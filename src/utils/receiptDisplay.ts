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

/** Merchant, street, city and printed time, in that order, whichever exist. */
export function receiptSourceParts(receipt: Receipt): string[] {
  return [receipt.merchantName, receipt.street, receipt.city, clockTime(receipt.receiptTime)]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '');
}

/**
 * The station cell, stacked (20261027150000): the brand half when the header
 * split, otherwise the whole merchant name; the operator only when the name
 * line does not already carry it (old rows keep "JET Tankstelle Detlev
 * Wüstenfelder" in merchantName alone); the street beneath.
 */
export interface StationCell {
  name: string | null;
  operator: string | null;
  street: string | null;
}

export function receiptStationCell(receipt: Receipt): StationCell {
  const name = textOrNull(receipt.stationName) ?? textOrNull(receipt.merchantName);
  const operator = textOrNull(receipt.operatorName);
  return {
    name,
    operator: operator !== null && (name === null || !name.includes(operator)) ? operator : null,
    street: textOrNull(receipt.street),
  };
}

/** A text datum trimmed, or null when it is absent or blank. */
export function textOrNull(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export interface FuelLabels {
  odometer: string;
  rangeLeft: string;
}

/** The refuel's figures formatted without their units; null where the Beleg has none. */
export interface FuelFigures {
  litres: string | null;
  pricePerLitre: string | null;
  odometerKm: string | null;
  rangeKm: string | null;
}

/**
 * Each fuel figure as a German number, one per table column. A figure the Beleg
 * does not carry is null - never `0`, which would claim a reading. The unit
 * price keeps three places: a pump prints three, and two is a silent rounding.
 */
export function receiptFuelFigures(receipt: Receipt): FuelFigures {
  return {
    litres: receipt.litres === undefined ? null : formatNumber(receipt.litres, 2),
    pricePerLitre: receipt.pricePerLitre === undefined ? null : formatNumber(receipt.pricePerLitre, 3),
    odometerKm: receipt.odometerKm === undefined ? null : formatNumber(receipt.odometerKm),
    rangeKm: receipt.rangeKm === undefined ? null : formatNumber(receipt.rangeKm),
  };
}

/**
 * The refuel's figures as display strings, in the order a person reads a pump
 * ticket: litres, unit price, then the cluster's odometer and range. This is
 * what a phone shows in the first cell, where the per-figure columns are hidden.
 */
export function receiptFuelParts(receipt: Receipt, labels: FuelLabels): string[] {
  const figures = receiptFuelFigures(receipt);
  const parts: string[] = [];
  if (figures.litres !== null) parts.push(`${figures.litres} l`);
  if (figures.pricePerLitre !== null) parts.push(`${figures.pricePerLitre} €/l`);
  if (figures.odometerKm !== null) parts.push(`${labels.odometer} ${figures.odometerKm} km`);
  if (figures.rangeKm !== null) parts.push(`${labels.rangeLeft} ${figures.rangeKm} km`);
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
