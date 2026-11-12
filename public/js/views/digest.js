// Сводка за неделю: изменения к прошлой неделе и готовый текст для рассылки.
import { h, mount, toast } from '../dom.js';
import { get, post } from '../api.js';

const ruDate = (date) => date.split('-').reverse().join('.');

function deltaTile(value, delta, label) {
  const trend = delta === undefined ? null
    : h('span', { class: `delta ${delta > 0 ? 'delta-up' : delta < 0 ? 'delta-down' : ''}` },
      delta > 0 ? `+${delta}` : String(delta), ' к прошлой неделе');
  return h('div', { class: 'kpi' }, h('div', { class: 'kpi-value' }, String(value)), h('div', { class: 'kpi-label' }, label), trend);
}

const list = (title, items, render, empty) => h('section', { class: 'card' },
  h('h3', null, title),
  items.length === 0 ? h('p', { class: 'muted' }, empty) : h('ul', { class: 'list-plain' }, items.map(render)));

export async function renderDigest(el, { meta }) {
  const live = meta.b24Mode !== 'off';
  const d = await get('/digest');
  const t = d.totals;
  const textBox = h('textarea', { rows: 14, readonly: true, class: 'digest-text', 'aria-label': 'Текст сводки' }, d.text);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(d.text);
      toast('Текст сводки скопирован', 'success');
    } catch {
      textBox.select();
      toast('Не удалось скопировать автоматически — текст выделен, нажмите Ctrl+C', 'error');
    }
  };
  const send = async () => {
    try {
      const { recipients } = await post('/digest/send');
      toast(live ? `Сводка поставлена в отправку в Битрикс24, получателей: ${recipients}` : `Сводка отправлена руководителям: ${recipients} (имитация, см. журнал Битрикс24)`, 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Сводка за неделю'), h('p', null, `${ruDate(d.from)} — ${ruDate(d.to)} · сравнение с предыдущими семью днями`)),
      h('a', { class: 'btn', href: '#/report' }, 'Отчёт за другой период')),
    h('div', { class: 'kpis' },
      deltaTile(t.created, d.delta.created, 'Подано'),
      deltaTile(t.resolved, d.delta.resolved, 'Рассмотрено'),
      deltaTile(t.implemented, d.delta.implemented, 'Реализовано'),
      deltaTile(t.openNow, undefined, 'В работе сейчас'),
      deltaTile(t.overdueNow, undefined, 'Просрочено сейчас'),
      deltaTile(d.clients.count === 0 ? '—' : d.clients.value, undefined, `NPS клиентов за неделю (отзывов: ${d.clients.count})`)),
    h('div', { class: 'an-grid' },
      list('Реализовано за неделю', d.implemented, (x) => h('li', null, h('a', { href: `#/t/${x.id}` }, h('span', { class: 't-code' }, x.code), ' ', x.title)), 'Нет'),
      list('Требуют внимания', d.overdue, (x) => h('li', null, h('a', { href: `#/t/${x.id}` }, h('span', { class: 't-code' }, x.code), ' ', x.title),
        h('div', { class: 't-sub' }, `${x.kind === 'first_response' ? 'Нет первого ответа' : 'Истёк срок решения'} · ${x.assignee ?? 'без ответственного'}`)), 'Просрочек нет'),
      list('Идеи с наибольшей поддержкой', d.topVoted, (x) => h('li', { class: 'row home-between' },
        h('a', { href: `#/t/${x.id}` }, h('span', { class: 't-code' }, x.code), ' ', x.title), h('span', { class: 'chip' }, `голосов: ${x.votes}`)), 'Голосов пока нет')),
    h('section', { class: 'card digest-share' },
      h('h3', null, 'Текст для рассылки'),
      h('p', { class: 't-sub' }, live
        ? 'Можно вставить в письмо или чат. Кнопка «Разослать» отправляет сводку руководителям уведомлением в Битрикс24.'
        : 'Можно вставить в письмо или чат. Кнопка «Разослать» в MVP записывает отправку в журнал имитации Битрикс24.'),
      textBox,
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: copy }, 'Скопировать текст'),
        h('button', { class: 'btn btn-primary', onclick: send }, live ? 'Разослать руководителям в Битрикс24' : 'Разослать руководителям (имитация)'))));
}
