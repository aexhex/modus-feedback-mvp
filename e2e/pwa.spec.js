// Приложение на телефоне: манифест, сервис-воркер, работа без связи.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';

test('приложение устанавливается и открывается без связи', async ({ page, context }) => {
  await loginAs(page, 'Сотрудник офиса');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  // Сервис-воркер готов и управляет страницей (127.0.0.1 — безопасный контекст, как HTTPS).
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.locator('.user-chip b')).toHaveText('Сотрудник офиса');

  await context.setOffline(true);
  const banner = page.getByRole('status').filter({ hasText: 'Нет связи с сервером' });
  await expect(banner).toBeVisible();
  // Без связи интерфейс открывается из сохранённой копии, а не страницей ошибки браузера.
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await expect(banner).toBeVisible();

  await context.setOffline(false);
  await expect(banner).toBeHidden();
});
