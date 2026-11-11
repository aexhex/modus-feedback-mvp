import { expect } from '@playwright/test';

// Вход для тестов — через API (сам экран входа проверяется отдельным тестом в zpolish.spec.js).
export async function loginAs(page, name) {
  await page.goto('/');
  await page.evaluate(async (wanted) => {
    const users = (await (await fetch('/api/demo-users')).json()).data.users;
    const user = users.find((u) => u.name === wanted);
    if (!user) throw new Error(`Нет демо-пользователя «${wanted}»`);
    await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: user.id }) });
  }, name);
  await page.goto('/#/home');
  await page.reload();
  await expect(page.locator('.user-chip b')).toHaveText(name);
}

// Открывает карточку по номеру: id берём через API от имени текущего пользователя (с учётом его прав).
export async function openTicket(page, code) {
  const id = await page.evaluate(async (q) => {
    const res = await fetch('/api/tickets?limit=1&q=' + encodeURIComponent(q));
    return (await res.json()).data[0]?.id ?? null;
  }, code);
  expect(id, 'обращение ' + code + ' доступно пользователю').not.toBeNull();
  await page.goto('/#/t/' + id);
  await expect(page.locator('.t-head .t-code')).toHaveText(code);
}
