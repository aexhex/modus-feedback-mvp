import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

const categoryId = (app, name) => app.db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;

const newTicket = (app, overrides = {}) => ({
  type: 'problem',
  categoryId: categoryId(app, 'Каталог и данные'),
  title: 'Дубли позиций в каталоге',
  description: 'В каталоге встречаются разные обозначения одного изделия, это мешает проверке.',
  priority: 'high',
  ...overrides,
});

describe('сессия и доступ', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('без входа API возвращает 401', async () => {
    const r = await app.request(null, 'GET', '/api/tickets');
    assert.equal(r.status, 401);
    assert.equal(r.json.ok, false);
  });

  it('список демо-пользователей доступен без входа', async () => {
    const r = await app.request(null, 'GET', '/api/demo-users');
    assert.equal(r.json.data.users.length, 24);
  });

  it('сотрудник видит только свои обращения', async () => {
    const emp = await app.as('Сотрудник закупок');
    const r = await emp.get('/api/tickets');
    assert.ok(r.json.data.length > 0);
    assert.ok(r.json.data.every((t) => t.author?.name === 'Сотрудник закупок'));
  });

  it('чужое обращение для сотрудника — 404', async () => {
    const emp = await app.as('Сотрудник офиса');
    const r = await emp.get(`/api/tickets/${app.ticketId('A-001')}`);
    assert.equal(r.status, 404);
  });

  it('ответственный видит назначенные ему, руководитель — все', async () => {
    const handler = await app.as('IT-специалист');
    const mine = (await handler.get('/api/tickets')).json.data;
    assert.deepEqual(mine.map((t) => t.code).sort(), ['A-007', 'A-012']);
    const manager = await app.as('Директор по развитию');
    assert.equal((await manager.get('/api/tickets')).json.data.length, 20);
  });

  it('аналитика и администрирование закрыты для сотрудника', async () => {
    const emp = await app.as('Сотрудник закупок');
    assert.equal((await emp.get('/api/analytics')).status, 403);
    assert.equal((await emp.get('/api/admin/categories')).status, 403);
  });

  it('мутации требуют JSON (защита от CSRF через формы)', async () => {
    const emp = await app.as('Сотрудник закупок');
    const cookieUser = await app.request(null, 'POST', '/api/session', { userId: app.userId('Сотрудник закупок') });
    const cookie = cookieUser.headers.get('set-cookie').split(';')[0];
    const res = await fetch(`${app.base}/api/tickets`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1',
    });
    assert.equal(res.status, 415);
    assert.ok(emp);
  });

  it('выход завершает сессию', async () => {
    const emp = await app.as('Сотрудник закупок');
    assert.equal((await emp.del('/api/session')).status, 200);
    assert.equal((await emp.get('/api/me')).status, 401);
  });
});

describe('создание и маршрутизация', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('новое обращение получает номер, SLA и ответственного по правилу категории', async () => {
    const emp = await app.as('Сотрудник проектирования');
    const r = await emp.post('/api/tickets', newTicket(app));
    assert.equal(r.status, 201);
    const t = r.json.data;
    assert.equal(t.code, 'A-021');
    assert.equal(t.status, 'new');
    assert.equal(t.assignee.name, 'Ответственный за номенклатуру');
    assert.equal(t.department, 'Проектирование');
    const hours = (new Date(t.firstResponseDue) - new Date(t.createdAt)) / 3600_000;
    assert.equal(hours, 24);
    assert.match(t.events.find((e) => e.kind === 'assigned').body, /по правилу/);
  });

  it('ответственный получает уведомление', async () => {
    const handler = await app.as('Ответственный за номенклатуру');
    const r = await handler.get('/api/notifications');
    assert.ok(r.json.data.items.some((n) => n.ticket_code === 'A-021'));
    await handler.post('/api/notifications/read');
    assert.equal((await handler.get('/api/notifications')).json.data.unread, 0);
  });

  it('при недоступности основного назначается резервный, затем диспетчер', async () => {
    const admin = await app.as('Администратор системы');
    await admin.patch(`/api/admin/users/${app.userId('Ответственный за номенклатуру')}`, { isAvailable: false });
    const emp = await app.as('Сотрудник проектирования');
    const fallback = (await emp.post('/api/tickets', newTicket(app))).json.data;
    assert.equal(fallback.assignee.name, 'IT-специалист');
    assert.match(fallback.events.find((e) => e.kind === 'assigned').body, /резервный/);

    await admin.patch(`/api/admin/users/${app.userId('IT-специалист')}`, { isAvailable: false });
    const dispatched = (await emp.post('/api/tickets', newTicket(app))).json.data;
    assert.equal(dispatched.assignee.name, 'Директор по развитию');
  });

  it('валидация: короткое описание и неизвестная категория', async () => {
    const emp = await app.as('Сотрудник проектирования');
    const short = await emp.post('/api/tickets', newTicket(app, { description: 'коротко' }));
    assert.equal(short.status, 400);
    const badCat = await emp.post('/api/tickets', newTicket(app, { categoryId: 9999 }));
    assert.equal(badCat.status, 400);
    const badType = await emp.post('/api/tickets', newTicket(app, { type: 'spam' }));
    assert.equal(badType.status, 400);
  });

  it('анонимное обращение скрывает автора от обработчика, но не от самого автора', async () => {
    const emp = await app.as('Сотрудник бухгалтерии');
    const created = (await emp.post('/api/tickets', newTicket(app, {
      categoryId: categoryId(app, 'Регламенты'), isAnonymous: true,
    }))).json.data;
    assert.equal(created.author.name, 'Сотрудник бухгалтерии');
    const handler = await app.as('Ответственный за процессы');
    const seen = (await handler.get(`/api/tickets/${created.id}`)).json.data;
    assert.equal(seen.author, null);
    assert.equal(seen.department, null);
    assert.equal(seen.events[0].actorName, 'Автор (анонимно)');
  });

  it('похожие обращения находятся по тексту', async () => {
    const emp = await app.as('Сотрудник офиса');
    const r = await emp.get(`/api/tickets/similar?text=${encodeURIComponent('в заявках на оборудование не хватает параметров изделия')}`);
    assert.equal(r.json.data[0].code, 'A-001');
    assert.equal(r.json.data[0].canOpen, false);
  });
});

