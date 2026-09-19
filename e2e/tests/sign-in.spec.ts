import { test, expect } from '@playwright/test';

/**
 * One sign-in screen, for platform accounts and company users alike (the
 * owner's decision of 17.09.2026, reversing half of slice 3.6a).
 *
 * The three routing tests below need no account at all, which is the point: the
 * suite has **no** spec that signs in as a platform account, because staging has
 * no platform test account — one would need an `@example.com` address, a
 * `user_profiles` row and an `app_private.platform_staff` row created by an
 * owner through `platform-staff`, and the staging seed (`setup-staging.sh`)
 * creates neither. Until it does, what a platform account sees after signing in
 * is covered by `src/lib/adminGate.test.ts` and checked by hand.
 */

test('the E2E company admin signs in and reaches the company overview', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(process.env.E2E_ADMIN_EMAIL!);
  await page.locator('input[type="password"]').fill(process.env.E2E_ADMIN_PASSWORD!);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/overview/, { timeout: 30_000 });
  await expect(page.getByText('Firmenübersicht', { exact: true }).first()).toBeVisible();
});

test('the panel’s old front door /admin/login redirects to the one sign-in screen', async ({ page }) => {
  // Not deleted: a bookmark from 16.–17.09.2026 still lands somewhere that
  // signs people in, rather than on the marketing page or a dead route.
  await page.goto('/admin/login');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible();
});

test('a platform path asked for without a session lands on the sign-in screen, remembering it', async ({ page }) => {
  await page.goto('/admin/protokoll');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible();

  // The remembered path travels in the router's own location state, never in
  // the address bar, so there is nothing in the URL to assert — react-router
  // keeps it in the history entry under `usr`, which is also what lets it
  // survive the router swap that signing in performs. Reading it here is the
  // only way to see it without a platform account to sign in with.
  const remembered = await page.evaluate(
    () => (window.history.state as { usr?: { from?: string } } | null)?.usr?.from,
  );
  expect(remembered).toBe('/admin/protokoll');
});

test('the panel’s previous entry /super-admin answers the same way', async ({ page }) => {
  await page.goto('/super-admin/companies');
  await expect(page).toHaveURL(/\/login$/);

  // Rewritten onto /admin before it is remembered: there is one panel, and the
  // path it goes back to is the one the panel is actually registered at.
  const remembered = await page.evaluate(
    () => (window.history.state as { usr?: { from?: string } } | null)?.usr?.from,
  );
  expect(remembered).toBe('/admin/companies');
});
