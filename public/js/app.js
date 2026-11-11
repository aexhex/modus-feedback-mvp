// Оболочка SPA: сессия, навигация по ролям, хэш-роутер, колокольчик уведомлений.
import { h, mount, toast, icon, themeToggle } from './dom.js';
import { get, post, del } from './api.js';
import { renderLogin } from './views/login.js';
import { renderList } from './views/list.js';
import { renderNew } from './views/new.js';
import { renderTicket } from './views/ticket.js';
import { renderBoard } from './views/board.js';
import { renderAnalytics } from './views/analytics.js';
import { renderAdmin } from './views/admin.js';
import { renderHome } from './views/home.js';
import { renderKanban } from './views/kanban.js';
import { renderSurveys } from './views/surveys.js';
import { renderClients, renderClientForm } from './views/clients.js';
import { renderReport } from './views/report.js';
import { renderDigest } from './views/digest.js';

const NOTIFY_POLL_MS = 30_000;
const root = document.getElementById('app');
const session = { me: null, meta: null };
let pollTimer = null;

const isOversight = (me) => me.role === 'manager' || me.role === 'admin';

const ROUTES = [
  { re: /^\/home$/, view: renderHome },
  { re: /^\/kanban$/, view: renderKanban, allow: (me) => me.role !== 'employee' },
  { re: /^\/new$/, view: renderNew },
  { re: /^\/tickets$/, view: renderList },
  { re: /^\/t\/(\d+)$/, view: renderTicket },
  { re: /^\/board$/, view: renderBoard },
  { re: /^\/analytics$/, view: renderAnalytics, allow: isOversight },
  { re: /^\/admin$/, view: renderAdmin, allow: (me) => me.role === 'admin' },
  { re: /^\/surveys(?:\/(\d+)(\/results)?)?$/, view: renderSurveys },
  { re: /^\/clients$/, view: renderClients, allow: isOversight },
  { re: /^\/report$/, view: renderReport, allow: isOversight },
  { re: /^\/digest$/, view: renderDigest, allow: isOversight },
];

function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const [path, query = ''] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(query)) };
}

const defaultRoute = () => '#/home';

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

async function loadSession() {
  try {
    const me = await get('/me');
    const meta = await get('/meta');
    Object.assign(session, { me, meta });
  } catch {
    Object.assign(session, { me: null, meta: null });
  }
}

// Меню сгруппировано по смыслу: обращения, идеи, аналитика, обратная связь. Пустые группы не показываются.
function navGroups(me) {
  const groups = [
    { title: null, items: [{ href: '#/home', label: 'Главная' }] },
    { title: 'Обращения', items: [
      { href: '#/tickets?scope=mine', label: 'Мои обращения' },
      me.role === 'handler' && { href: '#/tickets?scope=assigned', label: 'Назначенные мне' },
      isOversight(me) && { href: '#/tickets?scope=all', label: 'Все обращения' },
      me.role !== 'employee' && { href: '#/kanban', label: 'Канбан' },
    ] },
    { title: 'Идеи', items: [
      { href: '#/tickets?scope=feed', label: 'Идеи коллег' },
      { href: '#/board', label: 'Итоги внедрения' },
    ] },
    { title: 'Аналитика', items: [
      isOversight(me) && { href: '#/analytics', label: 'Показатели' },
      isOversight(me) && { href: '#/digest', label: 'Сводка недели' },
      isOversight(me) && { href: '#/report', label: 'Отчёт за период' },
    ] },
    { title: 'Обратная связь', items: [
      { href: '#/surveys', label: 'Опросы' },
      isOversight(me) && { href: '#/clients', label: 'Отзывы клиентов' },
    ] },
    { title: null, items: [me.role === 'admin' && { href: '#/admin', label: 'Настройки' }] },
  ];
  return groups.map((g) => ({ ...g, items: g.items.filter(Boolean) })).filter((g) => g.items.length > 0);
}

