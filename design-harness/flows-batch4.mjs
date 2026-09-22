#!/usr/bin/env node
/**
 * Clicks the batch-4 screens through in the harness: every write, every
 * refusal, and what each screen sends.
 *
 *   npm run harness:batch4:flows
 *
 * The harness answers every request itself (design-harness/batch4) and records
 * each write in `window.__harness.writes`, with its target and body, so a check
 * can say "the new-user form sent manage-users/create with no password" rather
 * than only "a dialog appeared". The selectors the e2e suite uses on staging
 * are checked here too, on the same screens, and so is every screen's width at
 * 375 (a touch phone), 768 and 1280.
 *
 * Nothing leaves the machine. Exit code 1 if a check fails.
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const e2eRequire = createRequire(join(root, 'e2e', 'package.json'));
const { chromium, expect } = e2eRequire('@playwright/test');

const FIXED_NOW = new Date('2026-09-14T10:00:00+02:00');
const results = [];

const server = await createServer({
  configFile: join(root, 'design-harness', 'batch4', 'vite.config.ts'),
  logLevel: 'warn',
  server: { strictPort: false },
});
await server.listen();
const origin = new URL(server.resolvedUrls.local[0]).origin;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--lang=de-DE'] });

/** A fresh page on a scenario, settled. */
async function open(query, { width = 1280, clock = true } = {}) {
  const phone = width < 768;
  const context = await browser.newContext({
    viewport: { width, height: phone ? 812 : 900 },
    isMobile: phone,
    hasTouch: phone,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    reducedMotion: 'reduce',
  });
  if (clock) await context.clock.install({ time: FIXED_NOW });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const params = new URLSearchParams({ theme: 'light', lang: 'de', ...query });
  await page.goto(`${origin}/design-harness/batch4/?${params}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await settle(page);
  return { page, context, errors };
}

async function settle(page) {
  await page.waitForFunction(() => window.__harness && window.__harness.pending === 0, null, { timeout: 15_000 });
  await page.waitForTimeout(250);
}

const writes = page => page.evaluate(() => window.__harness.writes);
const lastWrite = async (page, target) => (await writes(page)).filter(write => write.target.includes(target)).at(-1);

/** One attempt on a fresh page; the error, or null when it passed. */
async function attempt(query, body, options) {
  let opened;
  try {
    opened = await open(query, options);
  } catch (error) {
    return new Error(`the page did not load: ${String(error.message).split('\n')[0]}`);
  }
  const { page, context, errors } = opened;
  try {
    await body(page);
    if (errors.length > 0) throw new Error(`page error: ${errors[0]}`);
    return null;
  } catch (error) {
    return error;
  } finally {
    await context.close();
  }
}

/**
 * A check fails when it fails twice, each time on a fresh page: the harness
 * machine is shared with other builds, and a click that times out under load
 * once is not a finding. A pass on the second attempt is printed as such, so a
 * flake stays visible instead of being hidden.
 */
async function check(name, query, body, options) {
  const first = await attempt(query, body, options);
  const second = first ? await attempt(query, body, options) : null;
  const ok = !first || !second;
  results.push({ name, ok });
  if (!first) console.log(`  ok    ${name}`);
  else if (!second) console.log(`  ok    ${name} (second attempt; the first: ${String(first.message ?? first).split('\n')[0]})`);
  else console.log(`  FAIL  ${name}\n        ${String(second.message ?? second).split('\n')[0]}`);
}

const signIn = async page => {
  await page.locator('input[type="email"]').fill('katrin.lindner@example.com');
  await page.locator('input[type="password"]').fill('ein-falsches-passwort');
  await page.locator('form button[type="submit"]').click();
  await settle(page);
};

// ─── /login: what the e2e suite relies on, and every refusal ─────────────────

console.log('\nSign-in');
await check('the e2e selectors on /login: one email, one password, one submit, one heading "Anmelden", one button named exactly "Anmelden"', { screen: 'login' }, async page => {
  await expect(page.locator('input[type="email"]')).toHaveCount(1);
  await expect(page.locator('input[type="password"]')).toHaveCount(1);
  await expect(page.locator('form button[type="submit"]')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Anmelden', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Mit Google anmelden' })).toHaveCount(0);
});
await check('the staging banner shows above the sign-in card', { screen: 'login', env: 'staging' }, async page => {
  await expect(page.getByText('Testumgebung mit einer Kopie der Produktionsdaten', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible();
});
await check('with Google on, the Google button shows under the form and outside it', { screen: 'login', google: 'on' }, async page => {
  await expect(page.getByRole('button', { name: 'Mit Google anmelden' })).toBeVisible();
  await expect(page.locator('form button')).toHaveCount(2); // the eye and the submit
});
const REFUSALS = [
  ['invalid', 'Ungültige E-Mail-Adresse oder Passwort'],
  ['blocked', 'deaktiviert'],
  ['too-many', 'Zu viele Anmeldeversuche'],
  ['network', 'Netzwerkfehler'],
  ['generic', 'Anmeldung nicht möglich'],
];
for (const [signin, words] of REFUSALS) {
  await check(`refusal "${signin}": signIn is called with the address and the sentence shows as an alert`, { screen: 'login', signin }, async page => {
    await signIn(page);
    await expect(page.getByRole('alert')).toContainText(words);
    expect((await lastWrite(page, 'auth'))?.payload?.email).toBe('katrin.lindner@example.com');
    await expect(page.getByRole('button', { name: 'E-Mail-Adresse jetzt bestätigen' })).toHaveCount(0);
  });
}
await check('refusal "unconfirmed": the sentence and its CTA, which opens /auth/verify-email with the address', { screen: 'login', signin: 'unconfirmed' }, async page => {
  await signIn(page);
  await expect(page.getByRole('alert')).toContainText('noch nicht bestätigt');
  await page.getByRole('button', { name: 'E-Mail-Adresse jetzt bestätigen' }).click();
  await settle(page);
  await expect(page.locator('#verify-email')).toHaveValue('katrin.lindner@example.com');
});
await check('a Google refusal left by AuthContext shows on mount', { screen: 'login', notice: 'platform-google' }, async page => {
  await expect(page.getByRole('alert')).toContainText('Verwaltungskonten melden sich nur mit E-Mail und Passwort an');
});
await check('the eye shows and hides the password', { screen: 'login' }, async page => {
  await page.getByRole('button', { name: 'Passwort anzeigen' }).click();
  await expect(page.locator('input[type="text"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Passwort verbergen' }).click();
  await expect(page.locator('input[type="password"]')).toHaveCount(1);
});
await check('English: the sign-in reads "Sign in"', { screen: 'login', lang: 'en' }, async page => {
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

// ─── Password reset, the code, the new password ──────────────────────────────

console.log('\nPassword reset and codes');
await check('forgot password: a malformed address is refused without a request', { screen: 'forgot' }, async page => {
  await page.locator('input[type="email"]').fill('keine-adresse');
  await page.getByRole('button', { name: 'Code senden' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await lastWrite(page, 'otp-request')).toBeUndefined();
});
await check('forgot password: the request, the uniform notice, the wrong code, the right code, the hand-off', { screen: 'forgot' }, async page => {
  await page.locator('input[type="email"]').fill('Katrin.Lindner@example.com ');
  await page.getByRole('button', { name: 'Code senden' }).click();
  await settle(page);
  expect((await lastWrite(page, 'otp-request')).payload).toEqual({ purpose: 'password_reset', email: 'katrin.lindner@example.com' });
  await expect(page.getByText('Falls ein Konto zu dieser Adresse existiert')).toBeVisible();
  await page.getByLabel('Ziffer 1 von 6').click();
  await page.keyboard.type('000000');
  await settle(page);
  await expect(page.getByText('Noch 3 Versuche.')).toBeVisible();
  await page.getByLabel('Ziffer 1 von 6').click();
  await page.keyboard.type('482913');
  await settle(page);
  expect((await lastWrite(page, 'handoff')).payload.destination).toBe('/auth/set-password');
  await expect(page.locator('input[type="password"]')).toHaveCount(2);
});
await check('set password: a mismatch is refused, a match saves and says "Passwort gespeichert"', { screen: 'set-password' }, async page => {
  const fields = page.locator('input[type="password"]');
  await fields.nth(0).fill('Sicher-und-lang-1');
  await fields.nth(1).fill('Sicher-und-lang-2');
  await page.getByRole('button', { name: 'Passwort speichern' }).click();
  await expect(page.getByRole('alert')).toContainText('stimmen nicht überein');
  expect(await lastWrite(page, 'auth')).toBeUndefined();
  await fields.nth(1).fill('Sicher-und-lang-1');
  await page.getByRole('button', { name: 'Passwort speichern' }).click();
  await settle(page);
  await expect(page.getByText('Passwort gespeichert')).toBeVisible();
  expect((await lastWrite(page, 'auth')).op).toBe('updateUser');
  expect((await lastWrite(page, 'user_profiles')).payload).toEqual({ must_change_password: false });
});
await check('set password for an invitation activates the profile', { screen: 'set-password', invite: '1' }, async page => {
  const fields = page.locator('input[type="password"]');
  await fields.nth(0).fill('Sicher-und-lang-1');
  await fields.nth(1).fill('Sicher-und-lang-1');
  await page.getByRole('button', { name: 'Zugang aktivieren' }).click();
  await settle(page);
  expect((await lastWrite(page, 'user_profiles')).payload.status).toBe('active');
});
await check('set password without a session offers a new code', { screen: 'set-password', session: 'none' }, async page => {
  await page.getByRole('button', { name: 'Neuen Code anfordern' }).click();
  await settle(page);
  await expect(page.getByRole('button', { name: 'Code senden' })).toBeVisible();
});
await check('verify email: the address from the sign-in form, and a signup_verify request', { screen: 'verify-email' }, async page => {
  await page.getByRole('button', { name: 'Code senden' }).click();
  await settle(page);
  expect((await lastWrite(page, 'otp-request')).payload).toEqual({ purpose: 'signup_verify', email: 'katrin.lindner@example.com' });
  await expect(page.getByLabel('Ziffer 1 von 6')).toBeVisible();
});
await check('invitation: the code from the mail link hands off to /auth/set-password', { screen: 'invite' }, async page => {
  await page.getByLabel('Ziffer 1 von 6').click();
  await page.keyboard.type('482913');
  await settle(page);
  const verify = await lastWrite(page, 'otp-verify');
  expect(verify.payload.purpose).toBe('invite_activate');
  expect(verify.payload.email).toBe('katrin.nowak@example.com'.replace('katrin.', 'katarzyna.'));
  expect((await lastWrite(page, 'handoff')).payload.destination).toBe('/auth/set-password');
});
await check('invitation while another account is signed in: sign out first', { screen: 'invite', session: 'other' }, async page => {
  await expect(page.getByText('andere.person@example.com')).toBeVisible();
  await page.getByRole('button', { name: /Abmelden und/ }).click();
  await settle(page);
  expect((await lastWrite(page, 'auth')).op).toBe('signOut');
});

// ─── Registration ────────────────────────────────────────────────────────────

console.log('\nRegistration');
await check('signup: three steps, then company-signup with the chosen tier and no discount, then the code', { screen: 'signup' }, async page => {
  await page.getByRole('button', { name: /^Premium/ }).click();
  await page.getByRole('button', { name: /^Weiter mit Premium/ }).click();
  await expect(page.locator('form button[type="submit"]')).toBeDisabled();
  await page.getByPlaceholder('Muster GmbH').fill('Taxi Brandt & Söhne');
  await page.locator('form button[type="submit"]').click();
  await page.getByPlaceholder('Max Mustermann').fill('Lukas Brandt');
  await page.locator('input[type="email"]').fill('lukas.brandt@example.com');
  await page.locator('input[type="password"]').fill('Sicher-und-lang-1');
  await page.locator('form button[type="submit"]').click();
  await settle(page);
  const body = (await lastWrite(page, 'company-signup')).payload;
  expect(body).toMatchObject({ company_name: 'Taxi Brandt & Söhne', full_name: 'Lukas Brandt', email: 'lukas.brandt@example.com', plan: 'premium', billing_cycle: 'monthly', subscription_car_limit: 3, discount_code: null, referral_code: null });
  await expect(page.getByLabel('Ziffer 1 von 6')).toBeVisible();
});
await check('signup: a discount code is checked, applied, shown in the price and removed when the tier changes', { screen: 'signup' }, async page => {
  await page.getByLabel('Rabattcode').fill('falsch');
  await page.getByRole('button', { name: 'Anwenden' }).click();
  await settle(page);
  await expect(page.getByText('ungültig oder abgelaufen')).toBeVisible();
  await page.getByLabel('Rabattcode').fill('herbst10');
  await page.getByRole('button', { name: 'Anwenden' }).click();
  await settle(page);
  await expect(page.getByText('HERBST10').first()).toBeVisible();
  await page.getByRole('button', { name: /^Basic/ }).click();
  await expect(page.getByText('HERBST10')).toHaveCount(0);
});
await check('Google registration: register sends the form, then the waiting page', { screen: 'complete-registration' }, async page => {
  await page.locator('#gsignup-company').fill('Taxi Brandt & Söhne');
  await page.getByRole('button', { name: /Unternehmen registrieren|Registrieren/ }).click();
  await settle(page);
  const body = (await lastWrite(page, 'oauth-account')).payload;
  expect(body).toMatchObject({ action: 'register', company_name: 'Taxi Brandt & Söhne', plan: 'premium', billing_cycle: 'yearly', subscription_car_limit: 6 });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Registrierung eingegangen');
});
await check('Google registration: discarding asks first, then deletes the account and signs out', { screen: 'complete-registration' }, async page => {
  await page.getByRole('button', { name: /Konto löschen|löschen/i }).first().click();
  await page.getByRole('button', { name: 'Ja' }).click();
  await settle(page);
  expect((await lastWrite(page, 'oauth-account')).payload.action).toBe('discard');
});
await check('an expired mail link offers a new link and the sign-in', { screen: 'callback' }, async page => {
  await expect(page.getByRole('button', { name: /Neuen Link anfordern/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Zurück zur Anmeldung/ })).toBeVisible();
});

// ─── The takeovers ──────────────────────────────────────────────────────────

console.log('\nTakeovers');
for (const screen of ['blocked', 'pending', 'rejected', 'suspended']) {
  await check(`${screen}: one h1, the support address, and sign-out`, { screen }, async page => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'support@el-professor.de' })).toHaveAttribute('href', 'mailto:support@el-professor.de');
    await page.getByRole('button', { name: 'Abmelden' }).click();
    expect((await lastWrite(page, 'auth')).op).toBe('signOut');
  });
}
await check('rejected: the stored reason is shown', { screen: 'rejected' }, async page => {
  await expect(page.getByText('Konzessionsurkunde')).toBeVisible();
});

// ─── Benutzer ────────────────────────────────────────────────────────────────

console.log('\nBenutzer');
// The form resets itself when its role list arrives (UserModal's own effect,
// unchanged), so each flow waits for the list before typing, as a person would.
await check('a new user by invitation: manage-users/create without a password, then the result', { screen: 'users' }, async page => {
  await page.getByRole('button', { name: 'Neuer Benutzer' }).click();
  await settle(page);
  await page.getByLabel(/Name/).first().fill('Lukas Brandt');
  await page.getByLabel(/E-Mail/).first().fill('lukas.brandt@example.com');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await settle(page);
  const body = (await lastWrite(page, 'manage-users/create')).payload;
  expect(body).toMatchObject({ email: 'lukas.brandt@example.com', full_name: 'Lukas Brandt' });
  expect('password' in body).toBe(false);
  await expect(page.getByRole('dialog')).toContainText('Lukas Brandt');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
await check('a new user with a temporary password: the password is sent, and a short one is not', { screen: 'users' }, async page => {
  await page.getByRole('button', { name: 'Neuer Benutzer' }).click();
  await settle(page);
  await page.getByLabel(/Name/).first().fill('Lukas Brandt');
  await page.getByLabel(/E-Mail/).first().fill('lukas.brandt@example.com');
  await page.locator('#mode-temp').check();
  await page.locator('input[type="password"]').fill('kurz');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await settle(page);
  expect(await lastWrite(page, 'manage-users/create')).toBeUndefined();
  await page.locator('input[type="password"]').fill('Sicher-und-lang-1');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await settle(page);
  expect((await lastWrite(page, 'manage-users/create')).payload).toMatchObject({ password: 'Sicher-und-lang-1', use_temp_password: true });
});
// A defect older than this batch, kept as it is (look only; HANDOFF.md has
// it): the form sends `password: undefined` when editing, handleEditUser calls
// `userData.password.trim()` on it, and the catch shows "unexpected error". So
// saving an edit never reaches manage-users/update. This check pins that it
// still behaves exactly so.
await check('edit, as it always has: the unexpected-error dialog and no update call (a recorded defect)', { screen: 'users' }, async page => {
  await page.getByRole('button', { name: 'Svenja Krüger bearbeiten' }).click();
  await settle(page);
  await expect(page.getByLabel(/Name/).first()).toHaveValue('Svenja Krüger');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await settle(page);
  expect(await lastWrite(page, 'manage-users/update')).toBeUndefined();
  await expect(page.getByRole('alertdialog')).toContainText('Ein unerwarteter Fehler ist aufgetreten.');
});
await check('delete asks, then sends manage-users/delete, then says so', { screen: 'users' }, async page => {
  await page.getByRole('button', { name: 'Svenja Krüger löschen' }).click();
  await page.getByRole('button', { name: 'Bestätigen' }).click();
  await settle(page);
  expect((await lastWrite(page, 'manage-users/delete')).payload.user_id).toMatch(/a2$/);
  await expect(page.getByRole('dialog')).toContainText('Svenja Krüger');
});
await check('deactivate and resend invitation send their calls; the resend cooldown is reported', { screen: 'users' }, async page => {
  await page.getByRole('button', { name: 'Svenja Krüger deaktivieren' }).click();
  await settle(page);
  expect((await lastWrite(page, 'activate-deactivate')).payload).toMatchObject({ status: 'inactive' });
  await page.getByRole('button', { name: 'OK' }).click();
  await page.getByRole('button', { name: 'Einladung an Katarzyna Nowak erneut senden' }).click();
  await settle(page);
  await expect(page.getByRole('alertdialog')).toContainText('42');
});
await check('desktop: no reset-password action and no password-change badge in the table, as before', { screen: 'users' }, async page => {
  await expect(page.getByRole('button', { name: /Passwort.*zurücksetzen/ })).toHaveCount(0);
  // The phone cards are in the page at every width and hidden on a laptop.
  await expect(page.getByText('Passwortänderung erforderlich')).toBeHidden();
  await expect(page.getByRole('table')).toContainText('Jonas Albrecht');
}, { width: 1280 });
await check('phone: reset password is offered, refuses 7 characters, sends 8', { screen: 'users' }, async page => {
  await expect(page.getByText('Passwortänderung erforderlich')).toBeVisible();
  await page.getByRole('button', { name: 'Passwort für Svenja Krüger zurücksetzen' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input').fill('1234567');
  await expect(dialog.getByRole('button', { name: 'Passwort zurücksetzen' })).toBeDisabled();
  await dialog.locator('input').fill('12345678');
  await dialog.getByRole('button', { name: 'Passwort zurücksetzen' }).click();
  await settle(page);
  expect((await lastWrite(page, 'reset-password')).payload).toMatchObject({ password: '12345678' });
}, { width: 375 });
await check('a read context refuses the screen and offers nothing', { screen: 'users', scope: 'view' }, async page => {
  await expect(page.getByText('Nur-Lese-Ansicht').last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Neuer Benutzer' })).toHaveCount(0);
});
await check('a viewer is refused with its role named', { screen: 'users', role: 'viewer' }, async page => {
  await expect(page.getByText('viewer')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Neuer Benutzer' })).toHaveCount(0);
});
await check('a failed list load reports the error', { screen: 'users', data: 'error' }, async page => {
  await expect(page.getByRole('alertdialog')).toBeVisible();
});
await check('the Datensicherung tab', { screen: 'users' }, async page => {
  await page.getByRole('tab', { name: 'Datensicherung' }).click();
  await expect(page.getByRole('button', { name: /Backup/ })).toBeVisible();
});

// ─── Rollen ──────────────────────────────────────────────────────────────────

console.log('\nRollen');
await check('a new role: an empty name is refused; edit implies view; save writes the role and its permissions', { screen: 'roles' }, async page => {
  await page.getByRole('button', { name: 'Neue Rolle' }).click();
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await page.locator('#role-name').fill('Buchhaltung');
  const edit = page.getByRole('checkbox', { name: /Belege: Bearbeiten/ });
  const view = page.getByRole('checkbox', { name: /Belege: Ansehen/ });
  await edit.check();
  await expect(view).toBeChecked();
  await view.uncheck();
  await expect(edit).not.toBeChecked();
  await edit.check();
  await page.getByRole('button', { name: 'Speichern' }).click();
  await settle(page);
  expect((await lastWrite(page, 'roles')).payload).toMatchObject({ name: 'Buchhaltung' });
  const permissions = (await lastWrite(page, 'role_permissions')).payload;
  expect(permissions.find(row => row.page_key === 'receipts')).toMatchObject({ can_view: true, can_edit: true });
});
await check('a system role cannot be deleted; the custom one asks first', { screen: 'roles' }, async page => {
  await expect(page.getByRole('button', { name: 'Rolle admin löschen' })).toBeDisabled();
  await page.getByRole('button', { name: 'Rolle Disponent löschen' }).click();
  await page.getByRole('button', { name: 'Löschen' }).last().click();
  await settle(page);
  expect((await lastWrite(page, 'roles')).op).toBe('delete');
});
await check('a read context offers no write', { screen: 'roles', scope: 'view' }, async page => {
  await expect(page.getByRole('button', { name: 'Neue Rolle' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /bearbeiten$/ })).toHaveCount(0);
});

// ─── Einstellungen ───────────────────────────────────────────────────────────

console.log('\nEinstellungen');
await check('save sends the form and the drivers-per-car limit; Zurücksetzen restores', { screen: 'settings' }, async page => {
  await page.getByLabel('Firmenname').fill('Stadttaxi Lindner & Co.');
  await page.getByLabel('Fahrer pro Fahrzeug').selectOption('6');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await settle(page);
  expect((await lastWrite(page, 'company_settings')).payload).toMatchObject({ company_name: 'Stadttaxi Lindner & Co.', drivers_per_car_limit: 6 });
  await page.getByLabel('Slogan').fill('verworfen');
  await page.getByRole('button', { name: 'Zurücksetzen' }).click();
  await expect(page.getByLabel('Slogan')).not.toHaveValue('verworfen');
});
await check('a read context: every field and both buttons are disabled, under a note', { screen: 'settings', scope: 'view' }, async page => {
  await expect(page.getByText('nur in einer Support-Sitzung ändern')).toBeVisible();
  await expect(page.getByLabel('Firmenname')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Speichern' })).toBeDisabled();
  await expect(page.locator('#logo-upload')).toBeDisabled();
});

// ─── Abonnement ──────────────────────────────────────────────────────────────

console.log('\nAbonnement');
await check('six digits preview the code; redeeming calls redeem_activation_code, refreshes the plan, then goes to /billing', { screen: 'activation', data: 'inactive' }, async page => {
  await page.locator('input[inputmode="numeric"]').fill('731904');
  await settle(page);
  await expect(page.getByText('3 Monate')).toBeVisible();
  await page.locator('form button[type="submit"]').click();
  await settle(page);
  expect((await lastWrite(page, 'rpc:redeem_activation_code')).payload).toEqual({ input_code: '731904' });
  expect((await lastWrite(page, 'plan')).op).toBe('refresh');
  await expect(page.getByText('Abo erfolgreich aktiviert')).toBeVisible();
  await page.clock.runFor(2500);
  await settle(page);
  await expect(page.getByRole('heading', { name: 'Abonnement' })).toBeVisible();
}, { clock: true });
await check('a wrong code is refused; five refusals block the field', { screen: 'activation', data: 'inactive' }, async page => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.locator('input[inputmode="numeric"]').fill(`11111${attempt}`);
    await page.locator('form button[type="submit"]').click();
    await settle(page);
  }
  await expect(page.getByText('Zu viele Versuche')).toBeVisible();
  await expect(page.locator('input[inputmode="numeric"]')).toBeDisabled();
});
await check('billing, active: the status, the days left, the history with the current code first', { screen: 'billing' }, async page => {
  await expect(page.getByText('Aktiv').first()).toBeVisible();
  // 01.10. 10:00 from a clock that started at 14.09. 10:00 and has run on:
  // differenceInDays floors it to 16, as the old screen did.
  await expect(page.getByText('16 Tage').first()).toBeVisible();
  await expect(page.getByText('Aktuell aktiv')).toBeVisible();
});
await check('billing, expired: the CTA opens /abo-aktivieren', { screen: 'billing', data: 'expired' }, async page => {
  await page.getByRole('button', { name: /aktivieren/i }).first().click();
  await settle(page);
  await expect(page.getByRole('heading', { name: 'Abo aktivieren' })).toBeVisible();
});
await check('billing, inactive with history: the note, and the history kept', { screen: 'billing', data: 'history' }, async page => {
  await expect(page.getByText('Aktuell aktiv')).toHaveCount(0);
  await expect(page.locator('table tbody tr')).toHaveCount(3);
});

// ─── Width ───────────────────────────────────────────────────────────────────

console.log('\nWidth');
const SCREENS = ['login', 'forgot', 'verify-email', 'set-password', 'invite', 'signup', 'complete-registration', 'callback',
  'blocked', 'pending', 'rejected', 'suspended', 'users', 'roles', 'settings', 'activation', 'billing'];
for (const width of [375, 768, 1280]) {
  for (const lang of ['de', 'en']) {
    if (lang === 'en' && width !== 375) continue;
    const wide = [];
    for (const screen of SCREENS) {
      const { page, context } = await open({ screen, lang, env: 'staging' }, { width });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) wide.push(`${screen} +${overflow}px`);
      await context.close();
    }
    const name = `no screen wider than ${width} px${width < 768 ? ' (touch)' : ''}, ${lang === 'de' ? 'German' : 'English'}, staging banner on`;
    results.push({ name, ok: wide.length === 0 });
    console.log(`  ${wide.length === 0 ? 'ok  ' : 'FAIL'}  ${name}${wide.length ? `: ${wide.join(', ')}` : ''}`);
  }
}

await browser.close();
await server.close();

const failed = results.filter(result => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks pass`);
process.exitCode = failed.length === 0 ? 0 : 1;
