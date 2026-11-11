import { test, expect } from '@playwright/test';
import { loginAs, openTicket } from './helpers.js';

test('переключатель темы есть на экране входа и на форме клиента', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.role-card')).toHaveCount(4);
  const before = await page.locator('html').getAttribute('data-theme');
  await page.getByRole('button', { name: 'Переключить светлую и тёмную тему' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', before);
  await page.goto('/#/client');
  await expect(page.getByRole('button', { name: 'Переключить светлую и тёмную тему' })).toBeVisible();
});

test('автор исправляет своё новое обращение', async ({ page }) => {
  await loginAs(page, 'Сотрудник закупок');
  await openTicket(page, 'A-020');
  await page.getByRole('button', { name: 'Исправить' }).click();
  await page.getByLabel('Кратко, о чём обращение').fill('Ежеквартальный обзор завершённых улучшений');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.locator('.t-head h1')).toHaveText('Ежеквартальный обзор завершённых улучшений');
  await expect(page.locator('.timeline')).toContainText('Исправлено автором');
});

test('реестр фильтруется по дате подачи', async ({ page }) => {
  await loginAs(page, 'Директор по развитию');
  await page.goto('/#/tickets?scope=all');
  await expect(page.locator('.count')).toHaveText(/Найдено: \d+/);
  await page.locator('.date-filter input[type=date]').first().fill('2026-11-05');
  await page.locator('.date-filter input[type=date]').first().dispatchEvent('change');
  await expect(page).toHaveURL(/from=2026-11-05/);
  await expect(page.locator('.count')).not.toHaveText('Найдено: 20');
});
