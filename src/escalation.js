// Эскалация просрочек SLA: ответственный и руководители получают уведомление,
// в истории обращения остаётся запись. Пока просрочка не устранена, напоминание
// повторяется каждые ESCALATION_REMINDER_HOURS рабочих часов.
import { ESCALATION_REMINDER_HOURS, addBusinessHours } from './config.js';
import { inTransaction } from './db.js';
import { notify } from './notifications.js';
import { addEvent } from './tickets-actions.js';
import { OVERDUE_SQL } from './tickets-query.js';
import { getHolidays } from './settings.js';

const REASONS = Object.freeze({
  first_response: 'нет первого ответа в срок',
  resolve: 'истёк срок решения',
});

// Срок первого ответа и срок решения проверяются независимо: по каждому — своя эскалация.
function breachedKinds(row, nowIso) {
  return [
    !row.first_response_at && row.first_response_due < nowIso ? 'first_response' : null,
    row.due_at < nowIso ? 'resolve' : null,
  ].filter(Boolean);
}

// Возвращает номер уведомления (1 — первое, 2+ — напоминание) или 0, если ещё рано.
function registerEscalation(db, ticketId, kind, nowIso, holidays) {
  const existing = db
    .prepare('SELECT created_at, last_at, count FROM escalations WHERE ticket_id = ? AND kind = ?')
    .get(ticketId, kind);
  if (!existing) {
    db.prepare('INSERT INTO escalations (ticket_id, kind, created_at, last_at, count) VALUES (?, ?, ?, ?, 1)')
      .run(ticketId, kind, nowIso, nowIso);
    return 1;
  }
  const nextReminderAt = addBusinessHours(existing.last_at ?? existing.created_at, ESCALATION_REMINDER_HOURS, holidays);
  if (nowIso < nextReminderAt) return 0;
  const count = (existing.count ?? 1) + 1;
  db.prepare('UPDATE escalations SET last_at = ?, count = ? WHERE ticket_id = ? AND kind = ?')
    .run(nowIso, count, ticketId, kind);
  return count;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} nowIso
 * @returns {number} сколько уведомлений об эскалации создано
 */
export function escalateOverdue(db, nowIso) {
  const overdue = db
    .prepare(
      `SELECT t.id, t.code, t.title, t.status, t.assignee_id, t.first_response_at, t.first_response_due, t.due_at
       FROM tickets t WHERE ${OVERDUE_SQL}`,
    )
    .all(nowIso, nowIso);
  if (overdue.length === 0) return 0;
  const managers = db.prepare("SELECT id FROM users WHERE role = 'manager' AND is_available = 1").all().map((u) => u.id);
  const holidays = getHolidays(db);
  return inTransaction(db, () => {
    let created = 0;
    for (const row of overdue) {
      for (const kind of breachedKinds(row, nowIso)) {
        const attempt = registerEscalation(db, row.id, kind, nowIso, holidays);
        if (attempt === 0) continue;
        created += 1;
        const prefix = attempt === 1 ? 'Нарушен SLA' : `Напоминание №${attempt - 1}: SLA по-прежнему нарушен`;
        addEvent(db, { ticketId: row.id, actorId: null, kind: 'escalation', at: nowIso, body: `${prefix} — ${REASONS[kind]}.` });
        notify(db, {
          userIds: [row.assignee_id, ...managers], ticketId: row.id, actorId: null, now: nowIso,
          text: `${attempt === 1 ? 'Просрочка' : 'Напоминание о просрочке'} ${row.code}: ${REASONS[kind]} — ${row.title}`,
        });
      }
    }
    return created;
  });
}
