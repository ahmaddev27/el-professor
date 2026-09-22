#!/usr/bin/env node
/**
 * Phase 5 batch 2: what the Excel exports contain, cell by cell.
 *
 *   node design-harness/exports-batch2.mjs [--root <checkout>] [--out <file.json>]
 *
 * The Gehälter and Bargeldbestand dumps are not statutory and follow the UI
 * language, but a look-only change must leave their content alone. This
 * clicks each export in the harness, reads the downloaded workbook and prints
 * one digest per export. Run it once with `--root` on a worktree of the base
 * and once here: equal digests mean equal files, apart from the one thing
 * that differs between any two runs — the export's own timestamp, a cell
 * holding a date and a clock time, which is masked.
 *
 * `--root` renders another checkout's screens with this script, as capture.mjs
 * does, so both runs use the same browser, clock and parser.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const arg = name => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const renderRoot = resolve(arg('root') ?? ownRoot);
const out = arg('out');
const require = createRequire(join(ownRoot, 'package.json'));
const XLSX = require('xlsx');
const { createServer } = await import(pathToFileURL(join(ownRoot, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href);
const { chromium } = createRequire(join(ownRoot, 'e2e', 'package.json'))('@playwright/test');

const FIXED_NOW = new Date('2026-09-14T10:00:00+02:00');
const STAMP = /^\d{1,2}\.\d{1,2}\.\d{4},? \d{1,2}:\d{2}(:\d{2})?$/;

const EXPORTS = [
  { name: 'gehaelter', query: { screen: 'gehaelter' }, click: page => page.getByRole('button', { name: 'Excel exportieren' }).click() },
  { name: 'bargeld', query: { screen: 'bargeld' }, click: page => page.locator('button[title="Aktuelle Ansicht als Excel exportieren"]').click() },
  {
    name: 'bargeld-oktober',
    query: { screen: 'bargeld' },
    before: async page => {
      await page.locator('input[type="month"]').first().fill('2026-10');
      await page.waitForTimeout(300);
      await page.waitForFunction(() => window.__harness.pending === 0);
      await page.waitForTimeout(300);
    },
    click: page => page.locator('button[title="Aktuelle Ansicht als Excel exportieren"]').click(),
  },
  // The billing reader: no ledger, and the dump says so in its filter summary.
  { name: 'bargeld-billing', query: { screen: 'bargeld', role: 'billing' }, click: page => page.locator('button[title="Aktuelle Ansicht als Excel exportieren"]').click() },
];

function readWorkbook(path) {
  const workbook = XLSX.readFile(path);
  return workbook.SheetNames.map(name => ({
    name,
    rows: XLSX.utils
      .sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: '' })
      .map(row => row.map(cell => (STAMP.test(String(cell).trim()) ? '<timestamp>' : cell))),
  }));
}

const server = await createServer({
  configFile: join(renderRoot, 'design-harness', 'vite.config.ts'),
  logLevel: 'warn',
  server: { strictPort: false },
});
await server.listen();
const origin = new URL(server.resolvedUrls.local[0]).origin;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--lang=de-DE'] });
const results = {};

try {
  for (const entry of EXPORTS) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'de-DE', timezoneId: 'Europe/Berlin', acceptDownloads: true });
    await context.clock.install({ time: FIXED_NOW });
    const page = await context.newPage();
    const query = new URLSearchParams({ theme: 'light', lang: 'de', ...entry.query });
    await page.goto(`${origin}/design-harness/?${query}`, { waitUntil: 'domcontentloaded', timeout: 600_000 });
    await page.waitForFunction(() => window.__harness && window.__harness.answered > 0 && window.__harness.pending === 0, null, { timeout: 60_000 });
    await page.waitForTimeout(400);
    if (entry.before) await entry.before(page);
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), entry.click(page)]);
    const sheets = readWorkbook(await download.path());
    const digest = createHash('sha256').update(JSON.stringify(sheets)).digest('hex').slice(0, 16);
    results[entry.name] = { file: download.suggestedFilename(), digest, sheets };
    console.log(`${entry.name.padEnd(16)} ${digest}  ${download.suggestedFilename()}  ${sheets.map(s => `${s.name}: ${s.rows.length} rows`).join(', ')}`);
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}

if (out) writeFileSync(out, JSON.stringify(results, null, 2));
