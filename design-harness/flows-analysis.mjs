#!/usr/bin/env node
/**
 * The Fahrtenanalyse, clicked through (Fahrtenbuch plan, slice D).
 *
 *   node design-harness/flows-analysis.mjs
 *
 * The screen's whole point is that it explains without changing anything, so
 * most of these checks end the same way: **no write named `fahrtenbuch_trips`,
 * ever**, and for the read-only paths no write at all. The three writes the
 * screen does have — the company's two analysis settings, a driver's reserve
 * and the explicit confirmation of a month's budget — are each checked for
 * exactly what they send, including that the confirmation sends no salary or
 * hourly rate: the snapshot is the database's to take
 * (`app_private.driver_month_budget_guard`), and a browser that sent one would
 * be asserting a figure it did not read under lock.
 *
 * It needs the e2e package's Playwright (npm install in e2e/ once).
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { quiet } from './shots-analysis.mjs';

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
  await page.goto(
    `${ORIGIN}/design-harness/?${new URLSearchParams({ theme: 'light', lang: 'de', screen: 'fahrtenanalyse', ...query })}`,
    { waitUntil: 'domcontentloaded', timeout: 300_000 },
  );
  await page.waitForFunction(() => window.__harness && window.__harness.answered > 0, null, { timeout: 180_000 });
  await quiet(page);
  return { page, context, errors };
}

const writes = page => page.evaluate(() => window.__harness.writes.map(w => ({ table: w.table, op: w.op, payload: w.payload })));

/** The boundary, checked after every flow: no statement of any kind against a trip. */
async function noTripWrite(page, errors) {
  const sent = await writes(page);
  const trips = sent.filter(w => w.table === 'fahrtenbuch_trips');
  if (trips.length) throw new Error(`wrote fahrtenbuch_trips: ${JSON.stringify(trips)}`);
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  return sent;
}

/** A flow that only drew. */
async function nothingSent(page, errors) {
  const sent = await noTripWrite(page, errors);
  if (sent.length) throw new Error(`sent ${JSON.stringify(sent)}`);
}

const button = (page, name) => page.getByRole('button', typeof name === 'string' ? { name, exact: true } : { name });
const tab = (page, name) => page.getByRole('tab', { name }).first();
const click = async (page, locator) => {
  await locator.click();
  await quiet(page);
};

