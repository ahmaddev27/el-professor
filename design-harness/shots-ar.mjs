/**
 * Arabic (RTL) review set, every shot with lang=ar.
 *
 *   node design-harness/capture.mjs --set after --batch ar --out Docs/design/arabic
 *
 * Sign-in, Benutzer, Rollen, Einstellungen and Abonnement live in the batch4
 * harness: node design-harness/batch4/capture-ar.mjs --set after --out Docs/design/arabic
 * Acts find controls by icon, never by German text, because the labels are Arabic now.
 */
const AR = { lang: 'ar' };
const plusButton = page => page.locator('main button:has(svg.lucide-plus)').first().click();
const pencilButton = page => page.locator('main button:has(svg.lucide-pencil)').first().click();

const LIGHT = [{ width: 1440, theme: 'light' }, { width: 375, theme: 'light' }];
const WITH_DARK = [...LIGHT, { width: 1440, theme: 'dark' }, { width: 375, theme: 'dark' }];
const DARK_SCREENS = new Set(['uebersicht', 'fahrzeuge', 'abrechnung', 'admin-dashboard']);
const s = (name, screen, extra = {}) => ({
  name: `ar-${name}`, query: { screen, ...AR }, variants: DARK_SCREENS.has(name) ? WITH_DARK : LIGHT, ...extra,
});

export const SHOTS = [
  s('uebersicht', 'r1-uebersicht'),
  s('fahrzeuge', 'fahrzeuge'),
  s('fahrzeuge-formular', 'fahrzeuge', { act: plusButton, dialog: true }),
  s('fixkosten', 'fixkosten'),
  s('belege', 'belege'),
  s('fahrer', 'fahrer'),
  s('umsaetze', 'umsaetze'),
  s('gehaelter', 'gehaelter'),
  s('abrechnung', 'abrechnung'),
  s('bargeld', 'bargeld'),
  s('dokumente', 'dokumente'),
  s('monatsplanung', 'monatsplanung'),
  s('notizen', 'r2-notizen'),
  s('notizen-neu', 'r2-notizen', { act: plusButton, dialog: true }),
  s('werkstatt', 'r2-werkstatt'),
  s('benachrichtigungen', 'r2-benachrichtigungen'),
  s('admin-dashboard', 'r4-dashboard'),
  s('admin-companies', 'r4-companies'),
  s('admin-billing', 'r4-billing'),
  s('admin-settings', 'r4-settings'),
];
