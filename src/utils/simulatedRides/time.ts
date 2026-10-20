import { SOURCE_TIME_ZONE, formatWall, wallAt, wallDate, wallTimeToInstant } from '../fahrtenbuchImportParser';

const HOUR_MS = 3_600_000;
const OPERATING_DAY_START_HOUR = 4;

export function localHour(ms: number): number {
  return wallAt(ms, SOURCE_TIME_ZONE).hour;
}

/** The day a ride belongs to when days start at 04:00 (the same rule the shift recommendation uses). */
export function operatingDayOf(ms: number): string {
  return wallDate(wallAt(ms - OPERATING_DAY_START_HOUR * HOUR_MS, SOURCE_TIME_ZONE));
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

/** "2026-09-01 08:19:12.858" — the zone-less shape the export writes. */
export function formatStamp(ms: number, withMillis: boolean): string {
  const base = formatWall(wallAt(ms, SOURCE_TIME_ZONE));
  const millis = String(((ms % 1000) + 1000) % 1000).padStart(3, '0');
  return `${base}.${withMillis ? millis : '000'}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
