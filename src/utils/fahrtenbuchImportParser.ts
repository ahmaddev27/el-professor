/**
 * The pure half of the Fahrtenbuch importer: reading one uploaded row into one
 * `fahrtenbuch_trips` row, with no I/O. FahrtenbuchImportModal draws the wizard
 * around it; useFahrtenbuch writes what it returns.
 *
 * ## What a row records (migration 20260922100000)
 *
 * The columns planning has always read keep the meaning they had: `trip_date`
 * is the file's "Datum der Fahrt", `start_time` / `end_time` are HH:MM, and
 * `duration_minutes` is computed from those. Everything below is added beside
 * them, and the database refuses to change any of it after the insert.
 *
 * - **start_at / end_at**: the instants the ride began and ended, read from the
 *   source's own start and end timestamps as wall-clock time in Europe/Berlin
 *   (the files carry no zone). `time_source` says how they were obtained, and a
 *   value that cannot be read is left NULL rather than guessed:
 *     source_start_end    both columns hold a date and a time
 *     fallback_trip_date  neither column holds a date, so trip_date + HH:MM,
 *                         the end moved to the next day when it is earlier
 *     missing             a column is empty (a cancelled ride has neither)
 *     unparsed            something is there that is not a zone-less timestamp
 *     ambiguous           the wall time falls in a DST change: twice (October)
 *                         or never (March), so no single instant exists
 *   The Uber export dates a ride that starts between 00:00 and 00:30 on the
 *   day before ("Datum der Fahrt" is the order's day). `trip_date` keeps that
 *   value; `start_at` carries the day the ride actually began.
 * - **trip_status**: `abgeschlossen` → completed; the words the importer
 *   before this release read as cancelled → cancelled; anything else →
 *   unknown. `source_status` keeps the text as it was.
 *   `is_canceled` is exactly `trip_status = 'cancelled'`, so an unknown status
 *   is never read as a completed ride and never as a cancelled one.
 * - **needs_review / review_reasons**: a row the file left incomplete is kept
 *   and flagged, never dropped. No date is invented: a row with neither a
 *   "Datum der Fahrt" nor a dated start cannot be stored (trip_date is NOT
 *   NULL) and is held back and counted instead.
 * - **currency**: 'EUR' with `currency_source = 'assumed'`, because the file
 *   carries none. `price_amount` is read exactly as before.
 * - **source_row_key**: a SHA-256 that names the ride across files, so the
 *   same ride is refused when a second file carries it. It is derived, and
 *   `source_row_key_basis` says from what (see `sourceRowKeyMaterial`).
 *
 * The backfill in the migration applies the same time rules to the rows that
 * existed before; `fahrtenbuchImportParser.test.ts` pins both to the same
 * cases, and `tests/rls/fahrtenbuch-import.sql` repeats them in SQL.
 */
import * as XLSX from 'xlsx';
import type { TripInsertRow } from '../hooks/useFahrtenbuch';

// ── Types ─────────────────────────────────────────────────────────────────────

/** A cell as XLSX reads it with `raw: true`. */
export type CellValue = string | number | boolean | null | undefined;
export type RawRow = Record<string, CellValue>;

/** Which uploaded column feeds which system field; '' is unmapped. */
export interface ColMap {
  trip_date: string;
  start_time: string;
  end_time: string;
  driver_name: string;
  car_identifier: string;
  price_amount: string;
  tip_amount: string;
  payment_method: string;
  route_start: string;
  route_end: string;
  description: string;
}

export type TripStatus = 'completed' | 'cancelled' | 'unknown';
export const TRIP_STATUSES: readonly TripStatus[] = ['completed', 'cancelled', 'unknown'];

export type TimeSource =
  | 'source_start_end'
  | 'fallback_trip_date'
  | 'missing'
  | 'unparsed'
  | 'ambiguous';
export const TIME_SOURCES: readonly TimeSource[] = [
  'source_start_end', 'fallback_trip_date', 'missing', 'unparsed', 'ambiguous',
];

export type ReviewReason =
  | 'missing_trip_date'
  | 'missing_start'
  | 'unreadable_start'
  | 'missing_end'
  | 'unreadable_end'
  | 'end_before_start'
  | 'missing_driver'
  | 'unknown_status';

