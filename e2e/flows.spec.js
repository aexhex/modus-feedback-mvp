import { test, expect } from '@playwright/test';
import { loginAs, openTicket } from './helpers.js';

test('сотрудник видит похожее обращение и создаёт своё', async ({ page }) => {
  await loginAs(page, 'Сотрудник офиса');
  await page.getByRole('link', { name: '+ Новое обращение' }).first().click();
  await page.getByLabel('Категория').selectOption({ label: 'Хранение документов' });
  await page.getByLabel('Кратко, о чём обращение').fill('Не найти актуальную инструкцию в общих папках');
  await page.getByLabel('Описание').fill('В общих папках лежит несколько редакций инструкции, непонятно какая актуальная.');
  await expect(page.locator('.similar-item').first()).toContainText('A-019');

  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page.locator('.t-head .t-code')).toHaveText('A-021');
  await expect(page.locator('.t-head .badge').first()).toHaveText('Новое');
  await expect(page.locator('.facts')).toContainText('Администратор документов');
  await expect(page.locator('.timeline')).toContainText('Назначен по правилу категории');
});

test('уточнение: вопрос ответственного → ответ автора возвращает на рассмотрение', async ({ page }) => {
  await loginAs(page, 'Руководитель закупок');
  await openTicket(page, 'A-001');
  await page.getByLabel('Новый статус').selectOption({ label: 'Ожидает уточнения' });
  await page.getByPlaceholder('Комментарий для автора').fill('Приложите пример заявки.');
  await page.getByRole('button', { name: 'Применить' }).click();
  await expect(page.locator('.t-head .badge').first()).toHaveText('Ожидает уточнения');

  await loginAs(page, 'Сотрудник закупок');
  await openTicket(page, 'A-001');
  await expect(page.locator('.callout')).toContainText('ждёт уточнения');
  await page.getByPlaceholder('Ваш комментарий').fill('Пример: заявка на камеры для объекта.');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.locator('.t-head .badge').first()).toHaveText('На рассмотрении');
});

test('автор видит мотивированный отказ и оценивает результат', async ({ page }) => {
  await loginAs(page, 'Сотрудник офиса');
  await openTicket(page, 'A-017');
  await expect(page.locator('.resolution')).toContainText('Мотивированный отказ');
  await expect(page.locator('.resolution')).toContainText('нет подходящего помещения');
  await page.getByRole('button', { name: 'Нет, не решён' }).click();
  await expect(page.locator('.rating')).toContainText('Вопрос не решён');
});

test('руководитель: просроченные, фильтр в адресе, экспорт, аналитика', async ({ page }) => {
  await loginAs(page, 'Директор по развитию');
  await page.getByRole('link', { name: 'Все обращения' }).click();
  await page.getByLabel('Только просроченные').check();
  await expect(page.locator('tbody tr')).toHaveCount(4);
  await expect(page).toHaveURL(/overdue=1/);

  await page.reload();
  await expect(page.locator('tbody tr')).toHaveCount(4);
  await expect(page.getByLabel('Только просроченные')).toBeChecked();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Экспорт в Excel' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('obrashcheniya.csv');

  await page.getByRole('link', { name: 'Показатели' }).click();
  await expect(page.locator('.kpi.alert')).toContainText('Просрочено по SLA');
  await expect(page.locator('.kpi.alert .kpi-value')).toHaveText('4');
});

test('постраничный вывод реестра', async ({ page }) => {
  await loginAs(page, 'Директор по развитию');
  await page.getByRole('link', { name: 'Все обращения' }).click();
  await expect(page.locator('.pager')).toContainText('Страница 1 из 2');
  await page.getByRole('button', { name: 'Вперёд →' }).click();
  await expect(page.locator('.pager')).toContainText('Страница 2 из 2');
  await expect(page).toHaveURL(/page=2/);
});

test('сотруднику недоступны аналитика и настройки', async ({ page }) => {
  await loginAs(page, 'Сотрудник офиса');
  await expect(page.getByRole('link', { name: 'Показатели' })).toHaveCount(0);
  await page.goto('/#/analytics');
  await expect(page.locator('#content')).toContainText('нет доступа');
});

test('администратор видит журнал имитации Битрикс24', async ({ page }) => {
  await loginAs(page, 'Администратор системы');
  await page.getByRole('link', { name: 'Настройки' }).click();
  await expect(page.getByText('Уведомления в Битрикс24 — имитация')).toBeVisible();
  await expect(page.getByText('bitrix24 · im.notify').first()).toBeVisible();
});
