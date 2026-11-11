import { h, mount } from '../dom.js';
import { get } from '../api.js';
import { weeklyFlowChart, responseTimeChart } from '../chart.js';

const MAX_CATEGORY_BARS = 10;

const kpi = (value, label, alert = false) =>
  h('div', { class: `kpi ${alert ? 'alert' : ''}` }, h('div', { class: 'kpi-value' }, value), h('div', { class: 'kpi-label' }, label));

function bars(title, items, link) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return h('section', { class: 'card' },
    h('h3', null, title),
    h('div', { class: 'bars' }, items.map((i) => h('div', { class: 'bar-row' },
      link ? h('a', { href: link(i), title: i.label }, i.label) : h('span', { title: i.label }, i.label),
      h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: `${(i.count / max) * 100}%` } })),
      h('span', { class: 'bar-num' }, String(i.count))))));
}

export async function renderAnalytics(el, { meta }) {
  const a = await get('/analytics');
  const catId = new Map(meta.categories.map((c) => [c.name, c.id]));
  const k = a.kpi;
  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Аналитика обращений'),
        h('p', null, 'Показатели из ТЗ: доля рассмотренных, время до первого ответа, доля с зафиксированным результатом, реализованные улучшения.')),
      h('a', { class: 'btn', href: '#/report' }, 'Отчёт за период')),
    h('div', { class: 'kpis' },
      kpi(String(a.total), 'Всего обращений'),
      kpi(`${k.reviewedShare}%`, 'Получили первый ответ'),
      kpi(k.avgFirstResponseHours === null ? '—' : `${k.avgFirstResponseHours} ч`, 'Среднее время до первого ответа'),
      kpi(`${k.closedShare}%`, 'Рассмотрено до итога'),
      kpi(`${k.withResultShare}%`, 'Итогов с зафиксированным результатом'),
      kpi(String(k.implementedCount), 'Реализовано улучшений'),
      kpi(k.confirmedShare === null ? '—' : `${k.confirmedShare}%`, `Авторы подтвердили решение (оценок: ${k.feedbackCount})`),
      kpi(String(k.overdueCount), 'Просрочено по SLA', k.overdueCount > 0)),
    h('div', { class: 'an-grid an-charts' },
      h('section', { class: 'card' }, weeklyFlowChart(a.weekly)),
      h('section', { class: 'card' }, responseTimeChart(a.weekly))),
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
