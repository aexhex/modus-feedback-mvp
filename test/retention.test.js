// Хранение персональных данных уволенных: дата отключения, обезличивание по сроку и по просьбе.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

describe('обезличивание уволенных', () => {
  let app;
  let admin;
  const user = (id) => app.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  before(async () => {
    app = await startTestApp({ demoMode: true });
    admin = await app.as('Администратор системы');
  });
  after(() => app.close());

  it('дата отключения ставится при отключении и сбрасывается при включении', async () => {
    const id = app.userId('Менеджер по продажам');
    await admin.patch(`/api/admin/users/${id}`, { isActive: false });
    assert.ok(user(id).deactivated_at);
    await admin.patch(`/api/admin/users/${id}`, { isActive: true });
    assert.equal(user(id).deactivated_at, null);
  });

  it('по просьбе: имя, контакты и связи удаляются, обращения остаются без имени', async () => {
    const name = 'Сотрудник закупок';
    const id = app.userId(name);
    // След имени в журналах: уведомление (журнал отправки) и запись журнала действий.
    const handler = await app.as('Руководитель закупок');
    await handler.post(`/api/tickets/${app.ticketId('A-001')}/status`, { status: 'in_review', comment: 'Смотрим' });
    assert.equal((await admin.post(`/api/admin/users/${id}/anonymize`)).status, 400, 'активного обезличить нельзя');
    await admin.patch(`/api/admin/users/${id}`, { isActive: false });
    const emp = await app.as('Сотрудник офиса');
    assert.equal((await emp.post(`/api/admin/users/${id}/anonymize`)).status, 403);

    const res = await admin.post(`/api/admin/users/${id}/anonymize`);
    assert.equal(res.status, 200);
    const row = user(id);
    assert.equal(row.name, `Бывший сотрудник №${id}`);
    assert.deepEqual([row.email, row.phone, row.position, row.b24_id], [null, null, null, null]);
    assert.ok(row.anonymized_at);
    assert.equal(res.json.data.find((u) => u.id === id).anonymizedAt, row.anonymized_at);
    for (const [table, column] of [['audit_log', 'details'], ['outbox', 'recipient'], ['outbox', 'payload'], ['notifications', 'text'], ['events', 'body']]) {
      assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE ?`).get(`%${name}%`).n, 0, `${table}.${column} без имени`);
    }
    const ticket = (await admin.get(`/api/tickets/${app.ticketId('A-001')}`)).json.data;
    assert.equal(ticket.author.name, `Бывший сотрудник №${id}`, 'обращение осталось');
    const entry = (await admin.get('/api/admin/audit')).json.data.find((a) => a.action === 'Персональные данные обезличены');
    assert.equal(entry.details, `Бывший сотрудник №${id}`);

    assert.equal((await admin.post(`/api/admin/users/${id}/anonymize`)).status, 400, 'повторно — нет');
    assert.equal((await admin.patch(`/api/admin/users/${id}`, { isActive: true })).status, 400, 'включить снова нельзя');
    assert.equal((await admin.patch(`/api/admin/users/${id}`, { name })).status, 400, 'вернуть имя нельзя');
  });

  it('по сроку хранения: через выбранный срок после отключения — автоматически', async () => {
    assert.equal((await admin.patch('/api/admin/retention', { months: 5 })).status, 400);
    const set = await admin.patch('/api/admin/retention', { months: 6 });
    assert.equal(set.json.data.months, 6);
    const id = app.userId('Сотрудник бухгалтерии');
    await admin.patch(`/api/admin/users/${id}`, { isActive: false });
    assert.equal((await admin.get('/api/admin/retention')).json.data.due, 0, 'срок ещё не истёк');
    app.setNow('2027-06-01T09:00:00.000Z');
    const fresh = await app.as('Администратор системы');
    assert.equal((await fresh.get('/api/admin/retention')).json.data.due, 1);
    const run = await fresh.post('/api/admin/retention/run');
    assert.equal(run.json.data.anonymized, 1);
    assert.equal(user(id).name, `Бывший сотрудник №${id}`);
    assert.ok((await fresh.get('/api/admin/audit')).json.data.some((a) => a.details === 'по сроку хранения: 1'));
    assert.equal((await fresh.patch('/api/admin/retention', { months: null })).json.data.months, null);
  });
});
