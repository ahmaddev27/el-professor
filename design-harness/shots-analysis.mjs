/**
 * The Fahrtenanalyse's pictures, for capture.mjs (Fahrtenbuch plan, slice D).
 *
 *   node design-harness/capture.mjs --batch analysis --set after
 *
 * The screen is new, so there is no "before" set to compare with; the shots
 * exist to show every state it can be in — the three tabs, the evidence sheet,
 * a month with no Fahrtenbuch, a failed read, a read-only platform view, a
 * month with no budget and a company that has not decided its settings.
 *
 * **Every act only draws.** It switches a tab, opens the evidence sheet or
 * opens the settings form; none saves, confirms or deletes anything, and none
 * touches a trip. `flows-analysis.mjs` proves the same clicks send no write.
 */

/**
 * Until nothing has been pending for a while. The screen chains two reads —
 * the company's imports, drivers and settings, then the chosen month's trips,
 * Stundennachweise and budgets — so the first one ending is not the page
 * being ready. Copied from batch3/shots.mjs for the same reason.
 */
export async function quiet(page) {
  let answered = -1;
  for (let round = 0; round < 40; round += 1) {
    await page.waitForFunction(() => window.__harness.pending === 0, null, { timeout: 30_000 });
    await page.waitForTimeout(300);
    const now = await page.evaluate(() => (window.__harness.pending === 0 ? window.__harness.answered : -1));
    if (now !== -1 && now === answered) return;
    answered = now;
  }
}

/** A laptop in light and a phone in dark, for a state that needs no third width. */
const STATE_VARIANTS = [
  { width: 1280, theme: 'light' },
  { width: 375, theme: 'dark' },
];

const tab = (page, name) => page.getByRole('tab', { name }).first();
const button = (page, name) => page.getByRole('button', { name }).first();

/** Nothing is clicked; the act only waits out the second read. */
const settled = page => quiet(page);

const openTab = name => async page => {
  await quiet(page);
  await tab(page, name).click();
  await quiet(page);
};

const openDriverTab = openTab(/^Fahrer$/);
const openIssuesTab = openTab(/^Befunde$/);

/** The trips behind a figure: the review count on the overview opens them. */
const openEvidence = async page => {
  await quiet(page);
  await button(page, /Fahrten anzeigen: Zur Prüfung/).click();
  await page.waitForTimeout(400);
};

/** The settings form, the one place an administrator writes on this screen. */
const openSettings = async page => {
  await quiet(page);
  await button(page, /^Festlegen$/).click();
  await page.waitForTimeout(300);
};

export const SHOTS = [
  // The three tabs, at every width and in both themes.
  { name: 'fahrtenanalyse', query: { screen: 'fahrtenanalyse' }, act: settled },
  { name: 'fahrtenanalyse-fahrer', query: { screen: 'fahrtenanalyse' }, act: openDriverTab },
  { name: 'fahrtenanalyse-befunde', query: { screen: 'fahrtenanalyse' }, act: openIssuesTab },

  // The evidence sheet: the trips behind a figure, as imported and uneditable.
  { name: 'fahrtenanalyse-belege', query: { screen: 'fahrtenanalyse' }, act: openEvidence, dialog: true },

  // The states the screen must tell apart. A month with no file is not a
  // failed read, and neither is a zero.
  { name: 'fahrtenanalyse-leer', query: { screen: 'fahrtenanalyse', data: 'empty' }, act: settled },
  { name: 'fahrtenanalyse-fehler', query: { screen: 'fahrtenanalyse', data: 'error' }, act: settled },
  { name: 'fahrtenanalyse-nur-lesen', query: { screen: 'fahrtenanalyse', role: 'view' }, act: settled },
  { name: 'fahrtenanalyse-ohne-budget', query: { screen: 'fahrtenanalyse', data: 'no-budget' }, act: openDriverTab },
  { name: 'fahrtenanalyse-ohne-einstellungen', query: { screen: 'fahrtenanalyse', data: 'no-settings' }, act: settled },

  // A viewer: no settings form, no reserve, no confirmation.
  { name: 'fahrtenanalyse-leser', query: { screen: 'fahrtenanalyse', role: 'viewer' }, act: openDriverTab, variants: STATE_VARIANTS },
  { name: 'fahrtenanalyse-einstellungen', query: { screen: 'fahrtenanalyse' }, act: openSettings, variants: STATE_VARIANTS },
  { name: 'fahrtenanalyse-dateien', query: { screen: 'fahrtenanalyse', data: 'two-files' }, act: settled, variants: STATE_VARIANTS },

  // The English UI: the labels grow, and the German words that must stay
  // German (Fahrtenbuch, Stundennachweis) must still be there.
  { name: 'fahrtenanalyse-en', query: { screen: 'fahrtenanalyse', lang: 'en' }, act: settled, variants: [{ width: 1280, theme: 'light' }] },
  { name: 'fahrtenanalyse-befunde-en', query: { screen: 'fahrtenanalyse', lang: 'en' }, act: openTab(/^Findings$/), variants: [{ width: 375, theme: 'light' }] },
];
