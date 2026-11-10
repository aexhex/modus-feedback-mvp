// Сводка для руководителя: объёмы, SLA, результативность, повторяющиеся темы.
import { STATUSES, TYPES, PRIORITIES } from './config.js';
import { BASE_SELECT, isFinal, slaState } from './tickets-query.js';
import { tokenize, jaccard } from './similarity.js';

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
    },
    byType: countBy(rows, (r) => r.type, TYPES),
    byStatus: countBy(rows, (r) => r.status, STATUSES),
    byCategory: countBy(rows, (r) => r.category_name),
    byDepartment: countBy(rows, (r) => r.department),
    repeatedTopics: repeatedTopics(rows, nowIso),
    similarPairs: similarPairs(rows),
    overdue,
  };
}
