// Доставка журнала отправки (outbox) в Битрикс24.
// Бизнес-логика только пишет запись со статусом pending — в той же транзакции, что и само изменение,
// поэтому уведомление не теряется при сбое портала. Доставка идёт в фоне:
//   pending → sending → sent | pending (повтор с паузой) | failed (после MAX_ATTEMPTS) | skipped (некуда слать).
// Без подключения к порталу записи помечаются simulated — журнал показывает, что ушло бы.
import { b24Call, IntegrationError } from './clients.js';
import { sendMail } from './smtp.js';
import { addEvent } from '../tickets-actions.js';
import { recordTask } from './b24-tasks.js';

export const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 30_000;
const BATCH = 20;

const NOT_LINKED = 'Сотрудник не сопоставлен с пользователем Битрикс24 — загрузите оргструктуру';

// Записи, созданные при заполнении демо-данных, — история, а не новые события: их не отправляем.
export function markOutboxHistory(db) {
  db.exec("UPDATE outbox SET status = 'simulated' WHERE status = 'pending'");
}

function buildCall(db, row, publicUrl) {
  const payload = JSON.parse(row.payload);
  const b24Id = row.user_id ? db.prepare('SELECT b24_id FROM users WHERE id = ?').get(row.user_id)?.b24_id : null;
  const link = payload.LINK ? ` ${publicUrl}${payload.LINK.startsWith('/') ? '' : '/'}${payload.LINK}` : '';
  if (row.method === 'im.notify') {
    if (!b24Id) return { skip: NOT_LINKED };
    return { params: { USER_ID: b24Id, MESSAGE: `${payload.MESSAGE}${link}` } };
  }
  if (row.method === 'tasks.task.add') {
    // RESPONSIBLE_ID обязателен в tasks.task.add: без сопоставления задача ждёт загрузки оргструктуры.
    if (!b24Id) return { skip: NOT_LINKED };
    return { params: { fields: { TITLE: payload.TITLE, DESCRIPTION: `${payload.MESSAGE}${link}`, DEADLINE: payload.DEADLINE, RESPONSIBLE_ID: b24Id } } };
  }
  return { skip: `Неизвестный метод ${row.method}` };
}

// Письмо: адрес и согласие проверяются в момент отправки — человек мог отключить письма после события.
function buildMail(db, row, publicUrl) {
  const user = row.user_id ? db.prepare('SELECT email, email_notify, is_active FROM users WHERE id = ?').get(row.user_id) : null;
  const anonymous = row.ticket_id ? Boolean(db.prepare('SELECT is_anonymous FROM tickets WHERE id = ?').get(row.ticket_id)?.is_anonymous) : false;
  if (!user?.email || !user.is_active) return { skip: 'У сотрудника нет рабочей почты' };
  if (!user.email_notify) return { skip: 'Сотрудник отключил письма' };
  const payload = JSON.parse(row.payload);
  const text = `${payload.MESSAGE}\n\nОткрыть: ${publicUrl}${payload.LINK}\n\n—\nГолос сотрудника · ГК «Модус Трейд»\nОтключить письма можно в колокольчике уведомлений.`;
  return { mail: { to: user.email, fromName: 'Голос сотрудника', subject: payload.SUBJECT, text, hiddenRecipient: anonymous } };
}

// Битрикс24 может ответить без ошибки, но и без результата: im.notify возвращает false,
// если получатель не найден или отключён. Такой ответ — не доставка.
function checkResult(method, result) {
  if (method === 'im.notify' && !result) throw new IntegrationError('Битрикс24 im.notify: уведомление не создано — получатель не найден или отключён');
  if (method === 'tasks.task.add' && !result?.task?.id) throw new IntegrationError('Битрикс24 tasks.task.add: портал не вернул номер задачи');
}

function onTaskCreated(db, row, taskId, nowIso) {
  if (!row.ticket_id) return;
  addEvent(db, {
    ticketId: row.ticket_id, actorId: null, kind: 'b24_task', at: nowIso,
    body: `Задача в Битрикс24 №${taskId} создана`,
  });
  recordTask(db, row.ticket_id, taskId, nowIso);
}

/**
 * @param {{ db, mode: () => 'live'|'demo'|'off', endpoints: () => { b24: string, publicUrl: string }, now: () => string, logger?: Console }} options
 */