/** Canonical order: review_reasons is always written in this order. */
export const REVIEW_REASONS: readonly ReviewReason[] = [
  'missing_trip_date',
  'missing_start',
  'unreadable_start',
  'missing_end',
  'unreadable_end',
  'end_before_start',
  'missing_driver',
  'unknown_status',
];

export type SourceRowKeyBasis = 'derived_order_transmission' | 'derived_driver_start_plate';

/** The zone every wall-clock time in the source files is read in. */
export const SOURCE_TIME_ZONE = 'Europe/Berlin';

/** The files carry no currency; this is recorded with currency_source 'assumed'. */
export const ASSUMED_CURRENCY = 'EUR';

// ── Small helpers ─────────────────────────────────────────────────────────────

/** Lowercase and keep [a-z0-9] only — the importer's header and status rule. */
export function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Only these four characters, so the SQL twin (btrim with the same set) agrees.
const EDGE_WHITESPACE = /^[ \t\r\n]+|[ \t\r\n]+$/g;

function trimCell(s: string): string {
  return s.replace(EDGE_WHITESPACE, '');
}

/** The exporter writes an empty cell as the literal text `\N`. */
const NULL_MARKER = '\\N';

/** True for a cell that holds nothing: absent, empty, or `\N`. */
export function isMissingCell(value: CellValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const s = trimCell(value);
  return s === '' || s === NULL_MARKER;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

// ── Date, time and money parsing (moved unchanged from the modal) ─────────────

/**
 * Accepts: Excel serial number, DD.MM.YYYY, YYYY-MM-DD (optionally with a time
 * suffix), DD/MM/YYYY or MM/DD/YYYY, or a serial as text. Returns YYYY-MM-DD.
 *
 * A day the calendar does not have (31.02.2026, 45.13.2026) is not a date. It
 * used to be passed through and made the database refuse the whole import.
 */
export function parseDate(raw: CellValue): string | null {
  const iso = parseDateUnchecked(raw);
  if (iso === null) return null;
  const m = iso.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1900 || year > 2999 || month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return iso;
}

function parseDateUnchecked(raw: CellValue): string | null {
  if (raw === null || raw === undefined || raw === '' || raw === '\\N') return null;

  if (typeof raw === 'number') {
    if (Number.isInteger(raw) && raw > 1000) {
      try {
        const d = XLSX.SSF.parse_date_code(raw);
        if (d && d.y > 1980 && d.y < 2100) {
          return `${d.y}-${pad2(d.m)}-${pad2(d.d)}`;
        }
      } catch { /* fall through */ }
    }
    if (raw > 1000) {
      try {
        const d = XLSX.SSF.parse_date_code(Math.floor(raw));
        if (d && d.y > 1980 && d.y < 2100) {
          return `${d.y}-${pad2(d.m)}-${pad2(d.d)}`;
        }
      } catch { /* fall through */ }
    }
    return null;
  }

  const s = String(raw).trim();
  if (!s || s === '\\N') return null;

  const m1 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m1) {
    let y = Number(m1[3]);
    if (y < 100) y += y < 50 ? 2000 : 1900;
    return `${y}-${m1[2].padStart(2, '0')}-${m1[1].padStart(2, '0')}`;
  }

  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;

  const m3 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m3) {
    const a = Number(m3[1]);
    if (a > 12) return `${m3[3]}-${m3[2].padStart(2, '0')}-${m3[1].padStart(2, '0')}`;
    return `${m3[3]}-${m3[1].padStart(2, '0')}-${m3[2].padStart(2, '0')}`;
  }

  if (/^\d{5}$/.test(s)) {
    try {
      const d = XLSX.SSF.parse_date_code(Number(s));
      if (d && d.y > 1980) return `${d.y}-${pad2(d.m)}-${pad2(d.d)}`;
    } catch { /* fall through */ }
  }

  return null;
}

/**
 * HH:MM out of an Excel time fraction, "HH:MM[:SS]", a datetime string,
 * "HH.MM", "HHhMM" or a numeric string. Seconds are dropped: start_time and
 * end_time have always been minutes, and start_at / end_at keep the seconds.
 *
 * A value outside the clock (25:10, 10:75) is not a time. It used to be passed
 * through and made the database refuse the whole import.
 */
