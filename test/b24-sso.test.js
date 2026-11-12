// Вход через Битрикс24 (OAuth): полный путь через демо-портал, защита state и кода,
// рабочая установка без входа из списка, привязка администратора по ADMIN_B24_ID.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestApp } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { bootstrapAdmin } from '../src/seed.js';
import { login } from '../src/auth.js';
import { SESSION_COOKIE } from '../src/config.js';
import { readIntegrationConfig, resolveEndpoints } from '../src/integrations/config.js';
import { b24UserByCode } from '../src/integrations/b24-sso.js';
import { IntegrationError } from '../src/integrations/clients.js';
import { previewOrgSync } from '../src/integrations/b24-org.js';

const CLOSED_PORT_WEBHOOK = 'http://127.0.0.1:9/rest/1/secret/'; // порт discard — портал «недоступен»

const cookieOf = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? '').split(';')[0];
const b24IdOf = (app, name) => app.db.prepare('SELECT b24_id FROM users WHERE name = ?').get(name).b24_id;

// Браузер без автоперехода: каждый 302 проверяем сами.
function browser(base) {
  const jar = new Map();
  const go = async (path) => {
    const cookie = [...jar.values()].filter((c) => !c.endsWith('=')).join('; ');
    const res = await fetch(new URL(path, base), { redirect: 'manual', headers: cookie ? { cookie } : {} });
    for (const c of res.headers.getSetCookie()) jar.set(c.split('=')[0], c.split(';')[0]);
    return res;
  };
  return { go, jar };
}

// Вход через демо-портал от лица сотрудника портала с указанным ID Битрикс24.
async function loginViaPortal(app, b24Id) {
  const b = browser(app.base);
  const start = await b.go('/api/auth/b24/start');
  const authorize = new URL(start.headers.get('location'), app.base);
  authorize.searchParams.set('user', String(b24Id));
  const portal = await b.go(authorize.pathname + authorize.search);
  const callback = await b.go(portal.headers.get('location'));
  return { b, start, portal, callback };
}

describe('настройки входа через Битрикс24', () => {
  it('режим входа: демо, рабочий портал или выключен', () => {
    assert.equal(readIntegrationConfig({ env: {} }).sso.mode, 'off');
    assert.equal(readIntegrationConfig({ env: {}, demoMode: true }).sso.mode, 'demo');
    const live = readIntegrationConfig({
      env: { B24_WEBHOOK_URL: 'https://modus.bitrix24.kz/rest/7/secret', B24_CLIENT_ID: 'local.abc', B24_CLIENT_SECRET: 's3cr3t' },
    });
    assert.deepEqual(live.sso, { mode: 'live', portal: 'https://modus.bitrix24.kz', clientId: 'local.abc', clientSecret: 's3cr3t' });
    const { sso } = resolveEndpoints(live, 'http://127.0.0.1:3000');
    assert.equal(sso.authorize, 'https://modus.bitrix24.kz/oauth/authorize/');
    assert.equal(sso.token, 'https://oauth.bitrix.info/oauth/token/');
    assert.equal(sso.domain, 'modus.bitrix24.kz');
    // Портал с вебхуком, но без приложения: вход из списка, как раньше.
    assert.equal(readIntegrationConfig({ env: { B24_WEBHOOK_URL: 'https://modus.bitrix24.kz/rest/7/secret' }, demoMode: true }).sso.mode, 'off');
  });

  it('неполные настройки — ошибка при запуске, а не при первом входе', () => {
    assert.throws(() => readIntegrationConfig({ env: { B24_CLIENT_ID: 'local.abc' } }), /задаются вместе/);
    assert.throws(() => readIntegrationConfig({ env: { B24_CLIENT_ID: 'local.abc', B24_CLIENT_SECRET: 's' } }), /B24_WEBHOOK_URL/);
  });
});

