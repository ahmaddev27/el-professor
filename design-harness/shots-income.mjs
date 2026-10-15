/**
 * The Umsätze list's day / week / month tabs.
 *
 *   npm run harness:capture -- --set before --batch income --root <worktree of the base>
 *   npm run harness:capture -- --set after  --batch income
 *
 * The before set shows the one nested list the screen had (month, week, day,
 * driver at once); the after set shows each level. "Dieses Jahr" is clicked
 * first so more than one month is on screen.
 */
const VARIANTS = [
  { width: 1280, theme: 'light' },
  { width: 375, theme: 'light' },
  { width: 375, theme: 'dark' },
];

const wholeYear = async page => {
  await page.getByRole('button', { name: 'Dieses Jahr' }).first().click();
  await page.waitForTimeout(300);
};
const tab = name => async page => {
  await wholeYear(page);
  await page.getByRole('tab', { name, exact: true }).click();
  await page.waitForTimeout(200);
};
const openFirst = name => async page => {
  await tab(name)(page);
  await page.locator('button[aria-expanded="false"]').first().click();
  await page.waitForTimeout(200);
};

export const SHOTS = [
  { name: 'umsaetze-start', query: { screen: 'umsaetze' }, act: wholeYear, variants: VARIANTS },
  { name: 'umsaetze-tag', query: { screen: 'umsaetze' }, act: tab('Tag'), variants: VARIANTS },
  { name: 'umsaetze-woche', query: { screen: 'umsaetze' }, act: tab('Woche'), variants: VARIANTS },
  { name: 'umsaetze-woche-offen', query: { screen: 'umsaetze' }, act: openFirst('Woche'), variants: VARIANTS },
  { name: 'umsaetze-monat', query: { screen: 'umsaetze' }, act: openFirst('Monat'), variants: VARIANTS },
  { name: 'umsaetze-liste', query: { screen: 'umsaetze' }, act: tab('Liste'), variants: VARIANTS },
];
