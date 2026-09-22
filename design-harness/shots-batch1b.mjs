/**
 * Phase 5 batch 1b's pictures: Belege, Fahrer and Umsätze.
 *
 *   npm run harness:capture -- --set before --batch batch1b --root <worktree of the base>
 *   npm run harness:capture -- --set after --batch batch1b [--only -belege,-fahrer-]
 *
 * Every act works on the legacy screen and on the converted one, so both sets
 * show the same state. Where the legacy screen offers no accessible name (the
 * phone cards on Belege have unnamed icon buttons), the act falls back to the
 * legacy markup.
 *
 * `tall: true` opens a taller window, so a long form in a dialog shows whole.
 */

/** A laptop in light and a phone in dark: the widest and the narrowest layout, and both themes. */
const STATE_VARIANTS = [
  { width: 1280, theme: 'light' },
  { width: 375, theme: 'dark' },
];

/** The first of several locators that is on screen. */
async function firstVisible(page, locators) {
  for (const locator of locators) {
    const first = locator.first();
    if (await first.isVisible().catch(() => false)) return first;
  }
  throw new Error('none of the locators is visible');
}

/** A photographed till receipt, drawn by the browser: what a driver hands in. */
async function receiptImage(page) {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 520;
    const g = canvas.getContext('2d');
    g.fillStyle = '#f7f5ef';
    g.fillRect(0, 0, 360, 520);
    g.fillStyle = '#222';
    g.textAlign = 'center';
    g.font = 'bold 22px monospace';
    g.fillText('TANKSTELLE NORD', 180, 48);
    g.font = '15px monospace';
    ['Seestraße 12', '13405 Berlin', '', '12.09.2026 17:42'].forEach((line, i) => g.fillText(line, 180, 80 + i * 22));
    const rows = [['Super E10', '34,85'], ['  21,80 l x 1,599', ''], ['', ''], ['Netto', '34,85'], ['MwSt 19%', '6,62']];
    rows.forEach(([label, amount], i) => {
      g.textAlign = 'left';
      g.fillText(label, 30, 190 + i * 24);
      g.textAlign = 'right';
      g.fillText(amount, 330, 190 + i * 24);
    });
    g.font = 'bold 20px monospace';
    g.textAlign = 'left';
    g.fillText('SUMME EUR', 30, 340);
    g.textAlign = 'right';
    g.fillText('41,47', 330, 340);
    g.textAlign = 'center';
    g.font = '14px monospace';
    g.fillText('Vielen Dank', 180, 420);
    return canvas.toDataURL('image/png');
  });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

const openAddReceipt = page => page.getByRole('button', { name: 'Beleg hinzufügen' }).first().click();
const scanReceipt = async page => {
  await openAddReceipt(page);
  await page.waitForTimeout(300);
  await page.locator('input[type="file"]').setInputFiles({ name: 'beleg.png', mimeType: 'image/png', buffer: await receiptImage(page) });
  // The scripted OCR answers in 300 ms, the postcode lookup 120 ms later.
  await page.waitForTimeout(900);
};
const deleteFirstReceipt = async page =>
  (await firstVisible(page, [
    page.getByRole('button', { name: /löschen$/i }),
    // The legacy phone card: its two icon buttons have no name; delete is the second.
    page.locator('div.md\\:hidden > div button').nth(1),
  ])).click();
const editFirstReceipt = async page =>
  (await firstVisible(page, [
    page.getByRole('button', { name: /bearbeiten$/i }),
    // The legacy phone card: edit is the first of its two unnamed icon buttons.
    page.locator('div.md\\:hidden > div button').nth(0),
  ])).click();
const openReceiptFilters = page => page.getByRole('button', { name: /^Filter/ }).first().click();
const openAddDriver = page => page.getByRole('button', { name: 'Neuer Fahrer' }).first().click();
const editFirstDriver = page => page.getByRole('button', { name: /bearbeiten$/i }).first().click();
const openDriverPlanning = async page => {
  await openAddDriver(page);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /Planungseinstellungen/ }).click();
};
const openAddIncome = async page => {
  await page.getByRole('button', { name: 'Neue Einnahme hinzufügen' }).first().click();
  await page.waitForTimeout(300);
  // The four amount fields share the placeholder, in the order the form lists them.
  await page.getByPlaceholder('0,00').nth(0).fill('1184,60');
  await page.getByPlaceholder('0,00').nth(3).fill('512,40');
};
const editFirstIncome = page => page.getByRole('button', { name: /bearbeiten$/i }).first().click();
const deleteFirstIncome = page => page.getByRole('button', { name: /löschen$/i }).first().click();