describe('вход через демо-портал Битрикс24', () => {
  let app;
  before(async () => { app = await startTestApp({ demoMode: true }); });
  after(() => app.close());

  it('в демо доступны оба способа входа', async () => {
    const { json } = await app.request(null, 'GET', '/api/auth/options');
    assert.deepEqual(json.data, { b24: true, list: true });
  });

  it('до загрузки оргструктуры сотрудник портала не связан — понятная ошибка, без сессии', async () => {
    const { callback } = await loginViaPortal(app, 101);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/?login_error=not_linked');
    assert.equal(cookieOf(callback, SESSION_COOKIE), '');
  });

  it('после загрузки оргструктуры сотрудник входит учётной записью портала', async () => {
    const admin = await app.as('Администратор системы');
    await admin.post('/api/admin/integrations/b24/org-apply');

    const { b, start, portal, callback } = await loginViaPortal(app, b24IdOf(app, 'Сотрудник офиса'));
    assert.equal(start.status, 302);
    assert.match(start.headers.get('location'), /^\/demo-portal\/b24\/oauth\/authorize\/\?client_id=local\.golos-demo&state=[0-9a-f]{48}$/);
    assert.match(start.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax; Max-Age=600/);
    assert.match(portal.headers.get('location'), /^\/api\/auth\/b24\/callback\?code=[0-9a-f]{32}&state=/);
    assert.equal(callback.headers.get('location'), '/');
    const me = await b.go('/api/me');
    const meData = (await me.json()).data;
    assert.equal(meData.name, 'Сотрудник офиса');
    assert.equal(meData.canSwitch, true, 'в демо можно вернуться к выбору роли');
    assert.equal(b.jar.get('b24_state'), 'b24_state=', 'state одноразовый: cookie сброшена');
  });

  it('администратор связывает вручную того, кого система не связала сама', async () => {
    const admin = await app.as('Администратор системы');
    const preview = (await admin.post('/api/admin/integrations/b24/org-preview')).json.data;
    const entry = preview.notLinked.find((u) => u.name === 'Администратор системы');
    const [candidate] = entry.candidates;
    // Чужие права и ошибки — до связывания.
    const employee = await app.as('Сотрудник офиса');
    assert.equal((await employee.post('/api/admin/integrations/b24/link', { userId: entry.userId, b24Id: candidate.b24Id })).status, 403);
    const taken = b24IdOf(app, 'Сотрудник офиса');
    assert.equal((await admin.post('/api/admin/integrations/b24/link', { userId: entry.userId, b24Id: taken })).status, 409);
    assert.equal((await admin.post('/api/admin/integrations/b24/link', { userId: entry.userId, b24Id: 99999 })).status, 404);
    assert.equal((await admin.post('/api/admin/integrations/b24/link', { userId: entry.userId, b24Id: 'abc' })).status, 400);

    const linked = await admin.post('/api/admin/integrations/b24/link', { userId: entry.userId, b24Id: candidate.b24Id });
    assert.equal(linked.status, 200);
    assert.equal(b24IdOf(app, 'Администратор системы'), candidate.b24Id);
    assert.equal((await admin.post('/api/admin/integrations/b24/link', { userId: entry.userId, b24Id: candidate.b24Id })).status, 409, 'повторно не связывается');
    assert.ok((await admin.get('/api/admin/audit')).json.data.some((a) => a.action === 'Сотрудник связан с Битрикс24 вручную'));
    const { callback } = await loginViaPortal(app, candidate.b24Id);
    assert.equal(callback.headers.get('location'), '/', 'после связывания администратор входит через портал');
  });

  it('администратор отвязывает сотрудника: вход через портал закрыт, сессии закрыты', async () => {
    const admin = await app.as('Администратор системы');
    const b24Id = b24IdOf(app, 'Сотрудник офиса');
    const employee = await app.as('Сотрудник офиса');
    assert.equal((await employee.post('/api/admin/integrations/b24/unlink', { userId: app.userId('Сотрудник офиса') })).status, 403);
    const users = (await admin.get('/api/admin/users')).json.data;
    assert.equal(users.find((u) => u.name === 'Сотрудник офиса').b24Id, b24Id, 'администратор видит ID Битрикс24');
    const listed = (await app.request(null, 'GET', '/api/demo-users')).json.data.users;
    assert.equal(listed[0].b24Id, undefined, 'список для входа ID не показывает');

    const res = await admin.post('/api/admin/integrations/b24/unlink', { userId: app.userId('Сотрудник офиса') });
    assert.equal(res.status, 200);
    assert.equal(b24IdOf(app, 'Сотрудник офиса'), null);
    assert.equal((await employee.get('/api/me')).status, 401, 'открытая сессия закрыта');
    const { callback } = await loginViaPortal(app, b24Id);
    assert.equal(callback.headers.get('location'), '/?login_error=not_linked');
    assert.ok((await admin.get('/api/admin/audit')).json.data.some((a) => a.action === 'Сотрудник отвязан от Битрикс24'));
    assert.equal((await admin.post('/api/admin/integrations/b24/unlink', { userId: app.userId('Сотрудник офиса') })).status, 409);
    assert.equal((await admin.post('/api/admin/integrations/b24/unlink', { userId: app.userId('Администратор системы') })).status, 400, 'свою связь не снять');
    // Вернуть связь — тем же ручным связыванием.
    assert.equal((await admin.post('/api/admin/integrations/b24/link', { userId: app.userId('Сотрудник офиса'), b24Id })).status, 200);
  });

  it('уволенного на портале связать нельзя', async () => {
    const admin = await app.as('Администратор системы');
    const unlinked = app.db.prepare("INSERT INTO users (name, role, department) VALUES ('Новый сотрудник', 'employee', 'IT')").run().lastInsertRowid;
    // «Руководитель проекта» уволен на демо-портале: снимаем связь в системе и пробуем связать заново.
    const dismissedId = b24IdOf(app, 'Руководитель проекта');
    assert.ok(dismissedId);
    app.db.prepare("UPDATE users SET b24_id = NULL WHERE name = 'Руководитель проекта'").run();
    const res = await admin.post('/api/admin/integrations/b24/link', { userId: Number(unlinked), b24Id: dismissedId });
    assert.equal(res.status, 404);
  });

  it('страница входа портала показывает только действующих сотрудников', async () => {
    const b = browser(app.base);
    const start = await b.go('/api/auth/b24/start');
    const html = await (await b.go(start.headers.get('location'))).text();
    assert.match(html, /Демо-портал Битрикс24/);
    assert.ok(html.includes('<b>Инженер сервиса</b>'));
    assert.ok(!html.includes('<b>Руководитель проекта</b>'), 'уволенного на портале нет в списке');
  });

  it('чужой или подделанный state не пускает', async () => {
    const attacker = await loginViaPortal(app, b24IdOf(app, 'Сотрудник офиса'));
    // Ссылку возврата атакующего открывают в другом браузере — там другой state или его нет.
    const victim = browser(app.base);
    await victim.go('/api/auth/b24/start');
    const res = await victim.go(attacker.portal.headers.get('location'));
    assert.equal(res.headers.get('location'), '/?login_error=state');
    assert.equal(cookieOf(res, SESSION_COOKIE), '');
    const noCookie = await browser(app.base).go(attacker.portal.headers.get('location'));
    assert.equal(noCookie.headers.get('location'), '/?login_error=state');
  });

  it('код одноразовый, отказ на портале — понятная ошибка', async () => {
    const { b, portal } = await loginViaPortal(app, b24IdOf(app, 'Сотрудник офиса'));
    await b.go('/api/auth/b24/start'); // новый state в том же браузере
    const state = b.jar.get('b24_state').split('=')[1];
    const reuse = await b.go(portal.headers.get('location').replace(/state=[^&]*/, `state=${state}`));
    assert.equal(reuse.headers.get('location'), '/?login_error=failed');

    await b.go('/api/auth/b24/start');
    const fresh = b.jar.get('b24_state').split('=')[1];
    const denied = await b.go(`/api/auth/b24/callback?error=access_denied&state=${fresh}`);
    assert.equal(denied.headers.get('location'), '/?login_error=denied');
  });

  it('отключённый в системе сотрудник не входит', async () => {
    const b24Id = b24IdOf(app, 'Сотрудник закупок');
    assert.ok(b24Id, 'сотрудник связан с порталом');
    app.db.prepare("UPDATE users SET is_active = 0 WHERE name = 'Сотрудник закупок'").run();
    const { callback } = await loginViaPortal(app, b24Id);
    assert.equal(callback.headers.get('location'), '/?login_error=not_linked');
  });
});

