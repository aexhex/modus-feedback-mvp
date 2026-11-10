// Демо-аутентификация: выбор пользователя из списка. В промышленной версии — SSO
// через Битрикс24 OAuth / корпоративный каталог (см. docs/ARCHITECTURE.md).
import { randomBytes } from 'node:crypto';
import { notFound } from './http.js';

export function login(db, userId, now) {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(userId));
  if (!user) throw notFound('Пользователь не найден');
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, user.id, now);
  return token;
}

export function userByToken(db, token) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return (
    db
      .prepare(
        `SELECT u.id, u.name, u.role, u.department, u.is_available AS isAvailable
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
      )
      .get(token) ?? null
  );
}

export function logout(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