describe('рассмотрение обращения', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('недопустимый переход статуса отклоняется', async () => {
    const handler = await app.as('Руководитель закупок');
    const r = await handler.post(`/api/tickets/${app.ticketId('A-001')}/status`, { status: 'implemented', resolution: 'x' });
    assert.equal(r.status, 400);
  });

  it('итоговый статус требует результата', async () => {
    const handler = await app.as('Руководитель закупок');
    const r = await handler.post(`/api/tickets/${app.ticketId('A-001')}/status`, { status: 'rejected' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /результат/);
  });

  it('сотрудник не может менять статус', async () => {
    const emp = await app.as('Сотрудник закупок');
    const r = await emp.post(`/api/tickets/${app.ticketId('A-001')}/status`, { status: 'in_review' });
    assert.equal(r.status, 403);
  });

  it('запрос уточнения → ответ автора возвращает на рассмотрение', async () => {
    const id = app.ticketId('A-001');
    const handler = await app.as('Руководитель закупок');
    const ask = await handler.post(`/api/tickets/${id}/status`, { status: 'need_info', comment: 'Приложите пример заявки' });
    assert.equal(ask.json.data.status, 'need_info');
    assert.ok(ask.json.data.firstResponseAt);

    const emp = await app.as('Сотрудник закупок');
    const notes = (await emp.get('/api/notifications')).json.data.items;
    assert.ok(notes.some((n) => /Ожидает уточнения/.test(n.text)));
    const reply = await emp.post(`/api/tickets/${id}/comments`, { body: 'Пример во вложении' });
    assert.equal(reply.json.data.status, 'in_review');
  });

  it('внутренняя заметка не видна автору', async () => {
    const id = app.ticketId('A-001');
    const handler = await app.as('Руководитель закупок');
    await handler.post(`/api/tickets/${id}/comments`, { body: 'Секретная заметка', internal: true });
    const emp = await app.as('Сотрудник закупок');
    const events = (await emp.get(`/api/tickets/${id}`)).json.data.events;
    assert.ok(!events.some((e) => e.body === 'Секретная заметка'));
    const internalByAuthor = await emp.post(`/api/tickets/${id}/comments`, { body: 'x', internal: true });
    assert.equal(internalByAuthor.status, 403);
  });

  it('мотивированный отказ виден автору и закрывается', async () => {
    const id = app.ticketId('A-001');
    const handler = await app.as('Руководитель закупок');
    const r = await handler.post(`/api/tickets/${id}/status`, { status: 'rejected', resolution: 'Шаблон уже обновлён в другом проекте' });
    assert.equal(r.json.data.status, 'rejected');
    assert.ok(r.json.data.resolvedAt);
    const emp = await app.as('Сотрудник закупок');
    const seen = (await emp.get(`/api/tickets/${id}`)).json.data;
    assert.equal(seen.resolution, 'Шаблон уже обновлён в другом проекте');
    const closed = await handler.post(`/api/tickets/${id}/status`, { status: 'closed' });
    assert.equal(closed.json.data.status, 'closed');
    const late = await emp.post(`/api/tickets/${id}/comments`, { body: 'ещё вопрос' });
    assert.equal(late.status, 400);
  });

  it('руководитель переназначает и меняет приоритет с пересчётом SLA', async () => {
    const id = app.ticketId('A-016');
    const manager = await app.as('Директор по развитию');
    const r = await manager.post(`/api/tickets/${id}/assign`, { assigneeId: app.userId('HR / внутренние коммуникации'), reason: 'Отпуск' });
    assert.equal(r.json.data.assignee.name, 'HR / внутренние коммуникации');
    const p = await manager.post(`/api/tickets/${id}/priority`, { priority: 'high' });
    const t = p.json.data;
    assert.equal((new Date(t.firstResponseDue) - new Date(t.createdAt)) / 3600_000, 24);
    const handler = await app.as('Руководитель закупок');
    assert.equal((await handler.post(`/api/tickets/${id}/assign`, { assigneeId: 1 })).status, 403);
  });

  it('поддержка: нельзя дважды и нельзя своё', async () => {
    const id = app.ticketId('A-020');
    const emp = await app.as('Сотрудник офиса');
    assert.equal((await emp.post(`/api/tickets/${id}/support`)).json.data.supportsCount, 2);
    assert.equal((await emp.post(`/api/tickets/${id}/support`)).status, 400);
    const author = await app.as('Сотрудник закупок');
    assert.equal((await author.post(`/api/tickets/${id}/support`)).status, 400);
  });

  it('дубликат закрывается, автор добавляется в поддержавшие исходного', async () => {
    const emp = await app.as('Сотрудник офиса');
    const dup = (await emp.post('/api/tickets', newTicket(app))).json.data;
    const handler = await app.as('Ответственный за номенклатуру');
    const r = await handler.post(`/api/tickets/${dup.id}/duplicate`, { code: 'a-003' });
    assert.equal(r.json.data.status, 'closed');
    assert.equal(r.json.data.duplicateOf.code, 'A-003');
    const original = (await handler.get(`/api/tickets/${app.ticketId('A-003')}`)).json.data;
    assert.equal(original.supportsCount, 4);
  });
});