describe('рабочая установка со входом через Битрикс24', () => {
  let app;
  before(async () => {
    app = await startTestApp({
      demoMode: false,
      integrations: { b24WebhookUrl: CLOSED_PORT_WEBHOOK, b24ClientId: 'local.abc', b24ClientSecret: 's3cr3t' },
    });
  });
  after(() => app.close());

  it('вход из списка закрыт, список сотрудников наружу не отдаётся', async () => {
    assert.deepEqual((await app.request(null, 'GET', '/api/auth/options')).json.data, { b24: true, list: false });
    assert.equal((await app.request(null, 'GET', '/api/demo-users')).status, 403);
    const session = await app.request(null, 'POST', '/api/session', { userId: app.userId('Администратор системы') });
    assert.equal(session.status, 403);
  });

  it('DEMO_MODE=1 не открывает вход без пароля, если подключён настоящий портал', async () => {
    const demo = await startTestApp({
      demoMode: true,
      integrations: { b24WebhookUrl: CLOSED_PORT_WEBHOOK, b24ClientId: 'local.abc', b24ClientSecret: 's3cr3t' },
    });
    try {
      assert.deepEqual((await demo.request(null, 'GET', '/api/auth/options')).json.data, { b24: true, list: false });
      assert.equal((await demo.request(null, 'GET', '/api/demo-users')).status, 403);
    } finally {
      await demo.close();
    }
  });

  it('вошедшему через портал — кнопка «Выйти», а не «Сменить роль»', async () => {
    const token = login(app.db, app.userId('Администратор системы'), new Date().toISOString());
    const me = await app.request(`${SESSION_COOKIE}=${token}`, 'GET', '/api/me');
    assert.equal(me.json.data.canSwitch, false);
  });

  it('вход ведёт на страницу входа портала компании, секрет приложения в браузер не уходит', async () => {
    const res = await fetch(`${app.base}/api/auth/b24/start`, { redirect: 'manual' });
    const location = res.headers.get('location');
    assert.equal(location.split('?')[0], 'http://127.0.0.1:9/oauth/authorize/');
    assert.match(location, /client_id=local\.abc&state=/);
    assert.ok(!location.includes('s3cr3t'));
  });

  it('портал недоступен — понятная ошибка вместо падения', async () => {
    const b = browser(app.base);
    await b.go('/api/auth/b24/start');
    const state = b.jar.get('b24_state').split('=')[1];
    const res = await b.go(`/api/auth/b24/callback?code=abc&state=${state}`);
    assert.equal(res.headers.get('location'), '/?login_error=failed');
  });
});

