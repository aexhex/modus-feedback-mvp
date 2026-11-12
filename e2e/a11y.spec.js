import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs, openTicket } from './helpers.js';

// Автоматическая проверка доступности (WCAG 2.1 A/AA) ключевых экранов: ошибки уровня serious/critical недопустимы.
const PAGES = [
  ['вход', null, '/', '.role-card'],
  ['форма клиента', null, '/#/client', '.client-page form'],
  ['главная руководителя', 'Директор по развитию', '/#/home', 'figure.chart'],
  ['реестр', 'Директор по развитию', '/#/tickets?scope=all', 'tbody tr'],
  ['идеи коллег', 'Сотрудник офиса', '/#/tickets?scope=feed', 'tbody tr'],
  ['новое обращение', 'Сотрудник офиса', '/#/new', '.type-card'],
  ['канбан', 'Ответственный за обучение', '/#/kanban', '.kb-card'],
  ['аналитика', 'Директор по развитию', '/#/analytics', '.heatmap'],
  ['база решений', 'Сотрудник офиса', '/#/solutions', '.solution'],
  ['сводка недели', 'Директор по развитию', '/#/digest', '.digest-text'],
  ['настройки', 'Администратор системы', '/#/admin', '.users-table'],
];

async function serious(page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return result.violations
    .filter((v) => ['serious', 'critical'].includes(v.impact))
    .map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

for (const [name, user, url, ready] of PAGES) {
  test(`доступность: ${name}`, async ({ page }) => {
    if (user) await loginAs(page, user);
    await page.goto(url);
    await page.locator(ready).first().waitFor();
    expect(await serious(page)).toEqual([]);
  });
}

test('доступность: карточка обращения у ответственного', async ({ page }) => {
  await loginAs(page, 'Ответственный за номенклатуру');
  await openTicket(page, 'A-003');
  expect(await serious(page)).toEqual([]);
});

// /#/t/7 — A-007 с просроченным первым ответом: проверяется красная пометка на шкале этапов.
for (const [name, url, ready] of [
  ['главная', '/#/home', 'figure.chart'], ['карточка обращения', '/#/t/3', '.t-head'],
  ['аналитика', '/#/analytics', '.heatmap'], ['просроченное обращение', '/#/t/7', '.step-late'],
]) {
  test(`доступность в тёмной теме: ${name}`, async ({ page }) => {
    await loginAs(page, 'Директор по развитию');
    await page.evaluate(() => localStorage.setItem('theme', 'dark'));
    await page.goto(url);
    await page.reload();
    await page.locator(ready).first().waitFor();
    expect(await serious(page)).toEqual([]);
  });
}
