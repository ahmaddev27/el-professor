#!/usr/bin/env node
/**
 * Screenshots of the harnessed screens, for a phase 5 before/after comparison.
 *
 *   npm run harness:capture -- --set before          all shots into Docs/design/phase5/<batch>/before/
 *   npm run harness:capture -- --set after --only fixkosten
 *
 * It starts the harness's Vite server itself, drives the installed Chrome
 * through the e2e package's Playwright (run `npm install` in e2e/ once), pins
 * the clock to the design preview's "today" so TÜV countdowns never drift, and
 * writes WebP at quality 0.9 — the audit's format, a fifth of a PNG's size.
 *
 * Every shot is a full page at 375, 768 or 1280 CSS pixels, light and dark,
 * except the dialogs, which are the viewport (a dialog is fixed to it).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const e2eRequire = createRequire(join(root, 'e2e', 'package.json'));

const args = process.argv.slice(2);
const arg = name => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const set = arg('set');
const batch = arg('batch') ?? 'batch1';
const only = arg('only');
if (set !== 'before' && set !== 'after') {
  console.error('usage: node design-harness/capture.mjs --set before|after [--batch batch1] [--only <name part>]');
  process.exit(2);
}

/** The design preview's PREVIEW_TODAY, mid-morning in Berlin. */
const FIXED_NOW = new Date('2026-09-14T10:00:00+02:00');
const WIDTHS = [375, 768, 1280];
const THEMES = ['light', 'dark'];
const outDir = join(root, 'Docs', 'design', 'phase5', batch, set);

const openAdd = page => page.getByRole('button', { name: /^(Neues Fahrzeug|Fahrzeug hinzufügen)$/ }).first().click();
const openFirstDelete = page => page.getByRole('button', { name: /löschen$/i }).first().click();
const openAddCost = page => page.getByRole('button', { name: /^Neue Fixkosten hinzufügen$/ }).first().click();
const openFirstEdit = page => page.getByRole('button', { name: /bearbeiten$/i }).first().click();

/**
 * One entry per picture. `variants` defaults to every width and theme; a state
 * shot is taken at a laptop in light and a phone in dark, which between them
 * show the widest and the narrowest layout and both themes.
 */
const STATE_VARIANTS = [
  { width: 1280, theme: 'light' },
  { width: 375, theme: 'dark' },
];

const SHOTS = [
  { name: 'fahrzeuge', query: { screen: 'fahrzeuge' } },
  { name: 'fixkosten', query: { screen: 'fixkosten' } },
  { name: 'fahrzeuge-formular', query: { screen: 'fahrzeuge' }, act: openAdd, dialog: true, variants: STATE_VARIANTS },
  { name: 'fahrzeuge-loeschen', query: { screen: 'fahrzeuge' }, act: openFirstDelete, dialog: true, variants: STATE_VARIANTS },
  { name: 'fahrzeuge-limit', query: { screen: 'fahrzeuge', data: 'limit' }, variants: STATE_VARIANTS },
  { name: 'fahrzeuge-leer', query: { screen: 'fahrzeuge', data: 'empty' }, variants: STATE_VARIANTS },
  { name: 'fixkosten-neu', query: { screen: 'fixkosten' }, act: openAddCost, variants: STATE_VARIANTS },
  { name: 'fixkosten-bearbeiten', query: { screen: 'fixkosten' }, act: openFirstEdit, variants: STATE_VARIANTS },
  { name: 'fixkosten-loeschen', query: { screen: 'fixkosten' }, act: openFirstDelete, dialog: true, variants: STATE_VARIANTS },
  { name: 'fixkosten-nur-lesen', query: { screen: 'fixkosten', role: 'viewer' }, variants: STATE_VARIANTS },
  { name: 'fixkosten-leer', query: { screen: 'fixkosten', data: 'empty' }, variants: STATE_VARIANTS },
  { name: 'fixkosten-fehler', query: { screen: 'fixkosten', data: 'missing' }, variants: STATE_VARIANTS },
];

const allVariants = WIDTHS.flatMap(width => THEMES.map(theme => ({ width, theme })));

async function settle(page) {
  await page.waitForFunction(() => window.__harness && window.__harness.answered > 0 && window.__harness.pending === 0, null, {
    timeout: 15_000,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
}

/** PNG bytes to WebP, encoded by the same Chrome that took them. */
async function toWebp(encoder, png) {
  const dataUrl = await encoder.evaluate(async base64 => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas.toDataURL('image/webp', 0.9);
  }, png.toString('base64'));
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

const server = await createServer({ configFile: join(here, 'vite.config.ts'), logLevel: 'warn' });
await server.listen();
const origin = `http://localhost:${server.config.server.port}`;

const { chromium } = e2eRequire('@playwright/test');
// A date field formats by the browser's own UI language, not the page's
// locale: without --lang an English Chrome shows mm/dd/yyyy on a German screen.
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--lang=de-DE'] });
const encoder = await browser.newPage();

mkdirSync(outDir, { recursive: true });
let taken = 0;
const problems = [];

try {
  for (const shot of SHOTS) {
    for (const { width, theme } of shot.variants ?? allVariants) {
      const file = `${width}-${theme}-${shot.name}.webp`;
      if (only && !file.includes(only)) continue;

      const context = await browser.newContext({
        viewport: { width, height: width < 768 ? 812 : 900 },
        deviceScaleFactor: 1,
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
        reducedMotion: 'reduce',
      });
      // install(), not setFixedTime(): a clock that never moves hangs anything
      // that waits for Date.now() to pass a deadline. This one starts at
      // FIXED_NOW and runs.
      await context.clock.install({ time: FIXED_NOW });
      const page = await context.newPage();
      page.on('pageerror', error => problems.push(`${file}: ${error.message}`));
      page.on('console', message => {
        if (message.type() === 'error') problems.push(`${file}: console: ${message.text()}`);
      });

      const query = new URLSearchParams({ ...shot.query, theme, lang: 'de' });
      // The first visit waits for Vite to transform the whole module graph.
      // `load` is not awaited: with the clock installed it can stall, and
      // settle() below is the real readiness test.
      await page.goto(`${origin}/design-harness/?${query}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await settle(page);
      if (shot.act) {
        await shot.act(page);
        await page.waitForTimeout(500);
      }

      const png = await page.screenshot({ fullPage: !shot.dialog, animations: 'disabled' });
      writeFileSync(join(outDir, file), await toWebp(encoder, png));
      taken += 1;
      console.log(`  ${file}`);
      await context.close();
    }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${taken} screenshots in ${outDir}`);
if (problems.length > 0) {
  console.log(`\n${problems.length} page errors:`);
  for (const problem of problems) console.log(`  ${problem}`);
}
