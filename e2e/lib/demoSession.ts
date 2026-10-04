import { expect, type Page } from '@playwright/test';

/** The synthetic company's administrator. The password lives in e2e/.env.local only. */
export const DEMO_EMAIL = process.env.E2E_DEMO_EMAIL!;
export const DEMO_PASSWORD = process.env.E2E_DEMO_PASSWORD!;

export async function signInAsDemo(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('textbox', { name: /E-Mail|Email/i }).fill(DEMO_EMAIL);
  await page.locator('input[type="password"]').first().fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: /^(Anmelden|Sign in)$/i }).click();
  await page.waitForURL(/\/(overview|uebersicht)/, { timeout: 60_000 });
}

/**
 * The guard every writing spec calls before it touches anything: the account
 * button must read "Demo Administrator". It is a retrying assertion, because the
 * profile loads a moment after the redirect (a bare count() right after sign-in
 * reads 0), and it is not `innerText` on the body, which does not carry the
 * account at every viewport.
 */
export async function assertDemoAccount(page: Page): Promise<void> {
  await expect(
    page.getByRole('button', { name: /Demo Administrator/ }),
    'refusing to write: the signed-in account is not the DEMO Monatsplanung GmbH administrator',
  ).toHaveCount(1, { timeout: 30_000 });
}

/** "2.401,00 €" or "-1,00 €" (hyphen or true minus) to integer cents. */
export function euroTextToCents(text: string): number {
  const match = /([-−]?)\s*([\d.]+),(\d{2})\s*€/.exec(text);
  if (!match) throw new Error(`not a German euro amount: "${text}"`);
  const cents = Number(match[2].replace(/\./g, '')) * 100 + Number(match[3]);
  return match[1] ? -cents : cents;
}
