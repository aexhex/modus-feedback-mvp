// Настраиваемые сроки SLA: хранятся в таблице settings, по умолчанию — из config.js.
import { SLA_HOURS, PRIORITIES, HOLIDAYS } from './config.js';
import { badRequest } from './http.js';

const SLA_KEY = 'sla';
const HOURS_PER_DAY = 24;
const MAX_DAYS = 90;

/** @returns {Record<string, { firstResponse: number, resolve: number }>} сроки в рабочих часах */
export function getSla(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SLA_KEY);
  if (!row) return SLA_HOURS;
  let stored = null;
  try {
    stored = JSON.parse(row.value);
  } catch {
    stored = null; // запись повреждена — используем сроки по умолчанию
  }
  const valid = (item) => Number.isFinite(item?.firstResponse) && Number.isFinite(item?.resolve);
  return Object.fromEntries(Object.keys(SLA_HOURS).map((p) => [p, valid(stored?.[p]) ? stored[p] : SLA_HOURS[p]]));
}

/** Сроки в рабочих днях — для интерфейса. */
export function getSlaDays(db) {
  const sla = getSla(db);
  return Object.keys(PRIORITIES).map((key) => ({
    key,
    label: PRIORITIES[key],
    firstResponseDays: sla[key].firstResponse / HOURS_PER_DAY,
    resolveDays: sla[key].resolve / HOURS_PER_DAY,
  }));
}

function days(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) {
    throw badRequest(`${field}: целое число рабочих дней от 1 до ${MAX_DAYS}`);
  }
  return n;
}

// Новые сроки действуют для обращений, созданных после изменения; у существующих сроки не меняются.
export function setSla(db, input) {
  const next = Object.fromEntries(Object.keys(PRIORITIES).map((key) => {
    const item = input?.[key] ?? {};
    const firstResponse = days(item.firstResponseDays, `${PRIORITIES[key]} — первый ответ`);
    const resolve = days(item.resolveDays, `${PRIORITIES[key]} — решение`);
    if (firstResponse > resolve) throw badRequest(`${PRIORITIES[key]}: срок ответа не может быть больше срока решения`);
    return [key, { firstResponse: firstResponse * HOURS_PER_DAY, resolve: resolve * HOURS_PER_DAY }];
  }));
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(SLA_KEY, JSON.stringify(next));
}

const HOLIDAYS_KEY = 'holidays';
const HOLIDAYS_MAX = 400;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** @returns {Set<string>} нерабочие праздничные дни; по умолчанию — список из config.js */
export function getHolidays(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(HOLIDAYS_KEY);
  if (!row) return HOLIDAYS;
  try {
    const stored = JSON.parse(row.value);
    return Array.isArray(stored) ? new Set(stored.filter((d) => DATE_RE.test(d))) : HOLIDAYS;
  } catch {
    return HOLIDAYS; // запись повреждена — используем список по умолчанию
  }
}

const WORKDAYS_KEY = 'workdays';

/** @returns {Set<string>} рабочие выходные по переносу (суббота или воскресенье, когда работают) */
export function getWorkdays(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(WORKDAYS_KEY);
  try {
    const stored = row ? JSON.parse(row.value) : [];
    return new Set(Array.isArray(stored) ? stored.filter((d) => DATE_RE.test(d)) : []);
  } catch {
    return new Set();
  }
}

/** Производственный календарь для расчёта сроков: праздники и рабочие выходные. */
export const getCalendar = (db) => ({ holidays: getHolidays(db), workdays: getWorkdays(db) });

export const listHolidays = (db) => [...getHolidays(db)].sort();
export const listCalendar = (db) => ({ holidays: listHolidays(db), workdays: [...getWorkdays(db)].sort() });

// Изменение действует для сроков, которые рассчитываются после сохранения.
function parseDates(list, label) {
  if (!Array.isArray(list)) throw badRequest(`${label}: ожидается список дат`);
  if (list.length > HOLIDAYS_MAX) throw badRequest(`${label}: не больше ${HOLIDAYS_MAX} дат`);
  const dates = [...new Set(list.map((d) => String(d).trim()).filter(Boolean))];
  for (const date of dates) {
    const valid = DATE_RE.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))
      && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
    if (!valid) throw badRequest(`Некорректная дата: ${date}. Формат — ГГГГ-ММ-ДД`);
  }
  return dates.sort();
}

const saveSetting = (db, key, value) => db
  .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  .run(key, JSON.stringify(value));

// workdays — необязательно: рабочие выходные по переносу (только субботы и воскресенья).
export function setHolidays(db, input) {
  const dates = parseDates(input.dates, 'Праздники');
  saveSetting(db, HOLIDAYS_KEY, dates);
  if (input.workdays !== undefined) {
    const workdays = parseDates(input.workdays, 'Рабочие выходные');
    const weekday = workdays.find((d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()));
    if (weekday) throw badRequest(`${weekday}: рабочий выходной должен быть субботой или воскресеньем`);
    saveSetting(db, WORKDAYS_KEY, workdays);
  }
  return dates.length;
}

/** Календарь на год из внешнего источника заменяет записи этого года; другие годы не трогает. */
export function replaceCalendarYear(db, year, { holidays, workdays }) {
  const prefix = `${year}-`;
  const keep = (set) => [...set].filter((d) => !d.startsWith(prefix));
  const nextHolidays = parseDates([...keep(getHolidays(db)), ...holidays], 'Праздники');
  const nextWorkdays = parseDates([...keep(getWorkdays(db)), ...workdays], 'Рабочие выходные');
  saveSetting(db, HOLIDAYS_KEY, nextHolidays);
  saveSetting(db, WORKDAYS_KEY, nextWorkdays);
}
