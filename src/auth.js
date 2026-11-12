// Сессии. Открывает их вход через Битрикс24 (integrations/b24-sso.js) или, в демо-режиме и пока
// Битрикс24 не настроен, выбор пользователя из списка (см. docs/ARCHITECTURE.md).
import { randomBytes } from 'node:crypto';
import { SESSION_TTL_HOURS, SESSION_COOKIE, addHours } from './config.js';
import { notFound } from './http.js';

const expiryCutoff = (nowIso) => addHours(nowIso, -SESSION_TTL_HOURS);

export const SESSION_MAX_AGE_S = SESSION_TTL_HOURS * 3600;
// Даже при постоянной работе сессия открывается заново раз в неделю: украденный ключ не живёт вечно.
const SESSION_MAX_DAYS = 7;

/**
 * Cookie сессии. Обычно SameSite=Strict. Внутри портала Битрикс24 система открыта во фрейме чужого сайта,
 * и Strict-cookie браузер туда не передаст: по HTTPS ставится SameSite=None; Partitioned — браузер хранит её
 * отдельно, только для фрейма на портале. Изменяющие запросы принимают только JSON, поэтому чужой сайт
 * не может отправить их обычной формой.
 */
export function sessionCookie(token, maxAge, { secure = false, embedded = false } = {}) {
  const site = embedded && secure ? 'SameSite=None; Secure; Partitioned' : `SameSite=Strict${secure ? '; Secure' : ''}`;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; ${site}; Max-Age=${maxAge}`;
}

export function login(db, userId, now, { embedded = false } = {}) {
  const user = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(Number(userId));
  if (!user) throw notFound('Пользователь не найден');
  db.prepare('DELETE FROM sessions WHERE created_at < ?').run(expiryCutoff(now));
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at, embedded, issued_at) VALUES (?, ?, ?, ?, ?)').run(token, user.id, now, embedded ? 1 : 0, now);
  return token;
}

// Сессия действительна SESSION_TTL_HOURS часов — срок проверяется на сервере, а не только в cookie.
export function userByToken(db, token, nowIso) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return (
    db
      .prepare(
        `SELECT u.id, u.name, u.role, u.department, u.is_available AS isAvailable
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.created_at >= ? AND u.is_active = 1`,
      )
      .get(token, expiryCutoff(nowIso)) ?? null
  );
}

/** @returns {boolean} была ли сессия открыта внутри портала — чтобы удалить cookie с теми же атрибутами */
export function logout(db, token) {
  const row = db.prepare('DELETE FROM sessions WHERE token = ? RETURNING embedded').get(token);
  return row?.embedded === 1;
}

/**
 * Пока человек работает, сессия не обрывается: после половины срока отсчёт начинается заново.
 * @returns {{ embedded: boolean } | null} продлённая сессия — нужно обновить cookie
 */
export function renewSession(db, token, nowIso) {
  const row = db.prepare(`UPDATE sessions SET created_at = ? WHERE token = ? AND created_at < ?
      AND COALESCE(issued_at, created_at) > ? RETURNING embedded`)
    .get(nowIso, token, addHours(nowIso, -SESSION_TTL_HOURS / 2), addHours(nowIso, -24 * SESSION_MAX_DAYS));
  return row ? { embedded: row.embedded === 1 } : null;
}
