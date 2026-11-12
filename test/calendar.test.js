// Производственный календарь: разбор ответа источника, загрузка года, рабочие выходные в расчёте сроков.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { parseCalendarYear } from '../src/integrations/calendar.js';
import { addBusinessHours } from '../src/config.js';
import { IntegrationError } from '../src/integrations/clients.js';

// 2027: 1 января — пятница. Строим год: выходные «1», плюс 1 марта (пн) — праздник, 6 марта (сб) — рабочая.
function year2027() {
  const days = [];
  for (let t = Date.UTC(2027, 0, 1); new Date(t).getUTCFullYear() === 2027; t += 86_400_000) {
    const d = new Date(t);
    const iso = d.toISOString().slice(0, 10);
    const weekend = [0, 6].includes(d.getUTCDay());
    days.push(iso === '2027-03-01' || (weekend && iso !== '2027-03-06') ? '1' : '0');
  }
  return days.join('');
}

describe('разбор производственного календаря', () => {
  it('праздники — нерабочие будни, рабочие выходные — переносы', () => {
    const { holidays, workdays } = parseCalendarYear(year2027(), 2027);
    assert.deepEqual(holidays, ['2027-03-01']);
    assert.deepEqual(workdays, ['2027-03-06']);
  });

  it('код ошибки источника и ответ не той длины — понятная ошибка', () => {
    assert.throws(() => parseCalendarYear('101', 2027), (e) => e instanceof IntegrationError && /нет данных/.test(e.message));
    assert.throws(() => parseCalendarYear('0'.repeat(365), 2028), /не похож на календарь/, '2028 — високосный, нужно 366 дней');
    assert.throws(() => parseCalendarYear('<html>', 2027), /не похож/);
  });

  it('рабочий выходной входит в срок, праздник — нет', () => {
    const calendar = { holidays: new Set(['2027-03-01']), workdays: new Set(['2027-03-06']) };
    // Пятница 5 марта 12:00 по Москве + 24 рабочих часа: суббота 6-го рабочая → суббота 12:00.
    assert.equal(addBusinessHours('2027-03-05T09:00:00.000Z', 24, calendar), '2027-03-06T09:00:00.000Z');
    // Без переноса суббота и воскресенье выходные → понедельник 8 марта.
    assert.equal(addBusinessHours('2027-03-05T09:00:00.000Z', 24, { holidays: new Set(), workdays: new Set() }), '2027-03-08T09:00:00.000Z');
    // Старый вызов со списком праздников по-прежнему работает.
    assert.equal(addBusinessHours('2027-02-26T09:00:00.000Z', 24, new Set(['2027-03-01'])), '2027-03-02T09:00:00.000Z');
  });
});

describe('загрузка календаря в «Настройках»', () => {
  let app;
  before(async () => { app = await startTestApp({ demoMode: true }); });
  after(() => app.close());

  it('год из демо-источника заменяет даты этого года, другие годы не трогает', async () => {
    const admin = await app.as('Администратор системы');
    await admin.patch('/api/admin/holidays', { dates: ['2026-11-04', '2027-12-31'], workdays: [] });
    const res = await admin.post('/api/admin/calendar/import', { year: 2027, country: 'ru' });
    assert.equal(res.status, 200);
    assert.ok(res.json.data.holidays.includes('2026-11-04'), '2026 не тронут');
    assert.ok(!res.json.data.holidays.includes('2027-12-31'), 'ручная дата 2027 заменена календарём');
    assert.ok(res.json.data.holidays.includes('2027-01-04'));
    assert.equal(res.json.data.loaded.year, 2027);
    assert.ok((await admin.get('/api/admin/audit')).json.data.some((a) => a.action === 'Производственный календарь загружен'));
  });

  it('неверные параметры — 400, нет данных у источника — 502 с причиной', async () => {
    const admin = await app.as('Администратор системы');
    assert.equal((await admin.post('/api/admin/calendar/import', { year: 1999, country: 'ru' })).status, 400);
    assert.equal((await admin.post('/api/admin/calendar/import', { year: 2027, country: 'us' })).status, 400);
    const kz = await admin.post('/api/admin/calendar/import', { year: 2027, country: 'kz' });
    assert.equal(kz.status, 502);
    assert.match(kz.json.error, /нет данных/);
    const emp = await app.as('Сотрудник офиса');
    assert.equal((await emp.post('/api/admin/calendar/import', { year: 2027, country: 'ru' })).status, 403);
  });

  it('рабочие выходные вручную: только субботы и воскресенья', async () => {
    const admin = await app.as('Администратор системы');
    assert.equal((await admin.patch('/api/admin/holidays', { dates: [], workdays: ['2027-03-03'] })).status, 400);
    assert.equal((await admin.patch('/api/admin/holidays', { dates: [], workdays: ['2027-03-06'] })).status, 200);
    const calendar = (await admin.get('/api/admin/calendar')).json.data;
    assert.deepEqual(calendar.workdays, ['2027-03-06']);
    assert.equal(calendar.source.mode, 'demo');
  });
});
