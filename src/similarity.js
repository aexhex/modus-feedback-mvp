// Поиск похожих обращений: упрощённый стемминг (префикс слова) + коэффициент Жаккара.
// Достаточно для MVP; в развитии — полнотекстовый поиск или эмбеддинги.

const STEM_LENGTH = 5;
const MIN_WORD_LENGTH = 4;
const STOP_WORDS = new Set([
  'этот', 'чтобы', 'можно', 'нужно', 'нужен', 'нужна', 'было', 'быть', 'есть', 'если',
  'когда', 'также', 'тоже', 'более', 'очень', 'предлагаю', 'хотелось', 'иногда', 'всегда',
  'который', 'которые', 'такие', 'такой', 'между', 'после', 'через', 'полезно', 'будет',
]);

export function tokenize(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/u)
    .filter((w) => w.length >= MIN_WORD_LENGTH && !STOP_WORDS.has(w));
  return new Set(words.map((w) => w.slice(0, STEM_LENGTH)));
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / (a.size + b.size - common);
}

/**
 * @param {string} text
 * @param {Array<{id:number, title:string, description:string}>} candidates
 * @returns {Array<{id:number, score:number}>}
 */
export function findSimilar(text, candidates, { threshold = 0.1, limit = 5 } = {}) {
  const query = tokenize(text);
  return candidates
    .map((c) => ({ id: c.id, score: jaccard(query, tokenize(`${c.title} ${c.description}`)) }))
    .filter((r) => r.score >= threshold)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}
