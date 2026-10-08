/**
 * The monthly plan's second type, walked on staging: the chooser, the three
 * steps, and the one property the type is built on — it writes nothing.
 *
 * Every request the page sends to PostgREST is recorded, and the walk fails on
 * any write there (a POST that is not a read-only RPC, a PATCH, a PUT or a
 * DELETE). Storage and edge functions are not watched: the page calls neither.
 * The recommendation reads imports and rides and produces shifts in memory; a
 * write here would be the first step towards a record of something that did
 * not happen.
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

test('the chooser, the three steps, and no write', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  const writes: string[] = [];
  page.on('pageerror', e => errors.push(`UNCAUGHT ${e.message}`));
  page.on('request', request => {
    const url = request.url().split('?')[0];
    const method = request.method();
    if (!url.includes('/rest/v1/')) return;
    // GET and HEAD read; OPTIONS is the browser's CORS preflight, not a request of the page's.
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    // The app shell's own reads travel as POST RPCs (it refreshes its config on focus).
    if (method === 'POST' && READ_RPCS.some(name => url.endsWith(`/rpc/${name}`))) return;
    writes.push(`${method} ${url}`);
  });

  await signIn(page);
  // Signing in may write (a profile touch, an audit row); only what the page sends counts.
  writes.length = 0;

  await page.goto('/monatsplan');
  await expect(page.getByRole('button', { name: 'Standardplan verwenden' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Schichtempfehlung erstellen' }).click();
  await expect(page).toHaveURL(/art=schichten/);

  // Step 1: the months to learn from and the target month.
  await expect(page.getByRole('button', { name: /^Weiter$/ })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: /^Weiter$/ }).click();

  // Step 2: the profile's coverage and the vehicles.
  const compute = page.getByRole('button', { name: 'Empfehlung berechnen' });
  await expect(compute).toBeVisible({ timeout: 60_000 });
  console.log('\n── step 2 ──\n' + (await page.locator('main').first().innerText()).slice(0, 900));
  await compute.click();

  // Step 3: the result.
  await expect(page.getByText('Empfohlene Schichten').first()).toBeVisible({ timeout: 30_000 });
  const result = await page.locator('main').first().innerText();
  console.log('\n── step 3 ──\n' + result.slice(0, 1500));
  expect(result).not.toMatch(/shiftrec\.|mplanType\.|undefined|NaN/);

  // Back to the chooser from the recommendation asks nothing.
  await page.getByRole('button', { name: /Planungsart wechseln/ }).click();
  await expect(page.getByRole('button', { name: 'Standardplan verwenden' })).toBeVisible();

  expect(writes, 'the recommendation writes nothing').toEqual([]);
  expect(errors).toEqual([]);
});
