import { SOURCE_TIME_ZONE, formatWall, wallAt, wallTimeToInstant } from '../fahrtenbuchImportParser';
import { operatingDayIn } from './period';

const OPERATING_DAY_START_HOUR = 4;

export function localHour(ms: number): number {
  return wallAt(ms, SOURCE_TIME_ZONE).hour;
}

/**
 * The day a ride belongs to when days start at 04:00 (the same rule the shift
 * recommendation uses).
 *
 * It used to subtract four hours of **absolute** time and read the calendar day
 * of the result. Four absolute hours are not four clock hours on a day the
 * offset changes, so a ride at 04:30 local on the spring-forward day was dated
 * the day before while the same reading on every other day was dated the same
 * day — measured in `dstProbe.test.ts`. The rule now lives in `period.ts`,
 * stated on the clock, and this is the call with the shipped defaults. Nothing
 * outside this folder reads it, so no stored row moves.
 */
export function operatingDayOf(ms: number): string {
  return operatingDayIn(ms, SOURCE_TIME_ZONE, OPERATING_DAY_START_HOUR);
}

/** 04:00 local on the given calendar day; null on a day where that clock reading is not unique. */
export function operatingDayStartMs(year: number, month: number, day: number): number | null {
  const result = wallTimeToInstant({ year, month, day, hour: OPERATING_DAY_START_HOUR, minute: 0, second: 0 });
  return result.kind === 'ok' ? result.ms : null;
}

/**
 * True when the clock reading of this instant names exactly this instant again.
 * It is false in the repeated hour of October and, for a reading that does not
 * exist, in March. The importer stores those rows as unreadable, so the
 * generator never writes one.
 */
export function isUniqueWallTime(ms: number): boolean {
  const wall = wallAt(ms, SOURCE_TIME_ZONE);
  const back = wallTimeToInstant(wall);
  return back.kind === 'ok' && back.ms === Math.floor(ms / 1000) * 1000;
}

/**
 * "2026-09-01 08:19:12.858" — the zone-less shape the export writes.
 *
 * A timestamp is a whole number of milliseconds, and this is the boundary that
 * makes it so. Given a fractional `ms`, `String(ms % 1000)` printed
 * "441.665771484375" where three digits belong and `padStart(3, '0')` left it,
 * so the cell carried two decimal points and `DATETIME_RE` — which admits one
 * fractional group — could not read it at all (FB-HIGH-001, 52 of 255 cells of
 * one audited month). The producer no longer makes such a value; this floor is
 * the second wall, so no future producer can make the shape malformed.
 *
 * Floored, never rounded: rounding 25.9997 s up would print second 26, an
 * instant the value does not name, and would part the printed second from the
 * printed milliseconds. `wallAt` truncates the same way, so the two agree.
 */
export function formatStamp(ms: number, withMillis: boolean): string {
  const whole = Math.floor(ms);
  const base = formatWall(wallAt(whole, SOURCE_TIME_ZONE));
  const millis = String(((whole % 1000) + 1000) % 1000).padStart(3, '0');
  return `${base}.${withMillis ? millis : '000'}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
