// Иконки приложения для установки на телефон (PNG 192/512 и maskable 512) из знака логотипа «Модус Трейд» —
// того же, что в public/favicon.svg. Рисует Chromium из Playwright — без дополнительных зависимостей.
// Запуск: node scripts/make-icons.mjs → public/icons/*.png
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const OUT = resolve(import.meta.dirname, '..', 'public', 'icons');

// Знак логотипа в квадрате 100×100: разрезанное кольцо (#082742) и красный круг с бликом (#ED1111).
const MARK = `
  <path fill="#082742" d="M4.7 42A46 46 0 0 1 95.3 42H80A31 31 0 0 0 20 42Z"/>
  <path fill="#082742" d="M4.7 58A46 46 0 0 0 95.3 58H80A31 31 0 0 1 20 58Z"/>
  <circle cx="50" cy="50.5" r="17.5" fill="#ed1111"/>
  <circle cx="56.3" cy="44.6" r="5.4" fill="#fff"/>`;

// Обычная иконка — белая плашка со скруглёнными углами, как favicon. У maskable система сама обрезает края
// кругом или квадратом, поэтому фон на всю площадь, а знак — в безопасной зоне (60 % стороны).
const icon = ({ maskable }) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="100%">
  ${maskable ? '<rect width="100" height="100" fill="#fff"/>' : '<rect width="100" height="100" rx="22" fill="#fff"/>'}
  <g transform="${maskable ? 'translate(20 20) scale(.6)' : 'translate(9 9) scale(.82)'}">${MARK}</g>
</svg>`;

const ICONS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'maskable-512.png', size: 512, maskable: true },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const { file, size, maskable } of ICONS) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<body style="margin:0;background:transparent">${icon({ maskable })}</body>`);
    await page.screenshot({ path: join(OUT, file), omitBackground: true });
  }
} finally {
  await browser.close();
}
