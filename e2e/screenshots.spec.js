import { test } from '@playwright/test';
import { loginAs, openTicket } from './helpers.js';

const shot = (page, name) => page.screenshot({ path: `docs/screenshots/${name}.png` });

test('снимки экранов для README', async ({ page }) => {
  await page.goto('/');
  await page.locator('.user-card').first().waitFor();
  await shot(page, '01-login');

  await loginAs(page, 'Сотрудник офиса');
  await page.goto('/#/new');
  await page.getByLabel('Категория').selectOption({ label: 'Хранение документов' });
  await page.getByLabel('Кратко, о чём обращение').fill('Не найти актуальную инструкцию в общих папках');
  await page.getByLabel('Описание').fill('В общих папках лежит несколько редакций инструкции, непонятно какая актуальная.');
  await page.locator('.similar-item').first().waitFor();
  await shot(page, '02-new-ticket');

  await loginAs(page, 'Ответственный за номенклатуру');
  await openTicket(page, 'A-003');
  await shot(page, '03-ticket');

  await loginAs(page, 'Директор по развитию');
  await page.locator('figure.chart svg').waitFor();
  await shot(page, '07-home');
  await page.goto('/#/kanban');
  await page.locator('.kb-card').first().waitFor();
  await shot(page, '08-kanban');
  await page.goto('/#/tickets?scope=all');
  await page.locator('tbody tr').first().waitFor();
  await shot(page, '04-registry');
  await page.goto('/#/analytics');
  await page.locator('.kpi').first().waitFor();
  await shot(page, '05-analytics');
  await page.goto('/#/board');
  await page.locator('.win').first().waitFor();
  await shot(page, '06-board');

  await page.goto('/#/tickets?scope=feed');
  await page.locator('tbody tr').first().waitFor();
  await shot(page, '11-feed');
  await page.goto('/#/report');
  await page.locator('.report-section').first().waitFor();
  await shot(page, '12-report');
  await page.goto('/#/surveys');
  await page.locator('.survey-card').first().waitFor();
  await page.locator('.survey-card', { hasText: 'Удобство внутренних процессов' }).getByRole('link', { name: 'Результаты' }).click();
  await page.locator('.kpi-value').first().waitFor();
  await shot(page, '13-survey-results');
  await page.goto('/#/clients');
  await page.locator('.client-item').first().waitFor();
  await shot(page, '14-clients');
  await page.goto('/#/client');
  await page.locator('.client-page form').waitFor();
  await shot(page, '15-client-form');

  await loginAs(page, 'Администратор системы');
  await page.goto('/#/admin');
  await page.locator('.users-table').waitFor();
  await page.locator('.users-table').scrollIntoViewIfNeeded();
  await shot(page, '16-admin-users');

  await loginAs(page, 'Директор по развитию');
  await page.goto('/#/home');
  await page.getByRole('button', { name: 'Переключить светлую и тёмную тему' }).click();
  await page.locator('figure.chart svg').waitFor();
  await shot(page, '09-home-dark');
  await page.goto('/#/analytics');
  await page.locator('.kpi').first().waitFor();
  await shot(page, '10-analytics-dark');
});