describe('обмен кода на ID пользователя', () => {
  let server;
  let base;
  let tokenReply;
  let meReply = { result: { ID: '42', ACTIVE: true } };
  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.startsWith('/oauth/token/')) return res.end(JSON.stringify(tokenReply));
      return res.end(JSON.stringify(meReply));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));

  const endpoints = () => ({ token: `${base}/oauth/token/`, rest: `${base}/rest/`, domain: new URL(base).host });
  const sso = { clientId: 'local.abc', clientSecret: 's' };

  it('возвращает ID пользователя портала', async () => {
    tokenReply = { access_token: 't', client_endpoint: `${base}/rest/` };
    assert.deepEqual(await b24UserByCode(sso, endpoints(), 'c'), { id: 42, active: true });
  });

  it('уволенный на портале помечается неактивным (ACTIVE false или N)', async () => {
    tokenReply = { access_token: 't', client_endpoint: `${base}/rest/` };
    for (const ACTIVE of [false, 'N']) {
      meReply = { result: { ID: '42', ACTIVE } };
      assert.equal((await b24UserByCode(sso, endpoints(), 'c')).active, false);
    }
    meReply = { result: { ID: '42', ACTIVE: 'Y' } };
    assert.equal((await b24UserByCode(sso, endpoints(), 'c')).active, true);
  });

  it('токен другого портала отклоняется', async () => {
    tokenReply = { access_token: 't', client_endpoint: 'https://other.bitrix24.ru/rest/' };
    await assert.rejects(b24UserByCode(sso, endpoints(), 'c'), (e) => e instanceof IntegrationError && /другим порталом/.test(e.message));
  });

  it('ошибка портала приходит понятным текстом', async () => {
    tokenReply = { error: 'invalid_grant', error_description: 'Invalid authorization code' };
    await assert.rejects(b24UserByCode(sso, endpoints(), 'c'), /Invalid authorization code/);
  });
});

