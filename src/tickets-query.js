// Чтение обращений: список с фильтрами, карточка, доска улучшений, похожие.
import { FINAL_STATUSES, STATUSES, TYPES, PRIORITIES, TRANSITIONS, LIMITS } from './config.js';
import { canView, canProcess, canReassign, canSeeAuthor, listScope } from './access.js';
import { notFound } from './http.js';
import { findSimilar } from './similarity.js';

export const BASE_SELECT = `
SELECT t.*, c.name AS category_name, a.name AS author_name, s.name AS assignee_name,
  (SELECT COUNT(*) FROM supports sp WHERE sp.ticket_id = t.id) AS supports_count
FROM tickets t
JOIN categories c ON c.id = t.category_id
JOIN users a ON a.id = t.author_id
LEFT JOIN users s ON s.id = t.assignee_id`;

export const isFinal = (status) => FINAL_STATUSES.includes(status);

// ISO-строки в UTC сравниваются лексикографически.
export function slaState(row, nowIso) {
  if (isFinal(row.status)) return { overdue: false, kind: null };
  if (!row.first_response_at && row.first_response_due < nowIso) {
    return { overdue: true, kind: 'first_response' };
  }
  if (row.due_at < nowIso) return { overdue: true, kind: 'resolve' };
  return { overdue: false, kind: null };
}

export function serializeTicket(row, user, nowIso) {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    typeLabel: TYPES[row.type],
    category: { id: row.category_id, name: row.category_name },
    title: row.title,
    description: row.description,
    proposedSolution: row.proposed_solution,
    priority: row.priority,
    priorityLabel: PRIORITIES[row.priority],
    status: row.status,
    statusLabel: STATUSES[row.status],
    isAnonymous: Boolean(row.is_anonymous),
    author: canSeeAuthor(user, row) ? { id: row.author_id, name: row.author_name } : null,
    department: row.department,
    assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name } : null,
    resolution: row.resolution,
    duplicateOf: row.duplicate_of,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    firstResponseDue: row.first_response_due,
    firstResponseAt: row.first_response_at,
    dueAt: row.due_at,
    resolvedAt: row.resolved_at,
    supportsCount: row.supports_count,
    sla: slaState(row, nowIso),
  };
}

export function getTicketRow(db, id) {
  const row = db.prepare(`${BASE_SELECT} WHERE t.id = ?`).get(Number(id));
  if (!row) throw notFound('Обращение не найдено');
  return row;
}

// Доступ к чужому обращению отдаём как 404, чтобы не раскрывать его существование.
export function getVisibleTicketRow(db, user, id) {
  const row = getTicketRow(db, id);
  if (!canView(user, row)) throw notFound('Обращение не найдено');
  return row;
}

const FILTERS = [
  ['type', 't.type = ?'],
  ['status', 't.status = ?'],
  ['priority', 't.priority = ?'],
  ['category', 't.category_id = ?'],
  ['department', 't.department = ?'],
  ['assignee', 't.assignee_id = ?'],
];

export function listTickets(db, user, query, nowIso) {
  const scope = listScope(user);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.scope === 'mine') {
    where.push('t.author_id = ?');
    params.push(user.id);
  } else if (query.scope === 'assigned') {
    where.push('t.assignee_id = ?');
    params.push(user.id);
  }
  for (const [key, sql] of FILTERS) {
    if (query[key]) {
      where.push(sql);
      params.push(query[key]);
    }
  }
  if (query.q) {
    where.push('(t.title LIKE ? OR t.description LIKE ? OR t.code LIKE ?)');
    const like = `%${String(query.q).slice(0, 100)}%`;
    params.push(like, like, like);
  }
  const rows = db
    .prepare(`${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC LIMIT ?`)
    .all(...params, LIMITS.listMax);
  const items = rows.map((row) => serializeTicket(row, user, nowIso));
  return query.overdue === '1' ? items.filter((t) => t.sla.overdue) : items;
}