export function parseTime(raw: CellValue): string | null {
  const hhmm = parseTimeUnchecked(raw);
  if (hhmm === null) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (m > 59 || h > 24 || (h === 24 && m !== 0)) return null;
  return hhmm;
}

function parseTimeUnchecked(raw: CellValue): string | null {
  if (raw === null || raw === undefined || raw === '' || raw === '\\N') return null;

  if (typeof raw === 'number') {
    let frac = raw;
    if (frac >= 1) frac = frac - Math.floor(frac);
    if (frac < 0) return null;
    const totalMinutes = Math.round(frac * 24 * 60);
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${pad2(h)}:${pad2(m)}`;
  }

  const s = String(raw).trim();
  if (!s || s === '\\N') return null;

  const dtm = s.match(/(?:[T\s])(\d{1,2}):(\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (dtm) return `${dtm[1].padStart(2, '0')}:${dtm[2]}`;

  const m1 = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?(?:\.\d+)?$/);
  if (m1) return `${m1[1].padStart(2, '0')}:${m1[2]}`;

  const m2 = s.match(/^(\d{1,2})\.(\d{2})$/);
  if (m2) return `${m2[1].padStart(2, '0')}:${m2[2]}`;

  const m3 = s.match(/^(\d{1,2})h(\d{2})$/i);
  if (m3) return `${m3[1].padStart(2, '0')}:${m3[2]}`;

  if (/^\d+\.\d+$/.test(s)) {
    const n = parseFloat(s);
    const frac = n >= 1 ? n - Math.floor(n) : n;
    const totalMinutes = Math.round(frac * 24 * 60);
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${pad2(h)}:${pad2(m)}`;
  }

  return null;
}

/** A euro amount, German decimal comma accepted. Unchanged from the modal. */
export function parseMoney(raw: CellValue): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') return Math.round(raw * 100) / 100;
  const s = String(raw).trim();
  if (!s || s === '\\N') return 0;
  const cleaned = s.replace(/[^\d,.-]/g, '').replace(/,(\d{2})$/, '.$1');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

/** Minutes from HH:MM to HH:MM, across midnight when the end is earlier. */
export function durationMinutes(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff < 0) diff += 24 * 60;
  return diff;
}

/** Rejects GPS coordinates, `\N`, empty values and numbers: a plate has a letter. */
export function isValidKennzeichen(raw: CellValue): boolean {
  if (raw === null || raw === undefined) return false;
  const v = String(raw).trim();
  if (!v || v === '\\N' || v.toLowerCase() === 'null' || v.toLowerCase() === 'undefined') return false;
  if (/^-?\d{1,3}\.\d+\s+-?\d{1,3}\.\d+$/.test(v)) return false;
  if (/^-?\d{2,3}\.\d{5,}$/.test(v)) return false;
  if (/^\d{7,}$/.test(v)) return false;
  if (!/[a-zA-ZÄÖÜäöü]/.test(v)) return false;
  return true;
}

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * The words a status cell may hold, compared after `normalise` (case and
 * everything but letters and digits dropped). The cancelled list keeps the
 * words the importer before 20260922100000 read as cancelled, so no file that
 * imported as cancelled then reads differently now (owner's decision,
 * 22.09.2026). Anything else — a typo, an empty cell, a file without a status
 * column — is 'unknown': stored, flagged for review, never counted as
 * completed and never as cancelled. Widening a list is a decision about what
 * a word in a customer's file means, so it is made here and in the migration's
 * app_private.fahrtenbuch_map_status, and the test fails when the two part.
 */
export const COMPLETED_STATUS_WORDS: readonly string[] = ['abgeschlossen'];
// All nine of the old importer's CANCELED_STATUSES but one: 'nichtdurchgeführt'
// is dropped because it could never match — normalise drops the ü from every
// input, so no cell could ever equal it. 'nichtdurchgefuhrt' is the spelling
// that did match and is kept.
export const CANCELLED_STATUS_WORDS: readonly string[] = [
  'storno', 'storniert', 'storniertfahrt', 'stornierung',
  'cancelled', 'canceled', 'abgebrochen', 'nichtdurchgefuhrt',
];

