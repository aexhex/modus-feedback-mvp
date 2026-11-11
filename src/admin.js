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

// По умолчанию — только действующие пользователи; администратору показываются и отключённые.
export function listUsers(db, { includeInactive = false } = {}) {
  return db
    .prepare(
      `SELECT id, name, role, department, is_available AS isAvailable, is_active AS isActive
       FROM users ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY role, name`,
    )
    .all()
    .map((u) => ({ ...u, isAvailable: Boolean(u.isAvailable), isActive: Boolean(u.isActive) }));
}

function validStaffId(db, value, field) {
  if (value === null || value === '' || value === undefined) return null;
  const user = db
    .prepare("SELECT id FROM users WHERE id = ? AND role IN ('handler','manager','admin') AND is_active = 1")
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

const USER_ROLES = ['employee', 'handler', 'manager', 'admin'];

function userText(value, field, max) {
  const str = typeof value === 'string' ? value.trim() : '';
  if (str.length < 2 || str.length > max) throw badRequest(`${field}: от 2 до ${max} символов`);
  return str;
}

function userRole(value) {
  if (!USER_ROLES.includes(value)) throw badRequest('Недопустимая роль');
  return value;
}

function flag(value, field) {
  if (typeof value !== 'boolean') throw badRequest(`Ожидается ${field}: true/false`);
  return value ? 1 : 0;
}

export function createUser(db, input) {
  const name = userText(input.name, 'Имя', 80);
  if (db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) throw badRequest('Пользователь с таким именем уже есть');
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (name, role, department) VALUES (?, ?, ?)')
    .run(name, userRole(input.role), userText(input.department, 'Подразделение', 80));
  return { id: Number(lastInsertRowid), name };
}

/** @returns {string} описание изменений для журнала действий */
export function updateUser(db, actor, id, input) {
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  if (!current) throw notFound('Пользователь не найден');
  const next = {
    name: input.name !== undefined ? userText(input.name, 'Имя', 80) : current.name,
    role: input.role !== undefined ? userRole(input.role) : current.role,
    department: input.department !== undefined ? userText(input.department, 'Подразделение', 80) : current.department,
    isAvailable: input.isAvailable !== undefined ? flag(input.isAvailable, 'isAvailable') : current.is_available,
    isActive: input.isActive !== undefined ? flag(input.isActive, 'isActive') : current.is_active,
  };
  if (current.id === actor.id) {
    if (!next.isAvailable || !next.isActive) throw badRequest('Нельзя отключить самого себя');
    if (next.role !== current.role) throw badRequest('Нельзя менять собственную роль');
  }
  if (next.name !== current.name && db.prepare('SELECT 1 FROM users WHERE name = ? AND id != ?').get(next.name, current.id)) {
    throw badRequest('Пользователь с таким именем уже есть');
  }
  // Сотрудник без роли обработчика и отключённый пользователь не могут стоять в правилах маршрутизации.
  if (next.role === 'employee' || !next.isActive) {
    const inRules = db.prepare('SELECT name FROM categories WHERE assignee_id = ? OR fallback_id = ? LIMIT 1').get(current.id, current.id);
    if (inRules) throw badRequest(`Сначала уберите пользователя из правил маршрутизации (категория «${inRules.name}»)`);
  }
  // Отключённый пользователь одновременно снимается с маршрутизации и теряет активные сессии.
  const available = next.isActive ? next.isAvailable : 0;
  db.prepare('UPDATE users SET name = ?, role = ?, department = ?, is_available = ?, is_active = ? WHERE id = ?')
    .run(next.name, next.role, next.department, available, next.isActive, current.id);
  if (!next.isActive) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(current.id);
  const changes = [
    next.name !== current.name && `имя: ${next.name}`,
    next.role !== current.role && `роль: ${next.role}`,
    next.department !== current.department && `подразделение: ${next.department}`,
    available !== current.is_available && (available ? 'на месте' : 'отсутствует'),
    next.isActive !== current.is_active && (next.isActive ? 'включён' : 'отключён'),
  ].filter(Boolean);
  return `${current.name} — ${changes.join(', ') || 'без изменений'}`;
}
