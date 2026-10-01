/**
 * The Excel exports, tested by downloading the real files from staging.
 *
 * The owner reported on 01.10.2026 that the files came out ugly and signed. The
 * unit test `src/utils/exportDrawing.test.ts` writes each workbook through the
 * real `exceljs` and reads the bytes back, which is strong — but it builds the
 * workbook from a fixture in Node. **This spec presses the button on staging and
 * keeps the file the browser downloaded**, which is the only thing that exercises
 * the whole path: the screen's own data, the lazy `exceljs` import in the browser,
 * the Blob, and the download.
 *
 * It deliberately does not parse the workbook here — Playwright is not where a
 * workbook is parsed. It saves each download into `test-results/exports/` and
 * `scripts/inspect-exports.mjs` at the repo root reports on the bytes, because
 * that is where `exceljs` lives.
 *
 * ## It creates its own data, through the UI
 *
 * DEMO Monatsplanung GmbH has six drivers and no income, so the export button is
 * `disabled` with `title="Keine Daten zum Exportieren"` — which is correct
 * behaviour and was the first thing this spec found. The rows are therefore
 * entered through the product's own form rather than seeded with SQL, which also
 * tests that path, and only into the synthetic demo company at an address the
 * staging mail relay never forwards. No real customer's company is touched.
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

/**
 * Fills the input whose `<label for>` matches, which is how the design system's
 * `Field` wires a label to its control. By label and not by index: the filter row
 * above the form holds four controls of its own.
 */
async function fillByLabel(page: Page, label: RegExp, value: string) {
  const id = await page.locator('label').filter({ hasText: label }).first().getAttribute('for');
  if (!id) throw new Error(`no label matching ${label}`);
  await page.locator(`#${id}`).fill(value);
}

async function selectByLabel(page: Page, label: RegExp, index: number) {
  const id = await page.locator('label').filter({ hasText: label }).first().getAttribute('for');
  if (!id) throw new Error(`no label matching ${label}`);
  await page.locator(`#${id}`).selectOption({ index });
}

/** Presses an export button and saves whatever the browser downloads. */
async function download(page: Page, button: RegExp, as: string): Promise<void> {
  const target = page.getByRole('button', { name: button }).first();
  await expect(target, `the ${as} export button is enabled`).toBeEnabled({ timeout: 20_000 });
  const wait = page.waitForEvent('download', { timeout: 90_000 });
  await target.click();
  const file = await wait;
  await file.saveAs(resolve(OUT, as));
  console.log(`  ${as}  <-  "${file.suggestedFilename()}"`);
}

/** Today in `YYYY-MM-DD`, which is what a date input takes. */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

test('all three exports download a real file', async ({ page }) => {
  test.setTimeout(480_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`UNCAUGHT ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error' && !/WebSocket|favicon|net::ERR/.test(m.text())) {
      errors.push(m.text().slice(0, 300));
    }
  });

  await signIn(page);

  // ── Umsätze ───────────────────────────────────────────────────────────────
  await page.goto('/umsaetze');
  await page.waitForTimeout(7000);

  const exportUmsaetze = page.getByRole('button', { name: /Nach Excel exportieren/ }).first();
  if (!(await exportUmsaetze.isEnabled())) {
    console.log('  Umsätze is empty — entering four amounts through the form');
    await page.getByRole('button', { name: /Neue Einnahme hinzufügen/ }).first().click();
    await page.waitForTimeout(2500);

    await selectByLabel(page, /^Fahrer\*/, 1);
    await fillByLabel(page, /^Datum\*/, today());
    await fillByLabel(page, /Beschreibung/, 'E2E Prüfung Export');
    await fillByLabel(page, /Netto-Fahrpreis/, '1234,56');
    await fillByLabel(page, /Aktionen/, '80,00');
    await fillByLabel(page, /Trinkgeld/, '45,50');
    await fillByLabel(page, /Bargeld/, '600,00');

    await page.getByRole('button', { name: /^Speichern$/ }).first().click();
    await page.waitForTimeout(7000);
  }

  // The list defaults to the BUSINESS month, and a business week belongs to the
  // month containing its Monday — so an entry made on Thursday 01.10.2026 sits in
  // September's business month and the October filter hides it. The rows are
  // written (verified directly in the database); the filter is what has to move.
  // Widened rather than worked around, because an export of a hidden row would
  // prove nothing about the file the operator actually gets.
  await fillByLabel(page, /Von Datum/, '2026-01-01');
  await fillByLabel(page, /Bis Datum/, '2027-12-31');
  await page.waitForTimeout(4000);

  await download(page, /Nach Excel exportieren/, 'umsaetze.xlsx');

  // ── Notizen ───────────────────────────────────────────────────────────────
  await page.goto('/notes');
  await page.waitForTimeout(7000);

  const exportNotes = page.getByRole('button', { name: /Notizen exportieren/ }).first();
  if (!(await exportNotes.isEnabled())) {
    console.log('  Notizen is empty — adding one note through the form');
    await page.getByRole('button', { name: /Neue Notiz/ }).first().click();
    await page.waitForTimeout(2500);

    // NotesPage is one of the six screens phase 5 never converted, so its form
    // controls carry no id and no `<label for>` — `selectByLabel` cannot reach
    // them. Matching on a DRIVER's name picked the wrong control: the page's own
    // filter select offers the same names and sits in the same document, so the
    // first match was the filter and the modal's field stayed empty (the browser
    // said so: "Please select an item in the list"). The placeholder option is
    // what only the modal has.
    const driverSelect = page.locator('select').filter({
      has: page.locator('option', { hasText: 'Fahrer auswählen' }),
    }).first();
    await driverSelect.selectOption({ index: 1 });

    const text = page.locator('textarea').first();
    if (await text.count() > 0) await text.fill('E2E Prüfung Export');

    await page.getByRole('button', { name: /^(Speichern|Hinzufügen)$/ }).first().click();
    await page.waitForTimeout(7000);
  }
  await download(page, /Notizen exportieren/, 'notizen.xlsx');

  // ── Gehälter ──────────────────────────────────────────────────────────────
  await page.goto('/salaries');
  await page.waitForTimeout(9000);
  await download(page, /^Excel exportieren$/, 'gehaelter.xlsx');

  expect(errors, `the browser logged errors:\n${errors.join('\n')}`).toEqual([]);
});
