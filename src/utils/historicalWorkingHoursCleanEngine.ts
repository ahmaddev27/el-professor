/**
 * historicalWorkingHoursCleanEngine
 *
 * Phase 1.6: Build vehicle blocks from raw Fahrtenbuch trips.
 * Steps:
 *   A. Normalize rides (full datetime, preserve seconds)
 *   B. Group by vehicle, sort chronologically
 *   C. Chain into preliminary blocks (gap <= maxGapInsideBlockMinutes)
 *   D. Split too-long blocks (best-first recursive: minimize max half, prefer both-fit)
 *   E. Merge short blocks with nearest safe neighbor
 *
 * Pure functions — no React, no Supabase.
 */

import type { FahrtenbuchTrip } from '../hooks/useFahrtenbuch';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CleanHistoricalRide {
  tripId: string;
  sourceRowIndex: number | null;
  vehicle: string;
  originalDriverName: string | null;
  originalStartDatetime: string;
  originalEndDatetime: string;
  originalStartMs: number;
  originalEndMs: number;
  durationSec: number;
  rawTrip: FahrtenbuchTrip;
}

export interface VehicleBlockRide {
  tripId: string;
  sourceRowIndex: number | null;
  originalStartDatetime: string;
  originalEndDatetime: string;
  originalStartMs: number;
  originalEndMs: number;
  durationSec: number;
}

export type VehicleBlockWarning =
  | 'missing_vehicle'
  | 'missing_time'
  | 'zero_duration'
  | 'negative_duration'
  | 'original_vehicle_overlap'
  | 'short_block'
  | 'long_block';

export type VehicleBlockStatus = 'valid' | 'short' | 'long' | 'invalid';

// ── Lohnart second buckets ────────────────────────────────────────────────────

export interface LohnartSeconds {
  baseSec: number;       // 1000 Std (06:00–20:00, non-night)
  night25Sec: number;    // 1500 N25% (04:00–06:00 and 20:00–00:00)
  night40Sec: number;    // 1501 N40% (00:00–04:00)
  sundaySec: number;     // 1510 Son (any time on Sunday)
  holidaySec: number;    // Feiertag (any time on public holiday)
  totalSec: number;      // raw block duration
}

/** Returns German national (federal) public holidays for a given year as YYYY-MM-DD strings. */
export function getGermanNationalHolidays(year: number): Set<string> {
  const set = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, '0');
  const add = (y: number, m: number, d: number) => set.add(`${y}-${pad(m)}-${pad(d)}`);

  // Fixed holidays
  add(year, 1, 1);   // Neujahr
  add(year, 5, 1);   // Tag der Arbeit
  add(year, 10, 3);  // Tag der Deutschen Einheit
  add(year, 12, 25); // 1. Weihnachtstag
  add(year, 12, 26); // 2. Weihnachtstag

  // Easter-based holidays (Gauss algorithm)
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const easterMonth = Math.floor((h + l - 7 * m + 114) / 31);
  const easterDay = ((h + l - 7 * m + 114) % 31) + 1;
  const easterMs = Date.UTC(year, easterMonth - 1, easterDay);

  const easterSunday  = new Date(easterMs);
  const goodFriday    = new Date(easterMs - 2 * 86400000);
  const easterMonday  = new Date(easterMs + 1 * 86400000);
  const ascension     = new Date(easterMs + 39 * 86400000);
  const whitMonday    = new Date(easterMs + 50 * 86400000);

  for (const dt of [easterSunday, goodFriday, easterMonday, ascension, whitMonday]) {
    add(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  return set;
}

function msOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * Computes Lohnart-split seconds for an interval [startMs, endMs].
 * All timestamps are Unix ms (UTC). Uses local calendar day boundaries based
 * on wall-clock time (using local Date methods — suitable since Fahrtenbuch
 * datetimes are already local-time strings stored in UTC-offset Supabase timestamps).
 */
export function computeLohnartSeconds(startMs: number, endMs: number, holidaySet: Set<string>): LohnartSeconds {
  if (endMs <= startMs) return { baseSec: 0, night25Sec: 0, night40Sec: 0, sundaySec: 0, holidaySec: 0, totalSec: 0 };

  const totalSec = (endMs - startMs) / 1000;
  let baseSec = 0, night25Sec = 0, night40Sec = 0, sundaySec = 0, holidaySec = 0;

  // Walk day-by-day (local time) to classify each segment
  const startDate = new Date(startMs);
  // Find local midnight of the start day
  const dayStart = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 0, 0, 0, 0);

  for (let d = dayStart; d.getTime() < endMs; ) {
    const dMs = d.getTime();
    const nextDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
    const nextDayMs = nextDay.getTime();

    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const isSunday  = d.getDay() === 0;
    const isHoliday = holidaySet.has(dayKey);

    // Windows within this local calendar day:
    // N40: 00:00–04:00
    const n40Start = dMs;
    const n40End   = dMs + 4 * 3600000;
    // N25 early: 04:00–06:00
    const n25eStart = dMs + 4 * 3600000;
    const n25eEnd   = dMs + 6 * 3600000;
    // Base: 06:00–20:00
    const baseStart = dMs + 6 * 3600000;
    const baseEnd   = dMs + 20 * 3600000;
    // N25 late: 20:00–24:00
    const n25lStart = dMs + 20 * 3600000;
    const n25lEnd   = nextDayMs;

    const dayOverlap = msOverlap(startMs, endMs, dMs, nextDayMs);

    night40Sec  += msOverlap(startMs, endMs, n40Start, n40End) / 1000;
    night25Sec  += (msOverlap(startMs, endMs, n25eStart, n25eEnd) + msOverlap(startMs, endMs, n25lStart, n25lEnd)) / 1000;
    baseSec     += msOverlap(startMs, endMs, baseStart, baseEnd) / 1000;
    if (isSunday)  sundaySec  += dayOverlap / 1000;
    if (isHoliday) holidaySec += dayOverlap / 1000;

    d = nextDay;
  }

  return { baseSec, night25Sec, night40Sec, sundaySec, holidaySec, totalSec };
}

export interface VehicleBlock {
  blockId: string;
  vehicle: string;
  blockStartMs: number;
  blockEndMs: number;
  blockDurationSec: number;
  rides: VehicleBlockRide[];
  status: VehicleBlockStatus;
  /** @deprecated use status */
  validity: 'valid' | 'invalid';
  warnings: VehicleBlockWarning[];
  /** Only set when status === 'long' */
  longReason?: string;
  /** Lohnart-split seconds for this block */
  lohnart: LohnartSeconds;
}

export interface OriginalOverlapRecord {
  vehicle: string;
  rowA: number | null;
  rowB: number | null;
  startA: string;
  endA: string;
  startB: string;
  endB: string;
  overlapMs: number;
}

export interface BuildVehicleBlocksOptions {
  maxGapInsideBlockMinutes?: number;
  minBlockDurationMinutes?: number;
  maxBlockDurationMinutes?: number;
  shortMergeGapMinutes?: number;
}

export interface PerVehicleSummary {
  vehicle: string;
  rideCount: number;
  blockCount: number;
  blockHours: number;
  shortBlocks: number;
  longBlocks: number;
  originalDataWarnings: number;
}

export interface RowCoverageDiagnostic {
  ridesConsidered: number;
  ridesInBlocks: number;
  uniqueRowsInBlocks: number;
  duplicateRows: number;
  missingRows: number;
  duplicateSourceRows: (number | null)[];
  missingSourceRows: (number | null)[];
}

export interface BuildVehicleBlocksResult {
  blocks: VehicleBlock[];
  options: Required<BuildVehicleBlocksOptions>;
  totalRides: number;
  canceledRides: number;
  consideredRides: number;
  vehicleCount: number;
  validBlockCount: number;
  shortBlockCount: number;
  longBlockCount: number;
  invalidBlockCount: number;
  assignableBlockCount: number;
  totalBlockHours: number;
  avgBlockDurationSec: number;
  shortestBlockSec: number;
  longestBlockSec: number;
  originalOverlaps: OriginalOverlapRecord[];
  perVehicle: PerVehicleSummary[];
  rowCoverage: RowCoverageDiagnostic;
  normalizedRides: CleanHistoricalRide[];
}

// ── Datetime resolution ────────────────────────────────────────────────────────

function resolveFullDatetime(trip: FahrtenbuchTrip, which: 'start' | 'end'): string {
  const raw = (trip.raw_data_json ?? {}) as Record<string, unknown>;
  const startKeys = ['Uhrzeit des Fahrtbeginns', 'Fahrtbeginn', 'start_datetime', 'StartDatetime', 'Fahrt_Beginn', 'FahrtBeginn'];
  const endKeys   = ['Uhrzeit des Fahrtendes',   'Fahrtende',   'end_datetime',   'EndDatetime',   'Fahrt_Ende',   'FahrtEnde'];
  const candidates = which === 'start' ? startKeys : endKeys;

  for (const key of candidates) {
    const val = raw[key];
    if (typeof val === 'string' && val.trim()) {
      const v = val.trim();
      if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return v;
      if (/^\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/.test(v)) {
        const m = v.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}:\d{2}(?::\d{2})?)$/);
        if (m) return `${m[3]}-${m[2]}-${m[1]}T${m[4]}`;
      }
    }
  }

  const date = trip.trip_date;
  const time = which === 'start' ? trip.start_time : trip.end_time;
  if (!date || !time) return '';
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(time)) return time;
  const timePart = /^(\d{2}:\d{2}(?::\d{2})?)/.exec(time)?.[1] ?? time;
  return `${date}T${timePart}`;
}

function parseFullDatetimeMs(dt: string): number {
  if (!dt) return 0;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(dt)) {
    const ms = Date.parse(dt.replace(' ', 'T'));
    return isNaN(ms) ? 0 : ms;
  }
  return 0;
}

// ── Block ID generation ───────────────────────────────────────────────────────

let globalSeq = 0;
function nextBlockId(): string {
  globalSeq++;
  return `blk-${String(globalSeq).padStart(4, '0')}`;
}

// ── Internal building block ────────────────────────────────────────────────────

interface RideChain {
  vehicle: string;
  rides: CleanHistoricalRide[];
}

function chainDurationMs(chain: RideChain): number {
  if (chain.rides.length === 0) return 0;
  const starts = chain.rides.map(r => r.originalStartMs).filter(Boolean);
  const ends   = chain.rides.map(r => r.originalEndMs).filter(Boolean);
  if (starts.length === 0 || ends.length === 0) return 0;
  return Math.max(...ends) - Math.min(...starts);
}

// ── Phase D: best-first recursive split ───────────────────────────────────────
//
// Scoring priority at each split:
//   1. Both halves fit in maxBlockMs  (preferred)
//   2. Minimize max(leftDur, rightDur)
//   3. Maximize gap between the two boundary rides
//   4. Minimize count of resulting short blocks
//
// After picking the best boundary, recursively split both halves.
// A block remains 'long' only when it has a single ride > max or
// every boundary has a timestamp overlap (no safe boundary exists).

function splitChain(chain: RideChain, maxBlockMs: number, minBlockMs: number): RideChain[] {
  if (chainDurationMs(chain) <= maxBlockMs) return [chain];
  if (chain.rides.length <= 1) return [chain];

  const rides = chain.rides;

  interface Candidate {
    idx: number;
    maxDur: number;
    gap: number;
    shortCount: number;
    bothFit: boolean;
  }

  const candidates: Candidate[] = [];

  for (let i = 0; i < rides.length - 1; i++) {
    const prevEnd   = rides[i].originalEndMs;
    const nextStart = rides[i + 1].originalStartMs;
    if (!prevEnd || !nextStart) continue;
    if (prevEnd > nextStart) continue;

    const leftDur  = chainDurationMs({ vehicle: chain.vehicle, rides: rides.slice(0, i + 1) });
    const rightDur = chainDurationMs({ vehicle: chain.vehicle, rides: rides.slice(i + 1) });
    const gap      = nextStart - prevEnd;
    const maxDur   = Math.max(leftDur, rightDur);
    const shortCount =
      (leftDur > 0 && leftDur < minBlockMs ? 1 : 0) +
      (rightDur > 0 && rightDur < minBlockMs ? 1 : 0);

    candidates.push({ idx: i, maxDur, gap, shortCount, bothFit: leftDur <= maxBlockMs && rightDur <= maxBlockMs });
  }

  if (candidates.length === 0) return [chain];

  candidates.sort((a, b) => {
    if (a.bothFit !== b.bothFit) return a.bothFit ? -1 : 1;
    if (a.maxDur !== b.maxDur) return a.maxDur - b.maxDur;
    if (b.gap !== a.gap) return b.gap - a.gap;
    return a.shortCount - b.shortCount;
  });

  const { idx } = candidates[0];
  const left:  RideChain = { vehicle: chain.vehicle, rides: rides.slice(0, idx + 1) };
  const right: RideChain = { vehicle: chain.vehicle, rides: rides.slice(idx + 1) };

  return [
    ...splitChain(left,  maxBlockMs, minBlockMs),
    ...splitChain(right, maxBlockMs, minBlockMs),
  ];
}

// ── Phase E: merge short chains ────────────────────────────────────────────────

function mergeShortChains(
  chains: RideChain[],
  minBlockMs: number,
  maxBlockMs: number,
  maxMergeGapMs: number,
): RideChain[] {
  let arr = [...chains];
  let changed = true;

  while (changed) {
    changed = false;
    for (let i = 0; i < arr.length; i++) {
      if (chainDurationMs(arr[i]) >= minBlockMs) continue;
      if (arr[i].rides.length === 0) continue;

      const shortChain = arr[i];
      const shortStart = Math.min(...shortChain.rides.map(r => r.originalStartMs).filter(Boolean));
      const shortEnd   = Math.max(...shortChain.rides.map(r => r.originalEndMs).filter(Boolean));

      let bestIdx = -1;
      let bestGap = Infinity;

      for (let j = i - 1; j >= 0; j--) {
        if (arr[j].vehicle !== shortChain.vehicle) continue;
        const nEnd   = Math.max(...arr[j].rides.map(r => r.originalEndMs).filter(Boolean));
        const nStart = Math.min(...arr[j].rides.map(r => r.originalStartMs).filter(Boolean));
        const gap = shortStart - nEnd;
        if (gap >= 0 && gap <= maxMergeGapMs && shortEnd - nStart <= maxBlockMs && gap < bestGap) {
          bestGap = gap;
          bestIdx = j;
        }
        break;
      }

      for (let j = i + 1; j < arr.length; j++) {
        if (arr[j].vehicle !== shortChain.vehicle) continue;
        const nEnd   = Math.max(...arr[j].rides.map(r => r.originalEndMs).filter(Boolean));
        const nStart = Math.min(...arr[j].rides.map(r => r.originalStartMs).filter(Boolean));
        const gap = nStart - shortEnd;
        if (gap >= 0 && gap <= maxMergeGapMs && nEnd - shortStart <= maxBlockMs) {
          if (gap < bestGap || (gap === bestGap && bestIdx < i)) { bestGap = gap; bestIdx = j; }
        }
        break;
      }

      if (bestIdx < 0) continue;

      const neighbor = arr[bestIdx];
      const mergedRides = bestIdx < i
        ? [...neighbor.rides, ...shortChain.rides]
        : [...shortChain.rides, ...neighbor.rides];
      const merged: RideChain = { vehicle: shortChain.vehicle, rides: mergedRides };

      const newArr = arr.filter((_, k) => k !== i && k !== bestIdx);
      newArr.splice(Math.min(i, bestIdx), 0, merged);
      arr = newArr;
      changed = true;
      break;
    }
  }

  return arr;
}