export function createDelivery({ db, mode, endpoints, now, logger = console, mailMode = () => 'off', mailServer = () => null }) {
  // Отправка, прерванная перезапуском сервера, возвращается в очередь.
  db.exec("UPDATE outbox SET status = 'pending' WHERE status = 'sending'");
  let running = null;
  let again = false;
  // Поколение данных: сброс демо-данных его увеличивает, и ответы на вызовы, отправленные
  // до сброса, больше не трогают базу (иначе события старых задач попали бы в новый датасет).
  let generation = 0;

  function fail(row, error) {
    if (!(error instanceof IntegrationError)) logger.error('[b24 delivery]', error);
    const attempts = row.attempts + 1;
    db.prepare('UPDATE outbox SET status = ?, attempts = ?, error = ?, next_at = ? WHERE id = ?')
      .run(attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, error.message, Date.now() + RETRY_BASE_MS * 2 ** (attempts - 1), row.id);
  }

  async function sendOne(row) {
    const startedIn = generation;
    let result;
    try {
      const { b24, publicUrl } = endpoints();
      const isMail = row.channel === 'email';
      const call = isMail ? buildMail(db, row, publicUrl) : buildCall(db, row, publicUrl);
      if (call.skip) {
        db.prepare("UPDATE outbox SET status = 'skipped', error = ? WHERE id = ?").run(call.skip, row.id);
        return;
      }
      if (isMail) {
        const server = mailServer();
        result = await sendMail(server, { ...call.mail, from: server.from });
      } else {
        ({ result } = await b24Call(b24, row.method, call.params));
      }
      if (startedIn !== generation) return;
      if (!isMail) checkResult(row.method, result);
    } catch (error) {
      if (startedIn === generation) fail(row, error);
      return;
    }
    // Портал уже принял вызов: дальше — только запись результата. Ошибка здесь не должна
    // вернуть запись в очередь, иначе задача в Битрикс24 создалась бы второй раз.
    const externalId = String(result?.task?.id ?? result ?? '').slice(0, 120);
    db.prepare("UPDATE outbox SET status = 'sent', attempts = attempts + 1, error = NULL, external_id = ?, sent_at = ? WHERE id = ?")
      .run(externalId, now(), row.id);
    try {
      if (row.method === 'tasks.task.add') onTaskCreated(db, row, externalId, now());
    } catch (error) {
      logger.error('[b24 delivery] task created but not recorded in ticket history', error);
    }
  }

  async function drain() {
    do {
      again = false;
      const rows = db
        .prepare("SELECT * FROM outbox WHERE status = 'pending' AND (next_at IS NULL OR next_at <= ?) ORDER BY id LIMIT ?")
        .all(Date.now(), BATCH);
      const batchGeneration = generation;
      for (const row of rows) {
        if (batchGeneration !== generation) break;
        db.prepare("UPDATE outbox SET status = 'sending' WHERE id = ?").run(row.id);
        await sendOne(row);
      }
      if (rows.length === BATCH) again = true;
    } while (again);
  }

  /** Запускает отправку; повторный вызов во время отправки дождётся следующего круга. */
  function kick() {
    // Канал без подключения: записи остаются в журнале как имитация — видно, что ушло бы.
    const off = [['bitrix24', mode()], ['email', mailMode()]].filter(([, m]) => m === 'off').map(([channel]) => channel);
    for (const channel of off) db.prepare("UPDATE outbox SET status = 'simulated' WHERE status = 'pending' AND channel = ?").run(channel);
    if (off.length === 2) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = drain()
      .catch((error) => logger.error('[b24 delivery]', error))
      .finally(() => { running = null; });
    return running;
  }

  return {
    kick,
    idle: () => running ?? Promise.resolve(),
    /** Вызывается перед сбросом данных: незавершённые отправки больше не пишут в базу. */
    invalidate: () => { generation += 1; },
  };
}

// После загрузки оргструктуры недавние уведомления, не отправленные из-за отсутствия связи
// с пользователем Битрикс24, ставятся в очередь снова.
export function requeueUnlinked(db, sinceIso) {
  return db
    .prepare(`UPDATE outbox SET status = 'pending', error = NULL, next_at = NULL
              WHERE status = 'skipped' AND error = ? AND created_at >= ?
                AND user_id IN (SELECT id FROM users WHERE b24_id IS NOT NULL AND is_active = 1)`)
    .run(NOT_LINKED, sinceIso).changes;
}

export function retryOutbox(db, id) {
  const { changes } = db
    .prepare("UPDATE outbox SET status = 'pending', attempts = 0, next_at = NULL, error = NULL WHERE id = ? AND status IN ('failed','skipped')")
    .run(Number(id));
  return changes > 0;
}

export function outboxStats(db, channel = 'bitrix24') {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM outbox WHERE channel = ? GROUP BY status').all(channel);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
