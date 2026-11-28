/**
 * Design remake, batch R2: Notizen, Werkstatt, Benachrichtigungen.
 *
 *   node design-harness/capture.mjs --set before --batch r2 --widths 1440,375 --out Docs/design/remake-v2
 *
 * The before set is shot from the unconverted pages, so the acts try the new
 * markup's accessible name first and fall back to the old icon-only buttons.
 */

/** Click the first of the given locators that exists. */
async function clickFirstOf(page, locators) {
  for (const locate of locators) {
    const target = locate(page).first();
    if ((await target.count()) > 0) {
      await target.click();
      return;
    }
  }
  throw new Error('r2 act: no selector matched');
}

const openNewNote = page => page.getByRole('button', { name: /^(Neue Notiz|New note)$/ }).first().click();

const openEditNote = page => clickFirstOf(page, [
  p => p.getByRole('button', { name: /bearbeiten|^edit/i }),
  // lucide 0.344 kebab-cases the icon's name, so Trash2 is `lucide-trash2`. Until R3
  // the edit button drew a CreditCard icon; a before set from an older base needs it.
  p => p.locator('button:has(svg.lucide-pencil), button:has(svg.lucide-credit-card), button:has(svg.lucide-square-pen)'),
]);

const openDeleteNote = async page => {
  await clickFirstOf(page, [
    p => p.getByRole('button', { name: /löschen|^delete/i }),
    p => p.locator('button:has(svg.lucide-trash2), button:has(svg.lucide-trash)'),
  ]);
};

const openNewCheck = page => page.getByRole('button', { name: /^(Neuer Check|New check)$/ }).first().click();

export const SHOTS = [
  { name: 'r2-notizen', query: { screen: 'r2-notizen' } },
  { name: 'r2-notizen-leer', query: { screen: 'r2-notizen-leer' } },
  { name: 'r2-werkstatt', query: { screen: 'r2-werkstatt' } },
  { name: 'r2-werkstatt-leer', query: { screen: 'r2-werkstatt-leer' } },
  { name: 'r2-benachrichtigungen', query: { screen: 'r2-benachrichtigungen' } },
  { name: 'r2-notizen-neu', query: { screen: 'r2-notizen' }, act: openNewNote, dialog: true },
  { name: 'r2-notizen-bearbeiten', query: { screen: 'r2-notizen' }, act: openEditNote, dialog: true },
  { name: 'r2-notizen-loeschen', query: { screen: 'r2-notizen' }, act: openDeleteNote, dialog: true },
  { name: 'r2-werkstatt-neu', query: { screen: 'r2-werkstatt' }, act: openNewCheck, dialog: true },
  { name: 'r2-notizen-en', query: { screen: 'r2-notizen', lang: 'en' }, variants: [{ width: 1440, theme: 'light' }] },
];