// ── Finalize: chain → VehicleBlock ────────────────────────────────────────────

function finalizeBlock(
  chain: RideChain,
  overlapTripIds: Set<string>,
  minBlockMs: number,
  maxBlockMs: number,
): VehicleBlock {
  const vehicle = chain.vehicle;
  const warnings: VehicleBlockWarning[] = [];
  let hasHardWarning = false;

  for (const r of chain.rides) {
    if (!r.vehicle) { warnings.push('missing_vehicle'); hasHardWarning = true; }
    if (!r.originalStartDatetime || !r.originalEndDatetime) {
      if (!warnings.includes('missing_time')) { warnings.push('missing_time'); hasHardWarning = true; }
    }
    if (r.durationSec === 0 && r.originalStartMs > 0) {
      if (!warnings.includes('zero_duration')) { warnings.push('zero_duration'); hasHardWarning = true; }
    }
    if (r.durationSec < 0) {
      if (!warnings.includes('negative_duration')) { warnings.push('negative_duration'); hasHardWarning = true; }
    }
    if (overlapTripIds.has(r.tripId)) {
      if (!warnings.includes('original_vehicle_overlap')) { warnings.push('original_vehicle_overlap'); hasHardWarning = true; }
    }
  }

  const starts = chain.rides.map(r => r.originalStartMs).filter(Boolean);
  const ends   = chain.rides.map(r => r.originalEndMs).filter(Boolean);
  const blockStartMs = starts.length > 0 ? Math.min(...starts) : 0;
  const blockEndMs   = ends.length   > 0 ? Math.max(...ends)   : 0;
  const blockDurMs   = blockStartMs && blockEndMs ? blockEndMs - blockStartMs : 0;
  const blockDurSec  = Math.round(blockDurMs / 1000);

  let longReason: string | undefined;

  if (!hasHardWarning) {
    if (blockDurMs > 0 && blockDurMs < minBlockMs) warnings.push('short_block');
    if (blockDurMs > maxBlockMs) {
      warnings.push('long_block');
      if (chain.rides.length === 1) {
        longReason = 'Einzelfahrt länger als Maximaldauer';
      } else {
        const hasSafeBoundary = chain.rides.some((r, i) => {
          if (i === chain.rides.length - 1) return false;
          const end   = r.originalEndMs;
          const start = chain.rides[i + 1].originalStartMs;
          return end > 0 && start > 0 && end <= start;
        });
        longReason = hasSafeBoundary
          ? 'Keine Trennstelle unter Maximaldauer gefunden'
          : 'Keine sichere Trennstelle gefunden';
      }
    }
  }

  let status: VehicleBlockStatus = 'valid';
  if (hasHardWarning)                        status = 'invalid';
  else if (warnings.includes('long_block'))  status = 'long';
  else if (warnings.includes('short_block')) status = 'short';

  return {
    blockId: nextBlockId(),
    vehicle,
    blockStartMs,
    blockEndMs,
    blockDurationSec: blockDurSec,
    rides: chain.rides.map(r => ({
      tripId: r.tripId,
      sourceRowIndex: r.sourceRowIndex,
      originalStartDatetime: r.originalStartDatetime,
      originalEndDatetime: r.originalEndDatetime,
      originalStartMs: r.originalStartMs,
      originalEndMs: r.originalEndMs,
      durationSec: r.durationSec,
    })),
    status,
    validity: hasHardWarning ? 'invalid' : 'valid',
    warnings,
    longReason,
    lohnart: blockStartMs > 0
      ? computeLohnartSeconds(blockStartMs, blockEndMs, getGermanNationalHolidays(new Date(blockStartMs).getFullYear()))
      : { baseSec: 0, night25Sec: 0, night40Sec: 0, sundaySec: 0, holidaySec: 0, totalSec: 0 },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function buildVehicleBlocksForHistoricalWorkingHours(
  trips: FahrtenbuchTrip[],
  options: BuildVehicleBlocksOptions = {},
): BuildVehicleBlocksResult {
  globalSeq = 0;

  const maxGapMs      = (options.maxGapInsideBlockMinutes ?? 60) * 60_000;
  const minBlockMs    = (options.minBlockDurationMinutes  ?? 60) * 60_000;
  const maxBlockMs    = (options.maxBlockDurationMinutes  ?? 360) * 60_000;
  const maxMergeGapMs = (options.shortMergeGapMinutes     ?? 60) * 60_000;

  const resolvedOptions: Required<BuildVehicleBlocksOptions> = {
    maxGapInsideBlockMinutes: options.maxGapInsideBlockMinutes ?? 60,
    minBlockDurationMinutes:  options.minBlockDurationMinutes  ?? 60,
    maxBlockDurationMinutes:  options.maxBlockDurationMinutes  ?? 360,
    shortMergeGapMinutes:     options.shortMergeGapMinutes     ?? 60,
  };

  const totalRides    = trips.length;
  const canceledRides = trips.filter(t => t.is_canceled).length;

  // A. Normalize
  const rides: CleanHistoricalRide[] = [];
  for (const trip of trips) {
    if (trip.is_canceled) continue;
    const vehicle = (trip.car_identifier ?? '').trim();
    const startDt = resolveFullDatetime(trip, 'start');
    const endDt   = resolveFullDatetime(trip, 'end');
    const startMs = parseFullDatetimeMs(startDt);
    const endMs   = parseFullDatetimeMs(endDt);
    rides.push({
      tripId: trip.id,
      sourceRowIndex: trip.source_row_index ?? null,
      vehicle,
      originalDriverName: trip.original_driver_name ?? null,
      originalStartDatetime: startDt,
      originalEndDatetime: endDt,
      originalStartMs: startMs,
      originalEndMs: endMs,
      durationSec: startMs > 0 && endMs > 0 ? Math.round((endMs - startMs) / 1000) : 0,
      rawTrip: trip,
    });
  }

  // Detect original vehicle overlaps
  const originalOverlaps: OriginalOverlapRecord[] = [];
  const overlapTripIds = new Set<string>();
  {
    const byVehicle = new Map<string, CleanHistoricalRide[]>();
    for (const r of rides) {
      if (!r.vehicle || !r.originalStartMs || !r.originalEndMs) continue;
      if (!byVehicle.has(r.vehicle)) byVehicle.set(r.vehicle, []);
      byVehicle.get(r.vehicle)!.push(r);
    }
    for (const [, vRides] of byVehicle) {
      const sorted = [...vRides].sort((a, b) => a.originalStartMs - b.originalStartMs);
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i], b = sorted[j];
          if (b.originalStartMs >= a.originalEndMs) break;
          const overlapMs = Math.min(a.originalEndMs, b.originalEndMs) - Math.max(a.originalStartMs, b.originalStartMs);
          if (overlapMs > 0) {
            overlapTripIds.add(a.tripId);
            overlapTripIds.add(b.tripId);
            if (originalOverlaps.length < 20) {
              originalOverlaps.push({
                vehicle: a.vehicle,
                rowA: a.sourceRowIndex, rowB: b.sourceRowIndex,
                startA: a.originalStartDatetime, endA: a.originalEndDatetime,
                startB: b.originalStartDatetime, endB: b.originalEndDatetime,
                overlapMs,
              });
            }
          }
        }
      }
    }
  }

  // B. Group by vehicle
  const byVehicle = new Map<string, CleanHistoricalRide[]>();
  for (const r of rides) {
    const key = r.vehicle || '__no_vehicle__';
    if (!byVehicle.has(key)) byVehicle.set(key, []);
    byVehicle.get(key)!.push(r);
  }

  const vehicleCount = byVehicle.size;
  const allChains: RideChain[] = [];

  for (const [vehicleKey, vRides] of byVehicle) {
    const vehicle = vehicleKey === '__no_vehicle__' ? '' : vehicleKey;
    vRides.sort((a, b) => {
      if (!a.originalStartMs && !b.originalStartMs) return 0;
      if (!a.originalStartMs) return 1;
      if (!b.originalStartMs) return -1;
      return a.originalStartMs - b.originalStartMs;
    });
    if (vRides.length === 0) continue;

    // C. Chain
    let cur: CleanHistoricalRide[] = [vRides[0]];
    const vehicleChains: RideChain[] = [];
    for (let i = 1; i < vRides.length; i++) {
      const prev = cur[cur.length - 1];
      const curr = vRides[i];
      const prevEnd = prev.originalEndMs || prev.originalStartMs;
      const gap = (prevEnd && curr.originalStartMs) ? curr.originalStartMs - prevEnd : Infinity;
      if (gap <= maxGapMs) {
        cur.push(curr);
      } else {
        vehicleChains.push({ vehicle, rides: cur });
        cur = [curr];
      }
    }
    vehicleChains.push({ vehicle, rides: cur });

    // D. Split
    const splitChains: RideChain[] = [];
    for (const chain of vehicleChains) splitChains.push(...splitChain(chain, maxBlockMs, minBlockMs));

    // E. Merge
    allChains.push(...mergeShortChains(splitChains, minBlockMs, maxBlockMs, maxMergeGapMs));
  }

  const allBlocks = allChains.map(chain => finalizeBlock(chain, overlapTripIds, minBlockMs, maxBlockMs));

  // Aggregate
  const validBlocks   = allBlocks.filter(b => b.status === 'valid');
  const shortBlocks   = allBlocks.filter(b => b.status === 'short');
  const longBlocks    = allBlocks.filter(b => b.status === 'long');
  const invalidBlocks = allBlocks.filter(b => b.status === 'invalid');

  const allDurations    = allBlocks.map(b => b.blockDurationSec).filter(d => d > 0);
  const totalBlockHours = allDurations.reduce((s, d) => s + d, 0) / 3600;
  const avgBlockDurationSec = allDurations.length > 0
    ? Math.round(allDurations.reduce((s, d) => s + d, 0) / allDurations.length)
    : 0;
  const shortestBlockSec = allDurations.length > 0 ? Math.min(...allDurations) : 0;
  const longestBlockSec  = allDurations.length > 0 ? Math.max(...allDurations) : 0;

  // Per-vehicle
  const vehicleMap = new Map<string, PerVehicleSummary>();
  for (const r of rides) {
    const v = r.vehicle || '(kein Fahrzeug)';
    if (!vehicleMap.has(v)) vehicleMap.set(v, { vehicle: v, rideCount: 0, blockCount: 0, blockHours: 0, shortBlocks: 0, longBlocks: 0, originalDataWarnings: 0 });
    vehicleMap.get(v)!.rideCount++;
  }
  for (const b of allBlocks) {
    const v = b.vehicle || '(kein Fahrzeug)';
    if (!vehicleMap.has(v)) vehicleMap.set(v, { vehicle: v, rideCount: 0, blockCount: 0, blockHours: 0, shortBlocks: 0, longBlocks: 0, originalDataWarnings: 0 });
    const e = vehicleMap.get(v)!;
    e.blockCount++;
    e.blockHours += b.blockDurationSec / 3600;
    if (b.status === 'short')   e.shortBlocks++;
    if (b.status === 'long')    e.longBlocks++;
    if (b.status === 'invalid') e.originalDataWarnings++;
  }

  // Row coverage
  const tripIdCount = new Map<string, number>();
  for (const r of rides) tripIdCount.set(r.tripId, 0);
  for (const block of allBlocks) {
    for (const ride of block.rides) {
      tripIdCount.set(ride.tripId, (tripIdCount.get(ride.tripId) ?? 0) + 1);
    }
  }
  const tripToRow = new Map(rides.map(r => [r.tripId, r.sourceRowIndex]));
  const duplicateTripIds = [...tripIdCount.entries()].filter(([, c]) => c > 1).map(([id]) => id);
  const missingTripIds   = [...tripIdCount.entries()].filter(([, c]) => c === 0).map(([id]) => id);
  const ridesInBlocks    = [...tripIdCount.values()].filter(c => c > 0).length;

  const rowCoverage: RowCoverageDiagnostic = {
    ridesConsidered:    rides.length,
    ridesInBlocks,
    uniqueRowsInBlocks: ridesInBlocks,
    duplicateRows:      duplicateTripIds.length,
    missingRows:        missingTripIds.length,
    duplicateSourceRows: duplicateTripIds.slice(0, 20).map(id => tripToRow.get(id) ?? null),
    missingSourceRows:   missingTripIds.slice(0, 20).map(id => tripToRow.get(id) ?? null),
  };

  return {
    blocks: allBlocks,
    options: resolvedOptions,
    totalRides,
    canceledRides,
    consideredRides: rides.length,
    vehicleCount,
    validBlockCount:      validBlocks.length,
    shortBlockCount:      shortBlocks.length,
    longBlockCount:       longBlocks.length,
    invalidBlockCount:    invalidBlocks.length,
    assignableBlockCount: validBlocks.length,
    totalBlockHours,
    avgBlockDurationSec,
    shortestBlockSec,
    longestBlockSec,
    originalOverlaps,
    perVehicle: [...vehicleMap.values()].sort((a, b) => a.vehicle.localeCompare(b.vehicle)),
    rowCoverage,
    normalizedRides: rides,
  };
}

// ── Formatting helpers ────────────────────────────────────────────────────────

