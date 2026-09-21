#!/usr/bin/env node
/**
 * Screenshots of /impressum and /datenschutz, filled and empty, into
 * Docs/design/legal-pages/.
 *
 *   node design-harness/capture-legal.mjs
 *
 * Renders design-harness/legal.html (the production LegalPageView on invented
 * data) through the harness's Vite config, in the installed Chrome driven by the
 * e2e package's Playwright — the same setup as capture.mjs. Each state is taken
 * on a laptop in light and on a touch phone in dark, which between them show
 * the widest and the narrowest layout and both themes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const e2eRequire = createRequire(join(root, 'e2e', 'package.json'));
const outDir = join(root, 'Docs', 'design', 'legal-pages');

const VARIANTS = [
  { width: 1280, theme: 'light' },
  { width: 375, theme: 'dark' },
];

const SHOTS = [
  { name: 'impressum', query: { page: 'impressum', data: 'filled' } },
  { name: 'impressum-leer', query: { page: 'impressum', data: 'empty' } },
  { name: 'datenschutz', query: { page: 'datenschutz', data: 'filled' } },
  { name: 'datenschutz-leer', query: { page: 'datenschutz', data: 'empty' } },
  // The English UI: the one-line note, and the German document under it.
  { name: 'impressum-en', query: { page: 'impressum', data: 'filled', lang: 'en' }, variants: [{ width: 375, theme: 'light' }] },
  { name: 'datenschutz-fehler', query: { page: 'datenschutz', data: 'error' }, variants: [{ width: 375, theme: 'light' }] },
];

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
  configFile: join(root, 'design-harness', 'vite.config.ts'),
  logLevel: 'warn',
  server: { strictPort: false },
});
await server.listen();
const origin = new URL(server.resolvedUrls.local[0]).origin;

const { chromium } = e2eRequire('@playwright/test');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--lang=de-DE'] });
const encoder = await browser.newPage();

mkdirSync(outDir, { recursive: true });
const problems = [];
let taken = 0;

try {
  for (const shot of SHOTS) {
    for (const { width, theme } of shot.variants ?? VARIANTS) {
      const file = `${width}-${theme}-${shot.name}.webp`;
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
      const page = await context.newPage();
      page.on('pageerror', error => problems.push(`${file}: ${error.message}`));
      page.on('console', message => {
        if (message.type() === 'error') problems.push(`${file}: console: ${message.text()}`);
      });

      const query = new URLSearchParams({ theme, lang: 'de', ...shot.query });
      await page.goto(`${origin}/design-harness/legal.html?${query}`, { waitUntil: 'load', timeout: 90_000 });
      await page.waitForSelector('h1', { timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);

      // No sideways scroll at any width: the page must fit its viewport.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) problems.push(`${file}: scrolls sideways by ${overflow}px`);

      const png = await page.screenshot({ fullPage: true, animations: 'disabled' });
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
  console.log(`\n${problems.length} problems:`);
  for (const problem of problems) console.log(`  ${problem}`);
  process.exitCode = 1;
}
