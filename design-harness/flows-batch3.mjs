#!/usr/bin/env node
/**
 * Phase 5 batch 3, clicked through: Dokumente, Monatsplanung, Stundennachweis.
 *
 *   node design-harness/flows-batch3.mjs
 *
 * These screens write payroll records, so the flows here only draw: they open
 * and close dialogs, switch tabs and steps, follow links between the screens,
 * type into Phase 1's parameter fields (whose handlers must correct a value
 * exactly as before), and build Phase 1's vehicle blocks, which happens in
 * memory. Nothing applies a plan, finalizes one, saves a Stundennachweis or
 * deletes anything, and every check ends by proving it: the harness records
 * each insert, update, delete and RPC a batch 3 screen sends, and both lists
 * must be empty.
 *
 * It needs the e2e package's Playwright (npm install in e2e/ once).
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { quiet } from './batch3/shots.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  configFile: join(root, 'design-harness', 'vite.config.ts'),
  logLevel: 'warn',
  cacheDir: join(tmpdir(), 'el-professor-harness', createHash('sha1').update(root).digest('hex').slice(0, 12)),
  server: { strictPort: false },
});
await server.listen();
const ORIGIN = new URL(server.resolvedUrls.local[0]).origin;
const { chromium, expect } = createRequire(join(root, 'e2e', 'package.json'))('@playwright/test');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--lang=de-DE'] });
const results = [];

const check = async (name, fn) => {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message.split('\n').filter(Boolean).slice(0, 8).join(' | ')}`);
  }
};

async function open(query, touch = false) {
  const context = await browser.newContext({
    viewport: { width: touch ? 375 : 1280, height: 900 },
    isMobile: touch,
    hasTouch: touch,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  });
  await context.clock.install({ time: new Date('2026-09-14T10:00:00+02:00') });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${ORIGIN}/design-harness/?${new URLSearchParams({ theme: 'light', lang: 'de', ...query })}`, {
    waitUntil: 'domcontentloaded',
    timeout: 300_000,
  });
  await page.waitForFunction(() => window.__harness && window.__harness.answered > 0, null, { timeout: 180_000 });
  await quiet(page);
  return { page, context, errors };
}

/** No write, no RPC, no page error: the flow only drew. */
async function nothingSent(page, errors) {
  const sent = await page.evaluate(() => window.__harnessBatch3);
  if (sent.writes.length || sent.rpcs.length) {
    throw new Error(`sent ${JSON.stringify(sent)}`);
  }
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
}

// A string is an exact name: a run's row is a button whose name holds every label in it.
const button = (page, name) => page.getByRole('button', typeof name === 'string' ? { name, exact: true } : { name });
const click = async (page, locator) => {
  await locator.click();
  await quiet(page);
};

