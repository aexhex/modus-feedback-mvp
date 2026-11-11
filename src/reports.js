// Отчёт о внедрении (что сделано и какой эффект) и признание авторов принятых идей.
import { LIMITS } from './config.js';
import { canProcess } from './access.js';
import { badRequest, forbidden } from './http.js';
import { inTransaction } from './db.js';
import { notify } from './notifications.js';
import { addEvent } from './tickets-actions.js';
import { getVisibleTicketRow, watcherIds } from './tickets-query.js';

const TOP_AUTHORS = 5;
const MONTH_MS = 30 * 24 * 3600 * 1000;

// Обращение считается реализованным, если оно когда-либо получало статус «Реализовано».
const IMPLEMENTED_SQL = `(t.status = 'implemented' OR (t.status = 'closed' AND t.duplicate_of IS NULL
  AND EXISTS (SELECT 1 FROM events e WHERE e.ticket_id = t.id AND e.to_status = 'implemented')))`;

function required(value, field, max) {
  const str = typeof value === 'string' ? value.trim() : '';
  if (str.length < 5) throw badRequest(`Поле «${field}»: минимум 5 символов`);
  if (str.length > max) throw badRequest(`Поле «${field}»: максимум ${max} символов`);
  return str;
}

export function getReport(db, ticketId) {
  const row = db.prepare('SELECT done, effect, created_at FROM impl_reports WHERE ticket_id = ?').get(ticketId);
  return row ? { done: row.done, effect: row.effect, createdAt: row.created_at } : null;
}

export function canReport(db, ticketId) {
  return Boolean(db.prepare(`SELECT 1 FROM tickets t WHERE t.id = ? AND ${IMPLEMENTED_SQL}`).get(ticketId));
}

// Отчёт можно дополнять: повторное сохранение заменяет текст.
export function saveReport(db, user, id, input, now) {
  const row = getVisibleTicketRow(db, user, id);
  if (!canProcess(user, row)) throw forbidden('Отчёт о внедрении пишет ответственный или руководитель');
  if (!canReport(db, row.id)) throw badRequest('Отчёт доступен для реализованных обращений');
  const done = required(input.done, 'Что сделано', LIMITS.solutionMax);
  const effect = required(input.effect, 'Эффект', LIMITS.solutionMax);
  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO impl_reports (ticket_id, done, effect, author_id, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ticket_id) DO UPDATE SET done = excluded.done, effect = excluded.effect,
         author_id = excluded.author_id, created_at = excluded.created_at`,
    ).run(row.id, done, effect, user.id, now);
    addEvent(db, { ticketId: row.id, actorId: user.id, kind: 'report', body: `Что сделано: ${done}\nЭффект: ${effect}`, at: now });
    const supporters = db.prepare('SELECT user_id FROM supports WHERE ticket_id = ?').all(row.id).map((r) => r.user_id);
    notify(db, {
      userIds: [row.author_id, ...supporters, ...watcherIds(db, row.id)], ticketId: row.id, actorId: user.id, now,
      text: `${row.code}: опубликован отчёт о внедрении`,
    });
  });
}

// В рейтинг попадают только обращения, которые автор сам опубликовал в ленте, и никогда — анонимные:
// иначе рейтинг раскрывал бы автора закрытого обращения.
export function recognition(db, nowIso) {
  const since = new Date(new Date(nowIso).getTime() - MONTH_MS).toISOString();
  const ranked = (extra, params) => db
    .prepare(
      `SELECT u.name, u.department, COUNT(*) AS count FROM tickets t JOIN users u ON u.id = t.author_id
       WHERE t.is_anonymous = 0 AND t.is_public = 1 AND t.type != 'praise' AND ${IMPLEMENTED_SQL} ${extra}
       GROUP BY u.id ORDER BY count DESC, u.name LIMIT ?`,
    )
    .all(...params, TOP_AUTHORS);
  const month = ranked('AND t.resolved_at >= ?', [since]);
  return { topAuthors: ranked('', []), authorOfMonth: month[0] ?? null };
}

export function implementedCountOf(db, userId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE t.author_id = ? AND ${IMPLEMENTED_SQL}`).get(userId).n;
}