export function formatBlockDuration(totalSec: number): string {
  if (totalSec <= 0) return '—';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function formatBlockHours(totalSec: number): string {
  if (totalSec <= 0) return '0,0';
  return (totalSec / 3600).toFixed(1).replace('.', ',');
}

export function formatBlockDatetime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function blockStatusLabel(block: VehicleBlock): string {
  switch (block.status) {
    case 'valid':   return 'Gültig';
    case 'short':   return 'Kurz';
    case 'long':    return 'Lang';
    case 'invalid': return 'Ungültig';
  }
}

export function blockWarningLabels(block: VehicleBlock): string[] {
  return block.warnings.map(w => {
    switch (w) {
      case 'missing_vehicle':          return 'Kein Fahrzeug';
      case 'missing_time':             return 'Zeit fehlt';
      case 'zero_duration':            return 'Nulldauer';
      case 'negative_duration':        return 'Negative Dauer';
      case 'original_vehicle_overlap': return 'Originaldaten-Überschneidung';
      case 'short_block':              return 'Kurzer Block (<1h)';
      case 'long_block':               return 'Langer Block (>6h)';
    }
  });
}

/**
 * Compact source-row range string.
 * Contiguous → "14–22"; non-contiguous → "14, 18–21, 25"; too long → "14, 18–21, … (+3)".
 */
export function blockSourceRowRange(block: VehicleBlock, maxRanges = 5): string {
  const indices = block.rides
    .map(r => r.sourceRowIndex)
    .filter((x): x is number => x !== null);
  if (indices.length === 0) return '—';

  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  let lo = sorted[0], hi = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === hi + 1) { hi = sorted[i]; }
    else { ranges.push([lo, hi]); lo = hi = sorted[i]; }
  }
  ranges.push([lo, hi]);

  const fmt = ([l, h]: [number, number]) => l === h ? `${l}` : `${l}–${h}`;
  if (ranges.length <= maxRanges) return ranges.map(fmt).join(', ');
  return `${ranges.slice(0, maxRanges).map(fmt).join(', ')}, … (+${ranges.length - maxRanges})`;
}

// ── Regular driver assignment types ──────────────────────────────────────────

export interface RegularDriverTarget {
  driverId: string;
  driverName: string;
  targetWorkSec: number;    // kept for compat (sum of all buckets)
  targetHours: number;      // kept for compat
  targetBaseSec1000: number;
  targetNight25Sec1500: number;
  targetNight40Sec1501: number;
  targetSundaySec1510: number;
  targetHolidaySec: number;
  targetTotalSec: number;   // == targetWorkSec
}

export interface RegularBlockAssignment {
  blockId: string;
  driverId: string;
  driverName: string;
  vehicle: string;
  startMs: number;
  endMs: number;
  durationSec: number;
  sourceRowIndices: (number | null)[];
  assignmentType: 'regular_block_assignment_preview';
}

export interface RegularDriverAssignmentSummary {
  driverId: string;
  driverName: string;
  targetWorkSec: number;
  assignedWorkSec: number;
  remainingWorkSec: number;
  assignedBlockCount: number;
  overlapCount: number;
  status: 'unter_ziel' | 'ziel_erreicht' | 'keine_zuteilung';
  // Per-bucket Lohnart targets and actuals
  targetBaseSec1000: number;
  targetNight25Sec1500: number;
  targetNight40Sec1501: number;
  targetSundaySec1510: number;
  targetHolidaySec: number;
  assignedBaseSec1000: number;
  assignedNight25Sec1500: number;
  assignedNight40Sec1501: number;
  assignedSundaySec1510: number;
  assignedHolidaySec: number;
}

export interface RegularDriverAssignmentValidation {
  assignedBlockCount: number;
  surplusBlockCount: number;
  duplicateAssignedBlockCount: number;
  driverOverlapCount: number;
  targetOverrunCount: number;
  invalidRegularAssignmentCount: number;
  rejectedDueToRowDriverOverlap: number;
}

/** Pre-computed half-open exclusion interval [startMs, endExclusiveMs) for a driver. */
export interface DriverPlanningExclusion {
  startMs: number;
  endExclusiveMs: number;
  label: string;
}

export interface RegularAssignmentRejection {
  blockId: string;
  reason:
    | 'target_full'
    | 'would_exceed_target'
    | 'would_exceed_total_target'
    | 'would_exceed_1000_target'
    | 'would_exceed_1500_night25_target'
    | 'would_exceed_1501_night40_target'
    | 'would_exceed_1510_sunday_target'
    | 'would_exceed_holiday_target'
    | 'driver_overlap'
    | 'driver_excluded_by_note'
    | 'no_driver_available';
  durationSec: number;
  excludedDriverId?: string;
  excludedDriverName?: string;
  exclusionLabel?: string;
}

export interface RegularDriverAssignmentResult {
  assignments: RegularBlockAssignment[];
  driverSummaries: RegularDriverAssignmentSummary[];
  surplusBlocks: VehicleBlock[];
  surplusValidBlocks: VehicleBlock[];
  surplusShortBlocks: VehicleBlock[];
  surplusLongBlocks: VehicleBlock[];
  surplusInvalidBlocks: VehicleBlock[];
  validation: RegularDriverAssignmentValidation;
  rejectedAssignments: RegularAssignmentRejection[];
}

// ── Assignment strategy ────────────────────────────────────────────────────────
export type RegularAssignmentStrategy = 'hours_first' | 'rides_first' | 'balanced';

// ── assignRegularDriversToVehicleBlocks ───────────────────────────────────────
//
// Greedy best-fit assignment of valid vehicle blocks to regular drivers.
// Rules:
//   - Only 'valid' blocks are candidates; short/long/invalid stay in surplus.
//   - No block assigned more than once.
//   - No driver may exceed their targetWorkSec (+1s float tolerance).
//   - No driver may receive overlapping block intervals.
//   - Sort candidates largest-first for best coverage.
//   - Pick the driver that minimises remaining-after-assignment (tightest fit).

export function assignRegularDriversToVehicleBlocks(
  phase1Result: BuildVehicleBlocksResult,
  regularDrivers: RegularDriverTarget[],
  strategy: RegularAssignmentStrategy = 'hours_first',
  driverExclusions?: Map<string, DriverPlanningExclusion[]>,
): RegularDriverAssignmentResult {
  const candidateBlocks    = phase1Result.blocks.filter(b => b.status === 'valid');
  const nonCandidateBlocks = phase1Result.blocks.filter(b => b.status !== 'valid');

  // Sort candidates based on strategy
  const sortedCandidates = [...candidateBlocks].sort((a, b) => {
    if (strategy === 'rides_first') {
      // Primary: more rides first; secondary: higher rides/hour; tertiary: earlier start; then blockId
      const aRides = a.rides.length;
      const bRides = b.rides.length;
      if (bRides !== aRides) return bRides - aRides;
      const aRph = a.blockDurationSec > 0 ? aRides / (a.blockDurationSec / 3600) : 0;
      const bRph = b.blockDurationSec > 0 ? bRides / (b.blockDurationSec / 3600) : 0;
      if (Math.abs(bRph - aRph) > 0.001) return bRph - aRph;
      if (a.blockStartMs !== b.blockStartMs) return a.blockStartMs - b.blockStartMs;
      return a.blockId.localeCompare(b.blockId);
    }
    // hours_first: largest duration first → earlier start → blockId
    if (b.blockDurationSec !== a.blockDurationSec) return b.blockDurationSec - a.blockDurationSec;
    if (a.blockStartMs !== b.blockStartMs) return a.blockStartMs - b.blockStartMs;
    return a.blockId.localeCompare(b.blockId);
  });

  interface DriverState {
    target: RegularDriverTarget;
    assignedSec: number;
    assignedBase1000: number;
    assignedNight25: number;
    assignedNight40: number;
    assignedSunday: number;
    assignedHoliday: number;
    // Row-level ride intervals (not block envelopes) for accurate overlap detection
    intervals: Array<{ startMs: number; endMs: number }>;
    rejectedDueToRowDriverOverlap: number;
  }

  const stateMap = new Map<string, DriverState>();
  for (const d of regularDrivers) {
    stateMap.set(d.driverId, {
      target: d,
      assignedSec: 0,
      assignedBase1000: 0,
      assignedNight25: 0,
      assignedNight40: 0,
      assignedSunday: 0,
      assignedHoliday: 0,
      intervals: [],
      rejectedDueToRowDriverOverlap: 0,
    });
  }

  const assignments: RegularBlockAssignment[] = [];
  const rejections:  RegularAssignmentRejection[] = [];
  const assignedIds  = new Set<string>();
  // Tracks per-block driver exclusions (only emitted if the block is ultimately unassigned)
  const pendingExclusionRejections: RegularAssignmentRejection[] = [];

  for (const block of sortedCandidates) {
    const bStart = block.blockStartMs;
    const bEnd   = block.blockEndMs;
    const bl     = block.lohnart;

    let bestId: string | null = null;
    let bestRemaining = Infinity;
    let bestAssigned  = Infinity;
    let bestName      = '';

    let anyActive    = false;
    let anyHasBudget = false;
    let anyCanFit    = false;
    let bucketRejectReason: RegularAssignmentRejection['reason'] = 'no_driver_available';
    pendingExclusionRejections.length = 0;

    for (const [id, s] of stateMap) {
      const t = s.target;
      if (t.targetTotalSec <= 0 && t.targetWorkSec <= 0) continue;
      anyActive = true;
      const totalTarget = t.targetTotalSec > 0 ? t.targetTotalSec : t.targetWorkSec;
      if (s.assignedSec >= totalTarget) continue;
      anyHasBudget = true;

      // Check all per-bucket constraints (1-second tolerance)
      const TOL = 1;
      if (s.assignedSec + block.blockDurationSec > totalTarget + TOL) {
        bucketRejectReason = 'would_exceed_total_target';
        continue;
      }
      if (t.targetBaseSec1000 >= 0 && s.assignedBase1000 + bl.baseSec > t.targetBaseSec1000 + TOL) {
        bucketRejectReason = 'would_exceed_1000_target';
        continue;
      }
      if (t.targetNight25Sec1500 >= 0 && s.assignedNight25 + bl.night25Sec > t.targetNight25Sec1500 + TOL) {
        bucketRejectReason = 'would_exceed_1500_night25_target';
        continue;
      }
      if (t.targetNight40Sec1501 >= 0 && s.assignedNight40 + bl.night40Sec > t.targetNight40Sec1501 + TOL) {
        bucketRejectReason = 'would_exceed_1501_night40_target';
        continue;
      }
      if (t.targetSundaySec1510 >= 0 && s.assignedSunday + bl.sundaySec > t.targetSundaySec1510 + TOL) {
        bucketRejectReason = 'would_exceed_1510_sunday_target';
        continue;
      }
      if (t.targetHolidaySec >= 0 && s.assignedHoliday + bl.holidaySec > t.targetHolidaySec + TOL) {
        bucketRejectReason = 'would_exceed_holiday_target';
        continue;
      }
      anyCanFit = true;

      // Planning-exclusion check: reject driver if any ride falls in an excluded interval
      if (driverExclusions && driverExclusions.has(id)) {
        const excls = driverExclusions.get(id)!;
        const firstConflict = block.rides.find(ride =>
          excls.some(ex => ride.originalStartMs < ex.endExclusiveMs && ride.originalEndMs > ex.startMs)
        );
        if (firstConflict) {
          const matchedExcl = excls.find(ex => firstConflict.originalStartMs < ex.endExclusiveMs && firstConflict.originalEndMs > ex.startMs)!;
          pendingExclusionRejections.push({
            blockId: block.blockId,
            reason: 'driver_excluded_by_note',
            durationSec: block.blockDurationSec,
            excludedDriverId: id,
            excludedDriverName: t.driverName,
            exclusionLabel: matchedExcl.label,
          });
          continue;
        }
      }

      // Row-level overlap check: every ride in this block must not overlap any already-assigned ride of this driver
      const hasRowOverlap = block.rides.some(ride =>
        s.intervals.some(iv => iv.startMs < ride.originalEndMs && ride.originalStartMs < iv.endMs)
      );
      if (hasRowOverlap) {
        s.rejectedDueToRowDriverOverlap++;
        continue;
      }

      const remaining = totalTarget - (s.assignedSec + block.blockDurationSec);
      let better: boolean;
      if (strategy === 'balanced') {
        // balanced: pick the driver with the lowest current assigned ratio
        // (assignedSec / totalTarget) so workload is spread proportionally.
        // Tie-break: lower absolute assigned seconds, then name.
        const candidateRatio = totalTarget > 0 ? s.assignedSec / totalTarget : 0;
        const bestRatio = bestId
          ? (() => { const bs = stateMap.get(bestId!)!; const bt = bs.target; const btt = bt.targetTotalSec > 0 ? bt.targetTotalSec : bt.targetWorkSec; return btt > 0 ? bs.assignedSec / btt : 0; })()
          : Infinity;
        better =
          candidateRatio < bestRatio - 0.001 ||
          (Math.abs(candidateRatio - bestRatio) <= 0.001 && s.assignedSec < bestAssigned) ||
          (Math.abs(candidateRatio - bestRatio) <= 0.001 && s.assignedSec === bestAssigned && t.driverName < bestName);
      } else if (strategy === 'rides_first') {
        // For rides_first: prefer driver with most remaining budget (keeps options open),
        // tie-break by fewer assigned blocks (spreads rides), then name
        const candidateRemaining = totalTarget - s.assignedSec;
        const bestCandidateRemaining = bestId
          ? (() => { const bs = stateMap.get(bestId!)!; const bt = bs.target; return (bt.targetTotalSec > 0 ? bt.targetTotalSec : bt.targetWorkSec) - bs.assignedSec; })()
          : -Infinity;
        better =
          candidateRemaining > bestCandidateRemaining ||
          (candidateRemaining === bestCandidateRemaining && s.assignedSec < bestAssigned) ||
          (candidateRemaining === bestCandidateRemaining && s.assignedSec === bestAssigned && t.driverName < bestName);
      } else {
        // hours_first: tightest fit
        better =
          remaining < bestRemaining ||
          (remaining === bestRemaining && s.assignedSec < bestAssigned) ||
          (remaining === bestRemaining && s.assignedSec === bestAssigned && t.driverName < bestName);
      }

      if (better) {
        bestId = id;
        bestRemaining = remaining;
        bestAssigned  = s.assignedSec;
        bestName      = t.driverName;
      }
    }

    if (bestId) {
      const s = stateMap.get(bestId)!;
      s.assignedSec     += block.blockDurationSec;
      s.assignedBase1000 += bl.baseSec;
      s.assignedNight25  += bl.night25Sec;
      s.assignedNight40  += bl.night40Sec;
      s.assignedSunday   += bl.sundaySec;
      s.assignedHoliday  += bl.holidaySec;
      // Store individual ride intervals (not block envelope) for accurate row-level overlap detection
      for (const ride of block.rides) {
        s.intervals.push({ startMs: ride.originalStartMs, endMs: ride.originalEndMs });
      }
      assignedIds.add(block.blockId);
      assignments.push({
        blockId: block.blockId,
        driverId: bestId,
        driverName: s.target.driverName,
        vehicle: block.vehicle,
        startMs: bStart,
        endMs: bEnd,
        durationSec: block.blockDurationSec,
        sourceRowIndices: block.rides.map(r => r.sourceRowIndex),
        assignmentType: 'regular_block_assignment_preview',
      });
    } else {
      // Emit the driver-exclusion rejections (deferred, now that we know the block was unassigned)
      for (const excl of pendingExclusionRejections) rejections.push(excl);
      let reason: RegularAssignmentRejection['reason'];
      if (!anyActive)         reason = 'no_driver_available';
      else if (!anyHasBudget) reason = 'target_full';
      else if (!anyCanFit && pendingExclusionRejections.length === 0) reason = bucketRejectReason;
      else if (pendingExclusionRejections.length > 0 && !anyCanFit) reason = 'driver_excluded_by_note';
      else                    reason = 'driver_overlap';
      rejections.push({ blockId: block.blockId, reason, durationSec: block.blockDurationSec });
    }
  }

  // Driver summaries
  const driverSummaries: RegularDriverAssignmentSummary[] = [];
  for (const [id, s] of stateMap) {
    const ivs = s.intervals;
    let overlapCount = 0;
    for (let i = 0; i < ivs.length; i++) {
      for (let j = i + 1; j < ivs.length; j++) {
        if (ivs[i].startMs < ivs[j].endMs && ivs[j].startMs < ivs[i].endMs) overlapCount++;
      }
    }

    const totalTarget = s.target.targetTotalSec > 0 ? s.target.targetTotalSec : s.target.targetWorkSec;
    const remaining = Math.max(0, totalTarget - s.assignedSec);
    let status: RegularDriverAssignmentSummary['status'];
    if (totalTarget <= 0 || s.assignedSec === 0) {
      status = 'keine_zuteilung';
    } else if (s.assignedSec + 1 >= totalTarget) {
      status = 'ziel_erreicht';
    } else {
      status = 'unter_ziel';
    }

    driverSummaries.push({
      driverId: id,
      driverName: s.target.driverName,
      targetWorkSec: totalTarget,
      assignedWorkSec: s.assignedSec,
      remainingWorkSec: remaining,
      assignedBlockCount: assignments.filter(a => a.driverId === id).length,
      overlapCount,
      status,
      targetBaseSec1000:     s.target.targetBaseSec1000,
      targetNight25Sec1500:  s.target.targetNight25Sec1500,
      targetNight40Sec1501:  s.target.targetNight40Sec1501,
      targetSundaySec1510:   s.target.targetSundaySec1510,
      targetHolidaySec:      s.target.targetHolidaySec,
      assignedBaseSec1000:   s.assignedBase1000,
      assignedNight25Sec1500: s.assignedNight25,
      assignedNight40Sec1501: s.assignedNight40,
      assignedSundaySec1510: s.assignedSunday,
      assignedHolidaySec:    s.assignedHoliday,
    });
  }
  driverSummaries.sort((a, b) => a.driverName.localeCompare(b.driverName));

  // Surplus
  const surplusValidBlocks   = candidateBlocks.filter(b => !assignedIds.has(b.blockId));
  const surplusShortBlocks   = nonCandidateBlocks.filter(b => b.status === 'short');
  const surplusLongBlocks    = nonCandidateBlocks.filter(b => b.status === 'long');
  const surplusInvalidBlocks = nonCandidateBlocks.filter(b => b.status === 'invalid');
  const surplusBlocks = [...surplusValidBlocks, ...surplusShortBlocks, ...surplusLongBlocks, ...surplusInvalidBlocks];

  // Validation
  const allAssignedIds = new Set(assignments.map(a => a.blockId));
  const duplicateAssignedBlockCount = assignments.length - allAssignedIds.size;
  const nonCandidateIds = new Set(nonCandidateBlocks.map(b => b.blockId));
  let driverOverlapCount = 0;
  let targetOverrunCount = 0;
  let invalidRegularAssignmentCount = 0;
  let totalRejectedDueToRowDriverOverlap = 0;
  for (const s of driverSummaries) {
    driverOverlapCount += s.overlapCount;
    if (s.assignedWorkSec > s.targetWorkSec + 1) targetOverrunCount++;
  }
  for (const a of assignments) {
    if (nonCandidateIds.has(a.blockId)) invalidRegularAssignmentCount++;
  }
  for (const [, s] of stateMap) {
    totalRejectedDueToRowDriverOverlap += s.rejectedDueToRowDriverOverlap;
  }

  return {
    assignments,
    driverSummaries,
    surplusBlocks,
    surplusValidBlocks,
    surplusShortBlocks,
    surplusLongBlocks,
    surplusInvalidBlocks,
    validation: {
      assignedBlockCount: assignments.length,
      surplusBlockCount: surplusBlocks.length,
      duplicateAssignedBlockCount,
      driverOverlapCount,
      targetOverrunCount,
      invalidRegularAssignmentCount,
      rejectedDueToRowDriverOverlap: totalRejectedDueToRowDriverOverlap,
    },
    rejectedAssignments: rejections,
  };
}

