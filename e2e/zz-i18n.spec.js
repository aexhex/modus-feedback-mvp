// Смена языка интерфейса: русский, казахский, английский.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs } from './helpers.js';

// Язык включается после входа: помощник входа сверяет имя пользователя по-русски.
async function useEnglish(page) {
  await page.evaluate(() => localStorage.setItem('lang', 'en'));
  await page.reload();
}

test('переключатель на экране входа: английский и казахский, выбор запоминается', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.role-card[data-role="employee"] .role-card-name')).toHaveText('Employee');
  await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Қазақша' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'kk');
  await expect(page.locator('.role-card[data-role="manager"] .role-card-name')).toHaveText('Басшы');
  await page.reload();
  await expect(page.locator('.role-card[data-role="manager"] .role-card-name')).toHaveText('Басшы');

  await page.getByRole('button', { name: 'Русский' }).click();
  await expect(page.locator('.role-card[data-role="manager"] .role-card-name')).toHaveText('Руководитель');
});

test('английский интерфейс: меню, справочники и сообщения сервера', async ({ page }) => {
  await loginAs(page, 'Директор по развитию');
  await useEnglish(page);
  const nav = page.locator('.nav');
  await expect(nav.getByRole('link', { name: 'Solutions base' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Metrics' })).toBeVisible();
  await expect(page.locator('.user-chip b')).toHaveText('Development Director');

  // Ошибка проверки на сервере тоже показывается на выбранном языке.
  await page.goto('/#/report?from=2026-12-01&to=2026-11-01');
  await expect(page.locator('#content').getByText('The period starts after it ends')).toBeVisible();
});

test('доступность английского интерфейса: главная руководителя', async ({ page }) => {
  await loginAs(page, 'Директор по развитию');
  await useEnglish(page);
  await page.locator('figure.chart').waitFor();
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)).toEqual([]);
});
