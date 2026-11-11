// Обратная связь от клиентов: публичная форма без входа и сводка NPS для руководителя.
// Публичный вход — зона риска: строгая проверка полей, поле-ловушка от ботов, отдельный лимит запросов.
import { canSeeAnalytics } from './access.js';
import { LIMITS } from './config.js';
import { HttpError, badRequest, forbidden, notFound } from './http.js';

const LIST_LIMIT = 200;
const PROMOTER_MIN = 9;
const DETRACTOR_MAX = 6;

function optional(value, field, max) {
  const str = typeof value === 'string' ? value.trim() : '';
  if (str.length > max) throw badRequest(`Поле «${field}»: максимум ${max} символов`);
  return str || null;
}

/** @returns {boolean} сохранён ли отзыв (false — сработала ловушка для ботов) */
export function submitClientFeedback(db, input, now) {
  // Поле website скрыто от людей; его заполняют только автоматические отправители.
  if (typeof input.website === 'string' && input.website.trim() !== '') return false;
  // Только число: пустая строка или null иначе превратились бы в оценку 0.
  const { score } = input;
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 10) throw badRequest('Поставьте оценку от 0 до 10');
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (message.length < 5 || message.length > 2000) throw badRequest('Отзыв: от 5 до 2000 символов');
  // Общий суточный предел: рассылка с разных адресов не должна заполнить базу и исказить NPS.
  const dayAgo = new Date(new Date(now).getTime() - 24 * 3600 * 1000).toISOString();
  const { recent } = db.prepare('SELECT COUNT(*) AS recent FROM client_feedback WHERE created_at >= ?').get(dayAgo);
  if (recent >= LIMITS.clientFeedbackPerDay) throw new HttpError(429, 'Сегодня принято слишком много отзывов, попробуйте завтра');
  db.prepare(
    'INSERT INTO client_feedback (name, company, contact, score, message, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(optional(input.name, 'Имя', 100), optional(input.company, 'Компания', 150), optional(input.contact, 'Контакт', 150), score, message, now);
  return true;
}

function nps(scores) {
  if (scores.length === 0) return { value: null, promoters: 0, passives: 0, detractors: 0, count: 0 };
  const promoters = scores.filter((s) => s >= PROMOTER_MIN).length;
  const detractors = scores.filter((s) => s <= DETRACTOR_MAX).length;
  return {
    value: Math.round(((promoters - detractors) / scores.length) * 100),
    promoters, detractors, passives: scores.length - promoters - detractors, count: scores.length,
  };
}

export function listClientFeedback(db, user) {
  if (!canSeeAnalytics(user)) throw forbidden();
  const items = db
    .prepare(
      `SELECT id, name, company, contact, score, message, status, created_at AS createdAt
       FROM client_feedback ORDER BY id DESC LIMIT ?`,
    )
    .all(LIST_LIMIT);
  const scores = db.prepare('SELECT score FROM client_feedback').all().map((r) => r.score);
  return { items, nps: nps(scores) };
}

export function markClientFeedback(db, user, id, input) {
  if (!canSeeAnalytics(user)) throw forbidden();
  if (!['new', 'processed'].includes(input.status)) throw badRequest('Недопустимый статус');
  const { changes } = db.prepare('UPDATE client_feedback SET status = ? WHERE id = ?').run(input.status, Number(id));
  if (changes === 0) throw notFound('Отзыв не найден');
}