// ── Phase 3: Inhaber surplus assignment ───────────────────────────────────────

export interface InhaberTarget {
  driverId: string;
  driverName: string;
}

export interface InhaberBlockAssignment {
  blockId: string;
  driverId: string;
  driverName: string;
  vehicle: string;
  startMs: number;
  endMs: number;
  durationSec: number;
  sourceRowIndices: (number | null)[];
  originalStatus: VehicleBlockStatus;
  needsTimeShift: boolean;
  assignmentType: 'owner_surplus_original_time_preview' | 'owner_surplus_needs_shift_preview';
}

export interface InhaberOverlapPair {
  blockAId: string;
  blockBId: string;
  vehicleA: string;
  vehicleB: string;
  startMsA: number;
  endMsA: number;
  startMsB: number;
  endMsB: number;
  overlapSec: number;
}

export interface InhaberAssignmentValidation {
  totalSurplusBlockCount: number;
  ownerOriginalTimeCount: number;
  ownerNeedsShiftCount: number;
  ownerInvalidOriginalDataCount: number;
  ownerOverlapPairCount: number;
  duplicateOwnerBlockCount: number;
  missingOwnerBlockCount: number;
  timeChangedCount: number;
  vehicleOverlapCount: number;
  ownerBlocksNeedingShiftDueToRowOverlap: number;
}

export interface InhaberAssignmentResult {
  inhaber: InhaberTarget | null;
  ownerOriginalTimeAssignments: InhaberBlockAssignment[];
  ownerNeedsShiftAssignments: InhaberBlockAssignment[];
  ownerInvalidOriginalDataBlocks: VehicleBlock[];
  ownerOverlapPairs: InhaberOverlapPair[];
  validation: InhaberAssignmentValidation;
  noInhaberWarning?: string;
}

export function assignSurplusBlocksToInhaberWithoutTimeChange(
  regularResult: RegularDriverAssignmentResult,
  inhaber: InhaberTarget | null,
  phase1Result?: BuildVehicleBlocksResult,
): InhaberAssignmentResult {
  const { surplusBlocks } = regularResult;

  if (!inhaber) {
    const totalSurplusBlockCount = surplusBlocks.length;
    const invalidCount = surplusBlocks.filter(b => b.status === 'invalid').length;
    return {
      inhaber: null,
      ownerOriginalTimeAssignments: [],
      ownerNeedsShiftAssignments: [],
      ownerInvalidOriginalDataBlocks: surplusBlocks.filter(b => b.status === 'invalid'),
      ownerOverlapPairs: [],
      validation: {
        totalSurplusBlockCount,
        ownerOriginalTimeCount: 0,
        ownerNeedsShiftCount: 0,
        ownerInvalidOriginalDataCount: invalidCount,
        ownerOverlapPairCount: 0,
        duplicateOwnerBlockCount: 0,
        missingOwnerBlockCount: totalSurplusBlockCount - invalidCount,
        timeChangedCount: 0,
        vehicleOverlapCount: 0,
        ownerBlocksNeedingShiftDueToRowOverlap: 0,
      },
      noInhaberWarning: 'Kein Inhaber/Ausgleichsfahrer ausgewählt.',
    };
  }

  // Build ride lookup from phase1 blocks for accurate per-ride interval checks
  const ridesByBlockId = new Map<string, VehicleBlockRide[]>();
  if (phase1Result) {
    for (const block of phase1Result.blocks) {
      ridesByBlockId.set(block.blockId, block.rides);
    }
  }

  // Build vehicle occupancy from regular driver assignments (ride-level)
  // This prevents placing Inhaber blocks at times that would create vehicle overlaps
  // with already-assigned regular driver blocks.
  type OccInterval = { startMs: number; endMs: number; blockId: string };
  const regularVehicleOccupied = new Map<string, OccInterval[]>(); // vehicle → ride intervals
  for (const a of regularResult.assignments) {
    const rides = ridesByBlockId.get(a.blockId);
    const intervals: OccInterval[] = rides && rides.length > 0
      ? rides.map(r => ({ startMs: r.originalStartMs, endMs: r.originalEndMs, blockId: a.blockId }))
      : [{ startMs: a.startMs, endMs: a.endMs, blockId: a.blockId }];
    if (!regularVehicleOccupied.has(a.vehicle)) regularVehicleOccupied.set(a.vehicle, []);
    regularVehicleOccupied.get(a.vehicle)!.push(...intervals);
  }

  // Sort: startMs asc, durationSec desc, blockId asc
  const sorted = [...surplusBlocks].sort((a, b) => {
    if (a.blockStartMs !== b.blockStartMs) return a.blockStartMs - b.blockStartMs;
    if (b.blockDurationSec !== a.blockDurationSec) return b.blockDurationSec - a.blockDurationSec;
    return a.blockId.localeCompare(b.blockId);
  });

  const ownerOriginalTimeAssignments: InhaberBlockAssignment[] = [];
  const ownerNeedsShiftAssignments: InhaberBlockAssignment[] = [];
  const ownerInvalidOriginalDataBlocks: VehicleBlock[] = [];

  // Ride-level intervals for already-placed (original-time) Inhaber blocks.
  // Used for driver-level overlap detection in subsequent blocks.
  const inhaberPlacedRides: OccInterval[] = [];
  // Vehicle-level occupancy: includes regular drivers + already-placed Inhaber blocks
  // Used for vehicle-level overlap detection when placing each new Inhaber block.
  const inhaberVehicleOccupied = new Map<string, OccInterval[]>(); // vehicle → ride intervals
  // Pre-populate with regular driver occupancy
  for (const [vehicle, ivs] of regularVehicleOccupied) {
    inhaberVehicleOccupied.set(vehicle, [...ivs]);
  }

  let ownerBlocksNeedingShiftDueToRowOverlap = 0;

  for (const block of sorted) {
    if (block.status === 'invalid') {
      ownerInvalidOriginalDataBlocks.push(block);
      continue;
    }

    const blockRides = ridesByBlockId.get(block.blockId) ?? [];
    const vehicleIvs = inhaberVehicleOccupied.get(block.vehicle) ?? [];

    // Row-level overlap check 1: driver overlap — any ride in this block overlaps any
    // already-placed Inhaber ride (same driver check).
    const driverOverlap = blockRides.length > 0
      ? blockRides.some(ride =>
          inhaberPlacedRides.some(p => p.startMs < ride.originalEndMs && ride.originalStartMs < p.endMs)
        )
      : block.rides.some(ride =>
          inhaberPlacedRides.some(p => p.startMs < ride.originalEndMs && ride.originalStartMs < p.endMs)
        );

    // Row-level overlap check 2: vehicle overlap — any ride in this block overlaps any
    // regular-driver or already-placed Inhaber ride on the SAME vehicle.
    const vehicleOverlap = blockRides.length > 0
      ? blockRides.some(ride =>
          vehicleIvs.some(p => p.startMs < ride.originalEndMs && ride.originalStartMs < p.endMs)
        )
      : vehicleIvs.some(p =>
          p.startMs < block.blockEndMs && block.blockStartMs < p.endMs
        );

    const overlaps = driverOverlap || vehicleOverlap;

    if (import.meta.env.DEV && overlaps) {
      console.log('[PermanentFahrtenbuchOverlapFix] Phase3 block flagged needs-shift:', {
        blockId: block.blockId, vehicle: block.vehicle,
        driverOverlap, vehicleOverlap,
        rideCount: blockRides.length,
      });
    }

    const assignment: InhaberBlockAssignment = {
      blockId: block.blockId,
      driverId: inhaber.driverId,
      driverName: inhaber.driverName,
      vehicle: block.vehicle,
      startMs: block.blockStartMs,
      endMs: block.blockEndMs,
      durationSec: block.blockDurationSec,
      sourceRowIndices: block.rides.map(r => r.sourceRowIndex),
      originalStatus: block.status,
      needsTimeShift: overlaps,
      assignmentType: overlaps
        ? 'owner_surplus_needs_shift_preview'
        : 'owner_surplus_original_time_preview',
    };

    if (overlaps) {
      ownerNeedsShiftAssignments.push(assignment);
      ownerBlocksNeedingShiftDueToRowOverlap++;
      // Do NOT add to occupancy maps — this block will be shifted later.
      // Phase 4 will add the shifted intervals after finding a clean slot.
    } else {
      ownerOriginalTimeAssignments.push(assignment);
      // Add placed rides to both occupancy maps so future blocks see them.
      const rideIvsToAdd: OccInterval[] = blockRides.length > 0
        ? blockRides.map(r => ({ startMs: r.originalStartMs, endMs: r.originalEndMs, blockId: block.blockId }))
        : [{ startMs: block.blockStartMs, endMs: block.blockEndMs, blockId: block.blockId }];
      inhaberPlacedRides.push(...rideIvsToAdd);
      if (!inhaberVehicleOccupied.has(block.vehicle)) inhaberVehicleOccupied.set(block.vehicle, []);
      inhaberVehicleOccupied.get(block.vehicle)!.push(...rideIvsToAdd);
    }
  }

  // Compute ownerOverlapPairs across ALL non-invalid placed blocks
  const allNonInvalid = [...ownerOriginalTimeAssignments, ...ownerNeedsShiftAssignments];
  const ownerOverlapPairs: InhaberOverlapPair[] = [];
  for (let i = 0; i < allNonInvalid.length; i++) {
    for (let j = i + 1; j < allNonInvalid.length; j++) {
      const a = allNonInvalid[i];
      const b = allNonInvalid[j];
      if (a.startMs < b.endMs && b.startMs < a.endMs) {
        const overlapMs = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
        ownerOverlapPairs.push({
          blockAId: a.blockId,
          blockBId: b.blockId,
          vehicleA: a.vehicle,
          vehicleB: b.vehicle,
          startMsA: a.startMs,
          endMsA: a.endMs,
          startMsB: b.startMs,
          endMsB: b.endMs,
          overlapSec: Math.round(overlapMs / 1000),
        });
      }
    }
  }

  // vehicleOverlapCount = pairs where vehicleA === vehicleB
  const vehicleOverlapCount = ownerOverlapPairs.filter(p => p.vehicleA === p.vehicleB).length;

  // Validation: duplicate / missing owner blocks
  const allOwnerBlockIds = new Set([
    ...ownerOriginalTimeAssignments.map(a => a.blockId),
    ...ownerNeedsShiftAssignments.map(a => a.blockId),
    ...ownerInvalidOriginalDataBlocks.map(b => b.blockId),
  ]);
  const allSurplusIds = new Set(surplusBlocks.map(b => b.blockId));
  const duplicateOwnerBlockCount =
    ownerOriginalTimeAssignments.length +
    ownerNeedsShiftAssignments.length +
    ownerInvalidOriginalDataBlocks.length -
    allOwnerBlockIds.size;
  const missingOwnerBlockCount = [...allSurplusIds].filter(id => !allOwnerBlockIds.has(id)).length;

  // timeChangedCount is always 0 — this function never shifts times
  const timeChangedCount = 0;

  return {
    inhaber,
    ownerOriginalTimeAssignments,
    ownerNeedsShiftAssignments,
    ownerInvalidOriginalDataBlocks,
    ownerOverlapPairs,
    validation: {
      totalSurplusBlockCount: surplusBlocks.length,
      ownerOriginalTimeCount: ownerOriginalTimeAssignments.length,
      ownerNeedsShiftCount: ownerNeedsShiftAssignments.length,
      ownerInvalidOriginalDataCount: ownerInvalidOriginalDataBlocks.length,
      ownerOverlapPairCount: ownerOverlapPairs.length,
      duplicateOwnerBlockCount,
      missingOwnerBlockCount,
      timeChangedCount,
      vehicleOverlapCount,
      ownerBlocksNeedingShiftDueToRowOverlap,
    },
  };
}

