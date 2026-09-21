/**
 * Batch 3's pictures, for capture.mjs: Dokumente, Monatsplanung, Stundennachweis.
 *
 *   node design-harness/capture.mjs --batch batch3 --set before|after [--only <name part>]
 *
 * Every act only draws: it opens a dialog, switches a step or a tab, or builds
 * Phase 1's vehicle blocks in memory. None applies, finalizes, saves or deletes
 * anything — flows-batch3.mjs proves the same clicks send no write and no RPC.
 *
 * The selectors match the legacy markup and the converted one alike (a label's
 * visible words, a row's driver name), so the before and after sets are taken
 * by the same acts.
 */

/** Until nothing has been pending for a while: the planning screens chain reads, and one ends before the next starts. */
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

const click = async (page, locator) => {
  await locator.click();
  await quiet(page);
};

const button = (page, name) => page.getByRole('button', { name }).first();

export const openNewPlan = page => click(page, button(page, /^(Neue Planung starten|Start a new plan)$/));
export const openHistorical = page => click(page, button(page, /^(Historischen Abgleich starten|Start historical reconciliation)$/));
export const buildBlocks = async page => {
  await openNewPlan(page);
  await click(page, button(page, /^(Fahrzeug-Blöcke erstellen|Create vehicle blocks)$/));
};
export const openRunDelete = async page => {
  await openNewPlan(page);
  await click(page, button(page, /^(Plan endgültig löschen|Delete plan permanently)$/));
};
export const openRunPreview = async page => {
  await openNewPlan(page);
  await click(page, button(page, /^(Vorschau|Preview)$/));
};

// The archive's rows name their driver; the Gehaltsquittung list above it holds other drivers.
export const openRowDelete = page =>
  click(page, page.getByRole('row', { name: /Svenja Krüger/ }).getByRole('button').last());
export const openGroupDelete = page => click(page, button(page, /^(Alle löschen|Delete all)/));
export const openFahrtenbuch = page => click(page, button(page, /^Fahrtenbuch/));

export const toStep2 = async page => {
  await page.locator('main select').first().selectOption({ index: 1 });
  await click(page, button(page, /^(Weiter|Next)/));
};
export const toStep2Totals = async page => {
  await toStep2(page);
  await click(page, page.getByText(/^(Aus Stunden-Summen|From hour totals)$/).first());
};

/** A state shot: the widest and the narrowest layout, and both themes between them. */
const STATE = [
  { width: 1280, theme: 'light' },
  { width: 375, theme: 'dark' },
];

export const BATCH3_SHOTS = [
  // Dokumente
  { name: 'dokumente', query: { screen: 'dokumente' } },
  { name: 'dokumente-leer', query: { screen: 'dokumente', data: 'empty' }, variants: STATE },
  { name: 'dokumente-loeschen', query: { screen: 'dokumente' }, act: openRowDelete, dialog: true, variants: STATE },
  { name: 'dokumente-gruppe-loeschen', query: { screen: 'dokumente' }, act: openGroupDelete, dialog: true, variants: STATE },
  { name: 'dokumente-fahrtenbuch', query: { screen: 'dokumente' }, act: openFahrtenbuch, variants: STATE },
  { name: 'dokumente-en', query: { screen: 'dokumente', lang: 'en' }, variants: [{ width: 1280, theme: 'light' }] },

  // Monatsplanung
  { name: 'monatsplanung', query: { screen: 'monatsplanung' } },
  { name: 'monatsplanung-neu', query: { screen: 'monatsplanung' }, act: openNewPlan },
  { name: 'monatsplanung-historisch', query: { screen: 'monatsplanung' }, act: openHistorical, variants: STATE },
  { name: 'monatsplanung-bloecke', query: { screen: 'monatsplanung' }, act: buildBlocks, variants: STATE },
  { name: 'monatsplanung-lauf-loeschen', query: { screen: 'monatsplanung' }, act: openRunDelete, dialog: true, variants: STATE },
  { name: 'monatsplanung-vorschau', query: { screen: 'monatsplanung' }, act: openRunPreview, dialog: true, variants: STATE },
  { name: 'monatsplanung-leer', query: { screen: 'monatsplanung', data: 'empty' }, act: openNewPlan, variants: STATE },
  { name: 'monatsplanung-neu-en', query: { screen: 'monatsplanung', lang: 'en' }, act: openNewPlan, variants: [{ width: 375, theme: 'light' }] },

  // Stundennachweis
  { name: 'stundennachweis', query: { screen: 'stundennachweis' } },
  { name: 'stundennachweis-schritt2', query: { screen: 'stundennachweis' }, act: toStep2, variants: STATE },
  { name: 'stundennachweis-schritt2-stunden', query: { screen: 'stundennachweis' }, act: toStep2Totals, variants: STATE },
  { name: 'stundennachweis-blatt', query: { screen: 'stundennachweis', entry: 'archiv' }, variants: STATE },
  { name: 'stundennachweis-blatt-en', query: { screen: 'stundennachweis', entry: 'archiv', lang: 'en' }, variants: [{ width: 1280, theme: 'light' }] },
];
