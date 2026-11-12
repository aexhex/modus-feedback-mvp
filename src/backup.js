// Резервное копирование: база (VACUUM INTO — целостный снимок без остановки сервера) и вложения.
// Каждая копия — отдельный каталог backup-ГГГГММДД-ЧЧММСС; хранятся последние keep копий.
// Автоматически — раз в сутки, если задан BACKUP_DIR; вручную — npm run backup.
import { mkdirSync, cpSync, readdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const BACKUP_NAME = /^backup-\d{8}-\d{6}$/;
export const DEFAULT_KEEP = 14;

/** @returns {{ dir: string, removed: number }} */
export function backup(db, { uploadsDir, backupDir, keep = DEFAULT_KEEP, nowIso }) {
  const stamp = nowIso.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dir = join(backupDir, `backup-${stamp}`);
  // Копия — только для владельца процесса: в ней все обращения и персональные данные.
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, 'feedback.db');
  db.prepare('VACUUM INTO ?').run(file);
  // Действующие сессии в копию не попадают: по украденной копии нельзя войти в систему.
  const copy = new DatabaseSync(file);
  try {
    copy.exec('DELETE FROM sessions; VACUUM');
  } finally {
    copy.close();
  }
  if (uploadsDir && existsSync(uploadsDir)) cpSync(uploadsDir, join(dir, 'uploads'), { recursive: true });
  const old = readdirSync(backupDir).filter((name) => BACKUP_NAME.test(name)).sort().slice(0, -keep);
  for (const name of old) rmSync(join(backupDir, name), { recursive: true, force: true });
  return { dir, removed: old.length };
}

export function backupKeep(value) {
  const keep = Number.parseInt(value, 10);
  return keep > 0 ? keep : DEFAULT_KEEP;
}
