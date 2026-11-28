/**
 * Design remake, batch R4: the platform panel, in the production AdminLayout, as an `owner`.
 *
 *   node design-harness/capture.mjs --set before --batch r4 --widths 1440,375 --out Docs/design/remake-v2
 *
 * A before set is shot from the unconverted tree, so every act finds its control by
 * role and visible text, which both generations of markup carry, never by a class.
 * Dashboard tabs and tab rows are plain buttons in the old markup and `role=tab`
 * in a converted one; `tabOrButton` accepts either.
 */

/** A tab or a button with this name, whichever the markup is. */
const tabOrButton = name => page =>
  page.locator('[role="tab"], button').filter({ hasText: name }).first().click();

const clickButton = name => page => page.getByRole('button', { name }).first().click();

const DIALOG = true;

export const SHOTS = [
  { name: 'r4-dashboard', query: { screen: 'r4-dashboard' } },
  { name: 'r4-dashboard-freigabe', query: { screen: 'r4-dashboard' }, act: tabOrButton(/^Freischaltung/), dialog: false },
  { name: 'r4-dashboard-rabattcodes', query: { screen: 'r4-dashboard' }, act: tabOrButton(/^Rabattcodes/) },
  { name: 'r4-dashboard-empfehlungen', query: { screen: 'r4-dashboard' }, act: tabOrButton(/^Empfehlungen/) },
  { name: 'r4-dashboard-aktivierung', query: { screen: 'r4-dashboard' }, act: tabOrButton(/^Aktivierung/) },
  { name: 'r4-companies', query: { screen: 'r4-companies' } },
  { name: 'r4-companies-neu', query: { screen: 'r4-companies' }, act: clickButton(/Unternehmen erstellen/i), dialog: DIALOG },
  { name: 'r4-billing', query: { screen: 'r4-billing' } },
  { name: 'r4-billing-abos', query: { screen: 'r4-billing' }, act: tabOrButton(/^Abonnements/) },
  { name: 'r4-billing-plaene', query: { screen: 'r4-billing' }, act: tabOrButton(/^Pläne/) },
  { name: 'r4-billing-abo-zuweisen', query: { screen: 'r4-billing' }, act: clickButton(/Abo zuweisen/i), dialog: DIALOG },
  { name: 'r4-billing-generieren', query: { screen: 'r4-billing' }, act: clickButton(/Rechnungen generieren/i), dialog: DIALOG },
  { name: 'r4-team', query: { screen: 'r4-team' } },
  { name: 'r4-audit', query: { screen: 'r4-audit' } },
  { name: 'r4-directories', query: { screen: 'r4-directories' } },
  { name: 'r4-directories-fahrer', query: { screen: 'r4-directories' }, act: tabOrButton(/^Fahrer/) },
  { name: 'r4-directories-benutzer', query: { screen: 'r4-directories' }, act: tabOrButton(/^Benutzer/) },
  { name: 'r4-settings', query: { screen: 'r4-settings' } },
  { name: 'r4-settings-mail', query: { screen: 'r4-settings' }, act: tabOrButton(/^E-Mails/) },
  { name: 'r4-plans', query: { screen: 'r4-plans' } },
  { name: 'r4-abnahme', query: { screen: 'r4-abnahme' } },
];
