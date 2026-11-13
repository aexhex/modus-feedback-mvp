// Исправления по итогам финального ревью: поиск без учёта регистра, атомарность настроек,
// пустой ответ 1С, объединение дубликатов, часовой пояс в выгрузке.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestApp, TEST_NOW } from './helpers.js';
import { syncCounterparties } from '../src/integrations/onec.js';
import { IntegrationError } from '../src/integrations/clients.js';
import { exportTicketsCsv } from '../src/export.js';

describe('финальное ревью', () => {
  let app;
  let admin;
  let manager;
  before(async () => {
    app = await startTestApp({ demoMode: true });
    admin = await app.as('Администратор системы');
    manager = await app.as('Директор по развитию');
  });
  after(() => app.close());

  it('поиск в реестре не зависит от регистра кириллицы, % и _ — обычные символы', async () => {
    const found = async (q) => (await manager.get(`/api/tickets?scope=all&q=${encodeURIComponent(q)}`)).json;
    const codes = async (q) => (await found(q)).data.map((t) => t.code);
    // Тема A-009 начинается с заглавной: «Неясно, кто готовит…».
    assert.deepEqual(await codes('неясно'), ['A-009']);
    assert.deepEqual(await codes('НЕЯСНО'), ['A-009']);
    assert.deepEqual(await codes('a-009'), ['A-009']);
    assert.equal((await found('%')).meta.total, 0);
    assert.equal((await found('_')).meta.total, 0);
  });

  it('часовой пояс и праздники: при ошибке ничего не сохраняется', async () => {
    const before = (await admin.get('/api/admin/timezone')).json.data.offset;
    const bad = await admin.patch('/api/admin/timezone', { offset: before === 3 ? 4 : 3, departments: { Закупки: 99 } });
    assert.equal(bad.status, 400);
    assert.equal((await admin.get('/api/admin/timezone')).json.data.offset, before, 'пояс компании не изменился');

    const holidays = (await admin.get('/api/admin/holidays')).json.data;
    const badHolidays = await admin.patch('/api/admin/holidays', { dates: ['2026-12-31'], workdays: ['2026-12-30'] });
    assert.equal(badHolidays.status, 400, '2026-12-30 — среда, не рабочий выходной');
    assert.deepEqual((await admin.get('/api/admin/holidays')).json.data, holidays, 'праздники не заменены');
  });

  it('выгрузка в Excel показывает время в часовом поясе компании', async () => {
    const createdOf = () => {
      const lines = exportTicketsCsv(app.db, { id: app.userId('Директор по развитию'), role: 'manager' }, { q: 'A-009' }, TEST_NOW)
        .trim().split('\r\n');
      return lines[1].split(';')[9].replaceAll('"', '');
    };
    await admin.patch('/api/admin/timezone', { offset: 3 });
    const moscow = createdOf();
    await admin.patch('/api/admin/timezone', { offset: 5 });
    const almaty = createdOf();
    const hour = (s) => Number(s.split(' ')[1].split(':')[0]);
    assert.equal((hour(almaty) - hour(moscow) + 24) % 24, 2, `${moscow} → ${almaty}`);
  });

  it('пустой справочник из 1С не отключает клиентов', async () => {
    await admin.post('/api/admin/integrations/1c/counterparties');
    const active = () => app.db.prepare('SELECT COUNT(*) AS n FROM counterparties WHERE is_active = 1').get().n;
    const before = active();
    assert.ok(before > 0);
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: [] }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const onec = { url: `http://127.0.0.1:${server.address().port}/odata/standard.odata/` };
      await assert.rejects(syncCounterparties(app.db, onec, TEST_NOW), IntegrationError);
      assert.equal(active(), before);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('объединить можно только с исходным обращением, голоса за дубликат возвращаются', async () => {
    const author = await app.as('Сотрудник офиса');
    const idea = async (title) => (await author.post('/api/tickets', {
      type: 'idea', categoryId: app.db.prepare("SELECT id FROM categories WHERE name = 'Обучение'").get().id,
      title, description: `${title}: подробное описание идеи для проверки.`, isPublic: true,
    })).json.data;
    const a = await idea('Первая идея для объединения');
    const b = await idea('Вторая идея для объединения');
    const voter = await app.as('Сотрудник закупок');
    assert.equal((await voter.post(`/api/tickets/${a.id}/vote`, { count: 1 })).status, 200);

    assert.equal((await manager.post(`/api/tickets/${a.id}/duplicate`, { code: b.code })).status, 200);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM idea_votes WHERE ticket_id = ?').get(a.id).n, 0, 'голос вернулся');
    const cycle = await manager.post(`/api/tickets/${b.id}/duplicate`, { code: a.code });
    assert.equal(cycle.status, 400);
    assert.match(cycle.json.error, new RegExp(`${a.code} само объединено с ${b.code}`));
  });
});
