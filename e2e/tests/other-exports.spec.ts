/**
 * The two exports converted in `b081c18` that no download had checked.
 *
 * `exportFahreruebersichtToExcel` (the Steuerberater's payroll summary) and
 * `tripAnalysisReport.ts` were moved onto the styled writer with the rest, and
 * `excel-exports.spec.ts` covers neither. Both are the kind of change that cannot
 * fail a unit test and still produce a broken file: one swapped the writer under a
 * sheet that had always described its own styling, the other added styling to four
 * hand-built grids.
 *
 * The first run of this spec found that **neither was reachable**: the
 * Fahrerübersicht export sits behind the Stundennachweis wizard rather than on its
 * first screen, and the Fahrtenanalyse `Bericht` button was disabled. The second
 * part is not a dead end — the Fahrtenanalyse computes nothing until a block
 * threshold exists, and the company has none because that figure is still the
 * owner's open decision, so the screen offers a clearly labelled 30-minute test
 * value instead. Pressing that is what the screen is for, and it is what this does.
 *
 * A screen that still cannot produce a file is reported in those words rather than
 * skipped silently: "the test ran" must never read as "the file is fine".
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const EMAIL = process.env.E2E_DEMO_EMAIL!;
const PASSWORD = process.env.E2E_DEMO_PASSWORD!;
const OUT = resolve(process.cwd(), 'test-results/exports');

test.skip(!PASSWORD, 'E2E_DEMO_PASSWORD is not set; the demo password is never in the repo.');

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: /E-Mail|Email/i }).fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: /^(Anmelden|Sign in)$/i }).click();
  await page.waitForURL(/\/(overview|uebersicht)/, { timeout: 60_000 });
}

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

test('the Fahrtenanalyse report downloads once the analysis has run', async ({ page }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`UNCAUGHT ${e.message}`));

  await signIn(page);
  await page.goto('/fahrtenanalyse');
  await page.waitForTimeout(9000);

  // The analysis computes nothing without a block threshold, and the company has
  // none: that figure is one of the three settings still waiting on the owner, and
  // the screen stores NULL rather than inventing a default. The test value is the
  // screen's own answer to that, and it is never stored.
  const testValue = page.getByRole('button', { name: /Mit Testwert 30 Min\. ansehen/ }).first();
  if (await testValue.count() > 0) {
    console.log('  no block threshold is set — using the screen\'s 30-minute test value');
    await testValue.click();
    await page.waitForTimeout(12_000);
  }

  const report = page.getByRole('button', { name: /^Bericht$/ }).first();
  await expect(report, 'the report button is enabled once the analysis has run')
    .toBeEnabled({ timeout: 30_000 });

  const wait = page.waitForEvent('download', { timeout: 90_000 });
  await report.click();
  const file = await wait;
  await file.saveAs(resolve(OUT, 'fahrtenanalyse.xlsx'));
  console.log(`  fahrtenanalyse.xlsx  <-  "${file.suggestedFilename()}"`);

  expect(errors, `the browser logged errors:\n${errors.join('\n')}`).toEqual([]);
});

test('where the payroll summary export sits, reported rather than assumed', async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  await page.goto('/stundennachweis');
  await page.waitForTimeout(8000);

  const buttons = (await page.getByRole('button').allInnerTexts())
    .map(b => b.replace(/\s+/g, ' ').trim())
    .filter(b => b && !/^(Abmelden|DE|EN|DA )/.test(b));
  console.log(`  /stundennachweis step 1 buttons: ${buttons.join(' | ')}`);

  // Not an assertion: this records that `exportFahreruebersichtToExcel` is behind a
  // wizard that needs a saved Stundennachweis, so it stays UNVERIFIED by download
  // until a month is walked through to the end. Written down so nobody reads the
  // export work as fully checked.
  console.log('  exportFahreruebersichtToExcel: still unverified by download —'
    + ' it needs a saved Stundennachweis to reach');
});
