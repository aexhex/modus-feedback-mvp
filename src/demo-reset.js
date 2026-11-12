// Сброс демо-данных одной кнопкой: перед показом жюри база возвращается к исходному датасету.
// Доступно только в демо-режиме (DEMO_MODE=1; включается командами npm start и npm run reset).
import { rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { inTransaction } from './db.js';
import { seedIfEmpty } from './seed.js';
import { seedTemplates } from './templates.js';
import { escalateOverdue } from './escalation.js';
import { audit } from './audit.js';

export function resetDemo(db, uploadsDir, actorName, nowIso) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  // Удаляются только файлы вложений из базы — каталог может быть общим с другими данными.
  const files = db.prepare('SELECT stored_name FROM attachments').all().map((r) => basename(r.stored_name));
  // Внешние ключи нельзя переключить внутри транзакции, поэтому — до и после неё.
  // Очистка и повторное заполнение — одна транзакция: при ошибке база остаётся как была.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    inTransaction(db, () => {
      for (const table of tables) db.exec(`DELETE FROM "${table}"`);
      seedIfEmpty(db, nowIso, uploadsDir);
      seedTemplates(db);
      escalateOverdue(db, nowIso);
      audit(db, null, 'Демо-данные сброшены', `выполнил: ${actorName}`, nowIso);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  for (const file of files) rmSync(join(uploadsDir, file), { force: true });
}
