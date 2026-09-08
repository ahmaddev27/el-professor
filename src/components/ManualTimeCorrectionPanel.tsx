/**
 * ManualTimeCorrectionPanel — Inhaber-Überlauf lösen
 *
 * 4-Phase block-based assignment for the "Mit Arbeitsstunden" historical
 * working-hours reconciliation workflow.
 *
 * Phase 1 — Build valid vehicle blocks from ALL trips.
 * Phase 2 — Assign blocks to selected regular drivers (no time change, target-based).
 * Phase 3 — Assign all remaining surplus blocks to the owner/Ausgleichsfahrer.
 * Phase 4 — Detect owner driver overlaps; reschedule ONLY those overlapping owner blocks.
 *
 * Core invariants:
 *   – Regular driver blocks: driver name changes, times NEVER change.
 *   – Owner overflow blocks: same vehicle, same duration, same seconds, offset applied.
 *   – Full datetime strings preserved: "YYYY-MM-DD HH:mm:ss.SSS".
 *   – adjustment_type = "owner_overflow_block_v1" for DB records.
 *   – Anything without that type is treated as legacy and ignored.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Check, CheckCircle2, Clock,
  RefreshCw, X, XCircle, Info, ChevronDown, ChevronRight,
  Layers, Users, User,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { FahrtenbuchTrip } from '../hooks/useFahrtenbuch';

// ── Exported types ─────────────────────────────────────────────────────────────

export type AdjustmentStatus = 'proposal' | 'approved' | 'rejected' | 'invalid' | 'no_slot';

export interface TimeAdjustment {
  id?: string;
  companyId: string;
  reconciliationId: string;
  fahrtId: string;
  sourceRowIndex: number | null;
  date: string;
  driverName: string;
  originalDriverName: string;
  originalStartTime: string;
  originalEndTime: string;
  adjustedStartTime: string;
  adjustedEndTime: string;
  proposedDate: string;
  proposedDriverId: string;
  proposedDriverName: string;
  durationMinutes: number;
  durationSec: number;
  reason: string;
  failReason: string;
  status: AdjustmentStatus;
  conflicts: string[];
  impact: string;
  /** "owner_overflow_block_v1" for owner overflow shifts; "driver_block_assignment_v1" for regular assignment. */
  adjustment_type?: string;
}

export interface AllowedDriver {
  driverId: string;
  driverName: string;
  targetWorkSec: number;
  targetNightSec: number;
  targetNight0to4Sec: number;
  targetSunSec: number;
  targetHolSec: number;
}

// ── Internal types ─────────────────────────────────────────────────────────────

export interface BlockRide {
  fahrtId: string;
  sourceRowIndex: number | null;
  originalStartRaw: string;
  originalEndRaw: string;
  startSecOfDay: number;
  durationSec: number;
  originalDriverId: string;
  originalDriverName: string;
}

type BlockValidity = 'valid' | 'invalid';

export interface VehicleBlock {
  blockId: string;
  vehicle: string;
  date: string;
  rides: BlockRide[];
  originalBlockStartFull: string;
  originalBlockEndFull: string;
  originalBlockStartSecOfDay: number;
  originalBlockEndSecOfDay: number;
  blockDurationSec: number;
  originalSubMinSec: number;
  // Lohnart impact (seconds, based on original times)
  grundlohnSec: number;
  nacht25Sec: number;
  nacht40Sec: number;
  sonntagSec: number;
  validity: BlockValidity;
  invalidReason: string;
}

type OverflowStatus = 'pending' | 'proposal' | 'approved' | 'rejected' | 'no_slot';

export interface OwnerOverflowBlock {
  block: VehicleBlock;
  conflictsWithBlockIds: string[];
  proposedStartFull: string | null;
  proposedEndFull: string | null;
  offsetSec: number;
  status: OverflowStatus;
  failReason: string;
  dbId?: string;
}

export interface Phase2Rejection {
  blockId: string;
  vehicle: string;
  date: string;
  sourceRows: number[];
  rejectedDriverName: string;
  conflictBlockId: string;
  action: string;
}

interface PhaseState {
  blocks: VehicleBlock[];
  regularAssignments: Map<string, { driverId: string; driverName: string }>; // blockId → driver
  ownerBlocks: VehicleBlock[];
  overflowBlocks: OwnerOverflowBlock[];
  phase2Rejections: Phase2Rejection[];
  generated: boolean;
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface Props {
  reconciliationId: string;
  companyId: string;
  month: number;
  year: number;
  allTrips: FahrtenbuchTrip[];
  allowedDrivers: AllowedDriver[];
  inhaberDriverId: string;
  inhaberDriverName: string;
  existingAdjustments?: TimeAdjustment[];
  onApproved: (adjustments: TimeAdjustment[]) => void;
  onBack: () => void;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MONTHS_DE = [
  'Januar','Februar','März','April','Mai','Juni',
  'Juli','August','September','Oktober','November','Dezember',
];

const BLOCK_GAP_SEC  = 30 * 60;
const SLOT_INC_SEC   = 15 * 60;
const DAY_START_SEC  =  8 * 3600;
const DAY_END_SEC    = 18 * 3600;
const SECS_PER_DAY   = 86400;

// ── Raw datetime extraction ────────────────────────────────────────────────────

const RAW_START_COLS = [
  'Uhrzeit des Fahrtbeginns', 'uhrzeit des fahrtbeginns',
  'Fahrtbeginn', 'fahrtbeginn', 'startzeit', 'start_time', 'start time',
];
const RAW_END_COLS = [
  'Uhrzeit des Fahrtendes', 'uhrzeit des fahrtendes',
  'Fahrtende', 'fahrtende', 'endzeit', 'end_time', 'end time',
];

function extractFullDatetimeFromRaw(
  raw: Record<string, unknown> | null | undefined,
  candidates: string[],
): string | null {
  if (!raw) return null;
  for (const col of candidates) {
    if (col in raw) {
      const v = raw[col];
      if (v === null || v === undefined || v === '') continue;
      const s = String(v).trim();
      if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) return s;
    }
  }
  const lowerCands = candidates.map(c => c.toLowerCase().replace(/\s/g, ''));
  for (const [key, val] of Object.entries(raw)) {
    if (lowerCands.some(c => key.toLowerCase().replace(/\s/g, '').includes(c))) {
      const s = String(val ?? '').trim();
      if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) return s;
    }
  }
  return null;
}

// ── Datetime helpers ───────────────────────────────────────────────────────────

function parseSecOfDay(t: string): number {
  if (!t) return 0;
  const dtMatch = t.match(/[T ](\d{2}):(\d{2}):(\d{2})/);
  if (dtMatch) return +dtMatch[1] * 3600 + +dtMatch[2] * 60 + +dtMatch[3];
  const hmsMatch = t.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (hmsMatch) return +hmsMatch[1] * 3600 + +hmsMatch[2] * 60 + +hmsMatch[3];
  const hmMatch = t.match(/^(\d{2}):(\d{2})$/);
  if (hmMatch) return +hmMatch[1] * 3600 + +hmMatch[2] * 60;
  return 0;
}

function isFullDatetime(t: string): boolean {
  return /^\d{4}-\d{2}-\d{2}[T ]/.test(t);
}

function computeDurationSec(start: string, end: string): number {
  if (!start || !end) return 0;
  const s = parseSecOfDay(start);
  const e = parseSecOfDay(end);
  return e >= s ? e - s : SECS_PER_DAY - s + e;
}

