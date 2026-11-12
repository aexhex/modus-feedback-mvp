// Цели показателей, карта повторяющихся проблем, база решений и шкала этапов (доработки по ТЗ 1.3 и 2.7).
import { test, expect } from '@playwright/test';
import { loginAs, openTicket } from './helpers.js';

test('аналитика: цели на плитках и карта повторяющихся проблем', async ({ page }) => {
  await loginAs(page, 'Директор по развитию');
  await page.goto('/#/analytics');
  const overdue = page.locator('.kpi', { hasText: 'Просрочено по SLA' });
  await expect(overdue.locator('.kpi-target')).toContainText('цель ≤ 0');
  await expect(overdue.locator('.kpi-target')).toContainText('ниже цели');

  const map = page.locator('.heatmap-card');
  await expect(map.getByRole('columnheader', { name: 'Отделов' })).toBeVisible();
  // Первая строка — категория, которая затрагивает больше всего подразделений.
  await expect(map.locator('tbody tr').first().locator('th')).toHaveText('Каталог и данные');
  const rows = await map.locator('tbody tr').count();
  await map.getByRole('button', { name: /Показать все категории/ }).click();
  expect(await map.locator('tbody tr').count()).toBeGreaterThan(rows);
});

test('администратор меняет цель — аналитика показывает «в цели»', async ({ page }) => {
  await loginAs(page, 'Администратор системы');
  await page.goto('/#/admin');
  const card = page.locator('section.card', { hasText: 'Цели показателей' });
  await card.getByLabel('Просрочено по SLA: цель, шт.').fill('50');
  await card.getByRole('button', { name: 'Сохранить цели' }).click();
  await expect(page.locator('.toast')).toContainText('Цели сохранены');
  await page.goto('/#/analytics');
  await expect(page.locator('.kpi', { hasText: 'Просрочено по SLA' }).locator('.kpi-target')).toContainText('в цели');
  // Вернуть цель, чтобы не влиять на другие проверки.
  await page.goto('/#/admin');
  await page.locator('section.card', { hasText: 'Цели показателей' }).getByLabel('Просрочено по SLA: цель, шт.').fill('0');
  await page.getByRole('button', { name: 'Сохранить цели' }).click();
  await expect(page.locator('.toast').last()).toContainText('Цели сохранены');
});

test('база решений: поиск и вкладки итогов', async ({ page }) => {
  await loginAs(page, 'Менеджер по продажам');
  await page.locator('.nav').getByRole('link', { name: 'База решений' }).click();
  await expect(page.getByRole('heading', { name: 'База решений' })).toBeVisible();
  await expect(page.locator('.solution', { hasText: 'A-004' })).toContainText('Что решили');

  await page.getByLabel('Поиск по базе решений').fill('семинар');
  await expect(page.locator('.solution')).toHaveCount(1);
  await expect(page.locator('.solution')).toContainText('A-004');
  await page.getByLabel('Поиск по базе решений').fill('');

  await page.getByRole('link', { name: 'Отклонено' }).click();
  await expect(page.locator('.solution').first()).toContainText('Почему отказали');
  await expect(page.locator('.solution.solution-implemented')).toHaveCount(0);
});

test('при подаче похожее решённое обращение показывает итог', async ({ page }) => {
  await loginAs(page, 'Менеджер по продажам');
  await page.goto('/#/new');
  await page.getByLabel('Кратко, о чём обращение').fill('Обучающие занятия по новым товарным линейкам для менеджеров');
  const solved = page.locator('.similar-item', { hasText: 'A-004' }).locator('.already-solved');
  await expect(solved).toContainText('Уже решено');
  await expect(solved).toContainText('семинар');
});

test('шкала этапов: просрочка, уточнение и отказ', async ({ page }) => {
  await loginAs(page, 'Директор по развитию');
  await openTicket(page, 'A-007');
  const current = page.locator('.stepper li[aria-current="step"]');
  await expect(current).toContainText('На рассмотрении');
  await expect(current).toContainText('просрочено');

  await openTicket(page, 'A-005');
  await expect(page.locator('.stepper li[aria-current="step"]')).toContainText('Ожидает уточнения');

  await openTicket(page, 'A-017');
  await expect(page.locator('.stepper .step-skipped')).toContainText('не потребовалось');
  await expect(page.locator('.stepper li').last()).toContainText('Отклонено');
  await expect(page.locator('.stepper li[aria-current="step"]')).toHaveCount(0);
});
