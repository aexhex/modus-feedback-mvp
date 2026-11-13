import { test } from '@playwright/test';
import { loginAs, openTicket } from './helpers.js';

const shot = (page, name) => page.screenshot({ path: `docs/screenshots/${name}.png` });
// Снимок отдельного блока: закреплённая шапка открепляется, иначе при прокрутке к блоку она закрывает его верх.
async function elShot(locator, name) {
  // Через свойство элемента: встроенный <style> запрещён политикой CSP.
  await locator.page().evaluate(() => { const bar = document.querySelector('.topbar'); if (bar) bar.style.position = 'static'; });
  await locator.screenshot({ path: `docs/screenshots/${name}.png` });
}

test('снимки экранов для README', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.locator('.role-card').first().waitFor();
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
  await page.locator('figure.chart svg').waitFor();
  await shot(page, '07-home');
  await page.goto('/#/kanban');
  await page.locator('.kb-card').first().waitFor();
  await shot(page, '08-kanban');
  await page.goto('/#/tickets?scope=all');
  await page.locator('tbody tr').first().waitFor();
  await shot(page, '04-registry');
  await page.goto('/#/analytics');
  await page.locator('.kpi').first().waitFor();
  await shot(page, '05-analytics');
  await page.goto('/#/board');
  await page.locator('.win').first().waitFor();
  await shot(page, '06-board');

  await page.goto('/#/tickets?scope=feed');
  await page.locator('tbody tr').first().waitFor();
  await shot(page, '11-feed');
  await page.goto('/#/report');
  await page.locator('.report-section').first().waitFor();
  await shot(page, '12-report');
  await page.goto('/#/surveys');
  await page.locator('.survey-card').first().waitFor();
  await page.locator('.survey-card', { hasText: 'Удобство внутренних процессов' }).getByRole('link', { name: 'Результаты' }).click();
  await page.locator('.kpi-value').first().waitFor();
  await shot(page, '13-survey-results');
  await page.goto('/#/clients');
  await page.locator('.client-item').first().waitFor();
  await shot(page, '14-clients');
  await page.goto('/#/client');
  await page.locator('.client-page form').waitFor();
  await shot(page, '15-client-form');

  await loginAs(page, 'Администратор системы');
  await page.goto('/#/admin');
  await page.locator('.users-table').waitFor();
  await page.locator('.users-table').scrollIntoViewIfNeeded();
  await shot(page, '16-admin-users');

  await loginAs(page, 'Директор по развитию');
  await page.goto('/#/home');
  await page.getByRole('button', { name: 'Переключить светлую и тёмную тему' }).click();
  await page.locator('figure.chart svg').waitFor();
  await shot(page, '09-home-dark');
  await page.goto('/#/kanban');
  await page.locator('.kb-card').first().waitFor();
  await shot(page, '26-kanban-dark');
  await page.goto('/#/analytics');
  await page.locator('.kpi').first().waitFor();
  await shot(page, '10-analytics-dark');
  await page.getByRole('button', { name: 'Переключить светлую и тёмную тему' }).click();

  // Карта повторяющихся проблем и база решений (доработки по ТЗ 1.3 и 2.7).
  await elShot(page.locator('.heatmap-card'), '18-problem-map');
  await loginAs(page, 'Сотрудник офиса');
  await page.goto('/#/solutions');
  await page.locator('.solution').first().waitFor();
  await shot(page, '17-solutions');

  // Интеграции: предпросмотр оргструктуры из Битрикс24 (демо-портал), затем клиент из 1С и задача.
  await loginAs(page, 'Администратор системы');
  await page.goto('/#/admin');
  const integrations = page.locator('section.card', { hasText: 'Интеграции с Битрикс24 и 1С УТ' });
  await integrations.getByRole('button', { name: 'Загрузить оргструктуру' }).click();
  await integrations.getByRole('region', { name: 'Изменения из Битрикс24' }).waitFor();
  await elShot(integrations, '19-integrations');
  await integrations.getByRole('button', { name: 'Применить изменения' }).click();
  await integrations.getByRole('button', { name: 'Загрузить контрагентов' }).click();
  await page.locator('.toast-success').last().waitFor();

  await loginAs(page, 'Ответственный за договоры');
  await openTicket(page, 'A-009');
  await page.locator('.more-actions summary').click();
  await page.getByRole('button', { name: 'Создать задачу в Битрикс24' }).click();
  await page.locator('.toast-success').last().waitFor();
  // После действия карточка перерисовывается и панель «Ещё действия» сворачивается.
  await page.locator('.more-actions').evaluate((d) => { d.open = true; });
  await page.getByRole('button', { name: 'Завершить задачу на демо-портале' }).click();
  await page.locator('.timeline', { hasText: 'подтвердите результат' }).waitFor();
  await page.locator('.toast').evaluateAll((toasts) => toasts.forEach((t) => t.remove()));
  await page.locator('.more-actions').evaluate((d) => { d.open = true; });
  const taskPanel = page.locator('.more-actions .stack', { hasText: 'Статус в Битрикс24' }).last();
  await taskPanel.scrollIntoViewIfNeeded();
  await elShot(page.locator('.more-actions'), '20-b24-task');

  // Вход через Битрикс24: страница входа демо-портала.
  await page.evaluate(() => fetch('/api/session', { method: 'DELETE' }));
  await page.goto('/');
  await page.getByRole('link', { name: 'Войти через Битрикс24' }).click();
  await page.getByRole('heading', { name: 'Демо-портал Битрикс24' }).waitFor();
  await shot(page, '21-b24-login');

  // Система внутри портала: пункт левого меню открывает её во фрейме под сотрудником портала.
  await page.goto('/demo-portal/b24/');
  await page.getByRole('link', { name: /Ответственный за договоры/ }).click();
  await page.getByRole('button', { name: 'Голос сотрудника' }).click();
  await page.frameLocator('iframe[name="app"]').locator('.user-chip b').waitFor();
  await shot(page, '22-portal-embed');

  // Ручное связывание: кого система не связала по ФИО (администратор).
  await loginAs(page, 'Администратор системы');
  await page.goto('/#/admin');
  await integrations.getByRole('button', { name: 'Загрузить оргструктуру' }).click();
  const manual = integrations.locator('.sync-group', { hasText: 'Не связаны автоматически' });
  await manual.waitFor();
  await elShot(manual, '23-manual-link');

  // Производственный календарь на год из источника.
  const calendar = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Производственный календарь', exact: true }) });
  await calendar.getByLabel('Год календаря').selectOption('2027');
  await calendar.getByRole('button', { name: 'Загрузить производственный календарь' }).click();
  await page.locator('.toast-success').last().waitFor();
  await page.locator('.toast').evaluateAll((toasts) => toasts.forEach((t) => t.remove()));
  await elShot(calendar, '24-calendar');

  // Письма-уведомления: демо-почта с письмами, отправленными по SMTP.
  await page.goto('/demo-portal/mail/');
  await page.locator('.demo-letter').first().waitFor();
  await shot(page, '25-mail');

  // Сроки: SLA, рабочие часы и часовой пояс компании и подразделений; хранение данных уволенных.
  await page.goto('/#/admin');
  const sla = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Сроки рассмотрения (SLA)' }) });
  await elShot(sla, '27-sla-timezone');
  const retention = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Хранение персональных данных' }) });
  await elShot(retention, '28-retention');

  // Мой профиль: контакты, письма и push-уведомления на этом устройстве.
  await loginAs(page, 'Сотрудник офиса');
  await page.goto('/#/profile');
  await page.getByRole('heading', { name: 'Мой профиль' }).waitFor();
  await shot(page, '29-profile');

  // Экран входа в тёмной теме.
  await page.evaluate(() => fetch('/api/session', { method: 'DELETE' }));
  await page.goto('/');
  await page.locator('.role-card').first().waitFor();
  await page.getByRole('button', { name: 'Переключить светлую и тёмную тему' }).click();
  await shot(page, '30-login-dark');
  await page.getByRole('button', { name: 'Переключить светлую и тёмную тему' }).click();
});
