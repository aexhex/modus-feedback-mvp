// Резервная копия вручную: npm run backup  (переменные: DB_PATH, UPLOADS_DIR, BACKUP_DIR, BACKUP_KEEP).
// Сервер можно не останавливать: VACUUM INTO делает целостный снимок базы.
import { join, resolve } from 'node:path';
import { openDatabase } from '../src/db.js';
import { backup, backupKeep } from '../src/backup.js';

const root = resolve(import.meta.dirname, '..');
const dbPath = resolve(process.env.DB_PATH ?? join(root, 'data', 'feedback.db'));
const db = openDatabase(dbPath);
try {
  const result = backup(db, {
    uploadsDir: resolve(process.env.UPLOADS_DIR ?? join(root, 'data', 'uploads')),
    backupDir: resolve(process.env.BACKUP_DIR ?? join(root, 'data', 'backups')),
    keep: backupKeep(process.env.BACKUP_KEEP),
    nowIso: new Date().toISOString(),
  });
  process.stdout.write(`Резервная копия: ${result.dir}${result.removed ? ` (старых удалено: ${result.removed})` : ''}\n`);
} finally {
  db.close();
}
