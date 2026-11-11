import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, TEST_NOW } from './helpers.js';
import { addBusinessHours, addHours } from '../src/config.js';
import { escalateOverdue } from '../src/escalation.js';

const categoryId = (app, name) => app.db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;

describe('рабочие дни в SLA', () => {
  it('срок из пятницы переносится на понедельник', () => {
    // Пятница 13.11.2026 15:00 МСК + 1 рабочий день = понедельник 16.11 15:00 МСК
    assert.equal(addBusinessHours('2026-11-13T12:00:00.000Z', 24), '2026-11-16T12:00:00.000Z');
  });
  it('обращение, поданное в выходной, отсчитывается с понедельника', () => {
    // Суббота 14.11 10:00 МСК + 1 рабочий день = вторник 17.11 00:00 МСК
    assert.equal(addBusinessHours('2026-11-14T07:00:00.000Z', 24), '2026-11-16T21:00:00.000Z');
  });
  it('три рабочих дня со среды заканчиваются в понедельник', () => {
    assert.equal(addBusinessHours('2026-11-11T09:00:00.000Z', 72), '2026-11-16T09:00:00.000Z');
  });
  it('внутри рабочей недели совпадает с календарным расчётом', () => {
    assert.equal(addBusinessHours('2026-11-09T09:00:00.000Z', 24), addHours('2026-11-09T09:00:00.000Z', 24));
  });
});

describe('эскалация просрочек', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('при старте руководитель и ответственный уведомлены, в истории есть запись', async () => {
    const manager = await app.as('Директор по развитию');
    const notes = (await manager.get('/api/notifications')).json.data.items.map((n) => n.text);
    for (const code of ['A-003', 'A-007', 'A-011', 'A-014']) {
      assert.ok(notes.some((t) => t.startsWith(`Просрочка ${code}`)), code);
    }
    const handler = await app.as('IT-специалист');
    const own = (await handler.get('/api/notifications')).json.data.items.map((n) => n.text);
    assert.ok(own.some((t) => t.startsWith('Просрочка A-007')));
    const ticket = (await manager.get(`/api/tickets/${app.ticketId('A-007')}`)).json.data;
    assert.ok(ticket.events.some((e) => e.kind === 'escalation' && /первого ответа/.test(e.body)));
  });

  it('срок решения эскалируется отдельно, даже если первый ответ так и не дан', async () => {
    const id = app.ticketId('A-007');
    const kinds = () => app.db.prepare('SELECT kind FROM escalations WHERE ticket_id = ? ORDER BY kind').all(id).map((r) => r.kind);
    assert.deepEqual(kinds(), ['first_response']);
    escalateOverdue(app.db, addHours(TEST_NOW, 24 * 20));
    assert.deepEqual(kinds(), ['first_response', 'resolve']);
  });

  it('повторный запуск не дублирует эскалации, новые просрочки добавляются', () => {
    assert.equal(escalateOverdue(app.db, TEST_NOW), 0);
    const later = addHours(TEST_NOW, 24 * 60);
    assert.ok(escalateOverdue(app.db, later) > 0);
    assert.equal(escalateOverdue(app.db, later), 0);
  });
});

describe('экспорт в CSV', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('руководитель выгружает весь реестр с BOM и заголовком', async () => {
    const manager = await app.as('Директор по развитию');
    const res = await manager.raw('/api/tickets/export');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const lines = bytes.toString('utf8').trim().split('\r\n');
    assert.equal(lines.length, 21);
    assert.match(lines[0], /"Номер";"Тип";"Категория"/);
  });

  it('учитывает права и фильтры', async () => {
    const emp = await app.as('Сотрудник офиса');
    const own = (await (await emp.raw('/api/tickets/export')).text()).trim().split('\r\n');
    assert.equal(own.length, 3);
    const manager = await app.as('Директор по развитию');
    const overdue = (await (await manager.raw('/api/tickets/export?overdue=1')).text()).trim().split('\r\n');
    assert.equal(overdue.length, 5);
  });

  it('значения, похожие на формулы, экранируются', async () => {
    const emp = await app.as('Сотрудник офиса');
    await emp.post('/api/tickets', {
      type: 'idea', categoryId: categoryId(app, 'Обучение'), title: '=SUM(A1:A9)', description: 'Проверка защиты от формул в экспорте.',
    });
    const csv = await (await emp.raw('/api/tickets/export')).text();
    assert.ok(csv.includes(`"'=SUM(A1:A9)"`));
  });
});

