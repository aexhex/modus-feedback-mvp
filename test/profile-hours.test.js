// Свой профиль (контакты сотрудника), почта и телефон в импорте CSV, рабочие часы в сроках SLA.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { addBusinessHours } from '../src/config.js';

describe('свой профиль', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('сотрудник меняет свою почту и телефон, должность — нет', async () => {
    const emp = await app.as('Сотрудник офиса');
    const res = await emp.patch('/api/me/contacts', { email: 'Office@Modus.Example', phone: '+7 (000) 555-00-01', position: 'Директор' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { email: 'office@modus.example', phone: '+7 (000) 555-00-01' });
    const me = (await emp.get('/api/me')).json.data;
    assert.equal(me.position, null, 'должность сотрудник сам не меняет');
    assert.equal(me.phone, '+7 (000) 555-00-01');
    assert.equal((await emp.patch('/api/me/contacts', { email: 'не почта' })).status, 400);
    const admin = await app.as('Администратор системы');
    assert.ok((await admin.get('/api/admin/audit')).json.data.some((a) => a.action === 'Контакты изменены' && /Сотрудник офиса \(сам\)/.test(a.details)));
  });

  it('пустое поле очищает контакт; без входа — 401', async () => {
    const emp = await app.as('Сотрудник офиса');
    const res = await emp.patch('/api/me/contacts', { email: 'office@modus.example', phone: '' });
    assert.equal(res.json.data.phone, null);
    assert.equal((await app.request(null, 'PATCH', '/api/me/contacts', { phone: '+7 000 000 00 00' })).status, 401);
  });
});

describe('импорт пользователей с контактами', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('почта и телефон необязательны; неверная почта — строка пропускается целиком', async () => {
    const admin = await app.as('Администратор системы');
    const csv = [
      'имя;роль;подразделение;почта;телефон',
      'Инженер склада;сотрудник;Склад;sklad@modus.example;+7 (000) 123-45-67',
      'Кладовщик;сотрудник;Склад',
      'Логист;сотрудник;Склад;не-почта;',
    ].join('\n');
    const r = (await admin.post('/api/admin/users/import', { csv })).json.data;
    assert.deepEqual(r.created, ['Инженер склада', 'Кладовщик']);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /Почта/);
    const row = app.db.prepare("SELECT email, phone FROM users WHERE name = 'Инженер склада'").get();
    assert.deepEqual({ ...row }, { email: 'sklad@modus.example', phone: '+7 (000) 123-45-67' });
    assert.equal(app.db.prepare("SELECT 1 FROM users WHERE name = 'Логист'").get(), undefined);
  });
});

describe('рабочие часы в сроках', () => {
  const calendar = { holidays: new Set(), workdays: new Set(), workHours: { start: 9, end: 18 } };

  it('рабочий день срока — окно 9–18 по Москве', () => {
    // Среда 11 ноября 2026, 10:00 МСК (07:00 UTC) + 1 рабочий день (24 «часа SLA») = 9 рабочих часов → четверг 10:00.
    assert.equal(addBusinessHours('2026-11-11T07:00:00.000Z', 24, calendar), '2026-11-12T07:00:00.000Z');
    // Подано в 20:00 МСК — отсчёт с 9:00 четверга: 1 рабочий день → четверг 18:00.
    assert.equal(addBusinessHours('2026-11-11T17:00:00.000Z', 24, calendar), '2026-11-12T15:00:00.000Z');
    // Пятница 17:00 МСК + 1 рабочий день: 1 час в пятницу, 8 — в понедельник → понедельник 17:00.
    assert.equal(addBusinessHours('2026-11-13T14:00:00.000Z', 24, calendar), '2026-11-16T14:00:00.000Z');
    // Без рабочих часов — сутки целиком, как раньше.
    assert.equal(addBusinessHours('2026-11-11T17:00:00.000Z', 24, { holidays: new Set(), workdays: new Set() }), '2026-11-12T17:00:00.000Z');
  });

  it('настройка: администратор включает часы, новые обращения считаются по ним', async () => {
    const app = await startTestApp();
    try {
      const admin = await app.as('Администратор системы');
      assert.equal((await admin.get('/api/admin/work-hours')).json.data, null);
      assert.equal((await admin.patch('/api/admin/work-hours', { enabled: true, start: 18, end: 9 })).status, 400);
      assert.deepEqual((await admin.patch('/api/admin/work-hours', { enabled: true, start: 9, end: 18 })).json.data, { start: 9, end: 18 });
      assert.ok((await admin.get('/api/admin/audit')).json.data.some((a) => a.action === 'Рабочие часы изменены'));
      const emp = await app.as('Сотрудник офиса');
      // TEST_NOW — среда 12:00 МСК; низкий приоритет: ответ за 5 рабочих дней по 9 часов.
      const created = await emp.post('/api/tickets', {
        type: 'idea', categoryId: app.db.prepare("SELECT id FROM categories WHERE name = 'Регламенты'").get().id,
        title: 'Проверка рабочих часов', description: 'Срок ответа считается по рабочим часам.', priority: 'low',
      });
      const ticket = app.db.prepare('SELECT first_response_due FROM tickets WHERE id = ?').get(created.json.data.id);
      // Ср 12:00 + 45 рабочих часов: ср 6 ч, чт 9, пт 9, пн 9, вт 9 = 42, в среду ещё 3 ч с 9:00 → 18 ноября 12:00 МСК.
      assert.equal(ticket.first_response_due, '2026-11-18T09:00:00.000Z');
      assert.equal((await emp.patch('/api/admin/work-hours', { enabled: false })).status, 403);
      assert.equal((await admin.patch('/api/admin/work-hours', { enabled: false })).json.data, null);
    } finally {
      await app.close();
    }
  });
});
