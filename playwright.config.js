// Сквозные тесты интерфейса: поднимают отдельный сервер с чистой базой в data/e2e.
import { defineConfig } from '@playwright/test';

const PORT = 3210;

export default defineConfig({
  testDir: 'e2e',
  testIgnore: ['**/screenshots.spec.js', '**/demo-video.spec.js'],
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    locale: 'ru-RU',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node server.js',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), DB_PATH: 'data/e2e/feedback.db', UPLOADS_DIR: 'data/e2e/uploads', RESET: '1', DEMO_MODE: '1', MUTATIONS_PER_MINUTE: '1000' },
  },
});
