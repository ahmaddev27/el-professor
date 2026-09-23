#!/usr/bin/env node
/**
 * Phase 5 batch 2, clicked through: Gehälter, Abrechnung and Bargeldbestand on
 * the harness's invented month. Screenshots show a screen; this shows it
 * still computes, filters, refuses and fails the way it did.
 *
 *   node design-harness/flows-batch2.mjs
 *
 * The expected figures are the legacy screens' own, read off the before set
 * (Docs/design/phase5/batch2/before/) and the base's harness: a converted
 * screen that printed a different number would fail here, not only look
 * different. It needs the e2e package's Playwright (npm install in e2e/ once).
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { createServer } = await import(pathToFileURL(join(root, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href);
const server = await createServer({ configFile: join(root, 'design-harness', 'vite.config.ts'), logLevel: 'warn', server: { strictPort: false } });
await server.listen();
const ORIGIN = new URL(server.resolvedUrls.local[0]).origin;
const { chromium, expect } = createRequire(join(root, 'e2e', 'package.json'))('@playwright/test');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--lang=de-DE'] });
const results = [];
// `--only <part of a check's name>` runs just the matching checks.
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined;
const check = async (name, fn) => {
  if (only && !name.includes(only)) return;
  try { await fn(); results.push(`ok   ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message.split('\n').filter(Boolean).slice(0, 8).join(' | ')}`); }
  console.log(results[results.length - 1]);
};
async function open(query, touch = false) {
  const context = await browser.newContext({
    viewport: { width: touch ? 375 : 1280, height: 900 },
    isMobile: touch,
    hasTouch: touch,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    acceptDownloads: true,
  });
  await context.clock.install({ time: new Date('2026-09-14T10:00:00+02:00') });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${ORIGIN}/design-harness/?${new URLSearchParams({ theme: 'light', lang: 'de', ...query })}`, { waitUntil: 'domcontentloaded', timeout: 600_000 });
  await page.waitForFunction(() => window.__harness && window.__harness.answered > 0 && window.__harness.pending === 0, null, { timeout: 60_000 });
  await page.waitForTimeout(300);
  return { page, context, errors };
}
const idle = async page => {
  await page.waitForTimeout(250);
  await page.waitForFunction(() => window.__harness.pending === 0);
  await page.waitForTimeout(250);
};
/** The one DataTable of Gehälter and Bargeldbestand; the page has no other region. */
const rows = page => page.locator('[role="region"] tbody tr');
const choose = async (page, label, option) => {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await idle(page);
};
const kpi = (page, label) => page.locator('p', { hasText: new RegExp(`^${label}$`) }).locator('xpath=../..');

