// Отчёт за период для планёрки: одна страница, которую можно распечатать или сохранить в PDF.
import { h, mount, toast, fmtDate } from '../dom.js';
import { get, qs } from '../api.js';

const tile = (value, label) => h('div', { class: 'kpi' }, h('div', { class: 'kpi-value' }, value), h('div', { class: 'kpi-label' }, label));

const table = (headers, rows) => h('table', { class: 'table report-table' },
  h('thead', null, h('tr', null, headers.map((c) => h('th', null, c)))),
  h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, c))))));

const section = (title, body) => h('section', { class: 'card report-section' }, h('h3', null, title), body);

const ticketRows = (items) => items.map((t) => [
  h('a', { href: `#/t/${t.id}`, class: 't-code' }, t.code), t.title, t.category, t.resolution ?? '—',
]);

const ruDate = (iso) => iso.split('-').reverse().join('.');

// Охват и доверие из плана пилота (docs/CONCEPT.md): считаются здесь, а не вручную по выгрузке.
function engagementSection(e) {
  return section('Вовлечённость сотрудников (показатели пилота)', [
    h('p', { class: 't-sub' }, 'Охват — доля сотрудников, которые за период подали обращение или отметили «У меня тоже». Доверие — доля авторов, подавших больше одного обращения. Анонимные обращения не учитываются.'),
    h('div', { class: 'kpis' },
      tile(`${e.overall.share}%`, `Охват (${e.overall.participants} из ${e.overall.headcount})`),
      tile(e.trust.authors === 0 ? '—' : `${e.trust.share}%`, `Доверие (${e.trust.repeat} из ${e.trust.authors} авторов)`)),
    table(['Подразделение', 'Участвовали', 'Сотрудников', 'Охват'],
      e.coverage.map((d) => [d.department, String(d.participants), String(d.headcount), `${d.share}%`])),
  ]);
}

export async function renderReport(el, { query, go }) {
  const r = await get(`/report${qs({ from: query.from, to: query.to })}`);
  const from = h('input', { type: 'date', value: r.from, 'aria-label': 'Начало периода' });
  const to = h('input', { type: 'date', value: r.to, 'aria-label': 'Конец периода' });
  const t = r.totals;
  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Отчёт за период'),
        h('p', null, `${ruDate(r.from)} — ${ruDate(r.to)} · сформирован ${fmtDate(r.generatedAt)}`)),
      h('form', { class: 'row no-print', onsubmit: (e) => {
        e.preventDefault();
        if (!from.value || !to.value) { toast('Укажите обе даты', 'error'); return; }
        go(`#/report${qs({ from: from.value, to: to.value })}`);
      } },
      from, h('span', null, '—'), to,
      h('button', { class: 'btn', type: 'submit' }, 'Показать'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => window.print() }, 'Печать / PDF'))),
    h('div', { class: 'kpis' },
      tile(String(t.created), 'Подано'),
      tile(String(t.resolved), 'Рассмотрено'),
      tile(String(t.implemented), 'Реализовано'),
      tile(String(t.rejected), 'Отклонено'),
      tile(`${t.reviewedShare}%`, 'Получили первый ответ'),
      tile(t.avgFirstResponseHours === null ? '—' : `${t.avgFirstResponseHours} ч`, 'До первого ответа'),
      tile(String(t.openNow), 'Открыто сейчас'),
      tile(String(t.overdueNow), 'Просрочено сейчас')),
    engagementSection(r.engagement),
    section('Реализовано за период', r.implemented.length === 0 ? h('p', { class: 'muted' }, 'Нет')
      : table(['№', 'Тема', 'Категория', 'Что сделано'], ticketRows(r.implemented))),
    section('Отклонено за период', r.rejected.length === 0 ? h('p', { class: 'muted' }, 'Нет')
      : table(['№', 'Тема', 'Категория', 'Причина'], ticketRows(r.rejected))),
    h('div', { class: 'an-grid' },
      section('Подано по категориям', r.byCategory.length === 0 ? h('p', { class: 'muted' }, 'Нет')
        : table(['Категория', 'Обращений'], r.byCategory.map((c) => [c.label, String(c.count)]))),
      section('Самые поддержанные', r.topSupported.length === 0 ? h('p', { class: 'muted' }, 'Нет')
        : table(['№', 'Тема', 'Поддержали'], r.topSupported.map((s) => [h('a', { href: `#/t/${s.id}`, class: 't-code' }, s.code), s.title, String(s.supports)])))),
    section('Нагрузка по ответственным (на текущий момент)',
      table(['Ответственный', 'В работе', 'Без первого ответа', 'Просрочено'], r.workload.map((w) => [w.name, String(w.open), String(w.waiting), String(w.overdue)]))));
}
