// Вход через Битрикс24 глазами сотрудника: кнопка на экране входа → страница входа портала → система.
// Файл идёт после zzz-integrations: вход возможен только для сотрудников, связанных с порталом.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';

test('сотрудник входит через Битрикс24 (демо-портал)', async ({ page, context }) => {
  // Связь с порталом появляется при загрузке оргструктуры — повторное применение ничего не меняет.
  await loginAs(page, 'Администратор системы');
  const applied = await page.evaluate(async () => (await fetch('/api/admin/integrations/b24/org-apply', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).status);
  expect(applied).toBe(200);
  await context.clearCookies();

  await page.goto('/');
  await page.getByRole('link', { name: 'Войти через Битрикс24' }).click();
  await expect(page.getByRole('heading', { name: 'Демо-портал Битрикс24' })).toBeVisible();
  await page.getByRole('link', { name: /Сотрудник офиса/ }).click();
  await expect(page.locator('.user-chip b')).toHaveText('Сотрудник офиса');
  expect(new URL(page.url()).search).toBe('');
});

test('ошибка входа через Битрикс24 объясняется на экране входа', async ({ page }) => {
  await page.goto('/?login_error=not_linked');
  await expect(page.getByRole('alert')).toContainText('не связана с сотрудником');
  // Параметр убирается из адреса: после обновления страницы сообщения нет.
  expect(new URL(page.url()).search).toBe('');
  await page.reload();
  await expect(page.getByRole('link', { name: 'Войти через Битрикс24' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
