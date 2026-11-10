import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('employee','handler','manager','admin')),
  department TEXT NOT NULL,
  is_available INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  assignee_id INTEGER REFERENCES users(id),
  fallback_id INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  proposed_solution TEXT,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  is_anonymous INTEGER NOT NULL DEFAULT 0,
  department TEXT NOT NULL,
  assignee_id INTEGER REFERENCES users(id),
  resolution TEXT,
  duplicate_of INTEGER REFERENCES tickets(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  first_response_due TEXT NOT NULL,
  due_at TEXT NOT NULL,
  first_response_at TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_author ON tickets(author_id);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  actor_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL,
  body TEXT,
  from_status TEXT,
  to_status TEXT,
  is_internal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON events(ticket_id);
CREATE TABLE IF NOT EXISTS supports (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, user_id)
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  ticket_id INTEGER REFERENCES tickets(id),
  text TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
`;

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

// Выполняет fn в транзакции; при ошибке откатывает изменения.
export function inTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
