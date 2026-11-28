/**
 * Arabic (right-to-left) check of both shells, 27.11.2026: the sidebar that vanished on
 * a wide screen in Arabic, and the Arabic face.
 *
 *   node design-harness/capture.mjs --set after --batch rtl --out <dir>
 *
 * Both shells, at 1440 and 375, light and dark; at 375 the drawer closed and opened.
 */
const WIDE_AND_PHONE = [1440, 375].flatMap(width => ['light', 'dark'].map(theme => ({ width, theme })));
const PHONE = ['light', 'dark'].map(theme => ({ width: 375, theme }));

/** The drawer's menu button, fixed at the start edge below `lg`. */
const openDrawer = page => page.locator('button.fixed.start-4').first().click();

export const SHOTS = [
  { name: 'rtl-panel-audit', query: { screen: 'r4-audit', lang: 'ar' }, variants: WIDE_AND_PHONE },
  { name: 'rtl-panel-drawer', query: { screen: 'r4-audit', lang: 'ar' }, act: openDrawer, variants: PHONE },
  { name: 'rtl-app-fahrzeuge', query: { screen: 'fahrzeuge', lang: 'ar' }, variants: WIDE_AND_PHONE },
  { name: 'rtl-app-drawer', query: { screen: 'fahrzeuge', lang: 'ar' }, act: openDrawer, variants: PHONE },
  // Control: the same screen in German in the same browser. A native date field formats by the
  // browser's language, so it shows the same placeholder here as in Arabic.
  { name: 'ltr-panel-audit-de', query: { screen: 'r4-audit', lang: 'de' }, variants: [{ width: 1440, theme: 'dark' }] },
];
