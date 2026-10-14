/**
 * The reference period of the shift recommendation: what the history months
 * the profile was learnt from actually look like, measured from their rows.
 *
 * ## Why this is not in `utils/shiftRecommendation/`
 *
 * The payment split (cash / online) and the tip share need `cash_amount`,
 * `online_amount` and `tip_amount`, which `analysisTripFromRow` drops on
 * purpose — the recommendation learns from a ride's time, vehicle and price
 * and from nothing else. Widening its inputs for a panel would put money
 * columns into a module whose boundary test and shift-shape test exist to keep
 * it away from ride-level data, and it would tempt a later change to learn
 * from them. So the panel is computed here, in the screens layer, straight
 * from the rows the page already loaded; the profile never sees these columns
 * and what it learns is untouched.
 *
 * Everything is a measured figure of the chosen months; nothing is typed in or
 * assumed. A row whose money cannot be read as an amount is counted apart
 * (`unreadable`) rather than treated as zero.
 */
import { toCents } from './money';

/** The columns of a `fahrtenbuch_trips` row this panel reads; the page selects `*`, so they are present at runtime. */
export interface ReferenceTripRow {
  readonly is_canceled: boolean;
  readonly price_amount?: number | string | null;
  readonly cash_amount?: number | string | null;
  readonly online_amount?: number | string | null;
  readonly tip_amount?: number | string | null;
}

export interface ReferenceMonthInput {
  readonly year: number;
  readonly month: number;
  /** The rows of that month's import, as loaded. */
  readonly rows: readonly ReferenceTripRow[];
}

export interface ReferenceMonth {
  readonly year: number;
  readonly month: number;
  readonly rows: number;
}

export interface ReferenceStats {
  readonly months: readonly ReferenceMonth[];
  readonly rows: number;
  readonly completedRows: number;
  readonly cancelledRows: number;
  /** Rows whose money columns could not be read; left out of every cent figure below. */
  readonly unreadableRows: number;
  /** Completed rides, integer cents. */
  readonly fareCents: number;
  readonly cashCents: number;
  readonly onlineCents: number;
  readonly tipCents: number;
  /** cash ÷ (cash + online), 0–1; null when neither was paid. */
  readonly cashShare: number | null;
  readonly onlineShare: number | null;
  /** tip ÷ fare revenue, 0–1; null without fare revenue. */
  readonly tipShare: number | null;
  /** cancelled rows ÷ all rows, 0–1; null without rows. */
  readonly cancellationShare: number | null;
}

function cents(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return 0;
  try {
    return toCents(value);
  } catch {
    return null;
  }
}

function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

interface Totals {
  completed: number;
  cancelled: number;
  unreadable: number;
  fare: number;
  cash: number;
  online: number;
  tip: number;
}

function addRow(totals: Totals, row: ReferenceTripRow): void {
  if (row.is_canceled) {
    totals.cancelled += 1;
    return;
  }
  const fare = cents(row.price_amount);
  const cash = cents(row.cash_amount);
  const online = cents(row.online_amount);
  const tip = cents(row.tip_amount);
  if (fare === null || cash === null || online === null || tip === null) {
    totals.unreadable += 1;
    return;
  }
  totals.completed += 1;
  totals.fare += fare;
  totals.cash += cash;
  totals.online += online;
  totals.tip += tip;
}

export function referenceStats(months: readonly ReferenceMonthInput[]): ReferenceStats {
  const totals: Totals = { completed: 0, cancelled: 0, unreadable: 0, fare: 0, cash: 0, online: 0, tip: 0 };
  let rows = 0;
  for (const month of months) {
    rows += month.rows.length;
    for (const row of month.rows) addRow(totals, row);
  }
  const paid = totals.cash + totals.online;
  return {
    months: months.map(m => ({ year: m.year, month: m.month, rows: m.rows.length })),
    rows,
    completedRows: totals.completed,
    cancelledRows: totals.cancelled,
    unreadableRows: totals.unreadable,
    fareCents: totals.fare,
    cashCents: totals.cash,
    onlineCents: totals.online,
    tipCents: totals.tip,
    cashShare: share(totals.cash, paid),
    onlineShare: share(totals.online, paid),
    tipShare: share(totals.tip, totals.fare),
    cancellationShare: share(totals.cancelled, rows),
  };
}
