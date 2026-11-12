// ДЕМО-ПОРТАЛ: имитация внешних систем для показа без доступа к настоящему Битрикс24 и 1С.
// Отвечает в тех же форматах, что REST Битрикс24 и OData 1С, поэтому система ходит к нему
// настоящими HTTP-запросами — тем же кодом, что и к боевому порталу. Включается только в демо-режиме.
// Данные синтетические и повторяют демо-датасет с несколькими отличиями, чтобы синхронизация
// показала новых, переведённых и уволенных сотрудников.
import { randomBytes } from 'node:crypto';
import { USERS } from '../seed-data.js';
import { DEMO_CLIENT_ID, DEMO_CLIENT_SECRET, DEMO_PORTAL_PREFIX } from './config.js';

const PAGE = 50;
const CALLS_KEPT = 100; // журнал вызовов демо-портала ограничен: портал открыт без входа
const GRANTS_KEPT = 200; // выданные коды и токены входа — тоже

const HEADS = Object.freeze({
  Закупки: 'Руководитель закупок',
  'Дирекция направлений': 'Руководитель направления',
  'Каталог и НСИ': 'Ответственный за номенклатуру',
  HR: 'HR / внутренние коммуникации',
  Бухгалтерия: 'Руководитель бухгалтерии',
  'Офис процессов': 'Ответственный за процессы',
  IT: 'IT-специалист',
  'Юридический отдел': 'Ответственный за договоры',
  Продажи: 'Руководитель продаж',
  'Проектный офис': 'Руководитель проектов',
  Проектирование: 'Руководитель проектирования',
  'Административный отдел': 'Административный руководитель',
  Дирекция: 'Директор по развитию',
  Сервис: 'Руководитель сервиса',
});

// Отличия портала от демо-датасета системы.
const MOVED = Object.freeze({ 'Координатор проекта': 'Проектирование' });
const DISMISSED = Object.freeze(['Руководитель проекта']);
export const DEMO_HIRED = Object.freeze([['Руководитель сервиса', 'Сервис'], ['Инженер сервиса', 'Сервис'], ['Специалист по закупкам', 'Закупки']]);

// Условные клиенты: названия и ИНН заведомо вымышленные, чтобы их нельзя было спутать
// с реальными организациями (ТЗ 3.5: реальные клиентские данные — только с разрешения).
export const DEMO_COUNTERPARTIES = Object.freeze([
  ['ТОО «Демо-клиент Альфа»', '000000101', '000000000001'],
  ['ТОО «Демо-клиент Бета»', '000000102', '000000000002'],
  ['АО «Демо-клиент Гамма»', '000000103', '000000000003'],
  ['ТОО «Демо-клиент Дельта»', '000000104', '000000000004'],
  ['ТОО «Демо-клиент Эпсилон»', '000000105', '000000000005'],
  ['ГКП «Демо-клиент Зета»', '000000106', '000000000006'],
  ['ТОО «Демо-клиент Эта»', '000000107', '000000000007'],
  ['ТОО «Демо-клиент Тета» (помечен на удаление)', '000000108', '000000000008'],
]);

function buildData() {
  const people = [
    ...USERS.map(([name, , department]) => ({ name, department: MOVED[name] ?? department, active: !DISMISSED.includes(name) })),
    ...DEMO_HIRED.map(([name, department]) => ({ name, department, active: true })),
  ];
  const departments = [...new Set(people.map((p) => p.department))].map((name, i) => ({ ID: String(i + 1), NAME: name }));
  const deptId = new Map(departments.map((d) => [d.NAME, d.ID]));
  const users = people.map((p, i) => ({
    ID: String(101 + i), NAME: p.name, LAST_NAME: '', ACTIVE: p.active, UF_DEPARTMENT: [Number(deptId.get(p.department))],
  }));
  const userId = new Map(users.map((u) => [u.NAME, u.ID]));
  for (const d of departments) d.UF_HEAD = userId.get(HEADS[d.NAME]) ?? '';
  return { departments, users };
}

