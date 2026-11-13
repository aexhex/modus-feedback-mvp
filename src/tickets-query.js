// Чтение обращений: список с фильтрами, карточка, доска улучшений, похожие.
import { contactsOf } from './contacts.js';
import {
  FINAL_STATUSES, STATUSES, TYPES, PRIORITIES, TRANSITIONS, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX,
} from './config.js';
import { canView, canProcess, canReassign, canSeeAuthor, listScope } from './access.js';
import { notFound, badRequest } from './http.js';
import { findSimilar } from './similarity.js';
import { getReport, canReport } from './reports.js';
import { ticketVoting } from './votes.js';
import { taskInfo } from './integrations/b24-task-status.js';
import { tzOffsetMs } from './settings.js';

export const BASE_SELECT = `
SELECT t.*, c.name AS category_name, a.name AS author_name, s.name AS assignee_name,
  (SELECT COUNT(*) FROM supports sp WHERE sp.ticket_id = t.id) AS supports_count,
  (SELECT COALESCE(SUM(v.count), 0) FROM idea_votes v WHERE v.ticket_id = t.id) AS votes_count
FROM tickets t
JOIN categories c ON c.id = t.category_id
JOIN users a ON a.id = t.author_id
LEFT JOIN users s ON s.id = t.assignee_id`;

export const isFinal = (status) => FINAL_STATUSES.includes(status);

// SQL-условие просрочки SLA; принимает два параметра — текущее время (дважды).
export const OVERDUE_SQL = `(t.status NOT IN (${FINAL_STATUSES.map((s) => `'${s}'`).join(',')})
  AND ((t.first_response_at IS NULL AND t.first_response_due < ?) OR t.due_at < ?))`;

// ISO-строки в UTC сравниваются лексикографически.
export function slaState(row, nowIso) {
  if (isFinal(row.status)) return { overdue: false, kind: null };
  if (!row.first_response_at && row.first_response_due < nowIso) {
    return { overdue: true, kind: 'first_response' };
  }
  if (row.due_at < nowIso) return { overdue: true, kind: 'resolve' };
  return { overdue: false, kind: null };
}

function serializeTicket(row, user, nowIso) {
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
    isPublic: Boolean(row.is_public),
    author: canSeeAuthor(user, row) ? { id: row.author_id, name: row.author_name } : null,
    // У анонимного обращения подразделение скрыто так же, как автор (остаётся только в сводной аналитике).
    department: canSeeAuthor(user, row) ? row.department : null,
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
    votesCount: row.votes_count,
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
  if (!canView(user, row, isWatching(db, row.id, user.id))) throw notFound('Обращение не найдено');
  return row;
}

export function isWatching(db, ticketId, userId) {
  return Boolean(db.prepare('SELECT 1 FROM watchers WHERE ticket_id = ? AND user_id = ?').get(ticketId, userId));
}

export function watcherIds(db, ticketId) {
  return db.prepare('SELECT user_id FROM watchers WHERE ticket_id = ?').all(ticketId).map((r) => r.user_id);
}

