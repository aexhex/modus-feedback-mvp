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

// Рабочая неделя считается по московскому времени: выходные и праздники в SLA не входят.
export const BUSINESS_TZ_OFFSET_HOURS = 3;
const DAY_MS = 24 * HOUR_MS;
const SATURDAY = 6;
const SUNDAY = 0;

// Нерабочие праздничные дни РФ, выпадающие на будни (с учётом переносов).
// 2026 — по производственному календарю; 2027 — ориентировочно, уточнить после выхода постановления.
export const HOLIDAYS = Object.freeze(new Set([
  '2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09',
  '2026-02-23', '2026-03-09', '2026-05-01', '2026-05-11', '2026-06-12', '2026-11-04', '2026-12-31',
  '2027-01-01', '2027-01-04', '2027-01-05', '2027-01-06', '2027-01-07', '2027-01-08',
  '2027-02-23', '2027-03-08', '2027-05-03', '2027-05-10', '2027-06-14', '2027-11-04',
]));

function isNonWorking(localMs, holidays) {
  const date = new Date(localMs);
  return [SATURDAY, SUNDAY].includes(date.getUTCDay()) || holidays.has(date.toISOString().slice(0, 10));
}

function skipWeekend(localMs, holidays) {
  let t = localMs;
  while (isNonWorking(t, holidays)) {
    t = Math.floor(t / DAY_MS) * DAY_MS + DAY_MS;
  }
  return t;
}

/**
 * Прибавляет рабочие часы (пн–пт, круглосуточно), пропуская выходные.
 * @param {string} isoDate
 * @param {number} hours
 * @param {Set<string>} [holidays] даты нерабочих дней в формате ГГГГ-ММ-ДД
 * @returns {string}
 */
export function addBusinessHours(isoDate, hours, holidays = HOLIDAYS) {
  const offset = BUSINESS_TZ_OFFSET_HOURS * HOUR_MS;
  let t = new Date(isoDate).getTime() + offset;
  let remaining = hours * HOUR_MS;
  while (remaining > 0) {
    t = skipWeekend(t, holidays);
    const endOfDay = Math.floor(t / DAY_MS) * DAY_MS + DAY_MS;
    const step = Math.min(remaining, endOfDay - t);
    t += step;
    remaining -= step;
  }
  return new Date(t - offset).toISOString();
}

export const SESSION_TTL_HOURS = 12;
// Повторное напоминание о неустранённой просрочке — раз в 2 рабочих дня.
export const ESCALATION_REMINDER_HOURS = 48;

// Заготовки ответов для обработчиков: comment — в комментарий, resolution — в результат.
export const REPLY_TEMPLATES = Object.freeze([
  { id: 'accepted', title: 'Принято в работу', field: 'comment', text: 'Спасибо за обращение. Приняли в работу, о результате сообщим здесь.' },
  { id: 'need-example', title: 'Нужен пример', field: 'comment', text: 'Чтобы разобраться, нужен конкретный пример: когда это произошло, с каким документом или задачей и к чему привело.' },
  { id: 'done', title: 'Реализовано', field: 'resolution', text: 'Предложение реализовано. Что сделано: ' },
  { id: 'no-resources', title: 'Отказ: нет ресурсов', field: 'resolution', text: 'Сейчас реализовать не можем: нет свободных ресурсов. Вернёмся к вопросу при следующем планировании.' },
  { id: 'already-exists', title: 'Отказ: уже есть решение', field: 'resolution', text: 'Такая возможность уже есть. Как ей воспользоваться: ' },
  { id: 'thanks', title: 'Благодарность передана', field: 'resolution', text: 'Спасибо за отзыв! Передали его коллегам.' },
]);
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
  // Изменений в минуту с одного пользователя (или адреса — для входа). Переопределяется
  // MUTATIONS_PER_MINUTE: сквозные тесты входят десятки раз в минуту с одного адреса.
  mutationsPerMinute: Number.parseInt(process.env.MUTATIONS_PER_MINUTE, 10) > 0 ? Number.parseInt(process.env.MUTATIONS_PER_MINUTE, 10) : 60,
  publicPostsPerMinute: 5,
  clientFeedbackPerDay: 300,
  rateLimiterKeysMax: 5000,
});

export const ALLOWED_EXTENSIONS = Object.freeze([
  '.pdf', '.png', '.jpg', '.jpeg', '.txt', '.docx', '.xlsx', '.csv',
]);

export const SESSION_COOKIE = 'fb_session';
