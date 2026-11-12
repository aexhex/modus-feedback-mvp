import { test, expect } from '@playwright/test';
import { loginAs, openTicket } from './helpers.js';

test('главная руководителя: показатели, график с подсказкой', async ({ page }) => {
  await loginAs(page, 'Директор по развитию');
  await expect(page).toHaveURL(/#\/home/);
  await expect(page.locator('.kpi.alert').first()).toContainText('Просрочено по SLA');
  await expect(page.locator('figure.chart svg')).toBeVisible();
  await expect(page.locator('.ch-legend')).toContainText('Подано');

  await page.locator('.ch-hit').last().focus();
  await expect(page.locator('.ch-tooltip')).toBeVisible();
  await expect(page.locator('.ch-tooltip')).toContainText('Рассмотрено');
});

test('главная ответственного показывает его очередь', async ({ page }) => {
  await loginAs(page, 'IT-специалист');
  const waiting = page.locator('.card', { hasText: 'Ждут первого ответа' });
  await expect(waiting).toContainText('A-007');
  await expect(page.locator('.kpi', { hasText: 'В вашей очереди' }).locator('.kpi-value')).toHaveText('2');
});

test('доска задач: перемещение карточки, вопрос автору через диалог', async ({ page }) => {
  await loginAs(page, 'Ответственный за обучение');
  await page.locator('.nav').getByRole('link', { name: 'Канбан' }).click();
  await expect(page.locator('[data-status="new"] .kb-card')).toContainText('A-016');

  // «⋯» на карточке — перемещение без перетаскивания.
  const moveTo = async (status) => {
    await page.locator('.kb-card[data-code="A-016"] .kb-menu summary').click();
    await page.locator('.kb-card[data-code="A-016"] .kb-menu-list').getByRole('button', { name: status }).click();
  };
  await moveTo('На рассмотрении');
  await expect(page.locator('[data-status="in_review"] .kb-card', { hasText: 'A-016' })).toBeVisible();

  await moveTo('Ожидает уточнения');
  const dialog = page.locator('dialog');
  await expect(dialog).toContainText('A-016 → Ожидает уточнения');
  await dialog.locator('textarea').fill('Сколько человек планируется на пилотное занятие?');
  await dialog.getByRole('button', { name: 'Переместить' }).click();
  await expect(page.locator('[data-status="need_info"] .kb-card', { hasText: 'A-016' })).toBeVisible();
});

test('тёмная тема включается и сохраняется после перезагрузки', async ({ page }) => {
  await loginAs(page, 'Сотрудник офиса');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Переключить светлую и тёмную тему' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(11, 26, 43)');
});

test('черновик обращения восстанавливается и очищается', async ({ page }) => {
  await loginAs(page, 'Сотрудник проектирования');
  await page.goto('/#/new');
  const title = page.getByLabel('Кратко, о чём обращение');
  await title.fill('Черновик про шаблоны спецификаций');
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('draft:')))).toBe(true);

  await page.reload();
  await expect(page.locator('.callout', { hasText: 'Восстановлен несохранённый черновик' })).toBeVisible();
  await expect(title).toHaveValue('Черновик про шаблоны спецификаций');

  await page.getByRole('button', { name: 'Очистить' }).click();
  await expect(page.getByLabel('Кратко, о чём обращение')).toHaveValue('');
});

test('шаблон ответа и задача в Битрикс24 (демо-портал)', async ({ page }) => {
  await loginAs(page, 'Ответственный за договоры');
  await openTicket(page, 'A-009');
  await page.getByLabel('Шаблон ответа').selectOption({ label: 'Принято в работу' });
  await expect(page.getByPlaceholder('Комментарий для автора')).toHaveValue(/Спасибо за обращение/);

  await page.locator('.more-actions summary').click();
  await page.getByRole('button', { name: 'Создать задачу в Битрикс24' }).click();
  await expect(page.locator('.timeline')).toContainText('Задача отправлена в Битрикс24');
  await expect(page.getByRole('button', { name: 'Создать задачу в Битрикс24' })).toHaveCount(0);
});

test('администратор меняет сроки SLA — подсказка в форме обновляется', async ({ page }) => {
  await loginAs(page, 'Администратор системы');
  await page.getByRole('link', { name: 'Настройки' }).click();
  await page.getByLabel('Высокий: первый ответ').fill('2');
  await page.getByRole('button', { name: 'Сохранить сроки' }).click();
  await expect(page.locator('.toast-success')).toContainText('Сроки сохранены');

  await page.goto('/#/new');
  await expect(page.locator('form')).toContainText('высокий — 2');
});

test('канбан: четыре рабочие колонки в окне, завершённые — в свёрнутом блоке', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAs(page, 'Директор по развитию');
  await page.goto('/#/kanban');
  const active = page.locator('.kanban:not(.kanban-done) > .kb-col');
  await expect(active).toHaveCount(4);
  const layout = await page.evaluate(() => {
    const board = document.querySelector('.kanban').getBoundingClientRect();
    const heights = [...document.querySelectorAll('.kanban:not(.kanban-done) > .kb-col')].map((c) => Math.round(c.getBoundingClientRect().height));
    const done = document.querySelector('.kb-done > summary').getBoundingClientRect();
    return { right: board.right, heights, doneBottom: done.bottom, scrollsSideways: document.documentElement.scrollWidth > innerWidth };
  });
  expect(new Set(layout.heights).size).toBe(1);
  expect(layout.scrollsSideways).toBe(false);
  expect(layout.doneBottom).toBeLessThanOrEqual(900);

  // Отборы: поиск и «только просроченные» — без перезагрузки.
  await page.getByLabel('Поиск по канбану').fill('A-009');
  await expect(page.locator('.kb-card')).toHaveCount(1);
  await page.getByLabel('Поиск по канбану').fill('');
  await page.getByText('Только просроченные').click();
  for (const card of await page.locator('.kanban:not(.kanban-done) .kb-card').all()) await expect(card).toHaveClass(/overdue/);
  await page.getByText('Только просроченные').click();

  // Сверху колонки — просроченные.
  const firstNew = page.locator('[data-status="new"] .kb-card').first();
  await expect(firstNew).toHaveClass(/overdue/);

  // Завершённые открываются по щелчку.
  await page.locator('.kb-done > summary').click();
  await expect(page.locator('.kanban-done [data-status="implemented"] .kb-card').first()).toBeVisible();
});
