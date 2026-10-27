/**
 * The order the Belege list is drawn in.
 *
 * Why this is a module and not four lines inside `ReceiptList`: the owner asked
 * (27.10.2026) for the sort control on five more columns — the printed time, the
 * litres, the price per litre, the odometer and the range left — and the
 * comparator that was in the component could not have carried them correctly.
 * It read `a[field]` and compared with `<` / `>`, which is right for the seven
 * fields it already had and wrong for these five in two ways:
 *
 *   1. `receiptTime` is a Postgres `time` column, so it arrives as the string
 *      `"05:26:00"`. A plain string compare happens to order zero-padded clock
 *      times correctly, but only by accident of the format, and a row whose
 *      value is malformed or carries a timezone suffix would sort by its first
 *      character. It is compared here as a number of seconds since midnight.
 *   2. An absent figure is `undefined`, and `undefined < 5` and `undefined > 5`
 *      are *both* false. The old comparator therefore returned 0 for every pair
 *      involving an empty, which leaves those rows wherever the previous order
 *      happened to put them — scattered through the ranking rather than
 *      gathered. Most Belege are not refuels, so on four of these five columns
 *      the empties are the majority of the table.
 *
 * WHAT EACH OF THE FIVE ACTUALLY HOLDS, measured, because they are not uniform:
 *
 *   | screen column        | SQL column      | SQL type       | on the row object   |
 *   |----------------------|-----------------|----------------|---------------------|
 *   | Zeit                 | receipt_time    | time           | string `"05:26:00"` |
 *   | Liter                | litres          | numeric(8,2)   | number              |
 *   | Preis je Liter (€/l) | price_per_litre | numeric(6,3)   | number              |
 *   | Kilometerstand       | odometer_km     | integer        | number              |
 *   | Restreichweite       | range_km        | integer        | number              |
 *
 * (SQL types from 20261011100000 and 20261012100000; the row shape from
 * `useDatabase`'s receipt mapper, which puts the four figures through
 * `numberOrUndefined`.)
 *
 * So four are already numbers on the row and one is a clock string. **The
 * German formatting is applied for display only** — `receiptFuelFigures` runs
 * each figure through `formatNumber`, which is where the decimal comma and the
 * thousands dot come from. Nothing here reads a formatted string: `"9,50"`
 * sorts after `"10,20"` as text, and `"80.284"` against `"172.884"` compares
 * character by character. Sort on the value, format at the cell.
 *
 * THE EMPTY-VALUE RULE: **an empty sorts last, in both directions.**
 *
 * A Beleg with no odometer reading is not a Beleg for a car that has driven
 * 0 km — it carries no reading at all, so it has no place in a ranking by
 * distance and belongs out of the way of the rows that do. The rule does not
 * flip with the direction, and that is the deliberate half: these columns are
 * filled only for a refuel, so if empties led on a descending sort the operator
 * would open "highest odometer first" onto a screenful of blank cells and have
 * to scroll past every hand-entered Beleg in the month to reach the first
 * reading — which is the one thing the sort was asked for. Ties keep the order
 * they arrived in (`Array.prototype.sort` is stable), so the empties stay in the
 * list's previous order among themselves rather than being shuffled.
 */
import type { Receipt } from '../types/receipt';

/**
 * The seven fields that sorted before 27.10.2026. `income` and `balance` are
 * not columns on this table and no header offers them; they are kept because
 * the component's state may still hold them and dropping a member of this union
 * would change what `handleSort` accepts.
 */
export type ReceiptTextSortField =
  | 'receiptNumber'
  | 'date'
  | 'description'
  | 'driverName'
  | 'income'
  | 'expense'
  | 'balance';

/** The five the owner marked on 27.10.2026. Each is a measured quantity, not text. */
export const MEASURED_SORT_FIELDS = [
  'receiptTime',
  'litres',
  'pricePerLitre',
  'odometerKm',
  'rangeKm',
] as const;

export type MeasuredSortField = (typeof MEASURED_SORT_FIELDS)[number];

export type ReceiptSortField = ReceiptTextSortField | MeasuredSortField;
export type ReceiptSortDirection = 'asc' | 'desc';

function isMeasured(field: ReceiptSortField): field is MeasuredSortField {
  return (MEASURED_SORT_FIELDS as readonly string[]).includes(field);
}

/**
 * `HH:MM`, `HH:MM:SS` or `HH:MM:SS.ffff` as seconds since midnight; null for
 * anything else, including an absent value.
 *
 * The seconds are kept although the cell prints only `HH:MM` (`clockTime`
 * truncates). That cannot contradict what is on screen — two values that differ
 * only in their seconds print the same two digits either way — and throwing
 * them away would turn a real difference into a tie.
 *
 * A value that does not parse is `null`, never `NaN`: `NaN` compares false
 * against everything and would put such a row back in the gap this module
 * exists to close.
 */
export function clockSeconds(value: string | undefined): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d(?:\.\d+)?))?$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  if (hours > 23) return null;
  return hours * 3600 + Number(match[2]) * 60 + (match[3] === undefined ? 0 : Number(match[3]));
}

/** One of the five as the number it is, or null when the Beleg does not carry it. */
export function measuredSortValue(receipt: Receipt, field: MeasuredSortField): number | null {
  if (field === 'receiptTime') return clockSeconds(receipt.receiptTime);
  const value = receipt[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function compareReceipts(
  a: Receipt,
  b: Receipt,
  field: ReceiptSortField,
  direction: ReceiptSortDirection,
): number {
  if (isMeasured(field)) {
    const aValue = measuredSortValue(a, field);
    const bValue = measuredSortValue(b, field);
    // Empties last, whichever way the ranking runs — see the header.
    if (aValue === null) return bValue === null ? 0 : 1;
    if (bValue === null) return -1;
    if (aValue < bValue) return direction === 'asc' ? -1 : 1;
    if (aValue > bValue) return direction === 'asc' ? 1 : -1;
    return 0;
  }
  // The seven older fields, compared exactly as the component compared them, so
  // adding the five above cannot move a column that already worked.
  let aValue: any = a[field];
  let bValue: any = b[field];
  if (field === 'date') {
    aValue = new Date(aValue);
    bValue = new Date(bValue);
  }
  if (aValue < bValue) return direction === 'asc' ? -1 : 1;
  if (aValue > bValue) return direction === 'asc' ? 1 : -1;
  return 0;
}

/**
 * The rows in the order the table draws them. A copy: the caller's array is the
 * filtered list, which several other bindings read.
 *
 * It is a permutation of its input and nothing else — no row is dropped and no
 * row is added, which is what keeps the header's "Ausgaben gesamt" and
 * "MwSt. 19 % gesamt" the same two figures whatever the sort. Both are reduced
 * over this list.
 */
export function sortReceipts(
  rows: readonly Receipt[],
  field: ReceiptSortField,
  direction: ReceiptSortDirection,
): Receipt[] {
  return [...rows].sort((a, b) => compareReceipts(a, b, field, direction));
}
