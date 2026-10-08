/**
 * The monthly plan is saved — proven by a document, not by a green screen.
 *
 * The defect this covers was precisely a screen that *said* it had finished:
 * *Planung fertig*, every document drawn, and `monthly_plans` holding zero rows.
 * So neither test asserts on a success message. They assert that **§10's planned
 * Fahrtenbuch produces a file**, which it can only do from a saved plan's id,
 * and that confirming a month that already has a plan offers §9's choice rather
 * than writing a second one.
 *
 * ## Why it does not reset the database first
 *
 * It cannot, and that is correct behaviour rather than a limitation:
 * `app_private.monthly_plan_guard` refuses to delete a confirmed plan
 * (`monthly_plan_is_final`) because a confirmed plan is the month's record. So
 * these tests are written to be **independent of what ran before them** — the
 * first one presses *replace* if the month already holds a plan, which is §9's
 * real path and therefore tests more, not less.
 *
 * It runs against the synthetic **DEMO Monatsplanung GmbH**, seeded with the
 * owner's approval so no real customer's drivers or salaries are opened to test
 * a screen, at an address the staging relay never forwards.
 */

import { test, expect, type Page } from '@playwright/test';

const EMAIL = process.env.E2E_DEMO_EMAIL ?? 'demo-admin@example.com';
const PASSWORD = process.env.E2E_DEMO_PASSWORD;

test.skip(!PASSWORD, 'E2E_DEMO_PASSWORD is not set; the demo password is never in the repo.');

async function signIn(page: Page) {
  await page.goto('/login');
  // getByRole and not getByLabel: the field's own show/hide button is
  // aria-labelled "Passwort anzeigen", so a label match resolves to two nodes.
  await page.getByRole('textbox', { name: /E-Mail|Email/i }).fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD!);
  await page.getByRole('button', { name: /^(Anmelden|Sign in)$/i }).click();
  await page.waitForURL(/\/(overview|uebersicht)/, { timeout: 40_000 });
}

/**
 * Steps 1 to 4 of the eight, leaving the summary (step 4) with its first
 * "Plan bestätigen" button. That button only moves to step 6 ("Bestätigen"),
 * where a second "Plan bestätigen" saves; callers press it twice.
 */
async function walkToSummary(page: Page) {
  await page.goto('/monatsplan?art=standard');
  await page.waitForTimeout(6000);
  // The month list now opens on November 2026, whose seeded import carries no
  // source_columns_json, so the planned Fahrtenbuch (§10) cannot be built from it
  // (fixture gap, see report). October's import has its columns; pick it, as the
  // spec did when October was the only/first month.
  const monthSelect = page.locator('select').first();
  const october = await monthSelect.locator('option').filter({ hasText: /Oktober 2026/ }).first().getAttribute('value');
  await monthSelect.selectOption(october!);
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: /^Weiter$/ }).click();
  await page.waitForTimeout(4000);
  await page.getByRole('button', { name: /Bestätigen und Plan erzeugen/ }).click();
  await page.waitForTimeout(12_000);
  // Step 3 (blocks) -> step 4 (distribution / summary).
  await page.getByRole('button', { name: /Auf Fahrer verteilen/ }).first().click();
  await page.waitForTimeout(10_000);
}

/** Step 4 -> step 6: the first "Plan bestätigen" only opens the confirmation step. */
async function toConfirmStep(page: Page) {
  const first = page.getByRole('button', { name: /^Plan bestätigen$/ });
  await expect(first, 'the summary offers confirmation').toBeEnabled({ timeout: 30_000 });
  await first.click();
  await page.waitForTimeout(2000);
}

test('confirming writes the plan, and the planned Fahrtenbuch becomes producible', async ({ page }) => {
  test.setTimeout(300_000); // the eight-step walk on staging is slow

  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`UNCAUGHT ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error' && !/WebSocket|favicon/.test(m.text())) errors.push(m.text().slice(0, 300));
  });

  await signIn(page);
  await walkToSummary(page);

  await toConfirmStep(page);
  const confirm = page.getByRole('button', { name: /^Plan bestätigen$/ });
  await expect(confirm, 'the confirmation step offers the save').toBeEnabled();
  await confirm.click();

  // The month may already hold a plan from an earlier run. §9's choice is the
  // real path for that, so take it rather than depending on a clean database.
  const replace = page.getByRole('button', { name: /Bisherige ersetzen/ });
  await page.waitForTimeout(12_000);
  if (await replace.count() > 0) {
    await replace.click();
  }

  // A confirmed plan lands on step 7 (Schichten); the documents are step 8.
  await page.getByRole('button', { name: /Weiter zu den Dokumenten/ }).click({ timeout: 45_000 });

  await expect(page.getByRole('tab', { name: /Stundennachweis/ }),
    'the documents step opens once the plan is confirmed').toBeVisible({ timeout: 45_000 });

  /*
   * The screen's own statement that the plan reached the database. "Noch nicht
   * gespeichert — der Plan liegt nur in dieser Ansicht" is what screen 4 showed
   * for every plan before the save was wired.
   */
  await expect(page.getByText(/Noch nicht gespeichert/)).toHaveCount(0);

  /*
   * And the assertion that cannot pass by accident. §10's document is built from
   * the import's original rows reached **through the saved plan's id**, so it
   * refused outright while nothing was saved — and refused again while the page
   * held a saved plan whose projection still carried `id: null`. A file here
   * means a row exists and the id the page holds is the one the database gave.
   */
  await page.getByRole('tab', { name: /Fahrtenbuch/ }).click();
  await page.waitForTimeout(9000);

  const panel = page.getByRole('tabpanel').first();
  await expect(panel.getByText(/muss die Planung gespeichert sein/),
    'the planned Fahrtenbuch no longer refuses for want of a saved plan').toHaveCount(0);

  const download = panel.getByRole('button', { name: /Herunterladen|Download/i }).first();
  await expect(download, 'its download is offered').toBeEnabled({ timeout: 20_000 });

  const [file] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    download.click(),
  ]);
  expect(file.suggestedFilename(), 'and the file says it is a proposal').toMatch(/PLANUNG/);

  expect(errors, `uncaught errors while saving:\n${errors.join('\n')}`).toEqual([]);
});

test('a second confirmation offers to replace rather than writing a second plan', async ({ page }) => {
  test.setTimeout(300_000); // the eight-step walk on staging is slow

  // The test above leaves October confirmed, so this one's premise holds
  // whatever ran before either of them.
  await signIn(page);
  await walkToSummary(page);
  await toConfirmStep(page);
  await page.getByRole('button', { name: /^Plan bestätigen$/ }).click();

  await expect(page.getByText(/bereits eine bestätigte Planung/),
    '§9 offers the choice').toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('button', { name: /Bisherige ersetzen/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Bisherige behalten/ })).toBeVisible();

  // And it must not have advanced: the documents belong to a confirmed plan, and
  // showing them over an unconfirmed draft is the claim this whole slice closes.
  await expect(page.getByRole('tab', { name: /Stundennachweis/ })).toHaveCount(0);

  // Declining leaves the screen where it was, with nothing confirmed.
  await page.getByRole('button', { name: /Bisherige behalten/ }).click();
  await page.waitForTimeout(1500);
  await expect(page.getByText(/bereits eine bestätigte Planung/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Plan bestätigen$/ })).toBeVisible();
});
