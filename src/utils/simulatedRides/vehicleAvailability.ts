import { wallTimeToInstant, type WallTime } from '../fahrtenbuchImportParser';

/**
 * The hand-entered windows in which a car may not be on the road
 * (`vehicle_unavailability`, 20261023130000): the workshop, an accident, a
 * breakdown, an inspection. Round 6 recorded "no maintenance window in the data
 * model"; that has been out of date since October, and Round 8 (§9) reads them.
 *
 * The table stores wall-clock moments in Europe/Berlin, `timestamp WITHOUT time
 * zone`, and an open end (`ends_local IS NULL`: still off the road, nobody has
 * said until when). Three rules here:
 *
 * - **An open end is unavailable to the end of time**, as the table's comment
 *   says its readers treat it.
 * - **A boundary the clocks skip or repeat is widened, never guessed.** A start
 *   moves to the instant an hour earlier, an end to the instant an hour later,
 *   so the window covers every instant the wall time could name. Widening can
 *   keep a car off the road an hour longer than entered; narrowing could put
 *   it on the road inside the workshop.
 * - **A row that does not parse blocks the car at every moment** and is
 *   named. The column is a `timestamp`, so this only happens when a reader
 *   changes; then the safe answer is no shift on that car, not a shift on it.
 */

export interface VehicleUnavailabilityRow {
  id: string;
  car_id: string;
  starts_local: string;
  ends_local: string | null;
  reason: string;
}

export interface UnavailabilityWindow {
  id: string;
  carId: string;
  startMs: number;
  /** `Infinity` for an open end. */
  endMs: number;
  reason: string;
  /** True when a boundary fell in a clock change and was moved outwards by an hour. */
  widened: boolean;
  /** True when the row did not parse and the window is every moment. */
  unreadable: boolean;
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

function parseWall(text: string): WallTime | null {
  const m = WALL.exec(text.trim());
  if (!m) return null;
  const wall = { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: m[6] ? +m[6] : 0 };
  const probe = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second));
  const sameWall = probe.getUTCFullYear() === wall.year && probe.getUTCMonth() === wall.month - 1 && probe.getUTCDate() === wall.day
    && probe.getUTCHours() === wall.hour && probe.getUTCMinutes() === wall.minute;
  return sameWall ? wall : null;
}

function shiftWall(wall: WallTime, hours: number): WallTime {
  const d = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour + hours, wall.minute, wall.second));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}

/** The instant of a boundary, widened outwards by an hour when the clocks skip or repeat it. */
function boundary(wall: WallTime, side: 'start' | 'end', zone: string): { ms: number; widened: boolean } | null {
  const exact = wallTimeToInstant(wall, zone);
  if (exact.kind === 'ok') return { ms: exact.ms, widened: false };
  const moved = wallTimeToInstant(shiftWall(wall, side === 'start' ? -1 : 1), zone);
  return moved.kind === 'ok' ? { ms: moved.ms, widened: true } : null;
}

/** The zone the table stores its wall times in (its column comment). */
export const UNAVAILABILITY_TIME_ZONE = 'Europe/Berlin';

/** Every row as an interval of instants. */
export function readUnavailability(
  rows: readonly VehicleUnavailabilityRow[],
  zone: string = UNAVAILABILITY_TIME_ZONE,
): UnavailabilityWindow[] {
  return rows.map(row => {
    const startWall = parseWall(row.starts_local);
    const endWall = row.ends_local == null ? null : parseWall(row.ends_local);
    const start = startWall ? boundary(startWall, 'start', zone) : null;
    const end = row.ends_local == null ? { ms: Infinity, widened: false } : endWall ? boundary(endWall, 'end', zone) : null;
    if (!start || !end || end.ms <= start.ms) {
      return { id: row.id, carId: row.car_id, startMs: -Infinity, endMs: Infinity, reason: row.reason, widened: false, unreadable: true };
    }
    return { id: row.id, carId: row.car_id, startMs: start.ms, endMs: end.ms, reason: row.reason, widened: start.widened || end.widened, unreadable: false };
  });
}

/** The first window of the car that overlaps `[startMs, endMs)`, or null. */
export function unavailableDuring(
  windows: readonly UnavailabilityWindow[],
  carId: string,
  startMs: number,
  endMs: number,
): UnavailabilityWindow | null {
  return windows.find(w => w.carId === carId && w.startMs < endMs && w.endMs > startMs) ?? null;
}
