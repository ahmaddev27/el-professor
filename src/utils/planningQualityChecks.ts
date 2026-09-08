/**
 * Shared helpers for planning quality and finalization checks.
 *
 * Single source of truth for:
 *  - Resolving actual ride start/end absolute timestamps from raw_data_json
 *  - Token lists that target only actual ride-time columns
 *  - Hard-exclusion of Auftrags/Übermittlung/Disposition columns
 *
 * The functions here are pure and have no side effects.
 * They are used by both MonatsplanungAssignmentPreview and FinalizePlanningModal.
 */

// ── Token configuration ──────────────────────────────────────────────────────

/** Column name fragments that must NEVER be used as ride start/end. */
const REJECT_COL_FRAGMENTS = [
  'auftrag',
  'auftragseingang',
  'auftragsuebermittlung',
  'auftragsübermittlung',
  'übermittlung',
  'uebermittlung',
  'disposition',
  'vermittlung',
  'eingang',
];

/**
 * Tokens targeting the actual ride-start column.
 * Ordered: exact/longest first so the best match wins early.
 */
export const ACTUAL_START_TOKENS: string[] = [
  'uhrzeit des fahrtbeginns',
  'uhrzeites fahrtbeginns',
  'uhrzeit fahrtbeginn',
  'fahrtbeginn',
  'beginn der fahrt',
  'startzeit der fahrt',
  'start time',
  'startzeit',
];

/**
 * Tokens targeting the actual ride-end column.
 * Ordered: exact/longest first so the best match wins early.
 */
export const ACTUAL_END_TOKENS: string[] = [
  'uhrzeit des fahrtendes',
  'uhrzeit fahrtende',
  'fahrtende',
  'ende der fahrt',
  'endzeit der fahrt',
  'end time',
  'endzeit',
];

// ── Helper: column finding ────────────────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isRejectedCol(key: string): boolean {
  const kn = norm(key);
  return REJECT_COL_FRAGMENTS.some(f => kn.includes(norm(f)));
}

/**
 * Find the best matching column name and its raw string value in a raw_data_json
 * object, given a list of target tokens. Rejected columns (Auftrags*, Übermittlung*,
 * etc.) are never returned even if they would otherwise match.
 *
 * Pass 1: exact normalized match (longest token wins).
 * Pass 2: substring match (non-exact tokens only).
 *
 * Returns [colName, rawValue] or ['', ''] if not found.
 */
export function findActualRideCol(
  raw: Record<string, unknown>,
  tokens: string[],
): [string, string] {
  const entries = Object.entries(raw);

  // Pass 1: exact match
  for (const token of tokens) {
    for (const [k, v] of entries) {
      if (isRejectedCol(k)) continue;
      if (norm(k) === norm(token)) {
        return [k, v != null ? String(v) : ''];
      }
    }
  }

  // Pass 2: substring match (skip rejected columns)
  for (const token of tokens) {
    for (const [k, v] of entries) {
      if (isRejectedCol(k)) continue;
      if (norm(k).includes(norm(token))) {
        return [k, v != null ? String(v) : ''];
      }
    }
  }

  return ['', ''];
}

// ── Helper: full-datetime parsing ────────────────────────────────────────────

/**
 * Parse a full datetime string ("2026-05-15 23:47:51.000", "2026-05-15T23:47:51", etc.)
 * into a UTC ms timestamp.  Returns null if the string is a bare HH:MM time.
 */
