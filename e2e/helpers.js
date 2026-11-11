import { expect } from '@playwright/test';

// Демо-вход: при активной сессии сначала выходим, затем выбираем карточку пользователя.
export async function loginAs(page, name) {
  await page.goto('/');
  const switchRole = page.getByRole('button', { name: 'Сменить роль' });
  const userCards = page.locator('.user-card');
  await expect(switchRole.or(userCards.first())).toBeVisible();
  if (await switchRole.isVisible()) await switchRole.click();
  await userCards.filter({ has: page.getByText(name, { exact: true }) }).click();
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
