// Доставка журнала отправки (outbox) в Битрикс24.
// Бизнес-логика только пишет запись со статусом pending — в той же транзакции, что и само изменение,
// поэтому уведомление не теряется при сбое портала. Доставка идёт в фоне:
//   pending → sending → sent | pending (повтор с паузой) | failed (после MAX_ATTEMPTS) | skipped (некуда слать).
// Без подключения к порталу записи помечаются simulated — журнал показывает, что ушло бы.
import { b24Call, IntegrationError } from './clients.js';
import { addEvent } from '../tickets-actions.js';

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
    const fields = { TITLE: payload.TITLE, DESCRIPTION: `${payload.MESSAGE}${link}`, DEADLINE: payload.DEADLINE };
    // Без сопоставления ответственным станет владелец вебхука — задача всё равно не потеряется.
    return { params: { fields: b24Id ? { ...fields, RESPONSIBLE_ID: b24Id } : fields } };
  }
  return { skip: `Неизвестный метод ${row.method}` };
}

function onTaskCreated(db, row, taskId, nowIso) {
  if (!row.ticket_id) return;
  addEvent(db, {
    ticketId: row.ticket_id, actorId: null, kind: 'b24_task', at: nowIso,
    body: `Задача в Битрикс24 №${taskId} создана`,
  });
}

/**
 * @param {{ db, mode: () => 'live'|'demo'|'off', endpoints: () => { b24: string, publicUrl: string }, now: () => string, logger?: Console }} options
 */
export function createDelivery({ db, mode, endpoints, now, logger = console }) {
  // Отправка, прерванная перезапуском сервера, возвращается в очередь.
  db.exec("UPDATE outbox SET status = 'pending' WHERE status = 'sending'");
  let running = null;
  let again = false;

  function fail(row, error) {
    if (!(error instanceof IntegrationError)) logger.error('[b24 delivery]', error);
    const attempts = row.attempts + 1;
    db.prepare('UPDATE outbox SET status = ?, attempts = ?, error = ?, next_at = ? WHERE id = ?')
      .run(attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, error.message, Date.now() + RETRY_BASE_MS * 2 ** (attempts - 1), row.id);
  }

  async function sendOne(row) {
    let result;
    try {
      const { b24, publicUrl } = endpoints();
      const call = buildCall(db, row, publicUrl);
      if (call.skip) {
        db.prepare("UPDATE outbox SET status = 'skipped', error = ? WHERE id = ?").run(call.skip, row.id);
        return;
      }
      ({ result } = await b24Call(b24, row.method, call.params));
    } catch (error) {
      fail(row, error);
      return;
    }
    // Портал уже принял вызов: дальше — только запись результата. Ошибка здесь не должна
    // вернуть запись в очередь, иначе задача в Битрикс24 создалась бы второй раз.
    const externalId = String(result?.task?.id ?? result ?? '');
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
      for (const row of rows) {
        db.prepare("UPDATE outbox SET status = 'sending' WHERE id = ?").run(row.id);
        await sendOne(row);
      }
      if (rows.length === BATCH) again = true;
    } while (again);
  }

  /** Запускает отправку; повторный вызов во время отправки дождётся следующего круга. */
  function kick() {
    if (mode() === 'off') {
      db.exec("UPDATE outbox SET status = 'simulated' WHERE status = 'pending'");
      return Promise.resolve();
    }
    if (running) {
      again = true;
      return running;
    }
    running = drain()
      .catch((error) => logger.error('[b24 delivery]', error))
      .finally(() => { running = null; });
    return running;
  }

  return { kick, idle: () => running ?? Promise.resolve() };
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

export function outboxStats(db) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status').all();
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