describe('фильтры, SLA, аналитика, доска', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('фильтр просроченных находит обращения с нарушением SLA', async () => {
    const manager = await app.as('Директор по развитию');
    const r = await manager.get('/api/tickets?overdue=1');
    const codes = r.json.data.map((t) => t.code).sort();
    assert.deepEqual(codes, ['A-003', 'A-007', 'A-011', 'A-014']);
    assert.equal(r.json.data.find((t) => t.code === 'A-007').sla.kind, 'first_response');
  });

  it('фильтры по статусу, типу, подразделению и тексту', async () => {
    const manager = await app.as('Директор по развитию');
    const byStatus = (await manager.get('/api/tickets?status=need_info')).json.data.map((t) => t.code).sort();
    assert.deepEqual(byStatus, ['A-005', 'A-013']);
    const praise = (await manager.get('/api/tickets?type=praise')).json.data;
    assert.equal(praise.length, 1);
    const dept = (await manager.get(`/api/tickets?department=${encodeURIComponent('Бухгалтерия')}`)).json.data;
    assert.equal(dept.length, 4);
    const q = (await manager.get(`/api/tickets?q=${encodeURIComponent('спецификац')}`)).json.data;
    assert.ok(q.some((t) => t.code === 'A-013'));
  });

  it('аналитика считает ключевые показатели', async () => {
    const manager = await app.as('Директор по развитию');
    const a = (await manager.get('/api/analytics')).json.data;
    assert.equal(a.total, 20);
    assert.equal(a.kpi.overdueCount, 4);
    assert.equal(a.kpi.implementedCount, 2);
    assert.equal(a.kpi.withResultShare, 100);
    assert.equal(a.kpi.closedShare, 20);
    assert.ok(a.kpi.avgFirstResponseHours > 0);
    assert.equal(a.byType.find((x) => x.key === 'problem').count, 9);
    assert.equal(a.byType.find((x) => x.key === 'idea').count, 10);
    assert.ok(a.repeatedTopics.length > 0);
  });

  it('доска улучшений доступна всем и не раскрывает авторов', async () => {
    const emp = await app.as('Сотрудник офиса');
    const b = (await emp.get('/api/board')).json.data;
    assert.deepEqual(b.implemented.map((x) => x.code).sort(), ['A-004', 'A-008']);
    assert.ok(b.implemented.every((x) => !('author' in x)));
    assert.equal(b.openIdeas[0].code, 'A-003');
  });

  it('справочники', async () => {
    const emp = await app.as('Сотрудник офиса');
    const m = (await emp.get('/api/meta')).json.data;
    assert.equal(m.categories.length, 18);
    assert.equal(m.statuses.length, 7);
  });
});
