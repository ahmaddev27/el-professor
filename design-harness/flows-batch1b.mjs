#!/usr/bin/env node
/**
 * Phase 5 batch 1b, clicked through: every write, refusal and filter of the
 * converted Belege, Fahrer and Umsätze screens, run against the harness's
 * in-memory store. Screenshots show a screen; this shows it still works.
 *
 *   node design-harness/flows-batch1b.mjs
 *
 * Beyond what the screen shows afterwards, each write is checked against what
 * it sent: `window.__harness.writes` records every insert, update and delete
 * with its payload and filters (fakes/supabase.ts), so a check can say "the
 * Beleg number that was saved is the one the system generated", not only
 * "a row appeared". It needs the e2e package's Playwright (npm install in e2e/).
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ configFile: join(root, 'design-harness', 'vite.config.ts'), logLevel: 'warn', server: { strictPort: false } });
await server.listen();
const ORIGIN = new URL(server.resolvedUrls.local[0]).origin;
const { chromium, expect } = createRequire(join(root, 'e2e', 'package.json'))('@playwright/test');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--lang=de-DE'] });
const results = [];
const check = async (name, fn) => {
  const started = Date.now();
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message.split('\n').filter(Boolean).slice(0, 8).join(' | ')}`);
  }
  console.log(`${results[results.length - 1].slice(0, 4)} ${name}  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
};
const contexts = new Set();
async function open(query, touch = false) {
  const context = await browser.newContext({ viewport: { width: touch ? 375 : 1280, height: 900 }, isMobile: touch, hasTouch: touch, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  contexts.add(context);
  await context.clock.install({ time: new Date('2026-09-14T10:00:00+02:00') });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${ORIGIN}/design-harness/?${new URLSearchParams({ theme: 'light', lang: 'de', ...query })}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__harness && window.__harness.answered > 0 && window.__harness.pending === 0, null, { timeout: 60000 });
  // Umsätze reads its entries only once the page has its drivers, so a first
  // pending === 0 can fall between the two reads.
  await settle(page);
  return { page, context, errors };
}
const close = async context => { contexts.delete(context); await context.close(); };
async function settle(page) {
  await page.waitForFunction(() => window.__harness.pending === 0);
  await page.waitForTimeout(400);
  await page.waitForFunction(() => window.__harness.pending === 0);
}
const writes = page => page.evaluate(() => window.__harness.writes);
const tableRows = (page, index = 0) => page.locator('[role="region"]').nth(index).locator('tbody tr');
const visible = locator => locator.filter({ visible: true });
/** A 1×1 PNG: the scripted OCR ignores the pixels, the form needs an image file. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const WRITE_WORDS = /hinzufügen|bearbeiten|löschen|deaktivieren|aktivieren|Neuer Fahrer/;

try {
  // ── Belege ────────────────────────────────────────────────────────────────
  await check('Belege: the number is the system\'s, the OCR leaves it alone, and the insert carries it', async () => {
    const { page, context, errors } = await open({ screen: 'belege', ocr: 'ok' });
    await page.getByRole('button', { name: 'Beleg hinzufügen' }).click();
    const dialog = page.getByRole('dialog');
    const number = dialog.getByLabel(/^Belegnummer/);
    const generated = await number.inputValue();
    if (!/^BEL-\d{13}-\d{4}$/.test(generated)) throw new Error(`not a system number: ${generated}`);
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'beleg.png', mimeType: 'image/png', buffer: PNG });
    await expect(dialog.getByText('Felder automatisch ausgefüllt')).toBeVisible();
    await expect(number).toHaveValue(generated);
    await expect(dialog.getByLabel(/^Ausgaben/)).toHaveValue('41,47');
    await expect(dialog.getByLabel(/^Postleitzahl/)).toHaveValue('13405');
    await dialog.getByLabel(/^Fahrer/).selectOption({ label: 'Ahmad Haddad' });
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await settle(page);
    const insert = (await writes(page)).find(w => w.table === 'receipts' && w.op === 'insert');
    if (!insert) throw new Error('no insert');
    const p = insert.payload;
    const expected = { receipt_number: generated, date: '2026-09-12', description: 'Tanken', driver_name: 'Ahmad Haddad', expense: 41.47, postal_code: '13405', city: 'Berlin', payment_method: 'bar' };
    for (const [key, value] of Object.entries(expected)) {
      if (p[key] !== value) throw new Error(`${key}: ${JSON.stringify(p[key])} != ${JSON.stringify(value)}`);
    }
    // Create mode leaves the form open for the next Beleg, with a fresh number.
    // It is a fresh form, driver included: BelegePage shows its loading state
    // while it reloads, which unmounts the form, so ReceiptModal's
    // resetForm(true) ("keep the driver") never reaches the screen. That was so
    // before phase 5 as well (HANDOFF.md).
    await expect(page.getByText('Beleg erfolgreich gespeichert').first()).toBeVisible();
    await expect(dialog).toHaveCount(1);
    await expect.poll(() => number.inputValue()).not.toBe(generated);
    const next = await number.inputValue();
    if (!/^BEL-\d{13}-\d{4}$/.test(next)) throw new Error(`next number ${next}`);
    await expect(dialog.getByLabel(/^Fahrer/)).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(tableRows(page)).toHaveCount(13);
    if (errors.length) throw new Error(errors.join('; '));
    await close(context);
  });

  await check('Belege: "Other" needs a description; without one nothing is written', async () => {
    const { page, context } = await open({ screen: 'belege' });
    await page.getByRole('button', { name: 'Beleg hinzufügen' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^Fahrer/).selectOption({ label: 'Mehmet Yıldız' });
    await dialog.getByLabel(/^Kategorie/).selectOption('Other');
    const description = dialog.getByLabel(/^Beschreibung/);
    await expect(description).toBeVisible();
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await page.waitForTimeout(400);
    if (!(await description.evaluate(el => el.validity.valueMissing))) throw new Error('required not enforced');
    if ((await writes(page)).length) throw new Error('a write ran');
    await close(context);
  });

  await check('Belege: edit keeps the number and writes the new amount', async () => {
    const { page, context } = await open({ screen: 'belege' });
    await page.getByRole('button', { name: 'Beleg BEL-1788220800000-0000 bearbeiten' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Beleg bearbeiten' })).toBeVisible();
    await expect(dialog.getByText('Belegbild einfügen oder hochladen')).toHaveCount(0);
    await expect(dialog.getByLabel(/^Belegnummer/)).toHaveValue('BEL-1788220800000-0000');
    await dialog.getByLabel(/^Ausgaben/).fill('70,00');
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await settle(page);
    await expect(dialog).toHaveCount(0);
    const update = (await writes(page)).find(w => w.table === 'receipts' && w.op === 'update');
    if (!update || update.payload.expense !== 70 || update.payload.receipt_number !== 'BEL-1788220800000-0000') throw new Error(JSON.stringify(update));
    if (JSON.stringify(update.filters) !== JSON.stringify([['eq', 'id', 'rc-1']])) throw new Error(JSON.stringify(update.filters));
    await expect(page.getByText('819,52 €').first()).toBeVisible();
    await close(context);
  });

  await check('Belege: delete asks, then removes the row and the total follows', async () => {
    const { page, context } = await open({ screen: 'belege' });
    await page.getByRole('button', { name: 'Beleg BEL-1788220800000-0000 löschen' }).click();
    await expect(page.getByRole('dialog')).toContainText('BEL-1788220800000-0000');
    await page.getByRole('dialog').getByRole('button', { name: 'Löschen' }).click();
    await settle(page);
    const deleted = (await writes(page)).filter(w => w.table === 'receipts' && w.op === 'delete');
    if (deleted.length !== 1 || JSON.stringify(deleted[0].filters) !== JSON.stringify([['eq', 'id', 'rc-1']])) throw new Error(JSON.stringify(deleted));
    await expect(tableRows(page)).toHaveCount(11);
    await expect(page.getByText('749,52 €').first()).toBeVisible();
    await close(context);
  });

  await check('Belege: cancel in the delete dialog deletes nothing', async () => {
    const { page, context } = await open({ screen: 'belege' });
    await page.getByRole('button', { name: 'Beleg BEL-1788220800000-0000 löschen' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen' }).click();
    await page.waitForTimeout(400);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    if ((await writes(page)).length) throw new Error('a write ran');
    await expect(tableRows(page)).toHaveCount(12);
    await close(context);
  });

  await check('Belege: week, driver and month filters narrow the list and the totals', async () => {
    const { page, context } = await open({ screen: 'belege' });
    await page.getByLabel('Woche', { exact: true }).selectOption({ index: 1 });
    await expect(page.getByText(/^Woche 1: 07\.09\.2026 – 13\.09\.2026$/)).toBeVisible();
    // Eleven Belege are dated 07.–13.09., but the two of Sunday 13.09. are not
    // shown: the week ends at Sunday 00:00 local time and a Beleg's date parses
    // as UTC midnight, 02:00 in Berlin. A defect of ReceiptList's filter logic,
    // unchanged by phase 5 and pinned here as it is (HANDOFF.md).
    await expect(tableRows(page)).toHaveCount(9);
    await page.getByRole('button', { name: /^Filter/ }).click();
    await page.getByLabel('Fahrer', { exact: true }).selectOption('Mehmet Yıldız');
    // The badge counts the week and the driver.
    await expect(page.getByRole('button', { name: 'Filter 2', exact: true })).toBeVisible();
    // The empty state is a row of its own, one cell across the table.
    await expect(tableRows(page).filter({ hasNot: page.locator('td[colspan]') })).toHaveCount(0);
    await expect(page.getByText('Keine Belege für die aktuellen Filter gefunden.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zusammenfassung PDF' })).toBeDisabled();
    await page.getByRole('button', { name: 'Alle Filter zurücksetzen' }).click();
    await page.getByLabel('Monat', { exact: true }).fill('2026-08');
    await expect(tableRows(page)).toHaveCount(3);
    await expect(page.getByText('139,67 €').first()).toBeVisible();
    await close(context);
  });

  await check('Belege: a read context and a viewer are offered no write', async () => {
    for (const role of ['view', 'viewer']) {
      const { page, context } = await open({ screen: 'belege', role });
      await expect(tableRows(page)).toHaveCount(12);
      await expect(page.getByRole('button', { name: WRITE_WORDS })).toHaveCount(0);
      await close(context);
    }
  });

  await check('Belege: a failed load claims neither "no Belege" nor 0,00 €', async () => {
    const { page, context } = await open({ screen: 'belege', data: 'error' });
    await expect(page.getByText('Belege konnten nicht geladen werden')).toBeVisible();
    await expect(page.getByText('Keine Belege vorhanden')).toHaveCount(0);
    await expect(page.getByText('0,00 €')).toHaveCount(0);
    await close(context);
  });

  // ── Fahrer ────────────────────────────────────────────────────────────────
  await check('Fahrer: add a driver; salary_ratio goes in as the fraction', async () => {
    const { page, context, errors } = await open({ screen: 'fahrer' });
    await page.getByRole('button', { name: 'Neuer Fahrer' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^Fahrername/).fill('  Paula Neumann  ');
    await dialog.getByLabel(/^Personalnummer/).fill('2001');
    await dialog.getByLabel(/^Umsatzanteil/).fill('45');
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await settle(page);
    await expect(dialog).toHaveCount(0);
    const insert = (await writes(page)).find(w => w.table === 'drivers' && w.op === 'insert');
    const p = insert?.payload ?? {};
    if (p.name !== 'Paula Neumann' || p.salary_ratio !== 0.45 || p.personalnummer !== '2001' || p.planning_priority !== 100
      || JSON.stringify(p.allowed_weekdays) !== '[1,2,3,4,5]' || p.employment_type !== 'employee') throw new Error(JSON.stringify(p));
    await expect(page.getByText('Paula Neumann', { exact: true })).toBeVisible();
    await expect(page.getByText('17 von 60 aktiven Fahrern')).toBeVisible();
    if (errors.length) throw new Error(errors.join('; '));
    await close(context);
  });

  await check('Fahrer: an empty name is stopped by the field, nothing written', async () => {
    const { page, context } = await open({ screen: 'fahrer' });
    await page.getByRole('button', { name: 'Neuer Fahrer' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Speichern' }).click();
    await page.waitForTimeout(400);
    await expect(page.getByRole('dialog')).toHaveCount(1);
    if (!(await page.getByRole('dialog').getByLabel(/^Fahrername/).evaluate(el => el.validity.valueMissing))) throw new Error('required not enforced');
    if ((await writes(page)).length) throw new Error('a write ran');
    await close(context);
  });

  await check('Fahrer: edit shows the stored ratio, refuses max < min, then writes the planning', async () => {
    const { page, context } = await open({ screen: 'fahrer' });
    await page.getByRole('button', { name: 'Ahmad Haddad bearbeiten' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(/^Umsatzanteil/)).toHaveValue('60');
    await dialog.getByLabel(/^Umsatzanteil/).fill('55');
    await dialog.getByRole('button', { name: 'Planungseinstellungen' }).click();
    // Ahmad Haddad is a company owner in the store. Since #102 useDatabase maps
    // employment_type (mapDriverRow), so the form opens him as one and the save
    // below keeps him one; before it, an edit silently wrote 'employee'.
    await expect(dialog.getByLabel('Fahrerrolle')).toHaveValue('company_owner');
    await dialog.getByLabel(/^Mindestgehalt/).fill('3000');
    await dialog.getByLabel(/^Maximalgehalt/).fill('2500');
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await page.waitForTimeout(400);
    await expect(dialog.getByRole('alert')).toBeVisible();
    if ((await writes(page)).length) throw new Error('a write ran');
    await dialog.getByLabel(/^Maximalgehalt/).fill('3500');
    await dialog.getByRole('button', { name: 'Sa', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Sa', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await settle(page);
    const update = (await writes(page)).find(w => w.table === 'drivers' && w.op === 'update');
    const p = update?.payload ?? {};
    if (p.salary_ratio !== 0.55 || p.planning_min_salary !== 3000 || p.planning_max_salary !== 3500
      || JSON.stringify(p.allowed_weekdays) !== '[1,2,3,4,5,6]' || p.employment_type !== 'company_owner') throw new Error(JSON.stringify(p));
    if (JSON.stringify(update.filters) !== JSON.stringify([['eq', 'id', 'd05']])) throw new Error(JSON.stringify(update.filters));
    await close(context);
  });

  await check('Fahrer: an Inhaber is marked in the list', async () => {
    const { page, context } = await open({ screen: 'fahrer' });
    const row = page.locator('[role="region"] tbody tr', { hasText: 'Ahmad Haddad' });
    await expect(row.getByText('Inhaber / Selbstständig')).toBeVisible();
    await expect(page.getByText('Inhaber / Selbstständig')).toHaveCount(1);
    await close(context);
  });

  await check('Fahrer: deactivate writes the status and keeps the ratio', async () => {
    const { page, context } = await open({ screen: 'fahrer' });
    await page.getByRole('button', { name: 'Ahmad Haddad deaktivieren' }).click();
    await settle(page);
    const update = (await writes(page)).find(w => w.table === 'drivers' && w.op === 'update');
    if (update?.payload.status !== 'inactive' || update.payload.salary_ratio !== 0.6) throw new Error(JSON.stringify(update));
    await expect(page.getByRole('button', { name: 'Ahmad Haddad aktivieren' })).toBeVisible();
    await expect(page.getByText('15 von 60 aktiven Fahrern')).toBeVisible();
    await close(context);
  });

  await check('Fahrer: the bin deletes at once, as it always has', async () => {
    const { page, context } = await open({ screen: 'fahrer' });
    await page.getByRole('button', { name: 'Marco Rossi löschen' }).click();
    await settle(page);
    const deleted = (await writes(page)).filter(w => w.table === 'drivers' && w.op === 'delete');
    if (deleted.length !== 1 || JSON.stringify(deleted[0].filters) !== JSON.stringify([['eq', 'id', 'd16']])) throw new Error(JSON.stringify(deleted));
    await expect(page.getByText('Marco Rossi', { exact: true })).toHaveCount(0);
    await close(context);
  });

  await check('Fahrer: at the plan\'s limit the add button is disabled and says why', async () => {
    const { page, context } = await open({ screen: 'fahrer', data: 'limit' });
    await expect(page.getByRole('button', { name: 'Neuer Fahrer' })).toBeDisabled();
    await expect(page.getByText('Fahrerlimit erreicht', { exact: true })).toBeVisible();
    await close(context);
  });

  await check('Fahrer: a read context and a viewer are offered no write', async () => {
    for (const role of ['view', 'viewer']) {
      const { page, context } = await open({ screen: 'fahrer', role });
      await expect(tableRows(page)).toHaveCount(19);
      await expect(page.getByRole('button', { name: WRITE_WORDS })).toHaveCount(0);
      await close(context);
    }
  });

  await check('Fahrer: a failed load shows no list and no counts', async () => {
    const { page, context } = await open({ screen: 'fahrer', data: 'error' });
    await expect(page.getByText('Fahrer konnten nicht geladen werden')).toBeVisible();
    await expect(page.getByText('Keine Fahrer vorhanden')).toHaveCount(0);
    await expect(page.getByText('Aktive Fahrer')).toHaveCount(0);
    await close(context);
  });

  // ── Umsätze ───────────────────────────────────────────────────────────────
  await check('Umsätze: the batch form writes one row per filled amount', async () => {
    const { page, context, errors } = await open({ screen: 'umsaetze' });
    await page.getByRole('button', { name: 'Neue Einnahme hinzufügen' }).click();
    await expect(page.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    // The filter card above has a Fahrer field too; the form's is the required one.
    await page.getByLabel(/^Fahrer.*Pflichtfeld/).selectOption('Anja Schubert');
    await page.getByLabel('Netto-Fahrpreis (€)').fill('1184,60');
    await page.getByLabel('Bargeld (€)').fill('512,40');
    await page.getByLabel(/^Anzahl Fahrten/).fill('12');
    await expect(page.getByText('Es werden 2 Einträge erstellt.')).toBeVisible();
    await page.getByRole('button', { name: 'Speichern' }).click();
    await settle(page);
    const insert = (await writes(page)).find(w => w.table === 'income' && w.op === 'insert');
    const rowsWritten = insert?.payload ?? [];
    const summary = rowsWritten.map(r => `${r.type}:${r.amount}:${r.driver_name}:${r.description}:${r.trip_count}`).sort();
    if (JSON.stringify(summary) !== JSON.stringify(['bargeld:512.4:Anja Schubert:Woche 2:12', 'umsatz:1184.6:Anja Schubert:Woche 2:12'])) throw new Error(JSON.stringify(rowsWritten));
    await expect(page.getByText('2 Einträge erfolgreich gespeichert').first()).toBeVisible();
    await expect(page.getByText('24 von 32 Einträgen')).toBeVisible();
    if (errors.length) throw new Error(errors.join('; '));
    await close(context);
  });

  await check('Umsätze: without a driver the batch form warns and writes nothing', async () => {
    const { page, context } = await open({ screen: 'umsaetze' });
    await page.getByRole('button', { name: 'Neue Einnahme hinzufügen' }).click();
    await page.getByLabel('Aktionen (€)').fill('20');
    await page.getByRole('button', { name: 'Speichern' }).click();
    await page.waitForTimeout(400);
    await expect(page.getByText('Bitte wählen Sie einen Fahrer aus').first()).toBeVisible();
    if ((await writes(page)).length) throw new Error('a write ran');
    await close(context);
  });

  await check('Umsätze: edit a row in place', async () => {
    const { page, context } = await open({ screen: 'umsaetze' });
    await page.getByRole('button', { name: 'Einnahme von Mehmet Yıldız am 13.09.2026 bearbeiten' }).first().click();
    // In its own column a select must stay readable, not shrink to its chevron.
    for (const [label, min] of [['Woche', 80], ['Typ', 130]]) {
      const box = await visible(page.locator('[role="region"]').nth(1).getByLabel(label, { exact: true })).boundingBox();
      if (!box || box.width < min) throw new Error(`${label} select is ${box?.width}px wide`);
    }
    await visible(page.getByLabel('Betrag', { exact: true })).fill('1200');
    await page.getByRole('button', { name: 'Einnahme von Mehmet Yıldız speichern' }).click();
    await settle(page);
    const update = (await writes(page)).find(w => w.table === 'income' && w.op === 'update');
    if (update?.payload.amount !== 1200 || update.payload.type !== 'umsatz' || update.payload.description !== 'Woche 1 - Uber/Bolt') throw new Error(JSON.stringify(update));
    await expect(page.getByText('1.200,00 €').first()).toBeVisible();
    await close(context);
  });

  await check('Umsätze: delete asks, then removes the row', async () => {
    const { page, context } = await open({ screen: 'umsaetze' });
    await page.getByRole('button', { name: 'Einnahme von Hüseyin Demir am 13.09.2026 löschen' }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Löschen' }).click();
    await settle(page);
    const deleted = (await writes(page)).filter(w => w.table === 'income' && w.op === 'delete');
    if (deleted.length !== 1) throw new Error(JSON.stringify(deleted));
    await expect(page.getByText('21 von 29 Einträgen')).toBeVisible();
    await close(context);
  });

  await check('Umsätze: presets and the type filter narrow rows, total and per-driver table', async () => {
    const { page, context } = await open({ screen: 'umsaetze' });
    await expect(page.getByText('6.601,20 €')).toBeVisible();
    await page.getByRole('button', { name: 'Letzter Monat' }).click();
    await expect(page.getByRole('button', { name: 'Letzter Monat' })).toHaveAttribute('aria-pressed', 'true');
    await expect(tableRows(page, 1)).toHaveCount(8);
    await expect(page.getByText('8 von 30 Einträgen')).toBeVisible();
    await page.getByRole('button', { name: 'Dieser Monat' }).click();
    await page.getByLabel('Typ', { exact: true }).selectOption('bargeld');
    await expect(tableRows(page, 1)).toHaveCount(6);
    await page.getByRole('button', { name: 'Zurücksetzen' }).click();
    await expect(tableRows(page, 1)).toHaveCount(22);
    await close(context);
  });

  await check('Umsätze: a read context and a viewer are offered no write', async () => {
    for (const role of ['view', 'viewer']) {
      const { page, context } = await open({ screen: 'umsaetze', role });
      await expect(tableRows(page, 1)).toHaveCount(22);
      await expect(page.getByRole('button', { name: WRITE_WORDS })).toHaveCount(0);
      await close(context);
    }
  });

  await check('Umsätze: a failed load claims neither "no entries" nor 0,00 €', async () => {
    const { page, context } = await open({ screen: 'umsaetze', data: 'error' });
    await expect(page.getByText('Umsätze konnten nicht geladen werden')).toBeVisible();
    await expect(page.getByText('Keine Einträge für den ausgewählten Zeitraum')).toHaveCount(0);
    await expect(page.getByText('0,00 €')).toHaveCount(0);
    await close(context);
  });

  await check('Umsätze: a failed read of the entries shows no total, no figures and no export', async () => {
    // `missing` fails only the income table: the database is reachable, so
    // the page's connection check passes and only loadFailed can tell.
    const { page, context } = await open({ screen: 'umsaetze', data: 'missing' });
    await expect(page.getByText('Die Daten konnten nicht geladen werden')).toBeVisible();
    await expect(page.getByText('0,00 €')).toHaveCount(0);
    await expect(page.getByText('Keine Einträge für den ausgewählten Zeitraum')).toHaveCount(0);
    await expect(page.getByText('Gesamteinnahmen (gefiltert)')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nach Excel exportieren' })).toBeDisabled();
    await close(context);
  });

  // ── Phones ────────────────────────────────────────────────────────────────
  await check('Phone: no page or table scrolls sideways, and every row action is a 40 px target on screen', async () => {
    for (const screen of ['belege', 'fahrer', 'umsaetze']) {
      const { page, context } = await open({ screen }, true);
      const pageOver = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (pageOver > 0) throw new Error(`${screen}: page scrolls ${pageOver}px`);
      for (const region of await page.locator('[role="region"]').all()) {
        const over = await region.evaluate(el => el.scrollWidth - el.clientWidth);
        if (over > 0) throw new Error(`${screen}: a table scrolls ${over}px`);
      }
      const box = await page.getByRole('button', { name: /löschen$/ }).first().boundingBox();
      if (!box || box.x + box.width > 375 || box.height < 40) throw new Error(`${screen}: delete button ${JSON.stringify(box)}`);
      await close(context);
    }
  });

  await check('Phone: an Umsätze row edits every field the table offers', async () => {
    const { page, context } = await open({ screen: 'umsaetze' }, true);
    await page.getByRole('button', { name: 'Einnahme von Mehmet Yıldız am 13.09.2026 bearbeiten' }).first().click();
    // The filter card has Fahrer and Typ fields too; count inside the entries table.
    const table = page.locator('[role="region"]').nth(1);
    for (const label of ['Datum', 'Woche', 'Fahrer', 'Typ', 'Beschreibung', 'Betrag']) {
      await expect(visible(table.getByLabel(label, { exact: true }))).toHaveCount(1);
    }
    // Editing must not push the save button off the phone.
    const over = await table.evaluate(el => el.scrollWidth - el.clientWidth);
    if (over > 0) throw new Error(`the entries table scrolls ${over}px while a row is edited`);
    const save = await page.getByRole('button', { name: 'Einnahme von Mehmet Yıldız speichern' }).boundingBox();
    if (!save || save.x + save.width > 375 || save.height < 40) throw new Error(`save button ${JSON.stringify(save)}`);
    await visible(table.getByLabel('Typ', { exact: true })).selectOption('aktionen');
    await page.getByRole('button', { name: 'Einnahme von Mehmet Yıldız speichern' }).click();
    await settle(page);
    const update = (await writes(page)).find(w => w.table === 'income' && w.op === 'update');
    if (update?.payload.type !== 'aktionen') throw new Error(JSON.stringify(update));
    await close(context);
  });
} finally {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser.close();
  await server.close();
}
console.log(`\n${results.join('\n')}`);
if (results.some(line => line.startsWith('FAIL'))) process.exitCode = 1;