const FILTERS = [
  ['type', 't.type = ?'],
  ['status', 't.status = ?'],
  ['priority', 't.priority = ?'],
  ['category', 't.category_id = ?'],
  // Анонимные обращения не попадают в выборку по подразделению — иначе фильтр раскрывал бы автора.
  ['department', '(t.department = ? AND t.is_anonymous = 0)'],
  ['assignee', 't.assignee_id = ?'],
  ['counterparty', 't.counterparty_id = ?'],
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayStartIso(date, plusDays, offsetMs) {
  const ms = DATE_RE.test(String(date)) ? Date.parse(`${date}T00:00:00.000Z`) : Number.NaN;
  if (Number.isNaN(ms)) throw badRequest('Дата указывается в формате ГГГГ-ММ-ДД');
  return new Date(ms - offsetMs + plusDays * 24 * 3600 * 1000).toISOString();
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function buildWhere(user, query, nowIso, offsetMs) {
  // Лента идей — опубликованные обращения, одинаково для всех ролей.
  const scope = query.scope === 'feed' ? { sql: 't.is_public = 1', params: [] } : listScope(user);
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
  if (query.overdue === '1') {
    where.push(OVERDUE_SQL);
    params.push(nowIso, nowIso);
  }
  if (query.open === '1') where.push(`t.status NOT IN (${FINAL_STATUSES.map((s) => `'${s}'`).join(',')})`);
  if (query.notClosed === '1') where.push("t.status != 'closed'");
  // Период подачи: границы суток по времени компании.
  if (query.from) {
    where.push('t.created_at >= ?');
    params.push(dayStartIso(query.from, 0, offsetMs));
  }
  if (query.to) {
    where.push('t.created_at < ?');
    params.push(dayStartIso(query.to, 1, offsetMs));
  }
  return { sql: where.join(' AND '), params };
}

/**
 * Постраничный список с фильтрами.
 * @returns {{ items: object[], total: number, page: number, limit: number }}
 */
export function listTickets(db, user, query, nowIso, { maxLimit = PAGE_SIZE_MAX } = {}) {
  const where = buildWhere(user, query, nowIso, tzOffsetMs(db));
  const limit = clampInt(query.limit, Math.min(PAGE_SIZE_DEFAULT, maxLimit), 1, maxLimit);
  const page = clampInt(query.page, 1, 1, Number.MAX_SAFE_INTEGER);
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM tickets t WHERE ${where.sql}`).get(...where.params);
  const rows = db
    .prepare(`${BASE_SELECT} WHERE ${where.sql} ORDER BY ${query.sort === 'votes' ? 'votes_count DESC, ' : ''}t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`)
    .all(...where.params, limit, (page - 1) * limit);
  return { items: rows.map((row) => serializeTicket(row, user, nowIso)), total, page, limit };
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
  const feedback = db
    .prepare('SELECT is_resolved, comment, created_at FROM feedback WHERE ticket_id = ?')
    .get(row.id);
  const watching = isWatching(db, row.id, user.id);
  const watchers = db
    .prepare('SELECT u.id, u.name FROM watchers w JOIN users u ON u.id = w.user_id WHERE w.ticket_id = ? ORDER BY u.name')
    .all(row.id);
  const taskEvent = db
    .prepare("SELECT body, created_at FROM events WHERE ticket_id = ? AND kind = 'b24_task' ORDER BY id DESC LIMIT 1")
    .get(row.id);
  const counterparty = db
    .prepare('SELECT k.id, k.name, k.inn FROM counterparties k JOIN tickets t ON t.counterparty_id = k.id WHERE t.id = ?')
    .get(row.id) ?? null;
  // Контакты ответственного видят все, кто видит обращение; контакты автора — только рассматривающие,
  // и только у неанонимного обращения.
  const contacts = {
    assignee: contactsOf(db, row.assignee_id),
    author: processor && !row.is_anonymous ? contactsOf(db, row.author_id) : null,
  };
  return {
    ...serializeTicket(row, user, nowIso),
    contacts,
    counterparty,
    duplicateOf,
    events,
    attachments,
    watchers,
    isWatching: watching,
    b24Task: taskEvent ? { text: taskEvent.body, createdAt: taskEvent.created_at, task: taskInfo(db, row.id) } : null,
    report: getReport(db, row.id),
    voting: row.is_public && row.type === 'idea' ? ticketVoting(db, user, row) : null,
    feedback: feedback
      ? { isResolved: Boolean(feedback.is_resolved), comment: feedback.comment, createdAt: feedback.created_at }
      : null,
    permissions: {
      canRate: row.author_id === user.id && isFinal(row.status) && !row.duplicate_of && !feedback,
      canProcess: processor,
      canReassign: canReassign(user),
      canComment: row.status !== 'closed',
      canSupport: row.type === 'problem' && row.author_id !== user.id && !supported,
      canWatch: row.author_id !== user.id && row.assignee_id !== user.id,
      canInvite: processor && row.status !== 'closed',
      canCreateTask: processor && !isFinal(row.status) && !taskEvent,
      canReport: processor && canReport(db, row.id),
      canAttach: row.status !== 'closed' && (processor || row.author_id === user.id),
      canEdit: row.author_id === user.id && ['new', 'need_info'].includes(row.status),
      canPublish: processor || row.author_id === user.id,
      allowedStatuses: processor
        ? TRANSITIONS[row.status].map((key) => ({ key, label: STATUSES[key] }))
        : [],
    },
  };
}

// Похожие обращения показываем всем — без автора и текста, только тема и статус.
// Итог рассмотрения («Уже решено») — только если пользователь может открыть обращение
// или оно реализовано (такие итоги и так публикуются для всех в «Итогах внедрения»).
// Чужое закрытое обращение сравнивается только по теме: подбором слов нельзя выведать его текст.
// Тема чужого анонимного не показывается вовсе — по ней автора бывает легко узнать.
export function similarTickets(db, user, text) {
  const rows = db
    .prepare(
      `SELECT t.id, t.code, t.title, t.description, t.status, t.author_id, t.assignee_id, t.is_public, t.type,
              t.is_anonymous, t.resolution, c.name AS category_name,
              EXISTS (SELECT 1 FROM events e WHERE e.ticket_id = t.id AND e.to_status = 'implemented') AS was_implemented,
              (SELECT COUNT(*) FROM supports sp WHERE sp.ticket_id = t.id) AS supports_count
       FROM tickets t JOIN categories c ON c.id = t.category_id
       WHERE t.duplicate_of IS NULL AND t.type != 'praise'`,
    )
    .all();
  const watched = new Set(db.prepare('SELECT ticket_id FROM watchers WHERE user_id = ?').all(user.id).map((w) => w.ticket_id));
  const candidates = rows.map((r) => {
    const canOpen = canView(user, r, watched.has(r.id));
    return { ...r, canOpen, description: canOpen ? r.description : '' };
  });
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return findSimilar(text, candidates).map(({ id, score }) => {
    const c = byId.get(id);
    const { canOpen } = c;
    const showResult = isFinal(c.status) && c.resolution && (canOpen || c.was_implemented);
    return {
      id: c.id,
      code: c.code,
      title: canOpen || !c.is_anonymous ? c.title : null,
      category: c.category_name,
      status: c.status,
      statusLabel: STATUSES[c.status],
      supportsCount: c.supports_count,
      score: Math.round(score * 100) / 100,
      canOpen,
      isOwn: c.author_id === user.id,
      resolution: showResult ? c.resolution : null,
      type: c.type,
    };
  });
}

// Доска улучшений: прозрачность результатов для всех сотрудников (без авторов).
export function improvementsBoard(db) {
  const implemented = db
    .prepare(
      `SELECT t.id, t.code, t.title, t.resolution, t.resolved_at AS resolvedAt, c.name AS category,
              r.done AS reportDone, r.effect AS reportEffect,
              (SELECT COUNT(*) FROM supports sp WHERE sp.ticket_id = t.id) AS supportsCount
       FROM tickets t JOIN categories c ON c.id = t.category_id
       LEFT JOIN impl_reports r ON r.ticket_id = t.id
       WHERE t.status = 'implemented'
          OR (t.status = 'closed' AND t.type != 'praise' AND t.duplicate_of IS NULL
              AND EXISTS (SELECT 1 FROM events e WHERE e.ticket_id = t.id AND e.to_status = 'implemented'))
       ORDER BY t.resolved_at DESC`,
    )
    .all();
  const openIdeas = db
    .prepare(
      `SELECT t.id, t.code, t.title, t.status, c.name AS category,
              (SELECT COUNT(*) FROM supports sp WHERE sp.ticket_id = t.id) AS supportsCount,
              (SELECT COALESCE(SUM(v.count), 0) FROM idea_votes v WHERE v.ticket_id = t.id) AS votesCount
       FROM tickets t JOIN categories c ON c.id = t.category_id
       WHERE t.status NOT IN ('implemented','rejected','closed') AND t.type != 'praise' AND t.is_public = 1
       ORDER BY votesCount DESC, supportsCount DESC, t.created_at DESC LIMIT 10`,
    )
    .all()
    .map((r) => ({ ...r, statusLabel: STATUSES[r.status] }));
  return { implemented, openIdeas };
}
