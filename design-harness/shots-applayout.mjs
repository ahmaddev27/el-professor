/**
 * Phase 5, the frame: AppLayout moves onto the design system.
 *
 * Every other batch shot one screen deeply. This one is the frame every screen
 * renders inside, so the list is **wide**: one screen from each earlier batch,
 * three screens that were never converted, and the frame's own furniture — the
 * support-session bar, the account menu, the mobile navigation and the English
 * header. A frame defect shows on all of them at once; a screen defect shows on
 * one, which is how the two are told apart.
 *
 * The three unconverted screens are the point of the exercise. A legacy page on
 * a `--canvas` frame is the combination nobody had looked at before this batch.
 */

/** A laptop in light and a phone in dark: the widest and the narrowest layout, and both themes. */
const STATE_VARIANTS = [
  { width: 1280, theme: 'light' },
  { width: 375, theme: 'dark' },
];

/** The account menu's trigger is the last control in the top bar. */
const openUserMenu = page => page.locator('header button').last().click();

/**
 * The sidebar's menu button below `lg`. It is the first button the frame
 * renders and it carries no accessible name — which this batch records rather
 * than fixes, because a name is a translation key and not a look.
 */
const openMobileNav = page => page.locator('button').first().click();

export const SHOTS = [
  // ── The frame at every width, around a converted screen and around two that
  //    were never converted.
  { name: 'frame-fahrzeuge', query: { screen: 'fahrzeuge' } },
  { name: 'frame-uebersicht', query: { screen: 'uebersicht' } },
  { name: 'frame-benachrichtigungen', query: { screen: 'benachrichtigungen' } },

  // ── One screen from each remaining batch, and the third unconverted screen.
  { name: 'frame-belege', query: { screen: 'belege' }, variants: STATE_VARIANTS },
  { name: 'frame-gehaelter', query: { screen: 'gehaelter' }, variants: STATE_VARIANTS },
  { name: 'frame-dokumente', query: { screen: 'dokumente' }, variants: STATE_VARIANTS },
  { name: 'frame-werkstatt', query: { screen: 'werkstatt' }, variants: STATE_VARIANTS },

  // ── The frame's own furniture.
  // The bar a platform account carries inside a customer: the only thing on
  // screen saying the data is not the account's own, so it is checked in both
  // themes and at both extremes of width.
  { name: 'frame-support-sitzung', query: { screen: 'fahrzeuge', role: 'view' }, variants: STATE_VARIANTS },
  { name: 'frame-benutzermenue', query: { screen: 'fahrzeuge' }, act: openUserMenu, dialog: true, variants: STATE_VARIANTS },
  {
    name: 'frame-navigation-mobil',
    query: { screen: 'fahrzeuge' },
    act: openMobileNav,
    dialog: true,
    variants: [{ width: 375, theme: 'dark' }, { width: 375, theme: 'light' }],
  },
  // The English UI: the header and the navigation grow, and German-only words
  // must not leak into the frame.
  { name: 'frame-en', query: { screen: 'fahrzeuge', lang: 'en' }, variants: [{ width: 1280, theme: 'light' }] },
];
