/**
 * The recorded shifts the Fahrtenanalyse compares the trips with.
 *
 * In release 1 there is no working-time record apart from the trips themselves
 * (the plan, "ناقص كلياً"). The one record of when a driver was on duty is the
 * saved Stundennachweis: `saved_stundennachweise.rows_json`, one row per day
 * with up to three von/bis pairs as `HH:MM` wall-clock text. This module turns
 * those pairs into the absolute intervals the engine reads (`AnalysisShift`,
 * epoch milliseconds, half-open).
 *
 * It is input preparation, not analysis: it decides nothing about a shift
 * beyond where it lies on the clock.
 *
 * ## The clock is Europe/Berlin, whatever the browser's zone is
 *
 * A Stundennachweis is a German document about German days. A browser set to
 * another zone must not move a shift by its own offset, so the conversion asks
 * `Intl` for Berlin's offset at the instant and never uses `new Date(y, m, d)`.
 *
 * Two wall-clock times a year do not map to exactly one instant:
 *
 *   - the last Sunday of March, 02:00–02:59 does not exist. Such a time is read
 *     with the offset in force just before the switch (+01:00), so 02:30 lands
 *     on 03:30 summer time — the instant a clock that was not adjusted shows.
 *   - the last Sunday of October, 02:00–02:59 happens twice. The earlier one
 *     (summer time) is taken.
 *
 * Both are counted (`dstAdjusted`) so the screen can say so; neither is dropped.
 *
 * ## What a pair means
 *
 *   von < bis   the same day
 *   bis < von   across midnight, ending the next day (the Stundennachweis
 *               computes its minutes the same way)
 *   bis = von   zero minutes, as the Stundennachweis counts it: no shift
 *   one of the two missing, or not a time: unreadable, counted, skipped
 */
import type { AnalysisShift } from '../utils/tripAnalysis/types';

/** The source every shift from this module carries, reported by the engine unchanged. */
export const SAVED_STUNDENNACHWEIS_SOURCE = 'saved_stundennachweis';

const BERLIN = 'Europe/Berlin';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The columns of `saved_stundennachweise` this module reads. */
export interface SavedStundennachweisRecord {
  id: string;
  driver_id: string;
  /** 1-based, as the column stores it. */
  month: number;
  year: number;
  rows_json: unknown;
}

export interface ShiftConversion {
  shifts: AnalysisShift[];
  /** Pairs with only one side, or a side that is not a time. Skipped. */
  unreadable: number;
  /** Times inside the DST switch, resolved as described in the header. */
  dstAdjusted: number;
}

let offsetFormat: Intl.DateTimeFormat | null = null;

function berlinFormat(): Intl.DateTimeFormat {
  offsetFormat ??= new Intl.DateTimeFormat('en-US', {
    timeZone: BERLIN,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return offsetFormat;
}

/** Berlin's offset from UTC at an instant, in milliseconds (+01:00 → 3 600 000). */
export function berlinOffsetMs(instantMs: number): number {
  const parts = berlinFormat().formatToParts(new Date(instantMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === type)?.value ?? NaN);
  const wallAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour') % 24, part('minute'), part('second'));
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

export interface BerlinInstant {
  ms: number;
  /** True when the wall-clock time fell into the DST switch. */
  adjusted: boolean;
}

/**
 * The instant a Berlin wall-clock time names. `month` is 1-based. `hour` may be
 * 24 (the Stundennachweis writes the end of a day that way), which is 00:00 of
 * the next day.
 */
export function berlinWallClockToInstant(year: number, month: number, day: number, hour: number, minute: number): BerlinInstant {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = [...new Set([berlinOffsetMs(wall - 12 * HOUR_MS), berlinOffsetMs(wall + 12 * HOUR_MS)])];
  // Largest offset first: of two valid readings, the earlier instant wins.
  const valid = offsets
    .sort((a, b) => b - a)
    .filter(offset => berlinOffsetMs(wall - offset) === offset);

  if (valid.length === 1) return { ms: wall - valid[0], adjusted: false };
  if (valid.length > 1) return { ms: wall - valid[0], adjusted: true };
  // Nonexistent: read with the offset in force before the switch.
  return { ms: wall - berlinOffsetMs(wall - 12 * HOUR_MS), adjusted: true };
}

const TIME = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

function parseTime(text: unknown): { hour: number; minute: number } | null {
  if (typeof text !== 'string') return null;
  const match = TIME.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 24 || (hour === 24 && minute !== 0)) return null;
  return { hour, minute };
}

const isBlank = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** The calendar day of one stored row: `date_key` first, then the day index in the record's month. */
function rowDay(row: Record<string, unknown>, record: SavedStundennachweisRecord): { year: number; month: number; day: number } | null {
  if (typeof row.date_key === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(row.date_key);
    if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  }
  if (typeof row.dayIndex === 'number' && Number.isInteger(row.dayIndex) && row.dayIndex >= 1 && row.dayIndex <= 31) {
    return { year: record.year, month: record.month, day: row.dayIndex };
  }
  return null;
}

/**
 * Every von/bis pair of the given records as an `AnalysisShift`, in record,
 * day and pair order. Ids are `<record id>:<YYYY-MM-DD>:<pair>`, so a finding
 * that cites a shift names the Stundennachweis line it came from.
 */
export function shiftsFromSavedStundennachweise(records: readonly SavedStundennachweisRecord[]): ShiftConversion {
  const shifts: AnalysisShift[] = [];
  let unreadable = 0;
  let dstAdjusted = 0;

  for (const record of records) {
    const rows = Array.isArray(record.rows_json) ? record.rows_json : [];
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const day = rowDay(row, record);

      for (const pair of [1, 2, 3]) {
        const vonText = row[`von${pair}`];
        const bisText = row[`bis${pair}`];
        if (isBlank(vonText) && isBlank(bisText)) continue;

        const von = parseTime(vonText);
        const bis = parseTime(bisText);
        if (!day || !von || !bis) {
          unreadable += 1;
          continue;
        }

        const vonMinutes = von.hour * 60 + von.minute;
        const bisMinutes = bis.hour * 60 + bis.minute;
        if (vonMinutes === bisMinutes) continue;

        const start = berlinWallClockToInstant(day.year, day.month, day.day, von.hour, von.minute);
        // Across midnight: the same wall-clock time on the next calendar day.
        const endDay = bisMinutes < vonMinutes ? 1 : 0;
        const next = new Date(Date.UTC(day.year, day.month - 1, day.day) + endDay * DAY_MS);
        const end = berlinWallClockToInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), bis.hour, bis.minute);

        if (start.adjusted) dstAdjusted += 1;
        if (end.adjusted) dstAdjusted += 1;

        const dateKey = `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
        shifts.push({
          id: `${record.id}:${dateKey}:${pair}`,
          driver_id: record.driver_id,
          start_ms: start.ms,
          end_ms: end.ms,
          source: SAVED_STUNDENNACHWEIS_SOURCE,
        });
      }
    }
  }

  return { shifts, unreadable, dstAdjusted };
}