function serializeEvent(event, row, user) {
  const actorIsHiddenAuthor = event.actor_id === row.author_id && !canSeeAuthor(user, row);
  let actorName = event.actor_name ?? 'Система';
  if (actorIsHiddenAuthor) actorName = 'Автор (анонимно)';
  return {
    id: event.id,
    kind: event.kind,
    body: event.body,
    fromStatus: event.from_status,
    toStatus: event.to_status,
    fromStatusLabel: STATUSES[event.from_status] ?? null,
    toStatusLabel: STATUSES[event.to_status] ?? null,
    isInternal: Boolean(event.is_internal),
    actorName,
    createdAt: event.created_at,
  };
}

export function getTicketDetail(db, user, id, nowIso) {
  const row = getVisibleTicketRow(db, user, id);
  const processor = canProcess(user, row);
  const events = db
    .prepare(
      `SELECT e.*, u.name AS actor_name FROM events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.ticket_id = ? ORDER BY e.created_at, e.id`,
    )
    .all(row.id)
    .filter((e) => processor || !e.is_internal)
    .map((e) => serializeEvent(e, row, user));
  const attachments = db
    .prepare(
      'SELECT id, original_name AS name, size, created_at AS createdAt FROM attachments WHERE ticket_id = ? ORDER BY id',
    )
    .all(row.id);
  const supported = db
    .prepare('SELECT 1 FROM supports WHERE ticket_id = ? AND user_id = ?')
    .get(row.id, user.id);
  const duplicateOf = row.duplicate_of
    ? db.prepare('SELECT id, code, title FROM tickets WHERE id = ?').get(row.duplicate_of)
    : null;
  return {
    ...serializeTicket(row, user, nowIso),
    duplicateOf,
    events,
    attachments,
    permissions: {
      canProcess: processor,
      canReassign: canReassign(user),
      canComment: row.status !== 'closed',
      canSupport: row.author_id !== user.id && !supported,
      allowedStatuses: processor
        ? TRANSITIONS[row.status].map((key) => ({ key, label: STATUSES[key] }))
        : [],
    },
  };
}

// Похожие обращения показываем всем — без автора и текста, только тема и статус.
export function similarTickets(db, user, text) {
  const candidates = db
    .prepare(
      `SELECT t.id, t.code, t.title, t.description, t.status, t.author_id, t.assignee_id,
              c.name AS category_name,
              (SELECT COUNT(*) FROM supports sp WHERE sp.ticket_id = t.id) AS supports_count
       FROM tickets t JOIN categories c ON c.id = t.category_id
       WHERE t.duplicate_of IS NULL AND t.type != 'praise'`,
    )
    .all();
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return findSimilar(text, candidates).map(({ id, score }) => {
    const c = byId.get(id);
    return {
      id: c.id,
      code: c.code,
      title: c.title,
      category: c.category_name,
      status: c.status,
      statusLabel: STATUSES[c.status],
      supportsCount: c.supports_count,
      score: Math.round(score * 100) / 100,
      canOpen: canView(user, c),
      isOwn: c.author_id === user.id,
    };
  });
}

// Доска улучшений: прозрачность результатов для всех сотрудников (без авторов).
export function improvementsBoard(db) {
  const implemented = db
    .prepare(
      `SELECT t.id, t.code, t.title, t.resolution, t.resolved_at AS resolvedAt, c.name AS category,
              (SELECT COUNT(*) FROM supports sp WHERE sp.ticket_id = t.id) AS supportsCount
       FROM tickets t JOIN categories c ON c.id = t.category_id
       WHERE t.status = 'implemented'
          OR (t.status = 'closed' AND t.type != 'praise' AND t.duplicate_of IS NULL
              AND EXISTS (SELECT 1 FROM events e WHERE e.ticket_id = t.id AND e.to_status = 'implemented'))
       ORDER BY t.resolved_at DESC`,
    )
    .all();
  const openIdeas = db
    .prepare(
      `SELECT t.id, t.code, t.title, t.status, c.name AS category,
              (SELECT COUNT(*) FROM supports sp WHERE sp.ticket_id = t.id) AS supportsCount
       FROM tickets t JOIN categories c ON c.id = t.category_id
       WHERE t.status NOT IN ('implemented','rejected','closed') AND t.type != 'praise'
       ORDER BY supportsCount DESC, t.created_at DESC LIMIT 10`,
    )
    .all()
    .map((r) => ({ ...r, statusLabel: STATUSES[r.status] }));
  return { implemented, openIdeas };
}
