import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Mailpit, verifyLinkFrom } from '../lib/mailpit';
import { resetAdminPassword } from '../lib/staging';

// The current, link-based password reset, end to end. Phase 1 replaces the
// link with a one-time code; this test is rewritten in that same change.
//
// GoTrue sends at most one reset mail per account per minute, so two runs
// less than a minute apart fail at the "E-Mail versendet" step.

test.afterAll(() => resetAdminPassword());

test('forgot password: the mail arrives, its link opens the form, the new password signs in', async ({ page, browser }) => {
  const email = process.env.E2E_ADMIN_EMAIL!;
  const mailpit = Mailpit.fromEnv();
  await mailpit.clear(email);

  await page.goto('/auth/forgot-password');
  await page.locator('input[type="email"]').fill(email);
  await page.getByRole('button', { name: 'Link senden' }).click();
  await expect(page.getByText('E-Mail versendet')).toBeVisible();

  const mail = await mailpit.waitForMessage(email);
  expect(mail.subject).toContain('Passwort festlegen');
  const link = verifyLinkFrom(mail.html);
  expect(new URL(link).origin).toBe(new URL(process.env.E2E_API_URL!).origin);

  await page.goto(link);
  await expect(page).toHaveURL(/\/auth\/set-password/, { timeout: 30_000 });
  const newPassword = `E2e-${randomUUID()}`;
  const fields = page.locator('input[type="password"]');
  await fields.nth(0).fill(newPassword);
  await fields.nth(1).fill(newPassword);
  await page.getByRole('button', { name: 'Passwort speichern' }).click();
  await expect(page.getByText('Passwort gespeichert')).toBeVisible();

  // A separate browser context proves the new password itself, not the
  // session the link opened.
  const fresh = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
    locale: 'de-DE',
    httpCredentials: {
      username: process.env.E2E_STAGING_USER!,
      password: process.env.E2E_STAGING_PASS!,
      origin: new URL(process.env.E2E_BASE_URL!).origin,
    },
  });
  const second = await fresh.newPage();
  await second.goto('/login');
  await second.locator('input[type="email"]').fill(email);
  await second.locator('input[type="password"]').fill(newPassword);
  await second.locator('form button[type="submit"]').click();
  await expect(second).not.toHaveURL(/\/login/, { timeout: 30_000 });
  await fresh.close();
});
