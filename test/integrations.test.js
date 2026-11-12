import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db.js';
import { startTestApp } from './helpers.js';
import { readIntegrationConfig, describeConfig } from '../src/integrations/config.js';
import { b24List, IntegrationError } from '../src/integrations/clients.js';
import { MAX_ATTEMPTS } from '../src/integrations/delivery.js';

const categoryId = (app, name) => app.db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;
const outboxRow = (app, where, ...params) => app.db.prepare(`SELECT * FROM outbox WHERE ${where} ORDER BY id DESC LIMIT 1`).get(...params);
const CLOSED_PORT = 'http://127.0.0.1:9/'; // порт discard — соединение отклоняется

const newTicket = (app, extra = {}) => ({
  type: 'problem', categoryId: categoryId(app, 'Регламенты'),
  title: 'Регламент согласования счетов устарел', description: 'В регламенте описан старый порядок согласования счетов.', ...extra,
});

describe('настройки подключения', () => {
  it('выбирает режим по переменным окружения и демо-режиму', () => {
    assert.equal(readIntegrationConfig({ env: {} }).b24.mode, 'off');
    assert.equal(readIntegrationConfig({ env: {} }).exportToken, null);
    const demo = readIntegrationConfig({ env: {}, demoMode: true });
    assert.equal(demo.b24.mode, 'demo');
    assert.equal(demo.onec.mode, 'demo');
    assert.match(demo.exportToken, /^demo-[0-9a-f]{24}$/);
    const live = readIntegrationConfig({
      env: { B24_WEBHOOK_URL: 'https://modus.bitrix24.kz/rest/7/secret', ONEC_ODATA_URL: 'http://1c.local/ut/odata/standard.odata', ONEC_EXPORT_TOKEN: 't0ken' },
      demoMode: true,
    });
    assert.equal(live.b24.webhookUrl, 'https://modus.bitrix24.kz/rest/7/secret/');
    assert.equal(live.onec.mode, 'live');
    // В интерфейс уходит только хост: секрет из адреса вебхука и сам токен не показываются.
    const shown = JSON.stringify(describeConfig(live));
    assert.ok(shown.includes('modus.bitrix24.kz') && !shown.includes('secret') && !shown.includes('t0ken'));
    assert.throws(() => readIntegrationConfig({ env: { B24_WEBHOOK_URL: 'ftp://x' } }), /http\(s\)/);
    assert.throws(() => readIntegrationConfig({ env: { ONEC_ODATA_URL: 'не адрес' } }), /неверный адрес/);
  });

  it('читает списки Битрикс24 постранично и сообщает об ошибках портала', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const { start = 0 } = JSON.parse(body || '{}');
        res.setHeader('content-type', 'application/json');
        if (req.url.endsWith('/broken.json')) return res.end(JSON.stringify({ error: 'ACCESS_DENIED', error_description: 'Нет прав' }));
        if (req.url.endsWith('/html.json')) return res.end('<html>');
        const all = Array.from({ length: 120 }, (_, i) => ({ ID: i + 1 }));
        return res.end(JSON.stringify({ result: all.slice(start, start + 50), ...(start + 50 < 120 ? { next: start + 50 } : {}) }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/rest/1/x/`;
    try {
      assert.equal((await b24List(base, 'user.get')).length, 120);
      await assert.rejects(b24List(base, 'broken'), /Нет прав/);
      await assert.rejects(b24List(base, 'html'), /не в формате JSON/);
      await assert.rejects(b24List(CLOSED_PORT, 'user.get'), (e) => e instanceof IntegrationError && /недоступен/.test(e.message));
    } finally {
      server.close();
    }
  });
});

describe('миграция базы', () => {
  it('записи журнала из прежней версии не отправляются на портал задним числом', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fb-migrate-')), 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE outbox (id INTEGER PRIMARY KEY, channel TEXT NOT NULL, method TEXT NOT NULL,
      recipient TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)`);
    old.prepare("INSERT INTO outbox (channel, method, recipient, payload, created_at) VALUES ('bitrix24', 'im.notify', 'x', '{}', '2026-01-01')").run();
    old.close();
    const db = openDatabase(path);
    assert.equal(db.prepare('SELECT status FROM outbox').get().status, 'simulated');
    db.prepare("INSERT INTO outbox (channel, method, recipient, payload, created_at) VALUES ('bitrix24', 'im.notify', 'y', '{}', '2026-01-02')").run();
    assert.equal(db.prepare('SELECT status FROM outbox WHERE recipient = ?').get('y').status, 'pending');
    db.close();
  });
});