// ── Phase 4: Shift overlapping Inhaber blocks ─────────────────────────────────

export interface OwnerShiftOptions {
  month: number;  // 1-12
  year: number;
  slotIncrementMinutes?: number;  // default 15
  preferSameDay?: boolean;        // default true
  preserveOriginalSeconds?: boolean; // default true
  searchWholeMonth?: boolean;     // default true
}

export interface OwnerShiftSlotCandidate {
  finalStartMs: number;
  finalEndMs: number;
  offsetSec: number;
  sameDay: boolean;
  absOffsetMs: number;
  isDaytime: boolean; // start hour 8-20
}

export interface OwnerShiftedBlockAssignment {
  blockId: string;
  driverId: string;
  driverName: string;
  vehicle: string;
  originalStartMs: number;
  originalEndMs: number;
  finalStartMs: number;
  finalEndMs: number;
  durationSec: number;
  offsetSec: number;
  sourceRowIndices: (number | null)[];
  assignmentType: 'owner_surplus_shifted_preview';
  timeChanged: true;
}

export interface OwnerShiftNoSlotBlock {
  blockId: string;
  driverId: string;
  driverName: string;
  vehicle: string;
  originalStartMs: number;
  originalEndMs: number;
  durationSec: number;
  sourceRowIndices: (number | null)[];
  reason: string;
  attemptedSlotCount: number;
}

export interface OwnerShiftValidation {
  needsShiftCount: number;
  shiftedCount: number;
  noSlotCount: number;
  timeChangedCount: number;
  durationChangedCount: number;
  remainingOwnerOverlapCount: number;
  remainingVehicleOverlapCount: number;
  duplicateShiftedBlockCount: number;
  missingShiftedBlockCount: number;
  outsideMonthCount: number;
  zeroOffsetShiftCount: number;
  rejectedShiftSlotsDueToRowDriverOverlap: number;
  rejectedShiftSlotsDueToRowVehicleOverlap: number;
  remainingFinalDriverRowOverlaps: number;
  remainingFinalVehicleRowOverlaps: number;
}

export interface OwnerShiftResult {
  shiftedAssignments: OwnerShiftedBlockAssignment[];
  noSlotBlocks: OwnerShiftNoSlotBlock[];
  validation: OwnerShiftValidation;
  candidateSummary: { blockId: string; candidatesTried: number; found: boolean }[];
}