function applyOffsetToDatetime(t: string, offsetSec: number): string {
  if (!t) return t;
  if (isFullDatetime(t)) {
    const dtMatch = t.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?/);
    if (!dtMatch) return t;
    const [, yr, mo, dy, hh, mm, ss, frac] = dtMatch;
    const fracStr = frac ?? '.000';
    const origSec = +hh * 3600 + +mm * 60 + +ss;
    const newTotalSec = origSec + offsetSec;
    const dayDelta = Math.floor(newTotalSec / SECS_PER_DAY);
    const secOfNewDay = ((newTotalSec % SECS_PER_DAY) + SECS_PER_DAY) % SECS_PER_DAY;
    const newH = Math.floor(secOfNewDay / 3600);
    const newM = Math.floor((secOfNewDay % 3600) / 60);
    const newS = secOfNewDay % 60;
    const origDate = new Date(`${yr}-${mo}-${dy}T00:00:00Z`);
    origDate.setUTCDate(origDate.getUTCDate() + dayDelta);
    const sep = t.includes('T') ? 'T' : ' ';
    return `${origDate.getUTCFullYear()}-${String(origDate.getUTCMonth()+1).padStart(2,'0')}-${String(origDate.getUTCDate()).padStart(2,'0')}${sep}${String(newH).padStart(2,'0')}:${String(newM).padStart(2,'0')}:${String(newS).padStart(2,'0')}${fracStr}`;
  }
  const hmsMatch = t.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (hmsMatch) {
    const origSec = +hmsMatch[1] * 3600 + +hmsMatch[2] * 60 + +hmsMatch[3];
    const norm = ((origSec + offsetSec) % SECS_PER_DAY + SECS_PER_DAY) % SECS_PER_DAY;
    return `${String(Math.floor(norm/3600)).padStart(2,'0')}:${String(Math.floor((norm%3600)/60)).padStart(2,'0')}:${String(norm%60).padStart(2,'0')}`;
  }
  const hmMatch = t.match(/^(\d{2}):(\d{2})$/);
  if (hmMatch) {
    const origSec = +hmMatch[1] * 3600 + +hmMatch[2] * 60;
    const norm = ((origSec + offsetSec) % SECS_PER_DAY + SECS_PER_DAY) % SECS_PER_DAY;
    return `${String(Math.floor(norm/3600)).padStart(2,'0')}:${String(Math.floor((norm%3600)/60)).padStart(2,'0')}`;
  }
  return t;
}

function secOfDayToHMS(s: number): string {
  const norm = ((s % SECS_PER_DAY) + SECS_PER_DAY) % SECS_PER_DAY;
  return `${String(Math.floor(norm/3600)).padStart(2,'0')}:${String(Math.floor((norm%3600)/60)).padStart(2,'0')}:${String(norm%60).padStart(2,'0')}`;
}

function overlapsRange(aStart: number, aDur: number, bStart: number, bDur: number): boolean {
  return aStart < bStart + bDur && aStart + aDur > bStart;
}

// ── Lohnart helpers ────────────────────────────────────────────────────────────

function nightSecsInInterval(startSec: number, durSec: number): number {
  const end = startSec + durSec;
  const ov = (lo: number, hi: number) => Math.max(0, Math.min(end, hi) - Math.max(startSec, lo));
  return ov(23*3600, 24*3600) + ov(4*3600, 6*3600) + ov(24*3600, 25*3600) + ov(28*3600, 30*3600);
}

function nacht40SecsInInterval(startSec: number, durSec: number): number {
  const end = startSec + durSec;
  const ov = (lo: number, hi: number) => Math.max(0, Math.min(end, hi) - Math.max(startSec, lo));
  return ov(0, 4*3600) + ov(24*3600, 28*3600);
}

function isSunday(date: string): boolean {
  return new Date(date + 'T12:00:00').getDay() === 0;
}

// ── Phase 1: Build vehicle blocks ─────────────────────────────────────────────

