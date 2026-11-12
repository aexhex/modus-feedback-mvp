// Система внутри портала Битрикс24 (пункт меню и вкладка задачи), продление сессии, резервные копии,
// защита cookie входа префиксом __Host-.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestApp, TEST_NOW } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { SESSION_COOKIE } from '../src/config.js';
import { sessionCookie, login } from '../src/auth.js';
import { stateCookie } from '../src/integrations/b24-sso.js';
import { backup } from '../src/backup.js';

const b24IdOf = (app, name) => app.db.prepare('SELECT b24_id FROM users WHERE name = ?').get(name).b24_id;
const sessionOf = (res) => (res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '');

// Форма, которую присылает страница портала: ключ доступа сотрудника берётся со страницы демо-портала.
async function portalForm(app, b24Id, placement = 'LEFT_MENU', options = {}) {
  const html = await (await fetch(`${app.base}/demo-portal/b24/?user=${b24Id}`)).text();
  const authId = /name="AUTH_ID" value="([0-9a-f]+)"/.exec(html)[1];
  return new URLSearchParams({ AUTH_ID: authId, member_id: 'demo', PLACEMENT: placement, PLACEMENT_OPTIONS: JSON.stringify(options) });
}

const openApp = (app, form, origin = app.base) => fetch(`${app.base}/api/auth/b24/app`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) },
  body: form,
});

