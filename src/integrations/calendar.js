// Производственный календарь: праздники и переносы на год из открытого источника вместо ручного списка.
// Формат — как у isdayoff.ru: GET {base}api/getdata?year=ГГГГ&cc=страна → строка из 365/366 цифр,
// по одной на день: 0 — рабочий, 1 — нерабочий (остальные значения — рабочий день).
// Наружу уходят только год и код страны. В демо-режиме источник — демо-портал на этом же сервере.
import { IntegrationError } from './clients.js';
import { badRequest } from '../http.js';

const TIMEOUT_MS = 10_000;
export const CALENDAR_COUNTRIES = Object.freeze({ ru: 'Россия', kz: 'Казахстан' });
const SOURCE_ERRORS = { 100: 'неверный год', 101: 'нет данных на этот год', 199: 'ошибка сервиса' };
const DAY_MS = 24 * 3600 * 1000;
const MAX_RESPONSE = 1000;

const isLeap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

export function parseCalendarYear(raw, year) {
  const text = String(raw ?? '').trim();
  if (SOURCE_ERRORS[text]) throw new IntegrationError(`Производственный календарь: ${SOURCE_ERRORS[text]}`);
  if (!/^\d+$/.test(text) || text.length !== (isLeap(year) ? 366 : 365)) {
    throw new IntegrationError('Производственный календарь: ответ не похож на календарь года');
  }
  const holidays = [];
  const workdays = [];
  const start = Date.UTC(year, 0, 1);
  for (let i = 0; i < text.length; i += 1) {
    const date = new Date(start + i * DAY_MS);
    const day = date.toISOString().slice(0, 10);
    const weekend = [0, 6].includes(date.getUTCDay());
    const off = text[i] === '1';
    if (off && !weekend) holidays.push(day);
    if (!off && weekend) workdays.push(day);
  }
  return { holidays, workdays };
}

/** @returns {Promise<{ holidays: string[], workdays: string[] }>} */
export async function fetchCalendarYear(baseUrl, year, country) {
  const url = new URL('api/getdata', baseUrl);
  url.search = new URLSearchParams({ year: String(year), cc: country, pre: '0' }).toString();
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new IntegrationError(`Производственный календарь: ${url.host} — ${error.name === 'TimeoutError' ? 'нет ответа за 10 секунд' : 'сервис недоступен'}`);
  }
  // Год — 366 символов; ответ заметно длиннее — не календарь (и не читаем его целиком).
  if (Number(res.headers.get('content-length')) > MAX_RESPONSE) throw new IntegrationError('Производственный календарь: ответ не похож на календарь года');
  const text = (await res.text()).slice(0, MAX_RESPONSE);
  if (res.status >= 400 && !SOURCE_ERRORS[text.trim()]) throw new IntegrationError(`Производственный календарь: HTTP ${res.status}`);
  return parseCalendarYear(text, year);
}

export function validCalendarRequest(input, nowIso) {
  const year = Number(input.year);
  const current = new Date(nowIso).getUTCFullYear();
  if (!Number.isInteger(year) || year < current - 1 || year > current + 1) {
    throw badRequest(`Год: от ${current - 1} до ${current + 1}`);
  }
  if (!Object.hasOwn(CALENDAR_COUNTRIES, input.country)) throw badRequest('Страна: ru или kz');
  return { year, country: input.country };
}
