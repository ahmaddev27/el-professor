/**
 * From a `fahrtenbuch_trips` row to the engine's AnalysisTrip.
 *
 * Rows written by slice A carry `start_at` / `end_at` (timestamptz): those are
 * absolute and taken as they are. Older rows are read the way the planning
 * checks read them, through resolveActualRideWindow: the full date-times of
 * the source's own start and end columns ("Uhrzeit des Fahrtbeginns/-endes")
 * out of raw_data_json, which also corrects the rows whose trip_date came from
 * "Datum der Fahrt" and landed a day early.
 *
 * Three places where the adapter goes further than that resolver, each because
 * its answer would be wrong for the analysis:
 *  - a row with a full start and no end (or the reverse) keeps the side it has;
 *    the resolver needs both and otherwise falls back to trip_date + HH:MM,
 *    the column-D date this module exists to avoid.
 *  - the trip_date + HH:MM fallback adds a calendar day for an overnight trip,
 *    not 86 400 000 ms: on the two DST Sundays a day is 23 or 25 hours long,
 *    and the fixed amount puts the end an hour off.
 *  - equal start and end HH:MM is a trip under a minute, not a 24-hour trip.
 *
 * Local date-times are read in the runtime's zone, as the resolver reads them;
 * the product runs in Europe/Berlin. A local time the DST switch makes
 * ambiguous or nonexistent is marked on the trip for review, never resolved.
 *
 * Price and currency are copied through untouched.
 */
import { parseFullDatetimeMs, resolveActualRideWindow } from '../planningQualityChecks';
import type { AnalysisTrip, LocalTimeAmbiguity, TripRowForAnalysis, TripStatus, TripTimeSource } from './types';

/** Source status words the Uber export writes for a completed trip ("abgeschlossen" in the 08/2026 sample). */
const COMPLETED_SOURCE_STATUSES = new Set(['abgeschlossen', 'completed']);

const HOUR_MS = 3_600_000;

interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

interface ResolvedTimes {
  readonly start_ms: number | null;
  readonly end_ms: number | null;
  readonly time_source: TripTimeSource;
  readonly time_ambiguity: LocalTimeAmbiguity | null;
}

/** Trimmed text, or null for empty and the source's `\N`. */
function textOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === '\\N' ? null : trimmed;
}

function parseWallTime(text: string): WallTime | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(text.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  return { year: Number(year), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute) };
}

function sameWallTime(ms: number, wall: WallTime): boolean {
  const d = new Date(ms);
  return (
    d.getFullYear() === wall.year &&
    d.getMonth() + 1 === wall.month &&
    d.getDate() === wall.day &&
    d.getHours() === wall.hour &&
    d.getMinutes() === wall.minute
  );
}

/**
 * Whether a wall-clock reading, parsed to `ms` in the runtime's zone, names
 * one instant. It does not when the clock skipped it (the parser moved it) or
 * when the same reading occurs an hour earlier or later as well.
 */
export function localTimeAmbiguity(ms: number, wall: WallTime): LocalTimeAmbiguity | null {
  if (!sameWallTime(ms, wall)) return 'dst_nonexistent';
  if (sameWallTime(ms + HOUR_MS, wall) || sameWallTime(ms - HOUR_MS, wall)) return 'dst_ambiguous';
  return null;
}

function ambiguityOf(ms: number | null, text: string): LocalTimeAmbiguity | null {
  if (ms === null) return null;
  const wall = parseWallTime(text);
  return wall ? localTimeAmbiguity(ms, wall) : null;
}

function firstAmbiguity(...values: Array<LocalTimeAmbiguity | null>): LocalTimeAmbiguity | null {
  return values.find(v => v !== null) ?? null;
}

