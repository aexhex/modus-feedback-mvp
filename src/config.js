// Справочники и бизнес-правила MVP. Значения условны и настраиваются здесь.

export const ROLES = Object.freeze({
  employee: 'Сотрудник',
  handler: 'Ответственный',
  manager: 'Руководитель',
  admin: 'Администратор',
});

export const TYPES = Object.freeze({
  problem: 'Проблема',
  idea: 'Предложение',
  praise: 'Положительный отзыв',
});

export const PRIORITIES = Object.freeze({
  high: 'Высокий',
  medium: 'Средний',
  low: 'Низкий',
});

export const STATUSES = Object.freeze({
  new: 'Новое',
  in_review: 'На рассмотрении',
  need_info: 'Ожидает уточнения',
  in_progress: 'В работе',
  implemented: 'Реализовано',
  rejected: 'Отклонено',
  closed: 'Закрыто',
});

// Допустимые переходы статусов (жизненный цикл обращения).
export const TRANSITIONS = Object.freeze({
  new: ['in_review', 'in_progress', 'need_info', 'rejected', 'closed'],
  in_review: ['in_progress', 'need_info', 'implemented', 'rejected', 'closed'],
  need_info: ['in_review', 'in_progress', 'rejected'],
  in_progress: ['need_info', 'implemented', 'rejected'],
  implemented: ['closed'],
  rejected: ['in_review', 'closed'],
  closed: [],
});

// Итоговые статусы: для них обязателен зафиксированный результат.
export const FINAL_STATUSES = Object.freeze(['implemented', 'rejected', 'closed']);

const HOUR_MS = 60 * 60 * 1000;

// SLA: срок первого ответа и срок решения в рабочих часах (24 ч = 1 рабочий день) по приоритету.
export const SLA_HOURS = Object.freeze({
  high: { firstResponse: 24, resolve: 7 * 24 },
  medium: { firstResponse: 72, resolve: 14 * 24 },
  low: { firstResponse: 120, resolve: 30 * 24 },
});

export function addHours(isoDate, hours) {
  return new Date(new Date(isoDate).getTime() + hours * HOUR_MS).toISOString();
}

// Рабочая неделя считается по московскому времени: суббота и воскресенье в SLA не входят.
export const BUSINESS_TZ_OFFSET_HOURS = 3;
const DAY_MS = 24 * HOUR_MS;
const SATURDAY = 6;
const SUNDAY = 0;

function skipWeekend(localMs) {
  let t = localMs;
  while ([SATURDAY, SUNDAY].includes(new Date(t).getUTCDay())) {
    t = Math.floor(t / DAY_MS) * DAY_MS + DAY_MS;
  }
  return t;
}

/**
 * Прибавляет рабочие часы (пн–пт, круглосуточно), пропуская выходные.
 * @param {string} isoDate
 * @param {number} hours
 * @returns {string}
 */
export function addBusinessHours(isoDate, hours) {
  const offset = BUSINESS_TZ_OFFSET_HOURS * HOUR_MS;
  let t = new Date(isoDate).getTime() + offset;
  let remaining = hours * HOUR_MS;
  while (remaining > 0) {
    t = skipWeekend(t);
    const endOfDay = Math.floor(t / DAY_MS) * DAY_MS + DAY_MS;
    const step = Math.min(remaining, endOfDay - t);
    t += step;
    remaining -= step;
  }
  return new Date(t - offset).toISOString();
}

export const SESSION_TTL_HOURS = 12;
export const ESCALATION_INTERVAL_MS = 60_000;
export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;

export const LIMITS = Object.freeze({
  jsonBodyBytes: 100 * 1024,
  uploadBodyBytes: 8 * 1024 * 1024,
  attachmentBytes: 5 * 1024 * 1024,
  titleMin: 5,
  titleMax: 150,
  descriptionMin: 10,
  descriptionMax: 5000,
  solutionMax: 3000,
  commentMax: 3000,
  exportMax: 5000,
  mutationsPerMinute: 60,
});

export const ALLOWED_EXTENSIONS = Object.freeze([
  '.pdf', '.png', '.jpg', '.jpeg', '.txt', '.docx', '.xlsx', '.csv',
]);

export const SESSION_COOKIE = 'fb_session';