describe('без подключения — имитация', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('журнал помечает вызовы как имитацию, управление интеграциями недоступно', async () => {
    const emp = await app.as('Сотрудник офиса');
    await emp.post('/api/tickets', newTicket(app));
    const admin = await app.as('Администратор системы');
    const info = (await admin.get('/api/admin/integrations')).json.data;
    assert.equal(info.b24.mode, 'off');
    assert.equal(info.export.enabled, false);
    assert.ok((await admin.get('/api/admin/outbox')).json.data.every((o) => o.status === 'simulated'));
    assert.equal((await admin.post('/api/admin/integrations/b24/org-preview')).status, 400);
    assert.equal((await admin.post('/api/admin/integrations/1c/counterparties')).status, 400);
    assert.equal((await app.request(null, 'GET', '/api/integrations/1c/tickets')).status, 404);
    assert.equal((await emp.get('/api/admin/integrations')).status, 403);
  });
});

describe('Битрикс24 через демо-портал', () => {
  let app;
  before(async () => { app = await startTestApp({ demoMode: true }); });
  after(() => app.close());

  it('до загрузки оргструктуры уведомление не отправляется: сотрудник не сопоставлен', async () => {
    const emp = await app.as('Сотрудник офиса');
    await emp.post('/api/tickets', newTicket(app));
    await app.delivery.idle();
    const row = outboxRow(app, "method = 'im.notify'");
    assert.equal(row.status, 'skipped');
    assert.match(row.error, /не сопоставлен/);
    // История демо-данных не отправляется повторно.
    assert.ok(app.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'simulated'").get().n > 0);
  });

  it('предпросмотр показывает изменения и ничего не меняет', async () => {
    const admin = await app.as('Администратор системы');
    const p = (await admin.post('/api/admin/integrations/b24/org-preview')).json.data;
    assert.equal(p.portalUsers, 27);
    assert.equal(p.linked.length, 23);
    assert.deepEqual(p.notLinked, ['Администратор системы'], 'администратор по ФИО не связывается — только ADMIN_B24_ID');
    assert.deepEqual(p.created.map((u) => u.name).sort(), ['Инженер сервиса', 'Руководитель сервиса', 'Специалист по закупкам']);
    assert.equal(p.created.find((u) => u.name === 'Руководитель сервиса').role, 'handler', 'руководитель отдела получает роль ответственного');
    assert.deepEqual(p.moved, [{ name: 'Координатор проекта', from: 'Проектный офис', to: 'Проектирование' }]);
    assert.deepEqual(p.dismissed, ['Руководитель проекта']);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM users WHERE b24_id IS NOT NULL').get().n, 0);
  });

  it('применение связывает, добавляет, переводит и отключает; повтор ничего не меняет', async () => {
    const admin = await app.as('Администратор системы');
    const r = (await admin.post('/api/admin/integrations/b24/org-apply')).json.data;
    assert.deepEqual(r, { linked: 23, created: 3, moved: 1, dismissed: 1, warnings: [] });
    const user = (name) => app.db.prepare('SELECT * FROM users WHERE name = ?').get(name);
    assert.equal(user('Координатор проекта').department, 'Проектирование');
    assert.equal(user('Руководитель проекта').is_active, 0);
    assert.equal(user('Инженер сервиса').department, 'Сервис');
    assert.ok(user('Сотрудник офиса').b24_id > 100);
    assert.ok((await admin.get('/api/admin/audit')).json.data.some((a) => a.action === 'Оргструктура загружена из Битрикс24'));
    const again = (await admin.post('/api/admin/integrations/b24/org-preview')).json.data;
    assert.deepEqual([again.linked, again.created, again.moved, again.dismissed].map((x) => x.length), [0, 0, 0, 0]);
  });

  it('после загрузки оргструктуры неотправленное уведомление уходит повторно', async () => {
    await app.delivery.idle();
    const row = app.db.prepare("SELECT status FROM outbox WHERE error IS NULL AND status = 'sent' AND method = 'im.notify'").get();
    assert.ok(row, 'ранее пропущенная запись отправлена после связывания');
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'skipped'").get().n, 0);
  });

  it('уведомление уходит на портал с ID сотрудника в Битрикс24 и ссылкой', async () => {
    const emp = await app.as('Сотрудник офиса');
    const ticket = (await emp.post('/api/tickets', newTicket(app))).json.data;
    await app.delivery.idle();
    const row = outboxRow(app, "method = 'im.notify' AND ticket_id = ?", ticket.id);
    assert.equal(row.status, 'sent');
    assert.ok(row.external_id);
    const call = app.demoPortal.calls.findLast((c) => c.method === 'im.notify');
    const assignee = app.db.prepare('SELECT b24_id FROM users WHERE id = ?').get(ticket.assignee.id);
    assert.equal(call.params.USER_ID, assignee.b24_id);
    assert.match(call.params.MESSAGE, new RegExp(`/#/t/${ticket.id}$`));
  });

  it('задача создаётся на портале, её номер появляется в карточке', async () => {
    const id = app.ticketId('A-009');
    const handler = await app.as('Ответственный за договоры');
    const created = (await handler.post(`/api/tickets/${id}/b24-task`)).json.data;
    // Ответ ждёт портал: номер задачи и статус видны сразу, без обновления страницы.
    assert.match(created.b24Task.text, /^Задача в Битрикс24 №24\d\d создана$/);
    assert.equal(created.b24Task.task.statusLabel, 'Ждёт выполнения');
    await app.delivery.idle();
    const detail = (await handler.get(`/api/tickets/${id}`)).json.data;
    assert.match(detail.b24Task.text, /^Задача в Битрикс24 №24\d\d создана$/);
    assert.equal(detail.permissions.canCreateTask, false);
    const call = app.demoPortal.calls.findLast((c) => c.method === 'tasks.task.add');
    assert.equal(call.params.fields.TITLE, '[A-009] Неясно, кто готовит и проверяет приложение к договору');
    assert.ok(call.params.fields.RESPONSIBLE_ID);
  });

  it('ошибка портала: запись остаётся в очереди, затем помечается ошибкой и отправляется повторно вручную', async () => {
    // Сотрудник связан с ID, которого на портале нет среди действующих: Битрикс24 отвечает ошибкой.
    const dismissedId = app.db.prepare("SELECT b24_id FROM users WHERE name = 'Руководитель проекта'").get().b24_id;
    app.db.prepare("UPDATE users SET b24_id = NULL WHERE name = 'Руководитель проекта'").run();
    app.db.prepare("UPDATE users SET b24_id = ? WHERE name = 'Сотрудник закупок'").run(dismissedId);
    const author = app.userId('Сотрудник закупок');
    const handler = await app.as('Руководитель закупок');
    await handler.post(`/api/tickets/${app.ticketId('A-001')}/status`, { status: 'in_review', comment: 'Смотрим' });
    await app.delivery.idle();
    let row = outboxRow(app, 'user_id = ?', author);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.match(row.error, /уведомление не создано/);

    app.db.prepare('UPDATE outbox SET attempts = ?, next_at = NULL WHERE id = ?').run(MAX_ATTEMPTS - 1, row.id);
    await app.delivery.kick();
    row = outboxRow(app, 'id = ?', row.id);
    assert.equal(row.status, 'failed');

    const admin = await app.as('Администратор системы');
    assert.equal((await admin.get('/api/admin/outbox')).json.data.find((o) => o.id === row.id).status, 'failed');
    assert.equal((await admin.post(`/api/admin/outbox/${row.id}/retry`)).status, 200);
    assert.equal((await admin.post('/api/admin/outbox/999999/retry')).status, 404);
    await app.delivery.idle();
    assert.equal(outboxRow(app, 'id = ?', row.id).attempts, 1, 'после ручного повтора счётчик попыток начинается заново');
    const info = (await admin.get('/api/admin/integrations')).json.data;
    assert.ok(info.outbox.sent > 0);
    assert.equal(info.b24.mode, 'demo');
  });
});

describe('защита от сбоев', () => {
  it('запись, прерванная перезапуском, возвращается в очередь', async () => {
    const app = await startTestApp({ demoMode: true });
    try {
      app.db.prepare("UPDATE outbox SET status = 'sending' WHERE id = (SELECT MIN(id) FROM outbox)").run();
      const { createDelivery } = await import('../src/integrations/delivery.js');
      createDelivery({ db: app.db, mode: () => 'off', endpoints: () => ({}), now: () => '' });
      assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'sending'").get().n, 0);
    } finally {
      await app.close();
    }
  });

  it('портал вернул почти пустой список — уволенные не отключаются массово', async () => {
    const people = [{ ID: '7', NAME: 'Сотрудник офиса', LAST_NAME: '', ACTIVE: true, UF_DEPARTMENT: [1] }];
    const portal = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('department.get.json')) return res.end(JSON.stringify({ result: [{ ID: '1', NAME: 'Административный отдел', UF_HEAD: '' }] }));
      return res.end(JSON.stringify({ result: people }));
    });
    await new Promise((r) => portal.listen(0, '127.0.0.1', r));
    const app = await startTestApp({ integrations: { b24WebhookUrl: `http://127.0.0.1:${portal.address().port}/rest/1/x/` } });
    try {
      // Все сотрудники уже связаны с порталом; на портале остался один — остальные выглядят уволенными.
      app.db.exec('UPDATE users SET b24_id = 1000 + id');
      app.db.prepare("UPDATE users SET b24_id = 7 WHERE name = 'Сотрудник офиса'").run();
      const admin = await app.as('Администратор системы');
      const preview = (await admin.post('/api/admin/integrations/b24/org-preview')).json.data;
      assert.equal(preview.dismissBlocked, true);
      const r = (await admin.post('/api/admin/integrations/b24/org-apply')).json.data;
      assert.equal(r.dismissed, 0);
      assert.match(r.warnings[0], /подозрительно мало/);
      assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_active = 0').get().n, 0);
    } finally {
      await app.close();
      portal.close();
    }
  });
});

