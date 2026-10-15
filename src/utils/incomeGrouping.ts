/**
 * The Umsätze list grouped as month → week → day → driver. Pure; no React.
 *
 * - A week belongs to the month containing its MONDAY (`weekCalculations`'
 *   rule), so a calendar-month split is never used: 01.-04.10.2026 lie in the
 *   week of Monday 28.09. and are September's.
 * - Every total is integer cents, and every level is the sum of the level below
 *   it, built that way (`sumTotals`) rather than recomputed from the rows, so
 *   a month cannot disagree with its weeks. `incomeGrouping.test.ts` asserts it.
 * - A row from a WEEKLY Uber import has no day of its own: its period spans
 *   several days and the figure is the week's. It is NOT spread over the days
 *   (that would invent per-day figures); it sits in its week under a bucket
 *   whose `date` is null. A row typed by hand, or imported for one day, has its
 *   date as its day.
 * - "Summe" is Netto-Fahrpreis plus Aktionen, as everywhere on the screen;
 *   Trinkgeld and Bargeld are pass-through and stay separate columns.
 */
import type { Income } from '../types/receipt';
import { mondayOf } from '../../supabase/functions/_shared/uber-earnings-core';
import { toCents } from './money';
import { weekNumberOf } from './uberEarningsImport';

/** The columns income rows carry beyond `Income`; present in `select('*')`. */
export type GroupableIncome = Pick<Income, 'id' | 'driver_name' | 'date' | 'type' | 'amount'> & {
  source?: string | null;
  source_period_start?: string | null;
  source_period_end?: string | null;
};

export interface IncomeTotals {
  umsatzCents: number;
  aktionenCents: number;
  trinkgeldCents: number;
  bargeldCents: number;
  /** Netto-Fahrpreis + Aktionen. */
  sumCents: number;
  rowCount: number;
}

export interface DriverGroup { driverName: string; totals: IncomeTotals; rows: GroupableIncome[] }
/** `date` is null for the bucket of rows that carry a whole week and no day. */
export interface DayGroup { date: string | null; totals: IncomeTotals; drivers: DriverGroup[] }
export interface WeekGroup { monday: string; weekNumber: number; totals: IncomeTotals; days: DayGroup[] }
export interface MonthGroup { year: number; month: number; totals: IncomeTotals; weeks: WeekGroup[] }

export function emptyTotals(): IncomeTotals {
  return { umsatzCents: 0, aktionenCents: 0, trinkgeldCents: 0, bargeldCents: 0, sumCents: 0, rowCount: 0 };
}

/** The one place totals are added, so every level uses the same arithmetic. */
export function sumTotals(parts: readonly IncomeTotals[]): IncomeTotals {
  const out = emptyTotals();
  for (const p of parts) {
    out.umsatzCents += p.umsatzCents;
    out.aktionenCents += p.aktionenCents;
    out.trinkgeldCents += p.trinkgeldCents;
    out.bargeldCents += p.bargeldCents;
    out.sumCents += p.sumCents;
    out.rowCount += p.rowCount;
  }
  return out;
}

const FIELD_OF_TYPE: Record<Income['type'], 'umsatzCents' | 'aktionenCents' | 'trinkgeldCents' | 'bargeldCents'> = {
  umsatz: 'umsatzCents',
  aktionen: 'aktionenCents',
  trinkgeld: 'trinkgeldCents',
  bargeld: 'bargeldCents',
};

/** Throws (RangeError) on an amount that is not a finite decimal: never a silent 0. */
function totalsOfRows(rows: readonly GroupableIncome[]): IncomeTotals {
  const out = emptyTotals();
  for (const row of rows) {
    const field = FIELD_OF_TYPE[row.type];
    if (!field) throw new RangeError(`unknown income type: ${String(row.type)}`);
    const cents = toCents(row.amount);
    out[field] += cents;
    if (row.type === 'umsatz' || row.type === 'aktionen') out.sumCents += cents;
    out.rowCount += 1;
  }
  return out;
}

/** True for a row that stands for several days, which therefore has no day of its own. */
export function isWeekLevelRow(row: GroupableIncome): boolean {
  const start = row.source_period_start;
  const end = row.source_period_end;
  return row.source === 'uber' && !!start && !!end && start !== end;
}

