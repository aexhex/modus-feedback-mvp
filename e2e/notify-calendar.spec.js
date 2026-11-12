// Отказ с причиной, контакты в карточке, письма-уведомления и производственный календарь — глазами пользователя.
import { test, expect } from '@playwright/test';
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
