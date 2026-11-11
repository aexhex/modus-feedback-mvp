// Импорт пользователей из CSV (задел под выгрузку оргструктуры из 1С).
// Формат строки: имя;роль;подразделение. Разделитель «;» или «,», первая строка может быть заголовком.
// Корректные строки добавляются, ошибочные возвращаются со списком причин.
import { badRequest, HttpError } from './http.js';
import { inTransaction } from './db.js';
import { createUser } from './admin.js';

const MAX_ROWS = 500;
const MAX_CHARS = 60_000;

const ROLE_ALIASES = Object.freeze({
  сотрудник: 'employee', employee: 'employee',
  ответственный: 'handler', handler: 'handler',
  руководитель: 'manager', manager: 'manager',
  администратор: 'admin', admin: 'admin',
});

// Разбор строки CSV с учётом кавычек: "Иванов; мл." — одно поле, "" внутри кавычек — сама кавычка.
function splitLine(line, sep) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { cells.push(cell.trim()); cell = ''; } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function parse(csv) {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).map((line, i) => ({ line: i + 1, text: line })).filter((l) => l.text.trim());
  if (lines.length === 0) return [];
  const sep = lines[0].text.includes(';') ? ';' : ',';
  const rows = lines.map((l) => ({ line: l.line, cells: splitLine(l.text, sep) }));
  // Заголовок распознаётся по второй колонке: имя вроде «Имяров» не должно приниматься за заголовок.
  const isHeader = /^(роль|role)$/i.test(rows[0].cells[1] ?? '');
  return isHeader ? rows.slice(1) : rows;
}

/** @returns {{ created: string[], skipped: { line: number, name: string, reason: string }[] }} */
export function importUsers(db, input) {
  if (typeof input.csv !== 'string' || !input.csv.trim()) throw badRequest('Пустой файл');
  if (input.csv.length > MAX_CHARS) throw badRequest('Файл слишком большой');
  const rows = parse(input.csv);
  if (rows.length === 0) throw badRequest('В файле нет строк с пользователями');
  if (rows.length > MAX_ROWS) throw badRequest(`Не больше ${MAX_ROWS} пользователей за раз`);
  return inTransaction(db, () => {
    const created = [];
    const skipped = [];
    for (const { line, cells } of rows) {
      const [name = '', roleRaw = '', department = ''] = cells;
      const role = ROLE_ALIASES[roleRaw.toLowerCase()];
      if (!role) {
        skipped.push({ line, name, reason: `неизвестная роль «${roleRaw}»` });
        continue;
      }
      try {
        created.push(createUser(db, { name, role, department }).name);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        skipped.push({ line, name, reason: error.message });
      }
    }
    return { created, skipped };
  });
}