describe('связывание с порталом по ФИО', () => {
  let server;
  let url;
  before(async () => {
    const users = [
      { ID: '201', NAME: 'Иван Петров', ACTIVE: true, UF_DEPARTMENT: [1] },
      { ID: '202', NAME: 'Иван Петров', ACTIVE: true, UF_DEPARTMENT: [1] },
      { ID: '203', NAME: 'Админ', ACTIVE: true, UF_DEPARTMENT: [1] },
      { ID: '204', NAME: 'Пётр Сидоров', ACTIVE: true, UF_DEPARTMENT: [1] },
    ];
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const result = req.url.includes('department.get') ? [{ ID: '1', NAME: 'IT' }] : users;
      res.end(JSON.stringify({ result, total: result.length }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}/rest/1/x/`;
  });
  after(() => new Promise((r) => server.close(r)));

  it('администратор и одинаковые ФИО по имени не связываются: связь открывает вход', async () => {
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO users (name, role, department) VALUES ('Иван Петров', 'employee', 'IT'), ('Админ', 'admin', 'IT'), ('Пётр Сидоров', 'employee', 'IT')").run();
    const p = await previewOrgSync(db, url);
    assert.deepEqual(p.linked, ['Пётр Сидоров']);
    assert.deepEqual(p.notLinked.map((u) => u.name), ['Иван Петров', 'Админ']);
    assert.deepEqual(p.notLinked[0].candidates.map((c) => c.b24Id), [201, 202], 'оба однофамильца — кандидаты');
    assert.deepEqual(p.created, [], 'не связанные не дублируются новыми учётными записями');
  });
});

describe('администратор рабочей установки', () => {
  it('ADMIN_B24_ID связывает первого администратора с порталом', () => {
    const db = openDatabase(':memory:');
    assert.equal(bootstrapAdmin(db, 'Админ', '17'), true);
    assert.equal(db.prepare("SELECT b24_id FROM users WHERE role = 'admin'").get().b24_id, 17);
  });

  it('вход через портал включили позже — ID дописывается не связанному администратору', () => {
    const db = openDatabase(':memory:');
    bootstrapAdmin(db, 'Админ');
    assert.equal(bootstrapAdmin(db, 'Админ', '17'), false);
    assert.equal(db.prepare("SELECT b24_id FROM users WHERE role = 'admin'").get().b24_id, 17);
    assert.throws(() => bootstrapAdmin(db, 'Админ', 'abc'), /числовой ID/);
  });
});
