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
 *
 * `--root <dir>` renders another checkout's screens with this script, e.g. a
 * `git worktree` of the commit before a batch, so both sets come from the same
 * harness and the same browser settings. That checkout needs node_modules and
 * e2e/node_modules (a directory junction to this one's is enough).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
// Batch 3 waits for its chained reads with its own quiet(); this file has one for the DOM.
import { quiet as quietBatch3 } from './batch3/shots.mjs';

const args = process.argv.slice(2);
const arg = name => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The checkout whose screens are rendered; the shots always land in this one. */
const renderRoot = resolve(arg('root') ?? ownRoot);
const e2eRequire = createRequire(join(ownRoot, 'e2e', 'package.json'));
const set = arg('set');
const batch = arg('batch') ?? 'batch1';
// Several name parts, comma-separated, retake several shots under one server start.
const only = arg('only')?.split(',').filter(Boolean);
if (set !== 'before' && set !== 'after') {
  console.error('usage: node design-harness/capture.mjs --set before|after [--batch batch1] [--only <name part>[,<name part>…]]');
  process.exit(2);
}

/** The design preview's PREVIEW_TODAY, mid-morning in Berlin. */
const FIXED_NOW = new Date('2026-09-14T10:00:00+02:00');
const WIDTHS = [375, 768, 1280];
const THEMES = ['light', 'dark'];
const outDir = join(ownRoot, 'Docs', 'design', 'phase5', batch, set);

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

const BATCH1_SHOTS = [
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
  // The English UI, once per screen: labels grow, and German-only words must not leak.
  { name: 'fahrzeuge-en', query: { screen: 'fahrzeuge', lang: 'en' }, variants: [{ width: 1280, theme: 'light' }] },
  { name: 'fixkosten-en', query: { screen: 'fixkosten', lang: 'en' }, variants: [{ width: 375, theme: 'light' }] },
];

// A later batch keeps its list in its own module, design-harness/shots-<batch>.mjs.
const SHOTS = batch === 'batch1' ? BATCH1_SHOTS : (await import(`./shots-${batch}.mjs`)).SHOTS;

const allVariants = WIDTHS.flatMap(width => THEMES.map(theme => ({ width, theme })));

async function settle(page) {
  // Generous: the first page of a run can be reloaded once by Vite while it
  // optimizes dependencies, and batch 3's pages are large.
  await page.waitForFunction(() => window.__harness && window.__harness.answered > 0 && window.__harness.pending === 0, null, {
    timeout: 180_000,
  });
  await page.evaluate(() => document.fonts.ready);
  await quiet(page);
}

/**
 * Until the page has not changed for half a second (at most ten seconds).
 * The answered queries are not the last render: the Gehälter screen commits
 * one frame with the new salary rows and the previous calculations before its
 * effect recomputes them — every stored driver briefly flagged as overlapping,
 * every figure 0,00 € — and on a machine short of memory a fixed pause caught
 * that frame.
 */
async function quiet(page) {
  await page.evaluate(
    () =>
      new Promise(resolve => {
        let timer = setTimeout(done, 500);
        const cap = setTimeout(done, 10_000);
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(done, 500);
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        function done() {
          observer.disconnect();
          clearTimeout(timer);
          clearTimeout(cap);
          resolve();
        }
      }),
  );
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

const server = await createServer({
  configFile: join(renderRoot, 'design-harness', 'vite.config.ts'),
  logLevel: 'warn',
  // Vite's dependency cache defaults to node_modules/.vite. Worktrees that link
  // node_modules to one checkout would share it, and one harness run rewriting
  // it reloads another's pages mid-shot; each checkout gets its own.
  cacheDir: join(tmpdir(), 'el-professor-harness', createHash('sha1').update(renderRoot).digest('hex').slice(0, 12)),
  // Another harness may hold the port; take the next free one.
  server: { strictPort: false },
});
await server.listen();
const origin = new URL(server.resolvedUrls.local[0]).origin;

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
      if (only && !only.some(part => file.includes(part))) continue;

      // A phone is a touch screen: the 375 px shots emulate one, so a coarse
      // pointer grows the controls as it does on a real phone. 768 and 1280
      // keep a mouse, the densest layout a tablet or laptop can show.
      const phone = width < 768;
      const context = await browser.newContext({
        viewport: { width, height: phone ? 812 : 900 },
        isMobile: phone,
        hasTouch: phone,
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

      const query = new URLSearchParams({ theme, lang: 'de', ...shot.query });
      // The first visit waits for Vite to transform the whole module graph,
      // which on a machine short of memory has taken more than five minutes.
      // `load` is not awaited: with the clock installed it can stall, and
      // settle() below is the real readiness test.
      // Batch 3's pages pull in the planning wizards, several megabytes of source.
      await page.goto(`${origin}/design-harness/?${query}`, { waitUntil: 'domcontentloaded', timeout: 600_000 });
      await settle(page);
      if (shot.act) {
        await shot.act(page);
        await page.waitForTimeout(500);
      }
      // Batch 3's screens chain their reads; wait until none has been pending for a while.
      if (batch === 'batch3') await quietBatch3(page);

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