// Half-open interval overlap: aStart < bEnd && bStart < aEnd
function overlapsHalfOpen(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function shiftOverlappingInhaberBlocks(
  phase1Result: BuildVehicleBlocksResult,
  regularAssignmentResult: RegularDriverAssignmentResult,
  inhaberAssignmentResult: InhaberAssignmentResult,
  options: OwnerShiftOptions,
): OwnerShiftResult {
  const slotIncrementMs = (options.slotIncrementMinutes ?? 15) * 60 * 1000;
  const { month, year } = options;

  // Month window: local midnight boundaries to match local-time block timestamps
  const monthStart      = new Date(year, month - 1, 1,  0, 0, 0, 0).getTime();
  const nextMonthStart  = new Date(year, month,     1,  0, 0, 0, 0).getTime();

  // Blocks to shift
  const toShift = [...inhaberAssignmentResult.ownerNeedsShiftAssignments].sort((a, b) => {
    if (b.durationSec !== a.durationSec) return b.durationSec - a.durationSec;
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    return a.blockId.localeCompare(b.blockId);
  });

  // Build ride lookup from original VehicleBlocks for row-level overlap checks
  const ridesByBlockId = new Map<string, VehicleBlockRide[]>();
  for (const block of phase1Result.blocks) {
    ridesByBlockId.set(block.blockId, block.rides);
  }

  // Mutable occupancy sets using ride-level intervals
  type Interval = { startMs: number; endMs: number; blockId: string; vehicle: string };

  // Owner occupancy (ride-level): original-time Inhaber ride intervals
  const ownerOccupied: Interval[] = inhaberAssignmentResult.ownerOriginalTimeAssignments.flatMap(a => {
    const rides = ridesByBlockId.get(a.blockId);
    if (!rides) return [{ startMs: a.startMs, endMs: a.endMs, blockId: a.blockId, vehicle: a.vehicle }];
    return rides.map(r => ({ startMs: r.originalStartMs, endMs: r.originalEndMs, blockId: a.blockId, vehicle: a.vehicle }));
  });

  // Vehicle occupancy (ride-level): regular assignments + owner original-time + owner invalid
  const vehicleOccupied: Interval[] = [
    ...regularAssignmentResult.assignments.flatMap(a => {
      const rides = ridesByBlockId.get(a.blockId);
      if (!rides) return [{ startMs: a.startMs, endMs: a.endMs, blockId: a.blockId, vehicle: a.vehicle }];
      return rides.map(r => ({ startMs: r.originalStartMs, endMs: r.originalEndMs, blockId: a.blockId, vehicle: a.vehicle }));
    }),
    ...inhaberAssignmentResult.ownerOriginalTimeAssignments.flatMap(a => {
      const rides = ridesByBlockId.get(a.blockId);
      if (!rides) return [{ startMs: a.startMs, endMs: a.endMs, blockId: a.blockId, vehicle: a.vehicle }];
      return rides.map(r => ({ startMs: r.originalStartMs, endMs: r.originalEndMs, blockId: a.blockId, vehicle: a.vehicle }));
    }),
    ...inhaberAssignmentResult.ownerInvalidOriginalDataBlocks
      .filter(b => b.blockStartMs > 0 && b.blockEndMs > 0)
      .map(b => ({
        startMs: b.blockStartMs, endMs: b.blockEndMs, blockId: b.blockId, vehicle: b.vehicle,
      })),
  ];

  const shiftedAssignments: OwnerShiftedBlockAssignment[] = [];
  const noSlotBlocks: OwnerShiftNoSlotBlock[] = [];
  const candidateSummary: { blockId: string; candidatesTried: number; found: boolean }[] = [];
  let rejectedShiftSlotsDueToRowDriverOverlap = 0;
  let rejectedShiftSlotsDueToRowVehicleOverlap = 0;

  for (const block of toShift) {
    const durationMs = block.endMs - block.startMs;
    const durationSec = block.durationSec;
    const vehicle = block.vehicle;

    // Original seconds/ms within the minute to preserve (local seconds/ms are fine for sub-minute precision)
    const originalDate = new Date(block.startMs);
    const originalSec = originalDate.getSeconds();
    const originalMs  = originalDate.getMilliseconds();
    const subMinuteMs = originalSec * 1000 + originalMs; // offset within 15-min slot

    // Build candidate slot starts:
    // For each 15-min grid tick in the month, add the sub-minute offset

    // Original day (local wall-clock time)
    const origDateLocal = new Date(block.startMs);
    const origDayStart = new Date(origDateLocal.getFullYear(), origDateLocal.getMonth(), origDateLocal.getDate(), 0, 0, 0, 0).getTime();
    const origDayEnd   = origDayStart + 24 * 60 * 60 * 1000;

    // We will try same-day slots first, then rest of month
    // Build candidate list lazily to avoid huge arrays
    const makeCandidates = function*(): Generator<OwnerShiftSlotCandidate> {
      // Two passes: same day, then rest of month
      for (const sameDayPass of [true, false]) {
        // Start of search: for same-day pass, start at origDayStart; for rest, start at monthStart
        let gridStart = sameDayPass ? origDayStart : monthStart;
        const gridEnd = sameDayPass ? origDayEnd : nextMonthStart;

        // Align gridStart to nearest 15-min boundary before adding sub-minute offset
        // Actually: iterate through all 15-min boundary starts in the range
        // candidate = boundary + subMinuteMs
        let boundary = gridStart;
        while (boundary < gridEnd) {
          const candidateStart = boundary + subMinuteMs;
          const candidateEnd   = candidateStart + durationMs;

          // Skip if already in same-day pass and this is a same-day slot (avoid re-emitting in second pass)
          if (!sameDayPass && candidateStart >= origDayStart && candidateStart < origDayEnd) {
            boundary += slotIncrementMs;
            continue;
          }

          // Must be within month
          if (candidateStart >= monthStart && candidateEnd <= nextMonthStart) {
            const startHour = new Date(candidateStart).getHours();
            yield {
              finalStartMs: candidateStart,
              finalEndMs: candidateEnd,
              offsetSec: Math.round((candidateStart - block.startMs) / 1000),
              sameDay: sameDayPass,
              absOffsetMs: Math.abs(candidateStart - block.startMs),
              isDaytime: startHour >= 8 && startHour < 20,
            };
          }
          boundary += slotIncrementMs;
        }
      }
    };

    // Filter occupied intervals for this vehicle (excluding the block's own rides)
    const vehicleOccForVehicle = vehicleOccupied.filter(
      iv => iv.vehicle === vehicle && iv.blockId !== block.blockId
    );
    const ownerOccForCheck = ownerOccupied.filter(iv => iv.blockId !== block.blockId);

    // Get individual rides for row-level checking (fall back to block envelope if not found)
    const blockRides = ridesByBlockId.get(block.blockId);

    let bestCandidate: OwnerShiftSlotCandidate | null = null;
    let tried = 0;

    for (const cand of makeCandidates()) {
      tried++;
      const offsetMs = cand.finalStartMs - block.startMs;

      // Row-level vehicle overlap check: each shifted ride must not overlap any vehicle interval
      let vehicleConflict = false;
      if (blockRides && blockRides.length > 0) {
        for (const ride of blockRides) {
          const rideStart = ride.originalStartMs + offsetMs;
          const rideEnd   = ride.originalEndMs   + offsetMs;
          if (vehicleOccForVehicle.some(iv => iv.startMs < rideEnd && rideStart < iv.endMs)) {
            vehicleConflict = true;
            break;
          }
        }
      } else {
        vehicleConflict = vehicleOccForVehicle.some(
          iv => overlapsHalfOpen(cand.finalStartMs, cand.finalEndMs, iv.startMs, iv.endMs)
        );
      }
      if (vehicleConflict) {
        rejectedShiftSlotsDueToRowVehicleOverlap++;
        continue;
      }

      // Row-level owner overlap check: each shifted ride must not overlap any owner interval
      let ownerConflict = false;
      if (blockRides && blockRides.length > 0) {
        for (const ride of blockRides) {
          const rideStart = ride.originalStartMs + offsetMs;
          const rideEnd   = ride.originalEndMs   + offsetMs;
          if (ownerOccForCheck.some(iv => iv.startMs < rideEnd && rideStart < iv.endMs)) {
            ownerConflict = true;
            break;
          }
        }
      } else {
        ownerConflict = ownerOccForCheck.some(
          iv => overlapsHalfOpen(cand.finalStartMs, cand.finalEndMs, iv.startMs, iv.endMs)
        );
      }
      if (ownerConflict) {
        rejectedShiftSlotsDueToRowDriverOverlap++;
        continue;
      }

      // Must have non-zero offset
      if (cand.offsetSec === 0) continue;

      // Valid — rank: sameDay > smallerAbsOffset > daytime > earlier finalStart
      if (!bestCandidate) {
        bestCandidate = cand;
        continue;
      }
      // Prefer same day
      if (cand.sameDay && !bestCandidate.sameDay) { bestCandidate = cand; continue; }
      if (!cand.sameDay && bestCandidate.sameDay) continue;
      // Within same sameDay group: smaller abs offset
      if (cand.absOffsetMs < bestCandidate.absOffsetMs) { bestCandidate = cand; continue; }
      if (cand.absOffsetMs > bestCandidate.absOffsetMs) continue;
      // Daytime preferred
      if (cand.isDaytime && !bestCandidate.isDaytime) { bestCandidate = cand; continue; }
      if (!cand.isDaytime && bestCandidate.isDaytime) continue;
      // Earlier start
      if (cand.finalStartMs < bestCandidate.finalStartMs) { bestCandidate = cand; }
    }

    candidateSummary.push({ blockId: block.blockId, candidatesTried: tried, found: bestCandidate !== null });

    if (bestCandidate) {
      const shifted: OwnerShiftedBlockAssignment = {
        blockId: block.blockId,
        driverId: block.driverId,
        driverName: block.driverName,
        vehicle: block.vehicle,
        originalStartMs: block.startMs,
        originalEndMs: block.endMs,
        finalStartMs: bestCandidate.finalStartMs,
        finalEndMs: bestCandidate.finalEndMs,
        durationSec,
        offsetSec: bestCandidate.offsetSec,
        sourceRowIndices: block.sourceRowIndices,
        assignmentType: 'owner_surplus_shifted_preview',
        timeChanged: true,
      };
      shiftedAssignments.push(shifted);

      // Add shifted ride intervals to occupancy for future iterations
      const offsetMs = bestCandidate.finalStartMs - block.startMs;
      const rides = ridesByBlockId.get(block.blockId);
      if (rides && rides.length > 0) {
        for (const ride of rides) {
          const rideStart = ride.originalStartMs + offsetMs;
          const rideEnd   = ride.originalEndMs   + offsetMs;
          ownerOccupied.push({ startMs: rideStart, endMs: rideEnd, blockId: block.blockId, vehicle: block.vehicle });
          vehicleOccupied.push({ startMs: rideStart, endMs: rideEnd, blockId: block.blockId, vehicle: block.vehicle });
        }
      } else {
        ownerOccupied.push({ startMs: bestCandidate.finalStartMs, endMs: bestCandidate.finalEndMs, blockId: block.blockId, vehicle: block.vehicle });
        vehicleOccupied.push({ startMs: bestCandidate.finalStartMs, endMs: bestCandidate.finalEndMs, blockId: block.blockId, vehicle: block.vehicle });
      }
    } else {
      noSlotBlocks.push({
        blockId: block.blockId,
        driverId: block.driverId,
        driverName: block.driverName,
        vehicle: block.vehicle,
        originalStartMs: block.startMs,
        originalEndMs: block.endMs,
        durationSec,
        sourceRowIndices: block.sourceRowIndices,
        reason: 'Kein freier Slot im Monat gefunden.',
        attemptedSlotCount: tried,
      });
    }
  }

  // ── Post-shift validation ──────────────────────────────────────────────────

  // Remaining owner overlaps: combine original-time + shifted
  const allOwnerFinal = [
    ...inhaberAssignmentResult.ownerOriginalTimeAssignments.map(a => ({ startMs: a.startMs, endMs: a.endMs, blockId: a.blockId })),
    ...shiftedAssignments.map(a => ({ startMs: a.finalStartMs, endMs: a.finalEndMs, blockId: a.blockId })),
  ];
  let remainingOwnerOverlapCount = 0;
  for (let i = 0; i < allOwnerFinal.length; i++) {
    for (let j = i + 1; j < allOwnerFinal.length; j++) {
      if (overlapsHalfOpen(allOwnerFinal[i].startMs, allOwnerFinal[i].endMs, allOwnerFinal[j].startMs, allOwnerFinal[j].endMs)) {
        remainingOwnerOverlapCount++;
      }
    }
  }

  // Remaining vehicle overlaps: regular + owner-original + shifted
  type VehInterval = { startMs: number; endMs: number; blockId: string; vehicle: string };
  const allVehicleFinal: VehInterval[] = [
    ...regularAssignmentResult.assignments.map(a => ({ startMs: a.startMs, endMs: a.endMs, blockId: a.blockId, vehicle: a.vehicle })),
    ...inhaberAssignmentResult.ownerOriginalTimeAssignments.map(a => ({ startMs: a.startMs, endMs: a.endMs, blockId: a.blockId, vehicle: a.vehicle })),
    ...shiftedAssignments.map(a => ({ startMs: a.finalStartMs, endMs: a.finalEndMs, blockId: a.blockId, vehicle: a.vehicle })),
  ];
  let remainingVehicleOverlapCount = 0;
  for (let i = 0; i < allVehicleFinal.length; i++) {
    for (let j = i + 1; j < allVehicleFinal.length; j++) {
      if (
        allVehicleFinal[i].vehicle === allVehicleFinal[j].vehicle &&
        overlapsHalfOpen(allVehicleFinal[i].startMs, allVehicleFinal[i].endMs, allVehicleFinal[j].startMs, allVehicleFinal[j].endMs)
      ) {
        remainingVehicleOverlapCount++;
      }
    }
  }

  // Duplicate / missing shifted blocks
  const shiftedIds = new Set(shiftedAssignments.map(a => a.blockId));
  const needsShiftIds = new Set(toShift.map(b => b.blockId));
  const noSlotIds = new Set(noSlotBlocks.map(b => b.blockId));
  const duplicateShiftedBlockCount = shiftedAssignments.length - shiftedIds.size;
  const missingShiftedBlockCount = [...needsShiftIds].filter(id => !shiftedIds.has(id) && !noSlotIds.has(id)).length;

  const outsideMonthCount = shiftedAssignments.filter(
    a => a.finalStartMs < monthStart || a.finalEndMs > nextMonthStart
  ).length;
  const zeroOffsetShiftCount = shiftedAssignments.filter(a => a.offsetSec === 0).length;
  const durationChangedCount = shiftedAssignments.filter(
    a => (a.finalEndMs - a.finalStartMs) !== (a.originalEndMs - a.originalStartMs)
  ).length;

  return {
    shiftedAssignments,
    noSlotBlocks,
    validation: {
      needsShiftCount: toShift.length,
      shiftedCount: shiftedAssignments.length,
      noSlotCount: noSlotBlocks.length,
      timeChangedCount: shiftedAssignments.length,
      durationChangedCount,
      remainingOwnerOverlapCount,
      remainingVehicleOverlapCount,
      duplicateShiftedBlockCount,
      missingShiftedBlockCount,
      outsideMonthCount,
      zeroOffsetShiftCount,
      rejectedShiftSlotsDueToRowDriverOverlap,
      rejectedShiftSlotsDueToRowVehicleOverlap,
      remainingFinalDriverRowOverlaps: remainingOwnerOverlapCount,
      remainingFinalVehicleRowOverlaps: remainingVehicleOverlapCount,
    },
    candidateSummary,
  };
}

// ── Phase 5: Final block assignment snapshot ──────────────────────────────────

export type FinalDriverRole = 'regular' | 'inhaber' | 'unassigned' | 'invalid_original';
export type FinalAssignmentType =
  | 'regular_block_assignment'
  | 'owner_surplus_assignment'
  | 'owner_overflow_time_shift'
  | 'invalid_original_block'
  | 'unassigned';

export interface FinalBlockAssignmentRow {
  sourceRowIndex: number | null;
  tripId: string;
  blockId: string | null;
  vehicle: string;
  originalDriverName: string | null;
  originalStartMs: number;
  originalEndMs: number;
  originalStartDatetime: string;
  originalEndDatetime: string;
  finalStartMs: number;
  finalEndMs: number;
  finalStartDatetime: string;
  finalEndDatetime: string;
  finalDriverId: string | null;
  finalDriverName: string | null;
  finalDriverRole: FinalDriverRole;
  assignmentType: FinalAssignmentType;
  timeChanged: boolean;
  offsetSec: number;
  durationSecOriginal: number;
  durationSecFinal: number;
  durationChanged: boolean;
  isExportable: boolean;
  validationReason: string | null;
  rawTrip: FahrtenbuchTrip;
}

export interface FinalBlockAssignmentSnapshotValidation {
  totalConsideredRides: number;
  snapshotRows: number;
  uniqueTripCount: number;
  duplicateTripCount: number;
  missingTripCount: number;
  unassignedRowCount: number;
  invalidOriginalRowCount: number;
  regularRowCount: number;
  inhaberOriginalRowCount: number;
  inhaberShiftedRowCount: number;
  timeChangedRowCount: number;
  durationChangedRowCount: number;
  outsideMonthRowCount: number;
  appCreatedOutsideMonthRowCount: number;
  originalCrossMonthRowCount: number;
  missingFinalDriverCount: number;
  invalidDatetimeCount: number;
}

export interface FinalBlockAssignmentSnapshotResult {
  rows: FinalBlockAssignmentRow[];
  validation: FinalBlockAssignmentSnapshotValidation;
  duplicateTripIds: string[];
  missingTripIds: string[];
  unassignedRows: FinalBlockAssignmentRow[];
  originalCrossMonthRows: FinalBlockAssignmentRow[];
}

export interface FinalSnapshotOptions {
  month: number;
  year: number;
}

// Format ms timestamp as "YYYY-MM-DD HH:mm:ss.SSS" using local (wall-clock) time.
// The source datetimes were parsed from local-time strings, so we must NOT use UTC getters.
function formatSnapshotDatetime(ms: number): string {
  if (!ms || ms <= 0) return '';
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const Y   = d.getFullYear();
  const M   = pad(d.getMonth() + 1);
  const D   = pad(d.getDate());
  const h   = pad(d.getHours());
  const mi  = pad(d.getMinutes());
  const s   = pad(d.getSeconds());
  const ms3 = pad(d.getMilliseconds(), 3);
  return `${Y}-${M}-${D} ${h}:${mi}:${s}.${ms3}`;
}

export function buildFinalBlockAssignmentSnapshot(
  phase1Result: BuildVehicleBlocksResult,
  regularAssignmentResult: RegularDriverAssignmentResult,
  inhaberAssignmentResult: InhaberAssignmentResult,
  shiftResult: OwnerShiftResult,
  options: FinalSnapshotOptions,
): FinalBlockAssignmentSnapshotResult {
  const { month, year } = options;
  const monthStart     = new Date(year, month - 1, 1, 0, 0, 0, 0).getTime();
  const nextMonthStart = new Date(year, month,     1, 0, 0, 0, 0).getTime();

  // Build lookup maps
  // tripId → CleanHistoricalRide
  const rideByTripId = new Map<string, CleanHistoricalRide>();
  for (const r of phase1Result.normalizedRides) {
    rideByTripId.set(r.tripId, r);
  }

  // blockId → VehicleBlock
  const blockById = new Map<string, VehicleBlock>();
  for (const b of phase1Result.blocks) {
    blockById.set(b.blockId, b);
  }

  // blockId → RegularBlockAssignment
  const regularByBlockId = new Map<string, RegularBlockAssignment>();
  for (const a of regularAssignmentResult.assignments) {
    regularByBlockId.set(a.blockId, a);
  }

  // blockId → InhaberBlockAssignment (original-time)
  const inhaberOrigByBlockId = new Map<string, InhaberBlockAssignment>();
  for (const a of inhaberAssignmentResult.ownerOriginalTimeAssignments) {
    inhaberOrigByBlockId.set(a.blockId, a);
  }

  // blockId → OwnerShiftedBlockAssignment
  const shiftedByBlockId = new Map<string, OwnerShiftedBlockAssignment>();
  for (const a of shiftResult.shiftedAssignments) {
    shiftedByBlockId.set(a.blockId, a);
  }

  // blockId → VehicleBlock (invalid original)
  const invalidBlockIds = new Set<string>(inhaberAssignmentResult.ownerInvalidOriginalDataBlocks.map(b => b.blockId));

  // Track which tripIds have been assigned
  const assignedTripIds = new Set<string>();
  const rows: FinalBlockAssignmentRow[] = [];

  // Helper: build a row from a ride + assignment info
  const buildRow = (
    ride: CleanHistoricalRide,
    blockId: string | null,
    finalDriverId: string | null,
    finalDriverName: string | null,
    finalDriverRole: FinalDriverRole,
    assignmentType: FinalAssignmentType,
    finalStartMs: number,
    finalEndMs: number,
    isExportable: boolean,
    validationReason: string | null,
  ): FinalBlockAssignmentRow => {
    const durationSecOriginal = ride.durationSec;
    const durationSecFinal = finalStartMs > 0 && finalEndMs > 0
      ? Math.round((finalEndMs - finalStartMs) / 1000)
      : durationSecOriginal;
    const offsetSec = Math.round((finalStartMs - ride.originalStartMs) / 1000);
    const timeChanged = offsetSec !== 0;
    const durationChanged = durationSecFinal !== durationSecOriginal;
    return {
      sourceRowIndex: ride.sourceRowIndex,
      tripId: ride.tripId,
      blockId,
      vehicle: ride.vehicle,
      originalDriverName: ride.originalDriverName,
      originalStartMs: ride.originalStartMs,
      originalEndMs: ride.originalEndMs,
      originalStartDatetime: ride.originalStartDatetime,
      originalEndDatetime: ride.originalEndDatetime,
      finalStartMs,
      finalEndMs,
      finalStartDatetime: formatSnapshotDatetime(finalStartMs),
      finalEndDatetime: formatSnapshotDatetime(finalEndMs),
      finalDriverId,
      finalDriverName,
      finalDriverRole,
      assignmentType,
      timeChanged,
      offsetSec,
      durationSecOriginal,
      durationSecFinal,
      durationChanged,
      isExportable,
      validationReason,
      rawTrip: ride.rawTrip,
    };
  };

  // 1. Regular assignments
  for (const a of regularAssignmentResult.assignments) {
    const block = blockById.get(a.blockId);
    if (!block) continue;
    for (const ride of block.rides) {
      const fullRide = rideByTripId.get(ride.tripId);
      if (!fullRide) continue;
      rows.push(buildRow(
        fullRide, a.blockId,
        a.driverId, a.driverName,
        'regular', 'regular_block_assignment',
        fullRide.originalStartMs, fullRide.originalEndMs,
        true, null,
      ));
      assignedTripIds.add(ride.tripId);
    }
  }

  // 2. Inhaber original-time assignments
  for (const a of inhaberAssignmentResult.ownerOriginalTimeAssignments) {
    const block = blockById.get(a.blockId);
    if (!block) continue;
    for (const ride of block.rides) {
      if (assignedTripIds.has(ride.tripId)) continue;
      const fullRide = rideByTripId.get(ride.tripId);
      if (!fullRide) continue;
      rows.push(buildRow(
        fullRide, a.blockId,
        a.driverId, a.driverName,
        'inhaber', 'owner_surplus_assignment',
        fullRide.originalStartMs, fullRide.originalEndMs,
        true, null,
      ));
      assignedTripIds.add(ride.tripId);
    }
  }

  // 3. Inhaber shifted assignments — apply per-ride offset
  for (const a of shiftResult.shiftedAssignments) {
    const block = blockById.get(a.blockId);
    if (!block) continue;
    const offsetMs = a.offsetSec * 1000;
    for (const ride of block.rides) {
      if (assignedTripIds.has(ride.tripId)) continue;
      const fullRide = rideByTripId.get(ride.tripId);
      if (!fullRide) continue;
      const finalStartMs = fullRide.originalStartMs + offsetMs;
      const finalEndMs   = fullRide.originalEndMs   + offsetMs;
      rows.push(buildRow(
        fullRide, a.blockId,
        a.driverId, a.driverName,
        'inhaber', 'owner_overflow_time_shift',
        finalStartMs, finalEndMs,
        true, null,
      ));
      assignedTripIds.add(ride.tripId);
    }
  }

  // 4. Invalid original blocks
  for (const block of inhaberAssignmentResult.ownerInvalidOriginalDataBlocks) {
    for (const ride of block.rides) {
      if (assignedTripIds.has(ride.tripId)) continue;
      const fullRide = rideByTripId.get(ride.tripId);
      if (!fullRide) continue;
      rows.push(buildRow(
        fullRide, block.blockId,
        null, null,
        'invalid_original', 'invalid_original_block',
        fullRide.originalStartMs, fullRide.originalEndMs,
        false, 'Originaldaten-Warnung / ungültiger Block',
      ));
      assignedTripIds.add(ride.tripId);
    }
  }

  // 5. Unassigned fallback — any considered ride not yet covered
  for (const ride of phase1Result.normalizedRides) {
    if (assignedTripIds.has(ride.tripId)) continue;
    rows.push(buildRow(
      ride, null,
      null, null,
      'unassigned', 'unassigned',
      ride.originalStartMs, ride.originalEndMs,
      false, 'Nicht zugeordnet',
    ));
    assignedTripIds.add(ride.tripId);
  }

  // ── Validation ───────────────────────────────────────────────────────────────

  const allTripIds = phase1Result.normalizedRides.map(r => r.tripId);
  const allTripIdSet = new Set(allTripIds);
  const snapshotTripIds = rows.map(r => r.tripId);
  const snapshotTripIdSet = new Set(snapshotTripIds);

  // Duplicates in snapshot
  const tripIdCount = new Map<string, number>();
  for (const tid of snapshotTripIds) tripIdCount.set(tid, (tripIdCount.get(tid) ?? 0) + 1);
  const duplicateTripIds = [...tripIdCount.entries()].filter(([, c]) => c > 1).map(([id]) => id);

  // Missing from snapshot
  const missingTripIds = allTripIds.filter(id => !snapshotTripIdSet.has(id));

  const unassignedRows = rows.filter(r => r.assignmentType === 'unassigned');

  // Rows where the app shifted a block outside the month window (blocking error)
  const appCreatedOutsideMonthRows = rows.filter(
    r => r.timeChanged && r.finalStartMs > 0 && (r.finalStartMs < monthStart || r.finalEndMs > nextMonthStart)
  );
  // Original cross-month rows: not time-changed but final timestamps cross the boundary
  // (e.g. a block starting on 28 Feb ending on 01 Mar — this comes from source data)
  const originalCrossMonthRows = rows.filter(
    r => !r.timeChanged && r.finalStartMs > 0 && (r.finalStartMs < monthStart || r.finalEndMs > nextMonthStart)
  );
  // Keep combined for backward compat
  const outsideMonthRows = [...appCreatedOutsideMonthRows, ...originalCrossMonthRows];

  const missingFinalDriverCount = rows.filter(
    r => r.isExportable && !r.finalDriverId
  ).length;

  const invalidDatetimeCount = rows.filter(
    r => !r.finalStartDatetime || !r.finalEndDatetime || r.finalStartMs <= 0 || r.finalEndMs <= 0
  ).length;

  const validation: FinalBlockAssignmentSnapshotValidation = {
    totalConsideredRides: phase1Result.consideredRides,
    snapshotRows: rows.length,
    uniqueTripCount: snapshotTripIdSet.size,
    duplicateTripCount: duplicateTripIds.length,
    missingTripCount: missingTripIds.length,
    unassignedRowCount: unassignedRows.length,
    invalidOriginalRowCount: rows.filter(r => r.assignmentType === 'invalid_original_block').length,
    regularRowCount: rows.filter(r => r.finalDriverRole === 'regular').length,
    inhaberOriginalRowCount: rows.filter(r => r.assignmentType === 'owner_surplus_assignment').length,
    inhaberShiftedRowCount: rows.filter(r => r.assignmentType === 'owner_overflow_time_shift').length,
    timeChangedRowCount: rows.filter(r => r.timeChanged).length,
    durationChangedRowCount: rows.filter(r => r.durationChanged).length,
    outsideMonthRowCount: outsideMonthRows.length,
    appCreatedOutsideMonthRowCount: appCreatedOutsideMonthRows.length,
    originalCrossMonthRowCount: originalCrossMonthRows.length,
    missingFinalDriverCount,
    invalidDatetimeCount,
  };

  return { rows, validation, duplicateTripIds, missingTripIds, unassignedRows, originalCrossMonthRows };
}

// ── Task 7: Export-Prüfung ─────────────────────────────────────────────────────

export interface HistoricalWorkingHoursExportValidationIssue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  row?: number | null;
  blockId?: string | null;
  driverName?: string | null;
  vehicle?: string | null;
  details?: string | null;
}

