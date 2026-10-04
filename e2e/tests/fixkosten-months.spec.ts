/**
 * Fixkosten: the month list (src/components/FixedCostsManagement.tsx), walked in
 * a browser.
 *
 * Checks: the month cards and their badge ("Keine Fixkosten" / "Eigene
 * Einträge" / "Übernommen aus ..."), that a card expands and collapses, and that
 * EDITING a cost asks "Für welche Monate gilt die Änderung?" first and writes
 * nothing until the dialog is confirmed - then that each scope does what its
 * label says to the following month.
 *
 * ## What this writes, and why that is safe
 *
 * The demo company has no fixed costs, so the spec makes its own fixture through
 * the screen: one cost, "E2E-WALK Fixkosten", 1,00 € in the current month. The
 * edits move it to 2,00 € and 3,00 €, and "Nur dieser Monat" makes the screen
 * pin the following month with a copy. Everything it creates carries the
 * "E2E-WALK" prefix, and the last step deletes it again through the screen, in
 * the only order the screen allows (the current month first, then the pinned
 * month). The spec refuses to start if a row with that prefix is already there
 * (a crashed earlier run) or if the company holds any other fixed cost, so it
 * can only ever remove what it made. It refuses to write unless the signed-in
 * account is the demo administrator.
 *
 * ## What it cannot reach
 *
 * "Übernommen aus <Monat>" needs a month with no rows of its own that follows a
 * month that has some. The screen only lists months up to the current one and
 * the months that have rows, and it only writes into a listed month, so no
 * sequence of clicks makes a gap month; that state needs a row inserted
 * directly, which a walk through the screen does not do. The badge's wording is
 * therefore asserted through the one reachable inherited rendering - none - and
 * the inherited path is covered by src/utils/fixedCostMonths.test.ts.
 *
 * Runs against the synthetic DEMO Monatsplanung GmbH. No real customer's data.
 */
import { test, expect, type Page } from '@playwright/test';
import { DEMO_PASSWORD, assertDemoAccount, signInAsDemo } from '../lib/demoSession';

test.skip(!DEMO_PASSWORD, 'E2E_DEMO_PASSWORD is not set; the demo password is never in the repo.');

