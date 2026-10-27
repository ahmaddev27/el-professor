import { wallAt, wallTimeToInstant } from '../fahrtenbuchImportParser';
import type { SimulationTenantSettings } from './tenantSettings';

/**
 * The period a generated month covers: every calendar day of it, and the rule
 * that says which day a ride belongs to (external audit round 3, section 2).
 *
 * ## The operating-day rule, and the defect this module fixes
 *
 * `time.ts`'s `operatingDayOf` dated a ride by subtracting four hours of
 * **absolute** time and reading the calendar day of the result. On a day where
 * the offset changes, four absolute hours are not four clock hours, so the
 * rule mis-dated exactly the rides whose clock reading sits within the cutoff
 * of the change. Measured on 27.10.2026, in `dstProbe.test.ts`, with
 * `TZ=Europe/Berlin`:
 *
 * | reading (local)                  | old answer     | correct    |
 * |----------------------------------|----------------|------------|
 * | 2026-03-29 04:30 (spring foward) | **2026-03-28** | 2026-03-29 |
 * | 2026-06-15 04:30 (plain day)     | 2026-06-15     | 2026-06-15 |
 *
 * So a ride that began at half past four in the morning was written into
 * `Datum der Fahrt` as the day before, on one day a year, and on every other
 * day of the year the same reading was written as the same day. The rule here
 * is stated on the **clock** instead: read the wall time, and if its hour is
 * below the cutoff the ride belongs to the previous calendar day. No absolute
 * arithmetic crosses the offset change, so the answer cannot depend on it.
 *
 * `operatingDayOf` delegates here with the defaults, so the fix lands once.
 * Nothing outside `src/utils/simulatedRides/` calls it: the stored ledger's
 * own `trip_date` is the file's "Datum der Fahrt" read literally, and no row
 * in any database moves because of this change.
 */

/** A zone-free calendar date. */
interface CivilDate {
  year: number;
  month: number;
  day: number;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

export const formatCivil = (d: CivilDate): string => `${d.year}-${pad2(d.month)}-${pad2(d.day)}`;

/**
 * One calendar day earlier. Computed with `Date.UTC`, which is zone-free, so
 * the answer never depends on the machine's zone or on the tenant's — stepping
 * a *calendar* day is a question about the calendar, not about an instant.
 */
export function previousCivilDay(d: CivilDate): CivilDate {
  const utc = new Date(Date.UTC(d.year, d.month - 1, d.day));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

/** Days in a calendar month; `month` counts from 1. */
export function daysInCalendarMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The operating day an instant belongs to, in the given zone, when days start
 * at `cutoffHour`. See the header for why this reads the clock and never
 * subtracts hours.
 */
export function operatingDayIn(ms: number, zone: string, cutoffHour: number): string {
  const wall = wallAt(Math.floor(ms), zone);
  const civil: CivilDate = { year: wall.year, month: wall.month, day: wall.day };
  return formatCivil(wall.hour < cutoffHour ? previousCivilDay(civil) : civil);
}

/** Every calendar day of the month, `YYYY-MM-DD`, in order. 28, 29, 30 or 31 of them. */
export function calendarDaysOfMonth(year: number, month: number): string[] {
  const count = daysInCalendarMonth(year, month);
  const out: string[] = [];
  for (let day = 1; day <= count; day++) out.push(formatCivil({ year, month, day }));
  return out;
}

/** The start of one operating day as an instant, or a reason it has none. */
export type DayStart =
  | { kind: 'ok'; ms: number }
  | { kind: 'skipped' }
  | { kind: 'ambiguous' };

/**
 * `cutoffHour:00` local on one calendar day.
 *
 * It is not always an instant. In the hour the clocks skip, that reading never
 * happens; in the hour they repeat, it happens twice. The importer stores such
 * a row as unreadable rather than guessing, so the generator must not write
 * one — the day is reported as having no usable start instead, which is a
 * constraint on the period and is carried into the summary rather than
 * silently dropped.
 */
export function operatingDayStartIn(day: string, zone: string, cutoffHour: number): DayStart {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!parts) return { kind: 'skipped' };
  const result = wallTimeToInstant(
    { year: Number(parts[1]), month: Number(parts[2]), day: Number(parts[3]), hour: cutoffHour, minute: 0, second: 0 },
    zone,
  );
  if (result.kind === 'ok') return { kind: 'ok', ms: result.ms };
  return result.kind === 'ambiguous' ? { kind: 'ambiguous' } : { kind: 'skipped' };
}

/** One day of the generated period, with the clock facts the summary needs. */
export interface PeriodDay {
  /** `YYYY-MM-DD`. */
  day: string;
  /** ISO weekday, Monday = 1. */
  isoWeekday: number;
  /** The instant the operating day starts, or null when the clock has no such reading. */
  startMs: number | null;
  /** Why it has none, when it has none. */
  startProblem: 'skipped' | 'ambiguous' | null;
  /**
   * How many hours this operating day holds. 23 or 25 on a transition day, 24
   * otherwise — the figure a per-day utilisation sum has to divide by.
   */
  hours: number;
}

/** ISO weekday of a civil date, Monday = 1. Zone-free, like `previousCivilDay`. */
export function isoWeekdayOf(day: string): number {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!parts) return 0;
  const utcDay = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))).getUTCDay();
  return utcDay === 0 ? 7 : utcDay;
}

/**
 * The whole period: one entry per calendar day of the month, **including the
 * days that will carry no ride at all**. Section 2 asks for every day of a
 * 28/29/30/31-day month in the summary and forbids shortening the period to a
 * sample, so the day list is built from the calendar first and the rides are
 * placed into it afterwards — never the other way round.
 */
export function buildPeriod(year: number, month: number, settings: SimulationTenantSettings): PeriodDay[] {
  const { timeZone, operatingDayStartHour } = settings;
  return calendarDaysOfMonth(year, month).map((day, index, all) => {
    const start = operatingDayStartIn(day, timeZone, operatingDayStartHour);
    const nextDay = index + 1 < all.length ? all[index + 1] : null;
    const next = nextDay ? operatingDayStartIn(nextDay, timeZone, operatingDayStartHour) : null;
    const startMs = start.kind === 'ok' ? start.ms : null;
    const hours =
      startMs !== null && next && next.kind === 'ok' ? Math.round((next.ms - startMs) / 3_600_000) : 24;
    return {
      day,
      isoWeekday: isoWeekdayOf(day),
      startMs,
      startProblem: start.kind === 'ok' ? null : start.kind,
      hours,
    };
  });
}
