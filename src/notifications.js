// Внутренние уведомления + копия в Битрикс24: каждое уведомление пишется в журнал outbox
// (виден администратору в «Настройках»), откуда его отправляет src/integrations/delivery.js.
// Без подключения к порталу запись остаётся в журнале как имитация.

const OUTBOX_LIMIT = 100;
const SUBJECT_MAX = 90;

export function notify(db, { userIds, ticketId, text, actorId, now }) {
  const unique = [...new Set(userIds.filter((id) => id && id !== actorId))];
  const insert = db.prepare(
    'INSERT INTO notifications (user_id, ticket_id, text, created_at) VALUES (?, ?, ?, ?)',
  );
  const toOutbox = db.prepare(
    "INSERT INTO outbox (channel, method, recipient, payload, user_id, ticket_id, created_at) VALUES ('bitrix24', 'im.notify', ?, ?, ?, ?, ?)",
  );
  const nameOf = db.prepare('SELECT name FROM users WHERE id = ?');
  // Письмо — только тем, у кого есть рабочая почта и кто не отключил письма. Адрес берётся при отправке.
  const wantsMail = db.prepare("SELECT 1 FROM users WHERE id = ? AND is_active = 1 AND email_notify = 1 AND COALESCE(email, '') != ''");
  // Push — только тем, кто включил уведомления хотя бы на одном устройстве. Подписки берутся при отправке.
  const hasPush = db.prepare('SELECT 1 FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.user_id = ? AND u.is_active = 1 LIMIT 1');
  const toPush = db.prepare(
    "INSERT INTO outbox (channel, method, recipient, payload, user_id, ticket_id, created_at) VALUES ('push', 'webpush', ?, ?, ?, ?, ?)",
  );
  const toMail = db.prepare(
    "INSERT INTO outbox (channel, method, recipient, payload, user_id, ticket_id, created_at) VALUES ('email', 'mail.send', ?, ?, ?, ?, ?)",
  );
  // Журнал виден администратору. У анонимного обращения скрыты все получатели, а не только автор:
  // если бы скрывалось одно имя, его можно было бы вычислить по разнице с остальными.
  const ticket = ticketId ? db.prepare('SELECT is_anonymous FROM tickets WHERE id = ?').get(ticketId) : null;
  const hideAll = Boolean(ticket?.is_anonymous);
  for (const userId of unique) {
    insert.run(userId, ticketId, text, now);
    const recipient = hideAll ? 'Получатель скрыт (анонимное обращение)' : (nameOf.get(userId)?.name ?? `user:${userId}`);
    const link = ticketId ? `/#/t/${ticketId}` : '/#/home';
    toOutbox.run(recipient, JSON.stringify({ MESSAGE: text, LINK: link }), userId, ticketId ?? null, now);
    if (hasPush.get(userId)) toPush.run(recipient, JSON.stringify({ MESSAGE: text, LINK: link }), userId, ticketId ?? null, now);
    if (wantsMail.get(userId)) {
      const subject = `Голос сотрудника: ${text.length > SUBJECT_MAX ? `${text.slice(0, SUBJECT_MAX - 1)}…` : text}`;
      toMail.run(recipient, JSON.stringify({ SUBJECT: subject, MESSAGE: text, LINK: link }), userId, ticketId ?? null, now);
    }
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
    .prepare(`SELECT id, channel, method, recipient, payload, status, attempts, error, external_id AS externalId,
                     sent_at AS sentAt, created_at AS createdAt
              FROM outbox ORDER BY id DESC LIMIT ?`)
    .all(OUTBOX_LIMIT)
    .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

// Запись произвольного вызова Битрикс24 в журнал отправки; возвращает номер записи.
// userId — получатель или ответственный в системе (по нему находится ID в Битрикс24).
export function logOutbox(db, { method, recipient, payload, userId = null, ticketId = null, now }) {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO outbox (channel, method, recipient, payload, user_id, ticket_id, created_at) VALUES ('bitrix24', ?, ?, ?, ?, ?, ?)")
    .run(method, recipient, JSON.stringify(payload), userId, ticketId, now);
  return Number(lastInsertRowid);
}