describe('задачи и сброс данных', () => {
  it('задача без сопоставленного ответственного ждёт оргструктуры, затем создаётся', async () => {
    const app = await startTestApp({ demoMode: true });
    try {
      const id = app.ticketId('A-009');
      const handler = await app.as('Ответственный за договоры');
      await handler.post(`/api/tickets/${id}/b24-task`);
      await app.delivery.idle();
      const row = outboxRow(app, "method = 'tasks.task.add'");
      assert.equal(row.status, 'skipped');
      const admin = await app.as('Администратор системы');
      await admin.post('/api/admin/integrations/b24/org-apply');
      await app.delivery.idle();
      assert.equal(outboxRow(app, 'id = ?', row.id).status, 'sent');
      assert.match((await handler.get(`/api/tickets/${id}`)).json.data.b24Task.text, /№24\d\d создана/);
    } finally {
      await app.close();
    }
  });

  it('ответ на отправку, начатую до сброса данных, не попадает в новый датасет', async () => {
    const app = await startTestApp({ demoMode: true });
    try {
      const admin = await app.as('Администратор системы');
      await admin.post('/api/admin/integrations/b24/org-apply');
      await app.delivery.idle();
      const handler = await app.as('Ответственный за договоры');
      const id = app.ticketId('A-009');
      app.db.prepare("INSERT INTO outbox (channel, method, recipient, payload, user_id, ticket_id, created_at) VALUES ('bitrix24', 'tasks.task.add', 'x', ?, ?, ?, '2026-11-11')")
        .run(JSON.stringify({ TITLE: 't', MESSAGE: 'm' }), app.userId('Ответственный за договоры'), id);
      const sending = app.delivery.kick();
      app.delivery.invalidate();
      await sending;
      assert.ok(!(await handler.get(`/api/tickets/${id}`)).json.data.b24Task, 'событие задачи не записано после сброса');
    } finally {
      await app.close();
    }
  });
});

