/**
 * historicalRowLevelEngine
 *
 * Clean row-level engine for old-month Arbeitsstunden / Steuerberater-Abgleich workflow.
 *
 * [RowLevelArbeitsstundenRestart]
 *
 * Key design:
 *   - Every trip (including unassigned, invalid, cancelled) produces a FinalExportRow.
 *   - Overlap validation runs on ALL abgeschlossen rows, using the exact values
 *     that will appear in the exported XLSX (finalFahrername / finalStart / finalEnd).
 *   - For unassigned/invalid abgeschlossen trips, the original values are used as
 *     the final values — matching exactly what the XLSX checker sees.
 *   - No separate interpretation between validation and export.
 */

import type { FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
// Type-only: the engine names a dictionary key beside its German text.
import type { EngineMessageKey, EngineMessageVars } from '../i18n/engineMessageTypes';
import { nextLocalMidnightMs } from './localDayWindow';
import {
  buildVehicleBlocksForHistoricalWorkingHours,
  assignRegularDriversToVehicleBlocks,
  computeLohnartSeconds,
  getGermanNationalHolidays,
  type BuildVehicleBlocksResult,
  type VehicleBlock,
  type VehicleBlockRide,
  type RegularDriverTarget,
  type RegularAssignmentStrategy,
  type LohnartSeconds,
} from './historicalWorkingHoursCleanEngine';

// ── Fahrtstatus detection ─────────────────────────────────────────────────────

const FAHRTSTATUS_KEYS = ['Fahrtstatus', 'fahrtstatus', 'Status', 'status'];

export function getFahrtstatus(trip: FahrtenbuchTrip): string {
  const raw = (trip.raw_data_json ?? {}) as Record<string, unknown>;
  for (const key of FAHRTSTATUS_KEYS) {
    const val = raw[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return trip.is_canceled ? 'storniert' : 'abgeschlossen';
}

export function isAbgeschlossen(trip: FahrtenbuchTrip): boolean {
  return getFahrtstatus(trip) === 'abgeschlossen';
}

// ── Datetime resolution (mirrors existing engine logic) ───────────────────────

const START_KEYS = [
  'Uhrzeit des Fahrtbeginns', 'uhrzeit des fahrtbeginns',
  'Fahrtbeginn', 'fahrtbeginn', 'start_datetime', 'StartDatetime', 'Fahrt_Beginn', 'FahrtBeginn',
];
const END_KEYS = [
  'Uhrzeit des Fahrtendes', 'uhrzeit des fahrtendes',
  'Fahrtende', 'fahrtende', 'end_datetime', 'EndDatetime', 'Fahrt_Ende', 'FahrtEnde',
];
const DRIVER_KEYS = [
  'Fahrername', 'fahrername', 'Fahrer', 'Fahrer Name', 'FahrerName',
];
const VEHICLE_KEYS = [
  'Kennzeichen', 'kennzeichen', 'KFZ', 'kfz', 'Fahrzeug', 'fahrzeug', 'car_identifier',
];

function resolveRawString(raw: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const val = raw[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return '';
}

function parseDatetimeMs(dt: string): number {
  if (!dt) return 0;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(dt)) {
    const ms = Date.parse(dt.replace(' ', 'T'));
    return isNaN(ms) ? 0 : ms;
  }
  return 0;
}

function resolveFullDatetime(trip: FahrtenbuchTrip, which: 'start' | 'end'): string {
  const raw = (trip.raw_data_json ?? {}) as Record<string, unknown>;
  const keys = which === 'start' ? START_KEYS : END_KEYS;
  for (const key of keys) {
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

function formatFinalDatetime(ms: number): string {
  if (!ms || ms <= 0) return '';
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// ── FinalExportRow ────────────────────────────────────────────────────────────

export type FinalAssignmentType =
  | 'regular'
  | 'inhaber_original'
  | 'inhaber_shifted'
  | 'invalid_original'
  | 'unassigned'
  | 'canceled';

/**
 * Single source-of-truth row for the exported Fahrtenbuch.
 *
 * fahrtRowNumber = 1-based data row index (same as source_row_index + 1).
 * excelRowNumber = fahrtRowNumber + 1 (header takes row 1 in Excel).
 *
 * For ALL abgeschlossen rows, finalFahrername / finalStart / finalEnd hold the
 * exact values that will appear in the exported XLSX:
 *   - isExportable=true  → patched values
 *   - isExportable=false → original values (kept unchanged in XLSX)
 * This allows a single overlap check to match the external XLSX checker.
 */
export interface FinalExportRow {
  fahrtRowNumber: number;
  excelRowNumber: number;
  sourceRowIndex: number;
  originalTripId: string;
  blockId: string | null;
  fahrtstatus: string;

  originalFahrername: string;
  finalFahrername: string;
  kennzeichen: string;

  originalStart: string;
  originalEnd: string;
  finalStart: string;
  finalEnd: string;

  originalStartMs: number;
  originalEndMs: number;
  finalStartMs: number;
  finalEndMs: number;
  durationMs: number;

  assignmentType: FinalAssignmentType;
  timeChanged: boolean;
  isExportable: boolean;

  /** 'ok' | 'overlap_driver' | 'overlap_vehicle' | 'missing_time' | 'invalid_original' | 'unassigned' | 'canceled' */
  validationStatus: string;
}

// ── Overlap result ────────────────────────────────────────────────────────────

export interface RowLevelOverlapEntry {
  type: 'driver' | 'vehicle';
  name: string;
  rowA: number;
  excelRowA: number;
  rowB: number;
  excelRowB: number;
  startA: string;
  endA: string;
  startB: string;
  endB: string;
  vehicleA: string;
  vehicleB: string;
  driverA: string;
  driverB: string;
  overlapSec: number;
  blockIdA: string | null;
  blockIdB: string | null;
  assignmentTypeA: FinalAssignmentType;
  assignmentTypeB: FinalAssignmentType;
  timeChangedA: boolean;
  timeChangedB: boolean;
}

export interface RowLevelOverlapValidation {
  checkedRows: number;
  driverOverlapCount: number;
  vehicleOverlapCount: number;
  entries: RowLevelOverlapEntry[];
  isClean: boolean;
  regressionChecks: {
    rowPair99_100Present: boolean;
    rowPair340_366Present: boolean;
  };
}

// ── Engine configuration ──────────────────────────────────────────────────────

export interface ArbeitsstundenEngineConfig {
  month: number;
  year: number;
  regularTargets: RegularDriverTarget[];
  inhaber: { driverId: string; driverName: string } | null;
  assignmentStrategy?: RegularAssignmentStrategy;
  slotIncrementMinutes?: number;
}

// ── Engine result ─────────────────────────────────────────────────────────────

export interface ArbeitsstundenEngineResult {
  finalRows: FinalExportRow[];

  // Phase statistics
  totalTrips: number;
  abgeschlossenTrips: number;
  canceledTrips: number;
  regularAssignedBlocks: number;
  inhaberOriginalBlocks: number;
  inhaberShiftedBlocks: number;
  noSlotBlocks: number;
  unassignedRows: number;
  invalidOriginalRows: number;

  overlapValidation: RowLevelOverlapValidation;

  // Downstream engines (still needed for Stundennacheis preview etc.)
  phase1: BuildVehicleBlocksResult;

  isExportReady: boolean;
  /** German, as the engine has always written it. The screen's fallback. */
  exportBlockedReason: string | null;
  exportBlockedReasonKey?: EngineMessageKey;
  exportBlockedReasonVars?: EngineMessageVars;
}

// ── Occupancy map helpers ─────────────────────────────────────────────────────

interface OccInterval {
  startMs: number;
  endMs: number;
  blockId: string | null;
}

function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Check whether rides inside a single block overlap each other (for the same
 * vehicle or driver). Any block with internal overlap must not be exported clean.
 */
function blockHasInternalOverlap(rides: VehicleBlockRide[]): boolean {
  for (let i = 0; i < rides.length; i++) {
    const a = rides[i];
    if (!a.originalStartMs || !a.originalEndMs) continue;
    for (let j = i + 1; j < rides.length; j++) {
      const b = rides[j];
      if (!b.originalStartMs || !b.originalEndMs) continue;
      if (intervalsOverlap(a.originalStartMs, a.originalEndMs, b.originalStartMs, b.originalEndMs)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check whether a block can be placed for a given driver at a given offset.
 * Checks every individual ride in the block against:
 *   - driverOccupied[driverName]: existing driver intervals
 *   - vehicleOccupied[vehicle]: existing vehicle intervals
 * Returns null if ok, or an error description.
 */
function canPlaceBlock(
  blockRides: VehicleBlockRide[],
  vehicle: string,
  driverName: string,
  offsetMs: number,
  driverOccupied: Map<string, OccInterval[]>,
  vehicleOccupied: Map<string, OccInterval[]>,
): null | { driverConflict: boolean; vehicleConflict: boolean } {
  const driverIvs = driverOccupied.get(driverName) ?? [];
  const vehicleIvs = vehicleOccupied.get(vehicle) ?? [];

  let driverConflict = false;
  let vehicleConflict = false;

  for (const ride of blockRides) {
    const rideStart = ride.originalStartMs + offsetMs;
    const rideEnd   = ride.originalEndMs   + offsetMs;
    if (rideStart <= 0 || rideEnd <= 0 || rideEnd <= rideStart) continue;

    if (!driverConflict && driverIvs.some(iv => intervalsOverlap(rideStart, rideEnd, iv.startMs, iv.endMs))) {
      driverConflict = true;
    }
    if (!vehicleConflict && vehicleIvs.some(iv => intervalsOverlap(rideStart, rideEnd, iv.startMs, iv.endMs))) {
      vehicleConflict = true;
    }
    if (driverConflict && vehicleConflict) break;
  }

  if (driverConflict || vehicleConflict) return { driverConflict, vehicleConflict };
  return null;
}

/**
 * Add all rides of a block (with offset) to both occupancy maps.
 */
function addBlockToOccupancy(
  blockRides: VehicleBlockRide[],
  vehicle: string,
  driverName: string,
  offsetMs: number,
  blockId: string | null,
  driverOccupied: Map<string, OccInterval[]>,
  vehicleOccupied: Map<string, OccInterval[]>,
): void {
  if (!driverOccupied.has(driverName)) driverOccupied.set(driverName, []);
  if (!vehicleOccupied.has(vehicle)) vehicleOccupied.set(vehicle, []);
  const dArr = driverOccupied.get(driverName)!;
  const vArr = vehicleOccupied.get(vehicle)!;

  for (const ride of blockRides) {
    const rideStart = ride.originalStartMs + offsetMs;
    const rideEnd   = ride.originalEndMs   + offsetMs;
    if (rideStart <= 0 || rideEnd <= 0) continue;
    const iv: OccInterval = { startMs: rideStart, endMs: rideEnd, blockId };
    dArr.push(iv);
    vArr.push(iv);
  }
}

// ── Phase 3 (clean): Inhaber original-time placement ─────────────────────────

interface InhaberPlacementResult {
  originalTimeBlocks: Set<string>;
  needsShiftBlocks: Set<string>;
  invalidOriginalBlocks: Set<string>;
  ownerBlocksNeedingShift: number;
}

function placeInhaberOriginalTime(
  surplusBlocks: VehicleBlock[],
  inhaberName: string,
  ridesByBlockId: Map<string, VehicleBlockRide[]>,
  driverOccupied: Map<string, OccInterval[]>,
  vehicleOccupied: Map<string, OccInterval[]>,
): InhaberPlacementResult {
  // Sort by earliest start, then longest block first
  const sorted = [...surplusBlocks].sort((a, b) => {
    if (a.blockStartMs !== b.blockStartMs) return a.blockStartMs - b.blockStartMs;
    return b.blockDurationSec - a.blockDurationSec;
  });

  const originalTimeBlocks = new Set<string>();
  const needsShiftBlocks   = new Set<string>();
  const invalidOriginalBlocks = new Set<string>();

  for (const block of sorted) {
    if (block.status === 'invalid') {
      invalidOriginalBlocks.add(block.blockId);
      continue;
    }

    const rides = ridesByBlockId.get(block.blockId) ?? [];

    // Internal overlap: block itself has conflicting rides — cannot be placed clean at any offset
    if (blockHasInternalOverlap(rides)) {
      invalidOriginalBlocks.add(block.blockId);
      if (import.meta.env.DEV) {
        console.log('[RowLevelPlacementFix] Phase3 Inhaber block has internal overlap:', {
          blockId: block.blockId, vehicle: block.vehicle, rides: rides.length,
        });
      }
      continue;
    }

    const conflict = canPlaceBlock(rides, block.vehicle, inhaberName, 0, driverOccupied, vehicleOccupied);

    if (conflict) {
      needsShiftBlocks.add(block.blockId);
      if (import.meta.env.DEV) {
        console.log('[RowLevelPlacementFix] Phase3 Inhaber needs-shift:', {
          blockId: block.blockId, vehicle: block.vehicle,
          driverConflict: conflict.driverConflict,
          vehicleConflict: conflict.vehicleConflict,
        });
      }
    } else {
      originalTimeBlocks.add(block.blockId);
      // Register rides so future blocks see them
      addBlockToOccupancy(rides, block.vehicle, inhaberName, 0, block.blockId, driverOccupied, vehicleOccupied);
    }
  }

  return {
    originalTimeBlocks,
    needsShiftBlocks,
    invalidOriginalBlocks,
    ownerBlocksNeedingShift: needsShiftBlocks.size,
  };
}

// ── Phase 4 (clean): Inhaber shift placement ──────────────────────────────────

interface ShiftResult {
  shiftedBlocks: Map<string, number>; // blockId → offsetMs
  noSlotBlockIds: Set<string>;
  candidateSummary: { blockId: string; tried: number; found: boolean }[];
  rejectedDriverSlots: number;
  rejectedVehicleSlots: number;
}

function shiftInhaberBlocks(
  blocksToShift: VehicleBlock[],
  inhaberName: string,
  ridesByBlockId: Map<string, VehicleBlockRide[]>,
  driverOccupied: Map<string, OccInterval[]>,
  vehicleOccupied: Map<string, OccInterval[]>,
  options: { month: number; year: number; slotIncrementMinutes?: number },
): ShiftResult {
  const slotMs = (options.slotIncrementMinutes ?? 15) * 60_000;
  const monthStart     = new Date(options.year, options.month - 1, 1, 0, 0, 0, 0).getTime();
  const nextMonthStart = new Date(options.year, options.month,     1, 0, 0, 0, 0).getTime();

  // Sort: longest first, then earliest start
  const sorted = [...blocksToShift].sort((a, b) => {
    if (b.blockDurationSec !== a.blockDurationSec) return b.blockDurationSec - a.blockDurationSec;
    return a.blockStartMs - b.blockStartMs;
  });

  const shiftedBlocks    = new Map<string, number>();
  const noSlotBlockIds   = new Set<string>();
  const candidateSummary: ShiftResult['candidateSummary'] = [];
  let rejectedDriverSlots = 0;
  let rejectedVehicleSlots = 0;

  for (const block of sorted) {
    const rides = ridesByBlockId.get(block.blockId) ?? [];
    if (rides.length === 0) {
      noSlotBlockIds.add(block.blockId);
      candidateSummary.push({ blockId: block.blockId, tried: 0, found: false });
      continue;
    }

    const durationMs = block.blockEndMs - block.blockStartMs;
    const origDate   = new Date(block.blockStartMs);
    const origDayStart = new Date(origDate.getFullYear(), origDate.getMonth(), origDate.getDate(), 0, 0, 0, 0).getTime();
    // The end of that calendar day, not midnight plus a fixed day length — the
    // same defect and the same reasoning as `origDayEnd` in
    // `shiftOverlappingInhaberBlocks`, which this function mirrors slot for
    // slot. A fixed 86 400 000 ms named local 23:00 on the 25-hour day of
    // 25.10.2026 and local 01:00 of the NEXT day on the 23-hour day of
    // 29.03.2026, so the same-day pass was an hour short in autumn and reached
    // into Monday in spring. The selection below prefers a same-day slot over
    // any other before it compares offsets (`isSameDay && !bestIsSameDay`), so
    // a mislabelled slot changes which slot wins and therefore the block's
    // final time. See src/utils/localDayWindow.ts.
    const origDayEnd   = nextLocalMidnightMs(origDayStart);
    // Preserve seconds/ms within the slot
    const subMinuteMs = origDate.getSeconds() * 1000 + origDate.getMilliseconds();

    let bestOffsetMs: number | null = null;
    let bestAbsOffset = Infinity;
    let bestIsSameDay = false;
    let tried = 0;

    // Scan same-day first, then full month
    for (const sameDayPass of [true, false]) {
      const rangeStart = sameDayPass ? origDayStart : monthStart;
      const rangeEnd   = sameDayPass ? origDayEnd   : nextMonthStart;

      let boundary = rangeStart;
      while (boundary < rangeEnd) {
        const candidateStart = boundary + subMinuteMs;
        const candidateEnd   = candidateStart + durationMs;

        // Skip same-day slots in second pass
        if (!sameDayPass && candidateStart >= origDayStart && candidateStart < origDayEnd) {
          boundary += slotMs;
          continue;
        }

        // Must be within month
        if (candidateStart >= monthStart && candidateEnd <= nextMonthStart) {
          const offsetMs = candidateStart - block.blockStartMs;

          // Skip zero offset (same as original, already rejected)
          if (offsetMs !== 0) {
            tried++;
            const conflict = canPlaceBlock(rides, block.vehicle, inhaberName, offsetMs, driverOccupied, vehicleOccupied);

            if (conflict) {
              if (conflict.driverConflict) rejectedDriverSlots++;
              else rejectedVehicleSlots++;
            } else {
              const absOffset = Math.abs(offsetMs);
              const isSameDay = sameDayPass;
              // Prefer: same day > smallest abs offset
              const better =
                bestOffsetMs === null ||
                (isSameDay && !bestIsSameDay) ||
                (isSameDay === bestIsSameDay && absOffset < bestAbsOffset);

              if (better) {
                bestOffsetMs   = offsetMs;
                bestAbsOffset  = absOffset;
                bestIsSameDay  = isSameDay;
              }
            }
          }
        }
        boundary += slotMs;
      }
      // Stop after same-day pass if we found a slot there
      if (sameDayPass && bestOffsetMs !== null) break;
    }

    if (bestOffsetMs !== null) {
      if (import.meta.env.DEV) {
        console.log('[RowLevelPlacementFix] Phase4 accepted shift offset:', {
          blockId: block.blockId, vehicle: block.vehicle,
          offsetSec: Math.round(bestOffsetMs / 1000),
          candidatesTried: tried,
        });
      }
      shiftedBlocks.set(block.blockId, bestOffsetMs);
      addBlockToOccupancy(rides, block.vehicle, inhaberName, bestOffsetMs, block.blockId, driverOccupied, vehicleOccupied);
    } else {
      if (import.meta.env.DEV) {
        console.log('[RowLevelPlacementFix] Phase4 no slot found for block:', {
          blockId: block.blockId, vehicle: block.vehicle,
          candidatesTried: tried,
        });
      }
      noSlotBlockIds.add(block.blockId);
    }
    candidateSummary.push({ blockId: block.blockId, tried, found: bestOffsetMs !== null });
  }

  return { shiftedBlocks, noSlotBlockIds, candidateSummary, rejectedDriverSlots, rejectedVehicleSlots };
}

// ── Build FinalExportRow for a single trip ────────────────────────────────────

function buildRowForTrip(
  trip: FahrtenbuchTrip,
  assignmentType: FinalAssignmentType,
  blockId: string | null,
  finalDriverName: string,
  finalStartMs: number,
  finalEndMs: number,
  isExportable: boolean,
): FinalExportRow {
  const raw = (trip.raw_data_json ?? {}) as Record<string, unknown>;

  const srcIdx   = trip.source_row_index ?? 0;
  const fahrtRow = srcIdx + 1;
  const excelRow = fahrtRow + 1;

  const origStart   = resolveFullDatetime(trip, 'start');
  const origEnd     = resolveFullDatetime(trip, 'end');
  const origStartMs = parseDatetimeMs(origStart);
  const origEndMs   = parseDatetimeMs(origEnd);

  const fahrtstatus       = getFahrtstatus(trip);
  const originalFahrername = resolveRawString(raw, DRIVER_KEYS) || trip.original_driver_name || '';
  const kennzeichen        = (trip.car_identifier ?? resolveRawString(raw, VEHICLE_KEYS)).trim();

  const finalStart = finalStartMs > 0 ? formatFinalDatetime(finalStartMs) : origStart;
  const finalEnd   = finalEndMs   > 0 ? formatFinalDatetime(finalEndMs)   : origEnd;
  const usedStartMs = finalStartMs > 0 ? finalStartMs : origStartMs;
  const usedEndMs   = finalEndMs   > 0 ? finalEndMs   : origEndMs;

  const timeChanged = finalStartMs > 0 && origStartMs > 0 && finalStartMs !== origStartMs;
  const durationMs  = usedEndMs > usedStartMs ? usedEndMs - usedStartMs : 0;

  let validationStatus = 'ok';
  if (!isExportable) {
    if (assignmentType === 'canceled') validationStatus = 'canceled';
    else if (assignmentType === 'invalid_original') validationStatus = 'invalid_original';
    else validationStatus = 'unassigned';
  } else if (!usedStartMs || !usedEndMs) {
    validationStatus = 'missing_time';
  }

  return {
    fahrtRowNumber: fahrtRow,
    excelRowNumber: excelRow,
    sourceRowIndex: srcIdx,
    originalTripId: trip.id,
    blockId,
    fahrtstatus,
    originalFahrername,
    finalFahrername: finalDriverName,
    kennzeichen,
    originalStart: origStart,
    originalEnd: origEnd,
    finalStart,
    finalEnd,
    originalStartMs: origStartMs,
    originalEndMs: origEndMs,
    finalStartMs: usedStartMs,
    finalEndMs: usedEndMs,
    durationMs,
    assignmentType,
    timeChanged,
    isExportable,
    validationStatus,
  };
}

// ── Overlap validation ────────────────────────────────────────────────────────

/**
 * Validate overlaps using ALL abgeschlossen rows (not just isExportable).
 * This exactly matches what the external XLSX checker sees:
 * every abgeschlossen row in the XLSX, with its actual Fahrername and times.
 */
function validateRowLevelOverlaps(finalRows: FinalExportRow[]): RowLevelOverlapValidation {
  // Only abgeschlossen rows participate in overlap blocking
  const rows = finalRows.filter(r => r.fahrtstatus === 'abgeschlossen');

  const MAX_ENTRIES = 50;
  let driverOverlapCount = 0;
  let vehicleOverlapCount = 0;
  const entries: RowLevelOverlapEntry[] = [];

  // Known regression rows (0-based sourceRowIndex)
  const REGRESSION = new Set([99, 100, 175, 177, 340, 366]);

  // ── Driver overlaps ──────────────────────────────────────────────────────
  const byDriver = new Map<string, FinalExportRow[]>();
  for (const r of rows) {
    const name = r.finalFahrername;
    if (!name) continue;
    if (!byDriver.has(name)) byDriver.set(name, []);
    byDriver.get(name)!.push(r);
  }

  for (const dRows of byDriver.values()) {
    const sorted = [...dRows].sort((a, b) => a.finalStartMs - b.finalStartMs);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (b.finalStartMs >= a.finalEndMs) break;
        const overlapMs = Math.min(a.finalEndMs, b.finalEndMs) - Math.max(a.finalStartMs, b.finalStartMs);
        if (overlapMs <= 0) continue;
        driverOverlapCount++;
        const isRegression = REGRESSION.has(a.sourceRowIndex) || REGRESSION.has(b.sourceRowIndex);
        if (import.meta.env.DEV && isRegression) {
          console.log('[RowLevelArbeitsstundenRestart] [RegressionCheck] Driver overlap:', {
            driver: a.finalFahrername,
            rowA: a.fahrtRowNumber, excelRowA: a.excelRowNumber,
            rowB: b.fahrtRowNumber, excelRowB: b.excelRowNumber,
            startA: a.finalStart, endA: a.finalEnd,
            startB: b.finalStart, endB: b.finalEnd,
            vehicleA: a.kennzeichen, vehicleB: b.kennzeichen,
            overlapSec: Math.round(overlapMs / 1000),
            typeA: a.assignmentType, typeB: b.assignmentType,
          });
        }
        if (entries.length < MAX_ENTRIES) {
          entries.push({
            type: 'driver',
            name: a.finalFahrername,
            rowA: a.fahrtRowNumber, excelRowA: a.excelRowNumber,
            rowB: b.fahrtRowNumber, excelRowB: b.excelRowNumber,
            startA: a.finalStart, endA: a.finalEnd,
            startB: b.finalStart, endB: b.finalEnd,
            vehicleA: a.kennzeichen, vehicleB: b.kennzeichen,
            driverA: a.finalFahrername, driverB: b.finalFahrername,
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
  const byVehicle = new Map<string, FinalExportRow[]>();
  for (const r of rows) {
    if (!r.kennzeichen) continue;
    if (!byVehicle.has(r.kennzeichen)) byVehicle.set(r.kennzeichen, []);
    byVehicle.get(r.kennzeichen)!.push(r);
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
        const isRegression = REGRESSION.has(a.sourceRowIndex) || REGRESSION.has(b.sourceRowIndex);
        if (import.meta.env.DEV && isRegression) {
          console.log('[RowLevelArbeitsstundenRestart] [RegressionCheck] Vehicle overlap:', {
            vehicle: a.kennzeichen,
            rowA: a.fahrtRowNumber, rowB: b.fahrtRowNumber,
            startA: a.finalStart, endA: a.finalEnd,
            startB: b.finalStart, endB: b.finalEnd,
            driverA: a.finalFahrername, driverB: b.finalFahrername,
            overlapSec: Math.round(overlapMs / 1000),
            typeA: a.assignmentType, typeB: b.assignmentType,
          });
        }
        if (entries.length < MAX_ENTRIES) {
          entries.push({
            type: 'vehicle',
            name: a.kennzeichen,
            rowA: a.fahrtRowNumber, excelRowA: a.excelRowNumber,
            rowB: b.fahrtRowNumber, excelRowB: b.excelRowNumber,
            startA: a.finalStart, endA: a.finalEnd,
            startB: b.finalStart, endB: b.finalEnd,
            vehicleA: a.kennzeichen, vehicleB: b.kennzeichen,
            driverA: a.finalFahrername, driverB: b.finalFahrername,
            overlapSec: Math.round(overlapMs / 1000),
            blockIdA: a.blockId, blockIdB: b.blockId,
            assignmentTypeA: a.assignmentType, assignmentTypeB: b.assignmentType,
            timeChangedA: a.timeChanged, timeChangedB: b.timeChanged,
          });
        }
      }
    }
  }

  // Regression pair checks
  const rowMap = new Map(finalRows.map(r => [r.sourceRowIndex, r]));
  const r99  = rowMap.get(99);
  const r100 = rowMap.get(100);
  const r340 = rowMap.get(340);
  const r366 = rowMap.get(366);

  const rowPair99_100Present =
    !!r99 && !!r100 &&
    r99.fahrtstatus === 'abgeschlossen' &&
    r100.fahrtstatus === 'abgeschlossen' &&
    r99.finalFahrername === r100.finalFahrername &&
    intervalsOverlap(r99.finalStartMs, r99.finalEndMs, r100.finalStartMs, r100.finalEndMs);

  const rowPair340_366Present =
    !!r340 && !!r366 &&
    r340.fahrtstatus === 'abgeschlossen' &&
    r366.fahrtstatus === 'abgeschlossen' &&
    r340.kennzeichen === r366.kennzeichen &&
    intervalsOverlap(r340.finalStartMs, r340.finalEndMs, r366.finalStartMs, r366.finalEndMs);

  if (import.meta.env.DEV) {
    console.log('[RowLevelArbeitsstundenRestart] Final worksheet validation:', {
      abgeschlossenRows: rows.length,
      driverOverlapCount,
      vehicleOverlapCount,
      isClean: driverOverlapCount === 0 && vehicleOverlapCount === 0,
      regressionA_99_100: rowPair99_100Present,
      regressionB_340_366: rowPair340_366Present,
      first20: entries.slice(0, 20),
    });
  }

  return {
    checkedRows: rows.length,
    driverOverlapCount,
    vehicleOverlapCount,
    entries,
    isClean: driverOverlapCount === 0 && vehicleOverlapCount === 0,
    regressionChecks: { rowPair99_100Present, rowPair340_366Present },
  };
}

// ── Exported alias for use in XLSX exporter ──────────────────────────────────

export function validateRowLevelOverlapsForExport(finalRows: FinalExportRow[]): RowLevelOverlapValidation {
  return validateRowLevelOverlaps(finalRows);
}

// ── Main engine ───────────────────────────────────────────────────────────────

export function runHistoricalArbeitsstundenRowLevelEngine(
  allTrips: FahrtenbuchTrip[],
  config: ArbeitsstundenEngineConfig,
): ArbeitsstundenEngineResult {
  const { month, year, regularTargets, inhaber, assignmentStrategy = 'hours_first' } = config;

  if (import.meta.env.DEV) {
    console.log('[RowLevelArbeitsstundenRestart] Starting engine:', {
      totalTrips: allTrips.length,
      month, year,
      regularDrivers: regularTargets.length,
      inhaberName: inhaber?.driverName ?? null,
    });
  }

  // ── Step 1: Categorize all trips ──────────────────────────────────────────
  const canceledTrips     = allTrips.filter(t => t.is_canceled);
  const abgeschlossenTrips = allTrips.filter(t => !t.is_canceled && isAbgeschlossen(t));
  const otherTrips        = allTrips.filter(t => !t.is_canceled && !isAbgeschlossen(t));

  // ── Step 2: Build vehicle blocks from abgeschlossen trips ──────────────────
  // Phase 1 uses the same logic as existing engine — only non-canceled trips
  const phase1 = buildVehicleBlocksForHistoricalWorkingHours(
    allTrips.filter(t => !t.is_canceled),
  );

  // Build ride lookup by blockId
  const ridesByBlockId = new Map<string, VehicleBlockRide[]>();
  for (const block of phase1.blocks) {
    ridesByBlockId.set(block.blockId, block.rides);
  }

  // Build tripId → blockId mapping
  const tripIdToBlockId = new Map<string, string>();
  for (const block of phase1.blocks) {
    for (const ride of block.rides) {
      tripIdToBlockId.set(ride.tripId, block.blockId);
    }
  }

  // ── Step 3: Initialize occupancy maps ─────────────────────────────────────
  const driverOccupied  = new Map<string, OccInterval[]>();
  const vehicleOccupied = new Map<string, OccInterval[]>();

  // ── Step 4: Regular driver assignment ─────────────────────────────────────
  const aResult = assignRegularDriversToVehicleBlocks(phase1, regularTargets, assignmentStrategy);

  // ── Step 4b: Validate and register regular assignments through shared occupancy ──
  // The clean engine checks driver-vs-driver overlaps but not vehicle overlaps.
  // Here we enforce both using the shared maps, processing assignments in
  // chronological order so early blocks win and late conflicting ones go to surplus.
  const rejectedRegularBlockIds = new Set<string>();

  const sortedAssignments = [...aResult.assignments].sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    return a.blockId.localeCompare(b.blockId);
  });

  for (const assignment of sortedAssignments) {
    const rides = ridesByBlockId.get(assignment.blockId) ?? [];

    // Internal block overlap check: if a block's own rides overlap, skip it
    if (blockHasInternalOverlap(rides)) {
      rejectedRegularBlockIds.add(assignment.blockId);
      if (import.meta.env.DEV) {
        console.log('[RowLevelPlacementFix] Regular block rejected: internal overlap', {
          blockId: assignment.blockId, vehicle: assignment.vehicle,
          driver: assignment.driverName, rides: rides.length,
        });
      }
      continue;
    }

    // Full occupancy check: driver + vehicle
    const conflict = canPlaceBlock(
      rides, assignment.vehicle, assignment.driverName, 0, driverOccupied, vehicleOccupied,
    );
    if (conflict) {
      rejectedRegularBlockIds.add(assignment.blockId);
      if (import.meta.env.DEV) {
        console.log('[RowLevelPlacementFix] Regular block rejected by occupancy:', {
          blockId: assignment.blockId, vehicle: assignment.vehicle,
          driver: assignment.driverName,
          driverConflict: conflict.driverConflict,
          vehicleConflict: conflict.vehicleConflict,
        });
      }
      continue;
    }

    // Accept: register in occupancy maps
    addBlockToOccupancy(rides, assignment.vehicle, assignment.driverName, 0, assignment.blockId, driverOccupied, vehicleOccupied);
  }

  // Build tripId → regular assignment map (only accepted assignments)
  const regularByTripId = new Map<string, { driverId: string; driverName: string; blockId: string }>();
  for (const assignment of aResult.assignments) {
    if (rejectedRegularBlockIds.has(assignment.blockId)) continue;
    const rides = ridesByBlockId.get(assignment.blockId) ?? [];
    for (const ride of rides) {
      regularByTripId.set(ride.tripId, {
        driverId: assignment.driverId,
        driverName: assignment.driverName,
        blockId: assignment.blockId,
      });
    }
  }

  if (import.meta.env.DEV) {
    console.log('[RowLevelPlacementFix] Regular assignment summary:', {
      total: aResult.assignments.length,
      accepted: aResult.assignments.length - rejectedRegularBlockIds.size,
      rejected: rejectedRegularBlockIds.size,
      rejectedIds: [...rejectedRegularBlockIds],
    });
  }

  // ── Step 5: Inhaber placement ─────────────────────────────────────────────
  const inhaberOriginalTripMap = new Map<string, string>(); // tripId → blockId
  const inhaberShiftedTripMap  = new Map<string, { blockId: string; offsetMs: number }>();
  const noSlotBlockIds         = new Set<string>();
  const invalidOriginalBlockIds = new Set<string>();

  if (inhaber) {
    // Include rejected regular blocks in the surplus for Inhaber placement
    const rejectedRegularBlocks = phase1.blocks.filter(b => rejectedRegularBlockIds.has(b.blockId));
    const surplusBlocks = [...aResult.surplusBlocks, ...rejectedRegularBlocks];

    // Filter out duplicates (in case a block appears in both)
    const seenSurplusIds = new Set<string>();
    const dedupedSurplus = surplusBlocks.filter(b => {
      if (seenSurplusIds.has(b.blockId)) return false;
      seenSurplusIds.add(b.blockId);
      return true;
    });

    if (import.meta.env.DEV && rejectedRegularBlocks.length > 0) {
      console.log('[RowLevelPlacementFix] Rejected regular blocks added to Inhaber surplus:', {
        count: rejectedRegularBlocks.length,
        blockIds: rejectedRegularBlocks.map(b => b.blockId),
      });
    }

    // Phase 3: Inhaber original-time
    const p3 = placeInhaberOriginalTime(
      dedupedSurplus,
      inhaber.driverName,
      ridesByBlockId,
      driverOccupied,
      vehicleOccupied,
    );

    for (const blockId of p3.invalidOriginalBlocks) invalidOriginalBlockIds.add(blockId);

    // Register original-time Inhaber rides and build tripId mapping
    for (const blockId of p3.originalTimeBlocks) {
      const rides = ridesByBlockId.get(blockId) ?? [];
      // Already added to occupancy maps in placeInhaberOriginalTime
      for (const ride of rides) {
        inhaberOriginalTripMap.set(ride.tripId, blockId);
      }
    }

    // Phase 4: Inhaber shift
    const blocksToShift = dedupedSurplus.filter(
      b => p3.needsShiftBlocks.has(b.blockId),
    );
    const p4 = shiftInhaberBlocks(
      blocksToShift,
      inhaber.driverName,
      ridesByBlockId,
      driverOccupied,
      vehicleOccupied,
      { month, year },
    );

    for (const [blockId, offsetMs] of p4.shiftedBlocks) {
      const rides = ridesByBlockId.get(blockId) ?? [];
      for (const ride of rides) {
        inhaberShiftedTripMap.set(ride.tripId, { blockId, offsetMs });
      }
    }

    for (const blockId of p4.noSlotBlockIds) noSlotBlockIds.add(blockId);

    if (import.meta.env.DEV) {
      console.log('[RowLevelPlacementFix] Placement summary:', {
        regularAccepted: aResult.assignments.length - rejectedRegularBlockIds.size,
        regularRejected: rejectedRegularBlockIds.size,
        inhaberOriginalBlocks: p3.originalTimeBlocks.size,
        inhaberNeedsShift: p3.needsShiftBlocks.size,
        inhaberShifted: p4.shiftedBlocks.size,
        noSlot: p4.noSlotBlockIds.size,
        invalidOriginal: p3.invalidOriginalBlocks.size,
        rejectedDriverSlots: p4.rejectedDriverSlots,
        rejectedVehicleSlots: p4.rejectedVehicleSlots,
      });
    }
  } else {
    // No inhaber: all surplus (including rejected regular) → no-slot / unassigned
    const allSurplus = [
      ...aResult.surplusBlocks,
      ...phase1.blocks.filter(b => rejectedRegularBlockIds.has(b.blockId)),
    ];
    for (const block of allSurplus) {
      if (block.status === 'invalid') {
        invalidOriginalBlockIds.add(block.blockId);
      } else {
        noSlotBlockIds.add(block.blockId);
      }
    }
  }

  // ── Step 6: Build FinalExportRow[] for ALL trips ──────────────────────────
  // Sort by source_row_index ascending
  const sortedTrips = [...allTrips].sort(
    (a, b) => (a.source_row_index ?? Infinity) - (b.source_row_index ?? Infinity),
  );

  const finalRows: FinalExportRow[] = [];

  for (const trip of sortedTrips) {
    // Canceled trips: keep original, not exportable
    if (trip.is_canceled) {
      const raw = (trip.raw_data_json ?? {}) as Record<string, unknown>;
      const origFahrername = resolveRawString(raw, DRIVER_KEYS) || trip.original_driver_name || '';
      const origStart = resolveFullDatetime(trip, 'start');
      const origEnd   = resolveFullDatetime(trip, 'end');
      const origStartMs = parseDatetimeMs(origStart);
      const origEndMs   = parseDatetimeMs(origEnd);
      const srcIdx = trip.source_row_index ?? 0;
      finalRows.push({
        fahrtRowNumber: srcIdx + 1,
        excelRowNumber: srcIdx + 2,
        sourceRowIndex: srcIdx,
        originalTripId: trip.id,
        blockId: tripIdToBlockId.get(trip.id) ?? null,
        fahrtstatus: getFahrtstatus(trip),
        originalFahrername: origFahrername,
        finalFahrername: origFahrername,
        kennzeichen: (trip.car_identifier ?? resolveRawString(raw, VEHICLE_KEYS)).trim(),
        originalStart: origStart,
        originalEnd: origEnd,
        finalStart: origStart,
        finalEnd: origEnd,
        originalStartMs: origStartMs,
        originalEndMs: origEndMs,
        finalStartMs: origStartMs,
        finalEndMs: origEndMs,
        durationMs: origEndMs > origStartMs ? origEndMs - origStartMs : 0,
        assignmentType: 'canceled',
        timeChanged: false,
        isExportable: false,
        validationStatus: 'canceled',
      });
      continue;
    }

    const tripId = trip.id;

    // Regular assignment
    const regAssign = regularByTripId.get(tripId);
    if (regAssign) {
      finalRows.push(buildRowForTrip(trip, 'regular', regAssign.blockId, regAssign.driverName, 0, 0, true));
      continue;
    }

    // Inhaber original-time
    const inhaberOrigBlockId = inhaberOriginalTripMap.get(tripId);
    if (inhaberOrigBlockId !== undefined && inhaber) {
      finalRows.push(buildRowForTrip(trip, 'inhaber_original', inhaberOrigBlockId, inhaber.driverName, 0, 0, true));
      continue;
    }

    // Inhaber shifted
    const shiftInfo = inhaberShiftedTripMap.get(tripId);
    if (shiftInfo && inhaber) {
      const origStartMs = parseDatetimeMs(resolveFullDatetime(trip, 'start'));
      const origEndMs   = parseDatetimeMs(resolveFullDatetime(trip, 'end'));
      const finalStartMs = origStartMs + shiftInfo.offsetMs;
      const finalEndMs   = origEndMs   + shiftInfo.offsetMs;
      finalRows.push(buildRowForTrip(trip, 'inhaber_shifted', shiftInfo.blockId, inhaber.driverName, finalStartMs, finalEndMs, true));
      continue;
    }

    // Invalid original block
    const blockId = tripIdToBlockId.get(tripId);
    if (blockId && invalidOriginalBlockIds.has(blockId)) {
      finalRows.push(buildRowForTrip(trip, 'invalid_original', blockId, '', 0, 0, false));
      continue;
    }

    // No-slot block — can't be exported cleanly
    if (blockId && noSlotBlockIds.has(blockId)) {
      finalRows.push(buildRowForTrip(trip, 'unassigned', blockId, '', 0, 0, false));
      continue;
    }

    // Fully unassigned (no block)
    finalRows.push(buildRowForTrip(trip, 'unassigned', null, '', 0, 0, false));
  }

  // Fix: for unassigned/invalid rows, finalFahrername should be originalFahrername
  // (these rows keep their original value in the XLSX)
  for (const row of finalRows) {
    if (!row.isExportable && row.finalFahrername === '') {
      row.finalFahrername = row.originalFahrername;
      row.finalStart = row.originalStart;
      row.finalEnd   = row.originalEnd;
      row.finalStartMs = row.originalStartMs;
      row.finalEndMs   = row.originalEndMs;
    }
  }

  // ── Step 7: Overlap validation on ALL abgeschlossen rows ──────────────────
  const overlapValidation = validateRowLevelOverlaps(finalRows);

  // ── Step 8: Export readiness ──────────────────────────────────────────────
  const unassignedRows      = finalRows.filter(r => r.assignmentType === 'unassigned').length;
  const noSlotCount         = noSlotBlockIds.size;
  const invalidOriginalRows = finalRows.filter(r => r.assignmentType === 'invalid_original').length;

  let exportBlockedReason: string | null = null;
  let exportBlockedReasonKey: EngineMessageKey | undefined;
  let exportBlockedReasonVars: EngineMessageVars | undefined;
  if (!overlapValidation.isClean) {
    exportBlockedReason = `Export blockiert: ${overlapValidation.driverOverlapCount} Fahrerüberschneidung(en), ${overlapValidation.vehicleOverlapCount} Fahrzeugüberschneidung(en) im erzeugten Fahrtenbuch gefunden.`;
    exportBlockedReasonKey = 'engine.rowLevel.exportBlocked.overlaps';
    exportBlockedReasonVars = {
      driverOverlaps: overlapValidation.driverOverlapCount,
      vehicleOverlaps: overlapValidation.vehicleOverlapCount,
    };
  } else if (noSlotCount > 0) {
    exportBlockedReason = `Export blockiert: ${noSlotCount} Inhaber-Block(s) konnten nicht sauber verschoben werden (kein freier Slot).`;
    exportBlockedReasonKey = 'engine.rowLevel.exportBlocked.noFreeSlot';
    exportBlockedReasonVars = { blocks: noSlotCount };
  } else if (unassignedRows > 0) {
    exportBlockedReason = `Export blockiert: ${unassignedRows} abgeschlossene Fahrt(en) sind nicht zugewiesen.`;
    exportBlockedReasonKey = 'engine.rowLevel.exportBlocked.unassignedRows';
    exportBlockedReasonVars = { rows: unassignedRows };
  }

  const isExportReady = exportBlockedReason === null;

  if (import.meta.env.DEV) {
    console.log('[RowLevelPlacementFix] Engine complete:', {
      totalTrips: allTrips.length,
      abgeschlossenTrips: abgeschlossenTrips.length,
      canceledTrips: canceledTrips.length,
      regularAssignedBlocks: aResult.assignments.length - rejectedRegularBlockIds.size,
      regularRejectedByOccupancy: rejectedRegularBlockIds.size,
      inhaberOriginalBlocks: inhaberOriginalTripMap.size > 0 ? [...new Set(inhaberOriginalTripMap.values())].length : 0,
      inhaberShiftedBlocks: inhaberShiftedTripMap.size > 0 ? [...new Set([...inhaberShiftedTripMap.values()].map(v => v.blockId))].length : 0,
      noSlotBlocks: noSlotCount,
      unassignedRows,
      invalidOriginalRows,
      driverOverlaps: overlapValidation.driverOverlapCount,
      vehicleOverlaps: overlapValidation.vehicleOverlapCount,
      isExportReady,
      exportBlockedReason,
      first20Overlaps: overlapValidation.entries.slice(0, 20),
    });
  }

  return {
    finalRows,
    totalTrips: allTrips.length,
    abgeschlossenTrips: abgeschlossenTrips.length,
    canceledTrips: canceledTrips.length,
    regularAssignedBlocks: aResult.assignments.length,
    inhaberOriginalBlocks: [...new Set(inhaberOriginalTripMap.values())].length,
    inhaberShiftedBlocks: [...new Set([...inhaberShiftedTripMap.values()].map(v => v.blockId))].length,
    noSlotBlocks: noSlotCount,
    unassignedRows,
    invalidOriginalRows,
    overlapValidation,
    phase1,
    isExportReady,
    exportBlockedReason,
    exportBlockedReasonKey,
    exportBlockedReasonVars,
  };
}

// ── Compatibility: build FinalExportOverlapResult from RowLevelOverlapValidation ──
// For use with existing XLSX exporter overlap guard

export interface FinalExportOverlapResultCompat {
  checkedRows: number;
  skippedRows: number;
  invalidTimeRows: number;
  driverOverlapCount: number;
  vehicleOverlapCount: number;
  entries: Array<{
    type: 'driver' | 'vehicle';
    name: string;
    rowA: number | null;
    rowB: number | null;
    startA: string; endA: string;
    startB: string; endB: string;
    vehicleA: string; vehicleB: string;
    driverA: string | null; driverB: string | null;
    overlapSec: number;
    blockIdA: string | null; blockIdB: string | null;
    assignmentTypeA: string; assignmentTypeB: string;
    timeChangedA: boolean; timeChangedB: boolean;
  }>;
}

export function toCompatOverlapResult(v: RowLevelOverlapValidation): FinalExportOverlapResultCompat {
  return {
    checkedRows: v.checkedRows,
    skippedRows: 0,
    invalidTimeRows: 0,
    driverOverlapCount: v.driverOverlapCount,
    vehicleOverlapCount: v.vehicleOverlapCount,
    entries: v.entries.map(e => ({
      type: e.type,
      name: e.name,
      rowA: e.rowA,
      rowB: e.rowB,
      startA: e.startA, endA: e.endA,
      startB: e.startB, endB: e.endB,
      vehicleA: e.vehicleA, vehicleB: e.vehicleB,
      driverA: e.driverA, driverB: e.driverB,
      overlapSec: e.overlapSec,
      blockIdA: e.blockIdA, blockIdB: e.blockIdB,
      assignmentTypeA: e.assignmentTypeA, assignmentTypeB: e.assignmentTypeB,
      timeChangedA: e.timeChangedA, timeChangedB: e.timeChangedB,
    })),
  };
}
