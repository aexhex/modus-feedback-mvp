import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, TEST_NOW } from './helpers.js';
import { addBusinessHours, addHours } from '../src/config.js';
import { escalateOverdue } from '../src/escalation.js';
import { exportTicketsCsv } from '../src/export.js';

const categoryId = (app, name) => app.db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;
const hoursBetween = (from, to) => (new Date(to) - new Date(from)) / 3600_000;

describe('праздники и настраиваемый SLA', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('праздничный день пропускается при расчёте срока', () => {
    // Вторник 03.11.2026 12:00 МСК + 1 рабочий день: 4 ноября — праздник, срок — четверг 05.11 12:00
    assert.equal(addBusinessHours('2026-11-03T09:00:00.000Z', 24), '2026-11-05T09:00:00.000Z');
  });

  it('администратор меняет сроки — новые обращения считаются по ним', async () => {
    const admin = await app.as('Администратор системы');
    const saved = await admin.patch('/api/admin/sla', {
      high: { firstResponseDays: 2, resolveDays: 5 },
      medium: { firstResponseDays: 3, resolveDays: 14 },
      low: { firstResponseDays: 5, resolveDays: 30 },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.data.find((s) => s.key === 'high').firstResponseDays, 2);

    const emp = await app.as('Сотрудник офиса');
    const t = (await emp.post('/api/tickets', {
      type: 'problem', categoryId: categoryId(app, 'Обучение'), title: 'Срочная тема', description: 'Описание срочной темы для проверки сроков.', priority: 'high',
    })).json.data;
    // Среда 12:00 МСК + 2 рабочих дня = пятница 12:00 МСК
    assert.equal(hoursBetween(t.createdAt, t.firstResponseDue), 48);
    assert.equal((await emp.get('/api/meta')).json.data.sla.find((s) => s.key === 'high').resolveDays, 5);
  });

  it('повреждённая запись настроек не ломает создание обращений', async () => {
    app.db.prepare("INSERT INTO settings (key, value) VALUES ('sla', '{oops') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    const emp = await app.as('Сотрудник офиса');
    const t = await emp.post('/api/tickets', {
      type: 'idea', categoryId: categoryId(app, 'Обучение'), title: 'Тема при сбое настроек', description: 'Проверка сроков по умолчанию.', priority: 'high',
    });
    assert.equal(t.status, 201);
    assert.equal(hoursBetween(t.json.data.createdAt, t.json.data.firstResponseDue), 24);
  });

  it('некорректные сроки отклоняются, сотруднику настройка недоступна', async () => {
    const admin = await app.as('Администратор системы');
    const valid = { firstResponseDays: 1, resolveDays: 7 };
    const zero = await admin.patch('/api/admin/sla', { high: { firstResponseDays: 0, resolveDays: 7 }, medium: valid, low: valid });
    assert.equal(zero.status, 400);
    const inverted = await admin.patch('/api/admin/sla', { high: { firstResponseDays: 9, resolveDays: 7 }, medium: valid, low: valid });
    assert.equal(inverted.status, 400);
    const emp = await app.as('Сотрудник офиса');
    assert.equal((await emp.patch('/api/admin/sla', {})).status, 403);
    assert.equal((await emp.get('/api/admin/sla')).status, 403);
  });
});

describe('повторные напоминания об эскалации', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('раньше двух рабочих дней напоминание не уходит, затем уходит с номером', async () => {
    const id = app.ticketId('A-007');
    const state = () => app.db.prepare("SELECT count FROM escalations WHERE ticket_id = ? AND kind = 'first_response'").get(id);
    assert.equal(state().count, 1);
    escalateOverdue(app.db, addHours(TEST_NOW, 24));
    assert.equal(state().count, 1);
    // Среда + 48 рабочих часов = пятница
    assert.ok(escalateOverdue(app.db, addHours(TEST_NOW, 48)) >= 4);
    assert.equal(state().count, 2);
    const manager = await app.as('Директор по развитию');
    const ticket = (await manager.get(`/api/tickets/${id}`)).json.data;
    assert.ok(ticket.events.some((e) => e.kind === 'escalation' && /Напоминание №1/.test(e.body)));
    const notes = (await manager.get('/api/notifications')).json.data.items.map((n) => n.text);
    assert.ok(notes.some((t) => t.startsWith('Напоминание о просрочке A-007')));
  });
});

