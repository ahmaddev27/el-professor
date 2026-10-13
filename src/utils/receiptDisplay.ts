/**
 * How a Beleg's own details read on the Belege list.
 *
 * Display only: nothing here is stored, summed or exported. A Beleg that came
 * from the driver app carries what the receipt itself says - the merchant, the
 * city, the time printed on it - and, for a refuel, the litres, the unit price,
 * the odometer and the range left (20261011100000, 20261012100000).
 *
 * Why this is not in the component: the unit price is the figure most easily
 * wrong. `1,789 €/l` and `1,79 €/l` are different numbers on a pump, and a
 * fuel receipt prints three decimals. Two decimals - what `formatEuro` would
 * give - is a silent rounding of the price, so it is pinned by a test here.
 */
import { formatNumber } from '../components/ui/format';
import type { Receipt } from '../types/receipt';

/** `14:32:00` from a `time` column as `14:32`. Display only; storage keeps the seconds. */
export function clockTime(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^(\d{2}):(\d{2})/.exec(value);
  return match === null ? null : `${match[1]}:${match[2]}`;
}

/** Merchant, city and printed time, in that order, whichever of them exist. */
export function receiptSourceParts(receipt: Receipt): string[] {
  return [receipt.merchantName, receipt.city, clockTime(receipt.receiptTime)]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '');
}

export interface FuelLabels {
  odometer: string;
  rangeLeft: string;
}

/**
 * The refuel's figures as display strings, in the order a person reads a pump
 * ticket: litres, unit price, then the cluster's odometer and range. A figure
 * the Beleg does not carry is absent - never `0`, which would claim a reading.
 */
export function receiptFuelParts(receipt: Receipt, labels: FuelLabels): string[] {
  const parts: string[] = [];
  if (receipt.litres !== undefined) parts.push(`${formatNumber(receipt.litres, 2)} l`);
  if (receipt.pricePerLitre !== undefined) parts.push(`${formatNumber(receipt.pricePerLitre, 3)} €/l`);
  if (receipt.odometerKm !== undefined) {
    parts.push(`${labels.odometer} ${formatNumber(receipt.odometerKm)} km`);
  }
  if (receipt.rangeKm !== undefined) {
    parts.push(`${labels.rangeLeft} ${formatNumber(receipt.rangeKm)} km`);
  }
  return parts;
}

/**
 * A `numeric`/`integer` column as a number, or undefined when it is absent.
 * PostgREST sends `numeric` as a JSON number, but a string is accepted too: a
 * column that arrives as text must not become `NaN` on screen.
 */
export function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Who uploaded a Beleg. A Beleg from the driver app names the driver; any
 * other resolves `created_by` to a user, and a user nobody can find is unknown.
 */
export function receiptAuthor(
  receipt: Receipt,
  userDisplayNames: Map<string, string>,
  unknown: string,
): string {
  const driver = receipt.submittedByName?.trim();
  if (driver) return driver;
  if (!receipt.createdBy) return unknown;
  return userDisplayNames.get(receipt.createdBy) ?? unknown;
}