const STATUS_MAP: ReadonlyMap<string, TripStatus> = new Map<string, TripStatus>([
  ...COMPLETED_STATUS_WORDS.map(w => [normalise(w), 'completed'] as const),
  ...CANCELLED_STATUS_WORDS.map(w => [normalise(w), 'cancelled'] as const),
]);

export function mapTripStatus(raw: CellValue): TripStatus {
  if (isMissingCell(raw)) return 'unknown';
  return STATUS_MAP.get(normalise(String(raw))) ?? 'unknown';
}

// ── Timestamps ────────────────────────────────────────────────────────────────

/** A wall-clock time with no zone, as the file writes it. */
export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export type TimestampCell =
  | { kind: 'datetime'; wall: WallTime }
  | { kind: 'time' }
  | { kind: 'empty' }
  | { kind: 'other' };

// "2026-08-01 00:05:31.000" — the zone-less shape the exporter writes. A value
// with Z or an offset is not accepted: it is not what the files contain, and
// reading it would need a rule nobody has decided.
// Written with [0-9] to match the migration's twin character for character;
// the test compares the two.
export const DATETIME_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.[0-9]{1,9})?)?$/;
// "01.08.2026 10:05[:31]" — the German spelling other exports use. Day first,
// always: that is what the dots mean in this country.
export const GERMAN_DATETIME_RE = /^([0-9]{1,2})\.([0-9]{1,2})\.([0-9]{4}) ([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?$/;
export const TIME_RE = /^[0-9]{1,2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,9})?)?$/;

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const SECONDS_PER_DAY = 86400;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validWall(w: WallTime): WallTime | null {
  if (w.year < 1900 || w.year > 2999) return null;
  if (w.month < 1 || w.month > 12) return null;
  if (w.day < 1 || w.day > daysInMonth(w.year, w.month)) return null;
  if (w.hour > 23 || w.minute > 59 || w.second > 59) return null;
  return w;
}

/**
 * What a start or end cell holds: ISO or German date and time, with no zone.
 * The fractional seconds of a text value are dropped (the files write `.000`).
 * A number between 0 and 1 is an Excel time
 * of day; a number with a whole part and a fraction is an Excel date and time,
 * rounded to the second. A whole number is a date with no time, which is not
 * a timestamp.
 */
export function classifyTimestampCell(value: CellValue): TimestampCell {
  if (isMissingCell(value)) return { kind: 'empty' };

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return { kind: 'other' };
    if (value < 1) return { kind: 'time' };
    if (value < 61 || value >= 1_000_000 || Number.isInteger(value)) return { kind: 'other' };
    const d = new Date(EXCEL_EPOCH_MS + Math.round(value * SECONDS_PER_DAY) * 1000);
    const wall = validWall({
      year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
      hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
    });
    return wall ? { kind: 'datetime', wall } : { kind: 'other' };
  }

  if (typeof value !== 'string') return { kind: 'other' };

  const s = trimCell(value);
  const iso = s.match(DATETIME_RE);
  if (iso) {
    const wall = validWall({
      year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]),
      hour: Number(iso[4]), minute: Number(iso[5]), second: iso[6] === undefined ? 0 : Number(iso[6]),
    });
    return wall ? { kind: 'datetime', wall } : { kind: 'other' };
  }
  const german = s.match(GERMAN_DATETIME_RE);
  if (german) {
    const wall = validWall({
      year: Number(german[3]), month: Number(german[2]), day: Number(german[1]),
      hour: Number(german[4]), minute: Number(german[5]), second: german[6] === undefined ? 0 : Number(german[6]),
    });
    return wall ? { kind: 'datetime', wall } : { kind: 'other' };
  }
  if (TIME_RE.test(s)) return { kind: 'time' };
  return { kind: 'other' };
}