try {
  // ── The overview ───────────────────────────────────────────────────────────

  await check('the month opens on the newest Fahrtenbuch, not on today, and names the file it analyses', async () => {
    const { page, context, errors } = await open({});
    await expect(page.locator('input[type="month"]').first()).toHaveValue('2026-08');
    await expect(page.getByText(/2026-08_Fahrtenbuch_Uber\.xlsx/).first()).toBeVisible();
    await nothingSent(page, errors);
    await context.close();
  });

  await check('a month with two files offers the choice, newest first, each named with its import date and row count', async () => {
    const { page, context, errors } = await open({ data: 'two-files' });
    const select = page.getByLabel('Fahrtenbuch-Datei');
    await expect(select.locator('option')).toHaveCount(2);
    // Newest first, and that one is what the screen analyses until another is picked.
    await expect(select.locator('option').first()).toHaveText(/Korrektur\.xlsx · importiert am .* · \d+ Zeilen/);
    await expect(select).toHaveValue('ta-import-2026-08-korrektur');
    await nothingSent(page, errors);
    await context.close();
  });

  await check('the overview counts every row of the file and separates the statuses', async () => {
    const { page, context, errors } = await open({});
    await expect(page.getByText('Zeilen in der Datei')).toBeVisible();
    await expect(page.getByText(/abgeschlossen · .* storniert · .* unbekannt/)).toBeVisible();
    await expect(page.getByText('Prüfungen')).toBeVisible();
    await nothingSent(page, errors);
    await context.close();
  });

  await check('a driver the company does not know is named beside the table, never counted into it', async () => {
    const { page, context, errors } = await open({});
    await expect(page.getByText('Fahrer ohne Zuordnung')).toBeVisible();
    await expect(page.getByText('Gastfahrer Nachtschicht')).toBeVisible();
    await nothingSent(page, errors);
    await context.close();
  });

  await check('the boundary is on the screen in words', async () => {
    const { page, context, errors } = await open({});
    await expect(page.getByText(/Nur Analyse: Diese Seite zeigt und erklärt/)).toBeVisible();
    await nothingSent(page, errors);
    await context.close();
  });

  // ── The tabs and the evidence ──────────────────────────────────────────────

  await check('switching to the driver tab and back writes nothing', async () => {
    const { page, context, errors } = await open({});
    await click(page, tab(page, /^Fahrer$/));
    await expect(page.getByText('Zeitleiste')).toBeVisible();
    await click(page, tab(page, /^Übersicht$/));
    await nothingSent(page, errors);
    await context.close();
  });

  await check('the findings list filters by status and writes nothing', async () => {
    const { page, context, errors } = await open({});
    await click(page, tab(page, /^Befunde$/));
    await click(page, tab(page, /^Konflikt \(/));
    await expect(page.getByRole('table')).toBeVisible();
    await nothingSent(page, errors);
    await context.close();
  });

  await check('a figure opens the trips behind it, and the sheet has no control that edits one', async () => {
    const { page, context, errors } = await open({});
    await click(page, button(page, /Fahrten anzeigen: Zur Prüfung/));
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText(/Die Fahrten so, wie sie importiert wurden/)).toBeVisible();
    const editable = await sheet.locator('input, select, textarea, [contenteditable="true"]').count();
    if (editable > 0) throw new Error(`${editable} editable controls in the evidence sheet`);
    await nothingSent(page, errors);
    await context.close();
  });

  // ── The states that must not be confused ───────────────────────────────────

  await check('a month with no Fahrtenbuch says so and offers the import, rather than showing zeros', async () => {
    const { page, context, errors } = await open({ data: 'empty' });
    await expect(page.getByText('Keine Fahrtenbuch-Datei für diesen Monat')).toBeVisible();
    await expect(page.getByText('Zeilen in der Datei')).toHaveCount(0);
    await nothingSent(page, errors);
    await context.close();
  });

  await check('a failed read shows the failure and no figure at all', async () => {
    const { page, context, errors } = await open({ data: 'error' });
    await expect(page.getByText('Die Fahrtenanalyse konnte nicht geladen werden.')).toBeVisible();
    await expect(page.getByText('Zeilen in der Datei')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Erneut laden/ })).toBeVisible();
    await nothingSent(page, errors);
    await context.close();
  });

  await check('settings nobody decided compute nothing, and the test value is offered and labelled', async () => {
    const { page, context, errors } = await open({ data: 'no-settings' });
    await expect(page.getByText('Die Analyse-Einstellungen sind nicht festgelegt').first()).toBeVisible();
    await expect(page.getByText('Zeilen in der Datei')).toHaveCount(0);
    await click(page, button(page, /Mit Testwert 30 Min\. ansehen/));
    await expect(page.getByText('Zeilen in der Datei')).toBeVisible();
    await expect(page.getByText(/Testwert/).first()).toBeVisible();
    // Looking with the test value stores nothing.
    await nothingSent(page, errors);
    await context.close();
  });

  await check('a driver with no pay figures reads "nicht berechenbar", never 0,00 h', async () => {
    const { page, context, errors } = await open({ data: 'no-budget' });
    await click(page, tab(page, /^Fahrer$/));
    await expect(page.getByText('nicht berechenbar').first()).toBeVisible();
    await nothingSent(page, errors);
    await context.close();
  });

  // ── Who may write ──────────────────────────────────────────────────────────

  await check('a read-only platform view offers no write, and says why', async () => {
    const { page, context, errors } = await open({ role: 'view' });
    await expect(page.getByText(/Nur-Lese-Ansicht: Einstellungen und Monatsbudgets/)).toBeVisible();
    await expect(button(page, 'Festlegen')).toHaveCount(0);
    await click(page, tab(page, /^Fahrer$/));
    await expect(page.getByLabel('Reserve in Stunden')).toHaveCount(0);
    await expect(button(page, 'Monat bestätigen')).toHaveCount(0);
    await nothingSent(page, errors);
    await context.close();
  });

  await check('a viewer of the company offers no write either', async () => {
    const { page, context, errors } = await open({ role: 'viewer' });
    await expect(button(page, 'Festlegen')).toHaveCount(0);
    await click(page, tab(page, /^Fahrer$/));
    await expect(page.getByLabel('Reserve in Stunden')).toHaveCount(0);
    await nothingSent(page, errors);
    await context.close();
  });

  // ── The three writes, each checked for exactly what it sends ───────────────

  await check('saving the settings writes one row of trip_analysis_settings and nothing else', async () => {
    const { page, context, errors } = await open({ data: 'no-settings' });
    await click(page, button(page, 'Festlegen'));
    await page.getByLabel(/^Blockabstand/).fill('45');
    await page.getByLabel(/^Fahrtpuffer/).fill('10');
    await click(page, button(page, 'Speichern'));
    const sent = await noTripWrite(page, errors);
    if (sent.length !== 1 || sent[0].table !== 'trip_analysis_settings' || sent[0].op !== 'upsert') {
      throw new Error(`sent ${JSON.stringify(sent)}`);
    }
    if (sent[0].payload.block_gap_minutes !== 45 || sent[0].payload.travel_margin_minutes !== 10) {
      throw new Error(`payload ${JSON.stringify(sent[0].payload)}`);
    }
    await context.close();
  });

  await check('a blank setting is stored as "not set", never as 0', async () => {
    const { page, context, errors } = await open({ data: 'no-settings' });
    await click(page, button(page, 'Festlegen'));
    await page.getByLabel(/^Blockabstand/).fill('45');
    await click(page, button(page, 'Speichern'));
    const sent = await noTripWrite(page, errors);
    if (sent[0]?.payload.travel_margin_minutes !== null) throw new Error(`payload ${JSON.stringify(sent[0]?.payload)}`);
    await context.close();
  });

  await check('a setting outside its range is refused in the form and sends nothing', async () => {
    const { page, context, errors } = await open({ data: 'no-settings' });
    await click(page, button(page, 'Festlegen'));
    await page.getByLabel(/^Blockabstand/).fill('9999');
    await click(page, button(page, 'Speichern'));
    await expect(page.getByText(/Ganze Minuten von 1 bis 720/)).toBeVisible();
    await nothingSent(page, errors);
    await context.close();
  });

  await check('saving a reserve writes one row of driver_month_budget, with the German decimal read as hours', async () => {
    const { page, context, errors } = await open({});
    await click(page, tab(page, /^Fahrer$/));
    await page.getByLabel('Reserve in Stunden').fill('7,5');
    await click(page, button(page, 'Reserve speichern'));
    const sent = await noTripWrite(page, errors);
    if (sent.length !== 1 || sent[0].table !== 'driver_month_budget') throw new Error(`sent ${JSON.stringify(sent)}`);
    if (sent[0].payload.reserved_hours !== 7.5) throw new Error(`payload ${JSON.stringify(sent[0].payload)}`);
    await context.close();
  });

  await check('confirming a month asks for the confirmation and sends no salary or rate of its own', async () => {
    const { page, context, errors } = await open({ data: 'no-budget' });
    await click(page, tab(page, /^Fahrer$/));
    await click(page, button(page, /Monat bestätigen/));
    const sent = await noTripWrite(page, errors);
    if (sent.length !== 1 || sent[0].table !== 'driver_month_budget') throw new Error(`sent ${JSON.stringify(sent)}`);
    const payload = sent[0].payload;
    if (!payload.confirmed_at) throw new Error('no confirmed_at in the request');
    for (const column of ['planning_min_salary', 'planning_max_salary', 'planning_hourly_rate', 'confirmed_by', 'recompute_log']) {
      if (column in payload) throw new Error(`the browser sent ${column}: that is the database's to write`);
    }
    await context.close();
  });

  // ── The phone ──────────────────────────────────────────────────────────────

  for (const [name, act] of [
    ['the overview', null],
    ['the driver view', page => click(page, tab(page, /^Fahrer$/))],
    ['the findings', page => click(page, tab(page, /^Befunde$/))],
  ]) {
    await check(`375 px touch: ${name} fits the screen and its controls are finger-sized`, async () => {
      const { page, context, errors } = await open({}, true);
      if (act) await act(page);
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      if (width > 375) throw new Error(`page is ${width} px wide`);
      const small = await page.evaluate(() =>
        [...document.querySelectorAll('main .font-ui button, main .font-ui select, main .font-ui input')]
          // A `link` Button is inline text, not a control block: the design
          // system gives it h-auto on a coarse pointer on purpose, so a link
          // inside a sentence is not held to the 40 px rule. Table controls
          // are excluded as in the other batches' flows.
          .filter(el => el.offsetParent !== null && el.type !== 'checkbox' && !el.closest('table'))
          .filter(el => !el.className.includes('underline-offset-4'))
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
