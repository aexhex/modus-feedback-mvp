// Главная страница: у каждой роли — свой набор «что требует внимания сейчас».
import { STATUSES } from './config.js';
import { canSeeAnalytics } from './access.js';
import { listTickets, improvementsBoard } from './tickets-query.js';
import { buildAnalytics } from './analytics.js';
import { implementedCountOf } from './reports.js';
import { openSurveysFor } from './surveys.js';

const RECENT_LIMIT = 5;
const QUEUE_LIMIT = 1000;
const WINS_LIMIT = 3;

const brief = (t) => ({
  id: t.id, code: t.code, title: t.title, status: t.status, statusLabel: t.statusLabel,
  priority: t.priority, priorityLabel: t.priorityLabel, sla: t.sla,
  dueAt: t.dueAt, firstResponseDue: t.firstResponseDue, firstResponseAt: t.firstResponseAt, resolvedAt: t.resolvedAt,
  assignee: t.assignee?.name ?? null,
});

function authorBlock(db, user, nowIso) {
  const counts = db
    .prepare('SELECT status, COUNT(*) AS count FROM tickets WHERE author_id = ? GROUP BY status')
    .all(user.id);
  const mine = listTickets(db, user, { scope: 'mine', limit: RECENT_LIMIT }, nowIso).items;
  const needsReply = listTickets(db, user, { scope: 'mine', status: 'need_info', limit: RECENT_LIMIT }, nowIso).items;
  return {
    myByStatus: counts.map((c) => ({ key: c.status, label: STATUSES[c.status], count: c.count })),
    myTotal: counts.reduce((sum, c) => sum + c.count, 0),
    myRecent: mine.map(brief),
    needsReply: needsReply.map(brief),
    implementedCount: implementedCountOf(db, user.id),
  };
}

function handlerBlock(db, user, nowIso) {
  // Итоговые статусы отсекаются в запросе, поэтому закрытые обращения не вытесняют открытые из выборки.
  const queue = { scope: 'assigned', open: '1', limit: QUEUE_LIMIT };
  const { items: open, total } = listTickets(db, user, queue, nowIso, { maxLimit: QUEUE_LIMIT });
  const overdue = listTickets(db, user, { ...queue, overdue: '1', limit: 1 }, nowIso);
  const byDeadline = (a, b) => (a.firstResponseAt ? a.dueAt : a.firstResponseDue)
    .localeCompare(b.firstResponseAt ? b.dueAt : b.firstResponseDue);
  return {
    openCount: total,
    overdueCount: overdue.total,
    waitingFirstResponse: open.filter((t) => !t.firstResponseAt).sort(byDeadline).map(brief),
    nextDeadlines: open.filter((t) => t.firstResponseAt).sort(byDeadline).slice(0, RECENT_LIMIT).map(brief),
  };
}

function oversightBlock(db, nowIso) {
  const analytics = buildAnalytics(db, nowIso);
  const { unassigned } = db
    .prepare("SELECT COUNT(*) AS unassigned FROM tickets WHERE assignee_id IS NULL AND status NOT IN ('implemented','rejected','closed')")
    .get();
  return {
    kpi: analytics.kpi,
    total: analytics.total,
    unassigned,
    overdue: analytics.overdue.slice(0, RECENT_LIMIT),
    repeatedTopics: analytics.repeatedTopics.slice(0, WINS_LIMIT),
    weekly: analytics.weekly,
  };
}

export function buildHome(db, user, nowIso) {
  return {
    role: user.role,
    author: authorBlock(db, user, nowIso),
    handler: user.role === 'handler' ? handlerBlock(db, user, nowIso) : null,
    oversight: canSeeAnalytics(user) ? oversightBlock(db, nowIso) : null,
    wins: improvementsBoard(db).implemented.slice(0, WINS_LIMIT),
    surveysOpen: openSurveysFor(db, user.id),
  };
}
