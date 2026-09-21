#!/usr/bin/env node
/**
 * Screenshots of the batch-4 screens, before and after they move onto the
 * design system.
 *
 *   npm run harness:batch4:capture -- --set before
 *   npm run harness:batch4:capture -- --set after --only login
 *
 * The mechanics are batch 1's (design-harness/capture.mjs): the harness's own
 * Vite server, the installed Chrome through the e2e package's Playwright, a
 * clock pinned to the design preview's day, WebP at quality 0.9. It is a copy
 * rather than an import because that script is being extended by other batches
 * at the same time and has no module boundary to import across.
 *
 * Every main shot is taken at 375, 768 and 1280 in light and dark; a state is
 * taken at a laptop in light and a phone in dark. The 375 px shots are a touch
 * phone. `--root <dir>` renders another checkout with this script.
 *
 * An `act` that finds nothing to click (a control the legacy screen does not
 * have at that width) is reported and the shot is taken as it stands, so the
 * before set shows what the old screen offered there.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const arg = name => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const renderRoot = resolve(arg('root') ?? ownRoot);
const e2eRequire = createRequire(join(ownRoot, 'e2e', 'package.json'));
const set = arg('set');
const only = arg('only');
if (set !== 'before' && set !== 'after') {
  console.error('usage: node design-harness/batch4/capture.mjs --set before|after [--only <name part>] [--root <dir>]');
  process.exit(2);
}

const FIXED_NOW = new Date('2026-09-14T10:00:00+02:00');
const WIDTHS = [375, 768, 1280];
const THEMES = ['light', 'dark'];
const outDir = join(ownRoot, 'Docs', 'design', 'phase5', 'batch4', set);

const STATE_VARIANTS = [
  { width: 1280, theme: 'light' },
  { width: 375, theme: 'dark' },
];
const ONE = [{ width: 1280, theme: 'light' }];

// ─── Acts: what is clicked before a state shot ────────────────────────────────

const signIn = async page => {
  await page.locator('input[type="email"]').fill('katrin.lindner@example.com');
  await page.locator('input[type="password"]').fill('ein-falsches-passwort');
  await page.locator('form button[type="submit"]').click();
  await page.getByRole('alert').first().waitFor({ timeout: 5_000 });
};

const requestCode = async page => {
  await page.locator('input[type="email"]').fill('katrin.lindner@example.com');
  await page.getByRole('button', { name: 'Code senden' }).click();
  await page.getByLabel('Ziffer 1 von 6').waitFor({ timeout: 5_000 });
};

const wrongCode = async page => {
  await requestCode(page);
  await page.getByLabel('Ziffer 1 von 6').click();
  await page.keyboard.type('000000');
  await page.getByText('Noch 3 Versuche.').waitFor({ timeout: 5_000 });
};

const passwordFields = page => page.locator('input[type="password"]');

const mismatch = async page => {
  await passwordFields(page).nth(0).fill('Sicher-und-lang-1');
  await passwordFields(page).nth(1).fill('Sicher-und-lang-2');
  await page.locator('form button[type="submit"]').click();
};

const savePassword = async page => {
  await passwordFields(page).nth(0).fill('Sicher-und-lang-1');
  await passwordFields(page).nth(1).fill('Sicher-und-lang-1');
  await page.locator('form button[type="submit"]').click();
  await page.getByText('Passwort gespeichert').waitFor({ timeout: 5_000 });
};

const toCompanyStep = page => page.getByRole('button', { name: /^Weiter mit / }).click();
const toAccountStep = async page => {
  await toCompanyStep(page);
  await page.getByPlaceholder('Muster GmbH').fill('Taxi Brandt & Söhne');
  await page.locator('form button[type="submit"]').click();
};
const toVerifyStep = async page => {
  await toAccountStep(page);
  await page.getByPlaceholder('Max Mustermann').fill('Lukas Brandt');
  await page.locator('input[type="email"]').fill('lukas.brandt@example.com');
  await page.locator('input[type="password"]').fill('Sicher-und-lang-1');
  await page.locator('form button[type="submit"]').click();
  await page.getByLabel('Ziffer 1 von 6').waitFor({ timeout: 5_000 });
};

const openNewUser = page => page.getByRole('button', { name: 'Neuer Benutzer' }).first().click();
const openResetPassword = page => page.getByRole('button', { name: /Passwort zurücksetzen/ }).first().click();
const openFirstDelete = page => page.getByRole('button', { name: /löschen$/i }).first().click();
const openBackups = page => page.getByRole('tab', { name: 'Datensicherung' }).or(page.getByRole('button', { name: 'Datensicherung' })).first().click();
const openRoleEdit = page => page.getByRole('button', { name: /bearbeiten$/i }).nth(4).click();
const openRoleDelete = page => page.getByRole('button', { name: /löschen$/i }).last().click();

const typeActivationCode = code => async page => {
  await page.locator('input[inputmode="numeric"]').fill(code);
  await page.waitForTimeout(400);
};
const redeem = code => async page => {
  await typeActivationCode(code)(page);
  await page.locator('form button[type="submit"]').click();
};

// ─── The shot list ───────────────────────────────────────────────────────────

const SHOTS = [
  // Sign-in, with every refusal LoginForm can show.
  { name: 'login', query: { screen: 'login' } },
  { name: 'login-staging', query: { screen: 'login', env: 'staging' }, variants: STATE_VARIANTS },
  { name: 'login-fehler-zugangsdaten', query: { screen: 'login', signin: 'invalid' }, act: signIn, variants: STATE_VARIANTS },
  { name: 'login-fehler-gesperrt', query: { screen: 'login', signin: 'blocked' }, act: signIn, variants: STATE_VARIANTS },
  { name: 'login-fehler-unbestaetigt', query: { screen: 'login', signin: 'unconfirmed' }, act: signIn, variants: STATE_VARIANTS },
  { name: 'login-fehler-zu-viele', query: { screen: 'login', signin: 'too-many' }, act: signIn, variants: STATE_VARIANTS },
  { name: 'login-fehler-netzwerk', query: { screen: 'login', signin: 'network' }, act: signIn, variants: STATE_VARIANTS },
  { name: 'login-fehler-allgemein', query: { screen: 'login', signin: 'generic' }, act: signIn, variants: STATE_VARIANTS },
  { name: 'login-hinweis-google', query: { screen: 'login', notice: 'platform-google' }, variants: STATE_VARIANTS },
  { name: 'login-google', query: { screen: 'login', google: 'on' }, variants: STATE_VARIANTS },
  { name: 'login-en', query: { screen: 'login', lang: 'en' }, variants: ONE },
  // Password reset: the address, the code, a wrong code, then the new password.
  { name: 'passwort-vergessen', query: { screen: 'forgot' } },
  { name: 'passwort-vergessen-code', query: { screen: 'forgot' }, act: requestCode },
  { name: 'passwort-vergessen-falscher-code', query: { screen: 'forgot' }, act: wrongCode, variants: STATE_VARIANTS },
  { name: 'passwort-setzen', query: { screen: 'set-password' } },
  { name: 'passwort-setzen-fehler', query: { screen: 'set-password' }, act: mismatch, variants: STATE_VARIANTS },
  { name: 'passwort-setzen-gespeichert', query: { screen: 'set-password' }, act: savePassword, variants: STATE_VARIANTS },
  { name: 'passwort-setzen-einladung', query: { screen: 'set-password', invite: '1' }, variants: STATE_VARIANTS },
  { name: 'passwort-setzen-ohne-sitzung', query: { screen: 'set-password', session: 'none' }, variants: STATE_VARIANTS },
  { name: 'email-bestaetigen', query: { screen: 'verify-email' }, variants: STATE_VARIANTS },
  { name: 'einladung', query: { screen: 'invite' }, variants: STATE_VARIANTS },
  { name: 'einladung-anderes-konto', query: { screen: 'invite', session: 'other' }, variants: STATE_VARIANTS },
  { name: 'einladung-google', query: { screen: 'invite', google: 'on' }, variants: ONE },
  // Registration, both ways in.
  { name: 'registrierung', query: { screen: 'signup' } },
  { name: 'registrierung-firma', query: { screen: 'signup' }, act: toCompanyStep, variants: STATE_VARIANTS },
  { name: 'registrierung-konto', query: { screen: 'signup' }, act: toAccountStep, variants: STATE_VARIANTS },
  { name: 'registrierung-code', query: { screen: 'signup' }, act: toVerifyStep, variants: STATE_VARIANTS },
  { name: 'registrierung-google', query: { screen: 'complete-registration' }, variants: STATE_VARIANTS },
  { name: 'registrierung-google-einladung', query: { screen: 'complete-registration', intent: 'invite' }, variants: ONE },
  { name: 'link-abgelaufen', query: { screen: 'callback' }, variants: STATE_VARIANTS },
  // The takeovers App.tsx shows instead of any screen.
  { name: 'konto-gesperrt', query: { screen: 'blocked' } },
  { name: 'freigabe-ausstehend', query: { screen: 'pending' } },
  { name: 'abgelehnt', query: { screen: 'rejected' } },
  { name: 'gesperrt', query: { screen: 'suspended' } },
  // Benutzer.
  { name: 'benutzer', query: { screen: 'users' } },
  { name: 'benutzer-formular', query: { screen: 'users' }, act: openNewUser, dialog: true, variants: STATE_VARIANTS },
  { name: 'benutzer-passwort', query: { screen: 'users' }, act: openResetPassword, dialog: true, variants: STATE_VARIANTS },
  { name: 'benutzer-loeschen', query: { screen: 'users' }, act: openFirstDelete, dialog: true, variants: STATE_VARIANTS },
  { name: 'benutzer-datensicherung', query: { screen: 'users' }, act: openBackups, variants: STATE_VARIANTS },
  { name: 'benutzer-nur-lesen', query: { screen: 'users', scope: 'view' }, variants: STATE_VARIANTS },
  { name: 'benutzer-support', query: { screen: 'users', scope: 'support' }, variants: ONE },
  { name: 'benutzer-kein-zugriff', query: { screen: 'users', role: 'viewer' }, variants: STATE_VARIANTS },
  { name: 'benutzer-fehler', query: { screen: 'users', data: 'error' }, dialog: true, variants: STATE_VARIANTS },
  { name: 'benutzer-en', query: { screen: 'users', lang: 'en' }, variants: ONE },
  // Rollen.
  { name: 'rollen', query: { screen: 'roles' } },
  { name: 'rollen-formular', query: { screen: 'roles' }, act: openRoleEdit, dialog: true, variants: STATE_VARIANTS },
  { name: 'rollen-loeschen', query: { screen: 'roles' }, act: openRoleDelete, dialog: true, variants: STATE_VARIANTS },
  { name: 'rollen-nur-lesen', query: { screen: 'roles', scope: 'view' }, variants: STATE_VARIANTS },
  // Einstellungen.
  { name: 'einstellungen', query: { screen: 'settings' } },
  { name: 'einstellungen-nur-lesen', query: { screen: 'settings', scope: 'view' }, variants: STATE_VARIANTS },
  { name: 'einstellungen-en', query: { screen: 'settings', lang: 'en' }, variants: [{ width: 375, theme: 'light' }] },
  // Abonnement.
  { name: 'abo-aktivieren', query: { screen: 'activation', data: 'inactive' } },
  { name: 'abo-aktivieren-vorschau', query: { screen: 'activation', data: 'inactive' }, act: typeActivationCode('731904'), variants: STATE_VARIANTS },
  { name: 'abo-aktivieren-fehler', query: { screen: 'activation', data: 'inactive' }, act: redeem('111111'), variants: STATE_VARIANTS },
  { name: 'abo-aktivieren-erfolg', query: { screen: 'activation', data: 'inactive' }, act: redeem('731904'), variants: STATE_VARIANTS },
  { name: 'abonnement', query: { screen: 'billing' } },
  { name: 'abonnement-abgelaufen', query: { screen: 'billing', data: 'expired' }, variants: STATE_VARIANTS },
  { name: 'abonnement-inaktiv', query: { screen: 'billing', data: 'inactive' }, variants: STATE_VARIANTS },
  { name: 'abonnement-inaktiv-verlauf', query: { screen: 'billing', data: 'history' }, variants: STATE_VARIANTS },
  { name: 'abonnement-en', query: { screen: 'billing', lang: 'en' }, variants: ONE },
];

const allVariants = WIDTHS.flatMap(width => THEMES.map(theme => ({ width, theme })));

async function settle(page) {
  await page.waitForFunction(() => window.__harness && window.__harness.pending === 0, null, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
}

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
  configFile: join(renderRoot, 'design-harness', 'batch4', 'vite.config.ts'),
  logLevel: 'warn',
  server: { strictPort: false },
});
await server.listen();
const origin = new URL(server.resolvedUrls.local[0]).origin;

const { chromium } = e2eRequire('@playwright/test');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--lang=de-DE'] });
const encoder = await browser.newPage();

mkdirSync(outDir, { recursive: true });
let taken = 0;
const problems = [];
const skipped = [];

try {
  for (const shot of SHOTS) {
    for (const { width, theme } of shot.variants ?? allVariants) {
      const file = `${width}-${theme}-${shot.name}.webp`;
      if (only && !file.includes(only)) continue;

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
      await context.clock.install({ time: FIXED_NOW });
      const page = await context.newPage();
      page.on('pageerror', error => problems.push(`${file}: ${error.message}`));
      page.on('console', message => {
        if (message.type() === 'error') problems.push(`${file}: console: ${message.text()}`);
      });

      const query = new URLSearchParams({ theme, lang: 'de', ...shot.query });
      await page.goto(`${origin}/design-harness/batch4/?${query}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await settle(page);
      if (shot.act) {
        try {
          await shot.act(page);
          await settle(page);
          await page.waitForTimeout(400);
        } catch (error) {
          skipped.push(`${file}: ${String(error.message ?? error).split('\n')[0]}`);
        }
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
if (skipped.length > 0) {
  console.log(`\n${skipped.length} acts found nothing to do (shot taken as it stands):`);
  for (const line of skipped) console.log(`  ${line}`);
}
if (problems.length > 0) {
  console.log(`\n${problems.length} page errors:`);
  for (const problem of problems) console.log(`  ${problem}`);
}
