// Отказ с причиной, контакты в карточке, письма-уведомления и производственный календарь — глазами пользователя.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs, openTicket } from './helpers.js';

test('«Отклонить с причиной»: статус выбран, курсор в поле причины, без причины не отклонить', async ({ page }) => {
  await loginAs(page, 'Ответственный за договоры');
  await openTicket(page, 'A-009');
  await page.getByRole('button', { name: 'Отклонить с причиной' }).click();
  await expect(page.getByLabel('Новый статус')).toHaveValue('rejected');
  const reason = page.getByPlaceholder('Почему отклонено — автор увидит эту причину');
  await expect(reason).toBeFocused();
  await reason.fill('');
  await page.getByRole('button', { name: 'Применить' }).click();
  await expect(page.locator('.toast-error').last()).toBeVisible();
});

test('карточка: у ответственного видны рабочая почта и телефон', async ({ page }) => {
  await loginAs(page, 'Менеджер по продажам');
  await openTicket(page, 'A-009');
  const contacts = page.locator('.facts .person-contacts').first();
  await expect(contacts.getByRole('link', { name: /@modus-demo\.example$/ })).toHaveAttribute('href', /^mailto:/);
  await expect(contacts.getByRole('link', { name: /^\+7/ })).toHaveAttribute('href', /^tel:\+7/);
});

test('письма: сотрудник видит адрес в колокольчике, письмо приходит в демо-почту', async ({ page }) => {
  await loginAs(page, 'Сотрудник закупок');
  await page.getByRole('button', { name: 'Уведомления' }).click();
  await expect(page.locator('.notif-mail')).toContainText('@modus-demo.example');
  await expect(page.locator('.notif-mail input')).toBeChecked();

  await loginAs(page, 'Руководитель закупок');
  await openTicket(page, 'A-001');
  await page.getByPlaceholder('Комментарий для автора').fill('Уточните, пожалуйста, модель оборудования');
  await page.getByLabel('Новый статус').selectOption('need_info');
  await page.getByRole('button', { name: 'Применить' }).click();
  await expect(page.locator('.toast-success').last()).toBeVisible();
  // Письмо автору (Сотрудник закупок — employee1) о смене статуса A-001.
  await expect.poll(async () => {
    const html = await (await page.request.get('/demo-portal/mail/')).text();
    return [...html.matchAll(/<li class="demo-letter">([\s\S]*?)<\/li>/g)]
      .some(([, letter]) => letter.includes('A-001') && letter.includes('employee1@modus-demo.example'));
  }).toBe(true);
});

test('производственный календарь загружается на год из источника', async ({ page }) => {
  await loginAs(page, 'Администратор системы');
  await page.goto('/#/admin');
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Производственный календарь', exact: true }) });
  await card.getByLabel('Год календаря').selectOption('2027');
  await card.getByLabel('Страна календаря').selectOption('ru');
  await card.getByRole('button', { name: 'Загрузить производственный календарь' }).click();
  await expect(page.locator('.toast-success').last()).toContainText('2027');
  await expect(card.getByLabel('Праздничные дни')).toHaveValue(/2027-01-04/);
});

test('мой профиль: щелчок по имени, сотрудник сам меняет телефон', async ({ page }) => {
  await loginAs(page, 'Сотрудник офиса');
  await page.locator('.user-chip').click();
  await expect(page.getByRole('heading', { name: 'Мой профиль' })).toBeVisible();
  await page.getByLabel('Рабочий телефон').fill('+7 (000) 777-00-11');
  await page.getByRole('button', { name: 'Сохранить контакты' }).click();
  await expect(page.locator('.toast-success').last()).toContainText('Контакты сохранены');
  await page.reload();
  await expect(page.getByLabel('Рабочий телефон')).toHaveValue('+7 (000) 777-00-11');
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)).toEqual([]);
});

test('рабочие часы включаются в настройках сроков', async ({ page }) => {
  await loginAs(page, 'Администратор системы');
  await page.goto('/#/admin');
  await page.getByText('Учитывать рабочие часы').click();
  await page.getByLabel('Начало рабочего дня').selectOption('9');
  await page.getByLabel('Конец рабочего дня').selectOption('18');
  await page.getByRole('button', { name: 'Сохранить часы' }).click();
  await expect(page.locator('.toast-success').last()).toContainText('Рабочие часы сохранены');
  await expect(page.getByLabel('Начало рабочего дня')).toBeEnabled();
  // Вернуть как было: другие тесты считают сроки сутками.
  await page.getByText('Учитывать рабочие часы').click();
  await page.getByRole('button', { name: 'Сохранить часы' }).click();
  await expect(page.locator('.toast-success').last()).toContainText('Рабочие часы сохранены');
});

test('профиль: блок push-уведомлений показывает состояние этого устройства', async ({ page }) => {
  await loginAs(page, 'Сотрудник офиса');
  await page.goto('/#/profile');
  await expect(page.getByRole('heading', { name: 'Push-уведомления' })).toBeVisible();
  // 127.0.0.1 — безопасный адрес, Chromium поддерживает Push API: устройство ещё не подписано.
  await expect(page.getByText('Выключены на этом устройстве.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Включить на этом устройстве' })).toBeVisible();
});

test('часовой пояс подразделения задаётся в настройках сроков', async ({ page }) => {
  await loginAs(page, 'Администратор системы');
  await page.goto('/#/admin');
  await page.locator('.dept-tz > summary').click();
  await page.getByLabel('Часовой пояс: Бухгалтерия').selectOption('3');
  await page.getByRole('button', { name: 'Сохранить пояс' }).click();
  await expect(page.locator('.toast-success').last()).toContainText('Часовой пояс сохранён');
  await expect(page.locator('.dept-tz > summary')).toContainText('Подразделения в другом поясе: 1');
  // Вернуть как было.
  await page.getByLabel('Часовой пояс: Бухгалтерия').selectOption('');
  await page.getByRole('button', { name: 'Сохранить пояс' }).click();
  await expect(page.locator('.dept-tz > summary')).toContainText('Подразделения в другом поясе: 0');
});

test('хранение персональных данных: срок задаётся, уволенного можно обезличить', async ({ page }) => {
  await loginAs(page, 'Администратор системы');
  await page.goto('/#/admin');
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Хранение персональных данных', exact: true }) });
  await card.getByLabel('Срок хранения данных уволенных').selectOption('12');
  await card.getByRole('button', { name: 'Сохранить срок' }).click();
  await expect(page.locator('.toast-success').last()).toContainText('Срок хранения сохранён');
  await expect(card.getByLabel('Срок хранения данных уволенных')).toHaveValue('12');
  // Отдельный временный сотрудник: демо-сотрудников не трогаем, на них опираются другие тесты.
  await page.evaluate(() => fetch('/api/admin/users', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Временный сотрудник', role: 'employee', department: 'Склад' }),
  }));
  await page.reload();
  // Отключить и обезличить — по его просьбе.
  await page.getByLabel('Доступ: Временный сотрудник').uncheck();
  await expect(page.locator('.toast-success').last()).toContainText('доступ отключён');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Обезличить: Временный сотрудник' }).click();
  await expect(page.locator('.toast-success').last()).toContainText('Персональные данные обезличены');
  await expect(page.locator('.users-table')).toContainText('Бывший сотрудник №');
  await expect(page.locator('.users-table')).not.toContainText('Временный сотрудник');
  // Вернуть срок как было.
  await card.getByLabel('Срок хранения данных уволенных').selectOption('');
  await card.getByRole('button', { name: 'Сохранить срок' }).click();
});
