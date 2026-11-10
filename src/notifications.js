// Внутренние уведомления. Точка расширения для Битрикс24 (im.notify) — см. docs/ARCHITECTURE.md.

export function notify(db, { userIds, ticketId, text, actorId, now }) {
  const unique = [...new Set(userIds.filter((id) => id && id !== actorId))];
  const insert = db.prepare(
    'INSERT INTO notifications (user_id, ticket_id, text, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const userId of unique) insert.run(userId, ticketId, text, now);
}

export function listNotifications(db, userId) {
  const items = db
    .prepare(
      `SELECT n.id, n.text, n.is_read, n.created_at, n.ticket_id, t.code AS ticket_code
       FROM notifications n LEFT JOIN tickets t ON t.id = n.ticket_id
       WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 50`,
    )
    .all(userId);
  const { unread } = db
    .prepare('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0')
    .get(userId);
  return { items, unread };
}

export function markAllRead(db, userId) {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(userId);
}
