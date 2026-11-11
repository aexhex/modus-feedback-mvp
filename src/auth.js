// Демо-аутентификация: выбор пользователя из списка. В промышленной версии — SSO
// через Битрикс24 OAuth / корпоративный каталог (см. docs/ARCHITECTURE.md).
import { randomBytes } from 'node:crypto';
import { SESSION_TTL_HOURS, addHours } from './config.js';
import { notFound } from './http.js';

const expiryCutoff = (nowIso) => addHours(nowIso, -SESSION_TTL_HOURS);

export function login(db, userId, now) {
  const user = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(Number(userId));
  if (!user) throw notFound('Пользователь не найден');
  db.prepare('DELETE FROM sessions WHERE created_at < ?').run(expiryCutoff(now));
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, user.id, now);
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

export function logout(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