export interface HistoricalWorkingHoursExportValidationResult {
  isExportReady: boolean;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  issues: HistoricalWorkingHoursExportValidationIssue[];
  checks: {
    snapshotComplete: boolean;
    noUnassignedRows: boolean;
    noDuplicateTrips: boolean;
    noMissingTrips: boolean;
    noDurationChanges: boolean;
    noAppCreatedOutsideMonthRows: boolean;
    noMissingFinalDrivers: boolean;
    noInvalidDatetimes: boolean;
    noAppCreatedDriverOverlaps: boolean;
    noAppCreatedVehicleOverlaps: boolean;
    noFinalExportedDriverOverlaps: boolean;
    noFinalExportedVehicleOverlaps: boolean;
    onlyAllowedDrivers: boolean;
    onlyAllowedFieldsChanged: boolean;
    fullDatetimeOutput: boolean;
    lohnartBucketsRespected: boolean;
    unshiftedTimesConsistent: boolean;
    noRegularDriverTimeChanged: boolean;
  };
  finalExportOverlaps: FinalExportOverlapResult;
}

export interface FinalExportOverlapEntry {
  type: 'driver' | 'vehicle';
  name: string;
  rowA: number | null;
  rowB: number | null;
  startA: string;
  endA: string;
  startB: string;
  endB: string;
  vehicleA: string;
  vehicleB: string;
  driverA: string | null;
  driverB: string | null;
  overlapSec: number;
  blockIdA: string | null;
  blockIdB: string | null;
  assignmentTypeA: string;
  assignmentTypeB: string;
  timeChangedA: boolean;
  timeChangedB: boolean;
}

export interface FinalExportOverlapResult {
  checkedRows: number;
  skippedRows: number;
  invalidTimeRows: number;
  driverOverlapCount: number;
  vehicleOverlapCount: number;
  entries: FinalExportOverlapEntry[];
}

export function validateFinalFahrtenbuchRowsForOverlaps(
  snapshotRows: FinalBlockAssignmentRow[],
): FinalExportOverlapResult {
  // Build the exact rows that the XLSX exporter will write:
  // - all isExportable rows (including canceled/stornierte)
  // - use finalStartMs/finalEndMs (shifted rows have updated times, others preserve originals)
  const MAX_ENTRIES = 50;
  let checkedRows = 0;
  let skippedRows = 0;
  let invalidTimeRows = 0;

  interface ExportRow {
    sourceRowIndex: number | null;
    vehicle: string;
    finalDriverId: string | null;
    finalDriverName: string | null;
    finalStartMs: number;
    finalEndMs: number;
    finalStartDatetime: string;
    finalEndDatetime: string;
    blockId: string | null;
    assignmentType: string;
    timeChanged: boolean;
  }

  const exportRows: ExportRow[] = [];
  for (const r of snapshotRows) {
    if (!r.isExportable) { skippedRows++; continue; }
    if (!r.finalStartMs || !r.finalEndMs || r.finalStartMs <= 0 || r.finalEndMs <= 0) {
      invalidTimeRows++;
      continue;
    }
    checkedRows++;
    exportRows.push({
      sourceRowIndex: r.sourceRowIndex,
      vehicle: r.vehicle,
      finalDriverId: r.finalDriverId,
      finalDriverName: r.finalDriverName,
      finalStartMs: r.finalStartMs,
      finalEndMs: r.finalEndMs,
      finalStartDatetime: r.finalStartDatetime,
      finalEndDatetime: r.finalEndDatetime,
      blockId: r.blockId,
      assignmentType: r.assignmentType,
      timeChanged: r.timeChanged,
    });
  }

  const entries: FinalExportOverlapEntry[] = [];
  let driverOverlapCount = 0;
  let vehicleOverlapCount = 0;

  // ── Driver overlaps ──────────────────────────────────────────────────────
  const byDriver = new Map<string, ExportRow[]>();
  for (const r of exportRows) {
    if (!r.finalDriverId) continue;
    if (!byDriver.has(r.finalDriverId)) byDriver.set(r.finalDriverId, []);
    byDriver.get(r.finalDriverId)!.push(r);
  }

  for (const dRows of byDriver.values()) {
    const sorted = [...dRows].sort((a, b) => a.finalStartMs - b.finalStartMs);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (b.finalStartMs >= a.finalEndMs) break; // sorted, no further overlap possible
        const overlapMs = Math.min(a.finalEndMs, b.finalEndMs) - Math.max(a.finalStartMs, b.finalStartMs);
        if (overlapMs <= 0) continue;
        driverOverlapCount++;
        if (entries.length < MAX_ENTRIES) {
          entries.push({
            type: 'driver',
            name: a.finalDriverName ?? a.finalDriverId ?? '?',
            rowA: a.sourceRowIndex, rowB: b.sourceRowIndex,
            startA: a.finalStartDatetime, endA: a.finalEndDatetime,
            startB: b.finalStartDatetime, endB: b.finalEndDatetime,
            vehicleA: a.vehicle, vehicleB: b.vehicle,
            driverA: a.finalDriverName, driverB: b.finalDriverName,
            overlapSec: Math.round(overlapMs / 1000),
            blockIdA: a.blockId, blockIdB: b.blockId,
            assignmentTypeA: a.assignmentType, assignmentTypeB: b.assignmentType,
            timeChangedA: a.timeChanged, timeChangedB: b.timeChanged,
          });
        }
      }
    }
  }

  // ── Vehicle overlaps ─────────────────────────────────────────────────────
  const byVehicle = new Map<string, ExportRow[]>();
  for (const r of exportRows) {
    if (!r.vehicle) continue;
    if (!byVehicle.has(r.vehicle)) byVehicle.set(r.vehicle, []);
    byVehicle.get(r.vehicle)!.push(r);
  }

  for (const vRows of byVehicle.values()) {
    const sorted = [...vRows].sort((a, b) => a.finalStartMs - b.finalStartMs);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (b.finalStartMs >= a.finalEndMs) break;
        const overlapMs = Math.min(a.finalEndMs, b.finalEndMs) - Math.max(a.finalStartMs, b.finalStartMs);
        if (overlapMs <= 0) continue;
        vehicleOverlapCount++;
        if (entries.length < MAX_ENTRIES) {
          entries.push({
            type: 'vehicle',
            name: a.vehicle,
            rowA: a.sourceRowIndex, rowB: b.sourceRowIndex,
            startA: a.finalStartDatetime, endA: a.finalEndDatetime,
            startB: b.finalStartDatetime, endB: b.finalEndDatetime,
            vehicleA: a.vehicle, vehicleB: b.vehicle,
            driverA: a.finalDriverName, driverB: b.finalDriverName,
            overlapSec: Math.round(overlapMs / 1000),
            blockIdA: a.blockId, blockIdB: b.blockId,
            assignmentTypeA: a.assignmentType, assignmentTypeB: b.assignmentType,
            timeChangedA: a.timeChanged, timeChangedB: b.timeChanged,
          });
        }
      }
    }
  }

  if (import.meta.env.DEV) {
    console.log('[FinalFahrtenbuchOverlapValidation]', {
      checkedRows, skippedRows, invalidTimeRows,
      driverOverlapCount, vehicleOverlapCount,
      exportBlocked: driverOverlapCount > 0 || vehicleOverlapCount > 0,
      first20: entries.slice(0, 20),
    });
  }

  return { checkedRows, skippedRows, invalidTimeRows, driverOverlapCount, vehicleOverlapCount, entries };
}

