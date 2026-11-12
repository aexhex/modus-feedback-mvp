// Сводка для руководителя: объёмы, SLA, результативность, повторяющиеся темы.
import { STATUSES, TYPES, PRIORITIES, FINAL_STATUSES } from './config.js';
import { BASE_SELECT, isFinal, slaState } from './tickets-query.js';
import { tokenize, jaccard } from './similarity.js';
import { badRequest } from './http.js';
import { getTargets, evaluateTargets } from './targets.js';
import { tzOffsetMs } from './settings.js';

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

// Карта повторяющихся проблем за последние 90 дней: категория × подразделение.
// В ячейке — сколько сотрудников подразделения столкнулись с проблемой: подали обращение
// или отметили «У меня тоже». Одна категория в нескольких подразделениях — сигнал системной проблемы.
function problemMap(db, rows, nowIso) {
  const since = new Date(new Date(nowIso).getTime() - REPEAT_WINDOW_DAYS * 24 * HOUR_MS).toISOString();
  const recent = rows.filter((r) => r.type !== 'praise' && r.created_at >= since && !r.duplicate_of);
  const recentById = new Map(recent.map((r) => [r.id, r]));
  const supporters = db
    .prepare('SELECT s.ticket_id, u.department FROM supports s JOIN users u ON u.id = s.user_id')
    .all()
    .filter((s) => recentById.has(s.ticket_id));
  const marks = [
    ...recent.map((r) => ({ ticket: r, department: r.department })),
    ...supporters.map((s) => ({ ticket: recentById.get(s.ticket_id), department: s.department })),
  ];
  const departments = countBy(marks, (m) => m.department).map((d) => d.key);
  const byCategory = new Map();
  for (const { ticket, department } of marks) {
    const prev = byCategory.get(ticket.category_name) ?? { category: ticket.category_name, categoryId: ticket.category_id, counts: new Map() };
    const counts = new Map(prev.counts);
    counts.set(department, (counts.get(department) ?? 0) + 1);
    byCategory.set(ticket.category_name, { ...prev, counts });
  }
  const categories = [...byCategory.values()].map(({ category, categoryId, counts }) => {
    const cells = departments.map((d) => counts.get(d) ?? 0);
    return { category, categoryId, cells, total: cells.reduce((a, b) => a + b, 0), spread: cells.filter(Boolean).length };
  }).sort((a, b) => b.spread - a.spread || b.total - a.total || a.category.localeCompare(b.category, 'ru'));
  const max = Math.max(0, ...categories.flatMap((c) => c.cells));
  return { departments, categories, max };
}

// Динамика за последние WEEKS недель (неделя начинается в понедельник по времени компании).
const WEEKS = 8;
const DAY_MS = 24 * HOUR_MS;

function weekStartMs(ms, offsetMs) {
  const local = ms + offsetMs;
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
  const daysSinceMonday = (new Date(dayStart).getUTCDay() + 6) % 7;
  return dayStart - daysSinceMonday * DAY_MS - offsetMs;
}