function bell() {
  const count = h('span', { class: 'bell-count', id: 'bell-count', hidden: true });
  const panel = h('div', { class: 'notif-panel', hidden: true });
  const toggle = async () => {
    if (!panel.hidden) { panel.hidden = true; return; }
    const { items } = await get('/notifications');
    mount(panel, items.length === 0
      ? h('div', { class: 'empty' }, 'Уведомлений пока нет')
      : items.map((n) => h('a', {
        href: n.ticket_id ? `#/t/${n.ticket_id}` : '#', class: n.is_read ? '' : 'unread',
        onclick: () => { panel.hidden = true; },
      }, n.text, h('div', { class: 't-sub' }, new Date(n.created_at).toLocaleString('ru-RU')))));
    panel.hidden = false;
    await post('/notifications/read');
    count.hidden = true;
  };
  return h('div', { class: 'bell' },
    h('button', { class: 'btn btn-ghost', 'aria-label': 'Уведомления', onclick: toggle }, icon('bell', 20)), count, panel);
}


async function refreshBell() {
  const el = document.getElementById('bell-count');
  if (!el || !session.me) return;
  try {
    const { unread } = await get('/notifications');
    el.textContent = String(unread);
    el.hidden = unread === 0;
  } catch {
    // Тихо пропускаем: следующий опрос повторит попытку, ошибка сессии обработается при навигации.
  }
}

async function logout() {
  // Черновик обращения не должен достаться следующему человеку за этим компьютером.
  try {
    localStorage.removeItem(`draft:${session.me?.id}`);
  } catch {
    // Хранилище недоступно — черновика и не было.
  }
  await del('/session').catch(() => null);
  clearInterval(pollTimer);
  Object.assign(session, { me: null, meta: null });
  location.hash = '#/login';
  render();
}

function shell(me, path, query) {
  const current = `#${path}${query.scope ? `?scope=${query.scope}` : ''}`;
  const content = h('main', { class: 'content', id: 'content' });
  mount(root,
    h('aside', { class: 'side' },
      h('div', { class: 'brand' },
        h('div', { class: 'brand-mark' }, 'М'),
        h('div', null, h('div', { class: 'brand-name' }, 'Голос сотрудника'), h('div', { class: 'brand-sub' }, 'ГК «Модус Трейд»'))),
      h('nav', { class: 'nav', 'aria-label': 'Основная навигация' },
        h('a', { href: '#/new', class: `nav-cta ${path === '/new' ? 'active' : ''}` }, '+ Новое обращение'),
        navGroups(me).map((g) => h('div', { class: 'nav-group' },
          g.title && h('span', { class: 'nav-title' }, g.title),
          g.items.map((item) => h('a', { href: item.href, class: item.href === current ? 'active' : '', 'aria-current': item.href === current ? 'page' : null }, item.label))))),
      h('div', { class: 'side-foot' }, 'MVP · демонстрационные данные')),
    h('div', { class: 'main' },
      h('header', { class: 'topbar' },
        themeToggle(),
        bell(),
        h('div', { class: 'user-chip' }, h('b', null, me.name), h('span', null, `${me.roleLabel} · ${me.department}`)),
        h('button', { class: 'btn btn-sm', onclick: logout }, 'Сменить роль')),
      content));
  return content;
}

async function render() {
  const { path, query } = parseHash();
  // Форма отзыва для клиентов открывается без входа — и у сотрудника, и у постороннего.
  if (path === '/client') {
    root.className = 'app app-login';
    return renderClientForm(root);
  }
  if (!session.me) {
    root.className = 'app app-login';
    return renderLogin(root, {
      onLogin: async (userId) => {
        await post('/session', { userId });
        await loadSession();
        startPolling();
        go(defaultRoute(session.me));
      },
    });
  }
  if (path === '/' || path === '/login') return go(defaultRoute(session.me));
  root.className = 'app';
  const content = shell(session.me, path, query);
  refreshBell();
  const route = ROUTES.find((r) => r.re.test(path));
  if (!route || (route.allow && !route.allow(session.me))) {
    return mount(content, h('div', { class: 'empty' }, 'Страница не найдена или нет доступа'));
  }
  const params = path.match(route.re).slice(1);
  const ctx = {
    me: session.me, meta: session.meta, query, params, go, rerender: render,
    refreshMeta: async () => { session.meta = await get('/meta'); },
  };
  try {
    await route.view(content, ctx);
  } catch (error) {
    if (error.status === 401) return logout();
    mount(content, h('div', { class: 'empty' }, error.message));
    toast(error.message, 'error');
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshBell, NOTIFY_POLL_MS);
}

window.addEventListener('hashchange', render);
await loadSession();
if (session.me) startPolling();
render();
