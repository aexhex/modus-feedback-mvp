// Точка входа: node server.js  (переменные окружения: PORT, DB_PATH, UPLOADS_DIR, RESET=1)
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';

const root = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(process.env.DB_PATH ?? join(root, 'data', 'feedback.db'));
const dataDir = dirname(dbPath);
// Каталог вложений по умолчанию прежний; тестовые окружения задают свой через UPLOADS_DIR.
const uploadsDir = resolve(process.env.UPLOADS_DIR ?? join(root, 'data', 'uploads'));
const port = Number(process.env.PORT ?? 3000);

mkdirSync(dataDir, { recursive: true });
if (process.env.RESET === '1') {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, uploadsDir]) {
    rmSync(file, { recursive: true, force: true });
  }
}

const { server } = createApp({ dbPath, uploadsDir, publicDir: join(root, 'public') });
server.listen(port, () => {
  process.stdout.write(`Система обратной связи запущена: http://localhost:${port}\n`);
});
