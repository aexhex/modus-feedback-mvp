// Маршрутизация: основной ответственный категории → резервный → диспетчер (руководитель).

const REASONS = Object.freeze({
  rule: 'Назначен по правилу категории',
  fallback: 'Основной ответственный недоступен — назначен резервный',
  dispatcher: 'Нет доступного ответственного по категории — передано руководителю-диспетчеру',
  unassigned: 'Нет доступных ответственных — обращение ожидает ручного назначения',
});

function availableUser(db, userId) {
  if (!userId) return null;
  return db.prepare('SELECT id FROM users WHERE id = ? AND is_available = 1').get(userId) ?? null;
}

/**
 * @returns {{ userId: number|null, reason: string }}
 */
export function resolveAssignee(db, categoryId) {
  const category = db
    .prepare('SELECT assignee_id, fallback_id FROM categories WHERE id = ?')
    .get(categoryId);
  if (category) {
    if (availableUser(db, category.assignee_id)) {
      return { userId: category.assignee_id, reason: REASONS.rule };
    }
    if (availableUser(db, category.fallback_id)) {
      return { userId: category.fallback_id, reason: REASONS.fallback };
    }
  }
  const dispatcher = db
    .prepare("SELECT id FROM users WHERE role = 'manager' AND is_available = 1 ORDER BY id LIMIT 1")
    .get();
  if (dispatcher) return { userId: dispatcher.id, reason: REASONS.dispatcher };
  return { userId: null, reason: REASONS.unassigned };
}
