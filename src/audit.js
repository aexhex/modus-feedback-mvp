// Журнал действий администратора: кто, что и когда изменил в настройках системы.

const AUDIT_LIMIT = 100;

export function audit(db, actorId, action, details, now) {
  db.prepare('INSERT INTO audit_log (actor_id, action, details, created_at) VALUES (?, ?, ?, ?)')
    .run(actorId, action, details, now);
}

export function listAudit(db) {
  return db
    .prepare(
      `SELECT a.id, a.action, a.details, a.created_at AS createdAt, u.name AS actorName
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT ?`,
    )
    .all(AUDIT_LIMIT);
}
