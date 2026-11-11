import { test, expect, devices } from '@playwright/test';
import { loginAs } from './helpers.js';

// Эмуляция телефона Android (размер экрана, сенсорный ввод, мобильный браузер). Реальное устройство не заменяет.
test.use({ ...devices['Pixel 7'] });

const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('телефон: вход касанием и подача обращения с фото', async ({ page }) => {
  await page.goto('/');
  await page.locator('.role-card[data-role="employee"]').tap();
  await page.locator('.user-card', { hasText: 'Сотрудник офиса' }).tap();
  await expect(page.locator('.user-chip b')).toHaveText('Сотрудник офиса');

  await page.goto('/#/new');
  const camera = page.locator('.photo-btn input[type=file]');
  await expect(camera).toHaveAttribute('capture', 'environment');
  await expect(camera).toHaveAttribute('accept', 'image/*');
  await page.getByLabel('Категория').selectOption({ label: 'Корпоративная среда' });
  await page.getByLabel('Кратко, о чём обращение').fill('Не работает освещение на складе');
  await page.getByLabel('Описание').fill('Во втором ряду стеллажей не горят лампы, фото приложено.');
  await camera.setInputFiles({ name: 'IMG_0001.png', mimeType: 'image/png', buffer: PIXEL_PNG });
  await expect(page.locator('.photo-thumb')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.getByRole('button', { name: 'Отправить обращение' }).tap();
  await expect(page.locator('.attach')).toContainText(/photo-.*\.jpg/);
});

test('телефон: меню и карточка без горизонтальной прокрутки', async ({ page }) => {
  await loginAs(page, 'Ответственный за номенклатуру');
  for (const url of ['/#/home', '/#/tickets?scope=assigned', '/#/t/3', '/#/kanban']) {
    await page.goto(url);
    await page.locator('#content h1').first().waitFor();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(wide, url).toBe(false);
  }
});
