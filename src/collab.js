// Совместная работа над обращением: подписка, приглашение коллеги, задача в Битрикс24 (имитация).
import { canProcess } from './access.js';
import { badRequest, forbidden } from './http.js';
import { inTransaction } from './db.js';
import { notify, logOutbox } from './notifications.js';
import { addEvent } from './tickets-actions.js';
import { getVisibleTicketRow, isFinal } from './tickets-query.js';

const TASK_NUMBER_BASE = 1000;

// Подписка на обновления: доступна тому, кто уже видит обращение (кроме автора и ответственного —
// они получают уведомления и так).
export function setWatching(db, user, id, input, now) {
  const row = getVisibleTicketRow(db, user, id);
  if (typeof input.watch !== 'boolean') throw badRequest('Ожидается watch: true/false');
  if (row.author_id === user.id || row.assignee_id === user.id) {
    throw badRequest('Вы уже получаете уведомления по этому обращению');
  }
  if (input.watch) {
    db.prepare('INSERT OR IGNORE INTO watchers (ticket_id, user_id, created_at) VALUES (?, ?, ?)').run(row.id, user.id, now);
  } else {
    db.prepare('DELETE FROM watchers WHERE ticket_id = ? AND user_id = ?').run(row.id, user.id);
  }
}

// Приглашение в обсуждение: обработчик зовёт коллегу, тот получает доступ на чтение и комментарии.
export function inviteWatcher(db, user, id, input, now) {
  const row = getVisibleTicketRow(db, user, id);
  if (!canProcess(user, row)) throw forbidden('Приглашать в обсуждение может ответственный или руководитель');
  if (row.status === 'closed') throw badRequest('Обращение закрыто');
  const target = db
    .prepare("SELECT id, name FROM users WHERE id = ? AND role IN ('handler','manager','admin') AND is_active = 1")
    .get(Number(input.userId));
  if (!target) throw badRequest('Выберите коллегу с ролью обработчика');
  if ([row.assignee_id, row.author_id, user.id].includes(target.id)) throw badRequest('Этот сотрудник уже участвует в обращении');
  inTransaction(db, () => {
    const { changes } = db
      .prepare('INSERT OR IGNORE INTO watchers (ticket_id, user_id, created_at) VALUES (?, ?, ?)')
      .run(row.id, target.id, now);
    if (changes === 0) throw badRequest('Коллега уже приглашён');
    addEvent(db, { ticketId: row.id, actorId: user.id, kind: 'invite', body: `В обсуждение приглашён: ${target.name}`, internal: true, at: now });
    notify(db, {
      userIds: [target.id], ticketId: row.id, actorId: user.id, now,
      text: `Вас зовут в обсуждение ${row.code}: ${row.title}`,
    });
  });
}

// ИМИТАЦИЯ: вместо вызова REST tasks.task.add запись попадает в журнал outbox.
export function createB24Task(db, user, id, _input, now) {
  const row = getVisibleTicketRow(db, user, id);
  if (!canProcess(user, row)) throw forbidden();
  if (isFinal(row.status)) throw badRequest('Обращение уже рассмотрено');
  if (db.prepare("SELECT 1 FROM events WHERE ticket_id = ? AND kind = 'b24_task'").get(row.id)) {
    throw badRequest('Задача по этому обращению уже создана');
  }
  inTransaction(db, () => {
    const outboxId = logOutbox(db, {
      method: 'tasks.task.add',
      recipient: row.assignee_name ?? 'Не назначен',
      payload: { TITLE: `[${row.code}] ${row.title}`, DEADLINE: row.due_at, MESSAGE: `Задача по обращению ${row.code}`, LINK: `/#/t/${row.id}` },
      now,
    });
    addEvent(db, {
      ticketId: row.id, actorId: user.id, kind: 'b24_task', at: now,
      body: `Создана задача в Битрикс24 №${TASK_NUMBER_BASE + outboxId} (имитация), срок — по SLA обращения`,
    });
  });
}
