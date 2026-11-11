import { h, mount, toast, badge, slaChip, fmtRelative, options, debounce } from '../dom.js';
import { get, getWithMeta, qs } from '../api.js';

const TITLES = {
  mine: ['Мои обращения', 'Всё, что вы отправили, и что с этим происходит сейчас.'],
  assigned: ['Назначенные мне', 'Обращения, которые ждут вашего решения. Просроченные отмечены красным.'],
  all: ['Все обращения', 'Полный реестр с фильтрами по подразделению, категории, статусу и срокам.'],
  feed: ['Лента идей', 'Обращения, которые авторы открыли для всех. Комментируйте и поддерживайте — так идея быстрее попадёт в работу.'],
};
const FILTER_KEYS = ['q', 'type', 'status', 'category', 'priority', 'department', 'sort'];

// Фильтры и страница хранятся в адресе: ссылкой на выборку можно поделиться.
function readFilters(query) {
  const picked = Object.fromEntries(FILTER_KEYS.map((key) => [key, query[key] ?? '']));
  return { ...picked, overdue: query.overdue === '1', page: Math.max(1, Number.parseInt(query.page, 10) || 1) };
}

const toParams = (scope, filters) => ({
  scope, ...filters, overdue: filters.overdue ? '1' : '', page: filters.page > 1 ? filters.page : '',
});

function scopeTabs(me, scope) {
  const tabs = [['mine', 'Мои']];
  if (me.role === 'handler') tabs.push(['assigned', 'Назначенные мне']);
  if (me.role === 'manager' || me.role === 'admin') tabs.push(['all', 'Все']);
  if (tabs.length < 2) return null;
  return h('nav', { class: 'tabs' },
    tabs.map(([key, label]) => h('a', { href: `#/tickets?scope=${key}`, class: key === scope ? 'active' : '' }, label)));
}

function row(t, go) {
  const sub = [t.category.name, t.department ?? 'анонимно', t.supportsCount ? `поддержали ${t.supportsCount}` : null,
    t.votesCount ? `голосов ${t.votesCount}` : null];
  return h('tr', { class: t.sla.overdue ? 'overdue' : '', onclick: () => go(`#/t/${t.id}`) },
    h('td', null, h('span', { class: 't-code' }, t.code)),
    h('td', null, h('div', { class: 't-title' }, t.title), h('div', { class: 't-sub' }, sub.filter(Boolean).join(' · '))),
    h('td', null, badge('type', t.type, t.typeLabel)),
    h('td', null, badge('status', t.status, t.statusLabel)),
    h('td', null, badge('priority', t.priority, t.priorityLabel)),
    h('td', null, t.assignee?.name ?? '—'),
    h('td', null, h('div', null, fmtRelative(t.createdAt)), h('div', { class: 't-sub' }, slaChip(t))));
}

function pager(meta, onPage) {
  const pages = Math.max(1, Math.ceil(meta.total / meta.limit));
  if (pages < 2) return null;
  return h('nav', { class: 'pager', 'aria-label': 'Страницы' },
    h('button', { class: 'btn btn-sm', disabled: meta.page <= 1, onclick: () => onPage(meta.page - 1) }, '← Назад'),
    h('span', { class: 'muted' }, `Страница ${meta.page} из ${pages}`),
    h('button', { class: 'btn btn-sm', disabled: meta.page >= pages, onclick: () => onPage(meta.page + 1) }, 'Вперёд →'));
}

export async function renderList(el, { me, meta, query, go }) {
  const scope = TITLES[query.scope] ? query.scope : 'mine';
  const [title, subtitle] = TITLES[scope];
  const isOversight = me.role === 'manager' || me.role === 'admin';
  let filters = readFilters(query);
  const results = h('div');
  // В ленте сотрудник видит, сколько у него свободных голосов.
  const votesBanner = h('div', { class: 'callout votes-banner' }, 'Голосуйте за идеи, которые важны вам: откройте идею и распределите голоса.');
  if (scope === 'feed') {
    get('/votes').then((v) => { votesBanner.textContent = `У вас ${v.left} свободных голосов из ${v.budget}. Откройте идею и отдайте ей до ${v.perIdea} голосов — популярные идеи руководитель видит первыми.`; }).catch(() => null);
  }
  let requestSeq = 0;
  const exportLink = h('a', { class: 'btn', download: 'obrashcheniya.csv' }, 'Экспорт в Excel');

  const load = async () => {
    // Список уже снят со страницы (пользователь ушёл, пока ждал отложенный поиск) — ничего не трогаем.
    if (!results.isConnected) return;
    const params = toParams(scope, filters);
    // replaceState не вызывает повторную отрисовку: поле поиска не теряет фокус.
    history.replaceState(null, '', `#/tickets${qs(params)}`);
    exportLink.href = `/api/tickets/export${qs({ ...params, page: '' })}`;
    requestSeq += 1;
    const seq = requestSeq;
    const { data: items, meta: pageMeta } = await getWithMeta(`/tickets${qs(params)}`);
    // Устаревший ответ (пришёл позже более нового запроса) или уход со страницы — не отрисовываем.
    if (seq !== requestSeq || !results.isConnected) return;
    mount(results,
      h('p', { class: 'count' }, `Найдено: ${pageMeta.total}`,
        pageMeta.total > meta.limits.exportMax && ` · в экспорт попадут первые ${meta.limits.exportMax}`),
      items.length === 0
        ? h('div', { class: 'card empty' }, scope === 'mine' && pageMeta.total === 0 ? 'Вы ещё не отправляли обращений.' : 'По выбранным условиям ничего нет.')
        : h('table', { class: 'table' },
          h('thead', null, h('tr', null, ['№', 'Тема', 'Тип', 'Статус', 'Приоритет', 'Ответственный', 'Создано / срок'].map((c) => h('th', null, c)))),
          h('tbody', null, items.map((t) => row(t, go)))),
      pager(pageMeta, (page) => { filters = { ...filters, page }; reload(); }));
  };
  // Обновление из обработчиков событий: истёкшая сессия ведёт на экран входа, прочие ошибки показываются.
  const reload = () => load().catch((error) => {
    if (error.status === 401) location.reload();
    else toast(error.message, 'error');
  });
  const set = (key) => (e) => {
    filters = { ...filters, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value, page: 1 };
    reload();
  };
  const select = (key, items, empty, opts) => h('select', { onchange: set(key), value: filters[key], 'aria-label': empty }, options(items, { empty, ...opts }));

  mount(el,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, title), h('p', null, subtitle)),
      h('div', { class: 'row' }, exportLink, h('a', { class: 'btn btn-signal', href: '#/new' }, '+ Новое обращение'))),
    scopeTabs(me, scope),
    scope === 'feed' && votesBanner,
    h('div', { class: 'filters' },
      h('input', { type: 'search', placeholder: 'Поиск по номеру, теме, тексту', value: filters.q, oninput: debounce(set('q'), 350) }),
      select('type', meta.types, 'Все типы'),
      select('status', meta.statuses, 'Все статусы'),
      select('category', meta.categories, 'Все категории', { valueKey: 'id', labelKey: 'name' }),
      select('priority', meta.priorities, 'Любой приоритет'),
      isOversight
        ? select('department', meta.departments.map((d) => ({ key: d, label: d })), 'Все подразделения')
        : h('span'),
      scope === 'feed'
        ? select('sort', [{ key: 'votes', label: 'Сначала популярные' }], 'Сначала новые')
        : h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: filters.overdue, onchange: set('overdue') }), 'Только просроченные')),
    results);
  await load();
}
