// Сводка для руководителя: объёмы, SLA, результативность, повторяющиеся темы.
import { STATUSES, TYPES, PRIORITIES } from './config.js';
import { BASE_SELECT, isFinal, slaState } from './tickets-query.js';
import { tokenize, jaccard } from './similarity.js';
import { badRequest } from './http.js';

const HOUR_MS = 3600 * 1000;
const REPEAT_WINDOW_DAYS = 90;
const SIMILAR_PAIR_THRESHOLD = 0.18;

function countBy(rows, keyFn, labels) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: labels?.[key] ?? key, count }))
    .sort((a, b) => b.count - a.count);
}

const share = (part, total) => (total === 0 ? 0 : Math.round((part / total) * 1000) / 10);

function avgFirstResponseHours(rows) {
  const answered = rows.filter((r) => r.first_response_at);
  if (answered.length === 0) return null;
  const total = answered.reduce(
    (sum, r) => sum + (new Date(r.first_response_at) - new Date(r.created_at)) / HOUR_MS, 0,
  );
  return Math.round((total / answered.length) * 10) / 10;
}

function repeatedTopics(rows, nowIso) {
  const since = new Date(new Date(nowIso).getTime() - REPEAT_WINDOW_DAYS * 24 * HOUR_MS).toISOString();
  const recent = rows.filter((r) => r.type !== 'praise' && r.created_at >= since && !r.duplicate_of);
  const byCategory = new Map();
  for (const r of recent) {
    const prev = byCategory.get(r.category_name) ?? { category: r.category_name, count: 0, supports: 0, open: 0 };
    byCategory.set(r.category_name, {
      ...prev,
      count: prev.count + 1,
      supports: prev.supports + r.supports_count,
      open: prev.open + (isFinal(r.status) ? 0 : 1),
    });
  }
  return [...byCategory.values()]
    .map((t) => ({ ...t, weight: t.count + t.supports }))
    .filter((t) => t.weight >= 2)
    .sort((a, b) => b.weight - a.weight);
}

function similarPairs(rows) {
  const open = rows
    .filter((r) => !isFinal(r.status) && r.type !== 'praise')
    .map((r) => ({ r, tokens: tokenize(`${r.title} ${r.description}`) }));
  const pairs = [];
  for (let i = 0; i < open.length; i += 1) {
    for (let j = i + 1; j < open.length; j += 1) {
      const score = jaccard(open[i].tokens, open[j].tokens);
      if (score >= SIMILAR_PAIR_THRESHOLD) {
        pairs.push({
          a: { id: open[i].r.id, code: open[i].r.code, title: open[i].r.title },
          b: { id: open[j].r.id, code: open[j].r.code, title: open[j].r.title },
          score: Math.round(score * 100) / 100,
        });
      }
    }
  }
  return pairs.sort((x, y) => y.score - x.score).slice(0, 5);
}

// Динамика за последние WEEKS недель (неделя начинается в понедельник по московскому времени).
const WEEKS = 8;
const DAY_MS = 24 * HOUR_MS;
const TZ_OFFSET_MS = 3 * HOUR_MS;

function weekStartMs(ms) {
  const local = ms + TZ_OFFSET_MS;
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
  const daysSinceMonday = (new Date(dayStart).getUTCDay() + 6) % 7;
  return dayStart - daysSinceMonday * DAY_MS - TZ_OFFSET_MS;
}

function weeklyDynamics(rows, nowIso) {
  const currentWeek = weekStartMs(new Date(nowIso).getTime());
  return Array.from({ length: WEEKS }, (_, i) => {
    const start = currentWeek - (WEEKS - 1 - i) * 7 * DAY_MS;
    const end = start + 7 * DAY_MS;
    const within = (iso) => iso && new Date(iso).getTime() >= start && new Date(iso).getTime() < end;
    const created = rows.filter((r) => within(r.created_at));
    return {
      weekStart: new Date(start).toISOString(),
      created: created.length,
      resolved: rows.filter((r) => within(r.resolved_at)).length,
      avgFirstResponseHours: avgFirstResponseHours(created),
    };
  });
}

// Нагрузка по ответственным: открытые обращения, из них без первого ответа и просроченные.
function workload(rows, nowIso) {
  const byAssignee = new Map();
  for (const r of rows) {
    if (isFinal(r.status)) continue;
    const name = r.assignee_name ?? 'Без ответственного';
    const prev = byAssignee.get(name) ?? { name, open: 0, waiting: 0, overdue: 0 };
    byAssignee.set(name, {
      name,
      open: prev.open + 1,
      waiting: prev.waiting + (r.first_response_at ? 0 : 1),
      overdue: prev.overdue + (slaState(r, nowIso).overdue ? 1 : 0),
    });
  }
  return [...byAssignee.values()].sort((a, b) => b.open - a.open || b.overdue - a.overdue || a.name.localeCompare(b.name, 'ru'));
}

// Среднее время, которое обращения проводят в каждом статусе (по завершённым интервалам из истории).
function timeInStatus(db) {
  const events = db
    .prepare(
      `SELECT ticket_id, to_status, created_at FROM events
       WHERE kind IN ('created', 'status') AND to_status IS NOT NULL ORDER BY ticket_id, created_at, id`,
    )
    .all();
  const totals = new Map();
  for (let i = 0; i < events.length - 1; i += 1) {
    const current = events[i];
    const next = events[i + 1];
    if (current.ticket_id !== next.ticket_id || isFinal(current.to_status)) continue;
    const hours = (new Date(next.created_at) - new Date(current.created_at)) / HOUR_MS;
    const prev = totals.get(current.to_status) ?? { sum: 0, count: 0 };
    totals.set(current.to_status, { sum: prev.sum + hours, count: prev.count + 1 });
  }
  return Object.keys(STATUSES).filter((key) => totals.has(key)).map((key) => {
    const { sum, count } = totals.get(key);
    return { key, label: STATUSES[key], avgHours: Math.round((sum / count) * 10) / 10, count };
  });
}

