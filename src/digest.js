// Сводка за неделю для руководителя: что изменилось за 7 дней по сравнению с предыдущими семью,
// плюс готовый текст для рассылки (в MVP рассылка в Битрикс24 имитируется журналом).
import { buildReport, buildAnalytics } from './analytics.js';
import { npsOf } from './client-feedback.js';
import { logOutbox } from './notifications.js';

const DAY_MS = 24 * 3600 * 1000;
const TZ_OFFSET_MS = 3 * 3600 * 1000;
const TOP = 3;

// Календарная дата по московскому времени, сдвинутая на days дней.
const localDate = (nowIso, days) =>
  new Date(new Date(nowIso).getTime() + TZ_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 10);

const ruDate = (date) => date.split('-').reverse().join('.');
const signed = (n) => (n > 0 ? `+${n}` : String(n));

function topVoted(db) {
  return db
    .prepare(
      `SELECT t.id, t.code, t.title,
              (SELECT COALESCE(SUM(v.count), 0) FROM idea_votes v WHERE v.ticket_id = t.id) AS votes
       FROM tickets t
       WHERE t.is_public = 1 AND t.type = 'idea' AND t.status NOT IN ('implemented','rejected','closed')
       ORDER BY votes DESC, t.created_at DESC LIMIT ?`,
    )
    .all(TOP)
    .filter((t) => t.votes > 0);
}

function clientWeek(db, fromDate, toDate) {
  const from = new Date(Date.parse(`${fromDate}T00:00:00Z`) - TZ_OFFSET_MS).toISOString();
  const to = new Date(Date.parse(`${toDate}T00:00:00Z`) - TZ_OFFSET_MS + DAY_MS).toISOString();
  const scores = db
    .prepare('SELECT score FROM client_feedback WHERE created_at >= ? AND created_at < ?')
    .all(from, to)
    .map((r) => r.score);
  return npsOf(scores);
}

function digestText(d) {
  const t = d.totals;
  const lines = [
    `Сводка «Голос сотрудника» за ${ruDate(d.from)} — ${ruDate(d.to)}`,
    '',
    `Подано обращений: ${t.created} (${signed(d.delta.created)} к прошлой неделе)`,
    `Рассмотрено: ${t.resolved} (${signed(d.delta.resolved)}), из них реализовано: ${t.implemented} (${signed(d.delta.implemented)})`,
    `Сейчас в работе: ${t.openNow}, просрочено: ${t.overdueNow}`,
    t.avgFirstResponseHours === null ? null : `Среднее время до первого ответа: ${t.avgFirstResponseHours} ч`,
  ];
  if (d.implemented.length) lines.push('', 'Реализовано:', ...d.implemented.map((x) => `• ${x.code} ${x.title}`));
  if (d.overdue.length) lines.push('', 'Требуют внимания:', ...d.overdue.map((x) => `• ${x.code} ${x.title} — ${x.assignee ?? 'без ответственного'}`));
  if (d.topVoted.length) lines.push('', 'Идеи с наибольшей поддержкой:', ...d.topVoted.map((x) => `• ${x.code} ${x.title} — голосов: ${x.votes}`));
  if (d.clients.count > 0) lines.push('', `Отзывы клиентов: ${d.clients.count}, NPS ${d.clients.value}`);
  return lines.filter((l) => l !== null).join('\n');
}

export function buildDigest(db, nowIso) {
  const to = localDate(nowIso, 0);
  const from = localDate(nowIso, -6);
  const current = buildReport(db, { from, to }, nowIso);
  const previous = buildReport(db, { from: localDate(nowIso, -13), to: localDate(nowIso, -7) }, nowIso);
  const digest = {
    from,
    to,
    totals: current.totals,
    delta: {
      created: current.totals.created - previous.totals.created,
      resolved: current.totals.resolved - previous.totals.resolved,
      implemented: current.totals.implemented - previous.totals.implemented,
    },
    implemented: current.implemented,
    overdue: buildAnalytics(db, nowIso).overdue.slice(0, 5),
    topVoted: topVoted(db),
    clients: clientWeek(db, from, to),
  };
  return { ...digest, text: digestText(digest) };
}

// Рассылка: сводка уходит руководителям и администраторам вызовом im.notify через журнал outbox.
export function sendDigest(db, nowIso) {
  const { text } = buildDigest(db, nowIso);
  const recipients = db
    .prepare("SELECT id, name FROM users WHERE role IN ('manager','admin') AND is_active = 1 ORDER BY name")
    .all();
  for (const r of recipients) {
    logOutbox(db, { method: 'im.notify', recipient: r.name, userId: r.id, payload: { MESSAGE: text, LINK: '/#/digest' }, now: nowIso });
  }
  return recipients.length;
}
