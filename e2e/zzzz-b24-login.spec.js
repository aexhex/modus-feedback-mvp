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

test('администратор вручную связывает того, кого система не связала по ФИО', async ({ page }) => {
  await loginAs(page, 'Администратор системы');
  await page.goto('/#/admin');
  const card = page.locator('section.card', { hasText: 'Интеграции с Битрикс24 и 1С УТ' });
  await card.getByRole('button', { name: 'Загрузить оргструктуру' }).click();
  const preview = card.getByRole('region', { name: 'Изменения из Битрикс24' });
  await expect(preview).toContainText('Не связаны автоматически: 1');
  await preview.locator('.manual-link').getByRole('button', { name: 'Связать' }).click();
  await expect(page.locator('.toast-success').last()).toContainText('связан с Битрикс24');
  await expect(preview).not.toContainText('Не связаны автоматически');
});

test('система открывается внутри демо-портала: пункт меню и вкладка задачи', async ({ page }) => {
  await page.goto('/demo-portal/b24/');
  await page.getByRole('link', { name: /Ответственный за договоры/ }).click();
  await page.getByRole('button', { name: 'Голос сотрудника' }).click();
  const app = page.frameLocator('iframe[name="app"]');
  await expect(app.locator('.user-chip b')).toHaveText('Ответственный за договоры');

  // Задача из A-009 создана в zzz-integrations; если её нет (порядок файлов), создаём здесь.
  if (await page.getByRole('button', { name: /вкладка «Обращение»/ }).count() === 0) {
    await loginAs(page, 'Ответственный за договоры');
    await page.evaluate(async () => {
      const t = (await (await fetch('/api/tickets?limit=1&q=A-009')).json()).data[0];
      await fetch(`/api/tickets/${t.id}/b24-task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    });
    await page.goto('/demo-portal/b24/');
    await page.getByRole('link', { name: /Ответственный за договоры/ }).click();
  }
  await page.getByRole('button', { name: /вкладка «Обращение»/ }).first().click();
  await expect(app.locator('.t-head .t-code')).toHaveText('A-009');
});
