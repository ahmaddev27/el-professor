// The primary colour moves from the Reidey spec's emerald to the logo's blue
// (owner, 27.11.2026). The overview (buttons, charts, KPI accents), one table
// screen (Fahrzeuge: active navigation, tabs, badges) and the panel's team page,
// German and Arabic, light and dark, at 1440 and 375. The sign-in screen is
// batch 4's own harness (its shots `login` and `login-ar`).
const VARIANTS = [1440, 375].flatMap(width => ['light', 'dark'].map(theme => ({ width, theme })));

const SCREENS = [
  { name: 'uebersicht', screen: 'r1-uebersicht' },
  { name: 'fahrzeuge', screen: 'fahrzeuge' },
  { name: 'team', screen: 'r4-team' },
];

export const SHOTS = SCREENS.flatMap(({ name, screen }) =>
  ['de', 'ar'].map(lang => ({ name: `${name}-${lang}`, query: { screen, lang }, variants: VARIANTS })),
);
