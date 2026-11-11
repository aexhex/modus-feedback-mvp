// Снимки экранов для README: npm run screenshots → docs/screenshots/*.png
import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/screenshots.spec.js',
});
