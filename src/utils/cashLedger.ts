import { toCents } from './money';

/**
 * The till, as one ledger.
 *
 * ## The money rule this preserves
 *
 * Cash in is the Bargeld a driver hands over (`income.type = 'bargeld'`). Cash
 * out is what leaves the till: a Beleg (`receipts.expense`) and, since
 * 20260914140000, a Gehaltsquittung — the cash salary payment
 * `confirm_salary_cash_payment` books as `cash_movements(direction = 'out')`.
 * Manual entries (`manual_in`, `manual_out`, written by `record_cash_movement`)
 * move the till by their direction like any other movement.
 * Voiding one books the cash back on the day of the void
 * (`gehaltsquittung_storno`, `direction = 'in'`), the way a cash book corrects
 * an entry rather than rewriting the day it was paid. So a receipt paid in
 * March and voided in April lowers March and raises April; the two cancel only
 * over a range that holds both.
 *
 * The balance is therefore
 *
 *     Bargeld − Belege − (Gehaltsquittungen − Stornos)
 *
 * and until a company issues its first Gehaltsquittung the last term is 0,
 * which is exactly the figure the screen showed before this module existed.
 *
 * **Only a Beleg paid in cash leaves the till.** `receipts.payment_method` is
 * `'bar'` or `'uberweisung'` (CHECK, default `'bar'`), and a bank transfer
 * never touched the till — the money left the account, not the cash box. The
 * database has always read it that way: `abrechnung_weekly`
 * (20260402065740:120) and `get_current_cash_balance`
 * (20260607124839:138) both restrict to `payment_method = 'bar'`, so a screen
 * that counts every Beleg contradicts the weekly Abrechnung the same company
 * reads one menu item away. `cashBelegRows()` is that restriction, applied by
 * the caller that asked for the column.
 *
 * **"Bar zurück" counts as paid and moves no cash.** The weekly settlement
 * writes a `salary_payments` row with `source_type = 'weekly_cash_difference'`
 * and no `cash_movements` row: the money was kept back from a weekly
 * settlement, never handed out of the till. This module reads the ledger and
 * never `salary_payments`, so that rule holds by construction — there is
 * nothing here to double-count.
 *
 * ## Cents
 *
 * Every figure is integer cents. The euro floats this replaced accumulated
 * drift over a month of rows (0.1 + 0.2 !== 0.3); `utils/money.ts` converts
 * once at the edge and the arithmetic below is exact. Formatting happens in
 * the screen, once, on the way out.
 *
 * Nothing here does I/O, so the aggregation is testable on its own
 * (`cashLedger.test.ts`).
 */

export type CashLedgerSource =
  | 'bargeld_income'
  | 'beleg'
  | 'gehaltsquittung'
  | 'gehaltsquittung_storno'
  /** Cash an owner put into the till by hand (record_cash_movement). */
  | 'manual_in'
  /** Cash taken out of the till by hand that is neither a Beleg nor a salary. */
  | 'manual_out'
  /** A `cash_movements.source_type` this module does not know yet. */
  | 'other';

export interface CashLedgerEntry {
  id: string;
  direction: 'in' | 'out';
  /** Signed cents, as the source row reads. Direction carries the sign of the movement. */
  amountCents: number;
  /** `YYYY-MM-DD`, as stored — compared as text, never parsed, so no timezone can shift a day. */
  date: string;
  description: string;
  driverName: string;
  source: CashLedgerSource;
}

export interface CashLedgerTotals {
  cashInCents: number;
  cashOutCents: number;
  /**
   * cashIn − cashOut, so every movement counts towards the till whatever its
   * source. It equals `bargeldIncome − beleg − salaryPayout` only while every
   * row belongs to a source this module knows; an `other` movement is in the
   * balance and in none of the three categories below.
   */
  balanceCents: number;
  bargeldIncomeCents: number;
  belegExpenseCents: number;
  /** Gehaltsquittungen minus their Stornos: the cash salaries took out of the till. */
  salaryPayoutCents: number;
  /** Cash added by hand (`manual_in`). Part of cashIn and of the balance. */
  manualInCents: number;
  /** Cash paid out by hand (`manual_out`). Part of cashOut and of the balance. */
  manualOutCents: number;
}

// ── Source rows, as the tables return them ───────────────────────────────────

