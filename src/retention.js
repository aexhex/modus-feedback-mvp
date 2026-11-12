// Хранение персональных данных уволенных. Отключённый сотрудник через заданный срок обезличивается:
// имя заменяется на «Бывший сотрудник №…», рабочие контакты, связь с Битрикс24, сессии и подписки удаляются.
// Обращения, история и статистика остаются — без имени. Администратор может обезличить сразу (по просьбе
// человека). Обезличенного сотрудника нельзя снова включить: вернувшийся работник заводится заново.
import { badRequest, notFound } from './http.js';
import { inTransaction } from './db.js';

const RETENTION_KEY = 'retention_months';
export const RETENTION_OPTIONS = Object.freeze([6, 12, 24, 36]);
// Короткое имя (меньше 5 символов) не ищется в тексте журналов — иначе заменились бы части других слов.
const MIN_NAME_TO_SCRUB = 5;

/** @returns {number | null} срок хранения в месяцах; null — не обезличивать автоматически */
export function getRetention(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(RETENTION_KEY);
  const months = row ? Number(row.value) : null;
  return RETENTION_OPTIONS.includes(months) ? months : null;
}

export function setRetention(db, input) {
  const months = input.months === null || input.months === '' ? null : Number(input.months);
  if (months !== null && !RETENTION_OPTIONS.includes(months)) throw badRequest(`Срок хранения: ${RETENTION_OPTIONS.join(', ')} месяцев или не обезличивать`);
  if (months === null) db.prepare('DELETE FROM settings WHERE key = ?').run(RETENTION_KEY);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(RETENTION_KEY, String(months));
  return months;
}

const monthsBefore = (nowIso, months) => {
  const d = new Date(nowIso);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
};

/** Отключённые, срок хранения которых истёк (для сводки в «Настройках» и ежедневного прогона). */
export function dueForAnonymization(db, nowIso) {
  const months = getRetention(db);
  if (!months) return [];
  return db.prepare(`SELECT id FROM users WHERE is_active = 0 AND anonymized_at IS NULL
                     AND deactivated_at IS NOT NULL AND deactivated_at < ?`).all(monthsBefore(nowIso, months)).map((r) => r.id);
}

/** Обезличивает одного отключённого сотрудника. @returns {string} новое обозначение */
export function anonymizeUser(db, userId, nowIso) {
  const user = db.prepare('SELECT id, name, is_active, anonymized_at FROM users WHERE id = ?').get(Number(userId));
  if (!user) throw notFound('Пользователь не найден');
  if (user.anonymized_at) throw badRequest('Данные уже обезличены');
  if (user.is_active) throw badRequest('Сначала отключите доступ: обезличить можно только уволенного');
  const alias = `Бывший сотрудник №${user.id}`;
  inTransaction(db, () => {
    db.prepare(`UPDATE users SET name = ?, email = NULL, phone = NULL, position = NULL, b24_id = NULL, email_notify = 0,
                anonymized_at = ? WHERE id = ?`).run(alias, nowIso, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(user.id);
    // Имя, записанное текстом: журналы действий и отправки, уведомления, история обращений.
    if (user.name.length >= MIN_NAME_TO_SCRUB) {
      for (const [table, column] of [['audit_log', 'details'], ['outbox', 'recipient'], ['outbox', 'payload'], ['notifications', 'text'], ['events', 'body']]) {
        db.prepare(`UPDATE ${table} SET ${column} = REPLACE(${column}, ?, ?) WHERE ${column} LIKE ? ESCAPE '\\'`)
          .run(user.name, alias, `%${user.name.replace(/[%_\\]/g, '\\$&')}%`);
      }
    }
  });
  return alias;
}

/** Ежедневный прогон: обезличивает всех, чей срок истёк. @returns {number} сколько обезличено */
export function runRetention(db, nowIso) {
  const due = dueForAnonymization(db, nowIso);
  for (const id of due) anonymizeUser(db, id, nowIso);
  return due.length;
}
