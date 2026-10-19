#!/usr/bin/env node
/**
 * The Abrechnung's hand-over confirmation, clicked through on the harness's
 * invented month (19.10.2026).
 *
 *   node design-harness/flows-handover.mjs
 *
 * What it proves, each ending on what was written: the popup opens on the row's
 * Difference, a changed amount is stored as typed, 0 is a real answer apart from
 * no record, the status is derived and never stored, the monthly view sums the
 * weeks, a record that cannot be read claims no status, a viewer is not offered
 * the action, and nothing but `abrechnung_handovers` is ever written. It needs
 * the e2e package's Playwright (npm install in e2e/ once).
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
const check = async (name, fn) => {
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
  });
  await context.clock.install({ time: new Date('2026-09-14T10:00:00+02:00') });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${ORIGIN}/design-harness/?${new URLSearchParams({ theme: 'light', lang: 'de', screen: 'abrechnung', ...query })}`, { waitUntil: 'domcontentloaded', timeout: 600_000 });
  await page.waitForFunction(() => window.__harness && window.__harness.answered > 0 && window.__harness.pending === 0, null, { timeout: 60_000 });
  await page.waitForTimeout(300);
  return { page, context, errors };
}
const idle = async page => {
  await page.waitForTimeout(250);
  await page.waitForFunction(() => window.__harness.pending === 0);
  await page.waitForTimeout(250);
};
const writes = page => page.evaluate(() => window.__harness.writes);
/** Ahmad Haddad's row of the newest week: the first table on the page. */
const ahmad = page => page.locator('[role="region"] tbody tr', { hasText: 'Ahmad Haddad' }).first();
const openDialog = async page => {
  await ahmad(page).getByRole('button', { name: 'Rückgabe von Ahmad Haddad bestätigen' }).click();
  return page.getByRole('dialog');
};
const confirmAmount = async (page, text) => {
  const dialog = await openDialog(page);
  await dialog.getByLabel('Übergebener Betrag').fill(text);
  await dialog.getByRole('button', { name: 'Bestätigen' }).click();
  await idle(page);
};

