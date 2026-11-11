// Политика доступа (RBAC + владение обращением).
//  employee — свои обращения;
//  handler  — свои + назначенные ему;
//  manager  — все обращения (контроль), переназначение;
//  admin    — всё + справочники и правила маршрутизации.

const isOversight = (user) => user.role === 'manager' || user.role === 'admin';

// Наблюдатель (приглашён в обсуждение или подписался) получает доступ на чтение и комментарии.
// Обращение, которое автор опубликовал в ленте идей, могут читать и комментировать все сотрудники.
export function canView(user, ticket, isWatcher = false) {
  if (isOversight(user)) return true;
  if (ticket.author_id === user.id || isWatcher || ticket.is_public) return true;
  return user.role === 'handler' && ticket.assignee_id === user.id;
}

export function canProcess(user, ticket) {
  if (isOversight(user)) return true;
  return user.role === 'handler' && ticket.assignee_id === user.id;
}

export const canReassign = (user) => isOversight(user);
export const canSeeAnalytics = (user) => isOversight(user);
export const canAdminister = (user) => user.role === 'admin';

// Автор анонимного обращения скрыт от всех, кроме него самого.
export function canSeeAuthor(user, ticket) {
  return !ticket.is_anonymous || ticket.author_id === user.id;
}

// SQL-условие видимости списка для роли пользователя.
export function listScope(user) {
  if (isOversight(user)) return { sql: '1=1', params: [] };
  if (user.role === 'handler') {
    return {
      sql: '(t.author_id = ? OR t.assignee_id = ? OR t.id IN (SELECT ticket_id FROM watchers WHERE user_id = ?))',
      params: [user.id, user.id, user.id],
    };
  }
  return { sql: 't.author_id = ?', params: [user.id] };
}