export function buildVehicleBlocks(allTrips: FahrtenbuchTrip[]): VehicleBlock[] {
  const active = allTrips.filter(t => !t.is_canceled && t.start_time && t.end_time && t.car_identifier);

  // Group by vehicle + date
  const grouped = new Map<string, FahrtenbuchTrip[]>();
  for (const trip of active) {
    const key = `${trip.car_identifier}|${trip.trip_date}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(trip);
  }

  const blocks: VehicleBlock[] = [];

  for (const [key, trips] of grouped) {
    const [vehicle, date] = key.split('|');

    // Sort by original full start datetime
    const withFull = trips.map(trip => {
      const raw = trip.raw_data_json as Record<string, unknown> | null | undefined;
      const startFull = extractFullDatetimeFromRaw(raw, RAW_START_COLS) ?? trip.start_time ?? '';
      const endFull   = extractFullDatetimeFromRaw(raw, RAW_END_COLS)   ?? trip.end_time   ?? '';
      return { trip, startFull, endFull, startSec: parseSecOfDay(startFull) };
    });
    withFull.sort((a, b) => a.startSec - b.startSec);

    // Chain into blocks
    let chain: typeof withFull = [withFull[0]];
    const flush = () => {
      blocks.push(chainToVehicleBlock(chain, vehicle, date));
      chain = [];
    };
    for (let i = 1; i < withFull.length; i++) {
      const prev = chain[chain.length - 1];
      const prevEndSec = prev.startSec + computeDurationSec(prev.startFull, prev.endFull);
      const currStartSec = withFull[i].startSec;
      if (currStartSec - prevEndSec <= BLOCK_GAP_SEC) {
        chain.push(withFull[i]);
      } else {
        flush();
        chain = [withFull[i]];
      }
    }
    flush();
  }

  return blocks;
}

function chainToVehicleBlock(
  chain: Array<{ trip: FahrtenbuchTrip; startFull: string; endFull: string; startSec: number }>,
  vehicle: string,
  date: string,
): VehicleBlock {
  const rides: BlockRide[] = chain.map(({ trip, startFull, endFull, startSec }) => ({
    fahrtId: trip.id,
    sourceRowIndex: trip.source_row_index ?? null,
    originalStartRaw: startFull,
    originalEndRaw: endFull,
    startSecOfDay: startSec,
    durationSec: computeDurationSec(startFull, endFull),
    originalDriverId: trip.original_driver_id ?? '',
    originalDriverName: trip.original_driver_name ?? '',
  }));

  const invalidReasons: string[] = [];

  for (const ride of rides) {
    if (!ride.originalStartRaw || !ride.originalEndRaw) invalidReasons.push('Fehlende Zeitangabe');
    if (ride.durationSec <= 0) invalidReasons.push(`Fahrt ${ride.fahrtId.slice(-6)}: Dauer ≤ 0`);
  }

  // Check internal vehicle overlaps
  for (let i = 0; i < rides.length; i++) {
    for (let j = i + 1; j < rides.length; j++) {
      if (overlapsRange(rides[i].startSecOfDay, rides[i].durationSec, rides[j].startSecOfDay, rides[j].durationSec)) {
        invalidReasons.push(`Fahrzeug-Überschneidung im Originalblock: Zeile ${rides[i].sourceRowIndex ?? i} ∩ Zeile ${rides[j].sourceRowIndex ?? j}`);
        break;
      }
    }
    if (invalidReasons.some(r => r.startsWith('Fahrzeug-Überschneidung'))) break;
  }

  const blockStartSec = rides[0].startSecOfDay;
  const lastRide = rides[rides.length - 1];
  const blockEndSec = lastRide.startSecOfDay + lastRide.durationSec;
  const blockDurationSec = blockEndSec - blockStartSec;
  const originalSubMinSec = blockStartSec % 60;
  const blockId = `${vehicle}|${date}|${blockStartSec}`;

  // Lohnart impact based on original times
  const grundlohnSec = blockDurationSec;
  const nacht25Sec   = nightSecsInInterval(blockStartSec, blockDurationSec);
  const nacht40Sec   = nacht40SecsInInterval(blockStartSec, blockDurationSec);
  const sonntagSec   = isSunday(date) ? blockDurationSec : 0;

  return {
    blockId, vehicle, date, rides,
    originalBlockStartFull: rides[0].originalStartRaw,
    originalBlockEndFull: lastRide.originalEndRaw,
    originalBlockStartSecOfDay: blockStartSec,
    originalBlockEndSecOfDay: blockEndSec,
    blockDurationSec, originalSubMinSec,
    grundlohnSec, nacht25Sec, nacht40Sec, sonntagSec,
    validity: invalidReasons.length > 0 ? 'invalid' : 'valid',
    invalidReason: invalidReasons.join(' · '),
  };
}

// ── Phase 2: Assign blocks to regular drivers ─────────────────────────────────

/** Strict half-open interval overlap: [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅ */
export function overlapsMs(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Parse a full "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM:SS" string to UTC epoch ms. */
export function parseFullDatetimeMs(t: string): number {
  if (!t) return 0;
  // Normalise: replace space separator with T, strip fractional seconds
  const iso = t.replace(' ', 'T').replace(/(\.\d+)?$/, 'Z');
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? 0 : ms;
}

/** ms since UTC epoch for midnight of a YYYY-MM-DD date string */
export function dateMidnightMs(date: string): number {
  return new Date(date + 'T00:00:00Z').getTime();
}

interface OccupiedInterval {
  startMs: number;
  endMs: number;
  blockId: string;
}

interface DriverAssignmentState {
  driverId: string;
  driverName: string;
  targetWorkSec: number;
  targetNacht25Sec: number;
  targetNacht40Sec: number;
  targetSunSec: number;
  assignedWorkSec: number;
  assignedNacht25Sec: number;
  assignedNacht40Sec: number;
  assignedSunSec: number;
  /** One entry per ride already assigned to this driver (absolute ms intervals). */
  occupied: OccupiedInterval[];
}

/**
 * Build a list of ride-level absolute-ms intervals for a block.
 * Uses block.date midnight as the epoch base + ride.startSecOfDay * 1000.
 * For cross-midnight rides (durationSec takes ride past midnight) the end can
 * exceed the base day — this is handled naturally.
 */
function blockRideIntervals(block: VehicleBlock): Array<{ startMs: number; endMs: number }> {
  const baseDayMs = dateMidnightMs(block.date);
  return block.rides.map(ride => {
    const startMs = baseDayMs + ride.startSecOfDay * 1000;
    const endMs   = startMs + ride.durationSec * 1000;
    return { startMs, endMs };
  });
}

export function assignBlocksToRegularDrivers(
  validBlocks: VehicleBlock[],
  allowedDrivers: AllowedDriver[],
): { assignments: Map<string, { driverId: string; driverName: string }>; rejections: Phase2Rejection[] } {
  const assignments = new Map<string, { driverId: string; driverName: string }>();
  const rejections: Phase2Rejection[] = [];

  const driverStates: DriverAssignmentState[] = allowedDrivers.map(d => ({
    driverId: d.driverId,
    driverName: d.driverName,
    targetWorkSec: d.targetWorkSec,
    targetNacht25Sec: d.targetNightSec - d.targetNight0to4Sec,
    targetNacht40Sec: d.targetNight0to4Sec,
    targetSunSec: d.targetSunSec,
    assignedWorkSec: 0,
    assignedNacht25Sec: 0,
    assignedNacht40Sec: 0,
    assignedSunSec: 0,
    occupied: [],
  }));

  // Sort blocks: prioritise those with special Lohnarten (night/sunday) first
  const sorted = [...validBlocks].sort((a, b) => {
    const specA = a.nacht25Sec + a.nacht40Sec + a.sonntagSec;
    const specB = b.nacht25Sec + b.nacht40Sec + b.sonntagSec;
    if (specB !== specA) return specB - specA;
    return a.originalBlockStartSecOfDay - b.originalBlockStartSecOfDay;
  });

  for (const block of sorted) {
    // Build candidate ride intervals for this block (ride-level, absolute ms)
    const candidateIntervals = blockRideIntervals(block);

    let bestDriver: DriverAssignmentState | null = null;
    let bestScore = -Infinity;
    let firstRejectDriver: DriverAssignmentState | null = null;
    let firstRejectConflict = '';

    for (const driver of driverStates) {
      // Check if driver still needs hours
      const remainingWork = driver.targetWorkSec - driver.assignedWorkSec;
      if (remainingWork <= 0) continue;

      // Ride-level overlap check: any candidate ride must not overlap any existing driver ride
      let conflictSlot: OccupiedInterval | undefined;
      outer: for (const ci of candidateIntervals) {
        for (const slot of driver.occupied) {
          if (overlapsMs(ci.startMs, ci.endMs, slot.startMs, slot.endMs)) {
            conflictSlot = slot;
            break outer;
          }
        }
      }

      if (conflictSlot) {
        if (!firstRejectDriver) {
          firstRejectDriver = driver;
          firstRejectConflict = conflictSlot.blockId;
        }
        continue;
      }

      // Score: how well does this block serve the driver's needs?
      const workFit = Math.min(block.grundlohnSec, Math.max(0, remainingWork));
      const n25Fit  = Math.min(block.nacht25Sec, Math.max(0, driver.targetNacht25Sec - driver.assignedNacht25Sec));
      const n40Fit  = Math.min(block.nacht40Sec, Math.max(0, driver.targetNacht40Sec - driver.assignedNacht40Sec));
      const sunFit  = Math.min(block.sonntagSec, Math.max(0, driver.targetSunSec - driver.assignedSunSec));
      const score   = workFit * 1 + n25Fit * 3 + n40Fit * 4 + sunFit * 3;

      if (score > bestScore) { bestScore = score; bestDriver = driver; }
    }

    if (bestDriver) {
      assignments.set(block.blockId, { driverId: bestDriver.driverId, driverName: bestDriver.driverName });
      bestDriver.assignedWorkSec    += block.grundlohnSec;
      bestDriver.assignedNacht25Sec += block.nacht25Sec;
      bestDriver.assignedNacht40Sec += block.nacht40Sec;
      bestDriver.assignedSunSec     += block.sonntagSec;
      // Record every ride interval into the driver's occupied list
      for (const ci of candidateIntervals) {
        bestDriver.occupied.push({ startMs: ci.startMs, endMs: ci.endMs, blockId: block.blockId });
      }
    } else if (firstRejectDriver) {
      // All regular drivers rejected — record first reason for diagnostic
      rejections.push({
        blockId: block.blockId,
        vehicle: block.vehicle,
        date: block.date,
        sourceRows: block.rides.map(r => r.sourceRowIndex ?? 0),
        rejectedDriverName: firstRejectDriver.driverName,
        conflictBlockId: firstRejectConflict,
        action: 'An Inhaber-Überlauf verschoben',
      });
    }
  }

  return { assignments, rejections };
}

// ── Phase 4: Find owner overflow slots ────────────────────────────────────────

interface OccSlot { startSecOfDay: number; durationSec: number }

export function detectOwnerOverlaps(ownerBlocks: VehicleBlock[]): OwnerOverflowBlock[] {
  // Group by date
  const byDate = new Map<string, VehicleBlock[]>();
  for (const b of ownerBlocks) {
    if (!byDate.has(b.date)) byDate.set(b.date, []);
    byDate.get(b.date)!.push(b);
  }

  const overlapSet = new Set<string>();
  const conflictMap = new Map<string, string[]>();

  for (const [, blocks] of byDate) {
    const sorted = [...blocks].sort((a, b) => a.originalBlockStartSecOfDay - b.originalBlockStartSecOfDay);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i], b = sorted[j];
        if (overlapsRange(a.originalBlockStartSecOfDay, a.blockDurationSec, b.originalBlockStartSecOfDay, b.blockDurationSec)) {
          overlapSet.add(a.blockId);
          overlapSet.add(b.blockId);
          if (!conflictMap.has(a.blockId)) conflictMap.set(a.blockId, []);
          if (!conflictMap.has(b.blockId)) conflictMap.set(b.blockId, []);
          conflictMap.get(a.blockId)!.push(b.blockId);
          conflictMap.get(b.blockId)!.push(a.blockId);
        }
      }
    }
  }

  return ownerBlocks
    .filter(b => overlapSet.has(b.blockId))
    .map(b => ({
      block: b,
      conflictsWithBlockIds: conflictMap.get(b.blockId) ?? [],
      proposedStartFull: null,
      proposedEndFull: null,
      offsetSec: 0,
      status: 'pending' as OverflowStatus,
      failReason: '',
    }));
}

export function findOwnerOverflowSlots(
  overflowBlocks: OwnerOverflowBlock[],
  allTrips: FahrtenbuchTrip[],
  regularAssignments: Map<string, { driverId: string; driverName: string }>,
  ownerBlocks: VehicleBlock[],
  inhaberDriverId: string,
): OwnerOverflowBlock[] {
  // Build vehicle occupancy from all NON-overflow owner blocks + regular blocks (original times)
  const vehicleOcc = new Map<string, Map<string, OccSlot[]>>(); // vehicle → date → slots
  const ownerOcc   = new Map<string, OccSlot[]>();              // date → owner slots

  const addVehicleSlot = (vehicle: string, date: string, slot: OccSlot) => {
    if (!vehicleOcc.has(vehicle)) vehicleOcc.set(vehicle, new Map());
    const byDate = vehicleOcc.get(vehicle)!;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(slot);
  };

  // All trips → vehicle occupancy (exclude overflow fahrtIds initially)
  const overflowFahrtIds = new Set(overflowBlocks.flatMap(ob => ob.block.rides.map(r => r.fahrtId)));
  for (const trip of allTrips) {
    if (trip.is_canceled || !trip.start_time || !trip.end_time || !trip.car_identifier) continue;
    if (overflowFahrtIds.has(trip.id)) continue;
    const raw = trip.raw_data_json as Record<string, unknown> | null | undefined;
    const startFull = extractFullDatetimeFromRaw(raw, RAW_START_COLS) ?? trip.start_time;
    const durSec = computeDurationSec(startFull, extractFullDatetimeFromRaw(raw, RAW_END_COLS) ?? trip.end_time);
    addVehicleSlot(trip.car_identifier, trip.trip_date, { startSecOfDay: parseSecOfDay(startFull), durationSec: durSec });
  }

  // Non-overflow owner blocks → owner occupancy
  const overflowBlockIds = new Set(overflowBlocks.map(ob => ob.block.blockId));
  for (const b of ownerBlocks) {
    if (overflowBlockIds.has(b.blockId)) continue;
    const occ = ownerOcc.get(b.date) ?? [];
    if (!ownerOcc.has(b.date)) ownerOcc.set(b.date, occ);
    occ.push({ startSecOfDay: b.originalBlockStartSecOfDay, durationSec: b.blockDurationSec });
  }

  // Process each overflow block
  const resolved: OwnerOverflowBlock[] = [...overflowBlocks];

  for (let idx = 0; idx < resolved.length; idx++) {
    const ob = resolved[idx];
    const block = ob.block;
    const dur = block.blockDurationSec;
    const subMinSec = block.originalSubMinSec;
    const vehicle = block.vehicle;
    const date = block.date;

    // Candidate start times: daytime first, then early morning
    const candidateBaseMins: number[] = [];
    for (let m = Math.floor(DAY_START_SEC/60); m <= Math.floor(DAY_END_SEC/60); m += SLOT_INC_SEC/60) candidateBaseMins.push(m);
    for (let m = 0; m < Math.floor(DAY_START_SEC/60); m += SLOT_INC_SEC/60) candidateBaseMins.push(m);

    let found: { startSec: number } | null = null;
    for (const baseMins of candidateBaseMins) {
      const candidateStart = baseMins * 60 + subMinSec;

      // Check vehicle slot free
      const vSlots = vehicleOcc.get(vehicle)?.get(date) ?? [];
      if (vSlots.some(s => overlapsRange(candidateStart, dur, s.startSecOfDay, s.durationSec))) continue;

      // Check owner not already occupied at this slot
      const oSlots = ownerOcc.get(date) ?? [];
      if (oSlots.some(s => overlapsRange(candidateStart, dur, s.startSecOfDay, s.durationSec))) continue;

      found = { startSec: candidateStart };
      break;
    }

    if (!found) {
      resolved[idx] = { ...ob, status: 'no_slot', failReason: 'Kein freier Inhaber-Zeitraum gefunden' };
    } else {
      const offsetSec = found.startSec - block.originalBlockStartSecOfDay;
      const proposedStartFull = applyOffsetToDatetime(block.originalBlockStartFull, offsetSec);
      const proposedEndFull   = applyOffsetToDatetime(block.originalBlockEndFull,   offsetSec);
      resolved[idx] = { ...ob, status: 'proposal', offsetSec, proposedStartFull, proposedEndFull, failReason: '' };

      // Register in occupancy so subsequent blocks see this slot
      addVehicleSlot(vehicle, date, { startSecOfDay: found.startSec, durationSec: dur });
      const oSlots = ownerOcc.get(date) ?? [];
      if (!ownerOcc.has(date)) ownerOcc.set(date, oSlots);
      oSlots.push({ startSecOfDay: found.startSec, durationSec: dur });
    }
  }

  return resolved;
}

// ── Expand to TimeAdjustment[] ────────────────────────────────────────────────

export function expandToAdjustments(
  blocks: VehicleBlock[],
  regularAssignments: Map<string, { driverId: string; driverName: string }>,
  ownerBlocks: VehicleBlock[],
  overflowBlocks: OwnerOverflowBlock[],
  inhaberDriverId: string,
  inhaberDriverName: string,
  companyId: string,
  reconciliationId: string,
): TimeAdjustment[] {
  const adjustments: TimeAdjustment[] = [];
  const approvedOverflow = new Map(
    overflowBlocks.filter(ob => ob.status === 'approved').map(ob => [ob.block.blockId, ob]),
  );

  // Invalid blocks → emit invalid_original_block entries (status: 'invalid', times unchanged)
  for (const block of blocks) {
    if (block.validity !== 'invalid') continue;
    for (const ride of block.rides) {
      adjustments.push({
        companyId,
        reconciliationId,
        fahrtId: ride.fahrtId,
        sourceRowIndex: ride.sourceRowIndex,
        date: block.date,
        driverName: ride.originalDriverName,
        originalDriverName: ride.originalDriverName,
        originalStartTime: ride.originalStartRaw,
        originalEndTime: ride.originalEndRaw,
        adjustedStartTime: ride.originalStartRaw,
        adjustedEndTime: ride.originalEndRaw,
        proposedDate: block.date,
        proposedDriverId: '',
        proposedDriverName: '',
        durationMinutes: Math.round(ride.durationSec / 60),
        durationSec: ride.durationSec,
        reason: `Block ${block.blockId}`,
        failReason: block.invalidReason,
        status: 'invalid' as AdjustmentStatus,
        conflicts: [],
        impact: '',
        adjustment_type: 'invalid_original_block',
      });
    }
  }

  // Valid blocks → one approved adjustment per ride
  for (const block of blocks) {
    if (block.validity === 'invalid') continue;

    const regularDriver = regularAssignments.get(block.blockId);
    const isOwnerBlock = !regularDriver;
    const overflow = approvedOverflow.get(block.blockId);

    const assignedDriverId   = regularDriver?.driverId   ?? inhaberDriverId;
    const assignedDriverName = regularDriver?.driverName ?? inhaberDriverName;
    const isOverflow = isOwnerBlock && !!overflow;

    const offsetSec = isOverflow ? overflow!.offsetSec : 0;
    const adjType = isOverflow ? 'owner_overflow_block_v1' : 'driver_block_assignment_v1';

    for (const ride of block.rides) {
      const adjustedStartTime = isOverflow
        ? applyOffsetToDatetime(ride.originalStartRaw, offsetSec)
        : ride.originalStartRaw;
      const adjustedEndTime = isOverflow
        ? applyOffsetToDatetime(ride.originalEndRaw, offsetSec)
        : ride.originalEndRaw;

      adjustments.push({
        companyId,
        reconciliationId,
        fahrtId: ride.fahrtId,
        sourceRowIndex: ride.sourceRowIndex,
        date: block.date,
        driverName: assignedDriverName,
        originalDriverName: ride.originalDriverName,
        originalStartTime: ride.originalStartRaw,
        originalEndTime: ride.originalEndRaw,
        adjustedStartTime,
        adjustedEndTime,
        proposedDate: block.date,
        proposedDriverId: assignedDriverId,
        proposedDriverName: assignedDriverName,
        durationMinutes: Math.round(ride.durationSec / 60),
        durationSec: ride.durationSec,
        reason: `Block ${block.blockId}`,
        failReason: '',
        status: 'approved' as AdjustmentStatus,
        conflicts: [],
        impact: isOverflow ? `Inhaber-Überlauf: +${offsetSec}s` : '',
        adjustment_type: adjType,
      });
    }
  }

  return adjustments;
}

// ── Confirm modal ──────────────────────────────────────────────────────────────

function ConfirmModal({ count, onConfirm, onCancel }: { count: number; onConfirm: () => void; onCancel: () => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div className="rounded-2xl p-6 max-w-md w-full mx-4 space-y-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2">
          <div className="rounded-xl p-2" style={{ background: 'rgba(234,179,8,0.1)' }}>
            <Clock size={18} style={{ color: '#a16207' }} />
          </div>
          <h3 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>Inhaber-Überlauf-Korrekturen bestätigen</h3>
        </div>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Originaldaten bleiben erhalten. Nur der Zeitraum der überlappenden Inhaber-Blöcke wird im Export angepasst.
        </p>
        <div className="px-3 py-2 rounded-xl text-xs" style={{ background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.2)', color: '#a16207' }}>
          {count} Inhaber-Überlauf-Block{count !== 1 ? 'e' : ''} werden genehmigt.
        </div>
        <label className="flex items-start gap-2 cursor-pointer">
          <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} className="mt-0.5 w-4 h-4" />
          <span className="text-xs" style={{ color: 'var(--text-primary)' }}>
            Ich habe die Inhaber-Überlauf-Zeitkorrekturen geprüft und bestätige die Verwendung im historischen Abgleich.
          </span>
        </label>
        <div className="flex gap-2 justify-end pt-1">
          <button onClick={onCancel}
            className="px-4 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80"
            style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
            Abbrechen
          </button>
          <button onClick={onConfirm} disabled={!checked}
            className="px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-110 disabled:opacity-40"
            style={{ background: '#a16207', color: '#fff' }}>
            Bestätigen
          </button>
        </div>
      </div>
    </div>
  );
}

function OverflowStatusBadge({ status }: { status: OverflowStatus }) {
  if (status === 'no_slot') return <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(220,38,38,0.1)', color: '#b91c1c' }}>Kein Slot</span>;
  if (status === 'approved') return <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(21,128,61,0.1)', color: '#15803d' }}>Genehmigt</span>;
  if (status === 'rejected') return <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(100,116,139,0.1)', color: '#64748b' }}>Abgelehnt</span>;
  if (status === 'proposal') return <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(234,179,8,0.1)', color: '#a16207' }}>Vorschlag</span>;
  return <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(100,116,139,0.1)', color: '#64748b' }}>Ausstehend</span>;
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function ManualTimeCorrectionPanel({
  reconciliationId,
  companyId,
  month,
  year,
  allTrips: allTripsProp,
  allowedDrivers,
  inhaberDriverId,
  inhaberDriverName,
  existingAdjustments = [],
  onApproved,
  onBack,
}: Props) {
  const { user } = useAuth();
  const allTrips: FahrtenbuchTrip[] = Array.isArray(allTripsProp) ? allTripsProp : [];

  const [phase, setPhase] = useState<PhaseState>({
    blocks: [], regularAssignments: new Map(), ownerBlocks: [], overflowBlocks: [], phase2Rejections: [], generated: false,
  });
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [expandedBlockId, setExpandedBlockId] = useState<string | null>(null);
  const [legacyIgnored, setLegacyIgnored] = useState(false);
  const [resetting, setResetting] = useState(false);
  const generateAbortRef = useRef(false);

  // ── Seed from existing adjustments (owner_overflow_block_v1 only) ──────────

  useEffect(() => {
    const valid = existingAdjustments.filter(a => a.adjustment_type === 'owner_overflow_block_v1');
    const hadLegacy = valid.length < existingAdjustments.length && existingAdjustments.length > 0;
    if (hadLegacy) setLegacyIgnored(true);
    if (valid.length === 0 || allTrips.length === 0) return;

    // Rebuild block structure from current trips
    const blocks = buildVehicleBlocks(allTrips);
    const validBlocks = blocks.filter(b => b.validity === 'valid');
    const { assignments: regularAssignments } = assignBlocksToRegularDrivers(validBlocks, allowedDrivers);
    const ownerBlocks = validBlocks.filter(b => !regularAssignments.has(b.blockId));

    // Restore overflow block statuses from saved adjustments
    const overflowCandidates = detectOwnerOverlaps(ownerBlocks);
    const adjByFahrtId = new Map(valid.map(a => [a.fahrtId, a]));
    const restored: OwnerOverflowBlock[] = overflowCandidates.map(ob => {
      const firstAdj = adjByFahrtId.get(ob.block.rides[0]?.fahrtId);
      if (!firstAdj) return ob;
      if (firstAdj.status === 'approved' && isFullDatetime(firstAdj.adjustedStartTime)) {
        const offsetSec = parseSecOfDay(firstAdj.adjustedStartTime) - parseSecOfDay(firstAdj.originalStartTime);
        return {
          ...ob,
          status: 'approved' as OverflowStatus,
          offsetSec,
          proposedStartFull: firstAdj.adjustedStartTime,
          proposedEndFull: firstAdj.adjustedEndTime,
        };
      }
      return ob;
    });

    setPhase({ blocks, regularAssignments, ownerBlocks, overflowBlocks: restored, phase2Rejections: [], generated: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Reset stored adjustments ───────────────────────────────────────────────

  const handleReset = useCallback(async () => {
    if (!reconciliationId) return;
    setResetting(true);
    try {
      await supabase.from('historical_time_adjustments').delete().eq('reconciliation_id', reconciliationId);
      await supabase.from('historical_block_adjustments').delete().eq('reconciliation_id', reconciliationId);
      setPhase({ blocks: [], regularAssignments: new Map(), ownerBlocks: [], overflowBlocks: [], phase2Rejections: [], generated: false });
      setLegacyIgnored(false);
      setSaveError(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Fehler beim Zurücksetzen');
    } finally {
      setResetting(false);
    }
  }, [reconciliationId]);

  // ── Run all 4 phases ───────────────────────────────────────────────────────

  const handleGenerate = useCallback(async () => {
    if (allTrips.length === 0) return;
    setGenerating(true);
    generateAbortRef.current = false;
    await new Promise<void>(r => setTimeout(r, 0));

    // Phase 1
    const blocks = buildVehicleBlocks(allTrips);
    if (generateAbortRef.current) { setGenerating(false); return; }
    await new Promise<void>(r => setTimeout(r, 0));

    const validBlocks = blocks.filter(b => b.validity === 'valid');

    // Phase 2
    const { assignments: regularAssignments, rejections: phase2Rejections } = assignBlocksToRegularDrivers(validBlocks, allowedDrivers);
    if (generateAbortRef.current) { setGenerating(false); return; }

    // Phase 3
    const ownerBlocks = validBlocks.filter(b => !regularAssignments.has(b.blockId));
    await new Promise<void>(r => setTimeout(r, 0));

    // Phase 4
    const overflowCandidates = detectOwnerOverlaps(ownerBlocks);
    const overflowBlocks = overflowCandidates.length > 0
      ? findOwnerOverflowSlots(overflowCandidates, allTrips, regularAssignments, ownerBlocks, inhaberDriverId)
      : [];

    setPhase({ blocks, regularAssignments, ownerBlocks, overflowBlocks, phase2Rejections, generated: true });
    setGenerating(false);
  }, [allTrips, allowedDrivers, inhaberDriverId]);

  // ── Approve / reject overflow ──────────────────────────────────────────────

  const approveOverflow = (blockId: string) => {
    setPhase(prev => ({
      ...prev,
      overflowBlocks: prev.overflowBlocks.map(ob =>
        ob.block.blockId === blockId && ob.status === 'proposal' ? { ...ob, status: 'approved' } : ob,
      ),
    }));
  };

  const rejectOverflow = (blockId: string) => {
    setPhase(prev => ({
      ...prev,
      overflowBlocks: prev.overflowBlocks.map(ob =>
        ob.block.blockId === blockId ? { ...ob, status: 'rejected' } : ob,
      ),
    }));
  };

  const approveAllOverflow = () => {
    setPhase(prev => ({
      ...prev,
      overflowBlocks: prev.overflowBlocks.map(ob =>
        ob.status === 'proposal' ? { ...ob, status: 'approved' } : ob,
      ),
    }));
  };

  // ── Persist + apply ────────────────────────────────────────────────────────

  const persistAndApply = useCallback(async () => {
    setSaving(true); setSaveError(null);
    try {
      const now = new Date().toISOString();

      if (reconciliationId) {
        for (const ob of phase.overflowBlocks.filter(ob => ob.status === 'approved' || ob.status === 'rejected')) {
          const row = {
            company_id: companyId,
            reconciliation_id: reconciliationId,
            block_id: ob.block.blockId,
            fahrt_ids: ob.block.rides.map(r => r.fahrtId),
            source_row_indices: ob.block.rides.map(r => r.sourceRowIndex),
            vehicle: ob.block.vehicle,
            original_date: ob.block.date,
            original_block_start: ob.block.originalBlockStartFull,
            original_block_end: ob.block.originalBlockEndFull,
            adjusted_block_start: ob.proposedStartFull ?? null,
            adjusted_block_end: ob.proposedEndFull ?? null,
            adjusted_date: ob.block.date,
            offset_seconds: ob.offsetSec,
            proposed_driver_id: inhaberDriverId,
            proposed_driver_name: inhaberDriverName,
            original_driver_name: ob.block.rides[0]?.originalDriverName ?? '',
            status: ob.status,
            reason: 'owner_overflow_block_v1',
            fail_reason: ob.failReason,
            conflicts: ob.conflictsWithBlockIds,
            impact: `Inhaber-Überlauf: ${ob.conflictsWithBlockIds.length} Konflikte`,
            approved_by: ob.status === 'approved' ? (user?.id ?? null) : null,
            approved_at: ob.status === 'approved' ? now : null,
            updated_at: now,
          };

          if (ob.dbId) {
            await supabase.from('historical_block_adjustments').update(row).eq('id', ob.dbId);
          } else {
            const { data } = await supabase.from('historical_block_adjustments').insert(row).select('id').maybeSingle();
            if (data?.id) {
              setPhase(prev => ({
                ...prev,
                overflowBlocks: prev.overflowBlocks.map(x =>
                  x.block.blockId === ob.block.blockId ? { ...x, dbId: data.id } : x,
                ),
              }));
            }
          }
        }

        // Per-ride adjustments (owner overflow only, for wizard compatibility)
        const approvedOverflow = phase.overflowBlocks.filter(ob => ob.status === 'approved');
        for (const ob of approvedOverflow) {
          for (const ride of ob.block.rides) {
            const adjustedStart = applyOffsetToDatetime(ride.originalStartRaw, ob.offsetSec);
            const adjustedEnd   = applyOffsetToDatetime(ride.originalEndRaw,   ob.offsetSec);
            await supabase.from('historical_time_adjustments').upsert({
              company_id: companyId,
              reconciliation_id: reconciliationId,
              source_row_index: ride.sourceRowIndex,
              fahrt_id: ride.fahrtId,
              original_start_time: ride.originalStartRaw,
              original_end_time: ride.originalEndRaw,
              adjusted_start_time: adjustedStart,
              adjusted_end_time: adjustedEnd,
              duration_minutes: Math.round(ride.durationSec / 60),
              reason: `Block ${ob.block.blockId}`,
              status: 'approved',
              adjustment_type: 'owner_overflow_block_v1',
              approved_by: user?.id ?? null,
              approved_at: now,
              updated_at: now,
            }, { onConflict: 'reconciliation_id,fahrt_id' });
          }
        }
      }

      const result = expandToAdjustments(
        phase.blocks, phase.regularAssignments, phase.ownerBlocks, phase.overflowBlocks,
        inhaberDriverId, inhaberDriverName, companyId, reconciliationId,
      );
      onApproved(result);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Fehler beim Speichern');
    } finally {
      setSaving(false);
      setShowConfirm(false);
    }
  }, [phase, companyId, reconciliationId, inhaberDriverId, inhaberDriverName, user, onApproved]);

  // ── Derived counts ─────────────────────────────────────────────────────────

  const { blocks, regularAssignments, ownerBlocks, overflowBlocks, phase2Rejections, generated } = phase;
  const validBlocks   = blocks.filter(b => b.validity === 'valid');
  const invalidBlocks = blocks.filter(b => b.validity === 'invalid');
  const overflowApproved = overflowBlocks.filter(ob => ob.status === 'approved').length;
  const overflowProposal = overflowBlocks.filter(ob => ob.status === 'proposal').length;
  const overflowNoSlot   = overflowBlocks.filter(ob => ob.status === 'no_slot').length;
  const allOverflowHandled = overflowBlocks.length === 0 || overflowBlocks.every(ob => ob.status === 'approved' || ob.status === 'rejected' || ob.status === 'no_slot');

  const exportBlocked = overflowNoSlot > 0 || !allOverflowHandled;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 max-w-6xl">
      {showConfirm && (
        <ConfirmModal
          count={overflowApproved}
          onConfirm={persistAndApply}
          onCancel={() => setShowConfirm(false)}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="inline-flex items-center gap-2 text-sm font-medium transition-colors hover:opacity-80" style={{ color: 'var(--text-secondary)' }}>
          <ArrowLeft size={15} /> Zurück zum Ergebnis
        </button>
      </div>

      <div>
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Inhaber-Überlauf lösen</h2>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          {MONTHS_DE[month - 1]} {year} — {allTrips.filter(t => !t.is_canceled).length} aktive Fahrten
        </p>
      </div>

      {/* Phase overview */}
      <div className="rounded-2xl p-4 grid grid-cols-2 gap-3 sm:grid-cols-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        {[
          { icon: Layers,  label: 'Blöcke erstellt',          val: generated ? `${validBlocks.length} gültig / ${invalidBlocks.length} ungültig` : '—' },
          { icon: Users,   label: 'Fahrer zugeteilt',          val: generated ? `${regularAssignments.size} Blöcke` : '—' },
          { icon: User,    label: 'Überlauf an Inhaber',       val: generated ? `${ownerBlocks.length} Blöcke` : '—' },
          { icon: RefreshCw, label: 'Inhaber-Überschneidungen', val: generated ? `${overflowBlocks.length} lösen` : '—' },
        ].map(({ icon: Icon, label, val }) => (
          <div key={label} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <Icon size={13} style={{ color: 'var(--text-secondary)' }} />
              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</span>
            </div>
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{val}</span>
          </div>
        ))}
      </div>

      {/* Legacy warning */}
      {legacyIgnored && (
        <div className="rounded-xl px-4 py-3 flex items-start justify-between gap-3"
          style={{ background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)' }}>
          <div className="flex items-start gap-2 text-sm" style={{ color: '#b91c1c' }}>
            <XCircle size={15} className="shrink-0 mt-0.5" />
            <span>
              <span className="font-semibold">Alte Zeitkorrekturen wurden ignoriert.</span>{' '}
              Bitte Inhaber-Überlauf neu berechnen.
            </span>
          </div>
          <button onClick={handleReset} disabled={resetting}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all hover:brightness-110 disabled:opacity-50"
            style={{ background: 'rgba(220,38,38,0.1)', color: '#b91c1c', border: '1px solid rgba(220,38,38,0.2)', whiteSpace: 'nowrap' }}>
            {resetting ? <><RefreshCw size={11} className="animate-spin" /> Löschen…</> : <><X size={11} /> Zeitkorrekturen zurücksetzen</>}
          </button>
        </div>
      )}

      {/* Controls */}
      <div className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>4-Phasen-Berechnung starten</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
              Phase 1: Fahrzeugblöcke erstellen · Phase 2: Fahrer zuweisen · Phase 3: Rest an Inhaber · Phase 4: Überschneidungen lösen
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {generated && overflowProposal > 0 && (
              <button onClick={approveAllOverflow}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all hover:brightness-110"
                style={{ background: 'rgba(21,128,61,0.1)', color: '#15803d', border: '1px solid rgba(21,128,61,0.2)' }}>
                <CheckCircle2 size={12} /> Alle gültigen Vorschläge übernehmen
              </button>
            )}
            {(generated || existingAdjustments.length > 0) && reconciliationId && (
              <button onClick={handleReset} disabled={resetting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all hover:brightness-110 disabled:opacity-50"
                style={{ background: 'rgba(220,38,38,0.06)', color: '#b91c1c', border: '1px solid rgba(220,38,38,0.2)' }}>
                {resetting ? <><RefreshCw size={11} className="animate-spin" /> Löschen…</> : <><X size={11} /> Zeitkorrekturen zurücksetzen</>}
              </button>
            )}
            <button onClick={handleGenerate} disabled={generating || allTrips.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-110 disabled:opacity-50"
              style={{ background: '#2563eb', color: '#fff' }}>
              {generating
                ? <><RefreshCw size={13} className="animate-spin" /> Berechne…</>
                : <><Layers size={13} /> Berechnung starten</>}
            </button>
          </div>
        </div>
      </div>

      {/* Invalid original blocks warning */}
      {generated && invalidBlocks.length > 0 && (
        <div className="rounded-xl px-4 py-3 space-y-2"
          style={{ background: 'rgba(220,38,38,0.04)', border: '1px solid rgba(220,38,38,0.2)' }}>
          <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: '#b91c1c' }}>
            <AlertTriangle size={14} />
            {invalidBlocks.length} Originaldaten-Warnung{invalidBlocks.length !== 1 ? 'en' : ''} — Fahrzeug-Überschneidungen in Originaldaten
          </div>
          <p className="text-xs" style={{ color: '#b91c1c' }}>
            Diese Blöcke werden nicht zugewiesen und nicht exportiert. Sie stammen aus den Originaldaten und sind nicht durch die App verursacht.
          </p>
          <div className="space-y-1 max-h-36 overflow-y-auto">
            {invalidBlocks.map(b => (
              <div key={b.blockId} className="text-xs flex items-start gap-1" style={{ color: '#b91c1c' }}>
                <XCircle size={10} className="shrink-0 mt-0.5" />
                {b.vehicle} {b.date}: {b.invalidReason}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Phase 2 — Regular driver assignment summary */}
      {generated && regularAssignments.size > 0 && (
        <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <div className="px-4 py-2.5 border-b" style={{ borderColor: 'var(--border)', background: 'var(--bg-subtle)' }}>
            <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
              Phase 2 — Fahrer-Zuweisung ({regularAssignments.size} Blöcke, keine Zeitänderung)
            </span>
          </div>
          <div className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
            {allowedDrivers.map(d => {
              const count = [...regularAssignments.values()].filter(v => v.driverId === d.driverId).length;
              const secs  = validBlocks.filter(b => regularAssignments.get(b.blockId)?.driverId === d.driverId)
                                       .reduce((s, b) => s + b.grundlohnSec, 0);
              const target = d.targetWorkSec;
              return (
                <div key={d.driverId} className="flex items-center gap-3 py-1 border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                  <span className="font-medium" style={{ color: 'var(--text-primary)', minWidth: 140 }}>{d.driverName}</span>
                  <span>{count} Blöcke</span>
                  <span>{(secs/3600).toFixed(2)} h Ist</span>
                  <span style={{ color: target > 0 ? (Math.abs(secs - target) < 3600 ? '#15803d' : '#a16207') : 'var(--text-secondary)' }}>
                    {target > 0 ? `/ ${(target/3600).toFixed(2)} h Ziel` : '(kein Ziel)'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Phase 2 — Rejected regular driver assignments diagnostic */}
      {generated && phase2Rejections.length > 0 && (
        <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid rgba(245,158,11,0.35)' }}>
          <div className="px-4 py-2.5 border-b" style={{ borderColor: 'rgba(245,158,11,0.2)', background: 'rgba(245,158,11,0.06)' }}>
            <span className="text-xs font-semibold" style={{ color: '#a16207' }}>
              Reguläre Fahrer-Überschneidungen verhindert — {phase2Rejections.length} Block{phase2Rejections.length !== 1 ? 'e' : ''} an Inhaber-Überlauf verschoben
            </span>
          </div>
          <div className="px-4 py-3 space-y-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
            {phase2Rejections.slice(0, 12).map((r, i) => (
              <div key={i} className="flex flex-wrap gap-x-3 gap-y-0.5 py-1 border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{r.blockId.split('|').slice(0, 2).join(' / ')}</span>
                <span>Zeilen {r.sourceRows.join(', ')}</span>
                <span style={{ color: '#b91c1c' }}>↗ {r.rejectedDriverName}</span>
                <span>Überschneidung mit {r.conflictBlockId.split('|').slice(0, 2).join(' / ')}</span>
                <span style={{ color: '#2563eb' }}>→ {r.action}</span>
              </div>
            ))}
            {phase2Rejections.length > 12 && (
              <div className="pt-1" style={{ color: 'var(--text-tertiary)' }}>… und {phase2Rejections.length - 12} weitere</div>
            )}
          </div>
        </div>
      )}

      {/* Phase 3 — Owner surplus */}
      {generated && (
        <div className="rounded-xl px-4 py-3 flex items-center gap-2 text-sm"
          style={{ background: 'rgba(37,99,235,0.04)', border: '1px solid rgba(37,99,235,0.15)' }}>
          <User size={14} style={{ color: '#2563eb' }} />
          <span style={{ color: 'var(--text-primary)' }}>
            <span className="font-semibold">{ownerBlocks.length} Überlauf-Blöcke</span> an Inhaber{inhaberDriverName ? ` (${inhaberDriverName})` : ''} zugewiesen.
            {overflowBlocks.length === 0
              ? ' Keine Inhaber-Überschneidungen.'
              : ` ${overflowBlocks.length} Überschneidung${overflowBlocks.length !== 1 ? 'en' : ''} gefunden.`}
          </span>
        </div>
      )}

      {/* Phase 4 — Owner overflow block table */}
      {generated && overflowBlocks.length > 0 && (
        <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <div className="px-4 py-2.5 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)', background: 'var(--bg-subtle)' }}>
            <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
              Phase 4 — Inhaber-Überlauf lösen ({overflowBlocks.length} Blöcke)
            </span>
            <div className="flex items-center gap-2 text-xs">
              {overflowApproved > 0 && <span style={{ color: '#15803d' }}>{overflowApproved} Genehmigt</span>}
              {overflowProposal > 0 && <span style={{ color: '#a16207' }}>{overflowProposal} Vorschlag</span>}
              {overflowNoSlot   > 0 && <span style={{ color: '#b91c1c' }}>{overflowNoSlot} Kein Slot</span>}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ background: 'var(--bg-subtle)' }}>
                  {['Block','Fahrzeug','Datum','Originalzeitraum','Neuer Zeitraum','Dauer','Fahrten','Offset','Status','Problem','Aktionen'].map(h => (
                    <th key={h} className="px-3 py-2 text-left font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {overflowBlocks.map(ob => {
                  const block = ob.block;
                  const isExpanded = expandedBlockId === block.blockId;
                  const durMin = Math.floor(block.blockDurationSec / 60);
                  const durSec = block.blockDurationSec % 60;
                  const durStr = durSec > 0 ? `${durMin}m ${String(durSec).padStart(2,'0')}s` : `${durMin}m`;
                  return (
                    <React.Fragment key={block.blockId}>
                      <tr style={{ borderTop: '1px solid var(--border)', background: ob.status === 'approved' ? 'rgba(21,128,61,0.02)' : ob.status === 'no_slot' ? 'rgba(220,38,38,0.02)' : undefined }}>
                        <td className="px-3 py-2 font-mono" style={{ color: 'var(--text-secondary)', maxWidth: 80 }}>
                          <span className="truncate block" title={block.blockId}>{block.vehicle}|{block.date.slice(8)}</span>
                        </td>
                        <td className="px-3 py-2 font-medium" style={{ color: 'var(--text-primary)' }}>{block.vehicle}</td>
                        <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{block.date}</td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)', fontSize: '0.65rem' }}>
                          <div>{block.originalBlockStartFull}</div>
                          <div>{block.originalBlockEndFull}</div>
                        </td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap" style={{ fontSize: '0.65rem' }}>
                          {ob.proposedStartFull && ob.proposedEndFull ? (
                            <div style={{ color: ob.status === 'approved' ? '#15803d' : '#2563eb', fontWeight: 600 }}>
                              <div>{ob.proposedStartFull}</div>
                              <div>{ob.proposedEndFull}</div>
                            </div>
                          ) : <span style={{ color: '#64748b' }}>—</span>}
                        </td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{durStr}</td>
                        <td className="px-3 py-2 text-center cursor-pointer" style={{ color: 'var(--text-primary)' }}
                          onClick={() => setExpandedBlockId(isExpanded ? null : block.blockId)}>
                          <span className="flex items-center gap-1 justify-center">
                            {block.rides.length}
                            {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono" style={{ color: ob.offsetSec !== 0 ? '#2563eb' : 'var(--text-secondary)' }}>
                          {ob.offsetSec !== 0 ? `${ob.offsetSec > 0 ? '+' : ''}${ob.offsetSec}s` : '—'}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap"><OverflowStatusBadge status={ob.status} /></td>
                        <td className="px-3 py-2" style={{ color: '#b91c1c', minWidth: 100 }}>
                          {ob.failReason && <span className="text-xs">{ob.failReason}</span>}
                          {ob.conflictsWithBlockIds.length > 0 && (
                            <span className="text-xs" style={{ color: '#a16207' }}>{ob.conflictsWithBlockIds.length} Konflikt{ob.conflictsWithBlockIds.length !== 1 ? 'e' : ''}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <div className="flex items-center gap-1">
                            {ob.status === 'proposal' && (
                              <button onClick={() => approveOverflow(block.blockId)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-all hover:brightness-110"
                                style={{ background: 'rgba(21,128,61,0.1)', color: '#15803d' }}>
                                <Check size={11} /> Übernehmen
                              </button>
                            )}
                            {ob.status === 'approved' && (
                              <button onClick={() => rejectOverflow(block.blockId)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-all hover:brightness-110"
                                style={{ background: 'rgba(100,116,139,0.1)', color: '#64748b' }}>
                                <X size={11} /> Ablehnen
                              </button>
                            )}
                            {ob.status === 'rejected' && (
                              <button onClick={() => approveOverflow(block.blockId)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-all hover:brightness-110"
                                style={{ background: 'rgba(234,179,8,0.1)', color: '#a16207' }}>
                                <Check size={11} /> Zurücksetzen
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr style={{ background: 'var(--bg-subtle)', borderTop: '1px solid var(--border)' }}>
                          <td colSpan={11} className="px-4 py-3">
                            <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                              Fahrten ({block.rides.length}) — Offset: {ob.offsetSec >= 0 ? '+' : ''}{ob.offsetSec}s
                            </div>
                            <table className="w-full text-xs">
                              <thead>
                                <tr>
                                  {['Fahrt-ID','Zeile','Originalzeit','Neue Zeit','Dauer'].map(h => (
                                    <th key={h} className="px-2 py-1 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {block.rides.map(ride => {
                                  const adjStart = ob.offsetSec !== 0 ? applyOffsetToDatetime(ride.originalStartRaw, ob.offsetSec) : '—';
                                  const adjEnd   = ob.offsetSec !== 0 ? applyOffsetToDatetime(ride.originalEndRaw,   ob.offsetSec) : '—';
                                  return (
                                    <tr key={ride.fahrtId} style={{ borderTop: '1px solid var(--border)' }}>
                                      <td className="px-2 py-1 font-mono" style={{ color: 'var(--text-secondary)' }}>{ride.fahrtId.slice(-8)}</td>
                                      <td className="px-2 py-1 font-mono" style={{ color: 'var(--text-secondary)' }}>{ride.sourceRowIndex ?? '—'}</td>
                                      <td className="px-2 py-1 font-mono" style={{ color: 'var(--text-secondary)', fontSize: '0.65rem' }}>{ride.originalStartRaw} – {ride.originalEndRaw}</td>
                                      <td className="px-2 py-1 font-mono" style={{ color: ob.offsetSec !== 0 ? '#2563eb' : 'var(--text-secondary)', fontSize: '0.65rem' }}>{adjStart} – {adjEnd}</td>
                                      <td className="px-2 py-1 font-mono" style={{ color: 'var(--text-secondary)' }}>{ride.durationSec}s</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Export validation summary */}
      {generated && (
        <div className="rounded-xl px-4 py-3 space-y-1 text-xs"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <div className="font-semibold text-sm mb-2" style={{ color: 'var(--text-primary)' }}>Export-Prüfung</div>
          <div className="grid gap-y-1" style={{ gridTemplateColumns: '1fr auto' }}>
            {[
              { label: 'Gültige Fahrzeugblöcke',        val: validBlocks.length,         isError: false },
              { label: 'Ungültige Originalblöcke',       val: invalidBlocks.length,       isError: invalidBlocks.length > 0 },
              { label: 'Blöcke an reguläre Fahrer',      val: regularAssignments.size,    isError: false },
              { label: 'Blöcke an Inhaber',              val: ownerBlocks.length,          isError: false },
              { label: 'Inhaber-Überschneidungen',       val: overflowBlocks.length,       isError: false },
              { label: 'Überlauf genehmigt',             val: overflowApproved,            isError: false },
              { label: 'Überlauf ohne freien Slot',      val: overflowNoSlot,              isError: overflowNoSlot > 0 },
              { label: 'Export freigegeben',             val: exportBlocked ? 'Nein' : 'Ja', isError: exportBlocked },
            ].map(({ label, val, isError }) => (
              <React.Fragment key={label}>
                <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
                <span className="text-right font-medium" style={{
                  color: isError ? '#b91c1c' : val === 'Ja' ? '#15803d' : 'var(--text-primary)',
                }}>{val}</span>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {/* Info */}
      <div className="rounded-xl px-4 py-3 text-xs flex items-start gap-2"
        style={{ background: 'rgba(37,99,235,0.06)', border: '1px solid rgba(37,99,235,0.15)', color: 'var(--text-secondary)' }}>
        <Info size={13} className="shrink-0 mt-0.5" />
        <span>
          Reguläre Fahrer-Blöcke werden nie zeitlich verschoben. Nur Inhaber-Überlauf-Blöcke (Überschneidungen) erhalten einen Zeitvorschlag.
          Fahrer-Pool: {allowedDrivers.map(d => d.driverName).join(', ')}{inhaberDriverName ? ` · Inhaber: ${inhaberDriverName}` : ''}.
        </span>
      </div>

      {saveError && (
        <div className="px-4 py-3 rounded-xl text-sm flex items-center gap-2"
          style={{ background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', color: '#b91c1c' }}>
          <AlertTriangle size={14} /> {saveError}
        </div>
      )}

      {/* Action bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button onClick={onBack} className="inline-flex items-center gap-2 text-sm transition-colors hover:opacity-80" style={{ color: 'var(--text-secondary)' }}>
          <ArrowLeft size={15} /> Zurück
        </button>
        <button
          onClick={() => {
            if (!generated) { onApproved([]); return; }
            if (overflowApproved > 0) { setShowConfirm(true); return; }
            persistAndApply();
          }}
          disabled={saving || (generated && exportBlocked && !allOverflowHandled)}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:brightness-110 disabled:opacity-40"
          style={{ background: '#a16207', color: '#fff' }}>
          {saving
            ? <><RefreshCw size={13} className="animate-spin" /> Speichern…</>
            : overflowApproved > 0
              ? <><Check size={13} /> {overflowApproved} Korrektur{overflowApproved !== 1 ? 'en' : ''} bestätigen</>
              : <><Check size={13} /> {generated ? 'Zuweisung übernehmen' : 'Ohne Korrekturen fortfahren'}</>}
        </button>
      </div>
    </div>
  );
}