try {
  await check('the popup opens on the row\'s Difference and says it is a record only', async () => {
    const { page, context, errors } = await open({});
    await expect(ahmad(page)).toContainText('Noch beim Fahrer');
    const dialog = await openDialog(page);
    await expect(dialog.getByRole('heading', { name: 'Rückgabe des Bargelds bestätigen' })).toBeVisible();
    await expect(dialog.getByLabel('Übergebener Betrag')).toHaveValue('218,01');
    await expect(dialog).toContainText('Der Bargeldbestand ändert sich dadurch nicht');
    if ((await writes(page)).length) throw new Error('opening the popup wrote something');
    if (errors.length) throw new Error(errors.join('; '));
    await context.close();
  });

  await check('a changed amount is stored as typed and the status is derived: partial, with the rest', async () => {
    const { page, context } = await open({});
    await confirmAmount(page, '100,00');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(ahmad(page)).toContainText('Teilweise');
    await expect(ahmad(page)).toContainText('Rest 118,01 €');
    await expect(ahmad(page)).toContainText('100,00 €');
    const w = await writes(page);
    if (w.length !== 1 || w[0].table !== 'abrechnung_handovers' || w[0].op !== 'upsert') throw new Error(JSON.stringify(w));
    const p = w[0].payload;
    if (p.amount !== '100.00' || p.week_number !== 4 || p.driver_name !== 'Ahmad Haddad' || p.year !== 2026 || p.month !== 9) throw new Error(JSON.stringify(p));
    if ('status' in p) throw new Error('a status was written');
    await context.close();
  });

  await check('0 is an answer: shown as 0,00 €, still with the driver, and apart from no record', async () => {
    const { page, context } = await open({});
    await expect(ahmad(page)).toContainText('—');
    await confirmAmount(page, '0');
    await expect(ahmad(page)).toContainText('0,00 €');
    await expect(ahmad(page)).toContainText('Noch beim Fahrer');
    const w = await writes(page);
    if (w.length !== 1 || w[0].payload.amount !== '0.00') throw new Error(JSON.stringify(w));
    await context.close();
  });

  await check('the full amount reads Übergeben; a second confirmation replaces the first in place', async () => {
    const { page, context } = await open({});
    await confirmAmount(page, '100,00');
    await confirmAmount(page, '218,01');
    await expect(ahmad(page)).toContainText('Übergeben');
    await expect(ahmad(page)).not.toContainText('Rest');
    const w = await writes(page);
    if (w.length !== 2 || w.some(x => x.payload.week_number !== 4)) throw new Error(JSON.stringify(w));
    await context.close();
  });

  await check('an amount that is not an amount is refused in the popup and writes nothing', async () => {
    const { page, context } = await open({});
    const dialog = await openDialog(page);
    await dialog.getByLabel('Übergebener Betrag').fill('abc');
    await dialog.getByRole('button', { name: 'Bestätigen' }).click();
    await expect(dialog).toContainText('Bitte einen gültigen Betrag eingeben');
    await expect(page.getByRole('dialog')).toHaveCount(1);
    if ((await writes(page)).length) throw new Error('a write was sent');
    await context.close();
  });

  await check('the monthly view sums the weeks and derives against the monthly Difference', async () => {
    const { page, context } = await open({});
    await confirmAmount(page, '100,00');
    await page.getByRole('tab', { name: 'Monatlich' }).click();
    await idle(page);
    const row = page.locator('[role="region"] tbody tr', { hasText: 'Ahmad Haddad' }).first();
    await expect(row).toContainText('100,00 €');
    await expect(row).toContainText('Teilweise');
    await expect(page.getByText('Bestätigt wird in der Wochenansicht')).toBeVisible();
    await expect(row.getByRole('button', { name: /Rückgabe von/ })).toHaveCount(0);
    await context.close();
  });

  await check('hand-overs that cannot be read claim no status for anybody', async () => {
    const { page, context } = await open({ data: 'handovers-fail' });
    await expect(page.getByText(/Solange die Abrechnung nicht geladen ist/)).toBeVisible();
    await expect(page.getByText('Noch beim Fahrer')).toHaveCount(0);
    await expect(page.getByText('Übergeben')).toHaveCount(0);
    await context.close();
  });

  await check('a viewer is not offered the action, and still sees the status', async () => {
    const { page, context } = await open({ role: 'viewer' });
    await expect(page.getByRole('button', { name: /Rückgabe von/ })).toHaveCount(0);
    await expect(ahmad(page)).toContainText('Noch beim Fahrer');
    await context.close();
  });

  await check('the till is untouched: only abrechnung_handovers is ever written', async () => {
    const { page, context } = await open({});
    await confirmAmount(page, '50,00');
    await confirmAmount(page, '0');
    const tables = new Set((await writes(page)).map(x => x.table));
    if (tables.size !== 1 || !tables.has('abrechnung_handovers')) throw new Error([...tables].join(','));
    await context.close();
  });

  await check('Phone: no sideways scroll, and both row actions are on screen and 40 px tall', async () => {
    const { page, context } = await open({}, true);
    const pageOver = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (pageOver > 0) throw new Error(`the page scrolls ${pageOver}px sideways`);
    const tableOver = await page.locator('[role="region"]').first().evaluate(el => el.scrollWidth - el.clientWidth);
    if (tableOver > 0) throw new Error(`the table scrolls ${tableOver}px`);
    for (const name of [/^Rückgabe von /, /^Details: /]) {
      const box = await page.getByRole('button', { name }).first().boundingBox();
      if (!box || box.x + box.width > 375 || box.height < 40) throw new Error(`${name}: ${JSON.stringify(box)}`);
    }
    await context.close();
  });
} finally {
  await browser.close();
  await server.close();
}
console.log(`\n${results.filter(line => line.startsWith('ok')).length} of ${results.length} passed`);
if (results.some(line => line.startsWith('FAIL'))) process.exitCode = 1;
