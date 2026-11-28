// The two shells' sidebars (owner, 27.11.2026): the collapsible rail and the
// gutter between the sidebar and the sheet. Both shells, German and Arabic,
// 1280 and 1440 wide, expanded and collapsed, light and dark, plus the 375 px
// drawer. The collapse action does nothing when there is no toggle, so the
// "before" set's collapsed shots show that the shell had no rail.
const WIDE = [1280, 1440].flatMap(width => ['light', 'dark'].map(theme => ({ width, theme })));
const PHONE = ['light', 'dark'].map(theme => ({ width: 375, theme }));

const collapse = async page => {
  // The toggle inside the pane; the drawer's menu button names the same id.
  const toggle = page.locator('aside button[aria-controls="shell-sidebar"]');
  if (await toggle.count()) await toggle.first().click();
};
// The rail tooltip: collapse, then hover the third item.
const collapseAndHover = async page => {
  await collapse(page);
  await page.waitForTimeout(400);
  await page.locator('aside nav a').nth(2).hover();
};
const openDrawer = page => page.locator('button.fixed.start-4').first().click();

const SHELLS = [
  { shell: 'panel', screen: 'r4-team' },
  { shell: 'app', screen: 'fahrzeuge' },
];

export const SHOTS = SHELLS.flatMap(({ shell, screen }) =>
  ['de', 'ar'].flatMap(lang => [
    { name: `${shell}-${lang}-expanded`, query: { screen, lang }, variants: WIDE },
    { name: `${shell}-${lang}-collapsed`, query: { screen, lang }, act: collapse, variants: WIDE },
    { name: `${shell}-${lang}-tooltip`, query: { screen, lang }, act: collapseAndHover, variants: [1440].flatMap(width => ['light', 'dark'].map(theme => ({ width, theme }))) },
    { name: `${shell}-${lang}-drawer`, query: { screen, lang }, act: openDrawer, variants: PHONE },
  ]),
);
