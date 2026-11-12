// База решений (ТЗ 1.3, 2.7: «сохранение и систематизация предложений и принятых решений»).
// Рассмотренные обращения с зафиксированным итогом: что решили и почему — без имён авторов.
// Видимость: то, что пользователь и так может открыть, плюс реализованные улучшения,
// которые и так публикуются для всех в «Итогах внедрения».
import { STATUSES, TYPES } from './config.js';
import { canView } from './access.js';
import { isWatching } from './tickets-query.js';

const LIMIT = 100;
const OUTCOMES = Object.freeze({
  implemented: "t.status = 'implemented' OR was_implemented = 1",
  rejected: "t.status = 'rejected'",
});

/** Был ли у обращения статус «Реализовано» (в том числе если потом его закрыли). */
export const WAS_IMPLEMENTED_SQL =
  "EXISTS (SELECT 1 FROM events e WHERE e.ticket_id = t.id AND e.to_status = 'implemented')";

export function listSolutions(db, user, query = {}) {
  const where = ["t.status IN ('implemented','rejected','closed')", 't.resolution IS NOT NULL', "t.type != 'praise'", 't.duplicate_of IS NULL'];
  const params = [];
  const categoryId = Number(query.category);
  if (Number.isInteger(categoryId) && categoryId > 0) {
    where.push('t.category_id = ?');
    params.push(categoryId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT t.id, t.code, t.title, t.type, t.status, t.resolution, t.resolved_at, t.category_id,
                t.author_id, t.assignee_id, t.is_public, c.name AS category_name,
                r.done AS report_done, r.effect AS report_effect,
                ${WAS_IMPLEMENTED_SQL} AS was_implemented
         FROM tickets t JOIN categories c ON c.id = t.category_id
         LEFT JOIN impl_reports r ON r.ticket_id = t.id
         WHERE ${where.join(' AND ')}
       ) t ${OUTCOMES[query.outcome] ? `WHERE ${OUTCOMES[query.outcome]}` : ''}
       ORDER BY t.resolved_at DESC, t.id DESC`,
    )
    .all(...params);
  const needle = String(query.q ?? '').trim().toLowerCase().slice(0, 200);
  return rows
    .map((row) => ({ row, canOpen: canView(user, row, isWatching(db, row.id, user.id)) }))
    .filter(({ row, canOpen }) => canOpen || row.was_implemented)
    .filter(({ row }) => !needle || [row.code, row.title, row.resolution, row.category_name, row.report_done, row.report_effect]
      .some((text) => String(text ?? '').toLowerCase().includes(needle)))
    .slice(0, LIMIT)
    .map(({ row, canOpen }) => ({
      id: row.id,
      code: row.code,
      title: row.title,
      type: row.type,
      typeLabel: TYPES[row.type],
      category: { id: row.category_id, name: row.category_name },
      // Закрытое после внедрения обращение показываем как реализованное: это и есть его итог.
      outcome: row.status === 'rejected' ? 'rejected' : row.was_implemented ? 'implemented' : 'closed',
      outcomeLabel: row.status === 'rejected' ? STATUSES.rejected : row.was_implemented ? STATUSES.implemented : STATUSES.closed,
      resolution: row.resolution,
      report: row.report_done ? { done: row.report_done, effect: row.report_effect } : null,
      resolvedAt: row.resolved_at,
      canOpen,
    }));
}
