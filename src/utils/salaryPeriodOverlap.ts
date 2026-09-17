/**
 * Salary periods that overlap — the condition `confirm_salary_cash_payment`
 * refuses as `overlapping_salary`.
 *
 * A driver may hold two salary rows whose periods overlap: `unique_driver_period`
 * is only `UNIQUE (driver_id, period_start)`, so a calendar month beside a
 * business month passes it (CLAUDE.md, *Domain rules that are easy to break*).
 * The owner merges such rows by hand before paying, and the RPC keeps refusing
 * a cash payment until he does — so the screens have to make them findable.
 *
 * This module is the browser's mirror of the one condition in
 * `supabase/migrations/20260914140000_salary_cash_receipts.sql`:
 *
 *     s.driver_id    =  v_salary.driver_id
 *     AND s.id       <> v_salary.id
 *     AND s.period_start <= v_salary.period_end
 *     AND s.period_end   >= v_salary.period_start
 *
 * Two properties of that SQL are reproduced deliberately:
 *
 * - **The comparison is inclusive.** Two periods that share a single day —
 *   one ends on the day the other begins — overlap. Two consecutive periods
 *   (one ends the day *before* the next begins) do not. Business months are
 *   consecutive in that second sense, so a month and the month after it never
 *   collide; a business month and the calendar month of the same name do.
 * - **A NULL end date matches nothing.** In SQL a comparison against NULL is
 *   unknown, never true, so such a row is not refused. `salaries.period_end`
 *   is `NOT NULL`, so this is defensive only — but a marker that claimed an
 *   overlap the RPC would allow would be worse than no marker.
 *
 * Dates are `YYYY-MM-DD` text, so text order is date order and no Date is
 * constructed; that also keeps the comparison out of the browser's timezone.
 */

/** The part of a salary row an overlap is computed from. */
export interface SalaryPeriod {
  /** YYYY-MM-DD */
  period_start: string | null | undefined;
  /** YYYY-MM-DD */
  period_end: string | null | undefined;
}

/** A stored salary row: a period that can be pointed at. */
export interface IdentifiedSalaryPeriod extends SalaryPeriod {
  id: string;
}

/**
 * Whether two periods share at least one day, the way the RPC compares them.
 * A period missing either end overlaps nothing, as in SQL.
 */
export function salaryPeriodsOverlap(a: SalaryPeriod, b: SalaryPeriod): boolean {
  if (!a.period_start || !a.period_end || !b.period_start || !b.period_end) return false;
  return b.period_start <= a.period_end && b.period_end >= a.period_start;
}

/**
 * The rows of one driver whose period overlaps `period`, earliest period first.
 *
 * `excludeId` is the row `period` itself came from, when it is a stored row;
 * pass nothing for a period that has no row yet (the salaries screen shows one
 * line per driver whether or not a row exists for it, and creating that row is
 * exactly what would produce the next overlap).
 *
 * `driverRows` must already be one driver's rows — `groupSalaryPeriodsByDriver`
 * builds that index once for a whole company.
 */
export function findOverlappingSalaryPeriods<Row extends IdentifiedSalaryPeriod>(
  period: SalaryPeriod,
  driverRows: readonly Row[],
  excludeId?: string | null,
): Row[] {
  return driverRows
    .filter(row => row.id !== excludeId && salaryPeriodsOverlap(period, row))
    .sort((left, right) => (left.period_start ?? '').localeCompare(right.period_start ?? ''));
}

/**
 * The company's salary rows indexed by driver, so a screen that already holds
 * every row can answer one driver at a time without a query per row.
 */
export function groupSalaryPeriodsByDriver<Row extends IdentifiedSalaryPeriod & { driver_id: string }>(
  rows: readonly Row[],
): Map<string, Row[]> {
  const byDriver = new Map<string, Row[]>();
  for (const row of rows) {
    const existing = byDriver.get(row.driver_id);
    if (existing) existing.push(row);
    else byDriver.set(row.driver_id, [row]);
  }
  return byDriver;
}