export interface BargeldIncomeRow {
  id: string;
  amount: number | string | null;
  description?: string | null;
  driver_name?: string | null;
  date: string;
}

export interface BelegRow {
  id: string;
  expense: number | string | null;
  description?: string | null;
  driver_name?: string | null;
  date: string;
  /**
   * `'bar'` or `'uberweisung'`, as `receipts.payment_method` stores it.
   * Optional because a caller that reads the receipt through another shape
   * (`utils/overviewHelpers.ts` maps a `Receipt`) does not carry it — see
   * `cashBelegRows`, which is where the column is required.
   */
  payment_method?: string | null;
}

export interface CashMovementRow {
  id: string;
  direction: 'in' | 'out';
  amount: number | string | null;
  movement_date: string;
  source_type: string;
  source_id: string;
  description?: string | null;
}

/** Fallback texts, passed in so the dictionaries stay in the screen. */
export interface CashLedgerLabels {
  bargeldIncome: string;
  beleg: string;
  gehaltsquittung: string;
  gehaltsquittungStorno: string;
  manualIn: string;
  manualOut: string;
  /** A movement whose `source_type` this module does not know yet. */
  other: string;
}

/**
 * `receipts.expense` and `income.amount` are nullable numerics with a default
 * of 0, and the code this replaces read a NULL as `Number(null) === 0`. Keep
 * that, and only that: anything else that is not an amount still throws rather
 * than becoming a silent zero.
 */
function amountToCents(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  return toCents(value);
}

// ── Building entries ─────────────────────────────────────────────────────────

export function bargeldIncomeEntries(
  rows: readonly BargeldIncomeRow[],
  labels: CashLedgerLabels,
): CashLedgerEntry[] {
  return rows.map(row => ({
    id: row.id,
    direction: 'in' as const,
    amountCents: amountToCents(row.amount),
    date: row.date,
    description: row.description || labels.bargeldIncome,
    driverName: row.driver_name || '',
    source: 'bargeld_income' as const,
  }));
}

/**
 * The Belege that left the till, out of the Belege of a period.
 *
 * `payment_method = 'bar'` is the database's own rule, kept character for
 * character: `abrechnung_weekly` and `get_current_cash_balance` both write it
 * that way, so a NULL is excluded here exactly as SQL excludes it. The column
 * defaults to `'bar'`, so a NULL is an explicit act rather than an unset
 * value, and staging's copy of production holds none (853 `bar`, 4
 * `uberweisung`, 0 NULL on 28.09.2026).
 *
 * A caller that never selected the column gets nothing back, which shows up as
 * a total of 0,00 € — loud, not silent. That is deliberate: the rule belongs
 * next to the query that asks for the column, and a caller working from a row
 * shape without it must not be given a quietly plausible figure.
 */
export function cashBelegRows<Row extends { payment_method?: string | null }>(
  rows: readonly Row[],
): Row[] {
  return rows.filter(row => row.payment_method === 'bar');
}

/**
 * Every row given here is counted as cash out. Pass Belege through
 * `cashBelegRows` first when the rows carry `payment_method`: a bank-paid
 * Beleg never left the till, and counting it understates the cash a company
 * holds.
 */
export function belegEntries(
  rows: readonly BelegRow[],
  labels: CashLedgerLabels,
): CashLedgerEntry[] {
  return rows.map(row => ({
    id: row.id,
    direction: 'out' as const,
    amountCents: amountToCents(row.expense),
    date: row.date,
    description: row.description || labels.beleg,
    driverName: row.driver_name || '',
    source: 'beleg' as const,
  }));
}

/**
 * `cash_movements` rows.
 *
 * The ledger carries no driver: `source_id` points at the Gehaltsquittung, and
 * that is where the driver is. `driverNameBySourceId` is that lookup, so the
 * screen's driver filter reaches a payout as it reaches a Beleg. A movement
 * with no entry there simply has no driver, the way an income row without one
 * does.
 *
 * A `source_type` this module does not know still moved real cash, so its
 * `direction` decides the balance exactly as a known one does; only the
 * categorisation falls back to `other`. The CHECK constraint in
 * 20260914140000 allows the two Gehaltsquittung sources and nothing else, so
 * no such row exists today — but a later migration adding one (a float
 * top-up, a deposit) must not make cash disappear from a till. For a till,
 * invisible cash is worse than loosely categorised cash: the balance is what
 * an owner counts against, and a figure that silently omits a movement is
 * wrong with no signal, while an uncategorised one is merely coarse and still
 * visible in the table.
 */
