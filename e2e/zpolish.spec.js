import { test, expect } from '@playwright/test';
import { loginAs, openTicket } from './helpers.js';

const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('вход в два шага; роль с одним пользователем входит сразу', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.role-card')).toHaveCount(4);
  await page.locator('.role-card[data-role="manager"]').click();
  await expect(page.locator('.user-chip b')).toHaveText('Директор по развитию');

  await page.getByRole('button', { name: 'Сменить роль' }).click();
  await page.locator('.role-card[data-role="employee"]').click();
  await expect(page.getByRole('heading', { name: 'Войти как: Сотрудник' })).toBeVisible();
  await page.locator('.user-card', { hasText: 'Сотрудник офиса' }).click();
  await expect(page.locator('.user-chip b')).toHaveText('Сотрудник офиса');
});

test('редкие действия в карточке свёрнуты', async ({ page }) => {
  await loginAs(page, 'Руководитель закупок');
  await openTicket(page, 'A-001');
  await expect(page.getByLabel('Новый статус')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Приоритет и SLA' })).toBeHidden();
  await page.locator('.more-actions summary').click();
  await expect(page.getByRole('heading', { name: 'Приоритет и SLA' })).toBeVisible();
});

test('голосование за идею из ленты', async ({ page }) => {
  await loginAs(page, 'Координатор проекта');
  await page.getByRole('link', { name: 'Идеи коллег' }).click();
  await expect(page.locator('.votes-banner')).toContainText('5 свободных голосов');
  await page.getByLabel('Сначала новые').selectOption({ label: 'Сначала популярные' });
  await expect(page).toHaveURL(/sort=votes/);
  await page.locator('tbody tr', { hasText: 'A-020' }).click();
  await expect(page.locator('.voting .kpi-value')).toHaveText('5');
  await page.getByRole('button', { name: 'Добавить голос' }).click();
  await expect(page.locator('.voting .kpi-value')).toHaveText('6');
  await expect(page.locator('.voting')).toContainText('свободно 4 из 5');
});

test('фото с камеры прикрепляется к новому обращению', async ({ page }) => {
  await loginAs(page, 'Сотрудник офиса');
  await page.goto('/#/new');
  await page.getByLabel('Категория').selectOption({ label: 'Корпоративная среда' });
  await page.getByLabel('Кратко, о чём обращение').fill('Протекает кровля над входом');
  await page.getByLabel('Описание').fill('После дождя у входа в офис капает с потолка, фото приложено.');
  await page.locator('.photo-btn input[type=file]').setInputFiles({ name: 'roof.png', mimeType: 'image/png', buffer: PIXEL_PNG });
  await expect(page.locator('.photo-thumb')).toHaveCount(1);
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page.locator('.attach')).toContainText(/photo-.*\.jpg/);
});

test('сводка недели: текст и рассылка (имитация)', async ({ page }) => {
  await loginAs(page, 'Директор по развитию');
  await page.locator('.nav').getByRole('link', { name: 'Сводка недели' }).click();
  await expect(page.getByLabel('Текст сводки')).toHaveValue(/^Сводка «Голос сотрудника»/);
  await page.getByRole('button', { name: 'Разослать руководителям (имитация)' }).click();
  await expect(page.locator('.toast-success').last()).toContainText('Сводка отправлена руководителям: 2');
});

test('импорт пользователей из CSV', async ({ page }) => {
  await loginAs(page, 'Администратор системы');
  await page.getByRole('link', { name: 'Настройки' }).click();
  const csv = 'Имя;Роль;Подразделение\nСервисный инженер;ответственный;Сервис\nКто-то;директор;Офис\n';
  await page.locator('.user-import input[type=file]').setInputFiles({ name: 'users.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.locator('.import-report')).toContainText('Строка 3: Кто-то — неизвестная роль');
  await page.getByRole('button', { name: 'Обновить список' }).click();
  await expect(page.locator('.users-table')).toContainText('Сервисный инженер');
});

test('на телефоне вход и подача без горизонтальной прокрутки', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await expect(page.locator('.role-card')).toHaveCount(4);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(await overflow()).toBe(false);
  await loginAs(page, 'Сотрудник офиса');
  await page.goto('/#/new');
  await expect(page.getByRole('button', { name: 'Отправить обращение' })).toBeVisible();
  expect(await overflow()).toBe(false);
});

// Последний тест: сброс возвращает исходные данные для следующего запуска.
test('сброс демо-данных возвращает исходный датасет', async ({ page }) => {
  await loginAs(page, 'Администратор системы');
  await page.getByRole('link', { name: 'Настройки' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Сбросить демо-данные' }).click();
  await expect(page.locator('.role-card')).toHaveCount(4);
  await loginAs(page, 'Директор по развитию');
  await page.goto('/#/tickets?scope=all');
  await expect(page.locator('.count')).toHaveText('Найдено: 20');
});
