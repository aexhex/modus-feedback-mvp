// Точка входа: node server.js  (переменные окружения: PORT, DB_PATH, RESET=1)
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = join(root, 'data');
const dbPath = resolve(process.env.DB_PATH ?? join(dataDir, 'feedback.db'));
const uploadsDir = join(dataDir, 'uploads');
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
