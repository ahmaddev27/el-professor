/**
 * Design remake, batch R1: the Übersicht (full, empty, English) and the locked page.
 *
 *   node design-harness/capture.mjs --set before --batch r1 --widths 1440,375 --out Docs/design/remake-v2
 *
 * Each `screen` is this batch's own (design-harness/r1/fixtures.ts), so the
 * applayout batch's `uebersicht` keeps answering empty. Note: capture.mjs
 * ignores a shot's `variants` when `--widths` is given, so the English shot is
 * then taken at every width and theme rather than the one listed here.
 */
export const SHOTS = [
  { name: 'r1-uebersicht', query: { screen: 'r1-uebersicht' } },
  { name: 'r1-uebersicht-leer', query: { screen: 'r1-uebersicht-leer' } },
  { name: 'r1-gesperrt', query: { screen: 'r1-gesperrt' } },
  { name: 'r1-gesperrt-premium', query: { screen: 'r1-gesperrt-premium' } },
  { name: 'r1-uebersicht-en', query: { screen: 'r1-uebersicht', lang: 'en' }, variants: [{ width: 1440, theme: 'light' }] },
];
