// Сбор русских строк интерфейса для словарей перевода (казахский, английский).
// Шаблонные строки `Найдено: ${n}` превращаются в ключи с подстановками «Найдено: {1}».
// Запуск: npm run i18n:check — покажет строки, которых нет в словарях.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const CYRILLIC = /[А-Яа-яЁё]/;
// Содержимое и служебные данные, а не интерфейс: шаблоны ответов, текст рассылки, выгрузка CSV,
// стоп-слова поиска, демо-обращения и журнал запуска сервера.
const SERVER_SKIP = new Set(['seed.js', 'seed-data.js', 'templates.js', 'digest.js', 'export.js', 'similarity.js', 'app.js']);
// Имена объектов и полей 1С в запросах OData — не текст интерфейса.
const NOT_UI = new Set(['Catalog_Контрагенты', 'Ref_Key,Code,Description,ИНН,DeletionMark']);

function listJs(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'i18n' ? [] : listJs(path);
    return path.endsWith('.js') ? [path] : [];
  });
}

const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\(['"`\\])/g, '$1');

// Небольшой сканер строк JavaScript: обычные строки, шаблоны `…${…}…` и строки внутри подстановок
// (например, `${cond ? 'первый ответ' : 'решение'}`). Шаблон даёт ключ с {1}, {2}… по порядку.
function literals(source) {
  const found = [];
  let i = 0;
  const push = (s) => { if (CYRILLIC.test(s)) found.push(unescape(s)); };

  function readQuote(q) {
    let s = '';
    i += 1;
    while (i < source.length && source[i] !== q) {
      if (source[i] === '\\') {
        s += source.slice(i, i + 2);
        i += 2;
      } else {
        s += source[i];
        i += 1;
      }
    }
    i += 1;
    return s;
  }

  function readTemplate() {
    let key = '';
    let n = 0;
    i += 1;
    while (i < source.length && source[i] !== '`') {
      if (source[i] === '\\') {
        key += source.slice(i, i + 2);
        i += 2;
      } else if (source[i] === '$' && source[i + 1] === '{') {
        i += 2;
        readCode('}');
        n += 1;
        key += `{${n}}`;
      } else {
        key += source[i];
        i += 1;
      }
    }
    i += 1;
    return key;
  }

  function readCode(end) {
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (end && c === end && depth === 0) {
        i += 1;
        return;
      }
      if (c === "'" || c === '"') push(readQuote(c));
      else if (c === '`') push(readTemplate());
      else if (c === '/' && source[i + 1] === '/') i = source.indexOf('\n', i) < 0 ? source.length : source.indexOf('\n', i);
      else if (c === '/' && source[i + 1] === '*') i = source.indexOf('*/', i + 2) < 0 ? source.length : source.indexOf('*/', i + 2) + 2;
      else {
        if (c === '{') depth += 1;
        if (c === '}') depth -= 1;
        i += 1;
      }
    }
  }

  readCode(null);
  return found;
}

// Значения справочников из демо-данных: имена ролей-пользователей, подразделения, категории.
async function referenceData() {
  const { USERS, CATEGORIES } = await import(pathToFileURL(join(ROOT, 'src/seed-data.js')).href);
  // Сотрудники, которых синхронизация добавит из демо-портала Битрикс24.
  const { DEMO_HIRED } = await import(pathToFileURL(join(ROOT, 'src/integrations/demo-portal.js')).href);
  return [
    ...USERS.flatMap(([name, , department]) => [name, department]),
    ...DEMO_HIRED.flatMap(([name, department]) => [name, department]),
    ...CATEGORIES.map(([name]) => name),
  ];
}

/** @returns {Promise<string[]>} уникальные ключи для перевода */
export async function extractKeys() {
  const client = listJs(join(ROOT, 'public/js'));
  const serverDir = (dir, skip) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.js') && !skip.has(f)).map((f) => join(ROOT, dir, f));
  // Демо-портал — данные внешней системы (названия контрагентов), их не переводим.
  const server = [...serverDir('src', SERVER_SKIP), ...serverDir('src/integrations', new Set(['demo-portal.js']))];
  const keys = [...client, ...server].flatMap((file) => literals(readFileSync(file, 'utf8')));
  // В DOM пробелы по краям текста не участвуют в поиске перевода — ключи тоже без них.
  const normalized = [...keys, ...await referenceData()].map((k) => k.trim()).filter((k) => CYRILLIC.test(k) && !NOT_UI.has(k));
  return [...new Set(normalized)].sort((a, b) => a.localeCompare(b, 'ru'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const keys = await extractKeys();
  let missingTotal = 0;
  for (const lang of ['kk', 'en']) {
    const { default: dict } = await import(pathToFileURL(join(ROOT, `public/js/i18n/${lang}.js`)).href);
    const missing = keys.filter((k) => !(k in dict));
    missingTotal += missing.length;
    console.log(`${lang}: ${keys.length - missing.length}/${keys.length}`);
    if (process.argv.includes('--list')) missing.forEach((k) => console.log(`  ${JSON.stringify(k)}`));
  }
  process.exitCode = missingTotal > 0 ? 1 : 0;
}
