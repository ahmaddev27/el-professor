/**
 * The Fahrtenanalyse's Rückkehrpflicht tab, walked on staging: it opens, it
 * says it is a list to review rather than a verdict, it calls nothing a
 * violation, and opening it writes nothing.
 *
 * Saving the Betriebssitz is not exercised here: it would change the demo
 * company's settings for everyone who uses the fixture. The save is covered
 * by the kit (`tests/rls/trip-analysis-settings.sql`, the five `base:` probes)
 * and by the panel's render test.
 *
 * Runs against the synthetic DEMO Monatsplanung GmbH. No real customer's data.
 */
import { test, expect, type Page } from '@playwright/test';

const EMAIL = process.env.E2E_DEMO_EMAIL!;
const PASSWORD = process.env.E2E_DEMO_PASSWORD!;

test.skip(!EMAIL || !PASSWORD, 'E2E_DEMO_EMAIL / E2E_DEMO_PASSWORD are not set; the demo credentials are never in the repo.');

/** RPCs that only read, which the shell may call while the page is open. */
const READ_RPCS = ['get_app_config', 'get_public_config', 'platform_whoami'];

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: /E-Mail|Email/i }).fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: /^(Anmelden|Sign in)$/i }).click();
  await page.waitForURL(/\/(overview|uebersicht)/, { timeout: 60_000 });
}

test('the Rückkehrpflicht tab opens, reads as a list to review, and writes nothing', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  const writes: string[] = [];
  page.on('pageerror', e => errors.push(`UNCAUGHT ${e.message}`));
  page.on('request', request => {
    const url = request.url().split('?')[0];
    const method = request.method();
    if (!url.includes('/rest/v1/')) return;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    if (method === 'POST' && READ_RPCS.some(name => url.endsWith(`/rpc/${name}`))) return;
    writes.push(`${method} ${url}`);
  });

  await signIn(page);
  writes.length = 0;

  await page.goto('/fahrtenanalyse');
  // The demo company has not decided its analysis settings, and the page computes
  // nothing until it has — or until someone chooses to look with the test value,
  // which is held in the page and stored nowhere.
  const testValue = page.getByRole('button', { name: /Mit Testwert 30 Min\. ansehen/ });
  await expect(testValue.or(page.getByRole('tab').first())).toBeVisible({ timeout: 60_000 });
  if (await testValue.isVisible()) await testValue.click();
  const tab = page.getByRole('tab', { name: 'Rückkehrpflicht & Adressen' });
  await expect(tab).toBeVisible({ timeout: 60_000 });
  await tab.click();

  await expect(page.getByText('Eine Liste zum Prüfen, kein Urteil')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Betriebssitz', { exact: true }).first()).toBeVisible();
  // Give the check a moment on a month of rides.
  await page.waitForTimeout(5000);
  const text = await page.locator('main').first().innerText();
  console.log('\n── Rückkehrpflicht ──\n' + text.slice(0, 1500));
  expect(text).not.toMatch(/returncheck\.|undefined|NaN/);
  expect(text).not.toMatch(/Verstoß|Verstoss|illegal|Betrug/i);

  expect(writes, 'opening the tab writes nothing').toEqual([]);
  expect(errors).toEqual([]);
});
