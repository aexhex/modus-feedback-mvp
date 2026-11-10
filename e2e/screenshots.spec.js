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
  await page.locator('tbody tr').first().waitFor();
  await shot(page, '04-registry');
  await page.goto('/#/analytics');
  await page.locator('.kpi').first().waitFor();
  await shot(page, '05-analytics');
  await page.goto('/#/board');
  await page.locator('.win').first().waitFor();
  await shot(page, '06-board');
});