describe('постраничный вывод', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('возвращает страницу и метаданные', async () => {
    const manager = await app.as('Директор по развитию');
    const p1 = (await manager.get('/api/tickets?limit=8&page=1')).json;
    const p3 = (await manager.get('/api/tickets?limit=8&page=3')).json;
    assert.equal(p1.data.length, 8);
    assert.deepEqual(p1.meta, { total: 20, page: 1, limit: 8 });
    assert.equal(p3.data.length, 4);
    const codes = new Set([...p1.data, ...p3.data].map((t) => t.code));
    assert.equal(codes.size, 12);
  });

  it('некорректные параметры приводятся к допустимым', async () => {
    const manager = await app.as('Директор по развитию');
    const r = (await manager.get('/api/tickets?limit=100000&page=-5')).json;
    assert.deepEqual(r.meta, { total: 20, page: 1, limit: 100 });
    const far = (await manager.get('/api/tickets?page=99')).json;
    assert.equal(far.data.length, 0);
  });
});

describe('оценка результата автором', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('автор оценивает реализованное обращение один раз', async () => {
    const id = app.ticketId('A-004');
    const author = await app.as('Сотрудник закупок');
    assert.equal((await author.get(`/api/tickets/${id}`)).json.data.permissions.canRate, true);
    const r = await author.post(`/api/tickets/${id}/feedback`, { isResolved: false, comment: 'Семинар так и не провели' });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.feedback.isResolved, false);
    assert.equal(r.json.data.permissions.canRate, false);
    assert.equal((await author.post(`/api/tickets/${id}/feedback`, { isResolved: true })).status, 400);
    const handler = await app.as('Ответственный за обучение');
    const notes = (await handler.get('/api/notifications')).json.data.items;
    assert.ok(notes.some((n) => /НЕ решён/.test(n.text)));
  });

  it('нельзя оценить чужое или нерассмотренное обращение', async () => {
    const manager = await app.as('Директор по развитию');
    assert.equal((await manager.post(`/api/tickets/${app.ticketId('A-008')}/feedback`, { isResolved: true })).status, 403);
    const author = await app.as('Сотрудник закупок');
    assert.equal((await author.post(`/api/tickets/${app.ticketId('A-001')}/feedback`, { isResolved: true })).status, 400);
  });

  it('аналитика показывает долю подтверждённых итогов', async () => {
    const author = await app.as('Сотрудник бухгалтерии');
    await author.post(`/api/tickets/${app.ticketId('A-008')}/feedback`, { isResolved: true });
    const manager = await app.as('Директор по развитию');
    const { kpi } = (await manager.get('/api/analytics')).json.data;
    assert.equal(kpi.feedbackCount, 2);
    assert.equal(kpi.confirmedShare, 50);
  });
});

describe('сессии, имитация Битрикс24, анонимность', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('журнал имитации Битрикс24 виден только администратору', async () => {
    const admin = await app.as('Администратор системы');
    const items = (await admin.get('/api/admin/outbox')).json.data;
    assert.ok(items.length > 0);
    assert.equal(items[0].channel, 'bitrix24');
    assert.equal(items[0].method, 'im.notify');
    assert.ok(items[0].payload.MESSAGE);
    const emp = await app.as('Сотрудник офиса');
    assert.equal((await emp.get('/api/admin/outbox')).status, 403);
  });

  it('анонимное обращение не раскрывается фильтром по подразделению', async () => {
    const emp = await app.as('Сотрудник офиса');
    const created = (await emp.post('/api/tickets', {
      type: 'problem', categoryId: categoryId(app, 'Регламенты'), title: 'Анонимная тема', description: 'Текст анонимного обращения для проверки.', isAnonymous: true,
    })).json.data;
    assert.equal(created.department, 'Административный отдел');
    const manager = await app.as('Директор по развитию');
    const dept = (await manager.get(`/api/tickets?department=${encodeURIComponent('Административный отдел')}`)).json.data;
    assert.ok(!dept.some((t) => t.id === created.id));
    const seen = (await manager.get(`/api/tickets/${created.id}`)).json.data;
    assert.equal(seen.department, null);
    assert.equal(seen.author, null);

    const handler = await app.as('Ответственный за процессы');
    await handler.post(`/api/tickets/${created.id}/status`, { status: 'in_review', comment: 'Принято' });
    const admin = await app.as('Администратор системы');
    const entries = (await admin.get('/api/admin/outbox')).json.data.filter((o) => o.payload.LINK === `/#/t/${created.id}`);
    assert.ok(entries.length > 0);
    assert.ok(entries.every((o) => o.recipient === 'Получатель скрыт (анонимное обращение)'));
    assert.ok(!entries.some((o) => o.recipient === 'Сотрудник офиса'));
  });

  it('сессия истекает на сервере через 12 часов', async () => {
    const emp = await app.as('Сотрудник офиса');
    assert.equal((await emp.get('/api/me')).status, 200);
    app.setNow(addHours(TEST_NOW, 13));
    assert.equal((await emp.get('/api/me')).status, 401);
    app.setNow(TEST_NOW);
  });
});
