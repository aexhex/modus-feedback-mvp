import { test, expect } from '@playwright/test';
import { loginAs, openTicket } from './helpers.js';

test('лента идей: чужое предложение можно прочитать и прокомментировать', async ({ page }) => {
  await loginAs(page, 'Сотрудник проектирования');
  await page.getByRole('link', { name: 'Лента идей' }).click();
  await expect(page.locator('h1')).toHaveText('Лента идей');
  await page.locator('tbody tr', { hasText: 'A-002' }).click();
  await expect(page.locator('.t-head')).toContainText('В ленте идей');
  await expect(page.getByText('Рассмотрение', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Убрать из ленты' })).toHaveCount(0);

  await page.getByPlaceholder('Ваш комментарий').fill('У нас в проектировании та же потребность.');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.locator('.timeline')).toContainText('та же потребность');
});

test('предложение по умолчанию публикуется в ленте, проблема — нет', async ({ page }) => {
  await loginAs(page, 'Сотрудник офиса');
  await page.goto('/#/new');
  const publish = page.getByLabel('Опубликовать в ленте идей');
  await expect(publish).not.toBeChecked();
  await page.locator('.type-card', { hasText: 'Предложение' }).click();
  await expect(publish).toBeChecked();
});

test('отчёт о внедрении появляется в карточке и на доске улучшений', async ({ page }) => {
  await loginAs(page, 'Ответственный за обучение');
  await openTicket(page, 'A-004');
  await page.getByLabel('Что сделано').fill('Провели два семинара по новым товарным линейкам.');
  await page.getByLabel('Эффект', { exact: true }).fill('Уточняющих вопросов от закупок стало заметно меньше.');
  await page.getByRole('button', { name: 'Опубликовать отчёт' }).click();
  await expect(page.locator('.resolution', { hasText: 'Отчёт о внедрении' })).toContainText('два семинара');

  await page.getByRole('link', { name: 'Доска улучшений' }).click();
  await expect(page.locator('.win', { hasText: 'A-004' })).toContainText('Эффект:');
  await expect(page.locator('.recognition')).toContainText('Автор месяца');
});

test('руководитель: нагрузка в аналитике и отчёт за период', async ({ page }) => {
  await loginAs(page, 'Директор по развитию');
  await page.getByRole('link', { name: 'Аналитика', exact: true }).click();
  await expect(page.locator('.card', { hasText: 'Нагрузка по ответственным' })).toContainText('IT-специалист');
  await expect(page.locator('.card', { hasText: 'Среднее время в статусе' })).toContainText('На рассмотрении');

  await page.getByRole('link', { name: 'Отчёт за период' }).click();
  await expect(page.locator('h1')).toHaveText('Отчёт за период');
  await expect(page.locator('.report-section', { hasText: 'Реализовано за период' })).toContainText('A-008');
  await expect(page.getByRole('button', { name: 'Печать / PDF' })).toBeVisible();
});

test('администратор: шаблон, пользователь, журнал действий', async ({ page }) => {
  await loginAs(page, 'Администратор системы');
  await page.getByRole('link', { name: 'Настройки' }).click();

  const templates = page.locator('.card', { hasText: 'Шаблоны ответов' });
  await templates.getByPlaceholder('Название').fill('Передано в сервис');
  await templates.getByPlaceholder('Текст ответа').fill('Передали вопрос в сервисную службу.');
  await templates.getByRole('button', { name: 'Добавить шаблон' }).click();
  await expect(page.locator('.toast-success').last()).toContainText('Шаблон добавлен');

  const users = page.locator('.card', { hasText: 'Пользователи и роли' });
  await users.getByPlaceholder('Имя или должность').fill('Инженер пусконаладки');
  await users.getByPlaceholder('Подразделение').fill('Сервис');
  await users.getByRole('button', { name: 'Добавить пользователя' }).click();
  await expect(page.locator('.users-table')).toContainText('Инженер пусконаладки');

  const audit = page.locator('.card', { hasText: 'Журнал действий администратора' });
  await expect(audit).toContainText('Пользователь создан');
  await expect(audit).toContainText('Шаблон ответа создан');
  await expect(page.getByLabel('Праздничные дни')).toHaveValue(/2026-11-04/);
});

test('опрос: руководитель создаёт, сотрудник проходит, результаты сводные', async ({ page }) => {
  await loginAs(page, 'Директор по развитию');
  await page.getByRole('link', { name: 'Опросы' }).click();
  await page.getByLabel('Название').fill('Оценка внутренних семинаров');
  await page.getByLabel('Вопросы с оценкой от 1 до 5').fill('Насколько полезны семинары?');
  await page.getByLabel('Открытые вопросы').fill('Какой темы не хватает?');
  await page.getByRole('button', { name: 'Опубликовать опрос' }).click();
  await expect(page.locator('.survey-card', { hasText: 'Оценка внутренних семинаров' })).toBeVisible();

  await page.locator('.survey-card', { hasText: 'Удобство внутренних процессов' }).getByRole('link', { name: 'Результаты' }).click();
  await expect(page.locator('#content')).toContainText('средняя оценка из 5');
  await expect(page.locator('#content')).toContainText('Ответили: 5');
  await page.goto('/#/surveys');
  await page.locator('.survey-card', { hasText: 'Оценка внутренних семинаров' }).getByRole('link', { name: 'Результаты' }).click();
  await expect(page.locator('#content')).toContainText('Результаты появятся после закрытия опроса');

  await loginAs(page, 'Сотрудник офиса');
  await page.locator('.home-survey').click();
  await page.locator('.survey-card', { hasText: 'Оценка внутренних семинаров' }).getByRole('link', { name: 'Пройти опрос' }).click();
  await page.locator('.scale-option', { hasText: '4' }).click();
  await page.getByRole('button', { name: 'Отправить ответы' }).click();
  await expect(page.locator('.survey-card', { hasText: 'Оценка внутренних семинаров' })).toContainText('Вы прошли этот опрос');
});

test('клиент оставляет отзыв без входа, руководитель видит его и NPS', async ({ page }) => {
  await page.goto('/#/client');
  await expect(page.locator('h1')).toHaveText('Оцените работу с нами');
  await page.locator('.scale-option', { hasText: '10' }).click();
  await page.getByLabel('Ваш отзыв').fill('Монтаж выполнили аккуратно и раньше срока.');
  await page.getByLabel('Компания').fill('ООО «Проверка»');
  await page.getByRole('button', { name: 'Отправить отзыв' }).click();
  await expect(page.getByText('Спасибо! Ваш отзыв получен.')).toBeVisible();

  await loginAs(page, 'Директор по развитию');
  await page.getByRole('link', { name: 'Отзывы клиентов' }).click();
  await expect(page.locator('.client-item').first()).toContainText('раньше срока');
  await expect(page.locator('.kpi', { hasText: 'NPS' }).first().locator('.kpi-value')).toHaveText('40');
  await page.locator('.client-item').first().getByRole('button', { name: 'Отметить разобранным' }).click();
  await expect(page.locator('.client-item').first()).toContainText('Разобран');
});