export function parseFullDatetimeMs(raw: string): number | null {
  if (!raw || raw.length < 10) return null;
  const cleaned = raw.replace(' ', 'T').replace(/(\.\d+)?(Z)?$/, '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(cleaned)) return null;
  const ms = new Date(cleaned).getTime();
  return isNaN(ms) ? null : ms;
}

/**
 * Build a ms timestamp from a YYYY-MM-DD date string and an HH:MM time string.
 * Returns 0 if inputs are missing or unparseable.
 */
function parseTsFromDateAndTime(date: string, time: string): number {
  if (!date || !time) return 0;
  const ms = new Date(`${date}T${time.slice(0, 5)}:00`).getTime();
  return isNaN(ms) ? 0 : ms;
}

// ── Main resolver ────────────────────────────────────────────────────────────

export interface ActualRideWindow {
  /** Absolute ms timestamp of actual ride start. */
  actualStartMs: number;
  /** Absolute ms timestamp of actual ride end. */
  actualEndMs: number;
  /** Raw source value found in raw_data_json for start (may be full datetime or HH:MM). */
  sourceStartValue: string;
  /** Raw source value found in raw_data_json for end (may be full datetime or HH:MM). */
  sourceEndValue: string;
  /** Column name in raw_data_json that provided the start value. */
  sourceStartColumn: string;
  /** Column name in raw_data_json that provided the end value. */
  sourceEndColumn: string;
  /**
   * true  = full datetimes were available and used directly.
   * false = fell back to trip_date + HH:MM with overnight correction.
   */
  usedFallback: boolean;
  /** Human-readable start (ISO local, e.g. "2026-05-03T00:04"). */
  displayStart: string;
  /** Human-readable end (ISO local, e.g. "2026-05-03T00:09"). */
  displayEnd: string;
  /** YYYY-MM-DD of the actual start (from full datetime, not service/audit date). */
  actualStartDate: string;
  /** YYYY-MM-DD of the actual end. */
  actualEndDate: string;
}

function msToIso(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function msToDateStr(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Resolve the actual ride time window for a trip.
 *
 * Resolution priority:
 *  1. Full datetimes from raw_data_json (e.g. "2026-05-03 00:04:31.000").
 *     These give the real calendar date + time and are used as-is.
 *  2. Fallback: trip_date + start_time / end_time (HH:MM).
 *     Overnight correction (+24h) is applied if end ≤ start.
 *
 * raw_data_json columns are found by findActualRideCol() which explicitly
 * rejects Auftrags-, Übermittlung- and Disposition-prefixed columns.
 */
export function resolveActualRideWindow(trip: {
  trip_date: string;
  start_time: string | null;
  end_time: string | null;
  raw_data_json: Record<string, unknown> | null | undefined;
}): ActualRideWindow {
  const raw = trip.raw_data_json ?? {};

  const [startCol, srcStart] = findActualRideCol(raw, ACTUAL_START_TOKENS);
  const [endCol,   srcEnd]   = findActualRideCol(raw, ACTUAL_END_TOKENS);

  const fullStart = parseFullDatetimeMs(srcStart);
  const fullEnd   = parseFullDatetimeMs(srcEnd);

  if (fullStart !== null && fullEnd !== null) {
    return {
      actualStartMs:    fullStart,
      actualEndMs:      fullEnd,
      sourceStartValue: srcStart,
      sourceEndValue:   srcEnd,
      sourceStartColumn: startCol || 'Uhrzeit des Fahrtbeginns',
      sourceEndColumn:   endCol   || 'Uhrzeit des Fahrtendes',
      usedFallback:     false,
      displayStart:     msToIso(fullStart),
      displayEnd:       msToIso(fullEnd),
      actualStartDate:  msToDateStr(fullStart),
      actualEndDate:    msToDateStr(fullEnd),
    };
  }

  // Fallback: trip_date + HH:MM
  const sMs = parseTsFromDateAndTime(trip.trip_date, trip.start_time ?? '');
  let eMs   = parseTsFromDateAndTime(trip.trip_date, trip.end_time   ?? '');
  if (sMs > 0 && eMs > 0 && eMs <= sMs) eMs += 86400000; // overnight

  return {
    actualStartMs:    sMs,
    actualEndMs:      eMs,
    sourceStartValue: srcStart || trip.start_time || '',
    sourceEndValue:   srcEnd   || trip.end_time   || '',
    sourceStartColumn: startCol || 'start_time (normalisiert)',
    sourceEndColumn:   endCol   || 'end_time (normalisiert)',
    usedFallback:     true,
    displayStart:     sMs > 0 ? msToIso(sMs) : trip.start_time ?? '',
    displayEnd:       eMs > 0 ? msToIso(eMs) : trip.end_time   ?? '',
    actualStartDate:  sMs > 0 ? msToDateStr(sMs) : trip.trip_date,
    actualEndDate:    eMs > 0 ? msToDateStr(eMs) : trip.trip_date,
  };
}

// ── Display helpers ──────────────────────────────────────────────────────────

/** Format a ms timestamp as "DD.MM.YYYY HH:MM". */
export function fmtAbsDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Format a ms timestamp as "HH:MM". */
export function fmtAbsTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Format a ms timestamp as "DD.MM.YYYY". */
export function fmtAbsDate(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

/**
 * Build a human-readable time range label that shows the real calendar date
 * when a trip crosses midnight (start date ≠ end date).
 *
 * Examples:
 *   same day:   "02.05.2026 23:50–02.05.2026 00:09"  → just times if dates equal: "23:50–00:09"
 *   cross-day:  "02.05.2026 23:50 → 03.05.2026 00:09"
 */
export function fmtRideRange(
  startMs: number,
  endMs: number,
  showDateAlways = false,
): string {
  const startDate = fmtAbsDate(startMs);
  const endDate   = fmtAbsDate(endMs);
  const startTime = fmtAbsTime(startMs);
  const endTime   = fmtAbsTime(endMs);
  if (!showDateAlways && startDate === endDate) {
    return `${startTime}–${endTime}`;
  }
  return `${startDate} ${startTime}→${endDate} ${endTime}`;
}