function dayOf(row: GroupableIncome): string | null {
  return isWeekLevelRow(row) ? null : row.date;
}

/** The Monday of the business week a row belongs to. */
function mondayOfRow(row: GroupableIncome): string {
  return mondayOf(isWeekLevelRow(row) ? row.source_period_start! : row.date);
}

function bucket<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function driverGroups(rows: readonly GroupableIncome[]): DriverGroup[] {
  const byDriver = new Map<string, GroupableIncome[]>();
  for (const row of rows) bucket(byDriver, row.driver_name, row);
  return [...byDriver.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'de'))
    .map(([driverName, list]) => ({ driverName, totals: totalsOfRows(list), rows: list }));
}

function dayGroups(rows: readonly GroupableIncome[]): DayGroup[] {
  const byDay = new Map<string, GroupableIncome[]>();
  for (const row of rows) bucket(byDay, dayOf(row) ?? '', row);
  // Newest day first; the whole-week bucket ('' key) closes the week.
  const keys = [...byDay.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : b.localeCompare(a)));
  return keys.map(key => {
    const drivers = driverGroups(byDay.get(key)!);
    return { date: key === '' ? null : key, totals: sumTotals(drivers.map(d => d.totals)), drivers };
  });
}

function weekGroups(rows: readonly GroupableIncome[]): WeekGroup[] {
  const byMonday = new Map<string, GroupableIncome[]>();
  for (const row of rows) bucket(byMonday, mondayOfRow(row), row);
  return [...byMonday.keys()].sort((a, b) => b.localeCompare(a)).map(monday => {
    const days = dayGroups(byMonday.get(monday)!);
    return {
      monday,
      weekNumber: weekNumberOf({ from: monday, to: monday, monday }),
      totals: sumTotals(days.map(d => d.totals)),
      days,
    };
  });
}

/**
 * Month → week → day → driver, newest first. Throws when an amount cannot be
 * read; the screen treats that like a failed load instead of showing a total.
 */
export function groupIncome(rows: readonly GroupableIncome[]): MonthGroup[] {
  const byMonth = new Map<string, GroupableIncome[]>();
  for (const row of rows) bucket(byMonth, mondayOfRow(row).slice(0, 7), row);
  return [...byMonth.keys()].sort((a, b) => b.localeCompare(a)).map(key => {
    const weeks = weekGroups(byMonth.get(key)!);
    const [year, month] = key.split('-').map(Number);
    return { year: year!, month: month!, totals: sumTotals(weeks.map(w => w.totals)), weeks };
  });
}

// ── Views over the grouping (the Umsätze list's day / week / month tabs) ──────
// None of these adds a row's amount: they re-order the groups `groupIncome`
// built, and merge driver groups with `sumTotals`, the one place cents are added.

/** The Sunday that closes a business week, from its Monday. Display only. */
export function weekEndOf(monday: string): string {
  const [y, m, d] = monday.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 6)).toISOString().slice(0, 10);
}

export interface DayEntry { day: DayGroup; week: WeekGroup }

/** Every day of every week, newest first (a month never splits a week). */
export function flattenDays(months: readonly MonthGroup[]): DayEntry[] {
  return months.flatMap(month => month.weeks.flatMap(week => week.days.map(day => ({ day, week }))));
}

/** Every week, newest first. */
export function flattenWeeks(months: readonly MonthGroup[]): WeekGroup[] {
  return months.flatMap(month => month.weeks);
}

/** One group per driver over several days, totals added with `sumTotals`. */
export function mergeDriverGroups(days: readonly DayGroup[]): DriverGroup[] {
  const byDriver = new Map<string, DriverGroup[]>();
  for (const day of days) for (const driver of day.drivers) bucket(byDriver, driver.driverName, driver);
  return [...byDriver.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'de'))
    .map(([driverName, list]) => ({
      driverName,
      totals: sumTotals(list.map(d => d.totals)),
      rows: list.flatMap(d => d.rows),
    }));
}

export const driversOfWeek = (week: WeekGroup): DriverGroup[] => mergeDriverGroups(week.days);
export const driversOfMonth = (month: MonthGroup): DriverGroup[] =>
  mergeDriverGroups(month.weeks.flatMap(week => week.days));