describe('система внутри демо-портала Битрикс24', () => {
  let app;
  before(async () => {
    app = await startTestApp({ demoMode: true });
    const admin = await app.as('Администратор системы');
    await admin.post('/api/admin/integrations/b24/org-apply');
  });
  after(() => app.close());

  it('пункт левого меню открывает систему под сотрудником портала, без отдельного входа', async () => {
    const res = await openApp(app, await portalForm(app, b24IdOf(app, 'Сотрудник офиса')));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/#/home');
    const cookie = sessionOf(res).split(';')[0];
    const me = await app.request(cookie, 'GET', '/api/me');
    assert.equal(me.json.data.name, 'Сотрудник офиса');
  });

  it('вкладка в задаче открывает исходное обращение', async () => {
    const handler = await app.as('Ответственный за договоры');
    const ticketId = app.ticketId('A-009');
    await handler.post(`/api/tickets/${ticketId}/b24-task`);
    await app.delivery.idle();
    const taskId = app.db.prepare('SELECT task_id FROM b24_tasks WHERE ticket_id = ?').get(ticketId).task_id;
    const res = await openApp(app, await portalForm(app, b24IdOf(app, 'Ответственный за договоры'), 'TASK_VIEW_TAB', { taskId }));
    assert.equal(res.headers.get('location'), `/#/t/${ticketId}`);
    // Задача не из системы — главная.
    const other = await openApp(app, await portalForm(app, b24IdOf(app, 'Ответственный за договоры'), 'TASK_VIEW_TAB', { taskId: '1' }));
    assert.equal(other.headers.get('location'), '/#/home');
  });

  it('форму с другого сайта или без ключа не принимает', async () => {
    const form = await portalForm(app, b24IdOf(app, 'Сотрудник офиса'));
    for (const origin of ['https://evil.example', null]) {
      const res = await openApp(app, form, origin);
      assert.equal(res.headers.get('location'), '/?login_error=denied');
      assert.equal(sessionOf(res), '');
    }
    const noKey = await openApp(app, new URLSearchParams({ PLACEMENT: 'LEFT_MENU' }));
    assert.equal(noKey.headers.get('location'), '/?login_error=denied');
    const badKey = await openApp(app, new URLSearchParams({ AUTH_ID: 'f'.repeat(32) }));
    assert.equal(badKey.headers.get('location'), '/?login_error=failed');
  });

  it('JSON вместо формы и форма вместо JSON отклоняются', async () => {
    const json = await fetch(`${app.base}/api/auth/b24/app`, { method: 'POST', headers: { 'content-type': 'application/json', origin: app.base }, body: '{}' });
    assert.equal(json.status, 415);
    const cookie = (await app.request(null, 'POST', '/api/session', { userId: app.userId('Сотрудник офиса') })).headers.get('set-cookie').split(';')[0];
    const form = await fetch(`${app.base}/api/tickets`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=x' });
    assert.equal(form.status, 415, 'изменения принимают только JSON — обычной формой с чужого сайта их не отправить');
  });

  it('страницу системы может показывать во фрейме только сам сервер (демо-портал)', async () => {
    const res = await fetch(`${app.base}/`);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.equal(res.headers.get('x-frame-options'), null);
    const api = await fetch(`${app.base}/api/auth/options`);
    assert.equal(api.headers.get('x-frame-options'), 'DENY', 'API во фрейме по-прежнему запрещено');
  });

  it('страница демо-портала: меню, задачи и фрейм приложения', async () => {
    const html = await (await fetch(`${app.base}/demo-portal/b24/?user=${b24IdOf(app, 'Ответственный за договоры')}`)).text();
    assert.match(html, /<button class="btn btn-primary btn-sm">Голос сотрудника<\/button>/);
    assert.match(html, /вкладка «Обращение»/);
    assert.match(html, /<iframe name="app"/);
    const chooser = await (await fetch(`${app.base}/demo-portal/b24/`)).text();
    assert.match(chooser, /Выберите, кто вошёл в портал/);
  });
});

describe('рабочая установка: система внутри портала компании', () => {
  let app;
  before(async () => {
    app = await startTestApp({
      demoMode: false, secureCookie: true,
      integrations: { b24WebhookUrl: 'http://127.0.0.1:9/rest/1/secret/', b24ClientId: 'local.abc', b24ClientSecret: 's' },
    });
  });
  after(() => app.close());

  it('во фрейме система показывается только на портале компании', async () => {
    const res = await fetch(`${app.base}/`);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors http:\/\/127\.0\.0\.1:9$/);
  });

  it('форму принимает только со страницы портала', async () => {
    const res = await openApp(app, new URLSearchParams({ AUTH_ID: 'x' }), app.base);
    assert.equal(res.headers.get('location'), '/?login_error=denied');
    const fromPortal = await openApp(app, new URLSearchParams({ AUTH_ID: 'x' }), 'http://127.0.0.1:9');
    assert.equal(fromPortal.headers.get('location'), '/?login_error=failed', 'источник верный, портал недоступен');
  });

  it('state входа по HTTPS — с префиксом __Host-', () => {
    assert.match(stateCookie('abc', true), /^__Host-b24_state=abc; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
    assert.match(stateCookie('abc', false), /^b24_state=abc; Path=\/api\/auth\/b24\/;/);
  });
});

describe('cookie и продление сессии', () => {
  it('во фрейме портала по HTTPS — SameSite=None; Partitioned, иначе Strict', () => {
    assert.match(sessionCookie('t', 60, { secure: true, embedded: true }), /SameSite=None; Secure; Partitioned/);
    assert.match(sessionCookie('t', 60, { secure: true }), /SameSite=Strict; Secure/);
    assert.match(sessionCookie('t', 60, { embedded: true }), /SameSite=Strict;/, 'без HTTPS Partitioned не ставится');
  });

  it('пока человек работает, сессия продлевается; без работы — истекает', async () => {
    const app = await startTestApp();
    try {
      const token = login(app.db, app.userId('Сотрудник офиса'), TEST_NOW);
      const cookie = `${SESSION_COOKIE}=${token}`;
      app.setNow('2026-11-11T14:00:00.000Z'); // 5 часов — меньше половины срока
      assert.equal((await app.request(cookie, 'GET', '/api/me')).headers.get('set-cookie'), null);
      app.setNow('2026-11-11T16:00:00.000Z'); // 7 часов — продление
      const renewed = await app.request(cookie, 'GET', '/api/me');
      assert.match(renewed.headers.get('set-cookie'), /Max-Age=43200/);
      app.setNow('2026-11-12T03:00:00.000Z'); // 11 часов после продления — ещё действует
      assert.equal((await app.request(cookie, 'GET', '/api/me')).status, 200);
      app.setNow('2026-11-13T05:00:00.000Z'); // больше 12 часов без работы
      assert.equal((await app.request(cookie, 'GET', '/api/me')).status, 401);
    } finally {
      await app.close();
    }
  });

  it('продление не длится дольше недели', async () => {
    const app = await startTestApp();
    try {
      const token = login(app.db, app.userId('Сотрудник офиса'), TEST_NOW);
      const cookie = `${SESSION_COOKIE}=${token}`;
      // Каждые 8 часов — запрос: сессия продлевается, пока не пройдёт 7 дней с входа.
      let at = new Date(TEST_NOW).getTime();
      for (let i = 0; i < 21; i += 1) {
        at += 8 * 3600_000;
        app.setNow(new Date(at).toISOString());
        assert.equal((await app.request(cookie, 'GET', '/api/me')).status, 200);
      }
      // Дальше продления нет: через 12 часов после последнего продления сессия закрывается.
      at += 13 * 3600_000;
      app.setNow(new Date(at).toISOString());
      assert.equal((await app.request(cookie, 'GET', '/api/me')).status, 401);
    } finally {
      await app.close();
    }
  });

  it('выход из системы во фрейме удаляет cookie с теми же атрибутами', async () => {
    const app = await startTestApp({ secureCookie: true });
    try {
      const token = login(app.db, app.userId('Сотрудник офиса'), TEST_NOW, { embedded: true });
      const res = await app.request(`${SESSION_COOKIE}=${token}`, 'DELETE', '/api/session');
      assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
      assert.match(res.headers.get('set-cookie'), /Partitioned/);
    } finally {
      await app.close();
    }
  });

  it('надпись «демонстрационные данные» — только при демо-датасете', async () => {
    const app = await startTestApp({ seed: false });
    try {
      const admin = await app.as('Администратор системы');
      assert.equal((await admin.get('/api/meta')).json.data.demoData, false);
    } finally {
      await app.close();
    }
  });
});

describe('резервные копии', () => {
  it('копирует базу и вложения, хранит последние копии', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-backup-'));
    const uploadsDir = join(dir, 'uploads');
    mkdirSync(uploadsDir);
    writeFileSync(join(uploadsDir, 'a.txt'), 'файл');
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO users (name, role, department) VALUES ('Проверка копии', 'admin', 'IT')").run();
    login(db, 1, TEST_NOW);
    const backupDir = join(dir, 'backups');
    const first = backup(db, { uploadsDir, backupDir, keep: 2, nowIso: '2026-11-10T09:00:00.000Z' });
    assert.ok(first.dir.endsWith('backup-20261110-090000'));
    const copy = new DatabaseSync(join(first.dir, 'feedback.db'));
    assert.equal(copy.prepare('SELECT name FROM users').get().name, 'Проверка копии');
    copy.close();
    assert.ok(existsSync(join(first.dir, 'uploads', 'a.txt')));
    backup(db, { uploadsDir, backupDir, keep: 2, nowIso: '2026-11-11T09:00:00.000Z' });
    const third = backup(db, { uploadsDir, backupDir, keep: 2, nowIso: '2026-11-12T09:00:00.000Z' });
    assert.equal(third.removed, 1);
    const sessionsCopy = new DatabaseSync(join(third.dir, 'feedback.db'));
    assert.equal(sessionsCopy.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'сессии в копию не попадают');
    sessionsCopy.close();
    assert.deepEqual(readdirSync(backupDir).sort(), ['backup-20261111-090000', 'backup-20261112-090000']);
  });
});