function weeklyDynamics(rows, nowIso, offsetMs) {
  const currentWeek = weekStartMs(new Date(nowIso).getTime(), offsetMs);
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

const TOP_CLIENTS = 10;

// Клиенты из 1С УТ, с которыми связано больше всего обращений (ТЗ 1.2: «последующий анализ обращений»).
// Дубликаты не считаются; частая категория — подсказка, где у клиента системная проблема.
function clientsBreakdown(db) {
  const hasClients = db.prepare('SELECT 1 FROM counterparties LIMIT 1').get();
  if (!hasClients) return null;
  const items = db
    .prepare(
      `SELECT k.id, k.name, k.inn, COUNT(*) AS total,
              SUM(CASE WHEN t.status NOT IN (${FINAL_STATUSES.map((s) => `'${s}'`).join(',')}) THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN t.type = 'problem' THEN 1 ELSE 0 END) AS problems,
              (SELECT c.name FROM tickets t2 JOIN categories c ON c.id = t2.category_id
               WHERE t2.counterparty_id = k.id AND t2.duplicate_of IS NULL
               GROUP BY c.id ORDER BY COUNT(*) DESC, c.name LIMIT 1) AS topCategory
       FROM tickets t JOIN counterparties k ON k.id = t.counterparty_id
       WHERE t.duplicate_of IS NULL
       GROUP BY k.id ORDER BY total DESC, k.name LIMIT ?`,
    )
    .all(TOP_CLIENTS);
  const { linked } = db.prepare('SELECT COUNT(*) AS linked FROM tickets WHERE counterparty_id IS NOT NULL AND duplicate_of IS NULL').get();
  return { items, linked };
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
  const kpi = {
    reviewedShare: share(rows.filter((r) => r.first_response_at).length, rows.length),
    closedShare: share(finals.length, rows.length),
    withResultShare: share(finals.filter((r) => r.resolution).length, finals.length),
    avgFirstResponseHours: avgFirstResponseHours(rows),
    implementedCount: db
      .prepare("SELECT COUNT(DISTINCT ticket_id) AS n FROM events WHERE to_status = 'implemented'")
      .get().n,
    overdueCount: overdue.length,
    ...authorFeedback(db),
  };
  return {
    total: rows.length,
    kpi,
    targets: evaluateTargets(kpi, getTargets(db)),
    problemMap: problemMap(db, rows, nowIso),
    clients: clientsBreakdown(db),
    byType: countBy(rows, (r) => r.type, TYPES),
    byStatus: countBy(rows, (r) => r.status, STATUSES),
    byCategory: countBy(rows, (r) => r.category_name),
    byDepartment: countBy(rows, (r) => r.department),
    repeatedTopics: repeatedTopics(rows, nowIso),
    similarPairs: similarPairs(rows),
    weekly: weeklyDynamics(rows, nowIso, tzOffsetMs(db)),
    workload: workload(rows, nowIso),
    timeInStatus: timeInStatus(db),
    overdue,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_DEFAULT_DAYS = 30;
const REPORT_MAX_DAYS = 366;
const REPORT_TOP = 5;

// Граница суток по времени компании для даты вида ГГГГ-ММ-ДД.
function dayBoundary(value, endOfDay, offsetMs) {
  const ms = DATE_RE.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : Number.NaN;
  if (Number.isNaN(ms)) throw badRequest('Дата периода указывается в формате ГГГГ-ММ-ДД');
  return new Date(ms - offsetMs + (endOfDay ? DAY_MS : 0)).toISOString();
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
// Вовлечённость для плана пилота: охват — доля сотрудников отдела, которые за период подали обращение
// или отметили «У меня тоже»; доверие — доля авторов, подавших за период больше одного обращения.
// Анонимные обращения не учитываются: подсчёт «кто подал» по отделам мог бы раскрыть автора.
function engagement(db, from, to) {
  const participants = db
    .prepare(
      `SELECT DISTINCT u.id, u.department FROM users u
       WHERE u.is_active = 1 AND (
         EXISTS (SELECT 1 FROM tickets t WHERE t.author_id = u.id AND t.is_anonymous = 0 AND t.created_at >= ? AND t.created_at < ?)
         OR EXISTS (SELECT 1 FROM supports s WHERE s.user_id = u.id AND s.created_at >= ? AND s.created_at < ?))`,
    )
    .all(from, to, from, to);
  const headcount = db.prepare('SELECT department, COUNT(*) AS n FROM users WHERE is_active = 1 GROUP BY department').all();
  const byDept = new Map(headcount.map((d) => [d.department, { department: d.department, headcount: d.n, participants: 0 }]));
  for (const p of participants) byDept.get(p.department).participants += 1;
  const coverage = [...byDept.values()]
    .map((d) => ({ ...d, share: share(d.participants, d.headcount) }))
    .sort((a, b) => b.share - a.share || a.department.localeCompare(b.department, 'ru'));
  const authors = db
    .prepare(`SELECT author_id, COUNT(*) AS n FROM tickets WHERE is_anonymous = 0 AND created_at >= ? AND created_at < ?
              GROUP BY author_id`)
    .all(from, to);
  const totalHeadcount = headcount.reduce((sum, d) => sum + d.n, 0);
  return {
    coverage,
    overall: { participants: participants.length, headcount: totalHeadcount, share: share(participants.length, totalHeadcount) },
    trust: { authors: authors.length, repeat: authors.filter((a) => a.n > 1).length, share: share(authors.filter((a) => a.n > 1).length, authors.length) },
  };
}

export function buildReport(db, query, nowIso) {
  const offsetMs = tzOffsetMs(db);
  const today = new Date(new Date(nowIso).getTime() + offsetMs).toISOString().slice(0, 10);
  const toDate = query.to || today;
  const to = dayBoundary(toDate, true, offsetMs);
  const fromDate = query.from
    || new Date(new Date(to).getTime() + offsetMs - REPORT_DEFAULT_DAYS * DAY_MS).toISOString().slice(0, 10);
  const from = dayBoundary(fromDate, false, offsetMs);
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
    engagement: engagement(db, from, to),
  };
}
