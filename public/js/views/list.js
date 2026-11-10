import { h, mount, badge, slaChip, fmtRelative, options, debounce } from '../dom.js';
import { get, qs } from '../api.js';

const TITLES = {
  mine: ['Мои обращения', 'Всё, что вы отправили, и что с этим происходит сейчас.'],
  assigned: ['Назначенные мне', 'Обращения, которые ждут вашего решения. Просроченные отмечены красным.'],
  all: ['Все обращения', 'Полный реестр с фильтрами по подразделению, категории, статусу и срокам.'],
};

// Фильтры живут в памяти модуля: при возврате к списку выбор сохраняется.
let filters = { q: '', type: '', status: '', category: '', priority: '', department: '', overdue: false };

function scopeTabs(me, scope) {
  const tabs = [['mine', 'Мои']];
  if (me.role === 'handler') tabs.push(['assigned', 'Назначенные мне']);
  if (me.role === 'manager' || me.role === 'admin') tabs.push(['all', 'Все']);
  if (tabs.length < 2) return null;
  return h('nav', { class: 'tabs' },
    tabs.map(([key, label]) => h('a', { href: `#/tickets?scope=${key}`, class: key === scope ? 'active' : '' }, label)));
}

function row(t, go) {
  return h('tr', { class: t.sla.overdue ? 'overdue' : '', onclick: () => go(`#/t/${t.id}`) },
    h('td', null, h('span', { class: 't-code' }, t.code)),
    h('td', null,
      h('div', { class: 't-title' }, t.title),
      h('div', { class: 't-sub' }, `${t.category.name} · ${t.department}${t.supportsCount ? ` · поддержали ${t.supportsCount}` : ''}`)),
    h('td', null, badge('type', t.type, t.typeLabel)),
    h('td', null, badge('status', t.status, t.statusLabel)),
    h('td', null, badge('priority', t.priority, t.priorityLabel)),
    h('td', null, t.assignee?.name ?? '—'),
    h('td', null, h('div', null, fmtRelative(t.createdAt)), h('div', { class: 't-sub' }, slaChip(t))));
}

export async function renderList(el, { me, meta, query, go }) {
  const scope = TITLES[query.scope] ? query.scope : 'mine';
  if (query.category) filters = { ...filters, category: query.category };
  const [title, subtitle] = TITLES[scope];
  const results = h('div');
  const isOversight = me.role === 'manager' || me.role === 'admin';

  const load = async () => {
    const items = await get(`/tickets${qs({ scope, ...filters, overdue: filters.overdue ? '1' : '' })}`);
    mount(results,
      h('p', { class: 'count' }, `Найдено: ${items.length}`),
      items.length === 0
        ? h('div', { class: 'card empty' }, scope === 'mine' ? 'Вы ещё не отправляли обращений.' : 'По выбранным условиям ничего нет.')
        : h('table', { class: 'table' },
          h('thead', null, h('tr', null, ['№', 'Тема', 'Тип', 'Статус', 'Приоритет', 'Ответственный', 'Создано / срок'].map((c) => h('th', null, c)))),
          h('tbody', null, items.map((t) => row(t, go)))));
  };
  const set = (key) => (e) => {
    filters = { ...filters, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value };
    load();
  };
  const select = (key, items, empty, opts) => h('select', { onchange: set(key), value: filters[key], 'aria-label': empty }, options(items, { empty, ...opts }));

  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, title), h('p', null, subtitle)),
      h('a', { class: 'btn btn-signal', href: '#/new' }, '+ Новое обращение')),
    scopeTabs(me, scope),
    h('div', { class: 'filters' },
      h('input', { type: 'search', placeholder: 'Поиск по номеру, теме, тексту', value: filters.q, oninput: debounce(set('q'), 350) }),
      select('type', meta.types, 'Все типы'),
      select('status', meta.statuses, 'Все статусы'),
      select('category', meta.categories, 'Все категории', { valueKey: 'id', labelKey: 'name' }),
      select('priority', meta.priorities, 'Любой приоритет'),
      isOversight
        ? select('department', meta.departments.map((d) => ({ key: d, label: d })), 'Все подразделения')
        : h('span'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: filters.overdue, onchange: set('overdue') }), 'Только просроченные')),
    results);
  await load();
}
