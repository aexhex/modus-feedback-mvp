// Эскалация просрочек SLA: ответственный и руководители получают уведомление,
// в истории обращения остаётся запись. По каждому виду просрочки — один раз.
import { inTransaction } from './db.js';
import { notify } from './notifications.js';
import { addEvent } from './tickets-actions.js';
import { OVERDUE_SQL } from './tickets-query.js';

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

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} nowIso
 * @returns {number} сколько эскалаций создано
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
  const mark = db.prepare('INSERT OR IGNORE INTO escalations (ticket_id, kind, created_at) VALUES (?, ?, ?)');
  return inTransaction(db, () => {
    let created = 0;
    for (const row of overdue) {
      for (const kind of breachedKinds(row, nowIso)) {
        if (mark.run(row.id, kind, nowIso).changes === 0) continue;
        created += 1;
        addEvent(db, {
          ticketId: row.id, actorId: null, kind: 'escalation', at: nowIso,
          body: `Нарушен SLA: ${REASONS[kind]}.`,
        });
        notify(db, {
          userIds: [row.assignee_id, ...managers], ticketId: row.id, actorId: null, now: nowIso,
          text: `Просрочка ${row.code}: ${REASONS[kind]} — ${row.title}`,
        });
      }
    }
    return created;
  });
}
