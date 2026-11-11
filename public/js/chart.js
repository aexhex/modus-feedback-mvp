// Графики на чистом SVG. Правила: одна ось на график, тонкие метки, легенда для двух рядов,
// подсказка при наведении и фокусе, табличное представление тех же данных.
import { h, svg } from './dom.js';

const W = 640;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 34 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
const GRID_LINES = 4;
const BAR_W = 14;
const BAR_GAP = 2;
const BAR_RADIUS = 4;

const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' });
const weekLabel = (iso) => dayFmt.format(new Date(iso));
const weekRange = (iso) => {
  const end = new Date(new Date(iso).getTime() + 6 * 24 * 3600_000);
  return `${weekLabel(iso)} – ${dayFmt.format(end)}`;
};

// Верх шкалы — ближайшее «круглое» значение, кратное числу линий сетки.
function niceMax(value) {
  const step = Math.max(1, Math.ceil(value / GRID_LINES));
  return step * GRID_LINES;
}

const yOf = (value, max) => PAD.top + PLOT_H - (value / max) * PLOT_H;
const slotX = (i, count) => PAD.left + (PLOT_W / count) * (i + 0.5);

function grid(max, unit = '') {
  return Array.from({ length: GRID_LINES + 1 }, (_, i) => {
    const value = (max / GRID_LINES) * i;
    const y = yOf(value, max);
    return [
      svg('line', { x1: PAD.left, x2: W - PAD.right, y1: y, y2: y, class: i === 0 ? 'ch-axis' : 'ch-grid' }),
      svg('text', { x: PAD.left - 6, y: y + 4, class: 'ch-tick', 'text-anchor': 'end' }, `${value}${unit}`),
    ];
  });
}

const xLabels = (weeks) => weeks.map((w, i) =>
  svg('text', { x: slotX(i, weeks.length), y: H - 8, class: 'ch-tick', 'text-anchor': 'middle' }, weekLabel(w.weekStart)));

// Столбец со скруглённым верхом, основание стоит на оси.
function bar(x, value, max, cls) {
  if (value <= 0) return null;
  const top = yOf(value, max);
  const bottom = yOf(0, max);
  const r = Math.min(BAR_RADIUS, bottom - top);
  const d = `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + BAR_W - r} Q${x + BAR_W},${top} ${x + BAR_W},${top + r} V${bottom} Z`;
  return svg('path', { d, class: cls });
}

// Невидимые зоны наведения на всю высоту: цель крупнее самой метки, доступна с клавиатуры.
function hitZones(weeks, tooltip, describe) {
  const slot = PLOT_W / weeks.length;
  return weeks.map((w, i) => {
    const show = () => {
      tooltip.replaceChildren(...describe(w));
      tooltip.style.left = `${((PAD.left + slot * (i + 0.5)) / W) * 100}%`;
      tooltip.hidden = false;
    };
    const hide = () => { tooltip.hidden = true; };
    return svg('rect', {
      x: PAD.left + slot * i, y: PAD.top, width: slot, height: PLOT_H, class: 'ch-hit', tabindex: 0,
      'aria-label': describe(w).map((n) => n.textContent).join(', '),
      onmouseenter: show, onmouseleave: hide, onfocus: show, onblur: hide,
    });
  });
}

function dataTable(headers, rows) {
  return h('details', { class: 'ch-table' },
    h('summary', null, 'Показать таблицей'),
    h('table', { class: 'table' },
      h('thead', null, h('tr', null, headers.map((c) => h('th', null, c)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, String(c))))))));
}

function frame(title, legend, plot, tooltip, table) {
  return h('figure', { class: 'chart' },
    h('figcaption', { class: 'ch-head' }, h('h3', null, title), legend),
    h('div', { class: 'ch-plot' }, plot, tooltip),
    table);
}

const tipLine = (label, value, swatch) =>
  h('div', { class: 'ch-tip-row' }, swatch && h('span', { class: `ch-swatch ${swatch}` }), h('span', null, label), h('b', null, value));

/** Подано и рассмотрено по неделям: два ряда, сгруппированные столбцы. */
export function weeklyFlowChart(weeks) {
  const max = niceMax(Math.max(1, ...weeks.flatMap((w) => [w.created, w.resolved])));
  const tooltip = h('div', { class: 'ch-tooltip', hidden: true, role: 'status' });
  const bars = weeks.map((w, i) => {
    const center = slotX(i, weeks.length);
    return [
      bar(center - BAR_W - BAR_GAP / 2, w.created, max, 'ch-s1'),
      bar(center + BAR_GAP / 2, w.resolved, max, 'ch-s2'),
    ];
  });
  const plot = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Подано и рассмотрено обращений по неделям' },
    grid(max), bars, xLabels(weeks),
    hitZones(weeks, tooltip, (w) => [
      h('div', { class: 'ch-tip-title' }, `Неделя ${weekRange(w.weekStart)}`),
      tipLine('Подано', String(w.created), 'ch-s1'),
      tipLine('Рассмотрено', String(w.resolved), 'ch-s2'),
    ]));
  const legend = h('div', { class: 'ch-legend' },
    h('span', null, h('span', { class: 'ch-swatch ch-s1' }), 'Подано'),
    h('span', null, h('span', { class: 'ch-swatch ch-s2' }), 'Рассмотрено'));
  return frame('Подано и рассмотрено по неделям', legend, plot, tooltip,
    dataTable(['Неделя', 'Подано', 'Рассмотрено'], weeks.map((w) => [weekRange(w.weekStart), w.created, w.resolved])));
}

/** Среднее время до первого ответа по неделям подачи: один ряд, линия. Недели без данных — разрыв. */
export function responseTimeChart(weeks) {
  const values = weeks.map((w) => w.avgFirstResponseHours);
  const max = niceMax(Math.max(1, ...values.filter((v) => v !== null)));
  const tooltip = h('div', { class: 'ch-tooltip', hidden: true, role: 'status' });
  const points = weeks.map((w, i) => (w.avgFirstResponseHours === null
    ? null
    : { x: slotX(i, weeks.length), y: yOf(w.avgFirstResponseHours, max) }));
  const segments = points.reduce((acc, p) => {
    if (!p) return [...acc, []];
    return [...acc.slice(0, -1), [...acc.at(-1), p]];
  }, [[]]).filter((s) => s.length > 1);
  const plot = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Среднее время до первого ответа по неделям, часы' },
    grid(max, ' ч'),
    segments.map((s) => svg('polyline', { points: s.map((p) => `${p.x},${p.y}`).join(' '), class: 'ch-line' })),
    points.filter(Boolean).map((p) => svg('circle', { cx: p.x, cy: p.y, r: 4, class: 'ch-dot' })),
    xLabels(weeks),
    hitZones(weeks, tooltip, (w) => [
      h('div', { class: 'ch-tip-title' }, `Неделя ${weekRange(w.weekStart)}`),
      tipLine('До первого ответа', w.avgFirstResponseHours === null ? 'нет данных' : `${w.avgFirstResponseHours} ч`),
    ]));
  return frame('Время до первого ответа, часы', null, plot, tooltip,
    dataTable(['Неделя подачи', 'Среднее время, ч'], weeks.map((w) => [weekRange(w.weekStart), w.avgFirstResponseHours ?? '—'])));
}