try {
  // ── Dokumente ──────────────────────────────────────────────────────────────

  await check('Dokumente: a record\'s delete dialog opens, names nothing it would not delete, and Abbrechen closes it', async () => {
    const { page, context, errors } = await open({ screen: 'dokumente' });
    const row = page.getByRole('row', { name: /Svenja Krüger/ });
    await click(page, row.getByRole('button', { name: 'Stundennachweis von Svenja Krüger löschen' }));
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Löschen bestätigen' })).toBeVisible();
    await click(page, dialog.getByRole('button', { name: 'Abbrechen' }));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(row).toBeVisible();
    await nothingSent(page, errors);
    await context.close();
  });

  await check('Dokumente: Escape closes a record\'s delete dialog as Abbrechen does', async () => {
    const { page, context, errors } = await open({ screen: 'dokumente' });
    await click(page, page.getByRole('row', { name: /Jonas Albrecht/ }).getByRole('button').last());
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await nothingSent(page, errors);
    await context.close();
  });

  await check('Dokumente: the month\'s delete dialog names the month and how many records go', async () => {
    const { page, context, errors } = await open({ screen: 'dokumente' });
    await click(page, button(page, /^Alle löschen – August 2026$/));
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('August 2026', { exact: true })).toBeVisible();
    await expect(dialog.getByText(/^5 Einträge werden gelöscht/)).toBeVisible();
    await click(page, dialog.getByRole('button', { name: 'Abbrechen' }));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await nothingSent(page, errors);
    await context.close();
  });

  await check('Dokumente: a month folds and unfolds; the newest is open on arrival', async () => {
    const { page, context, errors } = await open({ screen: 'dokumente' });
    const august = button(page, /^August 2026/);
    const july = button(page, /^Juli 2026/);
    await expect(august).toHaveAttribute('aria-expanded', 'true');
    await expect(july).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('region', { name: 'Gespeicherte Stundennachweise, Juli 2026' })).toHaveCount(0);
    await click(page, july);
    await expect(july).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('region', { name: 'Gespeicherte Stundennachweise, Juli 2026' })).toBeVisible();
    await click(page, august);
    await expect(august).toHaveAttribute('aria-expanded', 'false');
    await nothingSent(page, errors);
    await context.close();
  });

  await check('Dokumente: a July record without a stored gross shows "—", and its month shows no gross total', async () => {
    const { page, context, errors } = await open({ screen: 'dokumente' });
    await click(page, button(page, /^Juli 2026/));
    const juli = button(page, /^Juli 2026/);
    await expect(juli).not.toContainText('Brutto');
    await expect(button(page, /^August 2026/)).toContainText(/Std\. gesamt · [\d.]+,\d{2}\s€ Brutto/);
    await nothingSent(page, errors);
    await context.close();
  });

  await check('Dokumente: the Fahrtenbuch card opens the trips view, and Dokumente comes back', async () => {
    const { page, context, errors } = await open({ screen: 'dokumente' });
    await click(page, button(page, /^Fahrtenbuch$/));
    await expect(page.getByRole('heading', { level: 1, name: 'Fahrtenbuch' })).toBeVisible();
    await click(page, button(page, /^Dokumente$/));
    await expect(page.getByRole('heading', { level: 1, name: 'Dokumente' })).toBeVisible();
    await nothingSent(page, errors);
    await context.close();
  });

  await check('Dokumente: "Öffnen" opens that record in the Stundennachweis sheet, and nothing is saved', async () => {
    const { page, context, errors } = await open({ screen: 'dokumente' });
    await click(page, page.getByRole('row', { name: /Mehmet Yıldız/ }).getByRole('button', { name: 'Stundennachweis von Mehmet Yıldız öffnen' }));
    await expect(page.getByRole('heading', { level: 1, name: 'Stundennachweis' })).toBeVisible();
    await expect(page.getByText(/^Mehmet Yıldız — August 2026/)).toBeVisible();
    await expect(page.getByText('Gespeicherte Version')).toBeVisible();
    await nothingSent(page, errors);
    await context.close();
  });

  // ── Monatsplanung ──────────────────────────────────────────────────────────

  await check('Monatsplanung: both modes open and go back to the choice', async () => {
    const { page, context, errors } = await open({ screen: 'monatsplanung' });
    await click(page, button(page, 'Neue Planung starten'));
    await expect(page.getByText('Phase 1: Fahrzeug-Blöcke')).toBeVisible();
    await click(page, button(page, 'Zurück zur Auswahl'));
    await click(page, button(page, 'Historischen Abgleich starten'));
    await expect(page.getByRole('heading', { name: 'Art des historischen Abgleichs wählen' })).toBeVisible();
    await click(page, button(page, 'Zurück zur Auswahl'));
    await expect(page.getByText('Wähle einen Planungsmodus aus.')).toBeVisible();
    await nothingSent(page, errors);
    await context.close();
  });

  await check('Monatsplanung: the parameter fields correct a value exactly as before', async () => {
    const { page, context, errors } = await open({ screen: 'monatsplanung' });
    await click(page, button(page, 'Neue Planung starten'));
    const gap = page.getByLabel('Block-Trenner');
    const minBlock = page.getByLabel('Min Blockdauer');
    const maxBlock = page.getByLabel('Max Blockdauer');
    const buffer = page.getByLabel('Fahrzeugwechsel-Puffer');
    // A gap of 0 is no gap: the default returns.
    await gap.fill('0');
    await expect(gap).toHaveValue('60');
    await gap.fill('45');
    await expect(gap).toHaveValue('45');
    // The minimum block is clamped to 0–120, and 0 reads "deaktiviert".
    await minBlock.fill('500');
    await expect(minBlock).toHaveValue('120');
    await minBlock.fill('0');
    await expect(minBlock).toHaveValue('0');
    await expect(page.getByText('Min. (deaktiviert)')).toBeVisible();
    // The maximum is clamped to its bounds.
    await maxBlock.fill('9999');
    await expect(maxBlock).toHaveValue('720');
    // A negative buffer is refused for the default.
    await buffer.fill('-5');
    await expect(buffer).toHaveValue('30');
    await expect(page.getByText(/Fahrzeugwechsel-Puffer 30 Min ·/)).toBeVisible();
    await nothingSent(page, errors);
    await context.close();
  });

  await check('Monatsplanung: Phase 1 builds blocks in memory and nothing is written', async () => {
    const { page, context, errors } = await open({ screen: 'monatsplanung' });
    await click(page, button(page, 'Neue Planung starten'));
    await click(page, button(page, 'Fahrzeug-Blöcke erstellen'));
    await expect(page.getByText('Fahrzeug-Blöcke wurden erstellt.')).toBeVisible();
    await expect(page.getByText(/^\d+ Blöcke · 3 Fahrzeuge · \d+ Fahrten\./)).toBeVisible();
    await expect(page.getByRole('heading', { name: /Fahrer-Auswahl/ })).toBeVisible();
    await nothingSent(page, errors);
    await context.close();
  });

  await check('Monatsplanung: a run\'s delete dialog opens and closes without calling the archive RPC', async () => {
    const { page, context, errors } = await open({ screen: 'monatsplanung' });
    await click(page, button(page, 'Neue Planung starten'));
    // Exact: the run's row is itself a button whose name contains every label in it.
    await click(page, page.getByRole('button', { name: 'Plan endgültig löschen', exact: true }).first());
    await expect(page.getByText(/August 2026 · Fahrtenbuch_August_2026\.xlsx/)).toBeVisible();
    await click(page, button(page, 'Abbrechen'));
    await expect(page.getByText(/August 2026 · Fahrtenbuch_August_2026\.xlsx/)).toHaveCount(0);
    await nothingSent(page, errors);
    await context.close();
  });

  await check('Monatsplanung: with no import for the month, Phase 1 cannot start', async () => {
    const { page, context, errors } = await open({ screen: 'monatsplanung', data: 'empty' });
    await click(page, button(page, 'Neue Planung starten'));
    await expect(page.getByLabel('Fahrtenbuch-Datei / Import')).toBeDisabled();
    await expect(button(page, 'Fahrzeug-Blöcke erstellen')).toBeDisabled();
    await nothingSent(page, errors);
    await context.close();
  });

  // ── Stundennachweis ────────────────────────────────────────────────────────

  await check('Stundennachweis: Weiter waits for a driver, the steps go forward and back', async () => {
    const { page, context, errors } = await open({ screen: 'stundennachweis' });
    const next = button(page, /^Weiter/);
    await expect(next).toBeDisabled();
    await page.getByLabel(/^Fahrer/).selectOption({ label: 'Ahmad Haddad — Pers.-Nr. 1005' });
    await expect(next).toBeEnabled();
    await click(page, next);
    await expect(page.getByText('Schritt 2 von 2 — Lohnparameter')).toBeVisible();
    await expect(page.getByText('Ahmad Haddad — September 2026')).toBeVisible();
    await click(page, page.getByRole('main').getByRole('button', { name: 'Zurück' }).last());
    await expect(page.getByText('Schritt 1 von 2 — Fahrer & Zeitraum')).toBeVisible();
    await nothingSent(page, errors);
    await context.close();
  });

  await check('Stundennachweis: the tabs switch the fields, clear the error, and keep what was typed', async () => {
    const { page, context, errors } = await open({ screen: 'stundennachweis' });
    await page.getByLabel(/^Fahrer/).selectOption({ index: 1 });
    await click(page, button(page, /^Weiter/));
    // The validator is the page's own: an empty target is refused before anything runs.
    await click(page, button(page, /^Plan generieren/));
    await expect(page.getByText('Bitte einen gültigen Zielbetrag eingeben.')).toBeVisible();
    await page.getByLabel(/^Stundensatz Fahrer/).fill('13,90');
    await click(page, page.getByRole('tab', { name: 'Aus Stunden-Summen' }));
    await expect(page.getByText('Bitte einen gültigen Zielbetrag eingeben.')).toHaveCount(0);
    await expect(page.getByLabel(/^Grundlohn \(Std\.\)/)).toBeVisible();
    await click(page, page.getByRole('tab', { name: 'Aus Gehalt' }));
    await expect(page.getByLabel(/^Stundensatz Fahrer/)).toHaveValue('13,90');
    await nothingSent(page, errors);
    await context.close();
  });

  await check('Stundennachweis: a profile with days but no hours shows its days alone', async () => {
    const { page, context, errors } = await open({ screen: 'stundennachweis' });
    await page.getByLabel(/^Fahrer/).selectOption({ label: 'Thomas Wendt — Pers.-Nr. 1007' });
    await click(page, button(page, /^Weiter/));
    await expect(page.getByText('Mo–Fr', { exact: true })).toBeVisible();
    await expect(page.getByText('Kein Arbeitszeitfenster im Fahrerprofil hinterlegt.')).toHaveCount(0);
    await nothingSent(page, errors);
    await context.close();
  });

  await check('Stundennachweis: "Plan generieren" computes the sheet in memory and saves nothing', async () => {
    const { page, context, errors } = await open({ screen: 'stundennachweis' });
    await page.getByLabel(/^Fahrer/).selectOption({ label: 'Ahmad Haddad — Pers.-Nr. 1005' });
    await click(page, button(page, /^Weiter/));
    await page.getByLabel(/^Grundlohn Zielbetrag/).fill('2150');
    await page.getByLabel(/^Stundensatz Fahrer/).fill('13,90');
    await click(page, button(page, /^Plan generieren/));
    await expect(page.getByText(/^Ahmad Haddad — September 2026/)).toBeVisible();
    // Not from the archive, so the save button offers to save, not to update.
    await expect(button(page, 'Speichern')).toBeVisible();
    await expect(page.getByText('Gespeicherte Version')).toHaveCount(0);
    await nothingSent(page, errors);
    await context.close();
  });

  await check('Stundennachweis: an archived sheet opens with its actions, and back leads to step 2', async () => {
    const { page, context, errors } = await open({ screen: 'stundennachweis', entry: 'archiv' });
    await expect(button(page, 'Aktualisieren')).toBeEnabled();
    await expect(button(page, 'Als PDF exportieren')).toBeEnabled();
    await expect(page.getByText(/Zuletzt gespeichert: 08\.09\.2026, 14:32/)).toBeVisible();
    await click(page, page.getByRole('main').getByRole('button', { name: 'Zurück' }).first());
    await expect(page.getByText('Schritt 2 von 2 — Lohnparameter')).toBeVisible();
    await nothingSent(page, errors);
    await context.close();
  });

  // ── On a phone ─────────────────────────────────────────────────────────────

  for (const [name, query, act] of [
    ['Dokumente', { screen: 'dokumente' }, null],
    ['Monatsplanung, Phase 1', { screen: 'monatsplanung' }, page => click(page, button(page, 'Neue Planung starten'))],
    ['Stundennachweis, step 1', { screen: 'stundennachweis' }, null],
  ]) {
    await check(`375 px touch: ${name} fits the screen and its controls are finger-sized`, async () => {
      const { page, context, errors } = await open(query, true);
      if (act) await act(page);
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      if (width > 375) throw new Error(`page is ${width} px wide`);
      const small = await page.evaluate(() =>
        [...document.querySelectorAll('main .font-ui button, main .font-ui select, main .font-ui input')]
          .filter(el => el.offsetParent !== null && el.type !== 'checkbox')
          .map(el => ({ name: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30), h: el.getBoundingClientRect().height }))
          .filter(({ h }) => h < 40),
      );
      if (small.length) throw new Error(`below 40 px: ${JSON.stringify(small.slice(0, 5))}`);
      await nothingSent(page, errors);
      await context.close();
    });
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(results.join('\n'));
const failed = results.filter(line => line.startsWith('FAIL')).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