const PREFIX = 'E2E-WALK Fixkosten';
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function monthName(offset: number): string {
  const berlin = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const d = new Date(berlin.getFullYear(), berlin.getMonth() + offset, 1);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** The card of one month: its heading button, the badge and the figure are in it. */
const card = (page: Page, month: string) => page.locator('h2').filter({ hasText: month }).locator('xpath=ancestor::*[contains(@class,"rounded")][1]');
const header = (page: Page, month: string) => page.getByRole('button', { name: new RegExp(month) }).first();

async function open(page: Page) {
  await page.goto('/fixkosten');
  await expect(page.getByRole('heading', { name: monthName(0) }), 'the current month is listed').toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Benutzerinfo')).toBeVisible();
}

async function expandIfCollapsed(page: Page, month: string) {
  const h = header(page, month);
  if ((await h.getAttribute('aria-expanded')) !== 'true') await h.click();
  await expect(h).toHaveAttribute('aria-expanded', 'true');
}

test('the month list, the scope question on an edit, and what each scope writes', async ({ page }) => {
  test.setTimeout(400_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`UNCAUGHT ${e.message}`));
  const writes: string[] = [];
  page.on('request', r => {
    if (/\/rest\/v1\/fixed_costs/.test(r.url()) && r.method() !== 'GET' && r.method() !== 'HEAD') {
      writes.push(`${r.method()} ${r.postData() ?? ''}`.slice(0, 200));
    }
  });

  await signInAsDemo(page);
  await assertDemoAccount(page);
  await open(page);

  const now = monthName(0);
  const next = monthName(1);

  // ── The fixture must be exactly what this spec expects ────────────────────
  const body = await page.locator('main').first().innerText();
  expect(body, `a "${PREFIX}" row is left over from a crashed run: delete it on the Fixkosten screen (current month first)`)
    .not.toContain('E2E-WALK');
  await expect(card(page, now), 'the demo company starts with no fixed cost at all; something else moved')
    .toContainText('Keine Fixkosten');
  expect(await page.locator('h2').filter({ hasText: /\d{4}$/ }).count(), 'one month card only').toBe(1);
  console.log('start: current month card =', (await card(page, now).innerText()).replace(/\s+/g, ' ').slice(0, 120));

  // ── Expand and collapse ───────────────────────────────────────────────────
  await expect(header(page, now), 'the current month is open by default').toHaveAttribute('aria-expanded', 'true');
  await header(page, now).click();
  await expect(header(page, now)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('table', { name: `Fixkosten ${now}` })).toHaveCount(0);
  await header(page, now).click();
  await expect(header(page, now)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('table', { name: `Fixkosten ${now}` })).toBeVisible();

  // ── Fixture: one cost of 1,00 € ───────────────────────────────────────────
  await page.getByRole('button', { name: 'Neue Fixkosten hinzufügen' }).first().click();
  await page.getByLabel('Beschreibung').fill(PREFIX);
  await page.getByLabel('Betrag (€)').fill('1.00');
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(page.getByText(PREFIX).first()).toBeVisible();
  expect(writes.filter(w => w.startsWith('POST')), 'one insert for the new cost').toHaveLength(1);

  await expect(card(page, now), 'a month with rows of its own says so').toContainText('Eigene Einträge');
  await expect(card(page, now)).toContainText('1,00 €');
  console.log('after adding:', (await card(page, now).innerText()).replace(/\s+/g, ' ').slice(0, 160));
  writes.length = 0;

  const table = (month: string) => page.getByRole('table', { name: `Fixkosten ${month}` });
  const startEdit = async (month: string, amount: string) => {
    await table(month).getByRole('button', { name: `${PREFIX} bearbeiten` }).click();
    await table(month).getByLabel('Betrag (€)').fill(amount);
    await table(month).getByRole('button', { name: `Änderungen an ${PREFIX} speichern` }).click();
  };
  const scopeDialog = page.getByRole('dialog');

  // ── Editing asks about its scope, and writes nothing until confirmed ──────
  await startEdit(now, '2.00');
  await expect(scopeDialog.getByRole('heading', { name: 'Für welche Monate gilt die Änderung?' })).toBeVisible();
  await expect(scopeDialog).toContainText('Nur dieser Monat');
  await expect(scopeDialog).toContainText('Dieser und alle folgenden Monate');
  await expect(scopeDialog.getByRole('radio').first(), 'the narrower scope is preselected').toBeChecked();
  expect(writes, 'the question is asked before anything is written').toEqual([]);

  // Cancel: still nothing written, the old figure still on the card.
  await scopeDialog.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(scopeDialog).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(writes, 'cancelling the question writes nothing').toEqual([]);
  await expect(card(page, now), 'the card still shows the old 1,00 €').toContainText('1,00 €');
  await expect(card(page, now)).not.toContainText('2,00 €');

  // The row is still in edit mode, so its save asks the question again; confirm
  // "Nur dieser Monat" this time.
  await table(now).getByRole('button', { name: `Änderungen an ${PREFIX} speichern` }).click();
  await expect(scopeDialog.getByRole('heading', { name: 'Für welche Monate gilt die Änderung?' })).toBeVisible();
  expect(writes, 'still nothing written while the question is open').toEqual([]);
  await scopeDialog.getByText('Nur dieser Monat', { exact: true }).click();
  await scopeDialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText('Fixkosten aktualisiert').first()).toBeVisible({ timeout: 30_000 });
  console.log('writes after "Nur dieser Monat":', JSON.stringify(writes));

  await expect(card(page, now)).toContainText('2,00 €');
  // Nur dieser Monat: the following month is pinned to the old 1,00 € and listed.
  await expect(page.getByRole('heading', { name: next }), 'the pinned following month is now listed').toBeVisible();
  await expect(card(page, next)).toContainText('Eigene Einträge');
  await expect(card(page, next)).toContainText('1,00 €');
  console.log('this_month:', (await card(page, now).innerText()).replace(/\s+/g, ' ').slice(0, 80),
    '||', (await card(page, next).innerText()).replace(/\s+/g, ' ').slice(0, 80));
  writes.length = 0;

  // ── "Dieser und alle folgenden Monate": the following month follows ───────
  await expandIfCollapsed(page, now);
  await startEdit(now, '3.00');
  await expect(scopeDialog.getByRole('heading', { name: 'Für welche Monate gilt die Änderung?' })).toBeVisible();
  await scopeDialog.getByText('Dieser und alle folgenden Monate', { exact: true }).click();
  await scopeDialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(card(page, now)).toContainText('3,00 €');
  await expect(card(page, next), 'a following month holding the same cost changed too').toContainText('3,00 €');
  console.log('this_and_later:', (await card(page, now).innerText()).replace(/\s+/g, ' ').slice(0, 80),
    '||', (await card(page, next).innerText()).replace(/\s+/g, ' ').slice(0, 80));

  // ── Cleanup through the screen: current month first, then the pinned one ──
  for (const month of [now, next]) {
    await expandIfCollapsed(page, month);
    await table(month).getByRole('button', { name: `${PREFIX} löschen` }).click();
    await page.getByRole('alertdialog').or(page.getByRole('dialog')).getByRole('button', { name: 'Löschen' }).click();
    await expect(table(month).getByText(PREFIX), `${month}: the row is gone`).toHaveCount(0, { timeout: 30_000 });
  }
  await page.reload();
  await expect(page.getByRole('heading', { name: now })).toBeVisible({ timeout: 60_000 });
  expect(await page.locator('main').first().innerText(), 'nothing of the spec is left behind').not.toContain('E2E-WALK');

  expect(errors, 'no uncaught page error').toEqual([]);
});