describe('наблюдатели: приглашение и подписка', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('приглашённый коллега получает доступ на чтение, но не на обработку', async () => {
    const id = app.ticketId('A-001');
    const guest = await app.as('IT-специалист');
    assert.equal((await guest.get(`/api/tickets/${id}`)).status, 404);

    const owner = await app.as('Руководитель закупок');
    const invited = await owner.post(`/api/tickets/${id}/invite`, { userId: app.userId('IT-специалист') });
    assert.equal(invited.status, 200);
    assert.deepEqual(invited.json.data.watchers.map((w) => w.name), ['IT-специалист']);

    const seen = await guest.get(`/api/tickets/${id}`);
    assert.equal(seen.status, 200);
    assert.equal(seen.json.data.permissions.canProcess, false);
    assert.ok(!seen.json.data.events.some((e) => e.isInternal));
    assert.equal((await guest.post(`/api/tickets/${id}/status`, { status: 'in_review' })).status, 403);
    assert.ok((await guest.get('/api/tickets')).json.data.some((t) => t.code === 'A-001'));
    assert.ok((await guest.get('/api/notifications')).json.data.items.some((n) => /зовут в обсуждение A-001/.test(n.text)));
  });

  it('наблюдатель получает уведомления о статусе, но не о внутренних заметках', async () => {
    const id = app.ticketId('A-001');
    const owner = await app.as('Руководитель закупок');
    await owner.post(`/api/tickets/${id}/status`, { status: 'in_review', comment: 'Принято' });
    await owner.post(`/api/tickets/${id}/comments`, { body: 'Скрыто от наблюдателя', internal: true });
    const guest = await app.as('IT-специалист');
    const notes = (await guest.get('/api/notifications')).json.data.items.map((n) => n.text);
    assert.ok(notes.some((t) => /A-001: статус изменён/.test(t)));
    assert.ok(!notes.some((t) => /новый комментарий/.test(t)));
    assert.equal((await guest.post(`/api/tickets/${id}/comments`, { body: 'Могу помочь с шаблоном' })).status, 200);
  });

  it('приглашённый отписывается и теряет доступ без ошибки', async () => {
    const id = app.ticketId('A-009');
    const owner = await app.as('Ответственный за договоры');
    await owner.post(`/api/tickets/${id}/invite`, { userId: app.userId('Руководитель проектов') });
    const guest = await app.as('Руководитель проектов');
    const left = await guest.post(`/api/tickets/${id}/watch`, { watch: false });
    assert.equal(left.status, 200);
    assert.deepEqual(left.json.data, { left: true });
    assert.equal((await guest.get(`/api/tickets/${id}`)).status, 404);
  });

  it('автора нельзя пригласить наблюдателем; приглашение не раскрывает имя пригласившего', async () => {
    const admin = await app.as('Администратор системы');
    const own = (await admin.post('/api/tickets', {
      type: 'problem', categoryId: app.db.prepare("SELECT id FROM categories WHERE name = 'Обучение'").get().id,
      title: 'Тема от администратора', description: 'Обращение для проверки приглашения автора.',
    })).json.data;
    const handler = await app.as('Ответственный за обучение');
    assert.equal((await handler.post(`/api/tickets/${own.id}/invite`, { userId: app.userId('Администратор системы') })).status, 400);
    await handler.post(`/api/tickets/${own.id}/invite`, { userId: app.userId('Руководитель продаж') });
    const guest = await app.as('Руководитель продаж');
    const note = (await guest.get('/api/notifications')).json.data.items.find((n) => n.ticket_id === own.id);
    assert.match(note.text, /^Вас зовут в обсуждение/);
  });

  it('ограничения приглашения', async () => {
    const id = app.ticketId('A-001');
    const owner = await app.as('Руководитель закупок');
    assert.equal((await owner.post(`/api/tickets/${id}/invite`, { userId: app.userId('IT-специалист') })).status, 400);
    assert.equal((await owner.post(`/api/tickets/${id}/invite`, { userId: app.userId('Сотрудник офиса') })).status, 400);
    const author = await app.as('Сотрудник закупок');
    assert.equal((await author.post(`/api/tickets/${id}/invite`, { userId: app.userId('Руководитель продаж') })).status, 403);
  });

  it('руководитель подписывается и отписывается; автору подписка не нужна', async () => {
    const id = app.ticketId('A-001');
    const manager = await app.as('Директор по развитию');
    assert.equal((await manager.post(`/api/tickets/${id}/watch`, { watch: true })).json.data.isWatching, true);
    assert.equal((await manager.post(`/api/tickets/${id}/watch`, { watch: false })).json.data.isWatching, false);
    assert.equal((await manager.post(`/api/tickets/${id}/watch`, {})).status, 400);
    const author = await app.as('Сотрудник закупок');
    assert.equal((await author.post(`/api/tickets/${id}/watch`, { watch: true })).status, 400);
  });
});