// Half-open interval overlap
function overlapHalfOpenExport(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function validateHistoricalWorkingHoursExportReadiness(
  snapshotResult: FinalBlockAssignmentSnapshotResult,
  allowedDriverIds: string[],
  driverSummaries?: RegularDriverAssignmentSummary[],
  precomputedFinalExportOverlaps?: FinalExportOverlapResult,
): HistoricalWorkingHoursExportValidationResult {
  const issues: HistoricalWorkingHoursExportValidationIssue[] = [];
  const v = snapshotResult.validation;
  const rows = snapshotResult.rows;
  const allowedSet = new Set(allowedDriverIds.filter(Boolean));

  // ── 1. Snapshot completeness ──────────────────────────────────────────────

  const snapshotComplete = v.snapshotRows === v.totalConsideredRides;
  if (!snapshotComplete) {
    issues.push({ code: 'SNAPSHOT_ROW_COUNT_MISMATCH', severity: 'error', message: `Snapshot-Zeilen (${v.snapshotRows}) stimmen nicht mit berücksichtigten Fahrten (${v.totalConsideredRides}) überein.` });
  }

  const noDuplicateTrips = v.duplicateTripCount === 0;
  if (!noDuplicateTrips) {
    for (const tid of snapshotResult.duplicateTripIds.slice(0, 20)) {
      issues.push({ code: 'DUPLICATE_TRIP', severity: 'error', message: `Doppelte Fahrt im Snapshot: ${tid}`, details: tid });
    }
  }

  const noMissingTrips = v.missingTripCount === 0;
  if (!noMissingTrips) {
    for (const tid of snapshotResult.missingTripIds.slice(0, 20)) {
      issues.push({ code: 'MISSING_TRIP', severity: 'error', message: `Fehlende Fahrt im Snapshot: ${tid}`, details: tid });
    }
  }

  const noUnassignedRows = v.unassignedRowCount === 0;
  for (const r of snapshotResult.unassignedRows.slice(0, 20)) {
    issues.push({ code: 'UNASSIGNED_ROW', severity: 'error', message: 'Nicht zugeordnete Fahrt im Snapshot', row: r.sourceRowIndex, blockId: r.blockId, vehicle: r.vehicle });
  }

  // ── 2. Non-exportable rows ────────────────────────────────────────────────

  const nonExportable = rows.filter(r => !r.isExportable && r.assignmentType !== 'unassigned');
  for (const r of nonExportable.slice(0, 20)) {
    issues.push({ code: 'NOT_EXPORTABLE', severity: 'error', message: `Zeile nicht exportierbar: ${r.validationReason ?? 'Unbekannter Grund'}`, row: r.sourceRowIndex, blockId: r.blockId, vehicle: r.vehicle });
  }

  // ── 3. Duration preservation ──────────────────────────────────────────────

  const noDurationChanges = v.durationChangedRowCount === 0;
  if (!noDurationChanges) {
    const changed = rows.filter(r => r.durationChanged);
    for (const r of changed.slice(0, 20)) {
      issues.push({ code: 'DURATION_CHANGED', severity: 'error', message: `Fahrtdauer verändert: ${r.durationSecOriginal}s → ${r.durationSecFinal}s`, row: r.sourceRowIndex, blockId: r.blockId, driverName: r.finalDriverName, vehicle: r.vehicle });
    }
  }

  // ── 4. App-created outside-month ──────────────────────────────────────────

  const noAppCreatedOutsideMonthRows = v.appCreatedOutsideMonthRowCount === 0;
  if (!noAppCreatedOutsideMonthRows) {
    const bad = rows.filter(r => r.timeChanged && (r.finalStartMs < 0 || r.finalEndMs < 0));
    for (const r of bad.slice(0, 20)) {
      issues.push({ code: 'APP_CREATED_OUTSIDE_MONTH', severity: 'error', message: 'Verschobene Fahrt außerhalb des Monats', row: r.sourceRowIndex, blockId: r.blockId, driverName: r.finalDriverName, vehicle: r.vehicle });
    }
    // Also scan directly
    const badDirect = rows.filter(r => r.timeChanged && r.finalStartMs > 0 && v.appCreatedOutsideMonthRowCount > 0);
    if (badDirect.length === 0 && v.appCreatedOutsideMonthRowCount > 0) {
      issues.push({ code: 'APP_CREATED_OUTSIDE_MONTH', severity: 'error', message: `${v.appCreatedOutsideMonthRowCount} verschobene Fahrt(en) außerhalb des Monats` });
    }
  }
  // Original cross-month = info only
  if (v.originalCrossMonthRowCount > 0) {
    issues.push({ code: 'ORIGINAL_CROSS_MONTH', severity: 'info', message: `${v.originalCrossMonthRowCount} Originalzeile(n) überschreiten die Monatsgrenze (nicht verschoben, nur Hinweis).` });
  }

  // ── 5. Missing final driver ───────────────────────────────────────────────

  const noMissingFinalDrivers = v.missingFinalDriverCount === 0;
  if (!noMissingFinalDrivers) {
    const noDriver = rows.filter(r => r.isExportable && !r.finalDriverId);
    for (const r of noDriver.slice(0, 20)) {
      issues.push({ code: 'MISSING_FINAL_DRIVER', severity: 'error', message: 'Exportierbarer Eintrag ohne finalen Fahrer', row: r.sourceRowIndex, blockId: r.blockId, vehicle: r.vehicle });
    }
  }

  // ── 6. Full datetime format ───────────────────────────────────────────────

  // YYYY-MM-DD HH:mm:ss.SSS
  const fullDtPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
  const invalidDtRows = rows.filter(r =>
    r.isExportable && (!fullDtPattern.test(r.finalStartDatetime) || !fullDtPattern.test(r.finalEndDatetime))
  );
  const noInvalidDatetimes = invalidDtRows.length === 0;
  const fullDatetimeOutput = noInvalidDatetimes;
  for (const r of invalidDtRows.slice(0, 20)) {
    issues.push({ code: 'INVALID_DATETIME_FORMAT', severity: 'error', message: `Ungültiges Datumsformat: "${r.finalStartDatetime}" / "${r.finalEndDatetime}"`, row: r.sourceRowIndex, blockId: r.blockId, vehicle: r.vehicle });
  }

  // ── 7. Allowed drivers ────────────────────────────────────────────────────

  let onlyAllowedDrivers = true;
  if (allowedSet.size > 0) {
    const disallowed = rows.filter(r => r.isExportable && r.finalDriverId && !allowedSet.has(r.finalDriverId));
    if (disallowed.length > 0) {
      onlyAllowedDrivers = false;
      const seen = new Set<string>();
      for (const r of disallowed) {
        const key = r.finalDriverId ?? 'unknown';
        if (!seen.has(key)) {
          seen.add(key);
          issues.push({ code: 'DRIVER_NOT_ALLOWED', severity: 'error', message: `Fahrer nicht in Auswahl: ${r.finalDriverName ?? r.finalDriverId}`, driverName: r.finalDriverName, vehicle: r.vehicle });
        }
      }
    }
  }

  // ── 8. Only allowed fields changed ───────────────────────────────────────

  let onlyAllowedFieldsChanged = true;
  for (const r of rows) {
    if (!r.isExportable) continue;
    const type = r.assignmentType;
    // Regular and inhaber-original must NOT have time changed
    if ((type === 'regular_block_assignment' || type === 'owner_surplus_assignment') && r.timeChanged) {
      onlyAllowedFieldsChanged = false;
      issues.push({ code: 'UNEXPECTED_TIME_CHANGE', severity: 'error', message: `Reguläre/Originalzeit-Zeile hat unerwartete Zeitänderung`, row: r.sourceRowIndex, blockId: r.blockId, driverName: r.finalDriverName, vehicle: r.vehicle });
    }
    // Shifted must have time changed
    if (type === 'owner_overflow_time_shift' && !r.timeChanged) {
      onlyAllowedFieldsChanged = false;
      issues.push({ code: 'MISSING_TIME_CHANGE_ON_SHIFT', severity: 'error', message: `Verschobene Zeile hat keine Zeitänderung (offsetSec=0?)`, row: r.sourceRowIndex, blockId: r.blockId, driverName: r.finalDriverName, vehicle: r.vehicle });
    }
    // Duration must never change
    if (r.durationChanged) {
      // Already counted above but add a field-change specific issue
      onlyAllowedFieldsChanged = false;
    }
    // Vehicle must be present
    if (!r.vehicle) {
      onlyAllowedFieldsChanged = false;
      issues.push({ code: 'MISSING_VEHICLE', severity: 'error', message: 'Fehlendes Fahrzeug', row: r.sourceRowIndex, blockId: r.blockId });
    }
  }

  // ── 9. Driver overlaps ────────────────────────────────────────────────────

  const exportableRows = rows.filter(r => r.isExportable && r.finalDriverId);
  // Group by finalDriverId
  const byDriver = new Map<string, typeof exportableRows>();
  for (const r of exportableRows) {
    const key = r.finalDriverId!;
    if (!byDriver.has(key)) byDriver.set(key, []);
    byDriver.get(key)!.push(r);
  }

  let noAppCreatedDriverOverlaps = true;
  const driverOverlapIssues: HistoricalWorkingHoursExportValidationIssue[] = [];
  for (const [driverId, dRows] of byDriver) {
    for (let i = 0; i < dRows.length; i++) {
      for (let j = i + 1; j < dRows.length; j++) {
        const a = dRows[i];
        const b = dRows[j];
        if (!overlapHalfOpenExport(a.finalStartMs, a.finalEndMs, b.finalStartMs, b.finalEndMs)) continue;
        // Determine if this was pre-existing in original data:
        // Same original driver AND original timestamps also overlapped
        const origOverlap =
          a.originalDriverName !== null &&
          a.originalDriverName === b.originalDriverName &&
          overlapHalfOpenExport(a.originalStartMs, a.originalEndMs, b.originalStartMs, b.originalEndMs);
        if (origOverlap) {
          driverOverlapIssues.push({ code: 'ORIGINAL_DRIVER_OVERLAP', severity: 'warning', message: `Originaldaten-Warnung Fahrer: ${a.finalDriverName ?? driverId}`, row: a.sourceRowIndex, blockId: a.blockId, driverName: a.finalDriverName, vehicle: a.vehicle, details: `Zeilen ${a.sourceRowIndex ?? '?'} & ${b.sourceRowIndex ?? '?'}` });
        } else {
          noAppCreatedDriverOverlaps = false;
          driverOverlapIssues.push({ code: 'APP_DRIVER_OVERLAP', severity: 'error', message: `App-erzeugte Fahrerüberschneidung: ${a.finalDriverName ?? driverId}`, row: a.sourceRowIndex, blockId: a.blockId, driverName: a.finalDriverName, vehicle: a.vehicle, details: `Zeilen ${a.sourceRowIndex ?? '?'} & ${b.sourceRowIndex ?? '?'}` });
        }
      }
    }
  }
  issues.push(...driverOverlapIssues.slice(0, 30));

  // ── 10. Vehicle overlaps ──────────────────────────────────────────────────

  const byVehicle = new Map<string, typeof exportableRows>();
  for (const r of exportableRows) {
    const key = r.vehicle;
    if (!byVehicle.has(key)) byVehicle.set(key, []);
    byVehicle.get(key)!.push(r);
  }

  let noAppCreatedVehicleOverlaps = true;
  const vehicleOverlapIssues: HistoricalWorkingHoursExportValidationIssue[] = [];
  for (const [vehicle, vRows] of byVehicle) {
    for (let i = 0; i < vRows.length; i++) {
      for (let j = i + 1; j < vRows.length; j++) {
        const a = vRows[i];
        const b = vRows[j];
        if (!overlapHalfOpenExport(a.finalStartMs, a.finalEndMs, b.finalStartMs, b.finalEndMs)) continue;
        // Pre-existing if same vehicle AND original timestamps also overlapped
        const origOverlap = overlapHalfOpenExport(a.originalStartMs, a.originalEndMs, b.originalStartMs, b.originalEndMs);
        if (origOverlap) {
          vehicleOverlapIssues.push({ code: 'ORIGINAL_VEHICLE_OVERLAP', severity: 'warning', message: `Originaldaten-Warnung Fahrzeug: ${vehicle}`, row: a.sourceRowIndex, blockId: a.blockId, vehicle, details: `Zeilen ${a.sourceRowIndex ?? '?'} & ${b.sourceRowIndex ?? '?'}` });
        } else {
          noAppCreatedVehicleOverlaps = false;
          vehicleOverlapIssues.push({ code: 'APP_VEHICLE_OVERLAP', severity: 'error', message: `App-erzeugte Fahrzeugüberschneidung: ${vehicle}`, row: a.sourceRowIndex, blockId: a.blockId, vehicle, details: `Zeilen ${a.sourceRowIndex ?? '?'} & ${b.sourceRowIndex ?? '?'}` });
        }
      }
    }
  }
  issues.push(...vehicleOverlapIssues.slice(0, 30));

  // ── 12. Unshifted times consistency ──────────────────────────────────────

  let unshiftedTimesConsistent = true;
  for (const row of rows) {
    if (!row.timeChanged && row.isExportable) {
      if (row.finalStartDatetime !== row.originalStartDatetime ||
          row.finalEndDatetime   !== row.originalEndDatetime) {
        unshiftedTimesConsistent = false;
        issues.push({
          code: 'UNSHIFTED_TIME_MISMATCH',
          severity: 'error',
          message: `Unveränderte Zeile hat abweichende finalDatetime: original="${row.originalStartDatetime}" final="${row.finalStartDatetime}"`,
          row: row.sourceRowIndex,
          blockId: row.blockId,
          driverName: row.finalDriverName,
        });
      }
    }
  }

  // ── 11. Lohnart bucket check ──────────────────────────────────────────────

  let lohnartBucketsRespected = true;
  if (driverSummaries && driverSummaries.length > 0) {
    const TOL = 1;
    for (const ds of driverSummaries) {
      const checks1: Array<[number, number, string]> = [
        [ds.assignedBaseSec1000,   ds.targetBaseSec1000,    '1000 Std'],
        [ds.assignedNight25Sec1500, ds.targetNight25Sec1500, '1500 N25%'],
        [ds.assignedNight40Sec1501, ds.targetNight40Sec1501, '1501 N40%'],
        [ds.assignedSundaySec1510, ds.targetSundaySec1510,  '1510 Son'],
        [ds.assignedHolidaySec,    ds.targetHolidaySec,     'Feiertag'],
      ];
      for (const [assigned, target, label] of checks1) {
        if (assigned > target + TOL) {
          lohnartBucketsRespected = false;
          issues.push({
            code: 'LOHNART_BUCKET_EXCEEDED',
            severity: 'error',
            message: `Fahrer ${ds.driverName}: ${label} überschritten (Ziel: ${Math.round(target / 3600 * 100) / 100} h, Zugewiesen: ${Math.round(assigned / 3600 * 100) / 100} h)`,
            driverName: ds.driverName,
          });
        }
      }
    }
  }

  // ── 13. No regular driver time changed ───────────────────────────────────

  let noRegularDriverTimeChanged = true;
  for (const row of rows) {
    if (row.timeChanged && row.finalDriverRole === 'regular') {
      noRegularDriverTimeChanged = false;
      issues.push({
        code: 'REGULAR_DRIVER_TIME_CHANGED',
        severity: 'error',
        message: `Regulärer Fahrer ${row.finalDriverName ?? '?'} hat zeitgeänderte Zeile (Zeile ${row.sourceRowIndex ?? '?'})`,
        row: row.sourceRowIndex,
        blockId: row.blockId,
        driverName: row.finalDriverName,
      });
    }
  }

  // ── Result assembly ───────────────────────────────────────────────────────

  // ── Final exported row-level overlap check ───────────────────────────────
  // Use precomputed result from buildFinalExportedFahrtenbuchRows if available
  // (single source of truth). Fall back to snapshot-based check for backward compat.
  const finalExportOverlaps = precomputedFinalExportOverlaps ?? validateFinalFahrtenbuchRowsForOverlaps(rows);
  const noFinalExportedDriverOverlaps = finalExportOverlaps.driverOverlapCount === 0;
  const noFinalExportedVehicleOverlaps = finalExportOverlaps.vehicleOverlapCount === 0;

  if (!noFinalExportedDriverOverlaps) {
    issues.push({
      code: 'FINAL_EXPORT_DRIVER_OVERLAP',
      severity: 'error',
      message: `Export blockiert: Fahrerüberschneidungen im exportierten Fahrtenbuch gefunden. (${finalExportOverlaps.driverOverlapCount} Überschneidung(en))`,
    });
  }
  if (!noFinalExportedVehicleOverlaps) {
    issues.push({
      code: 'FINAL_EXPORT_VEHICLE_OVERLAP',
      severity: 'error',
      message: `Export blockiert: Fahrzeugüberschneidungen im exportierten Fahrtenbuch gefunden. (${finalExportOverlaps.vehicleOverlapCount} Überschneidung(en))`,
    });
  }

  const errorCount   = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;
  const infoCount    = issues.filter(i => i.severity === 'info').length;

  const checks = {
    snapshotComplete,
    noUnassignedRows,
    noDuplicateTrips,
    noMissingTrips,
    noDurationChanges,
    noAppCreatedOutsideMonthRows,
    noMissingFinalDrivers,
    noInvalidDatetimes,
    noAppCreatedDriverOverlaps,
    noAppCreatedVehicleOverlaps,
    noFinalExportedDriverOverlaps,
    noFinalExportedVehicleOverlaps,
    onlyAllowedDrivers,
    onlyAllowedFieldsChanged,
    fullDatetimeOutput,
    lohnartBucketsRespected,
    unshiftedTimesConsistent,
    noRegularDriverTimeChanged,
  };

  const isExportReady = errorCount === 0;

  return { isExportReady, errorCount, warningCount, infoCount, issues, checks, finalExportOverlaps };
}
