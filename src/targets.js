// Целевые значения показателей (ТЗ, раздел 2.7: «целевые значения требуют отдельного определения»).
// Администратор задаёт цели, аналитика показывает «цель / факт». Хранятся в таблице settings.
import { badRequest } from './http.js';

const TARGETS_KEY = 'targets';

// dir: 'min' — показатель должен быть не меньше цели, 'max' — не больше.
export const TARGET_DEFS = Object.freeze([
  { key: 'reviewedShare', label: 'Получили первый ответ', unit: '%', dir: 'min', default: 90, limit: 100 },
  { key: 'avgFirstResponseHours', label: 'Среднее время до первого ответа', unit: 'ч', dir: 'max', default: 24, limit: 720 },
  { key: 'closedShare', label: 'Рассмотрено до итога', unit: '%', dir: 'min', default: 60, limit: 100 },
  { key: 'withResultShare', label: 'Итогов с зафиксированным результатом', unit: '%', dir: 'min', default: 95, limit: 100 },
  { key: 'implementedCount', label: 'Реализовано улучшений', unit: 'шт.', dir: 'min', default: 3, limit: 1000 },
  { key: 'overdueCount', label: 'Просрочено по SLA', unit: 'шт.', dir: 'max', default: 0, limit: 1000 },
]);

/** @returns {Record<string, number>} цель для каждого показателя; по умолчанию — из TARGET_DEFS */
export function getTargets(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(TARGETS_KEY);
  let stored = {};
  try {
    stored = row ? JSON.parse(row.value) ?? {} : {};
  } catch {
    stored = {}; // запись повреждена — используем цели по умолчанию
  }
  return Object.fromEntries(TARGET_DEFS.map((d) => [d.key, Number.isFinite(stored[d.key]) ? stored[d.key] : d.default]));
}

/** Цели с описанием — для формы администратора. */
export function listTargets(db) {
  const values = getTargets(db);
  return TARGET_DEFS.map(({ key, label, unit, dir, limit }) => ({ key, label, unit, dir, limit, value: values[key] }));
}

export function setTargets(db, input) {
  const next = Object.fromEntries(TARGET_DEFS.map((d) => {
    const value = Number(input?.[d.key]);
    if (input?.[d.key] === '' || input?.[d.key] === null || !Number.isFinite(value) || value < 0 || value > d.limit) {
      throw badRequest(`${d.label}: число от 0 до ${d.limit}`);
    }
    return [d.key, Math.round(value * 10) / 10];
  }));
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(TARGETS_KEY, JSON.stringify(next));
}

// Сравнение факта с целью: met = null, если факта ещё нет (например, ни одного ответа).
export function evaluateTargets(kpi, targets) {
  return Object.fromEntries(TARGET_DEFS.map((d) => {
    const actual = kpi[d.key];
    const target = targets[d.key];
    const met = actual === null || actual === undefined ? null : d.dir === 'min' ? actual >= target : actual <= target;
    return [d.key, { target, dir: d.dir, unit: d.unit, met }];
  }));
}