/** @returns {{ handle: (req, res, path: string, body: object) => void, calls: object[] }} */
export function createDemoPortal() {
  const { departments, users } = buildData();
  const calls = [];
  let nextTaskId = 2400;
  let nextMessageId = 0;
  const tasks = new Map(); // номер задачи → { status (коды REST Битрикс24), title }

  const page = (list, start) => {
    const from = Number(start) || 0;
    const result = list.slice(from, from + PAGE);
    return { result, total: list.length, ...(from + PAGE < list.length ? { next: from + PAGE } : {}) };
  };

  const b24 = {
    'department.get': () => page(departments, 0),
    'user.get': (p) => page(p.ID ? users.filter((u) => u.ID === String(p.ID)) : users, p.start),
    'im.notify': (p) => {
      // Как настоящий портал: неизвестному или отключённому получателю — result: false без ошибки.
      if (!users.some((u) => u.ID === String(p.USER_ID) && u.ACTIVE)) return { result: false };
      nextMessageId += 1;
      return { result: nextMessageId };
    },
    'tasks.task.add': (p) => {
      if (!p.fields?.TITLE) return { error: 'ERROR_CORE', error_description: 'Не указано название задачи' };
      nextTaskId += 1;
      tasks.set(String(nextTaskId), { status: '2', title: String(p.fields.TITLE) });
      return { result: { task: { id: String(nextTaskId), title: p.fields.TITLE } } };
    },
    'tasks.task.get': (p) => (tasks.has(String(p.taskId))
      ? { result: { task: { id: String(p.taskId), status: tasks.get(String(p.taskId)).status } } }
      : { error: 'ERROR_CORE', error_description: 'Задача не найдена или доступ запрещён' }),
    'tasks.task.complete': (p) => {
      if (!tasks.has(String(p.taskId))) return { error: 'ERROR_CORE', error_description: 'Задача не найдена или доступ запрещён' };
      tasks.set(String(p.taskId), { ...tasks.get(String(p.taskId)), status: '5' });
      return { result: { task: { id: String(p.taskId), status: '5' } } };
    },
  };

  // Вход через портал (OAuth): код живёт до первого обмена, токен — до перезапуска сервера.
  const codes = new Map();
  const tokens = new Map();
  const grant = (map, value) => {
    const key = randomBytes(16).toString('hex');
    map.set(key, value);
    if (map.size > GRANTS_KEPT) map.delete(map.keys().next().value);
    return key;
  };
  const deptName = new Map(departments.map((d) => [Number(d.ID), d.NAME]));
  const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  // Страница входа портала. На настоящем портале сотрудник вводит свой логин и пароль Битрикс24,
  // здесь — выбирает, кто «вошёл в портал». Система «Голос сотрудника» пароль не видит в обоих случаях.
  function authorizePage(params) {
    if (params.client_id !== DEMO_CLIENT_ID) return { status: 400, html: '<p>Неизвестное приложение (client_id)</p>' };
    const user = users.find((u) => u.ID === String(params.user) && u.ACTIVE);
    if (user) {
      const code = grant(codes, user.ID);
      const back = new URLSearchParams({
        code, state: params.state ?? '', domain: 'demo-portal', member_id: 'demo', scope: 'user', server_domain: 'oauth.bitrix.info',
      });
      return { status: 302, location: `/api/auth/b24/callback?${back}` };
    }
    const link = (u) => `${DEMO_PORTAL_PREFIX}/b24/oauth/authorize/?${new URLSearchParams({ client_id: DEMO_CLIENT_ID, state: params.state ?? '', user: u.ID })}`;
    const cards = users.filter((u) => u.ACTIVE).map((u) =>
      `<a class="user-card" href="${escapeHtml(link(u))}"><b>${escapeHtml(u.NAME)}</b><span>${escapeHtml(deptName.get(u.UF_DEPARTMENT[0]) ?? '')}</span></a>`).join('');
    return {
      status: 200,
      html: `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Демо-портал Битрикс24 — вход</title><link rel="stylesheet" href="/css/styles.css"></head>
<body><main class="login demo-oauth"><h1>Демо-портал Битрикс24</h1>
<p class="login-note">Имитация входа в облачный портал. На настоящем портале сотрудник входит своим логином и паролем Битрикс24,
а «Голос сотрудника» получает только подтверждение, кто вошёл. Выберите сотрудника портала:</p>
<div class="user-grid">${cards}</div></main></body></html>`,
    };
  }

  const htmlPage = (title, body) => `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<link rel="stylesheet" href="/css/styles.css"></head><body>${body}</body></html>`;

  // Форма, которой портал открывает приложение во фрейме: ключ доступа сотрудника и место встраивания.
  // Один ключ на сотрудника портала: страница может открываться сколько угодно раз, память не растёт.
  const userTokens = new Map();
  const tokenFor = (user) => {
    const known = userTokens.get(user.ID);
    if (known && tokens.has(known)) return known;
    const fresh = grant(tokens, user.ID);
    userTokens.set(user.ID, fresh);
    return fresh;
  };
  const appForm = (user, placement, options, label, cls) => {
    const fields = {
      AUTH_ID: tokenFor(user), AUTH_EXPIRES: '3600', REFRESH_ID: randomBytes(16).toString('hex'),
      member_id: 'demo', status: 'L', LANG: 'ru', PLACEMENT: placement, PLACEMENT_OPTIONS: JSON.stringify(options),
    };
    const hidden = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join('');
    return `<form method="post" action="/api/auth/b24/app" target="app">${hidden}<button class="${cls}">${escapeHtml(label)}</button></form>`;
  };

  // Главная демо-портала: сотрудник «вошёл в портал» и открывает систему пунктом левого меню
  // или вкладкой в задаче — так, как это выглядит в облачном Битрикс24 после установки приложения.
  function portalHome(params) {
    const user = users.find((u) => u.ID === String(params.user) && u.ACTIVE);
    if (!user) {
      const cards = users.filter((u) => u.ACTIVE).map((u) =>
        `<a class="user-card" href="${DEMO_PORTAL_PREFIX}/b24/?user=${u.ID}"><b>${escapeHtml(u.NAME)}</b><span>${escapeHtml(deptName.get(u.UF_DEPARTMENT[0]) ?? '')}</span></a>`).join('');
      return htmlPage('Демо-портал Битрикс24', `<main class="login demo-oauth"><h1>Демо-портал Битрикс24</h1>
<p class="login-note">Имитация облачного портала: «Голос сотрудника» открывается в нём пунктом левого меню и вкладкой в задаче, без отдельного входа. Выберите, кто вошёл в портал:</p>
<div class="user-grid">${cards}</div></main>`);
    }
    const taskForms = [...tasks].map(([id, task]) =>
      `<li>${appForm(user, 'TASK_VIEW_TAB', { taskId: id }, `Задача №${id}: ${task.title} — вкладка «Обращение»`, 'btn btn-ghost btn-sm')}</li>`).join('');
    return htmlPage('Демо-портал Битрикс24', `<main class="demo-portal">
<header class="demo-portal-head"><b>Демо-портал Битрикс24</b>
<span>Вы в портале: ${escapeHtml(user.NAME)} · <a href="${DEMO_PORTAL_PREFIX}/b24/">сменить</a></span></header>
<div class="demo-portal-body">
<nav class="demo-portal-nav" aria-label="Меню портала">
<span class="t-sub">Живая лента</span><span class="t-sub">Задачи и проекты</span><span class="t-sub">Сотрудники</span>
${appForm(user, 'LEFT_MENU', {}, 'Голос сотрудника', 'btn btn-primary btn-sm')}
<h2>Задачи портала</h2>
${taskForms ? `<ul class="list-plain">${taskForms}</ul>` : '<p class="t-sub">Задач пока нет: создайте задачу из карточки обращения.</p>'}
</nav>
<iframe name="app" title="Приложение «Голос сотрудника» в портале"></iframe>
</div></main>`);
  }

  function token(params) {
    const userId = params.client_id === DEMO_CLIENT_ID && params.client_secret === DEMO_CLIENT_SECRET
      && params.grant_type === 'authorization_code' ? codes.get(String(params.code)) : undefined;
    codes.delete(String(params.code));
    if (!userId) return { error: 'invalid_grant', error_description: 'Код недействителен или уже использован' };
    return { access_token: grant(tokens, userId), userId };
  }

  const record = (call) => {
    calls.push(call);
    if (calls.length > CALLS_KEPT) calls.splice(0, calls.length - CALLS_KEPT);
  };

  function handle(req, res, path, params) {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    if (path === '/b24/oauth/authorize/') {
      const page = authorizePage(params);
      if (page.location) {
        res.writeHead(302, { location: page.location, 'cache-control': 'no-store' });
        return res.end();
      }
      res.writeHead(page.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page.html);
    }
    if (path === '/b24/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
      return res.end(portalHome(params));
    }
    if (path === '/b24/oauth/token/') {
      record({ system: 'b24', method: 'oauth.token' });
      const result = token(params);
      if (result.error) return send(400, result);
      return send(200, {
        access_token: result.access_token, expires_in: 3600, scope: 'user', user_id: Number(result.userId),
        member_id: 'demo', domain: 'oauth.bitrix.info', status: 'L',
        client_endpoint: `http://${req.headers.host}${DEMO_PORTAL_PREFIX}/b24/rest/`, server_endpoint: 'https://oauth.bitrix.info/rest/',
      });
    }
    if (path === '/b24/rest/user.current.json') {
      record({ system: 'b24', method: 'user.current' });
      const user = users.find((u) => u.ID === tokens.get(String(params.auth)));
      if (!user) return send(401, { error: 'invalid_token', error_description: 'The access token provided is invalid.' });
      return send(200, { result: { ID: user.ID, NAME: user.NAME, LAST_NAME: user.LAST_NAME, ACTIVE: user.ACTIVE } });
    }
    const b24Match = /^\/b24\/rest\/1\/demo\/([a-z.]+)\.json$/.exec(path);
    if (b24Match) {
      const method = b24[b24Match[1]];
      if (!method) return send(404, { error: 'ERROR_METHOD_NOT_FOUND', error_description: 'Метод не найден' });
      record({ system: 'b24', method: b24Match[1], params });
      return send(200, method(params));
    }
    if (decodeURIComponent(path) === '/1c/odata/standard.odata/Catalog_Контрагенты') {
      record({ system: '1c', method: 'Catalog_Контрагенты' });
      return send(200, {
        value: DEMO_COUNTERPARTIES.map(([name, code, inn], i) => ({
          Ref_Key: `5f0c6a1e-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
          Code: code, Description: name, ИНН: inn, DeletionMark: name.includes('удаление'),
        })),
      });
    }
    return send(404, { error: 'NOT_FOUND' });
  }

  return { handle, calls };
}
