/**
 * Phase 5 batch 2's pictures: Gehälter, Abrechnung and Bargeldbestand.
 *
 *   npm run harness:capture -- --set before --batch batch2 --root <worktree of the base>
 *   npm run harness:capture -- --set after --batch batch2
 *
 * Every act here has to work on the legacy screens as well as the converted
 * ones, because the before set is rendered through the same list: it finds a
 * control by the words on it, never by a class or a structure only one
 * version has.
 */

/** A laptop in light and a phone in dark: the widest and the narrowest layout, and both themes. */
const STATE_VARIANTS = [
  { width: 1280, theme: 'light' },
  { width: 375, theme: 'dark' },
];

const idle = page => page.waitForFunction(() => window.__harness.pending === 0, null, { timeout: 15_000 });

async function afterLoad(page) {
  await page.waitForTimeout(200);
  await idle(page);
  await page.waitForTimeout(300);
}

/** Gehälter: the revenue breakdown of the first driver. */
async function openDriverDetails(page) {
  await page.getByRole('button', { name: /Umsatzdetails/ }).first().click();
  await afterLoad(page);
}

/** Abrechnung: the monthly view. */
async function openMonthly(page) {
  await page.getByText('Monatlich', { exact: true }).first().click();
  await afterLoad(page);
}

/**
 * Abrechnung: the detail of the first driver in the newest week. The legacy
 * row is itself the button; the converted table names its details button.
 */
async function openAbrechnungDetails(page) {
  const named = page.getByRole('button', { name: /^Details: / });
  if ((await named.count()) > 0) await named.first().click();
  else await page.locator('tbody tr').first().click();
  await afterLoad(page);
}

/** Bargeldbestand: October, the month after a Gehaltsquittung that was voided in it. */
async function showOctober(page) {
  await page.locator('input[type="month"]').first().fill('2026-10');
  await afterLoad(page);
}

export const SHOTS = [
  { name: 'gehaelter', query: { screen: 'gehaelter' } },
  { name: 'abrechnung', query: { screen: 'abrechnung' } },
  { name: 'bargeld', query: { screen: 'bargeld' } },

  { name: 'gehaelter-transaktionen', query: { screen: 'gehaelter' }, act: openDriverDetails, dialog: true, variants: STATE_VARIANTS },
  { name: 'gehaelter-nur-lesen', query: { screen: 'gehaelter', role: 'view' }, variants: STATE_VARIANTS },
  { name: 'gehaelter-leer', query: { screen: 'gehaelter', data: 'empty' }, variants: STATE_VARIANTS },
  { name: 'gehaelter-fehler', query: { screen: 'gehaelter', data: 'error' }, variants: STATE_VARIANTS },
  { name: 'gehaelter-fahrer-fehler', query: { screen: 'gehaelter', data: 'drivers-error' }, variants: STATE_VARIANTS },

  { name: 'abrechnung-monatlich', query: { screen: 'abrechnung' }, act: openMonthly, variants: STATE_VARIANTS },
  { name: 'abrechnung-details', query: { screen: 'abrechnung' }, act: openAbrechnungDetails, dialog: true, variants: STATE_VARIANTS },
  { name: 'abrechnung-leer', query: { screen: 'abrechnung', data: 'empty' }, variants: STATE_VARIANTS },
  { name: 'abrechnung-fehler', query: { screen: 'abrechnung', data: 'error' }, variants: STATE_VARIANTS },

  // September holds two Gehaltsquittungen; the second is voided on 02.10., so
  // October carries its Storno and the balance rises by it there.
  { name: 'bargeld-oktober', query: { screen: 'bargeld' }, act: showOctober, variants: STATE_VARIANTS },
  // A billing account inside a view context: no business.read, so the ledger is out of scope.
  { name: 'bargeld-billing', query: { screen: 'bargeld', role: 'billing' }, variants: STATE_VARIANTS },
  { name: 'bargeld-leer', query: { screen: 'bargeld', data: 'empty' }, variants: STATE_VARIANTS },
  { name: 'bargeld-fehler', query: { screen: 'bargeld', data: 'error' }, variants: STATE_VARIANTS },

  // The English UI, once per screen: labels grow, and German-only words must not leak.
  { name: 'gehaelter-en', query: { screen: 'gehaelter', lang: 'en' }, variants: [{ width: 1280, theme: 'light' }] },
  { name: 'abrechnung-en', query: { screen: 'abrechnung', lang: 'en' }, variants: [{ width: 768, theme: 'light' }] },
  { name: 'bargeld-en', query: { screen: 'bargeld', lang: 'en' }, variants: [{ width: 375, theme: 'light' }] },
];
