// Ядро перевода интерфейса без DOM: словарь «русский текст → перевод», шаблоны с {1}, {2}…
// Используется в браузере (i18n.js) и в серверных тестах.
const CYRILLIC = /[А-Яа-яЁё]/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Переводчик по словарю: возвращает перевод или null, если фразы нет. Пробелы по краям сохраняются. */
export function createTranslator(dict) {
  const exact = new Map();
  const patterns = [];
  for (const [key, value] of Object.entries(dict)) {
    if (/\{\d+\}/.test(key)) {
      const source = `^${escapeRe(key).replace(/\\\{(\d+)\\\}/g, '(.+?)')}$`;
      patterns.push({ re: new RegExp(source, 's'), order: [...key.matchAll(/\{(\d+)\}/g)].map((m) => m[1]), to: value, size: key.length });
    } else {
      exact.set(key, value);
    }
  }
  // Сначала более длинные шаблоны: «{1} · у кого так же: {2}» точнее, чем «{1} ч».
  patterns.sort((a, b) => b.size - a.size);

  // Точная фраза; для «высокий» подходит и «Высокий» из словаря — с той же строчной буквой в переводе.
  const lookup = (text) => {
    const direct = exact.get(text);
    if (direct !== undefined) return direct;
    const capital = exact.get(text.charAt(0).toUpperCase() + text.slice(1));
    return capital === undefined ? undefined : capital.charAt(0).toLowerCase() + capital.slice(1);
  };

  const byPattern = (text) => {
    for (const p of patterns) {
      const m = p.re.exec(text);
      if (!m) continue;
      const values = Object.fromEntries(p.order.map((n, i) => [n, m[i + 1]]));
      // Подставленные значения тоже переводятся, если это известная фраза (статус, категория).
      return p.to.replace(/\{(\d+)\}/g, (_, n) => {
        const v = values[n] ?? '';
        return translateCore(v.trim()) ?? v;
      });
    }
    return null;
  };

  const whole = (text) => lookup(text) ?? byPattern(text) ?? withNumber(text);
  // «Подано 4», «Закрыто: 1» — подпись с числом в конце.
  const withNumber = (text) => {
    const m = /^(.*?[А-Яа-яЁё].*?)(:?\s*[\d.,%]+)$/s.exec(text);
    const head = m && lookup(m[1].trim());
    return head ? `${head}${m[2]}` : null;
  };
  // Фраза, собранная из частей через «·», «—», «:» или запятую: «Обучение · Закупки».
  const SEPARATORS = /(\s·\s|^·\s|\s—\s|^—\s|:\s|,\s)/;
  const bySegments = (text) => {
    const parts = text.split(SEPARATORS);
    if (parts.length < 2) return null;
    let changed = false;
    const out = parts.map((part, i) => {
      if (i % 2 === 1 || !part.trim()) return part;
      const tr = whole(part.trim());
      if (tr === null) return part;
      changed = true;
      return part.replace(part.trim(), tr);
    });
    return changed ? out.join('') : null;
  };

  // function, а не const: шаблоны выше вызывают перевод подставленных значений рекурсивно.
  function translateCore(text) {
    return whole(text) ?? bySegments(text);
  }

  return (text) => {
    const trimmed = text.trim();
    if (!trimmed || !CYRILLIC.test(trimmed)) return null;
    const out = translateCore(trimmed);
    if (out === null) return null;
    const lead = text.slice(0, text.length - text.trimStart().length);
    const trail = text.slice(text.trimEnd().length);
    return `${lead}${out}${trail}`;
  };
}
