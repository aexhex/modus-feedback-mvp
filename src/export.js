// Экспорт реестра в CSV для Excel (разделитель «;», BOM, защита от формул).
import { LIMITS } from './config.js';
import { listTickets } from './tickets-query.js';
import { getTimezone } from './settings.js';

const BOM = '﻿';
const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const HOUR_MS = 3_600_000;
// Время — в часовом поясе компании из настроек, как в интерфейсе и в расчёте сроков.
const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
});
const formatter = (offsetHours) => (iso) => (iso ? dateFmt.format(new Date(Date.parse(iso) + offsetHours * HOUR_MS)).replace(',', '') : '');

// Значение, начинающееся с =, +, -, @, Excel выполнил бы как формулу — экранируем апострофом.
function cell(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = FORMULA_PREFIX.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

const columns = (fmt) => [
  ['Номер', (t) => t.code],
  ['Тип', (t) => t.typeLabel],
  ['Категория', (t) => t.category.name],
  ['Тема', (t) => t.title],
  ['Статус', (t) => t.statusLabel],
  ['Приоритет', (t) => t.priorityLabel],
  ['Автор', (t) => t.author?.name ?? 'Анонимно'],
  ['Подразделение', (t) => t.department ?? ''],
  ['Ответственный', (t) => t.assignee?.name ?? ''],
  ['Создано', (t) => fmt(t.createdAt)],
  ['Первый ответ', (t) => fmt(t.firstResponseAt)],
  ['Срок решения', (t) => fmt(t.dueAt)],
  ['Решено', (t) => fmt(t.resolvedAt)],
  ['Просрочено', (t) => (t.sla.overdue ? 'да' : 'нет')],
  ['Поддержали', (t) => t.supportsCount],
  ['Результат', (t) => t.resolution ?? ''],
];

/** @returns {string} CSV-файл с учётом прав пользователя и выбранных фильтров */
export function exportTicketsCsv(db, user, query, nowIso, { maxRows = LIMITS.exportMax } = {}) {
  const { items, total } = listTickets(db, user, { ...query, page: 1, limit: maxRows }, nowIso, {
    maxLimit: maxRows,
  });
  const cols = columns(formatter(getTimezone(db)));
  const lines = [
    cols.map(([title]) => cell(title)).join(';'),
    ...items.map((t) => cols.map(([, pick]) => cell(pick(t))).join(';')),
    // Файл не должен молча обрываться: если строк больше предела, последняя строка об этом говорит.
    ...(total > items.length ? [cell(`Показаны первые ${items.length} из ${total} обращений. Уточните фильтры, чтобы выгрузить остальные.`)] : []),
  ];
  return BOM + lines.join('\r\n') + '\r\n';
}
