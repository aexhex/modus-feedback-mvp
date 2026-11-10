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

export async function openTicket(page, code) {
  await page.locator('tbody tr', { hasText: code }).click();
  await expect(page.locator('.t-head .t-code')).toHaveText(code);
}
