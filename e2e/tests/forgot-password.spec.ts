import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Mailpit, codeFrom } from '../lib/mailpit';

// Password reset by one-time code, end to end: the code arrives without a link
// that carries a secret, a wrong code is refused with the attempts left, the
// right one opens the password form, and the new password signs in.
//
// ## The address is not the shared admin, and that is the point
//
// otp-request issues five codes per address per hour and answers 202 either
// way, so a sixth run in an hour used to see a successful-looking request, no
// mail, and a 45 s wait that read as a broken mailer. Global setup hands this
// test one of six seeded addresses instead (lib/resetAddress.ts has the
// measurements and the rotation's failure modes).
//
// Two things follow from owning the address rather than borrowing it. The test
// no longer puts the shared admin's password back afterwards — nothing else
// uses this account, so there is nothing to restore, and a failed run can no
// longer leave sign-in.spec.ts depending on a reset that did not happen. And
// the timeout stays the suite's 90 s: when the address is under its budget the
// mail takes 2.3 s, measured, so a longer budget would only have made the
// rate-limited runs fail more slowly.
//
// ## Why this stays one test
//
// The six phases share state that exists only inside a run — the code that
// arrived, the session it opened, the password it set — so as separate tests
// they would pass only in the order written, and with `fullyParallel: false`
// and one worker nothing would say so until someone reordered them. They are
// `test.step`s instead, which is the half of a split worth having: a failure
// names the phase it happened in, and the phases before it are in the report
// with the time each took.

test('forgot password: the code arrives, a wrong one is refused, the right one opens the form, the new password signs in', async ({ page, browser }) => {
  const email = process.env.E2E_RESET_EMAIL;
  if (!email) {
    throw new Error('E2E_RESET_EMAIL is unset — lib/global-setup.ts chooses it for each run.');
  }
  const mailpit = Mailpit.fromEnv();

  await test.step('empty the mailbox', () => mailpit.clear(email));

  await test.step('ask for a code', async () => {
    await page.goto('/auth/forgot-password');
    await page.locator('input[type="email"]').fill(email);
    await page.getByRole('button', { name: 'Code senden' }).click();
    // Room for ordinary latency to the shared VPS. The cold worker this used to
    // be blamed on is not what this covers: it answered 502 in ~130 ms and put an
    // error box on screen 0.45 s after the click, so the wait ran out every time.
    // lib/warmup.ts boots it in global setup instead.
    await expect(page.getByText('Falls ein Konto zu dieser Adresse existiert')).toBeVisible({ timeout: 20_000 });
  });

  const code = await test.step('read the code out of the mail', async () => {
    const mail = await mailpit.waitForMessage(email);
    expect(mail.subject).toContain('Passwort');
    expect(mail.subject).not.toMatch(/\d{6}/);
    expect(mail.html).not.toMatch(/token/i);
    return codeFrom(mail);
  });

  const firstBox = page.getByLabel('Ziffer 1 von 6');

  await test.step('a wrong code is refused, with the attempts left', async () => {
    await firstBox.click();
    await page.keyboard.type(code === '000000' ? '111111' : '000000');
    await expect(page.getByText('Noch 4 Versuche.')).toBeVisible({ timeout: 20_000 });
  });

  await test.step('the right code opens the password form', async () => {
    // The wrong code cleared the boxes; the sixth digit submits by itself.
    await firstBox.click();
    await page.keyboard.type(code);
    await expect(page).toHaveURL(/\/auth\/set-password/, { timeout: 30_000 });
  });

  const newPassword = `E2e-${randomUUID()}`;

  await test.step('the new password is saved', async () => {
    const fields = page.locator('input[type="password"]');
    await fields.nth(0).fill(newPassword);
    await fields.nth(1).fill(newPassword);
    await page.getByRole('button', { name: 'Passwort speichern' }).click();
    await expect(page.getByText('Passwort gespeichert')).toBeVisible();
  });

  await test.step('the new password signs in', async () => {
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
});
