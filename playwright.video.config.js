// Запасная видеозапись пяти моментов защиты: npm run video → docs/demo/demo.webm
import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

const SIZE = { width: 1280, height: 720 };

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/demo-video.spec.js',
  timeout: 300_000,
  outputDir: 'data/video-run',
  use: { ...base.use, viewport: SIZE, video: { mode: 'on', size: SIZE }, launchOptions: { slowMo: 200 } },
});
