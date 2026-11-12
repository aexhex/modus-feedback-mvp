import { h, mount } from '../dom.js';
import { get } from '../api.js';
import { weeklyFlowChart, responseTimeChart } from '../chart.js';

const MAX_CATEGORY_BARS = 10;

const HEAT_LEVELS = 4;
const HEAT_ROWS = 8;

// Плитка показателя; если задана цель — строка «цель ≥ 90 %» и отметка словами (не только цветом).
function kpi(value, label, { alert = false, target = null } = {}) {
  const goal = target && h('div', { class: `kpi-target ${target.met === true ? 'met' : target.met === false ? 'missed' : ''}` },
    h('span', null, `цель ${target.dir === 'min' ? '≥' : '≤'} ${target.target} ${target.unit}`),
    target.met !== null && h('b', null, target.met ? '✓ в цели' : '✗ ниже цели'));
  return h('div', { class: `kpi ${alert ? 'alert' : ''}` }, h('div', { class: 'kpi-value' }, value), h('div', { class: 'kpi-label' }, label), goal);
}

// Карта повторяющихся проблем: строки — категории, столбцы — подразделения авторов, в ячейке — число обращений.
function problemMapCard(map) {
  if (map.categories.length === 0) return null;
  const level = (n) => (n === 0 ? 0 : Math.max(1, Math.ceil((n / map.max) * HEAT_LEVELS)));
  const href = (row) => `#/tickets?scope=all&category=${row.categoryId}`;
  const rowEl = (row) => h('tr', null,
    h('th', { scope: 'row' }, h('a', { href: href(row) }, row.category)),
    row.cells.map((n, i) => h('td', { class: `heat-${level(n)}` },
      n === 0 ? h('span', { 'aria-label': `${map.departments[i]}: никто` }, '·')
        : h('span', { 'aria-label': `${map.departments[i]}: ${n}` }, String(n)))),
    h('td', { class: 'heat-spread' }, row.spread > 1 ? h('b', null, String(row.spread)) : String(row.spread)));
  const tbody = h('tbody', null, map.categories.slice(0, HEAT_ROWS).map(rowEl));
  const more = map.categories.length > HEAT_ROWS && h('button', {
    class: 'btn btn-sm btn-ghost',
    onclick: (e) => { tbody.replaceChildren(...map.categories.map(rowEl)); e.currentTarget.remove(); },
  }, `Показать все категории (${map.categories.length})`);
  return h('section', { class: 'card heatmap-card' },
    h('h3', null, 'Карта повторяющихся проблем (90 дней)'),
    h('p', { class: 't-sub' }, 'Сколько сотрудников каждого подразделения столкнулись с проблемой: подали обращение или отметили «У меня тоже». Сверху — категории, которые затрагивают больше всего отделов: это сигнал для системного решения, а не точечного.'),
    h('div', { class: 'table-scroll' }, h('table', { class: 'heatmap' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, 'Категория'),
        map.departments.map((d) => h('th', { scope: 'col' }, d)),
        h('th', { scope: 'col' }, 'Отделов'))),
      tbody)),
    more);
}

function bars(title, items, link) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return h('section', { class: 'card' },
    h('h3', null, title),
    h('div', { class: 'bars' }, items.map((i) => h('div', { class: 'bar-row' },
      link ? h('a', { href: link(i), title: i.label }, i.label) : h('span', { title: i.label }, i.label),
      h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: `${(i.count / max) * 100}%` } })),
      h('span', { class: 'bar-num' }, String(i.count))))));
}