function parseAbsolute(value: string | null | undefined): number | null {
  const text = textOrNull(value);
  if (text === null) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/** HH:MM of a time column, or null. */
function parseClock(value: string | null): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})/.exec((value ?? '').trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function parseDate(value: string | null): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec((value ?? '').trim());
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** trip_date + HH:MM, with a calendar day added when the end reads earlier than the start. */
function fallbackTimes(row: TripRowForAnalysis): ResolvedTimes {
  const date = parseDate(row.trip_date);
  const start = parseClock(row.start_time);
  const end = parseClock(row.end_time);
  if (!date) return { start_ms: null, end_ms: null, time_source: 'trip_date_hhmm', time_ambiguity: null };

  const startWall = start ? { ...date, ...start } : null;
  const startMs = startWall
    ? new Date(date.year, date.month - 1, date.day, startWall.hour, startWall.minute).getTime()
    : null;

  let endMs: number | null = null;
  let endWall: WallTime | null = null;
  if (end) {
    const overnight = start !== null && end.hour * 60 + end.minute < start.hour * 60 + start.minute;
    const endDate = new Date(date.year, date.month - 1, date.day + (overnight ? 1 : 0));
    endWall = {
      year: endDate.getFullYear(),
      month: endDate.getMonth() + 1,
      day: endDate.getDate(),
      hour: end.hour,
      minute: end.minute,
    };
    endMs = new Date(endWall.year, endWall.month - 1, endWall.day, end.hour, end.minute).getTime();
  }

  return {
    start_ms: startMs,
    end_ms: endMs,
    time_source: 'trip_date_hhmm',
    time_ambiguity: firstAmbiguity(
      startMs !== null && startWall ? localTimeAmbiguity(startMs, startWall) : null,
      endMs !== null && endWall ? localTimeAmbiguity(endMs, endWall) : null,
    ),
  };
}

function legacyTimes(row: TripRowForAnalysis): ResolvedTimes {
  const window = resolveActualRideWindow({
    trip_date: row.trip_date ?? '',
    start_time: row.start_time,
    end_time: row.end_time,
    raw_data_json: row.raw_data_json,
  });

  // The resolver's source values are the raw cells when it found the columns.
  const fullStart = window.usedFallback ? parseFullDatetimeMs(window.sourceStartValue) : window.actualStartMs;
  const fullEnd = window.usedFallback ? parseFullDatetimeMs(window.sourceEndValue) : window.actualEndMs;

  if (fullStart === null && fullEnd === null) return fallbackTimes(row);

  return {
    start_ms: fullStart,
    end_ms: fullEnd,
    time_source: 'raw_local_datetime',
    time_ambiguity: firstAmbiguity(
      ambiguityOf(fullStart, window.sourceStartValue),
      ambiguityOf(fullEnd, window.sourceEndValue),
    ),
  };
}

function resolveTimes(row: TripRowForAnalysis): ResolvedTimes {
  // A row selected with slice A's columns is judged by them alone, missing or not.
  if (row.start_at !== undefined || row.end_at !== undefined) {
    return {
      start_ms: parseAbsolute(row.start_at),
      end_ms: parseAbsolute(row.end_at),
      time_source: 'absolute',
      time_ambiguity: null,
    };
  }
  return legacyTimes(row);
}

function resolveStatus(row: TripRowForAnalysis): TripStatus {
  if (row.trip_status === 'completed' || row.trip_status === 'cancelled' || row.trip_status === 'unknown') {
    return row.trip_status;
  }
  if (row.is_canceled) return 'cancelled';
  const source = textOrNull(row.source_status)?.toLowerCase() ?? '';
  return COMPLETED_SOURCE_STATUSES.has(source) ? 'completed' : 'unknown';
}

export function analysisTripFromRow(row: TripRowForAnalysis): AnalysisTrip {
  const times = resolveTimes(row);
  return {
    id: row.id,
    driver_id: textOrNull(row.original_driver_id),
    driver_name: textOrNull(row.original_driver_name),
    vehicle: textOrNull(row.car_identifier),
    start_ms: times.start_ms,
    end_ms: times.end_ms,
    status: resolveStatus(row),
    price: row.price_amount,
    currency: row.currency ?? null,
    source_row: row.source_row_index,
    pickup_address: textOrNull(row.route_start),
    dropoff_address: textOrNull(row.route_end),
    time_source: times.time_source,
    time_ambiguity: times.time_ambiguity,
  };
}