// Оценки авторов: сколько итогов подтверждено как «вопрос решён».
function authorFeedback(db) {
  const { total, resolved } = db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(is_resolved), 0) AS resolved FROM feedback')
    .get();
  return { feedbackCount: total, confirmedShare: total === 0 ? null : share(resolved, total) };
}

export function buildAnalytics(db, nowIso) {
  const rows = db.prepare(BASE_SELECT).all();
  const finals = rows.filter((r) => isFinal(r.status));
  const overdue = rows
    .map((r) => ({ r, sla: slaState(r, nowIso) }))
    .filter(({ sla }) => sla.overdue)
    .map(({ r, sla }) => ({
      id: r.id, code: r.code, title: r.title, assignee: r.assignee_name, kind: sla.kind,
      priorityLabel: PRIORITIES[r.priority], statusLabel: STATUSES[r.status],
    }));
  return {
    total: rows.length,
    kpi: {
      reviewedShare: share(rows.filter((r) => r.first_response_at).length, rows.length),
      closedShare: share(finals.length, rows.length),
      withResultShare: share(finals.filter((r) => r.resolution).length, finals.length),
      avgFirstResponseHours: avgFirstResponseHours(rows),
      implementedCount: db
        .prepare("SELECT COUNT(DISTINCT ticket_id) AS n FROM events WHERE to_status = 'implemented'")
        .get().n,
      overdueCount: overdue.length,
      ...authorFeedback(db),
    },
    byType: countBy(rows, (r) => r.type, TYPES),
    byStatus: countBy(rows, (r) => r.status, STATUSES),
    byCategory: countBy(rows, (r) => r.category_name),
    byDepartment: countBy(rows, (r) => r.department),
    repeatedTopics: repeatedTopics(rows, nowIso),
    similarPairs: similarPairs(rows),
    weekly: weeklyDynamics(rows, nowIso),
    workload: workload(rows, nowIso),
    timeInStatus: timeInStatus(db),
    overdue,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_DEFAULT_DAYS = 30;
const REPORT_MAX_DAYS = 366;
const REPORT_TOP = 5;

// Граница суток по московскому времени для даты вида ГГГГ-ММ-ДД.
function dayBoundary(value, endOfDay) {
  const ms = DATE_RE.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : Number.NaN;
  if (Number.isNaN(ms)) throw badRequest('Дата периода указывается в формате ГГГГ-ММ-ДД');
  return new Date(ms - TZ_OFFSET_MS + (endOfDay ? DAY_MS : 0)).toISOString();
}

// Итог обращения: «реализовано» или «отклонено». Статус «закрыто» — лишь завершение после итога,
// поэтому для закрытых итог берётся из истории (последний из двух статусов).
function finalOutcomes(db) {
  const last = new Map();
  const events = db
    .prepare("SELECT ticket_id, to_status FROM events WHERE to_status IN ('implemented', 'rejected') ORDER BY created_at, id")
    .all();
  for (const e of events) last.set(e.ticket_id, e.to_status);
  return (row) => {
    if (row.status === 'implemented' || row.status === 'rejected') return row.status;
    return row.status === 'closed' && !row.duplicate_of ? (last.get(row.id) ?? null) : null;
  };
}

/** Отчёт за период для планёрки: что подано, что рассмотрено, что реализовано и где застряло. */
export function buildReport(db, query, nowIso) {
  const today = new Date(new Date(nowIso).getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
  const toDate = query.to || today;
  const to = dayBoundary(toDate, true);
  const fromDate = query.from
    || new Date(new Date(to).getTime() + TZ_OFFSET_MS - REPORT_DEFAULT_DAYS * DAY_MS).toISOString().slice(0, 10);
  const from = dayBoundary(fromDate, false);
  if (from >= to) throw badRequest('Начало периода позже его конца');
  if (new Date(to) - new Date(from) > REPORT_MAX_DAYS * DAY_MS) throw badRequest('Период не длиннее года');

  const rows = db.prepare(BASE_SELECT).all();
  const within = (iso) => Boolean(iso) && iso >= from && iso < to;
  const created = rows.filter((r) => within(r.created_at));
  const resolved = rows.filter((r) => within(r.resolved_at));
  const outcomeOf = finalOutcomes(db);
  const implemented = resolved.filter((r) => outcomeOf(r) === 'implemented');
  const rejected = resolved.filter((r) => outcomeOf(r) === 'rejected');
  const line = (r) => ({
    id: r.id, code: r.code, title: r.title, category: r.category_name, resolution: r.resolution,
    resolvedAt: r.resolved_at, supports: r.supports_count,
  });
  return {
    from: fromDate,
    to: toDate,
    generatedAt: nowIso,
    totals: {
      created: created.length,
      resolved: resolved.length,
      implemented: implemented.length,
      rejected: rejected.length,
      reviewedShare: share(created.filter((r) => r.first_response_at).length, created.length),
      avgFirstResponseHours: avgFirstResponseHours(created),
      openNow: rows.filter((r) => !isFinal(r.status)).length,
      overdueNow: rows.filter((r) => slaState(r, nowIso).overdue).length,
    },
    byType: countBy(created, (r) => r.type, TYPES),
    byCategory: countBy(created, (r) => r.category_name),
    implemented: implemented.map(line),
    rejected: rejected.map(line),
    topSupported: created.filter((r) => r.supports_count > 0)
      .sort((a, b) => b.supports_count - a.supports_count).slice(0, REPORT_TOP).map(line),
    workload: workload(rows, nowIso),
  };
}