export async function renderAnalytics(el, { me, meta }) {
  const a = await get('/analytics');
  const catId = new Map(meta.categories.map((c) => [c.name, c.id]));
  const k = a.kpi;
  const t = a.targets;
  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Аналитика обращений'),
        h('p', null, 'Показатели из ТЗ: доля рассмотренных, время до первого ответа, доля с зафиксированным результатом, реализованные улучшения.')),
      h('a', { class: 'btn', href: '#/report' }, 'Отчёт за период')),
    h('div', { class: 'kpis' },
      kpi(String(a.total), 'Всего обращений'),
      kpi(`${k.reviewedShare}%`, 'Получили первый ответ', { target: t.reviewedShare }),
      kpi(k.avgFirstResponseHours === null ? '—' : `${k.avgFirstResponseHours} ч`, 'Среднее время до первого ответа', { target: t.avgFirstResponseHours }),
      kpi(`${k.closedShare}%`, 'Рассмотрено до итога', { target: t.closedShare }),
      kpi(`${k.withResultShare}%`, 'Итогов с зафиксированным результатом', { target: t.withResultShare }),
      kpi(String(k.implementedCount), 'Реализовано улучшений', { target: t.implementedCount }),
      kpi(k.confirmedShare === null ? '—' : `${k.confirmedShare}%`, `Авторы подтвердили решение (оценок: ${k.feedbackCount})`),
      kpi(String(k.overdueCount), 'Просрочено по SLA', { alert: k.overdueCount > 0, target: t.overdueCount })),
    me.role === 'admin' && h('p', { class: 't-sub kpi-note' }, 'Цели показателей задаются в ', h('a', { href: '#/admin' }, 'настройках'), '.'),
    h('div', { class: 'an-grid an-charts' },
      h('section', { class: 'card' }, weeklyFlowChart(a.weekly)),
      h('section', { class: 'card' }, responseTimeChart(a.weekly))),
    problemMapCard(a.problemMap),
    h('div', { class: 'an-grid' },
      h('section', { class: 'card' },
        h('h3', null, 'Просроченные — требуют внимания'),
        a.overdue.length === 0 ? h('p', { class: 'muted' }, 'Просрочек нет') : h('ul', { class: 'list-plain' }, a.overdue.map((o) =>
          h('li', null, h('a', { href: `#/t/${o.id}` }, h('span', { class: 't-code' }, o.code), ' ', o.title),
            h('div', { class: 't-sub' }, `${o.kind === 'first_response' ? 'Нет первого ответа' : 'Истёк срок решения'} · ${o.assignee ?? 'без ответственного'} · ${o.priorityLabel}`))))),
      h('section', { class: 'card' },
        h('h3', null, 'Повторяющиеся темы (90 дней)'),
        h('p', { class: 't-sub' }, 'Вес = обращения + поддержки коллег. Сигнал для системного решения, а не точечного.'),
        h('ul', { class: 'list-plain' }, a.repeatedTopics.slice(0, 6).map((t) =>
          h('li', { class: 'row', style: { justifyContent: 'space-between' } },
            h('a', { href: `#/tickets?scope=all&category=${catId.get(t.category) ?? ''}` }, t.category),
            h('span', { class: 't-sub' }, `обращений ${t.count} · поддержек ${t.supports} · открыто ${t.open}`))))),
      bars('По типам', a.byType),
      bars('По статусам', a.byStatus),
      bars('По категориям', a.byCategory.slice(0, MAX_CATEGORY_BARS)),
      bars('По подразделениям авторов', a.byDepartment),
      bars('Среднее время в статусе, часов', a.timeInStatus.map((s) => ({ label: s.label, count: s.avgHours }))),
      h('section', { class: 'card' },
        h('h3', null, 'Нагрузка по ответственным'),
        h('div', { class: 'table-scroll' }, h('table', { class: 'table report-table' },
          h('thead', null, h('tr', null, ['Ответственный', 'В работе', 'Без ответа', 'Просрочено'].map((c) => h('th', null, c)))),
          h('tbody', null, a.workload.map((w) => h('tr', null,
            h('td', null, w.name), h('td', null, String(w.open)), h('td', null, String(w.waiting)),
            h('td', null, w.overdue > 0 ? h('span', { class: 'chip chip-danger' }, String(w.overdue)) : '0'))))))),
      h('section', { class: 'card' },
        h('h3', null, 'Возможные дубликаты среди открытых'),
        a.similarPairs.length === 0 ? h('p', { class: 'muted' }, 'Похожих открытых обращений не найдено')
          : h('ul', { class: 'list-plain' }, a.similarPairs.map((p) => h('li', null,
            h('a', { href: `#/t/${p.a.id}` }, p.a.code), ' ↔ ', h('a', { href: `#/t/${p.b.id}` }, p.b.code),
            h('span', { class: 'score' }, `  сходство ${Math.round(p.score * 100)}%`),
            h('div', { class: 't-sub' }, `${p.a.title} / ${p.b.title}`)))))));
}
