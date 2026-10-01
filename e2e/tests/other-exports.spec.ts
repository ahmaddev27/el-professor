/**
 * The two exports converted in `b081c18` that no download has yet checked.
 *
 * `exportFahreruebersichtToExcel` (the Steuerberater's payroll summary) and
 * `tripAnalysisReport.ts` were moved onto the styled writer with the rest, and
 * `excel-exports.spec.ts` covers neither — it tests Umsätze, Notizen and Gehälter.
 * Both changes are the kind that cannot fail a unit test and still produce a
 * broken file: one swapped the writer under a sheet that had always described its
 * own styling, the other added styling to four hand-built grids.
 *
 * So this walks to each screen, reports whether the export is reachable at all in
 * the demo company, and downloads it when it is. **A screen with no data is a
 * finding, not a pass** — it is reported in those words rather than skipped
 * silently, because "the test ran" would otherwise read as "the file is fine".
 */
import { test, type Page } from '@playwright/test';
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

test('the payroll summary and the analysis report, if they can be reached', async ({ page }) => {
  test.setTimeout(420_000);
  page.on('pageerror', e => console.log(`  UNCAUGHT ${e.message}`));

  await signIn(page);

  for (const [path, label, pattern] of [
    ['/stundennachweis', 'Stundennachweis / Fahrerübersicht', /Fahrer[üu]bersicht|Excel/i],
    ['/fahrtenanalyse', 'Fahrtenanalyse', /Bericht|Excel|Export/i],
    ['/trip-analysis', 'Fahrtenanalyse (alt)', /Bericht|Excel|Export/i],
  ] as const) {
    await page.goto(path);
    await page.waitForTimeout(8000);

    const heading = (await page.getByRole('heading').allInnerTexts())
      .map(h => h.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 3).join(' | ');
    const all = (await page.getByRole('button').allInnerTexts())
      .map(b => b.replace(/\s+/g, ' ').trim())
      .filter(b => b && !/^(Abmelden|DE|EN|DA )/.test(b));

    console.log(`\n── ${label}  (${path}) ──`);
    console.log(`   headings: ${heading}`);
    console.log(`   buttons:  ${all.join(' | ')}`);

    const target = page.getByRole('button', { name: pattern }).first();
    if (await target.count() === 0) {
      console.log('   NOT REACHABLE: no export button on this screen');
      continue;
    }
    if (!(await target.isEnabled())) {
      const title = await target.getAttribute('title');
      console.log(`   DISABLED: ${title ?? 'no reason given'} — the screen has no data to export`);
      continue;
    }

    try {
      const wait = page.waitForEvent('download', { timeout: 60_000 });
      await target.click();
      const file = await wait;
      const name = `${path.replace(/\W+/g, '')}.xlsx`;
      await file.saveAs(resolve(OUT, name));
      console.log(`   DOWNLOADED ${name}  <-  "${file.suggestedFilename()}"`);
    } catch (error) {
      console.log(`   NO FILE: ${(error as Error).message.split('\n')[0]}`);
    }
  }
});
