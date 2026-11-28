/**
 * Design remake, batch R3: Mein Konto, as a company user and as a platform account.
 *
 *   node design-harness/capture.mjs --set after --batch r3 --widths 1440,375 --out Docs/design/remake-v2
 *
 * One page, so the extra shots scroll a section into view rather than open anything.
 * Sections are found by their visible heading, which old and converted markup share.
 */
const scrollTo = re => page =>
  page.getByRole('heading', { name: re }).first().scrollIntoViewIfNeeded();

export const SHOTS = [
  { name: 'r3-konto', query: { screen: 'r3-konto' } },
  { name: 'r3-konto-email', query: { screen: 'r3-konto' }, act: scrollTo(/E-Mail/i) },
  { name: 'r3-konto-passwort', query: { screen: 'r3-konto' }, act: scrollTo(/Passwort/i) },
  { name: 'r3-konto-passkeys', query: { screen: 'r3-konto' }, act: scrollTo(/Passkey/i) },
  { name: 'r3-konto-plattform', query: { screen: 'r3-konto-plattform' } },
];
