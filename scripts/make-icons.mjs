// Иконки приложения для установки на телефон (PNG 192/512 и maskable 512) из того же рисунка,
// что favicon.svg. Рисует Chromium из Playwright — без дополнительных зависимостей.
// Запуск: node scripts/make-icons.mjs → public/icons/*.png
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const OUT = resolve(import.meta.dirname, '..', 'public', 'icons');

// scale — размер пузыря относительно иконки. У maskable система обрезает края,
// поэтому фон на всю площадь, а рисунок помещается в безопасный круг (80 % стороны).
const bubble = (scale) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%">
  <rect width="32" height="32" fill="#1f4b99"/>
  <g transform="translate(16 16) scale(${scale}) translate(-16 -17)">
    <path d="M9 10h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7l-5 4v-4H9a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z" fill="#fff"/>
    <circle cx="12" cy="15.5" r="1.4" fill="#1f4b99"/>
    <circle cx="16" cy="15.5" r="1.4" fill="#1f4b99"/>
    <circle cx="20" cy="15.5" r="1.4" fill="#1f4b99"/>
  </g>
</svg>`;

const ICONS = [
  { file: 'icon-192.png', size: 192, scale: 1.25 },
  { file: 'icon-512.png', size: 512, scale: 1.25 },
  { file: 'maskable-512.png', size: 512, scale: 0.95 },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const { file, size, scale } of ICONS) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<body style="margin:0">${bubble(scale)}</body>`);
    await page.screenshot({ path: join(OUT, file) });
  }
} finally {
  await browser.close();
}