export function formatWall(w: WallTime): string {
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)} ${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)}`;
}

export function wallDate(w: WallTime): string {
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let f = zoneFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    zoneFormatters.set(zone, f);
  }
  return f;
}

/** The wall-clock reading of an instant in a zone. */
export function wallAt(instantMs: number, zone: string): WallTime {
  const parts: Record<string, number> = {};
  for (const p of zoneFormatter(zone).formatToParts(new Date(instantMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year, month: parts.month, day: parts.day,
    hour: parts.hour, minute: parts.minute, second: parts.second,
  };
}

function wallAsUtcMs(w: WallTime): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

function sameWall(a: WallTime, b: WallTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day
    && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

export type InstantResult =
  | { kind: 'ok'; ms: number }
  | { kind: 'ambiguous' }
  | { kind: 'nonexistent' };

/**
 * The instant a wall-clock time names in a zone. Every offset the zone uses
 * within a day either side is tried, and the ones whose instant reads back as
 * the same wall time are kept: one is the answer, two means the hour repeats
 * (October), none means it was skipped (March). The migration's
 * app_private.fahrtenbuch_wall_to_instant does the same in SQL.
 */
export function wallTimeToInstant(wall: WallTime, zone: string = SOURCE_TIME_ZONE): InstantResult {
  const asUtc = wallAsUtcMs(wall);
  const day = SECONDS_PER_DAY * 1000;
  const offsets = new Set<number>();
  for (const probe of [asUtc - day, asUtc, asUtc + day]) {
    offsets.add(wallAsUtcMs(wallAt(probe, zone)) - probe);
  }
  const hits = new Set<number>();
  for (const offset of offsets) {
    const candidate = asUtc - offset;
    if (sameWall(wallAt(candidate, zone), wall)) hits.add(candidate);
  }
  if (hits.size === 1) return { kind: 'ok', ms: hits.values().next().value as number };
  return hits.size === 0 ? { kind: 'nonexistent' } : { kind: 'ambiguous' };
}

function timeOfDayWall(date: string, hhmm: string, addDays: number): WallTime | null {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  // 24:00 is the midnight that ends the day.
  const base = new Date(Date.UTC(y, mo - 1, d + addDays, h, mi, 0));
  if (Number.isNaN(base.getTime())) return null;
  return validWall({
    year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate(),
    hour: base.getUTCHours(), minute: base.getUTCMinutes(), second: 0,
  });
}

export interface TripTimes {
  startAt: string | null;
  endAt: string | null;
  timeZone: string | null;
  timeSource: TimeSource;
  /** The start as the file names it, YYYY-MM-DD HH:MM:SS, even when ambiguous. */
  startWallText: string | null;
  /** The local calendar day the ride began, when the file says. */
  startLocalDate: string | null;
}

export interface TripTimeInput {
  startCell: CellValue;
  endCell: CellValue;
  /** YYYY-MM-DD, the row's trip_date. */
  tripDate: string | null;
  /** HH:MM, the row's start_time and end_time. */
  startTime: string | null;
  endTime: string | null;
}

function resolvePair(start: WallTime, end: WallTime, source: TimeSource): Omit<TripTimes, 'startWallText' | 'startLocalDate'> {
  const s = wallTimeToInstant(start);
  const e = wallTimeToInstant(end);
  if (s.kind !== 'ok' || e.kind !== 'ok') {
    return { startAt: null, endAt: null, timeZone: null, timeSource: 'ambiguous' };
  }
  return {
    startAt: new Date(s.ms).toISOString(),
    endAt: new Date(e.ms).toISOString(),
    timeZone: SOURCE_TIME_ZONE,
    timeSource: source,
  };
}

/**
 * start_at, end_at and where they came from. Both are set or neither is: an
 * interval with one end is not an interval.
 */
export function deriveTripTimes(input: TripTimeInput): TripTimes {
  const start = classifyTimestampCell(input.startCell);
  const end = classifyTimestampCell(input.endCell);

  let startWallText: string | null = null;
  let startLocalDate: string | null = null;
  if (start.kind === 'datetime') {
    startWallText = formatWall(start.wall);
    startLocalDate = wallDate(start.wall);
  } else if (input.tripDate && input.startTime && start.kind !== 'other') {
    startWallText = `${input.tripDate} ${input.startTime}:00`;
  }
  const described = { startWallText, startLocalDate };

  if (start.kind === 'datetime' && end.kind === 'datetime') {
    return { ...resolvePair(start.wall, end.wall, 'source_start_end'), ...described };
  }

  const dateless = (c: TimestampCell) => c.kind === 'time' || c.kind === 'empty';
  if (dateless(start) && dateless(end) && input.tripDate && input.startTime && input.endTime) {
    const overnight = input.endTime < input.startTime ? 1 : 0;
    const startWall = timeOfDayWall(input.tripDate, input.startTime, 0);
    const endWall = timeOfDayWall(input.tripDate, input.endTime, overnight);
    if (startWall && endWall) {
      return {
        ...resolvePair(startWall, endWall, 'fallback_trip_date'),
        ...described,
        startLocalDate: wallDate(startWall),
      };
    }
  }

  const timeSource: TimeSource = start.kind === 'empty' || end.kind === 'empty' ? 'missing' : 'unparsed';
  return { startAt: null, endAt: null, timeZone: null, timeSource, ...described };
}

// ── The derived row key ───────────────────────────────────────────────────────

/** Headers of the order-transmission column, normalised. Exact only: a
 *  substring would also match "Standort des Fahrzeugs bei Auftragsuebermittlung". */
const ORDER_TRANSMISSION_HEADERS = new Set([
  'uhrzeitderauftragsuebermittlung',
  'uhrzeitderauftragsbermittlung', // "…übermittlung": normalise drops the ü
]);

export function findOrderTransmissionColumn(headers: readonly string[]): string {
  return headers.find(h => ORDER_TRANSMISSION_HEADERS.has(normalise(h))) ?? '';
}

export function normaliseDriverName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function normalisePlate(plate: string): string {
  return plate.normalize('NFC').toUpperCase().replace(/[\s-]+/g, '');
}

export interface SourceRowKeyInput {
  orderTransmission: CellValue;
  driverName: string;
  startWallText: string | null;
  plate: string | null;
}

/**
 * What the row key is a hash of, or null when the row names no ride.
 *
 * With the order-transmission time (column B of the Uber export) the key is
 * that time + driver + plate: B alone is unique in every file seen so far, but
 * nothing guarantees it, and two rides sharing it would make the second one
 * refused as a duplicate. Without it the key is the start + driver + plate — a
 * car does not start two rides in the same second. A row with neither (a
 * cancelled ride with no order time) gets no key, and only the file hash
 * protects it.
 */
export function sourceRowKeyMaterial(
  input: SourceRowKeyInput,
): { basis: SourceRowKeyBasis; material: string } | null {
  const driver = normaliseDriverName(input.driverName);
  const plate = normalisePlate(input.plate ?? '');
  if (!isMissingCell(input.orderTransmission)) {
    const order = trimCell(String(input.orderTransmission));
    return {
      basis: 'derived_order_transmission',
      material: ['v1', 'order', order, driver, plate].join('\u001f'),
    };
  }
  if (input.startWallText) {
    return {
      basis: 'derived_driver_start_plate',
      material: ['v1', 'start', input.startWallText, driver, plate].join('\u001f'),
    };
  }
  return null;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of bytes, lowercase hex. The file hash that refuses a second upload. */
export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  // A copy on its own ArrayBuffer: digest() takes no view of a shared buffer.
  return toHex(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}

export async function sha256HexOfText(text: string): Promise<string> {
  return sha256HexOfBytes(new TextEncoder().encode(text));
}

// ── Building the rows ─────────────────────────────────────────────────────────

export interface DriverMatchInfo { matchedDriverId: string | null; matchedDriverName: string }
export interface CarMatchInfo { matchedCarId: string | null }

export interface BuildContext {
  rows: readonly RawRow[];
  colMap: ColMap;
  /** The status column, '' when the file has none. */
  statusCol: string;
  /** The order-transmission column, '' when the file has none. */
  orderTransmissionCol: string;
  driverMatches: ReadonlyMap<string, DriverMatchInfo>;
  carMatches: ReadonlyMap<string, CarMatchInfo>;
}

export interface BuiltRow {
  row: TripInsertRow;
  /** What source_row_key hashes; null when the row has no key. */
  keyMaterial: string | null;
}

export interface BuildStats {
  total: number;
  /** Rows with no "Datum der Fahrt" and no dated start: trip_date is NOT NULL. */
  heldBackNoDate: number;
  /** Rows whose start falls on another day than their "Datum der Fahrt". */
  startDateDiffers: number;
  sampleUnreadableStart: CellValue[];
  /** The first few held-back rows, as 1-based positions among the data rows. */
  heldBackRows: number[];
}

function reviewReasonsInOrder(reasons: ReadonlySet<ReviewReason>): ReviewReason[] {
  return REVIEW_REASONS.filter(r => reasons.has(r));
}

/**
 * One trip row per uploaded row, except rows no date can be given to. Nothing
 * is dropped for being incomplete: the row is kept and flagged.
 */
export function buildTripRows(ctx: BuildContext): { built: BuiltRow[]; stats: BuildStats } {
  const { colMap } = ctx;
  const cell = (row: RawRow, col: string): CellValue => (col ? row[col] : null);
  const stats: BuildStats = {
    total: ctx.rows.length, heldBackNoDate: 0, startDateDiffers: 0,
    sampleUnreadableStart: [], heldBackRows: [],
  };
  const built: BuiltRow[] = [];

  ctx.rows.forEach((row, rowIdx) => {
    const rawDate = cell(row, colMap.trip_date);
    const rawStart = cell(row, colMap.start_time);
    const rawEnd = cell(row, colMap.end_time);
    const driverCell = cell(row, colMap.driver_name);
    const statusCell = cell(row, ctx.statusCol);

    const driverName = isMissingCell(driverCell) ? '' : String(driverCell).trim();
    const sourceStatus = isMissingCell(statusCell) ? null : String(statusCell).trim();
    const status = mapTripStatus(statusCell);
    const cancelled = status === 'cancelled';
    const reasons = new Set<ReviewReason>();

    let tripDate = parseDate(rawDate);
    if (!tripDate) {
      const start = classifyTimestampCell(rawStart);
      if (start.kind !== 'datetime') {
        stats.heldBackNoDate++;
        if (stats.heldBackRows.length < 5) stats.heldBackRows.push(rowIdx + 1);
        return;
      }
      // The ride's own start names its day; nothing is made up.
      tripDate = wallDate(start.wall);
      reasons.add('missing_trip_date');
    }

    // A cancelled ride keeps no clock times, as it always has.
    const startTime = cancelled ? null : parseTime(rawStart);
    const endTime = cancelled ? null : parseTime(rawEnd);
    if (!cancelled && !startTime) {
      reasons.add(isMissingCell(rawStart) ? 'missing_start' : 'unreadable_start');
      if (!isMissingCell(rawStart) && stats.sampleUnreadableStart.length < 5) {
        stats.sampleUnreadableStart.push(rawStart);
      }
    }
    if (!cancelled && !endTime) {
      reasons.add(isMissingCell(rawEnd) ? 'missing_end' : 'unreadable_end');
    }
    if (!driverName) reasons.add('missing_driver');
    if (status === 'unknown') reasons.add('unknown_status');

    const times = deriveTripTimes({ startCell: rawStart, endCell: rawEnd, tripDate, startTime, endTime });
    if (times.timeSource === 'source_start_end' && times.startAt && times.endAt && times.endAt < times.startAt) {
      reasons.add('end_before_start');
    }
    if (times.startLocalDate && times.startLocalDate !== tripDate) stats.startDateDiffers++;

    const rawPlate = cell(row, colMap.car_identifier);
    const plate = isValidKennzeichen(rawPlate) ? String(rawPlate).trim() : null;
    const price = parseMoney(cell(row, colMap.price_amount));
    const tip = parseMoney(cell(row, colMap.tip_amount));
    const payment = colMap.payment_method ? String(row[colMap.payment_method] ?? '').toLowerCase() : '';
    const isBar = payment.includes('bar') || payment.includes('cash') || payment === 'b';
    const text = (col: string) => (col ? String(row[col] ?? '') : '') || null;

    const driverMatch = ctx.driverMatches.get(driverName);
    const carMatch = plate ? ctx.carMatches.get(plate) : undefined;
    const reviewReasons = reviewReasonsInOrder(reasons);
    const key = sourceRowKeyMaterial({
      orderTransmission: cell(row, ctx.orderTransmissionCol),
      driverName, startWallText: times.startWallText, plate,
    });

    built.push({
      keyMaterial: key?.material ?? null,
      row: {
        company_id: '',
        import_id: '',
        trip_date: tripDate,
        start_time: startTime,
        end_time: endTime,
        duration_minutes: startTime && endTime ? durationMinutes(startTime, endTime) : null,
        original_driver_id: driverMatch?.matchedDriverId ?? null,
        original_driver_name: driverName,
        assigned_driver_id: driverMatch?.matchedDriverId ?? null,
        assigned_driver_name: driverMatch?.matchedDriverName ?? driverName,
        car_id: carMatch?.matchedCarId ?? null,
        car_identifier: plate,
        route_start: text(colMap.route_start),
        route_end: text(colMap.route_end),
        description: text(colMap.description),
        price_amount: price,
        cash_amount: cancelled ? 0 : (isBar ? price : 0),
        online_amount: cancelled ? 0 : (isBar ? 0 : price),
        tip_amount: tip,
        action_amount: 0,
        raw_data_json: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v ?? null])),
        plausibility_status: cancelled ? 'canceled' : 'pending',
        is_canceled: cancelled,
        source_status: sourceStatus,
        source_row_index: rowIdx + 1,
        start_at: times.startAt,
        end_at: times.endAt,
        time_zone: times.timeZone,
        time_source: times.timeSource,
        trip_status: status,
        needs_review: reviewReasons.length > 0,
        review_reasons: reviewReasons,
        currency: ASSUMED_CURRENCY,
        currency_source: 'assumed',
        source_row_key: null,
        source_row_key_basis: key?.basis ?? null,
      },
    });
  });

  return { built, stats };
}

/**
 * Hashes every row key and drops a row whose key an earlier row of the same
 * file already has — the second copy of a ride is not a second ride.
 */
export async function applySourceRowKeys(
  built: readonly BuiltRow[],
): Promise<{ rows: TripInsertRow[]; inFileDuplicates: number }> {
  const hashes = await Promise.all(
    built.map(b => (b.keyMaterial === null ? Promise.resolve(null) : sha256HexOfText(b.keyMaterial))),
  );
  const seen = new Set<string>();
  const rows: TripInsertRow[] = [];
  let inFileDuplicates = 0;
  built.forEach((b, i) => {
    const key = hashes[i];
    if (key !== null) {
      if (seen.has(key)) { inFileDuplicates++; return; }
      seen.add(key);
    }
    rows.push({ ...b.row, source_row_key: key, source_row_key_basis: key === null ? null : b.row.source_row_key_basis });
  });
  return { rows, inFileDuplicates };
}

/** Drops the rows whose key is already stored for the company. */
export function withoutStoredKeys(
  rows: readonly TripInsertRow[],
  storedKeys: ReadonlySet<string>,
): { rows: TripInsertRow[]; refused: number } {
  const kept = rows.filter(r => r.source_row_key === null || !storedKeys.has(r.source_row_key));
  return { rows: kept, refused: rows.length - kept.length };
}

export interface ImportSummary {
  completed: number;
  cancelled: number;
  unknown: number;
  needsReview: number;
  reasons: Record<ReviewReason, number>;
  timeSources: Record<TimeSource, number>;
}

/** The preview's counts, over the rows that will be written. */
export function summariseRows(rows: readonly TripInsertRow[]): ImportSummary {
  const reasons = Object.fromEntries(REVIEW_REASONS.map(r => [r, 0])) as Record<ReviewReason, number>;
  const timeSources = Object.fromEntries(TIME_SOURCES.map(s => [s, 0])) as Record<TimeSource, number>;
  const summary: ImportSummary = { completed: 0, cancelled: 0, unknown: 0, needsReview: 0, reasons, timeSources };
  for (const r of rows) {
    if (r.trip_status === 'completed') summary.completed++;
    else if (r.trip_status === 'cancelled') summary.cancelled++;
    else summary.unknown++;
    if (r.needs_review) summary.needsReview++;
    for (const reason of r.review_reasons) reasons[reason]++;
    timeSources[r.time_source]++;
  }
  return summary;
}
