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
CREATE TABLE IF NOT EXISTS escalations (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, kind)
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,
  method TEXT NOT NULL,
  recipient TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counterparties (
  id INTEGER PRIMARY KEY,
  ref_key TEXT NOT NULL UNIQUE,
  code TEXT,
  name TEXT NOT NULL,
  inn TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS b24_tasks (
  ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id),
  task_id TEXT NOT NULL,
  status TEXT,
  checked_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watchers (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, user_id)
);
CREATE TABLE IF NOT EXISTS impl_reports (
  ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id),
  done TEXT NOT NULL,
  effect TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reply_templates (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('comment','resolution')),
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS surveys (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  is_open INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS survey_questions (
  id INTEGER PRIMARY KEY,
  survey_id INTEGER NOT NULL REFERENCES surveys(id),
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('scale','text')),
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS survey_answers (
  question_id INTEGER NOT NULL REFERENCES survey_questions(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (question_id, user_id)
);
CREATE TABLE IF NOT EXISTS client_feedback (
  id INTEGER PRIMARY KEY,
  name TEXT,
  company TEXT,
  contact TEXT,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10),
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','processed')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idea_votes (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  count INTEGER NOT NULL CHECK (count BETWEEN 1 AND 3),
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, user_id)
);
CREATE TABLE IF NOT EXISTS feedback (
  ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id),
  is_resolved INTEGER NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL
);
`;

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // Миграция баз, созданных до появления повторных напоминаний об эскалации.
  ensureColumn(db, 'escalations', 'last_at', 'TEXT');
  ensureColumn(db, 'escalations', 'count', 'INTEGER NOT NULL DEFAULT 1');
  // Лента идей и управление пользователями появились позже первой версии схемы.
  ensureColumn(db, 'tickets', 'is_public', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  // Интеграции: связь с пользователем Битрикс24, доставка журнала отправки, клиент из 1С УТ.
  ensureColumn(db, 'users', 'b24_id', 'INTEGER');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_b24 ON users(b24_id) WHERE b24_id IS NOT NULL');
  ensureColumn(db, 'outbox', 'user_id', 'INTEGER');
  ensureColumn(db, 'outbox', 'ticket_id', 'INTEGER');
  // Записи, сделанные до появления доставки, — история: их не отправляем на портал задним числом.
  inTransaction(db, () => {
    if (ensureColumn(db, 'outbox', 'status', "TEXT NOT NULL DEFAULT 'pending'")) db.exec("UPDATE outbox SET status = 'simulated'");
  });
  ensureColumn(db, 'outbox', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'outbox', 'next_at', 'INTEGER');
  ensureColumn(db, 'outbox', 'error', 'TEXT');
  ensureColumn(db, 'outbox', 'external_id', 'TEXT');
  ensureColumn(db, 'outbox', 'sent_at', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status)');
  ensureColumn(db, 'tickets', 'counterparty_id', 'INTEGER REFERENCES counterparties(id)');
  return db;
}

// Имена таблицы и столбца задаются только из кода (не из пользовательского ввода).
function ensureColumn(db, table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return !exists;
}

// Выполняет fn в транзакции; при ошибке откатывает изменения.
// Вложенный вызов присоединяется к уже открытой транзакции (нужно сбросу демо-данных).
export function inTransaction(db, fn) {
  if (db.isTransaction) return fn();
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
