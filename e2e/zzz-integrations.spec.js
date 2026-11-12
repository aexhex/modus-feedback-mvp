// Интеграции с Битрикс24 и 1С УТ через встроенный демо-портал (DEMO_MODE=1).
// Файл идёт последним: синхронизация оргструктуры меняет состав пользователей демо-датасета.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs } from './helpers.js';

const integrationsCard = (page) => page.locator('section.card', { hasText: 'Интеграции с Битрикс24 и 1С УТ' });

test('администратор загружает оргструктуру из Битрикс24: предпросмотр, затем применение', async ({ page }) => {
  await loginAs(page, 'Администратор системы');
  await page.goto('/#/admin');
  const card = integrationsCard(page);
  await expect(card.locator('.badge', { hasText: 'Демо-портал' })).toHaveCount(2);

  await card.getByRole('button', { name: 'Загрузить оргструктуру' }).click();
  const preview = card.getByRole('region', { name: 'Изменения из Битрикс24' });
  await expect(preview).toContainText('Новые сотрудники: 3');
  await expect(preview).toContainText('Координатор проекта: Проектный офис → Проектирование');
  await expect(preview).toContainText('Руководитель проекта');

  const axe = await new AxeBuilder({ page }).include('section.card').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)).toEqual([]);

  await preview.getByRole('button', { name: 'Применить изменения' }).click();
  await expect(page.locator('.toast-success').last()).toContainText('Оргструктура загружена: +3');
  await expect(integrationsCard(page)).toContainText('Сотрудников связано с порталом: 26');
  await expect(page.locator('.users-table')).toContainText('Инженер сервиса');
});

test('после связывания уведомления уходят на портал: журнал показывает «Отправлено»', async ({ page }) => {
  await loginAs(page, 'Директор по развитию');
  await page.goto('/#/digest');
  await page.getByRole('button', { name: 'Разослать руководителям в Битрикс24' }).click();
  await expect(page.locator('.toast-success').last()).toContainText('в Битрикс24');
  await loginAs(page, 'Администратор системы');
  await page.goto('/#/admin');
  const log = page.locator('section.card', { hasText: 'Журнал отправки в Битрикс24' });
  await expect(log.locator('.badge', { hasText: 'Отправлено' }).first()).toBeVisible();
});

test('клиенты из 1С УТ: загрузка справочника и выбор клиента в обращении', async ({ page }) => {
  await loginAs(page, 'Администратор системы');
  await page.goto('/#/admin');
  const card = integrationsCard(page);
  await card.getByRole('button', { name: 'Загрузить контрагентов' }).click();
  await expect(page.locator('.toast-success').last()).toContainText('Клиентов в справочнике: 7');
  await expect(card).toContainText('Authorization: Bearer demo-');

  await loginAs(page, 'Менеджер по продажам');
  await page.goto('/#/new');
  await page.getByLabel('Категория').selectOption({ label: 'Договорная работа' });
  await page.getByLabel('Кратко, о чём обращение').fill('Клиент ждёт подписанный договор больше недели');
  await page.getByLabel('Описание').fill('Договор с клиентом согласован, но подписанный экземпляр не отправлен уже больше недели.');
  await page.getByRole('combobox', { name: /^Клиент Необязательно/ }).selectOption({ label: 'ТОО «Альфа Монтаж» · 060140001234' });
  // Черновик сохраняет выбранного клиента и после перезагрузки страницы.
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.getByRole('combobox', { name: /^Клиент Необязательно/ })).toHaveValue(/\d+/);
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page.locator('.facts')).toContainText('Клиент (1С УТ)');
  await expect(page.locator('.facts')).toContainText('ТОО «Альфа Монтаж»');
});