describe('статусы задач Битрикс24', () => {
  let app;
  before(async () => {
    app = await startTestApp({ demoMode: true });
    const admin = await app.as('Администратор системы');
    await admin.post('/api/admin/integrations/b24/org-apply');
    await app.delivery.idle();
  });
  after(() => app.close());

  it('завершение задачи на портале попадает в карточку и уведомляет ответственного', async () => {
    const id = app.ticketId('A-009');
    const handler = await app.as('Ответственный за договоры');
    await handler.post(`/api/tickets/${id}/b24-task`);
    await app.delivery.idle();
    let detail = (await handler.get(`/api/tickets/${id}`)).json.data;
    assert.equal(detail.b24Task.task.statusLabel, 'Ждёт выполнения');

    const admin = await app.as('Администратор системы');
    assert.deepEqual((await admin.post('/api/admin/integrations/b24/tasks-check')).json.data, { checked: 1, changed: 0, errors: 0 });

    detail = (await handler.post(`/api/tickets/${id}/b24-task/demo-complete`)).json.data;
    assert.equal(detail.b24Task.task.statusLabel, 'Завершена');
    assert.match(detail.b24Task.text, /завершена — подтвердите результат и зафиксируйте итог/);
    const note = (await handler.get('/api/notifications')).json.data.items[0];
    assert.match(note.text, /Задача в Битрикс24 по A-009 выполнена/);
    // Повторная проверка ничего не дублирует.
    assert.equal((await admin.post('/api/admin/integrations/b24/tasks-check')).json.data.changed, 0);
  });

  it('удалённая на портале задача помечается ошибкой, остальные проверяются', async () => {
    const id = app.ticketId('A-003');
    app.db.prepare("INSERT INTO b24_tasks (ticket_id, task_id, status, created_at) VALUES (?, '999999', '2', '2026-11-11')").run(id);
    const admin = await app.as('Администратор системы');
    const r = (await admin.post('/api/admin/integrations/b24/tasks-check')).json.data;
    assert.equal(r.errors, 1);
    const row = app.db.prepare('SELECT error FROM b24_tasks WHERE ticket_id = ?').get(id);
    assert.match(row.error, /Задача не найдена/);
  });

  it('завершение на демо-портале недоступно без демо-портала и без прав', async () => {
    const emp = await app.as('Менеджер по продажам');
    assert.equal((await emp.post(`/api/tickets/${app.ticketId('A-009')}/b24-task/demo-complete`)).status, 403);
    const handler = await app.as('Ответственный за договоры');
    const noTask = app.db.prepare("SELECT t.id FROM tickets t WHERE t.assignee_id = ? AND NOT EXISTS (SELECT 1 FROM b24_tasks b WHERE b.ticket_id = t.id)")
      .get(app.userId('Ответственный за договоры'));
    if (noTask) assert.equal((await handler.post(`/api/tickets/${noTask.id}/b24-task/demo-complete`)).status, 400);
    const off = await startTestApp();
    try {
      const h = await off.as('Ответственный за договоры');
      assert.equal((await h.post(`/api/tickets/${off.ticketId('A-009')}/b24-task/demo-complete`)).status, 403);
      const admin = await off.as('Администратор системы');
      assert.equal((await admin.post('/api/admin/integrations/b24/tasks-check')).status, 400);
    } finally {
      await off.close();
    }
  });
});

