import { test, expect } from '@playwright/test';

test('the E2E company admin signs in and reaches the company overview', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(process.env.E2E_ADMIN_EMAIL!);
  await page.locator('input[type="password"]').fill(process.env.E2E_ADMIN_PASSWORD!);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/overview/, { timeout: 30_000 });
  await expect(page.getByText('Firmenübersicht', { exact: true }).first()).toBeVisible();
});
