import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Mailpit, codeFrom } from '../lib/mailpit';
import { resetAdminPassword } from '../lib/staging';

// Password reset by one-time code, end to end: the code arrives without a link
// that carries a secret, a wrong code is refused with the attempts left, the
// right one opens the password form, and the new password signs in.
//
// otp-request issues at most one code per address per minute, so a second run
// less than a minute after the first waits for a mail that never comes.

test.afterAll(() => resetAdminPassword());

test('forgot password: the code arrives, a wrong one is refused, the right one opens the form, the new password signs in', async ({ page, browser }) => {
  const email = process.env.E2E_ADMIN_EMAIL!;
  const mailpit = Mailpit.fromEnv();
  await mailpit.clear(email);

  await page.goto('/auth/forgot-password');
  await page.locator('input[type="email"]').fill(email);
  await page.getByRole('button', { name: 'Code senden' }).click();
  // The first call after a staging release boots a fresh otp-request isolate,
  // which took longer than the default 5 s right after PRs #29 and #30.
  await expect(page.getByText('Falls ein Konto zu dieser Adresse existiert')).toBeVisible({ timeout: 20_000 });

  const mail = await mailpit.waitForMessage(email);
  expect(mail.subject).toContain('Passwort');
  expect(mail.subject).not.toMatch(/\d{6}/);
  expect(mail.html).not.toMatch(/token/i);
  const code = codeFrom(mail);

  const firstBox = page.getByLabel('Ziffer 1 von 6');
  await firstBox.click();
  await page.keyboard.type(code === '000000' ? '111111' : '000000');
  await expect(page.getByText('Noch 4 Versuche.')).toBeVisible({ timeout: 20_000 });

  // The wrong code cleared the boxes; the sixth digit submits by itself.
  await firstBox.click();
  await page.keyboard.type(code);
  await expect(page).toHaveURL(/\/auth\/set-password/, { timeout: 30_000 });

  const newPassword = `E2e-${randomUUID()}`;
  const fields = page.locator('input[type="password"]');
  await fields.nth(0).fill(newPassword);
  await fields.nth(1).fill(newPassword);
  await page.getByRole('button', { name: 'Passwort speichern' }).click();
  await expect(page.getByText('Passwort gespeichert')).toBeVisible();

  // A separate browser context proves the new password itself, not the
  // session the code opened.
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
