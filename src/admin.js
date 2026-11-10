// Администрирование: категории, правила маршрутизации, доступность ответственных.
import { badRequest, notFound } from './http.js';

const CATEGORY_SELECT = `
SELECT c.id, c.name, c.is_active AS isActive, c.assignee_id AS assigneeId, c.fallback_id AS fallbackId,
       a.name AS assigneeName, f.name AS fallbackName,
       (SELECT COUNT(*) FROM tickets t WHERE t.category_id = c.id) AS ticketsCount
FROM categories c
LEFT JOIN users a ON a.id = c.assignee_id
LEFT JOIN users f ON f.id = c.fallback_id`;

export function listCategories(db, { activeOnly = false } = {}) {
  const where = activeOnly ? 'WHERE c.is_active = 1' : '';
  return db
    .prepare(`${CATEGORY_SELECT} ${where} ORDER BY c.name`)
    .all()
    .map((c) => ({ ...c, isActive: Boolean(c.isActive) }));
}

export function listUsers(db) {
  return db
    .prepare('SELECT id, name, role, department, is_available AS isAvailable FROM users ORDER BY role, name')
    .all()
    .map((u) => ({ ...u, isAvailable: Boolean(u.isAvailable) }));
}

function validStaffId(db, value, field) {
  if (value === null || value === '' || value === undefined) return null;
  const user = db
    .prepare("SELECT id FROM users WHERE id = ? AND role IN ('handler','manager','admin')")
    .get(Number(value));
  if (!user) throw badRequest(`Поле «${field}»: выберите сотрудника с ролью обработчика`);
  return user.id;
}

function validName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 2 || name.length > 80) throw badRequest('Название категории: от 2 до 80 символов');
  return name;
}

export function createCategory(db, input) {
  const name = validName(input.name);
  if (db.prepare('SELECT 1 FROM categories WHERE name = ?').get(name)) {
    throw badRequest('Такая категория уже существует');
  }
  const { lastInsertRowid } = db
    .prepare('INSERT INTO categories (name, assignee_id, fallback_id) VALUES (?, ?, ?)')
    .run(name, validStaffId(db, input.assigneeId, 'Ответственный'), validStaffId(db, input.fallbackId, 'Резервный'));
  return Number(lastInsertRowid);
}

export function updateCategory(db, id, input) {
  const current = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(id));
  if (!current) throw notFound('Категория не найдена');
  const next = {
    name: input.name !== undefined ? validName(input.name) : current.name,
    isActive: input.isActive !== undefined ? (input.isActive ? 1 : 0) : current.is_active,
    assigneeId: input.assigneeId !== undefined ? validStaffId(db, input.assigneeId, 'Ответственный') : current.assignee_id,
    fallbackId: input.fallbackId !== undefined ? validStaffId(db, input.fallbackId, 'Резервный') : current.fallback_id,
  };
  db.prepare('UPDATE categories SET name = ?, is_active = ?, assignee_id = ?, fallback_id = ? WHERE id = ?')
    .run(next.name, next.isActive, next.assigneeId, next.fallbackId, current.id);
}

export function setAvailability(db, id, input) {
  if (typeof input.isAvailable !== 'boolean') throw badRequest('Ожидается isAvailable: true/false');
  const { changes } = db
    .prepare('UPDATE users SET is_available = ? WHERE id = ?')
    .run(input.isAvailable ? 1 : 0, Number(id));
  if (changes === 0) throw notFound('Пользователь не найден');
}