try {
  // ── Gehälter ────────────────────────────────────────────────────────────
  await check('Gehälter: nineteen drivers and the base\'s totals', async () => {
    const { page, context, errors } = await open({ screen: 'gehaelter' });
    await expect(rows(page)).toHaveCount(19);
    await expect(kpi(page, 'Gesamt Fällig')).toContainText('42.645,83 €');
    await expect(kpi(page, 'Gesamt Fällig')).toContainText('2 bezahlt / 17 unbezahlt');
    await expect(kpi(page, 'Trinkgeld')).toContainText('2.888,00 €');
    await expect(kpi(page, 'Umsatzanteil')).toContainText('39.757,83 €');
    if (errors.length) throw new Error(errors.join('; '));
    await context.close();
  });

  await check('Gehälter: (Umsatz + Aktionen) × Anteil + Trinkgeld, as the base computed it', async () => {
    const { page, context } = await open({ screen: 'gehaelter' });
    const row = rows(page).filter({ hasText: 'Ahmad Haddad' });
    for (const figure of ['3.587,98 €', '1.793,99 €', '172,00 €', '1.965,99 €']) await expect(row).toContainText(figure);
    await expect(row).toContainText(/50,0\s%/);
    // An adjusted salary shows netto_salary and its marker; Ewa is paid in full.
    const ewa = rows(page).filter({ hasText: 'Ewa Kowalczyk' });
    await expect(ewa).toContainText('1.720,40 €');
    await expect(ewa).toContainText('Manuell angepasst');
    await expect(ewa).toContainText('Bezahlt');
    const svenja = rows(page).filter({ hasText: 'Svenja Krüger' });
    await expect(svenja).toContainText('450,00 €');
    await expect(svenja).toContainText('Teilweise');
    await context.close();
  });

  await check('Gehälter: the month field moves the period to its business month (0-indexed underneath)', async () => {
    const { page, context } = await open({ screen: 'gehaelter' });
    await expect(page.getByLabel('Von', { exact: true })).toHaveValue('2026-09-07');
    await expect(page.getByLabel('Bis', { exact: true })).toHaveValue('2026-10-04');
    await page.getByLabel('Monat', { exact: true }).fill('2026-10');
    await expect(page.getByLabel('Von', { exact: true })).toHaveValue('2026-10-05');
    await expect(page.getByLabel('Bis', { exact: true })).toHaveValue('2026-11-01');
    // No income in October's business weeks: every total is a real zero now.
    await expect(kpi(page, 'Gesamt Fällig')).toContainText('0,00 €');
    await context.close();
  });

  await check('Gehälter: driver and status filters, and Zurücksetzen', async () => {
    const { page, context } = await open({ screen: 'gehaelter' });
    await choose(page, 'Fahrer', 'Svenja Krüger');
    await expect(rows(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'Zurücksetzen' }).click();
    await expect(rows(page)).toHaveCount(19);
    await choose(page, 'Status', 'Bezahlt');
    await expect(rows(page)).toHaveCount(2);
    await choose(page, 'Status', 'Unbezahlt');
    await expect(rows(page)).toHaveCount(17);
    await context.close();
  });

  await check('Gehälter: the overlap badge opens the periods dialog for that driver', async () => {
    const { page, context } = await open({ screen: 'gehaelter' });
    const row = rows(page).filter({ hasText: 'Katarzyna Nowak' });
    await row.getByRole('button', { name: /Zum Bereinigen anklicken/ }).click();
    await expect(page.getByText('Gehaltszeiträume — Katarzyna Nowak')).toBeVisible();
    await context.close();
  });

  await check('Gehälter: the revenue dialog lists the period\'s Umsatz and Trinkgeld and closes', async () => {
    const { page, context } = await open({ screen: 'gehaelter' });
    await page.getByRole('button', { name: 'Svenja Krüger: Umsatzdetails anzeigen' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Transaktionen: Svenja Krüger' })).toBeVisible();
    await expect(dialog.locator('tbody tr')).toHaveCount(8);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await context.close();
  });

  await check('Gehälter: the PDF summary still downloads', async () => {
    const { page, context } = await open({ screen: 'gehaelter' });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Svenja Krüger: Zusammenfassung für Fahrer (PDF)' }).click(),
    ]);
    if (!/^Fahrer-Zusammenfassung_.*\.pdf$/.test(download.suggestedFilename())) throw new Error(download.suggestedFilename());
    await context.close();
  });

  await check('Gehälter: an admin opens payments; the periods button is off without stored rows', async () => {
    const { page, context } = await open({ screen: 'gehaelter' });
    await expect(page.getByRole('button', { name: 'Anja Schubert: Gehaltszeiträume anzeigen (Für diesen Fahrer ist noch kein Gehaltsdatensatz gespeichert)' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Mehmet Yıldız: Gehaltszeiträume anzeigen', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Svenja Krüger: Zahlungen verwalten', exact: true }).click();
    await expect(page.getByText('Gehaltsdetails — Svenja Krüger')).toBeVisible();
    await context.close();
  });

  await check('Gehälter: a viewer and a platform view manage no payments', async () => {
    for (const role of ['viewer', 'view']) {
      const { page, context } = await open({ screen: 'gehaelter', role });
      await expect(rows(page)).toHaveCount(19);
      await expect(page.getByRole('button', { name: /Zahlungen verwalten \(Nur Admin\)$/ })).toHaveCount(19);
      for (const button of await page.getByRole('button', { name: /Zahlungen verwalten/ }).all()) await expect(button).toBeDisabled();
      await context.close();
    }
  });

  await check('Gehälter: a failed read claims no salary and offers no export', async () => {
    const { page, context } = await open({ screen: 'gehaelter', data: 'error' });
    await expect(page.getByText('Solange die Gehaltsdaten nicht geladen sind')).toBeVisible();
    await expect(page.getByText(/0,00\s€/)).toHaveCount(0);
    await expect(page.getByText('Ahmad Haddad')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Excel exportieren' })).toBeDisabled();
    await context.close();
  });

  await check('Gehälter: a failed driver list shows the page\'s own error and a retry', async () => {
    const { page, context } = await open({ screen: 'gehaelter', data: 'drivers-error' });
    await expect(page.getByText('Die Verbindung zur Datenbank konnte nicht hergestellt werden.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Erneut versuchen' })).toBeVisible();
    await expect(page.locator('[role="region"]')).toHaveCount(0);
    await context.close();
  });

  await check('Gehälter: no drivers, no rows, no export', async () => {
    const { page, context } = await open({ screen: 'gehaelter', data: 'empty' });
    await expect(page.getByText('Keine Gehaltsdaten für den ausgewählten Zeitraum')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Excel exportieren' })).toBeDisabled();
    await context.close();
  });

  // ── Abrechnung ──────────────────────────────────────────────────────────
  await check('Abrechnung: four weeks, newest first, each with its Gesamt row', async () => {
    const { page, context, errors } = await open({ screen: 'abrechnung' });
    const headings = page.getByRole('heading', { level: 2, name: /^Woche \d - September 2026$/ });
    await expect(headings).toHaveCount(4);
    await expect(headings.first()).toHaveText('Woche 4 - September 2026');
    await expect(page.locator('tfoot tr')).toHaveCount(4);
    if (errors.length) throw new Error(errors.join('; '));
    await context.close();
  });

  await check('Abrechnung: the detail shows the base\'s figures and Tankenquote', async () => {
    const { page, context } = await open({ screen: 'abrechnung' });
    await page.getByRole('button', { name: 'Details: Ahmad Haddad' }).first().click();
    await idle(page);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Detaillierte Abrechnung' })).toBeVisible();
    await expect(dialog).toContainText('Ahmad Haddad · Woche 4');
    await expect(dialog).toContainText('28.09.2026 – 04.10.2026');
    for (const figure of ['289,40 €', '71,39 €', '218,01 €', '7,24 %', '1 Belege']) await expect(dialog).toContainText(figure);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await context.close();
  });

  await check('Abrechnung: the share image is still built from the off-screen card', async () => {
    const { page, context } = await open({ screen: 'abrechnung' });
    await page.getByRole('button', { name: 'Details: Ahmad Haddad' }).first().click();
    await idle(page);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.getByRole('dialog').getByRole('button', { name: 'Download', exact: true }).click(),
    ]);
    if (download.suggestedFilename() !== 'abrechnung-ahmad-haddad-woche-4.png') throw new Error(download.suggestedFilename());
    await context.close();
  });

  await check('Abrechnung: week and driver filters', async () => {
    const { page, context } = await open({ screen: 'abrechnung' });
    await choose(page, 'Woche', 'Woche 2');
    await expect(page.getByRole('heading', { level: 2, name: /^Woche \d/ })).toHaveCount(1);
    await choose(page, 'Fahrer', 'Svenja Krüger');
    await expect(page.locator('[role="region"] tbody tr')).toHaveCount(1);
    await context.close();
  });

  await check('Abrechnung: the monthly view sums each driver\'s weeks', async () => {
    const { page, context } = await open({ screen: 'abrechnung' });
    await page.getByRole('tab', { name: 'Monatlich' }).click();
    await idle(page);
    await expect(page.getByRole('heading', { level: 2, name: 'September 2026' })).toBeVisible();
    await expect(page.locator('[role="region"] tbody tr')).toHaveCount(6);
    await expect(page.locator('[role="region"] tbody tr').first()).toContainText('(4 Wochen)');
    await context.close();
  });

  await check('Abrechnung: a month without rows says so', async () => {
    const { page, context } = await open({ screen: 'abrechnung' });
    await choose(page, 'Monat', 'Oktober');
    await expect(page.getByText('Keine Daten für Oktober 2026')).toBeVisible();
    await context.close();
  });

  await check('Abrechnung: a failed load claims no figure', async () => {
    const { page, context } = await open({ screen: 'abrechnung', data: 'error' });
    await expect(page.getByText(/Solange die Abrechnung nicht geladen ist/)).toBeVisible();
    await expect(page.getByText(/Keine Daten für/)).toHaveCount(0);
    await expect(page.getByText('€')).toHaveCount(0);
    await context.close();
  });

  await check('Abrechnung: when the next month fails, nothing of the previous one stays on screen', async () => {
    const { page, context } = await open({ screen: 'abrechnung', data: 'next-month-fails' });
    await expect(page.getByRole('heading', { level: 2, name: /September 2026/ })).toHaveCount(4);
    await choose(page, 'Monat', 'Oktober');
    await expect(page.getByText(/Solange die Abrechnung nicht geladen ist/)).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /September 2026/ })).toHaveCount(0);
    await expect(page.getByText('Ahmad Haddad')).toHaveCount(0);
    await expect(page.getByLabel('Fahrer', { exact: true })).toHaveCount(0);
    // And the retry reads October again rather than showing September.
    await page.getByRole('button', { name: 'Erneut versuchen' }).click();
    await idle(page);
    await expect(page.getByText(/Solange die Abrechnung nicht geladen ist/)).toBeVisible();
    await context.close();
  });

  // ── Bargeldbestand ──────────────────────────────────────────────────────
  await check('Bargeldbestand: September\'s till, Bargeld − Belege − (Gehaltsquittungen − Stornos)', async () => {
    const { page, context, errors } = await open({ screen: 'bargeld' });
    await expect(kpi(page, 'Bargeld Einnahmen')).toContainText('6.517,80 €');
    await expect(kpi(page, 'Belege Ausgaben')).toContainText('1.718,59 €');
    await expect(kpi(page, 'Gehaltsauszahlungen \\(bar\\)')).toContainText('1.130,00 €');
    await expect(kpi(page, 'Aktueller Bestand')).toContainText('3.669,21 €');
    await expect(kpi(page, 'Aktueller Bestand')).toContainText('Bargeld − Belege − Gehalt');
    await expect(rows(page).filter({ hasText: 'Gehaltsquittung GQ-2026-0008' })).toContainText('-680,00 €');
    if (errors.length) throw new Error(errors.join('; '));
    await context.close();
  });

  await check('Bargeldbestand: October books the Storno on the day of the void', async () => {
    const { page, context } = await open({ screen: 'bargeld' });
    await page.getByLabel('Monat', { exact: true }).fill('2026-10');
    await idle(page);
    await expect(kpi(page, 'Gehaltsauszahlungen \\(bar\\)')).toContainText('-680,00 €');
    await expect(kpi(page, 'Aktueller Bestand')).toContainText('995,73 €');
    const storno = rows(page).filter({ hasText: 'Storno Gehaltsquittung GQ-2026-0008' });
    await expect(storno).toContainText('02.10.2026');
    await expect(storno).toContainText('+680,00 €');
    await context.close();
  });

  await check('Bargeldbestand: a billing reader gets no payout card, the old label and the caveat', async () => {
    const { page, context } = await open({ screen: 'bargeld', role: 'billing' });
    await expect(page.getByText('Gehaltsquittungen sind in dieser Ansicht nicht lesbar.', { exact: false })).toBeVisible();
    await expect(page.getByText('Gehaltsauszahlungen (bar)')).toHaveCount(0);
    await expect(kpi(page, 'Aktueller Bestand')).toContainText('4.799,21 €');
    await expect(kpi(page, 'Aktueller Bestand')).toContainText('Bargeld − Belege');
    await expect(kpi(page, 'Aktueller Bestand')).not.toContainText('Gehalt');
    await expect(rows(page).filter({ hasText: 'Gehaltsquittung' })).toHaveCount(0);
    await context.close();
  });

  await check('Bargeldbestand: a read-only view with business.read keeps the ledger', async () => {
    const { page, context } = await open({ screen: 'bargeld', role: 'view' });
    await expect(kpi(page, 'Gehaltsauszahlungen \\(bar\\)')).toContainText('1.130,00 €');
    await expect(page.getByText('Gehaltsquittungen sind in dieser Ansicht nicht lesbar.', { exact: false })).toHaveCount(0);
    await context.close();
  });

  await check('Bargeldbestand: type, driver and date filters leave the cards alone', async () => {
    const { page, context } = await open({ screen: 'bargeld' });
    const all = await rows(page).count();
    await choose(page, 'Typ', 'Ausgaben');
    const out = await rows(page).count();
    if (!(out > 0 && out < all)) throw new Error(`${out} of ${all}`);
    for (const row of await rows(page).all()) await expect(row).toContainText(/-[\d.]+,\d{2}\s€/);
    await expect(kpi(page, 'Bargeld Einnahmen')).toContainText('6.517,80 €');
    await choose(page, 'Fahrer', 'Ahmad Haddad');
    for (const row of await rows(page).all()) await expect(row).toContainText('Ahmad Haddad');
    await page.getByRole('button', { name: 'Filter zurücksetzen' }).click();
    await expect(rows(page)).toHaveCount(all);
    await page.getByLabel('Von Datum', { exact: true }).fill('2026-09-25');
    await page.getByLabel('Bis Datum', { exact: true }).fill('2026-09-25');
    for (const row of await rows(page).all()) await expect(row).toContainText('25.09.2026');
    await context.close();
  });

  await check('Bargeldbestand: a failed read claims no till and offers no export', async () => {
    const { page, context } = await open({ screen: 'bargeld', data: 'error' });
    await expect(page.getByText('Solange die Daten nicht geladen sind, zeigt diese Seite keine Beträge an.')).toBeVisible();
    await expect(page.getByText(/0,00\s€/)).toHaveCount(0);
    await expect(page.getByText('Keine Transaktionen gefunden')).toHaveCount(0);
    await expect(page.locator('button[title="Aktuelle Ansicht als Excel exportieren"]')).toBeDisabled();
    await context.close();
  });

  await check('Bargeldbestand: when October fails, September\'s till is not shown as October\'s', async () => {
    const { page, context } = await open({ screen: 'bargeld', data: 'next-month-fails' });
    await expect(kpi(page, 'Aktueller Bestand')).toContainText('3.669,21 €');
    await page.getByLabel('Monat', { exact: true }).fill('2026-10');
    await idle(page);
    await expect(page.getByText('Solange die Daten nicht geladen sind, zeigt diese Seite keine Beträge an.')).toBeVisible();
    await expect(page.getByText('3.669,21 €')).toHaveCount(0);
    await expect(page.getByText('Bargeld Abgabe KW 39')).toHaveCount(0);
    await expect(page.locator('button[title="Aktuelle Ansicht als Excel exportieren"]')).toBeDisabled();
    await context.close();
  });

  await check('Bargeldbestand: an empty month is a real zero, and says there is nothing', async () => {
    const { page, context } = await open({ screen: 'bargeld', data: 'empty' });
    await expect(page.getByText('Keine Transaktionen gefunden')).toBeVisible();
    await expect(kpi(page, 'Aktueller Bestand')).toContainText('0,00 €');
    await context.close();
  });

  // ── Phones ──────────────────────────────────────────────────────────────
  await check('Phone: no page wider than 375 px, and every row action on screen and 40 px tall', async () => {
    for (const screen of ['gehaelter', 'abrechnung', 'bargeld']) {
      const { page, context } = await open({ screen }, true);
      const pageOver = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (pageOver > 0) throw new Error(`${screen}: the page scrolls ${pageOver}px sideways`);
      const tableOver = await page.locator('[role="region"]').first().evaluate(el => el.scrollWidth - el.clientWidth);
      if (tableOver > 0) throw new Error(`${screen}: the table scrolls ${tableOver}px`);
      const actions = screen === 'gehaelter' ? /: Gehaltszeiträume anzeigen/ : screen === 'abrechnung' ? /^Details: / : null;
      if (actions) {
        const box = await page.getByRole('button', { name: actions }).first().boundingBox();
        if (!box || box.x + box.width > 375 || box.height < 40) throw new Error(`${screen}: action ${JSON.stringify(box)}`);
      }
      await context.close();
    }
  });
} finally {
  await browser.close();
  await server.close();
}
console.log(`\n${results.filter(line => line.startsWith('ok')).length} of ${results.length} passed`);
if (results.some(line => line.startsWith('FAIL'))) process.exitCode = 1;
