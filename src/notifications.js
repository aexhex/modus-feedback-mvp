// Внутренние уведомления + ИМИТАЦИЯ отправки в Битрикс24: вместо реального вызова REST
// im.notify сообщение записывается в журнал outbox (виден администратору в «Настройках»).
// В промышленной версии запись в outbox заменяется HTTP-вызовом — см. docs/ARCHITECTURE.md.

const OUTBOX_LIMIT = 50;

export function notify(db, { userIds, ticketId, text, actorId, now }) {
  const unique = [...new Set(userIds.filter((id) => id && id !== actorId))];
  const insert = db.prepare(
    'INSERT INTO notifications (user_id, ticket_id, text, created_at) VALUES (?, ?, ?, ?)',
  );
  const toOutbox = db.prepare(
    "INSERT INTO outbox (channel, method, recipient, payload, created_at) VALUES ('bitrix24', 'im.notify', ?, ?, ?)",
  );
  const nameOf = db.prepare('SELECT name FROM users WHERE id = ?');
  // Журнал виден администратору, поэтому получатель-автор анонимного обращения в нём обезличен.
  const ticket = db.prepare('SELECT author_id, is_anonymous FROM tickets WHERE id = ?').get(ticketId);
  const hiddenAuthorId = ticket?.is_anonymous ? ticket.author_id : null;
  for (const userId of unique) {
    insert.run(userId, ticketId, text, now);
    const recipient = userId === hiddenAuthorId ? 'Автор (анонимно)' : (nameOf.get(userId)?.name ?? `user:${userId}`);
    toOutbox.run(recipient, JSON.stringify({ MESSAGE: text, LINK: `/#/t/${ticketId}` }), now);
  }
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

export function listOutbox(db) {
  return db
    .prepare('SELECT id, channel, method, recipient, payload, created_at AS createdAt FROM outbox ORDER BY id DESC LIMIT ?')
    .all(OUTBOX_LIMIT)
    .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}