describe('1С УТ через демо-портал', () => {
  let app;
  let token;
  before(async () => {
    app = await startTestApp({ demoMode: true });
    const admin = await app.as('Администратор системы');
    token = (await admin.get('/api/admin/integrations')).json.data.export.demoToken;
  });
  after(() => app.close());

  it('загружает контрагентов; помеченные на удаление не предлагаются', async () => {
    const emp = await app.as('Сотрудник офиса');
    assert.equal((await emp.get('/api/meta')).json.data.hasCounterparties, false);
    const manager = await app.as('Директор по развитию');
    assert.equal((await manager.get('/api/analytics')).json.data.clients, null, 'без справочника карточки клиентов нет');
    const admin = await app.as('Администратор системы');
    const r = (await admin.post('/api/admin/integrations/1c/counterparties')).json.data;
    assert.deepEqual(r, { total: 7, added: 8, updated: 0, deactivated: 0 });
    const again = (await admin.post('/api/admin/integrations/1c/counterparties')).json.data;
    assert.deepEqual(again, { total: 7, added: 0, updated: 8, deactivated: 0 });
    const list = (await emp.get('/api/counterparties')).json.data;
    assert.equal(list.length, 7);
    assert.ok(!list.some((c) => /удаление/.test(c.name)));
    assert.equal((await emp.get('/api/meta')).json.data.hasCounterparties, true);
  });

  it('обращение связывается с клиентом; удалённый или несуществующий клиент отклоняется', async () => {
    const emp = await app.as('Сотрудник офиса');
    const client = (await emp.get('/api/counterparties')).json.data[0];
    const created = (await emp.post('/api/tickets', newTicket(app, { counterpartyId: client.id }))).json.data;
    assert.deepEqual(created.counterparty, { id: client.id, name: client.name, inn: client.inn });
    const removed = app.db.prepare('SELECT id FROM counterparties WHERE is_active = 0').get().id;
    assert.equal((await emp.post('/api/tickets', newTicket(app, { counterpartyId: removed }))).status, 400);
    assert.equal((await emp.post('/api/tickets', newTicket(app, { counterpartyId: 99999 }))).status, 400);

    // Аналитика по клиентам и фильтр реестра по клиенту.
    const manager = await app.as('Директор по развитию');
    const { clients } = (await manager.get('/api/analytics')).json.data;
    assert.equal(clients.linked, 1);
    assert.deepEqual(clients.items.map((c) => [c.name, c.total, c.open, c.problems, c.topCategory]), [[client.name, 1, 1, 1, 'Регламенты']]);
    const listed = (await manager.get(`/api/tickets?scope=all&counterparty=${client.id}`)).json.data;
    assert.deepEqual(listed.map((t) => t.id), [created.id]);
  });

  it('выгрузка для 1С: только по токену, без текста и авторов, анонимность сохраняется', async () => {
    const pull = (headers, query = '') => fetch(`${app.base}/api/integrations/1c/tickets${query}`, { headers });
    assert.equal((await pull({})).status, 403);
    assert.equal((await pull({ authorization: 'Bearer wrong' })).status, 403);

    const emp = await app.as('Сотрудник офиса');
    const anon = (await emp.post('/api/tickets', newTicket(app, { isAnonymous: true }))).json.data;
    const { data } = await (await pull({ authorization: `Bearer ${token}` })).json();
    assert.ok(data.length > 20);
    const row = data.find((t) => t.code === anon.code);
    assert.equal(row.department, null);
    for (const key of ['title', 'description', 'author', 'authorId']) assert.ok(!(key in row), `нет поля ${key}`);
    assert.ok(data.some((t) => t.counterparty?.inn));

    const since = (await (await pull({ authorization: `Bearer ${token}` }, `?since=${encodeURIComponent(anon.createdAt)}`)).json()).data;
    assert.ok(since.length >= 1 && since.length < data.length);
    assert.ok(since.every((t) => t.changedAt >= anon.createdAt));

    // «У меня тоже» не меняет updated_at, но выгрузка с since должна увидеть новое число поддержавших.
    const later = '2026-11-12T10:00:00.000Z';
    app.setNow(later);
    const other = await app.as('Менеджер по продажам');
    const managerId = app.userId('Менеджер по продажам');
    const { code: oldCode } = app.db.prepare(`SELECT code FROM tickets t WHERE type = 'problem' AND status IN ('new','in_review','in_progress')
      AND author_id != ? AND NOT EXISTS (SELECT 1 FROM supports s WHERE s.ticket_id = t.id AND s.user_id = ?) AND id != ? ORDER BY id LIMIT 1`)
      .get(managerId, managerId, anon.id);
    const oldTicket = data.find((t) => t.code === oldCode);
    const oldId = app.ticketId(oldCode);
    const sup = await other.post(`/api/tickets/${oldId}/support`);
    assert.equal(sup.status, 200, JSON.stringify(sup.json) + oldTicket.code);
    // Объединение дубликата: запись остаётся в выгрузке с duplicateOf, чтобы 1С исключила её.
    const handler = await app.as('Ответственный за процессы');
    assert.equal((await handler.post(`/api/tickets/${anon.id}/duplicate`, { code: oldTicket.code })).status, 200);
    const fresh = (await (await pull({ authorization: `Bearer ${token}` }, `?since=${encodeURIComponent(later)}`)).json()).data;
    assert.equal(fresh.find((t) => t.code === oldTicket.code).supporters, oldTicket.supporters + 2);
    assert.equal(fresh.find((t) => t.code === anon.code).duplicateOf, oldTicket.code);
  });

  it('недоступные портал и база 1С — понятная ошибка 502', async () => {
    const broken = await startTestApp({ integrations: { onecODataUrl: CLOSED_PORT, b24WebhookUrl: CLOSED_PORT } });
    try {
      const admin = await broken.as('Администратор системы');
      const r = await admin.post('/api/admin/integrations/1c/counterparties');
      assert.equal(r.status, 502);
      assert.match(r.json.error, /недоступен/);
      assert.equal((await admin.post('/api/admin/integrations/b24/org-preview')).status, 502);
      assert.equal((await admin.get('/api/admin/integrations')).json.data.b24.mode, 'live');
    } finally {
      await broken.close();
    }
  });
});

