/**
 * The Fahrer and Fahrzeuge lists in Reidey's layout (27.11.2026), on the
 * invented data of design-harness/drivers-reidey/fixtures.ts.
 *
 *   npm run harness:capture -- --set after --batch drivers-reidey --out Docs/design --widths 1440,375
 *
 * Every shot carries `reidey: '1'`, which is what switches those fixtures on.
 */

const R = { reidey: '1' };
const wait = ms => page => page.waitForTimeout(ms);

const pressDriverUpdate = async page => {
  await page.getByRole('button', { name: 'Fahrer aus Reidey aktualisieren' }).first().click();
  await wait(900)(page);
};
const pressVehicleUpdate = async page => {
  await page.getByRole('button', { name: 'Fahrzeuge aus Reidey aktualisieren' }).first().click();
  await wait(900)(page);
};
const openDecision = async page => {
  await page.getByRole('button', { name: 'Entscheiden' }).first().click();
  await wait(600)(page);
};
const deleteDriver = name => async page => {
  await page.getByRole('button', { name: `Fahrer ${name} endgültig löschen` }).first().click();
  await wait(600)(page);
};

export const SHOTS = [
  { name: 'fahrer', query: { screen: 'fahrer', ...R } },
  { name: 'fahrer-aktualisiert', query: { screen: 'fahrer', ...R }, act: pressDriverUpdate },
  { name: 'fahrer-entscheiden', query: { screen: 'fahrer', ...R }, act: openDecision, dialog: true, tall: true },
  { name: 'fahrer-loeschen', query: { screen: 'fahrer', ...R }, act: deleteDriver('Ivana Marković'), dialog: true },
  { name: 'fahrer-loeschen-gesperrt', query: { screen: 'fahrer', ...R }, act: deleteDriver('Mehmet Yıldız'), dialog: true },
  { name: 'fahrer-nur-lesen', query: { screen: 'fahrer', role: 'viewer', ...R } },
  { name: 'fahrzeuge', query: { screen: 'fahrzeuge', ...R } },
  { name: 'fahrzeuge-aktualisiert', query: { screen: 'fahrzeuge', ...R }, act: pressVehicleUpdate },
  { name: 'fahrer-en', query: { screen: 'fahrer', lang: 'en', ...R }, variants: [{ width: 1440, theme: 'light' }] },
];
