/**
 * The period chooser of the Uber earnings import: which Uber weeks and months
 * the operator can pick, and how a pick becomes the `from` / `to` the rest of
 * the flow already uses. Pure; no React, no network.
 *
 * Uber's weeks run Monday 04:00 to the next Monday 04:00 (Europe/Berlin), and a
 * week belongs to the month containing its MONDAY, which is what gives a month
 * four or five weeks. `weekNumberOf` supplies the `Woche N` the books carry, so
 * the number on the chooser is the number written to `income.description`.
 */
import {
  MAX_RANGE_DAYS,
  addDaysIso,
  diffDaysIso,
  mondayOf,
  type WeekSegment,
} from '../../supabase/functions/_shared/uber-earnings-core';
import { UBER_WEEK_START_HOUR, weekNumberOf } from './uberEarningsImport';

/** Half a year of weeks: enough to catch up on a missed month, short enough to scroll. */
export const UBER_WEEKS_BACK = 26;

/** Six months back plus the current one: the monthly list is for recent months only. */
export const UBER_MONTHS_BACK = 6;

/** Whole weeks one pull may cover; the edge function calls Reidey once per week. */
export const MAX_SELECTABLE_WEEKS = Math.floor(MAX_RANGE_DAYS / 7);

export interface UberWeek {
  /** A whole Monday..Sunday week. */
  segment: WeekSegment;
  /** `Woche N`: the index inside the business month. */
  weekNumber: number;
  /** The business month (1-12) and its year: those of the Monday. */
  year: number;
  month: number;
  /** Not yet over: Uber's week ends Monday 04:00. */
  running: boolean;
}

export interface UberMonth {
  year: number;
  month: number;
  /** Every week of the business month, running and not yet started ones included. */
  weeks: UberWeek[];
  /** Weeks that have started (the running one counts); picking the month selects these. */
  startedCount: number;
  /** Weeks that are over. Less than `weeks.length` while the month is still going. */
  completeCount: number;
}

/** A contiguous run of weeks, named by the Mondays of its first and last week. */
export interface WeekRange {
  first: string;
  last: string;
}

/**
 * The Uber day `now` falls in. Before 04:00 Berlin time it is still the
 * previous day's Uber day, so Monday 02:00 is the end of last week.
 */
export function uberDayOf(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  return Number(get('hour')) < UBER_WEEK_START_HOUR ? addDaysIso(date, -1) : date;
}

function toWeek(monday: string, runningMonday: string): UberWeek {
  const segment: WeekSegment = { from: monday, to: addDaysIso(monday, 6), monday };
  const [year, month] = monday.split('-').map(Number);
  return { segment, weekNumber: weekNumberOf(segment), year, month, running: monday === runningMonday };
}

/** The running week plus `back` finished ones, newest first. */
export function recentUberWeeks(now: Date, back: number = UBER_WEEKS_BACK): UberWeek[] {
  const current = mondayOf(uberDayOf(now));
  return Array.from({ length: back + 1 }, (_, i) => toWeek(addDaysIso(current, -7 * i), current));
}

/** Runs of weeks sharing a business month, in the order given. */
export function groupWeeksByMonth(
  weeks: readonly UberWeek[],
): Array<{ year: number; month: number; weeks: UberWeek[] }> {
  const groups: Array<{ year: number; month: number; weeks: UberWeek[] }> = [];
  for (const week of weeks) {
    const last = groups[groups.length - 1];
    if (last && last.year === week.year && last.month === week.month) last.weeks.push(week);
    else groups.push({ year: week.year, month: week.month, weeks: [week] });
  }
  return groups;
}

/** Every Monday that lies in the calendar month, ascending. */
function mondaysOfMonth(year: number, month: number): string[] {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const first = `${prefix}-01`;
  let monday = mondayOf(first);
  if (monday < first) monday = addDaysIso(monday, 7);
  const out: string[] = [];
  while (monday.startsWith(prefix)) {
    out.push(monday);
    monday = addDaysIso(monday, 7);
  }
  return out;
}

/** The current business month and the `back` before it, newest first. */
export function recentUberMonths(now: Date, back: number = UBER_MONTHS_BACK): UberMonth[] {
  const current = mondayOf(uberDayOf(now));
  const [startYear, startMonth] = current.split('-').map(Number);
  return Array.from({ length: back + 1 }, (_, i) => {
    const index = startYear * 12 + (startMonth - 1) - i;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    const weeks = mondaysOfMonth(year, month).map(m => toWeek(m, current));
    const startedCount = weeks.filter(w => w.segment.monday <= current).length;
    const completeCount = weeks.filter(w => w.segment.monday < current).length;
    return { year, month, weeks, startedCount, completeCount };
  });
}

/** The most recent finished week: what the chooser opens on. */
export function defaultWeekRange(now: Date): WeekRange {
  const monday = addDaysIso(mondayOf(uberDayOf(now)), -7);
  return { first: monday, last: monday };
}

/** Picking a month selects every week of it that has started. */
export function rangeForMonth(month: UberMonth): WeekRange | null {
  const started = month.weeks.slice(0, month.startedCount);
  const first = started[0];
  const last = started[started.length - 1];
  return first && last ? { first: first.segment.monday, last: last.segment.monday } : null;
}

/**
 * A click on a week. The result is always a contiguous run, because the pull
 * takes one `from` and one `to` and would fetch a skipped week anyway:
 * - nothing selected: that week;
 * - a week outside the run extends it to reach that week, gap included;
 * - the only selected week clears the selection;
 * - an end week shrinks the run by one week;
 * - an interior week starts over with just that week.
 */
export function toggleWeek(range: WeekRange | null, monday: string): WeekRange | null {
  if (!range) return { first: monday, last: monday };
  if (monday < range.first) return { first: monday, last: range.last };
  if (monday > range.last) return { first: range.first, last: monday };
  if (range.first === range.last) return null;
  if (monday === range.first) return { first: addDaysIso(range.first, 7), last: range.last };
  if (monday === range.last) return { first: range.first, last: addDaysIso(range.last, -7) };
  return { first: monday, last: monday };
}

export function isWeekSelected(range: WeekRange | null, monday: string): boolean {
  return range !== null && monday >= range.first && monday <= range.last;
}

export function rangeWeekCount(range: WeekRange | null): number {
  return range ? diffDaysIso(range.first, range.last) / 7 + 1 : 0;
}

/** True when the pull would be refused for length; the screen says so before sending. */
export function rangeExceedsCap(range: WeekRange | null): boolean {
  return rangeWeekCount(range) > MAX_SELECTABLE_WEEKS;
}

/** The `from` / `to` the pull, the preview and the write already use. */
export function rangeToDates(range: WeekRange): { from: string; to: string } {
  return { from: range.first, to: addDaysIso(range.last, 6) };
}

/**
 * Reidey names its length refusal `range_exceeds_<n>_days`, so the code changes
 * with its limit. Both spellings are the same refusal and read as one sentence.
 */
export function normalizePartnerReason(reason: string): string {
  return /^range_exceeds_\d+_days$/.test(reason) ? 'range_too_long' : reason;
}