describe('ежедневная синхронизация', () => {
  it('загружает контрагентов и сообщает администратору об изменениях оргструктуры один раз', async () => {
    const app = await startTestApp({ demoMode: true });
    try {
      const { runDailySync } = await import('../src/integrations/daily.js');
      const { readIntegrationConfig, resolveEndpoints } = await import('../src/integrations/config.js');
      const config = readIntegrationConfig({ env: {}, demoMode: true });
      const endpoints = () => resolveEndpoints(config, app.base);
      const run = () => runDailySync({ db: app.db, config, endpoints, now: () => '2026-11-12T03:00:00.000Z', logger: { error: () => {} } });

      const first = await run();
      assert.equal(first.counterparties.total, 7);
      assert.match(first.org, /новых: 3/);
      assert.match(first.org, /уволено: 1/);
      const admin = await app.as('Администратор системы');
      const note = (await admin.get('/api/notifications')).json.data.items[0];
      assert.match(note.text, /В Битрикс24 изменилась оргструктура/);
      // Ничего не применено без администратора.
      assert.equal(app.db.prepare("SELECT is_active FROM users WHERE name = 'Руководитель проекта'").get().is_active, 1);

      const second = await run();
      assert.equal(second.org, null, 'о тех же изменениях повторно не сообщаем');
      await admin.post('/api/admin/integrations/b24/org-apply');
      assert.equal((await run()).org, null, 'после применения изменений нет');
      assert.ok((await admin.get('/api/admin/audit')).json.data.some((a) => /по расписанию/.test(a.details ?? '')));
    } finally {
      await app.close();
    }
  });
});