export function cashMovementEntries(
  rows: readonly CashMovementRow[],
  labels: CashLedgerLabels,
  driverNameBySourceId: Readonly<Record<string, string>> = {},
): CashLedgerEntry[] {
  return rows.map(row => {
    const source = cashMovementSource(row.source_type);
    return {
      id: row.id,
      direction: row.direction,
      amountCents: amountToCents(row.amount),
      date: row.movement_date,
      description: row.description || sourceLabel(source, labels),
      driverName: driverNameBySourceId[row.source_id] || '',
      source,
    };
  });
}

function cashMovementSource(sourceType: string): CashLedgerSource {
  return sourceType === 'gehaltsquittung' || sourceType === 'gehaltsquittung_storno'
    || sourceType === 'manual_in' || sourceType === 'manual_out'
    ? sourceType
    : 'other';
}

function sourceLabel(source: CashLedgerSource, labels: CashLedgerLabels): string {
  switch (source) {
    case 'gehaltsquittung':
      return labels.gehaltsquittung;
    case 'gehaltsquittung_storno':
      return labels.gehaltsquittungStorno;
    case 'manual_in':
      return labels.manualIn;
    case 'manual_out':
      return labels.manualOut;
    default:
      return labels.other;
  }
}

// ── Aggregation ──────────────────────────────────────────────────────────────

export function summarizeCashLedger(entries: readonly CashLedgerEntry[]): CashLedgerTotals {
  let cashInCents = 0;
  let cashOutCents = 0;
  let bargeldIncomeCents = 0;
  let belegExpenseCents = 0;
  let salaryPayoutCents = 0;
  let manualInCents = 0;
  let manualOutCents = 0;

  for (const entry of entries) {
    if (entry.direction === 'in') cashInCents += entry.amountCents;
    else cashOutCents += entry.amountCents;

    switch (entry.source) {
      case 'bargeld_income':
        bargeldIncomeCents += entry.amountCents;
        break;
      case 'beleg':
        belegExpenseCents += entry.amountCents;
        break;
      case 'gehaltsquittung':
        salaryPayoutCents += entry.amountCents;
        break;
      case 'gehaltsquittung_storno':
        salaryPayoutCents -= entry.amountCents;
        break;
      case 'manual_in':
        manualInCents += entry.amountCents;
        break;
      case 'manual_out':
        manualOutCents += entry.amountCents;
        break;
      case 'other':
        // Already counted in cashIn/cashOut above, so the balance holds it;
        // no category claims it, because nothing here knows what it is.
        break;
    }
  }

  return {
    cashInCents,
    cashOutCents,
    balanceCents: cashInCents - cashOutCents,
    bargeldIncomeCents,
    belegExpenseCents,
    salaryPayoutCents,
    manualInCents,
    manualOutCents,
  };
}

// ── Ordering and filtering ───────────────────────────────────────────────────

/**
 * Newest first, ties broken by id so a re-render never reshuffles two entries
 * of the same day. Dates are `YYYY-MM-DD`, which sorts correctly as text.
 */
export function sortCashEntriesByDateDesc(entries: readonly CashLedgerEntry[]): CashLedgerEntry[] {
  return [...entries].sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : b.date < a.date ? -1 : 1));
}

export interface CashLedgerFilter {
  /** Exact driver name, as the screen's select offers it. */
  driverName?: string;
  direction?: 'in' | 'out';
  /** Inclusive `YYYY-MM-DD` bounds, compared as text like the screen always did. */
  from?: string;
  to?: string;
}

export function filterCashEntries(
  entries: readonly CashLedgerEntry[],
  filter: CashLedgerFilter,
): CashLedgerEntry[] {
  return entries.filter(entry => {
    if (filter.driverName && entry.driverName !== filter.driverName) return false;
    if (filter.direction && entry.direction !== filter.direction) return false;
    if (filter.from && entry.date < filter.from) return false;
    if (filter.to && entry.date > filter.to) return false;
    return true;
  });
}

/** The driver names present in the ledger, sorted, for the screen's filter. */
export function cashLedgerDriverNames(entries: readonly CashLedgerEntry[]): string[] {
  return Array.from(new Set(entries.map(e => e.driverName).filter(Boolean))).sort();
}
