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

// SLA: срок первого ответа и срок решения в часах по приоритету.
export const SLA_HOURS = Object.freeze({
  high: { firstResponse: 24, resolve: 7 * 24 },
  medium: { firstResponse: 72, resolve: 14 * 24 },
  low: { firstResponse: 120, resolve: 30 * 24 },
});

export function addHours(isoDate, hours) {
  return new Date(new Date(isoDate).getTime() + hours * HOUR_MS).toISOString();
}

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
  listMax: 500,
  mutationsPerMinute: 60,
});

export const ALLOWED_EXTENSIONS = Object.freeze([
  '.pdf', '.png', '.jpg', '.jpeg', '.txt', '.docx', '.xlsx', '.csv',
]);

export const SESSION_COOKIE = 'fb_session';