export const SHOTS = [
  { name: 'belege', query: { screen: 'belege' } },
  { name: 'fahrer', query: { screen: 'fahrer' } },
  { name: 'umsaetze', query: { screen: 'umsaetze' } },
  // Belege
  { name: 'belege-formular', query: { screen: 'belege' }, act: openAddReceipt, dialog: true, variants: STATE_VARIANTS },
  { name: 'belege-scan', query: { screen: 'belege', ocr: 'uncertain' }, act: scanReceipt, dialog: true, tall: true, variants: STATE_VARIANTS },
  { name: 'belege-bearbeiten', query: { screen: 'belege' }, act: editFirstReceipt, dialog: true, variants: STATE_VARIANTS },
  { name: 'belege-loeschen', query: { screen: 'belege' }, act: deleteFirstReceipt, dialog: true, variants: STATE_VARIANTS },
  { name: 'belege-filter', query: { screen: 'belege' }, act: openReceiptFilters, variants: STATE_VARIANTS },
  { name: 'belege-leer', query: { screen: 'belege', data: 'empty' }, variants: STATE_VARIANTS },
  { name: 'belege-fehler', query: { screen: 'belege', data: 'error' }, variants: STATE_VARIANTS },
  { name: 'belege-nur-lesen', query: { screen: 'belege', role: 'view' }, variants: STATE_VARIANTS },
  // Fahrer. There is no delete confirmation to show: the bin deletes at once.
  { name: 'fahrer-formular', query: { screen: 'fahrer' }, act: openAddDriver, dialog: true, variants: STATE_VARIANTS },
  { name: 'fahrer-planung', query: { screen: 'fahrer' }, act: openDriverPlanning, dialog: true, tall: true, variants: STATE_VARIANTS },
  { name: 'fahrer-bearbeiten', query: { screen: 'fahrer' }, act: editFirstDriver, dialog: true, variants: STATE_VARIANTS },
  { name: 'fahrer-limit', query: { screen: 'fahrer', data: 'limit' }, variants: STATE_VARIANTS },
  { name: 'fahrer-leer', query: { screen: 'fahrer', data: 'empty' }, variants: STATE_VARIANTS },
  { name: 'fahrer-fehler', query: { screen: 'fahrer', data: 'error' }, variants: STATE_VARIANTS },
  { name: 'fahrer-nur-lesen', query: { screen: 'fahrer', role: 'view' }, variants: STATE_VARIANTS },
  // Umsätze
  { name: 'umsaetze-neu', query: { screen: 'umsaetze' }, act: openAddIncome, variants: STATE_VARIANTS },
  { name: 'umsaetze-bearbeiten', query: { screen: 'umsaetze' }, act: editFirstIncome, variants: STATE_VARIANTS },
  { name: 'umsaetze-loeschen', query: { screen: 'umsaetze' }, act: deleteFirstIncome, dialog: true, variants: STATE_VARIANTS },
  { name: 'umsaetze-leer', query: { screen: 'umsaetze', data: 'empty' }, variants: STATE_VARIANTS },
  { name: 'umsaetze-fehler', query: { screen: 'umsaetze', data: 'error' }, variants: STATE_VARIANTS },
  // The database reachable, the entries' own read failing (PGRST204).
  { name: 'umsaetze-einnahmen-fehler', query: { screen: 'umsaetze', data: 'missing' }, variants: STATE_VARIANTS },
  { name: 'umsaetze-nur-lesen', query: { screen: 'umsaetze', role: 'view' }, variants: STATE_VARIANTS },
  // The English UI, once per screen.
  { name: 'belege-en', query: { screen: 'belege', lang: 'en' }, variants: [{ width: 1280, theme: 'light' }] },
  { name: 'fahrer-en', query: { screen: 'fahrer', lang: 'en' }, variants: [{ width: 375, theme: 'light' }] },
  { name: 'umsaetze-en', query: { screen: 'umsaetze', lang: 'en' }, variants: [{ width: 1280, theme: 'light' }] },
];