describe('задача в Битрикс24 (имитация), оценка, экспорт', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('задача создаётся один раз и попадает в журнал имитации', async () => {
    const id = app.ticketId('A-009');
    const handler = await app.as('Ответственный за договоры');
    const created = await handler.post(`/api/tickets/${id}/b24-task`);
    assert.equal(created.status, 200);
    assert.match(created.json.data.b24Task.text, /Битрикс24 №\d+ \(имитация\)/);
    assert.equal(created.json.data.permissions.canCreateTask, false);
    assert.equal((await handler.post(`/api/tickets/${id}/b24-task`)).status, 400);

    const admin = await app.as('Администратор системы');
    const entry = (await admin.get('/api/admin/outbox')).json.data.find((o) => o.method === 'tasks.task.add');
    assert.equal(entry.payload.TITLE, '[A-009] Неясно, кто готовит и проверяет приложение к договору');
    const author = await app.as('Менеджер по продажам');
    assert.equal((await author.post(`/api/tickets/${id}/b24-task`)).status, 403);
  });

  it('повторное открытие сбрасывает оценку автора', async () => {
    const id = app.ticketId('A-017');
    const author = await app.as('Сотрудник офиса');
    await author.post(`/api/tickets/${id}/feedback`, { isResolved: false });
    const handler = await app.as('Административный руководитель');
    const reopened = await handler.post(`/api/tickets/${id}/status`, { status: 'in_review', comment: 'Появилось помещение' });
    assert.equal(reopened.json.data.feedback, null);
    assert.ok(reopened.json.data.events.some((e) => /оценка автора сброшена/.test(e.body ?? '')));
    assert.equal(reopened.json.data.resolution, null);
    const reused = await handler.post(`/api/tickets/${id}/status`, { status: 'implemented' });
    assert.equal(reused.status, 400);
    await handler.post(`/api/tickets/${id}/status`, { status: 'implemented', resolution: 'Зона отдыха открыта' });
    assert.equal((await author.get(`/api/tickets/${id}`)).json.data.permissions.canRate, true);
  });

  it('экспорт сообщает, если выгружены не все строки', () => {
    const manager = app.db.prepare("SELECT id, name, role, department FROM users WHERE role = 'manager'").get();
    const lines = exportTicketsCsv(app.db, manager, {}, TEST_NOW, { maxRows: 5 }).trim().split('\r\n');
    assert.equal(lines.length, 7);
    assert.match(lines.at(-1), /Показаны первые 5 из 20/);
    const full = exportTicketsCsv(app.db, manager, {}, TEST_NOW).trim().split('\r\n');
    assert.equal(full.length, 21);
  });
});

describe('главная страница и справочники', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('сотрудник видит свои обращения и те, где ждут его ответа', async () => {
    const emp = await app.as('Сотрудник бухгалтерии');
    const home = (await emp.get('/api/home')).json.data;
    assert.equal(home.author.myTotal, 4);
    assert.deepEqual(home.author.needsReply.map((t) => t.code), ['A-005']);
    assert.equal(home.handler, null);
    assert.equal(home.oversight, null);
    assert.equal(home.wins.length, 2);
  });

  it('закрытые обращения не вытесняют открытые из очереди ответственного', async () => {
    const itId = app.userId('IT-специалист');
    const insert = app.db.prepare(
      `INSERT INTO tickets (code, type, category_id, title, description, priority, status, author_id, department, assignee_id,
         resolution, created_at, updated_at, first_response_due, due_at, first_response_at, resolved_at)
       VALUES (?, 'idea', 1, 'Закрытая тема', 'Закрытое обращение для проверки очереди.', 'low', 'closed', 1, 'Закупки', ?, 'Готово', ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 120; i += 1) {
      insert.run(`Z-${i}`, itId, '2026-11-11T10:00:00.000Z', '2026-11-11T10:00:00.000Z', '2026-11-12T10:00:00.000Z', '2026-12-11T10:00:00.000Z', '2026-11-11T10:30:00.000Z', '2026-11-11T11:00:00.000Z');
    }
    const handler = await app.as('IT-специалист');
    const { handler: queue } = (await handler.get('/api/home')).json.data;
    assert.equal(queue.openCount, 2);
    assert.equal(queue.overdueCount, 1);
    const board = (await handler.get('/api/tickets?scope=assigned&notClosed=1&limit=100')).json;
    assert.equal(board.meta.total, 2);
    app.db.prepare("DELETE FROM tickets WHERE code LIKE 'Z-%'").run();
  });

  it('ответственный видит свою очередь', async () => {
    const handler = await app.as('IT-специалист');
    const { handler: queue } = (await handler.get('/api/home')).json.data;
    assert.equal(queue.openCount, 2);
    assert.equal(queue.overdueCount, 1);
    assert.deepEqual(queue.waitingFirstResponse.map((t) => t.code), ['A-007']);
    assert.deepEqual(queue.nextDeadlines.map((t) => t.code), ['A-012']);
  });

  it('руководитель видит показатели, просрочки и динамику по неделям', async () => {
    const manager = await app.as('Директор по развитию');
    const { oversight } = (await manager.get('/api/home')).json.data;
    assert.equal(oversight.kpi.overdueCount, 4);
    assert.equal(oversight.overdue.length, 4);
    assert.equal(oversight.weekly.length, 8);
    assert.equal(oversight.weekly.reduce((sum, w) => sum + w.created, 0), 20);
    assert.equal(oversight.weekly.at(-1).weekStart, '2026-11-08T21:00:00.000Z');
  });

  it('справочники отдают переходы статусов и шаблоны ответов', async () => {
    const emp = await app.as('Сотрудник офиса');
    const meta = (await emp.get('/api/meta')).json.data;
    assert.deepEqual(meta.transitions.implemented, ['closed']);
    assert.ok(meta.templates.some((t) => t.field === 'resolution'));
    assert.equal(meta.limits.exportMax, 5000);
  });
});
