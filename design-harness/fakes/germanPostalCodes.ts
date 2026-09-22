/**
 * Stands in for src/utils/germanPostalCodes.ts: the Beleg form looks a typed
 * postcode up at api.zippopotam.us, and nothing in the harness leaves the tab.
 * A handful of Berlin codes answer from this table after the same short delay
 * as a query; any other code answers null, as an unknown one does.
 */
export * from '../../src/utils/germanPostalCodes';

const CITIES: Record<string, string> = {
  '10115': 'Berlin',
  '10365': 'Berlin',
  '10785': 'Berlin',
  '10967': 'Berlin',
  '12057': 'Berlin',
  '12529': 'Schönefeld',
  '13405': 'Berlin',
};

export async function getCityFromPostalCode(postalCode: string): Promise<string | null> {
  await new Promise(resolve => setTimeout(resolve, 120));
  return CITIES[postalCode.trim()] ?? null;
}
