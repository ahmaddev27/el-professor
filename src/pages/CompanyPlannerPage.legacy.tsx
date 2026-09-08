import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Calendar, Play, AlertTriangle, CheckCircle, User,
  ChevronDown, ChevronUp, Info, ArrowRight, Shield, Save,
  FolderOpen, Trash2, RefreshCw, Clock, Filter, Moon, Zap,
  Lock, RotateCcw, Settings2, X, UserCheck, Ban, UserPlus, Download,
  Car as CarIcon,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import ConfirmationModal from '../components/ConfirmationModal';
import { Driver } from '../types/receipt';
import { FahrtenbuchTrip, useFahrtenbuch } from '../hooks/useFahrtenbuch';
import { exportFahrtenbuch } from '../utils/fahrtenbuchExport';
import GenerateStundennachweisModal from '../components/GenerateStundennachweisModal';
import {
  buildCarBlocksFromTrips, resolveCarBlocks,
  buildTripAssignmentMap, validateResolvedFahrtenbuch,
  MIN_VEHICLE_SWITCH_BUFFER_MINUTES,
  type ResolvedFahrtenbuchValidation, type CarBlockResolverResult,
  type PoolDriver, type TripAssignment,
} from '../utils/carBlockResolver';
import { normalizeTripServiceDate, type NormalizedTrip } from '../utils/shiftBlockEngine';
import { checkShiftWindow, minutesOutsideWindow, timeStringFromMinutes } from '../utils/shiftWindow';
import {
  planVehicleBlocks,
  type VehicleBlockPlanResult,
  type PlannerDriver as VBPlannerDriver,
  type PlannerTrip as VBPlannerTrip,
  VEHICLE_BLOCK_GAP_MINUTES,
} from '../utils/vehicleBlockPlanner';

// ─── Types ───────────────────────────────────────────────────────────────────

type NotePlanningBehavior = 'neutral' | 'exclude_from_plan' | 'must_include_in_plan';
const DEFAULT_MIN_BLOCK_MINUTES = 60;

interface DriverNote {
  id: string;
  driver_id: string;
  note_date: string;
  note_text: string;
  note_type?: string;
  note_planning_behavior?: NotePlanningBehavior;
  is_full_day?: boolean;
  start_time?: string | null;
  end_time?: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

interface ProposedBlock {
  date: string;
  driverIndex: number;
  originalDriverId: string | null;
  originalDriverName: string;
  startTime: string;
  endTime: string;
  durationHours: number;
  tripCount: number;
  tripIds: string[];
  status: 'ok' | 'proposed_reassignment' | 'no_capacity' | 'blocked_by_note' | 'missing_driver' | 'too_many_blocks' | 'exceeds_daily_limit' | 'short_block' | 'cross_midnight' | 'exceeds_monthly_max' | 'manually_assigned' | 'manually_confirmed' | 'excluded_from_apply';
  reason: string;
  isReassigned: boolean;
  blockSource: 'fahrtenbuch' | 'note' | 'fahrtenbuch+note';
  crossesMidnight?: boolean;
  isShortBlock?: boolean;
  manualResolution?: {
    type: 'assign_driver' | 'keep_original' | 'exclude';
    assignedDriverId?: string;
    assignedDriverName?: string;
    previousStatus: ProposedBlock['status'];
    previousReason: string;
  };
}

interface CoverageUsageReason {
  type: 'daily_limit' | 'salary_limit' | 'monthly_limit' | 'note_blocked' | 'no_regular_capacity';
  count: number;
}

interface PlanDriver {
  driver: Driver;
  totalHours: number;
  tripCount: number;
  blocks: ProposedBlock[];
  warnings: string[];
  proposedOverflows: number;
  expectedGross: number | null;
  salaryDiff: number | null;
  salaryStatus: 'ok' | 'over' | 'under' | 'no_target' | 'no_rate';
  coverageReasons: CoverageUsageReason[];
  isCoverageOverTargetWhileRegularsNeed: boolean;
}

interface PlanResult {
  totalTrips: number;
  canceledTrips: number;
  coveredTrips: number;
  uncoveredTrips: number;
  proposedReassignments: number;
  driversOverTarget: number;
  driversOverMax: number;
  planDrivers: PlanDriver[];
  allBlocks: ProposedBlock[];
}

interface SavedRun {
  id: string;
  month: number;
  year: number;
  import_id: string | null;
  status: string;
  max_shift_minutes: number;
  summary_json: PlanResult;
  created_at: string;
  block_count: number;
  warning_count: number;
  import_file_name?: string;
}

// ─── Pre-index structures ─────────────────────────────────────────────────────

interface NoteIndex {
  // driverId → date → notes (for fast O(1) lookup)
  excludeByDriverDate:     Map<string, Map<string, DriverNote[]>>;
  mustIncludeByDriverDate: Map<string, Map<string, DriverNote[]>>;
  // all dates that have must_include notes for each driver
  mustIncludeDatesByDriver: Map<string, string[]>;
}

// driverId+date → sorted FahrtenbuchTrip[]
type TripIndex = Map<string, Map<string, FahrtenbuchTrip[]>>;

// ─── Constants ───────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'Januar','Februar','März','April','Mai','Juni',
  'Juli','August','September','Oktober','November','Dezember'
];
const BLOCK_BUFFER_BEFORE    = 10;
const BLOCK_BUFFER_AFTER     = 10;
const LARGE_GAP_MINUTES      = 90;
const MAX_BLOCKS_PER_DAY     = 4;   // safety limit
const YIELD_EVERY_N_DRIVERS  = 5;   // yield after processing this many drivers

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function timeToMinutes(t: string | null | undefined): number {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function effectiveEndMinutes(startMin: number, endMin: number): number {
  if (endMin <= startMin) return endMin === 0 ? 1439 : 1440;
  return endMin;
}

function minutesToTime(m: number): string {
  const h   = Math.floor(m / 60) % 24;
  const min = m % 60;
  return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}

function fmtHours(h: number): string {
  return h.toFixed(2).replace('.', ',') + ' Std.';
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  let cur = start;
  let guard = 0;
  while (cur <= end && guard++ < 400) {   // 400-day hard cap prevents infinite loop
    dates.push(cur);
    cur = addDays(cur, 1);
  }
  return dates;
}

function noteEffectiveDateStr(note: DriverNote): { sd: string; ed: string } {
  const sd = note.start_date ?? note.note_date.slice(0, 10);
  const ed = note.end_date   ?? sd;
  return { sd, ed };
}

function getNotePlanningBehavior(note: DriverNote): NotePlanningBehavior {
  if (note.note_planning_behavior) return note.note_planning_behavior;
  const lower = note.note_text.toLowerCase();
  if (['krank','urlaub','frei','nicht verfügbar','gesperrt','ausfall','abwesend'].some(k => lower.includes(k)))
    return 'exclude_from_plan';
  if (['blitzer','unfall','panne','kontrolle','wartezeit'].some(k => lower.includes(k)))
    return 'must_include_in_plan';
  return 'neutral';
}

/** Yield to the browser event loop so the tab stays responsive */
function yieldToUI(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

// ─── Salary / premium helpers ────────────────────────────────────────────────

const PREM_NIGHT   = 0.40;
const PREM_SUN     = 0.50;
const PREM_HOLIDAY = 1.25;

function isDateSunday(dateStr: string): boolean {
  return new Date(dateStr + 'T12:00:00Z').getDay() === 0;
}

function isDateHoliday(dateStr: string, holidays: Set<string>): boolean {
  return holidays.has(dateStr);
}

function blockNightMins(startMin: number, endMin: number): number {
  const nightStart = 20 * 60; // 20:00
  const nightEnd   = 6 * 60;  // 06:00 next day = 30*60 in absolute
  const absEnd = endMin > startMin ? endMin : endMin + 1440;
  // Segment 1: 20:00..24:00 overlap
  const seg1 = Math.max(0, Math.min(absEnd, 1440) - Math.max(startMin, nightStart));
  // Segment 2: 24:00..30:00 (= next day 00:00..06:00) overlap
  const seg2 = Math.max(0, Math.min(absEnd, 1440 + nightEnd) - Math.max(startMin, 1440));
  return Math.max(0, seg1) + Math.max(0, seg2);
}

function blockGrossCents(
  durationMins: number, startMin: number, endMin: number,
  dateStr: string, holidays: Set<string>, hourlyRateCents: number,
): number {
  if (durationMins <= 0 || hourlyRateCents <= 0) return 0;
  const isSun = isDateSunday(dateStr);
  const isHol = isDateHoliday(dateStr, holidays);
  const nightMins = blockNightMins(startMin, endMin);
  let cents = (durationMins * hourlyRateCents) / 60;
  cents += (nightMins * hourlyRateCents * Math.round(PREM_NIGHT * 100)) / (60 * 100);
  if (isSun && !isHol) cents += (durationMins * hourlyRateCents * Math.round(PREM_SUN * 100)) / (60 * 100);
  if (isHol)           cents += (durationMins * hourlyRateCents * Math.round(PREM_HOLIDAY * 100)) / (60 * 100);
  return cents;
}

function calcExpectedGross(blocks: ProposedBlock[], hourlyRate: number, holidays: Set<string>): number {
  const rateCents = Math.round(hourlyRate * 100);
  let totalCents = 0;
  for (const b of blocks) {
    const startMin = timeToMinutes(b.startTime);
    const endMin   = timeToMinutes(b.endTime);
    const durMins  = Math.round(b.durationHours * 60);
    totalCents += blockGrossCents(durMins, startMin, endMin, b.date, holidays, rateCents);
  }
  return Math.round(totalCents) / 100;
}

function buildHolidaySet(year: number): Set<string> {
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dt  = (y: number, m: number, d: number) => new Date(y, m - 1, d);
  const addD = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

  // Easter (Anonymous Gregorian algorithm)
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day   = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = dt(year, month, day);

  const holidays = new Set<string>();
  holidays.add(fmt(dt(year, 1, 1)));       // Neujahr
  holidays.add(fmt(addD(easter, -2)));      // Karfreitag
  holidays.add(fmt(addD(easter, 1)));       // Ostermontag
  holidays.add(fmt(dt(year, 5, 1)));        // Tag der Arbeit
  holidays.add(fmt(addD(easter, 39)));      // Christi Himmelfahrt
  holidays.add(fmt(addD(easter, 50)));      // Pfingstmontag
  holidays.add(fmt(dt(year, 10, 3)));       // Tag der deutschen Einheit
  holidays.add(fmt(dt(year, 12, 25)));      // 1. Weihnachtstag
  holidays.add(fmt(dt(year, 12, 26)));      // 2. Weihnachtstag
  return holidays;
}

// ─── Pre-indexing functions (called once before planning) ─────────────────────

// Normalize a driver name for fuzzy matching: trim, lower-case, collapse spaces.
function normalizeDriverName(name: string | null | undefined): string {
  if (!name) return '';
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Resolve the EFFECTIVE current driver of a Fahrtenbuch trip, used for
 * stale-assignment detection and pool-membership checks.
 *
 * Priority order:
 *   1. assigned_driver_id (with assigned_driver_name)
 *   2. original_driver_id (with original_driver_name)
 *   3. drivers[] match by normalized original_driver_name
 *   4. none
 */
type EffectiveTripDriver = {
  driverId: string | null;
  driverName: string | null;
  source: 'assigned' | 'original_id' | 'original_name' | 'none';
};

function getEffectiveTripDriver(trip: FahrtenbuchTrip, drivers: Driver[]): EffectiveTripDriver {
  if (trip.assigned_driver_id) {
    return {
      driverId: trip.assigned_driver_id,
      driverName: trip.assigned_driver_name || null,
      source: 'assigned',
    };
  }
  if (trip.original_driver_id) {
    return {
      driverId: trip.original_driver_id,
      driverName: trip.original_driver_name || null,
      source: 'original_id',
    };
  }
  const norm = normalizeDriverName(trip.original_driver_name);
  if (norm) {
    const match = drivers.find(d => normalizeDriverName(d.name) === norm);
    if (match) {
      return { driverId: match.id, driverName: match.name, source: 'original_name' };
    }
    return { driverId: null, driverName: trip.original_driver_name || null, source: 'none' };
  }
  return { driverId: null, driverName: null, source: 'none' };
}

/**
 * Group non-canceled trips by (driverId → date → sorted trips[]).
 * Trips are sorted by start_time ascending within each group.
 * Each trip is filed under its effective driver ID:
 *   assigned_driver_id if set, else original_driver_id.
 */
function buildTripIndex(trips: FahrtenbuchTrip[]): TripIndex {
  const index: TripIndex = new Map();
  for (const t of trips) {
    if (t.is_canceled || !t.start_time || !t.end_time) continue;
    const driverId = t.assigned_driver_id ?? t.original_driver_id;
    if (!driverId) continue;
    if (!index.has(driverId)) index.set(driverId, new Map());
    const dateMap = index.get(driverId)!;
    if (!dateMap.has(t.trip_date)) dateMap.set(t.trip_date, []);
    dateMap.get(t.trip_date)!.push(t);
  }
  // Sort each list once by start_time ascending
  for (const dateMap of index.values()) {
    for (const list of dateMap.values()) {
      list.sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));
    }
  }
  return index;
}

/**
 * Expand all note date ranges once and build O(1) lookup maps.
 * Notes with behavior 'neutral' are skipped entirely.
 */
function buildNoteIndex(notes: DriverNote[]): NoteIndex {
  const excludeByDriverDate:     Map<string, Map<string, DriverNote[]>> = new Map();
  const mustIncludeByDriverDate: Map<string, Map<string, DriverNote[]>> = new Map();
  const mustIncludeDatesByDriver: Map<string, string[]> = new Map();

  for (const note of notes) {
    const behavior = getNotePlanningBehavior(note);
    if (behavior === 'neutral') continue;

    const { sd, ed } = noteEffectiveDateStr(note);
    const dates = dateRange(sd, ed);   // expanded once here, never again

    const target = behavior === 'exclude_from_plan' ? excludeByDriverDate : mustIncludeByDriverDate;
    for (const date of dates) {
      if (!target.has(note.driver_id)) target.set(note.driver_id, new Map());
      const dm = target.get(note.driver_id)!;
      if (!dm.has(date)) dm.set(date, []);
      dm.get(date)!.push(note);

      if (behavior === 'must_include_in_plan') {
        if (!mustIncludeDatesByDriver.has(note.driver_id)) mustIncludeDatesByDriver.set(note.driver_id, []);
        const arr = mustIncludeDatesByDriver.get(note.driver_id)!;
        if (!arr.includes(date)) arr.push(date);
      }
    }
  }

  return { excludeByDriverDate, mustIncludeByDriverDate, mustIncludeDatesByDriver };
}

/** O(1) blocked-check using pre-indexed note map */
function isDriverBlockedFast(
  driverId: string,
  date: string,
  noteIndex: NoteIndex,
  blockStartMin?: number,
  blockEndMin?: number,
): string | null {
  const dateMap = noteIndex.excludeByDriverDate.get(driverId);
  if (!dateMap) return null;
  const notesForDay = dateMap.get(date);
  if (!notesForDay) return null;

  for (const note of notesForDay) {
    if (note.is_full_day || (!note.start_time && !note.end_time)) return note.note_text || 'Abwesend';
    if (blockStartMin !== undefined && blockEndMin !== undefined && note.start_time && note.end_time) {
      const ns = timeToMinutes(note.start_time);
      const ne = timeToMinutes(note.end_time);
      if (blockStartMin < ne && blockEndMin > ns) return note.note_text || 'Abwesend';
    } else {
      return note.note_text || 'Abwesend';
    }
  }
  return null;
}

/** O(1) must-include lookup */
function getMustIncludeNotesFast(driverId: string, date: string, noteIndex: NoteIndex): DriverNote[] {
  return noteIndex.mustIncludeByDriverDate.get(driverId)?.get(date) ?? [];
}

/**
 * Build working blocks from pre-indexed, pre-sorted trips for one driver/date.
 * maxShiftMinutes enforced; MAX_BLOCKS_PER_DAY safety cap applied.
 */
function buildDailyBlocksFast(
  sortedTrips: FahrtenbuchTrip[],
  maxShiftMinutes: number,
): { startMin: number; endMin: number; tripIds: string[]; splitReason?: string; capped?: boolean; crossesMidnight?: boolean }[] {
  if (sortedTrips.length === 0) return [];

  type BlockDef = { startMin: number; endMin: number; tripIds: string[]; splitReason?: string; capped?: boolean; crossesMidnight?: boolean };
  const blocks: BlockDef[] = [];

  const rawStart0 = timeToMinutes(sortedTrips[0].start_time);
  const rawEnd0   = timeToMinutes(sortedTrips[0].end_time);
  const effEnd0   = effectiveEndMinutes(rawStart0, rawEnd0);
  let crossesMidnight = effEnd0 !== rawEnd0;

  let blockStart = rawStart0 - BLOCK_BUFFER_BEFORE;
  let blockEnd   = effEnd0   + BLOCK_BUFFER_AFTER;
  let blockTrips = [sortedTrips[0].id];

  for (let i = 1; i < sortedTrips.length; i++) {
    if (blocks.length >= MAX_BLOCKS_PER_DAY) {
      blocks[blocks.length - 1].capped = true;
      break;
    }
    const tripStart = timeToMinutes(sortedTrips[i].start_time);
    const rawTripEnd = timeToMinutes(sortedTrips[i].end_time);
    const tripEnd    = effectiveEndMinutes(tripStart, rawTripEnd);
    if (tripEnd !== rawTripEnd) crossesMidnight = true;

    const gap       = tripStart - (blockEnd - BLOCK_BUFFER_AFTER);
    const wouldExceedMax = (Math.max(blockEnd, tripEnd + BLOCK_BUFFER_AFTER) - blockStart) > maxShiftMinutes;
    const isLargeGap     = gap > LARGE_GAP_MINUTES;

    if (isLargeGap || wouldExceedMax) {
      blocks.push({
        startMin:    Math.max(0, blockStart),
        endMin:      Math.min(1440, blockEnd),
        tripIds:     blockTrips,
        splitReason: wouldExceedMax && !isLargeGap ? 'Schicht wegen Maximaldauer geteilt' : undefined,
        crossesMidnight,
      });
      crossesMidnight = tripEnd !== rawTripEnd;
      blockStart = tripStart - BLOCK_BUFFER_BEFORE;
      blockEnd   = tripEnd   + BLOCK_BUFFER_AFTER;
      blockTrips = [sortedTrips[i].id];
    } else {
      blockEnd = Math.max(blockEnd, tripEnd + BLOCK_BUFFER_AFTER);
      blockTrips.push(sortedTrips[i].id);
    }
  }
  blocks.push({ startMin: Math.max(0, blockStart), endMin: Math.min(1440, blockEnd), tripIds: blockTrips, crossesMidnight });
  return blocks;
}

// ─── Daily best-combination selector ─────────────────────────────────────────

/**
 * Brute-force subset selection for one driver/date.
 * N <= MAX_BLOCKS_PER_DAY = 4, so 2^4 = 16 subsets — perfectly fast.
 *
 * Picks the non-overlapping subset whose total duration is maximal while
 * staying <= maxShiftMinutes.  Ties broken by trip count.
 */
function selectBestDailyBlocks(
  candidates: Array<{ startMin: number; endMin: number; tripIds: string[] }>,
  maxDailyMinutes: number,
): { selectedIdx: number[]; rejectedIdx: number[] } {
  const n = candidates.length;
  if (n === 0) return { selectedIdx: [], rejectedIdx: [] };

  const sortedOrig = [...Array(n).keys()]
    .sort((a, b) => candidates[a].startMin - candidates[b].startMin);

  let bestMask = 0, bestMins = 0, bestTrips = 0;

  for (let mask = 1; mask < (1 << n); mask++) {
    const sub = sortedOrig.filter(i => mask & (1 << i));
    let totalMins = 0, totalTrips = 0;
    for (const i of sub) {
      totalMins  += candidates[i].endMin - candidates[i].startMin;
      totalTrips += candidates[i].tripIds.length;
    }
    if (totalMins > maxDailyMinutes) continue;

    let overlap = false;
    for (let j = 1; j < sub.length; j++) {
      if (candidates[sub[j]].startMin < candidates[sub[j - 1]].endMin) {
        overlap = true; break;
      }
    }
    if (overlap) continue;

    if (totalMins > bestMins || (totalMins === bestMins && totalTrips > bestTrips)) {
      bestMins = totalMins; bestTrips = totalTrips; bestMask = mask;
    }
  }

  const selectedIdx: number[] = [], rejectedIdx: number[] = [];
  for (let i = 0; i < n; i++)
    (bestMask & (1 << i) ? selectedIdx : rejectedIdx).push(i);
  return { selectedIdx, rejectedIdx };
}

// ─── Core planner (async, yields to UI between driver batches) ────────────────

async function runPlannerAsync(
  trips: FahrtenbuchTrip[],
  drivers: Driver[],
  notes: DriverNote[],
  maxShiftMinutes: number,
  targetToleranceHours: number,
  minBlockMinutes: number,
  salaryToleranceAmount: number,
  onProgress?: (step: string) => void,
): Promise<PlanResult> {
  onProgress?.('Daten vorverarbeiten …');

  const nonCanceled = trips.filter(t => !t.is_canceled);

  // ── Pre-index everything (O(n) passes, done once) ──────────────────────────
  console.time('build-trip-index');
  const tripIndex = buildTripIndex(nonCanceled);
  console.timeEnd('build-trip-index');

  console.time('build-note-index');
  const noteIndex = buildNoteIndex(notes);
  console.timeEnd('build-note-index');

  // Build holiday set for salary calculations
  const planYear = nonCanceled.length > 0 ? parseInt(nonCanceled[0].trip_date.slice(0, 4)) : new Date().getFullYear();
  const holidaySet = buildHolidaySet(planYear);

  // Collect all unique driver IDs from trips
  const allDriverIdSet = new Set<string>();
  for (const t of nonCanceled) {
    const id = t.assigned_driver_id ?? t.original_driver_id;
    if (id) allDriverIdSet.add(id);
  }
  const allDriverIds = Array.from(allDriverIdSet);

  // All dates present in trips
  const tripDates = [...new Set(nonCanceled.map(t => t.trip_date))].sort();

  const activePlanDrivers = drivers.filter(d => d.status === 'active' && d.planning_enabled !== false);
  const replacementDrivers = activePlanDrivers
    .filter(d => d.can_cover_other_drivers !== false || d.driver_usage_type === 'coverage_only');

  // Pre-build lookup maps — O(1) per lookup
  const driverById:    Map<string, Driver> = new Map(activePlanDrivers.map(d => [d.id, d]));
  const driverByName:  Map<string, Driver> = new Map(activePlanDrivers.map(d => [d.name.trim().toLowerCase(), d]));
  const driverIndexMap: Map<string, number> = new Map(activePlanDrivers.map((d, i) => [d.id, i]));

  // Name fallback for trip driver IDs not matching any DB driver
  const unknownIdToName: Map<string, string> = new Map();
  for (const t of nonCanceled) {
    const id = t.assigned_driver_id ?? t.original_driver_id;
    if (id && !driverById.has(id)) {
      unknownIdToName.set(id, t.original_driver_name ?? id);
    }
  }

  // All plan dates = trip dates ∪ must-include note dates for active drivers
  const mustIncludeDatesSet = new Set<string>();
  for (const d of activePlanDrivers) {
    for (const date of noteIndex.mustIncludeDatesByDriver.get(d.id) ?? []) {
      mustIncludeDatesSet.add(date);
    }
  }
  const allPlanDates = [...new Set([...tripDates, ...mustIncludeDatesSet])].sort();

  // Per-driver accumulators
  const driverHours:     Map<string, number>                  = new Map();
  const driverBlocks:    Map<string, ProposedBlock[]>          = new Map();
  const driverWarnings:  Map<string, string[]>                 = new Map();
  const driverTripCount: Map<string, number>                   = new Map();
  // driverId → date → accumulated minutes (for daily limit enforcement)
  const dailyMinutes:    Map<string, Map<string, number>>      = new Map();
  for (const d of activePlanDrivers) {
    driverHours.set(d.id, 0);
    driverBlocks.set(d.id, []);
    driverWarnings.set(d.id, []);
    driverTripCount.set(d.id, 0);
    dailyMinutes.set(d.id, new Map());
  }

  const allBlocks: ProposedBlock[] = [];

  // ── Phase 1: goal-aware, per-driver block selection ──────────────────────────
  //
  // For each driver:
  //   a) Collect all candidate blocks across all dates
  //   b) Per date: pick best non-overlapping combo under daily limit
  //   c) Across month: greedily add highest-value blocks until softCap
  //   d) Emit OK for selected, offer rejected to coverage
  //
  // Sort allDriverIds: regular drivers first, coverage drivers second
  const driverOrder = (id: string): number => {
    const d = driverById.get(id);
    if (!d) return 2; // unknown drivers last
    return d.driver_usage_type === 'coverage_only' ? 1 : 0;
  };
  allDriverIds.sort((a, b) => driverOrder(a) - driverOrder(b));

  onProgress?.('Erstelle Schichtblöcke …');
  console.time('phase1-blocks');

  interface CBlock {
    date: string;
    startMin: number;
    endMin: number;
    durationMins: number;
    durationHours: number;
    tripIds: string[];
    tripCount: number;
    blockSource: ProposedBlock['blockSource'];
    hasMustInclude: boolean;
    noteBlockReason: string | null;
    splitReason?: string;
    capped?: boolean;
    crossesMidnight?: boolean;
  }

  const tryAssignCoverage = (
    cb: CBlock,
    effectiveId: string,
    dbDriverName: string,
    driverIdx: number,
    isDailyRejection: boolean,
  ): boolean => {
    const limitLabel = isDailyRejection
      ? `Tageslimit (${(maxShiftMinutes / 60).toFixed(1)} Std.)`
      : 'Monatsziel erreicht';

    // Build scored candidate list from all replacement-eligible drivers
    const candidates: Array<{ driver: Driver; score: number }> = [];
    for (const cov of replacementDrivers) {
      if (cov.id === effectiveId) continue;
      if (isDriverBlockedFast(cov.id, cb.date, noteIndex, cb.startMin, cb.endMin)) continue;

      const covHardCap = cov.max_monthly_hours != null ? cov.max_monthly_hours * 60 : Infinity;
      const covTarget  = cov.target_monthly_hours != null ? cov.target_monthly_hours * 60 : Infinity;
      const covSoftCap = cov.target_monthly_hours != null
        ? Math.min((cov.target_monthly_hours + targetToleranceHours) * 60, covHardCap)
        : covHardCap;
      const covUsedMonthly = (driverHours.get(cov.id) ?? 0) * 60;
      const covUsedDaily   = dailyMinutes.get(cov.id)?.get(cb.date) ?? 0;

      if (covUsedMonthly + cb.durationMins > covHardCap) continue;
      if (covUsedDaily + cb.durationMins > maxShiftMinutes) continue;

      // Priority scoring: lower = better
      let score = 0;

      // Salary-first scoring if driver has salary goal
      const covRate    = cov.planning_hourly_rate;
      const covSalTgt  = cov.planning_target_salary;
      const covHasSalary = covRate != null && covRate > 0 && covSalTgt != null && covSalTgt > 0;
      if (covHasSalary) {
        const blockEuros = blockGrossCents(cb.durationMins, cb.startMin, cb.endMin, cb.date, holidaySet, Math.round(covRate! * 100)) / 100;
        const covCurrentGross = calcExpectedGross(
          (driverBlocks.get(cov.id) ?? []).filter(b => b.status === 'ok' || b.status === 'short_block' || b.status === 'cross_midnight' || b.status === 'proposed_reassignment' || b.status === 'manually_assigned' || b.status === 'manually_confirmed'),
          covRate!, holidaySet);
        const covNewGross = covCurrentGross + blockEuros;
        if (covCurrentGross < covSalTgt! - salaryToleranceAmount) score -= 20000;
        else if (covNewGross > covSalTgt! + salaryToleranceAmount) score += 30000;
        score -= Math.max(0, covSalTgt! - covNewGross) * 10;
      } else {
        if (covUsedMonthly < covTarget) score -= 10000;
      }
      // Prefer drivers with more daily capacity remaining
      score -= (maxShiftMinutes - covUsedDaily - cb.durationMins);
      // Prefer drivers with fewer warnings
      score += (driverWarnings.get(cov.id)?.length ?? 0) * 500;
      // Use planning_priority as tiebreaker
      score += (cov.planning_priority ?? 100);
      // REGULAR-FIRST: heavily penalize coverage drivers so regular drivers are preferred
      if (cov.driver_usage_type === 'coverage_only') score += 15000;

      candidates.push({ driver: cov, score });
    }

    if (candidates.length === 0) return false;

    // Sort by score ascending (lower = better)
    candidates.sort((a, b) => a.score - b.score);
    const best = candidates[0].driver;

    const covIdx = driverIndexMap.get(best.id) ?? -1;
    const covUsedH  = (driverHours.get(best.id) ?? 0);
    const covTargetH = best.target_monthly_hours;
    const covRemainingH = covTargetH != null ? Math.max(0, covTargetH - covUsedH) : null;
    const whyOriginal = `${dbDriverName}: ${limitLabel}`;
    const whyProposed = covRemainingH != null
      ? `${best.name} hat noch ${covRemainingH.toFixed(1)} Std. unter Ziel (${covTargetH} Std.)`
      : `${best.name} hat freie Kapazität`;
    const usageLabel = best.driver_usage_type === 'coverage_only' ? ' [Deckungsfahrer]' : '';
    const block: ProposedBlock = {
      date: cb.date, driverIndex: covIdx,
      originalDriverId: effectiveId, originalDriverName: dbDriverName,
      startTime: minutesToTime(cb.startMin), endTime: minutesToTime(cb.endMin),
      durationHours: cb.durationHours, tripCount: cb.tripCount, tripIds: cb.tripIds,
      status: 'proposed_reassignment',
      reason: `${whyOriginal}. Vorschlag: ${whyProposed}${usageLabel}`,
      isReassigned: true, blockSource: cb.blockSource,
    };
    allBlocks.push(block);
    driverBlocks.get(best.id)!.push(block);
    driverHours.set(best.id, (driverHours.get(best.id) ?? 0) + cb.durationHours);
    driverTripCount.set(best.id, (driverTripCount.get(best.id) ?? 0) + cb.tripCount);
    const covDM = dailyMinutes.get(best.id)!;
    covDM.set(cb.date, (covDM.get(cb.date) ?? 0) + cb.durationMins);
    return true;
  };

  let driverCount = 0;
  for (const driverId of allDriverIds) {
    const dbDriver = driverById.get(driverId)
      ?? driverByName.get((unknownIdToName.get(driverId) ?? '').trim().toLowerCase());
    const driverDateMap = tripIndex.get(driverId);

    // ── Unknown driver: emit missing_driver and move on ─────────────────────
    if (!dbDriver) {
      for (const date of allPlanDates) {
        for (const t of driverDateMap?.get(date) ?? []) {
          if (!t.start_time || !t.end_time) continue;
          // Emit one missing_driver block per raw block
        }
        const raw = buildDailyBlocksFast(driverDateMap?.get(date) ?? [], maxShiftMinutes);
        for (const rb of raw) {
          if (rb.tripIds.length === 0) continue;
          const durMins = Math.max(0, Math.min(1440, rb.endMin) - Math.max(0, rb.startMin));
          allBlocks.push({
            date, driverIndex: -1,
            originalDriverId: driverId, originalDriverName: unknownIdToName.get(driverId) ?? driverId,
            startTime: minutesToTime(Math.max(0, rb.startMin)), endTime: minutesToTime(Math.min(1440, rb.endMin)),
            durationHours: durMins / 60,
            tripCount: rb.tripIds.length, tripIds: rb.tripIds,
            status: 'missing_driver', reason: 'Fahrer hat keine Planungseinstellungen',
            isReassigned: false, blockSource: 'fahrtenbuch',
            crossesMidnight: rb.crossesMidnight,
          });
        }
      }
      continue;
    }

    const effectiveId = dbDriver.id;
    const driverIdx   = driverIndexMap.get(effectiveId) ?? -1;

    // ── a) Collect candidate blocks across all dates ─────────────────────────
    const allCBlocks: CBlock[] = [];

    for (const date of allPlanDates) {
      const sortedTrips      = driverDateMap?.get(date) ?? [];
      const mustIncludeNotes = getMustIncludeNotesFast(effectiveId, date, noteIndex);
      const rawBlocks        = buildDailyBlocksFast(sortedTrips, maxShiftMinutes);

      for (const mn of mustIncludeNotes) {
        const noteStart = mn.start_time ? timeToMinutes(mn.start_time) - BLOCK_BUFFER_BEFORE : 660;
        const noteEnd   = mn.end_time   ? timeToMinutes(mn.end_time)   + BLOCK_BUFFER_AFTER  : noteStart + 120;
        let merged = false;
        for (const rb of rawBlocks) {
          if (rb.startMin <= noteEnd + LARGE_GAP_MINUTES && rb.endMin >= noteStart - LARGE_GAP_MINUTES) {
            rb.startMin = Math.min(rb.startMin, noteStart);
            rb.endMin   = Math.max(rb.endMin, noteEnd);
            merged = true; break;
          }
        }
        if (!merged && rawBlocks.length < MAX_BLOCKS_PER_DAY) {
          rawBlocks.push({ startMin: Math.max(0, noteStart), endMin: Math.min(1440, noteEnd), tripIds: [] });
        }
      }

      for (const raw of rawBlocks) {
        const clampedStart = Math.max(0, raw.startMin);
        const clampedEnd   = Math.min(1440, raw.endMin);
        const durMins      = Math.max(0, clampedEnd - clampedStart);
        const hasTrips = raw.tripIds.length > 0;
        const hasMustInclude = mustIncludeNotes.some(mn => {
          const ms = mn.start_time ? timeToMinutes(mn.start_time) - BLOCK_BUFFER_BEFORE : 660;
          const me = mn.end_time   ? timeToMinutes(mn.end_time)   + BLOCK_BUFFER_AFTER  : ms + 120;
          return ms < clampedEnd && me > clampedStart;
        });
        allCBlocks.push({
          date,
          startMin:       clampedStart,
          endMin:         clampedEnd,
          durationMins:   durMins,
          durationHours:  durMins / 60,
          tripIds:        raw.tripIds,
          tripCount:      raw.tripIds.length,
          blockSource:    hasTrips && hasMustInclude ? 'fahrtenbuch+note' : hasMustInclude ? 'note' : 'fahrtenbuch',
          hasMustInclude,
          noteBlockReason: isDriverBlockedFast(effectiveId, date, noteIndex, clampedStart, clampedEnd),
          splitReason:    raw.splitReason,
          capped:         raw.capped,
          crossesMidnight: raw.crossesMidnight,
        });
      }
    }

    // ── Emit capped / note-blocked immediately (not selectable) ──────────────
    const plannable: CBlock[] = [];
    for (const cb of allCBlocks) {
      if (cb.capped) {
        const block: ProposedBlock = {
          date: cb.date, driverIndex: driverIdx,
          originalDriverId: effectiveId, originalDriverName: dbDriver.name,
          startTime: minutesToTime(cb.startMin), endTime: minutesToTime(cb.endMin),
          durationHours: cb.durationHours, tripCount: cb.tripCount, tripIds: cb.tripIds,
          status: 'too_many_blocks', reason: 'Zu viele Schichten an einem Tag (Limit erreicht)',
          isReassigned: false, blockSource: cb.blockSource,
        };
        allBlocks.push(block);
        driverBlocks.get(effectiveId)!.push(block);
        driverWarnings.get(effectiveId)!.push(`${cb.date}: Zu viele Schichten — einige Blöcke wurden übersprungen`);
      } else if (cb.noteBlockReason !== null) {
        const block: ProposedBlock = {
          date: cb.date, driverIndex: driverIdx,
          originalDriverId: effectiveId, originalDriverName: dbDriver.name,
          startTime: minutesToTime(cb.startMin), endTime: minutesToTime(cb.endMin),
          durationHours: cb.durationHours, tripCount: cb.tripCount, tripIds: cb.tripIds,
          status: 'blocked_by_note', reason: `Durch Notiz blockiert: ${cb.noteBlockReason}`,
          isReassigned: false, blockSource: cb.blockSource,
        };
        allBlocks.push(block);
        driverBlocks.get(effectiveId)!.push(block);
      } else {
        plannable.push(cb);
      }
    }

    // ── b) Per-date: pick best non-overlapping combo under daily limit ───────
    const dailyPlannable = new Map<string, CBlock[]>();
    for (const cb of plannable) {
      if (!dailyPlannable.has(cb.date)) dailyPlannable.set(cb.date, []);
      dailyPlannable.get(cb.date)!.push(cb);
    }

    const dailySelected:  CBlock[] = [];
    const dailyRejected:  CBlock[] = [];

    for (const [, dayCandidates] of dailyPlannable) {
      const { selectedIdx, rejectedIdx } = selectBestDailyBlocks(dayCandidates, maxShiftMinutes);
      for (const i of selectedIdx) dailySelected.push(dayCandidates[i]);
      for (const i of rejectedIdx) dailyRejected.push(dayCandidates[i]);
    }

    // ── c) Monthly: greedily add by value until softCap ─────────────────────
    const maxH        = dbDriver.max_monthly_hours;
    const targetH     = dbDriver.target_monthly_hours;
    const hardCapMins = maxH != null ? maxH * 60 : Infinity;

    const planHourlyRate   = dbDriver.planning_hourly_rate ?? null;
    const planTargetSalary = dbDriver.planning_target_salary ?? null;
    const hasSalaryGoal = planHourlyRate != null && planHourlyRate > 0 && planTargetSalary != null && planTargetSalary > 0;
    const rateCents = hasSalaryGoal ? Math.round(planHourlyRate! * 100) : 0;
    const salarySoftCapCents = hasSalaryGoal ? Math.round((planTargetSalary! + salaryToleranceAmount) * 100) : null;

    // Sort by gross density if salary goal, else by duration
    if (hasSalaryGoal) {
      dailySelected.sort((a, b) => {
        const grossA = blockGrossCents(a.durationMins, a.startMin, a.endMin, a.date, holidaySet, rateCents);
        const grossB = blockGrossCents(b.durationMins, b.startMin, b.endMin, b.date, holidaySet, rateCents);
        const densA = a.durationMins > 0 ? grossA / a.durationMins : 0;
        const densB = b.durationMins > 0 ? grossB / b.durationMins : 0;
        return densA - densB; // ascending: pick cheapest blocks first to stay near salary target
      });
    } else {
      dailySelected.sort((a, b) =>
        (b.durationMins * 1000 + b.tripCount) - (a.durationMins * 1000 + a.tripCount)
      );
    }

    const alreadyAssignedMins = (driverHours.get(effectiveId) ?? 0) * 60;
    let usedMonthlyMins = alreadyAssignedMins;
    let accumulatedGrossCents = 0;
    const monthlySelected: CBlock[] = [];
    const monthlySkipped:  CBlock[] = [];

    for (const cb of dailySelected) {
      if (usedMonthlyMins + cb.durationMins > hardCapMins) {
        monthlySkipped.push(cb);
        continue;
      }
      if (hasSalaryGoal && salarySoftCapCents != null) {
        const bCents = blockGrossCents(cb.durationMins, cb.startMin, cb.endMin, cb.date, holidaySet, rateCents);
        if (accumulatedGrossCents >= salarySoftCapCents && !cb.hasMustInclude) {
          monthlySkipped.push(cb);
          continue;
        }
        monthlySelected.push(cb);
        usedMonthlyMins += cb.durationMins;
        accumulatedGrossCents += bCents;
      } else {
        monthlySelected.push(cb);
        usedMonthlyMins += cb.durationMins;
      }
    }

    // ── d) Emit OK for selected blocks (with cross-midnight / short-block detection)
    for (const cb of monthlySelected) {
      const isShort = cb.durationMins > 0 && cb.durationMins < minBlockMinutes;
      let status: ProposedBlock['status'] = 'ok';
      let reason = cb.splitReason ?? (cb.hasMustInclude ? 'Enthält Pflichtzeit aus Notiz' : '');
      if (cb.crossesMidnight) {
        status = 'cross_midnight';
        reason = `Mitternachtsblock: Fahrt(en) enden nach 00:00 — Dauer auf aktuellen Tag begrenzt (${minutesToTime(cb.startMin)}–23:59). ${reason}`.trim();
      } else if (isShort) {
        status = 'short_block';
        reason = `Kurzer Block: ${cb.durationMins} Min. (Minimum: ${minBlockMinutes} Min.). ${reason}`.trim();
      }
      const block: ProposedBlock = {
        date: cb.date, driverIndex: driverIdx,
        originalDriverId: effectiveId, originalDriverName: dbDriver.name,
        startTime: minutesToTime(cb.startMin), endTime: minutesToTime(cb.endMin),
        durationHours: cb.durationHours, tripCount: cb.tripCount, tripIds: cb.tripIds,
        status, reason,
        isReassigned: false, blockSource: cb.blockSource,
        crossesMidnight: cb.crossesMidnight, isShortBlock: isShort,
      };
      allBlocks.push(block);
      driverBlocks.get(effectiveId)!.push(block);
      driverHours.set(effectiveId, (driverHours.get(effectiveId) ?? 0) + cb.durationHours);
      driverTripCount.set(effectiveId, (driverTripCount.get(effectiveId) ?? 0) + cb.tripCount);
      const dm = dailyMinutes.get(effectiveId)!;
      dm.set(cb.date, (dm.get(cb.date) ?? 0) + cb.durationMins);
    }

    // ── e) Offer rejected blocks to coverage, else emit warning ─────────────
    for (const cb of dailyRejected) {
      if (!tryAssignCoverage(cb, effectiveId, dbDriver.name, driverIdx, true)) {
        const reason = `Überschreitet Tageslimit (${(maxShiftMinutes / 60).toFixed(1)} Std.)`;
        const block: ProposedBlock = {
          date: cb.date, driverIndex: driverIdx,
          originalDriverId: effectiveId, originalDriverName: dbDriver.name,
          startTime: minutesToTime(cb.startMin), endTime: minutesToTime(cb.endMin),
          durationHours: cb.durationHours, tripCount: cb.tripCount, tripIds: cb.tripIds,
          status: 'exceeds_daily_limit', reason,
          isReassigned: false, blockSource: cb.blockSource,
        };
        allBlocks.push(block);
        driverBlocks.get(effectiveId)!.push(block);
        driverWarnings.get(effectiveId)!.push(`${cb.date}: ${reason} — Block ${minutesToTime(cb.startMin)}-${minutesToTime(cb.endMin)}`);
      }
    }

    for (const cb of monthlySkipped) {
      if (!tryAssignCoverage(cb, effectiveId, dbDriver.name, driverIdx, false)) {
        const reason = 'Nicht ausgewählt zugunsten besserer Zielerreichung';
        const block: ProposedBlock = {
          date: cb.date, driverIndex: driverIdx,
          originalDriverId: effectiveId, originalDriverName: dbDriver.name,
          startTime: minutesToTime(cb.startMin), endTime: minutesToTime(cb.endMin),
          durationHours: cb.durationHours, tripCount: cb.tripCount, tripIds: cb.tripIds,
          status: 'no_capacity', reason,
          isReassigned: false, blockSource: cb.blockSource,
        };
        allBlocks.push(block);
        driverBlocks.get(effectiveId)!.push(block);
      }
    }

    if (++driverCount % YIELD_EVERY_N_DRIVERS === 0) {
      onProgress?.(`Erstelle Schichtblöcke … (${driverCount}/${allDriverIds.length} Fahrer)`);
      await yieldToUI();
    }
  }
  console.timeEnd('phase1-blocks');

  // ── Phase 2: stand-alone must_include blocks (driver had no trips that day) ──
  onProgress?.('Prüfe Pflichtnotizen …');
  console.time('phase2-must-include');
  for (const d of activePlanDrivers) {
    const driverIdx = driverIndexMap.get(d.id) ?? -1;
    for (const date of noteIndex.mustIncludeDatesByDriver.get(d.id) ?? []) {
      const alreadyHasBlock = (driverBlocks.get(d.id) ?? []).some(b => b.date === date);
      if (alreadyHasBlock) continue;
      const mustNotes = getMustIncludeNotesFast(d.id, date, noteIndex);
      if (mustNotes.length === 0) continue;
      const blockedReason = isDriverBlockedFast(d.id, date, noteIndex);
      let blockStartMin = 1440, blockEndMin = 0;
      for (const mn of mustNotes) {
        if (!mn.start_time) {
          driverWarnings.get(d.id)!.push(`${date}: Pflichtnotiz ohne Uhrzeit`);
          continue;
        }
        const s = timeToMinutes(mn.start_time) - BLOCK_BUFFER_BEFORE;
        const e = mn.end_time ? timeToMinutes(mn.end_time) + BLOCK_BUFFER_AFTER : timeToMinutes(mn.start_time) + 60 + BLOCK_BUFFER_AFTER;
        blockStartMin = Math.min(blockStartMin, s);
        blockEndMin   = Math.max(blockEndMin,   e);
      }
      if (blockStartMin >= blockEndMin) continue;
      blockStartMin = Math.max(0, blockStartMin);
      blockEndMin   = Math.min(1440, blockEndMin);
      const durationHours = (blockEndMin - blockStartMin) / 60;
      const block: ProposedBlock = {
        date, driverIndex: driverIdx,
        originalDriverId: d.id, originalDriverName: d.name,
        startTime: minutesToTime(blockStartMin), endTime: minutesToTime(blockEndMin),
        durationHours, tripCount: 0, tripIds: [],
        status: blockedReason ? 'blocked_by_note' : 'ok',
        reason: blockedReason ? `Durch Notiz blockiert: ${blockedReason}` : 'Pflichtblock aus Notiz',
        isReassigned: false, blockSource: 'note',
      };
      allBlocks.push(block);
      driverBlocks.get(d.id)!.push(block);
      if (!blockedReason) driverHours.set(d.id, (driverHours.get(d.id) ?? 0) + durationHours);
    }
  }
  console.timeEnd('phase2-must-include');

  // ── Phase 2b: HARD-LIMIT rebalance — enforce max_monthly_hours ────────────
  onProgress?.('Prüfe Maximalstunden-Limits …');
  console.time('phase2b-rebalance');
  await yieldToUI();

  for (const d of activePlanDrivers) {
    if (d.max_monthly_hours == null) continue;
    const hardCapMinsD = d.max_monthly_hours * 60;
    const currentMins  = (driverHours.get(d.id) ?? 0) * 60;
    if (currentMins <= hardCapMinsD) continue;

    const driverIdx = driverIndexMap.get(d.id) ?? -1;
    const myBlocks = driverBlocks.get(d.id) ?? [];

    const movable = myBlocks
      .filter(b => b.status === 'ok' || b.status === 'short_block' || b.status === 'cross_midnight')
      .filter(b => b.blockSource !== 'note')
      .sort((a, b) => {
        if (a.isReassigned !== b.isReassigned) return a.isReassigned ? -1 : 1;
        if (a.tripCount !== b.tripCount) return a.tripCount - b.tripCount;
        return a.durationHours - b.durationHours;
      });

    let excessMins = currentMins - hardCapMinsD;

    for (const block of movable) {
      if (excessMins <= 0) break;
      const blockMins = Math.round(block.durationHours * 60);

      let bestCov: Driver | null = null;
      let bestScore = Infinity;
      for (const cov of replacementDrivers) {
        if (cov.id === d.id) continue;
        if (isDriverBlockedFast(cov.id, block.date, noteIndex, timeToMinutes(block.startTime), timeToMinutes(block.endTime))) continue;

        const covHardCap = cov.max_monthly_hours != null ? cov.max_monthly_hours * 60 : Infinity;
        const covTarget  = cov.target_monthly_hours != null ? cov.target_monthly_hours * 60 : Infinity;
        const covUsedMonthly = (driverHours.get(cov.id) ?? 0) * 60;
        const covUsedDaily   = dailyMinutes.get(cov.id)?.get(block.date) ?? 0;

        if (covUsedMonthly + blockMins > covHardCap) continue;
        if (covUsedDaily + blockMins > maxShiftMinutes) continue;

        let score = 0;
        if (covUsedMonthly < covTarget) score -= 10000;
        score -= (covHardCap - covUsedMonthly - blockMins);
        score += (cov.planning_priority ?? 100);
        if (cov.driver_usage_type === 'coverage_only') score += 15000;
        if (score < bestScore) { bestScore = score; bestCov = cov; }
      }

      if (bestCov) {
        const covIdx = driverIndexMap.get(bestCov.id) ?? -1;
        const covRemainingH = bestCov.target_monthly_hours != null
          ? Math.max(0, bestCov.target_monthly_hours - (driverHours.get(bestCov.id) ?? 0))
          : null;
        const whyProposed = covRemainingH != null
          ? `${bestCov.name} hat noch ${covRemainingH.toFixed(1)} Std. unter Ziel`
          : `${bestCov.name} hat freie Kapazität`;
        const usageLabel = bestCov.driver_usage_type === 'coverage_only' ? ' [Deckungsfahrer]' : '';

        block.status = 'proposed_reassignment';
        block.reason = `${d.name}: Maximalstunden (${d.max_monthly_hours} Std.) überschritten. Vorschlag: ${whyProposed}${usageLabel}`;
        block.isReassigned = true;
        block.driverIndex = covIdx;

        driverHours.set(d.id, (driverHours.get(d.id) ?? 0) - block.durationHours);
        driverTripCount.set(d.id, (driverTripCount.get(d.id) ?? 0) - block.tripCount);
        const dDM = dailyMinutes.get(d.id)!;
        dDM.set(block.date, (dDM.get(block.date) ?? 0) - blockMins);

        driverHours.set(bestCov.id, (driverHours.get(bestCov.id) ?? 0) + block.durationHours);
        driverTripCount.set(bestCov.id, (driverTripCount.get(bestCov.id) ?? 0) + block.tripCount);
        const covDM = dailyMinutes.get(bestCov.id)!;
        covDM.set(block.date, (covDM.get(block.date) ?? 0) + blockMins);
        driverBlocks.get(bestCov.id)!.push(block);

        excessMins -= blockMins;
      } else {
        block.status = 'exceeds_monthly_max';
        block.reason = `Überschreitet maximale Monatsstunden (${d.max_monthly_hours} Std.) und konnte nicht umverteilt werden`;

        driverHours.set(d.id, (driverHours.get(d.id) ?? 0) - block.durationHours);
        driverTripCount.set(d.id, (driverTripCount.get(d.id) ?? 0) - block.tripCount);
        const dDM = dailyMinutes.get(d.id)!;
        dDM.set(block.date, (dDM.get(block.date) ?? 0) - blockMins);

        driverWarnings.get(d.id)!.push(
          `${block.date}: Block ${block.startTime}–${block.endTime} überschreitet Maximalstunden — nicht umverteilbar`
        );
        excessMins -= blockMins;
      }
    }

    if (excessMins > 0) {
      driverWarnings.get(d.id)!.push(
        `Maximalstunden (${d.max_monthly_hours} Std.) noch um ${(excessMins / 60).toFixed(1)} Std. überschritten — keine weiteren Blöcke umverteilbar`
      );
    }
  }
  console.timeEnd('phase2b-rebalance');

  // ── Phase 2c: salary rebalance — move premium-heavy blocks from over-salary drivers ──
  onProgress?.('Gehaltsoptimierung …');
  console.time('phase2c-salary-rebalance');
  await yieldToUI();

  const activeStatuses = new Set<ProposedBlock['status']>(['ok', 'short_block', 'cross_midnight', 'manually_assigned', 'manually_confirmed']);

  for (const d of activePlanDrivers) {
    const dRate = d.planning_hourly_rate;
    const dTarget = d.planning_target_salary;
    if (!dRate || dRate <= 0 || !dTarget || dTarget <= 0) continue;

    const dRateCents = Math.round(dRate * 100);
    const myBlocks = driverBlocks.get(d.id) ?? [];
    const activeBlocks = myBlocks.filter(b => activeStatuses.has(b.status));
    const currentGross = calcExpectedGross(activeBlocks, dRate, holidaySet);
    const overAmount = currentGross - (dTarget + salaryToleranceAmount);
    if (overAmount <= 0) continue;

    // Sort blocks by gross contribution DESC — try to move the most expensive ones first
    const movable = activeBlocks
      .filter(b => b.blockSource !== 'note' && !b.manualResolution)
      .map(b => {
        const sm = timeToMinutes(b.startTime);
        const em = timeToMinutes(b.endTime);
        const dm = Math.round(b.durationHours * 60);
        return { block: b, grossCents: blockGrossCents(dm, sm, em, b.date, holidaySet, dRateCents) };
      })
      .sort((a, b) => b.grossCents - a.grossCents);

    let remainingOverCents = Math.round(overAmount * 100);

    for (const { block, grossCents } of movable) {
      if (remainingOverCents <= 0) break;
      const blockMins = Math.round(block.durationHours * 60);

      // Find a driver below their salary target to take this block
      let bestCov: Driver | null = null;
      let bestScore = Infinity;
      for (const cov of replacementDrivers) {
        if (cov.id === d.id) continue;
        if (isDriverBlockedFast(cov.id, block.date, noteIndex, timeToMinutes(block.startTime), timeToMinutes(block.endTime))) continue;

        const covHardCap = cov.max_monthly_hours != null ? cov.max_monthly_hours * 60 : Infinity;
        const covUsedMonthly = (driverHours.get(cov.id) ?? 0) * 60;
        const covUsedDaily   = dailyMinutes.get(cov.id)?.get(block.date) ?? 0;
        if (covUsedMonthly + blockMins > covHardCap) continue;
        if (covUsedDaily + blockMins > maxShiftMinutes) continue;

        const covRate = cov.planning_hourly_rate;
        const covSalTgt = cov.planning_target_salary;
        const covHasSalary = covRate != null && covRate > 0 && covSalTgt != null && covSalTgt > 0;

        let score = 0;
        if (covHasSalary) {
          const covActiveBlocks = (driverBlocks.get(cov.id) ?? []).filter(b2 => activeStatuses.has(b2.status));
          const covCurrentGross = calcExpectedGross(covActiveBlocks, covRate!, holidaySet);
          if (covCurrentGross >= covSalTgt! + salaryToleranceAmount) continue; // already over
          const deficit = covSalTgt! - covCurrentGross;
          score = -deficit * 100; // bigger deficit = lower score = preferred
        } else {
          const covTarget = cov.target_monthly_hours != null ? cov.target_monthly_hours * 60 : Infinity;
          if (covUsedMonthly < covTarget) score -= 10000;
        }
        score += (cov.planning_priority ?? 100);
        if (cov.driver_usage_type === 'coverage_only') score += 15000;
        if (score < bestScore) { bestScore = score; bestCov = cov; }
      }

      if (bestCov) {
        const covIdx = driverIndexMap.get(bestCov.id) ?? -1;
        block.status = 'proposed_reassignment';
        block.reason = `${d.name}: Über Wunschgehalt (${dTarget.toFixed(0)} €). Umverteilt an ${bestCov.name}`;
        block.isReassigned = true;
        block.driverIndex = covIdx;

        driverHours.set(d.id, (driverHours.get(d.id) ?? 0) - block.durationHours);
        driverTripCount.set(d.id, (driverTripCount.get(d.id) ?? 0) - block.tripCount);
        const dDM = dailyMinutes.get(d.id)!;
        dDM.set(block.date, (dDM.get(block.date) ?? 0) - blockMins);

        driverHours.set(bestCov.id, (driverHours.get(bestCov.id) ?? 0) + block.durationHours);
        driverTripCount.set(bestCov.id, (driverTripCount.get(bestCov.id) ?? 0) + block.tripCount);
        const covDM = dailyMinutes.get(bestCov.id)!;
        covDM.set(block.date, (covDM.get(block.date) ?? 0) + blockMins);
        driverBlocks.get(bestCov.id)!.push(block);

        remainingOverCents -= grossCents;
      }
    }

    if (remainingOverCents > 0) {
      driverWarnings.get(d.id)!.push(
        `Wunschgehalt nicht erreichbar wegen Fahrtenstruktur (${(remainingOverCents / 100).toFixed(2).replace('.', ',')} € über Ziel)`
      );
    }
  }
  console.timeEnd('phase2c-salary-rebalance');

  // ── Phase 2d: REGULAR-FIRST rebalance — move blocks from coverage drivers
  //    back to regular drivers that still have capacity and salary deficit ──────
  onProgress?.('Reguläre-Fahrer-Priorisierung …');
  console.time('phase2d-regular-first');
  await yieldToUI();

  const coverageDriverIds = activePlanDrivers
    .filter(d => d.driver_usage_type === 'coverage_only')
    .map(d => d.id);
  const regularDriversList = activePlanDrivers
    .filter(d => d.driver_usage_type !== 'coverage_only');

  for (const covId of coverageDriverIds) {
    const covDriver = driverById.get(covId)!;
    const covBlocks = driverBlocks.get(covId) ?? [];
    const movable = covBlocks
      .filter(b => (b.status === 'ok' || b.status === 'short_block' || b.status === 'cross_midnight'
        || b.status === 'proposed_reassignment') && b.blockSource !== 'note' && !b.manualResolution)
      .sort((a, b) => a.durationHours - b.durationHours);

    for (const block of movable) {
      const blockMins = Math.round(block.durationHours * 60);
      const bStartMin = timeToMinutes(block.startTime);
      const bEndMin   = timeToMinutes(block.endTime);

      let bestReg: Driver | null = null;
      let bestScore = Infinity;

      for (const reg of regularDriversList) {
        if (reg.id === block.originalDriverId && block.isReassigned) {
          // Don't return to original driver if it was reassigned away for a reason
        }
        if (isDriverBlockedFast(reg.id, block.date, noteIndex, bStartMin, bEndMin)) continue;

        const regHardCap = reg.max_monthly_hours != null ? reg.max_monthly_hours * 60 : Infinity;
        const regUsedMonthly = (driverHours.get(reg.id) ?? 0) * 60;
        const regUsedDaily   = dailyMinutes.get(reg.id)?.get(block.date) ?? 0;
        if (regUsedMonthly + blockMins > regHardCap) continue;
        if (regUsedDaily + blockMins > maxShiftMinutes) continue;

        const regRate   = reg.planning_hourly_rate;
        const regSalTgt = reg.planning_target_salary;
        const regHasSalary = regRate != null && regRate > 0 && regSalTgt != null && regSalTgt > 0;

        let score = 0;
        if (regHasSalary) {
          const regActiveBlocks = (driverBlocks.get(reg.id) ?? []).filter(b2 => activeStatuses.has(b2.status));
          const regCurrentGross = calcExpectedGross(regActiveBlocks, regRate!, holidaySet);
          if (regCurrentGross >= regSalTgt! + salaryToleranceAmount) continue;
          const deficit = regSalTgt! - regCurrentGross;
          if (deficit <= 0) continue;
          score = -deficit * 100;
        } else {
          const regTarget = reg.target_monthly_hours != null ? reg.target_monthly_hours * 60 : null;
          if (regTarget != null && regUsedMonthly >= regTarget) continue;
          if (regTarget != null) score -= (regTarget - regUsedMonthly) * 10;
        }
        score += (reg.planning_priority ?? 100);
        if (score < bestScore) { bestScore = score; bestReg = reg; }
      }

      if (bestReg) {
        const regIdx = driverIndexMap.get(bestReg.id) ?? -1;
        const prevStatus = block.status;

        block.status = prevStatus === 'proposed_reassignment' ? 'proposed_reassignment' : 'ok';
        block.reason = `Umverteilt von Deckungsfahrer ${covDriver.name} an regulären Fahrer ${bestReg.name}`;
        block.isReassigned = true;
        block.driverIndex = regIdx;

        driverHours.set(covId, (driverHours.get(covId) ?? 0) - block.durationHours);
        driverTripCount.set(covId, (driverTripCount.get(covId) ?? 0) - block.tripCount);
        const covDM = dailyMinutes.get(covId)!;
        covDM.set(block.date, (covDM.get(block.date) ?? 0) - blockMins);

        driverHours.set(bestReg.id, (driverHours.get(bestReg.id) ?? 0) + block.durationHours);
        driverTripCount.set(bestReg.id, (driverTripCount.get(bestReg.id) ?? 0) + block.tripCount);
        const regDM = dailyMinutes.get(bestReg.id)!;
        regDM.set(block.date, (regDM.get(block.date) ?? 0) + blockMins);
        driverBlocks.get(bestReg.id)!.push(block);
      }
    }
  }
  console.timeEnd('phase2d-regular-first');

  // ── Phase 3: build per-driver summaries ─────────────────────────────────────
  onProgress?.('Erstelle Vorschau …');
  console.time('phase3-summary');
  await yieldToUI();

  const planDrivers: PlanDriver[] = activePlanDrivers.map(d => {
    const blocks    = driverBlocks.get(d.id) ?? [];
    const overflows = allBlocks.filter(b => b.isReassigned && b.originalDriverId === d.id).length;
    const warnings  = [...(driverWarnings.get(d.id) ?? [])];
    const h = driverHours.get(d.id) ?? 0;
    if (d.max_monthly_hours != null && h > d.max_monthly_hours)
      warnings.push(`Maximalstunden überschritten: ${fmtHours(h)} > ${fmtHours(d.max_monthly_hours)}`);
    else if (d.target_monthly_hours != null && h < d.target_monthly_hours * 0.9)
      warnings.push(`Unter Zielstunden: ${fmtHours(h)} (Ziel: ${fmtHours(d.target_monthly_hours)})`);

    // Salary summary
    const pRate = d.planning_hourly_rate;
    const pTarget = d.planning_target_salary;
    let expectedGross: number | null = null;
    let salaryDiff: number | null = null;
    let salaryStatus: PlanDriver['salaryStatus'] = 'no_rate';

    if (pRate != null && pRate > 0) {
      const countableBlocks = blocks.filter(b =>
        b.status === 'ok' || b.status === 'short_block' || b.status === 'cross_midnight'
        || b.status === 'manually_assigned' || b.status === 'manually_confirmed'
      );
      expectedGross = calcExpectedGross(countableBlocks, pRate, holidaySet);
      if (pTarget != null && pTarget > 0) {
        salaryDiff = expectedGross - pTarget;
        if (Math.abs(salaryDiff) <= salaryToleranceAmount) salaryStatus = 'ok';
        else if (salaryDiff > 0) {
          salaryStatus = 'over';
          warnings.push(`Über Wunschgehalt: +${salaryDiff.toFixed(2).replace('.', ',')} €`);
        } else {
          salaryStatus = 'under';
          warnings.push(`Unter Wunschgehalt: ${salaryDiff.toFixed(2).replace('.', ',')} €`);
        }
      } else {
        salaryStatus = 'no_target';
      }
    } else {
      if (pTarget != null && pTarget > 0) {
        warnings.push('Stundensatz fehlt — Gehaltsoptimierung nicht möglich');
      }
    }

    // Coverage usage diagnostics
    const coverageReasons: CoverageUsageReason[] = [];
    if (d.driver_usage_type === 'coverage_only') {
      const reasonCounts = { daily_limit: 0, salary_limit: 0, monthly_limit: 0, note_blocked: 0, no_regular_capacity: 0 };
      for (const b of blocks) {
        if (!b.isReassigned && b.status !== 'proposed_reassignment') continue;
        const r = b.reason ?? '';
        if (r.includes('Tageslimit')) reasonCounts.daily_limit++;
        else if (r.includes('Wunschgehalt') || r.includes('Monatsziel')) reasonCounts.salary_limit++;
        else if (r.includes('Maximalstunden')) reasonCounts.monthly_limit++;
        else if (r.includes('Notiz') || r.includes('blockiert')) reasonCounts.note_blocked++;
        else reasonCounts.no_regular_capacity++;
      }
      for (const [type, count] of Object.entries(reasonCounts)) {
        if (count > 0) coverageReasons.push({ type: type as CoverageUsageReason['type'], count });
      }
    }

    return {
      driver: d, totalHours: h,
      tripCount: driverTripCount.get(d.id) ?? 0,
      blocks, warnings: [...new Set(warnings)], proposedOverflows: overflows,
      expectedGross, salaryDiff, salaryStatus,
      coverageReasons,
      isCoverageOverTargetWhileRegularsNeed: false,
    };
  });

  // Post-compute: flag coverage drivers that are over target while regular drivers still need work
  const regularsWithDeficit = planDrivers.filter(pd =>
    pd.driver.driver_usage_type !== 'coverage_only' && pd.salaryStatus === 'under');
  if (regularsWithDeficit.length > 0) {
    for (const pd of planDrivers) {
      if (pd.driver.driver_usage_type === 'coverage_only' && (pd.salaryStatus === 'over' || pd.salaryStatus === 'ok')) {
        pd.isCoverageOverTargetWhileRegularsNeed = true;
        pd.warnings.push(`Deckungsfahrer über Ziel, obwohl ${regularsWithDeficit.length} reguläre Fahrer noch Bedarf haben`);
      }
    }
  }

  console.timeEnd('phase3-summary');

  const uncoveredStatuses = new Set<ProposedBlock['status']>(['no_capacity', 'missing_driver', 'exceeds_daily_limit', 'exceeds_monthly_max']);
  const coveredTrips   = allBlocks.filter(b => !uncoveredStatuses.has(b.status)).reduce((s, b) => s + b.tripCount, 0);
  const uncoveredTrips = allBlocks.filter(b => uncoveredStatuses.has(b.status)).reduce((s, b) => s + b.tripCount, 0);

  return {
    totalTrips:            nonCanceled.length,
    canceledTrips:         trips.filter(t => t.is_canceled).length,
    coveredTrips:          Math.min(coveredTrips, nonCanceled.length),
    uncoveredTrips,
    proposedReassignments: allBlocks.filter(b => b.status === 'proposed_reassignment').length,
    driversOverTarget:     planDrivers.filter(pd => pd.driver.target_monthly_hours != null && pd.totalHours > pd.driver.target_monthly_hours).length,
    driversOverMax:        planDrivers.filter(pd => pd.driver.max_monthly_hours != null && pd.totalHours > pd.driver.max_monthly_hours).length,
    planDrivers,
    allBlocks: allBlocks.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)),
  };
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ProposedBlock['status'] }) {
  const map: Record<ProposedBlock['status'], { label: string; bg: string; color: string }> = {
    ok:                    { label: 'OK',                         bg: 'var(--success-subtle)', color: 'var(--success)' },
    proposed_reassignment: { label: 'Vorgeschlagener Wechsel',    bg: 'var(--warning-subtle)', color: 'var(--warning)' },
    no_capacity:           { label: 'Keine Kapazität',            bg: 'var(--danger-subtle)',  color: 'var(--danger)' },
    blocked_by_note:       { label: 'Durch Notiz gesperrt',       bg: 'var(--danger-subtle)',  color: 'var(--danger)' },
    missing_driver:        { label: 'Fahrer unbekannt',           bg: 'var(--bg-muted)',       color: 'var(--text-tertiary)' },
    too_many_blocks:       { label: 'Zu viele Schichten',         bg: 'var(--warning-subtle)', color: 'var(--warning)' },
    exceeds_daily_limit:   { label: 'Über Tageslimit',            bg: 'var(--warning-subtle)', color: 'var(--warning)' },
    short_block:           { label: 'Kurzer Block',               bg: 'var(--warning-subtle)', color: 'var(--warning)' },
    cross_midnight:        { label: 'Mitternacht',                bg: 'var(--accent-subtle)',  color: 'var(--accent-text)' },
    exceeds_monthly_max:   { label: 'Über Maximalstunden',        bg: 'var(--danger-subtle)',  color: 'var(--danger)' },
    manually_assigned:     { label: 'Manuell zugewiesen',        bg: '#dbeafe',               color: '#1d4ed8' },
    manually_confirmed:    { label: 'Manuell bestätigt',         bg: '#dbeafe',               color: '#1d4ed8' },
    excluded_from_apply:   { label: 'Ausgeschlossen',            bg: 'var(--bg-muted)',       color: 'var(--text-tertiary)' },
  };
  const s = map[status];
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap"
      style={{ background: s.bg, color: s.color }}>{s.label}</span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const CompanyPlannerPage: React.FC = () => {
  const { companyId, user, isAdmin, isSuperAdmin } = useAuth();
  const toast = useToast();
  const { imports, fetchImports, loadingImports } = useFahrtenbuch();
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean; title: string; message: string;
    onConfirm: () => void; type?: 'confirm' | 'error';
  }>({ open: false, title: '', message: '', onConfirm: () => {} });

  useEffect(() => { fetchImports(); }, [fetchImports]);

  const now = new Date();
  const [selMonth,    setSelMonth]    = useState(now.getMonth() + 1);
  const [selYear,     setSelYear]     = useState(now.getFullYear());
  const [selImportId, setSelImportId] = useState('');
  const [maxShiftHours, setMaxShiftHours] = useState('8');
  const [targetToleranceHours, setTargetToleranceHours] = useState('3');
  const [minBlockMinStr, setMinBlockMinStr] = useState(String(DEFAULT_MIN_BLOCK_MINUTES));
  const [salaryToleranceStr, setSalaryToleranceStr] = useState('100');
  const [running,     setRunning]     = useState(false);
  const [plannerStep, setPlannerStep] = useState('');
  const [result,      setResult]      = useState<PlanResult | null>(null);
  const [plannerError, setPlannerError] = useState<string | null>(null);
  const [expandedDrivers, setExpandedDrivers] = useState<Set<string>>(new Set());
  const [showAllBlocks, setShowAllBlocks] = useState(false);
  const [showReview,   setShowReview]   = useState(false);
  const [reviewFilter, setReviewFilter] = useState<'all' | 'reassignment' | 'warnings' | 'critical' | 'short' | 'midnight'>('all');
  const [showDebug,   setShowDebug]   = useState(false);
  const [debugInfo,   setDebugInfo]   = useState<Record<string, string | number>>({});

  // Draft state
  const [saving,      setSaving]      = useState(false);
  const [savedRuns,   setSavedRuns]   = useState<SavedRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [showSavedRuns, setShowSavedRuns] = useState(false);

  // Conflict resolution state
  const [conflictBlockIndex, setConflictBlockIndex] = useState<number | null>(null);

  // Apply state
  const [showApplyModal, setShowApplyModal]   = useState(false);
  const [applying,       setApplying]         = useState(false);
  const [applyProgress,  setApplyProgress]    = useState({ done: 0, total: 0 });
  const [planApplied,    setPlanApplied]       = useState(false);
  const [applyError,     setApplyError]       = useState<string | null>(null);

  // Fahrtenbuch assignment validation
  const [fahrtenbuchValidation, setFahrtenbuchValidation] = useState<ResolvedFahrtenbuchValidation | null>(null);
  const [carResolverResult, setCarResolverResult] = useState<CarBlockResolverResult | null>(null);
  const [resolvedAssignmentMap, setResolvedAssignmentMap] = useState<Map<string, TripAssignment> | null>(null);
  const [showFahrtenbuchCheck, setShowFahrtenbuchCheck] = useState(false);

  // Driver selection for planning
  const [availableDrivers, setAvailableDrivers] = useState<Driver[]>([]);
  const [selectedDriverIds, setSelectedDriverIds] = useState<Set<string>>(new Set());
  const [fahrtenbuchDriverIds, setFahrtenbuchDriverIds] = useState<Set<string>>(new Set());
  const [loadingDrivers, setLoadingDrivers] = useState(false);
  const [showDriverSelection, setShowDriverSelection] = useState(false);
  // Trip IDs currently assigned (in DB) to drivers NOT in the selected pool.
  // A non-empty set means the Fahrtenbuch is NOT clean — stale assignments must be reapplied.
  const [staleAssignedTripIds, setStaleAssignedTripIds] = useState<Set<string>>(new Set());
  // Per-trip details for the stale set, used by the debug section to group by driver/source.
  type StaleTripDetail = { tripId: string; effectiveDriverId: string | null; effectiveDriverName: string | null; source: EffectiveTripDriver['source'] };
  const [staleAssignedTripDetails, setStaleAssignedTripDetails] = useState<StaleTripDetail[]>([]);
  // Becomes true when Fahrer-Auswahl changes after a plan was computed; result must be re-run.
  const [isPlanOutdated, setIsPlanOutdated] = useState(false);
  // Block keys (`${driverIndex}|${date}|${startTime}|${endTime}`) for outside-shift-window
  // assignments the user has explicitly accepted as exceptions.
  const [acceptedShiftExceptions, setAcceptedShiftExceptions] = useState<Set<string>>(new Set());

  // Vehicle-block-first planner result (Step 1-9 of the new pipeline).
  const [vehiclePlanResult, setVehiclePlanResult] = useState<VehicleBlockPlanResult | null>(null);
  const [vehiclePlanApplying, setVehiclePlanApplying] = useState(false);
  const [vehiclePlanApplyError, setVehiclePlanApplyError] = useState<string | null>(null);
  const [vehiclePlanApplied, setVehiclePlanApplied] = useState(false);
  const [showVehicleBlockDetails, setShowVehicleBlockDetails] = useState(true);

  const filteredImports = useMemo(
    () => imports.filter(i => i.month === selMonth && i.year === selYear),
    [imports, selMonth, selYear]
  );

  const maxShiftMinutes      = Math.max(60, Math.min(24 * 60, Math.round((parseFloat(maxShiftHours) || 8) * 60)));
  const parsedToleranceHours = Math.max(0, Math.min(24, parseFloat(targetToleranceHours) || 3));
  const parsedMinBlockMin    = Math.max(0, Math.min(480, parseInt(minBlockMinStr) || DEFAULT_MIN_BLOCK_MINUTES));
  const parsedSalaryTolerance = Math.max(0, Math.min(10000, parseFloat(salaryToleranceStr) || 100));

  // Load drivers and detect Fahrtenbuch driver names for smart default selection
  const activeImportId = selImportId || filteredImports[0]?.id || '';
  const loadDriversForSelection = useCallback(async () => {
    if (!companyId || !activeImportId) {
      setAvailableDrivers([]);
      setSelectedDriverIds(new Set());
      setFahrtenbuchDriverIds(new Set());
      return;
    }
    setLoadingDrivers(true);
    try {
      const [driversRes, tripsRes] = await Promise.all([
        supabase.from('drivers').select('*').eq('company_id', companyId).eq('status', 'active').order('name'),
        supabase.from('fahrtenbuch_trips').select('original_driver_id, original_driver_name, assigned_driver_id').eq('import_id', activeImportId).eq('is_canceled', false),
      ]);
      const allDrivers = (driversRes.data ?? []) as Driver[];
      const planningEligible = allDrivers.filter(d => d.planning_enabled !== false);
      setAvailableDrivers(planningEligible);

      const tripDriverIds = new Set<string>();
      const tripDriverNames = new Set<string>();
      for (const t of tripsRes.data ?? []) {
        if (t.assigned_driver_id) tripDriverIds.add(t.assigned_driver_id);
        if (t.original_driver_id) tripDriverIds.add(t.original_driver_id);
        if (t.original_driver_name) tripDriverNames.add(t.original_driver_name.trim().toLowerCase());
      }
      setFahrtenbuchDriverIds(tripDriverIds);

      const autoSelected = new Set<string>();
      for (const d of planningEligible) {
        if (tripDriverIds.has(d.id) || tripDriverNames.has(d.name.trim().toLowerCase())) {
          autoSelected.add(d.id);
        }
      }
      if (autoSelected.size === 0) {
        for (const d of planningEligible) autoSelected.add(d.id);
      }
      setSelectedDriverIds(autoSelected);
    } finally {
      setLoadingDrivers(false);
    }
  }, [companyId, activeImportId]);

  useEffect(() => { loadDriversForSelection(); }, [loadDriversForSelection]);

  const loadSavedRuns = useCallback(async () => {
    if (!companyId) return;
    setLoadingRuns(true);
    try {
      const { data, error } = await supabase
        .from('company_planning_runs')
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      const runsWithMeta: SavedRun[] = (data ?? []).map((r: any) => {
        const plan = r.summary_json as PlanResult;
        return {
          ...r,
          summary_json:   plan,
          block_count:    plan?.allBlocks?.length ?? 0,
          warning_count:  plan?.planDrivers?.reduce((s: number, pd: PlanDriver) => s + pd.warnings.length, 0) ?? 0,
          import_file_name: imports.find(i => i.id === r.import_id)?.file_name,
        };
      });
      setSavedRuns(runsWithMeta);
    } finally {
      setLoadingRuns(false);
    }
  }, [companyId, imports]);

  useEffect(() => { if (companyId) loadSavedRuns(); }, [loadSavedRuns]);

  const handleRun = async () => {
    if (!companyId) return;
    setRunning(true);
    setResult(null);
    setPlannerError(null);
    setDebugInfo({});
    setCurrentRunId(null);
    setExpandedDrivers(new Set());
    setShowAllBlocks(false);
    setFahrtenbuchValidation(null);
    setCarResolverResult(null);
    setVehiclePlanResult(null);
    setVehiclePlanApplied(false);
    setVehiclePlanApplyError(null);
    setResolvedAssignmentMap(null);
    setShowFahrtenbuchCheck(false);
    setStaleAssignedTripIds(new Set());
    setStaleAssignedTripDetails([]);
    setIsPlanOutdated(false);

    try {
      const importId = selImportId || filteredImports[0]?.id;
      if (!importId) {
        setPlannerError('Kein Fahrtenbuch-Import für den gewählten Monat. Bitte zuerst einen Import hochladen.');
        return;
      }

      // ── Load trips (batched — Supabase default limit is 1000) ──────────────
      setPlannerStep('Lade Fahrten …');
      await yieldToUI();
      console.time('load-trips');

      const tripCols = 'id, trip_date, start_time, end_time, original_driver_id, original_driver_name, assigned_driver_id, assigned_driver_name, is_canceled, price_amount, cash_amount, tip_amount, car_id, car_identifier';
      const BATCH = 1000;
      const allTripsData: FahrtenbuchTrip[] = [];
      let tripOffset = 0;
      while (true) {
        const { data: batch, error: batchErr } = await supabase
          .from('fahrtenbuch_trips')
          .select(tripCols)
          .eq('company_id', companyId)
          .eq('import_id', importId)
          .order('trip_date')
          .order('start_time', { nullsFirst: false })
          .range(tripOffset, tripOffset + BATCH - 1);
        if (batchErr) { setPlannerError(`Fahrten konnten nicht geladen werden: ${batchErr.message}`); return; }
        const rows = (batch ?? []) as FahrtenbuchTrip[];
        allTripsData.push(...rows);
        if (rows.length < BATCH) break;
        tripOffset += BATCH;
      }

      console.timeEnd('load-trips');
      const trips = allTripsData;

      if (trips.length === 0) { setPlannerError('Keine Fahrten in diesem Import gefunden.'); return; }

      // ── Load drivers (filtered to user selection) ──────────────────────────
      setPlannerStep('Lade Fahrer …');
      await yieldToUI();

      const { data: driversData, error: driversError } = await supabase
        .from('drivers')
        .select('*')
        .eq('company_id', companyId)
        .eq('status', 'active')
        .order('name');
      if (driversError) { setPlannerError(`Fahrer konnten nicht geladen werden: ${driversError.message}`); return; }
      const allActiveDrivers = (driversData ?? []) as Driver[];
      const drivers = allActiveDrivers.filter(d => d.planning_enabled !== false && selectedDriverIds.has(d.id));
      const planningDrivers = drivers;
      const regularDrivers  = planningDrivers.filter(d => d.driver_usage_type !== 'coverage_only');
      const coverageDrivers = planningDrivers.filter(d => d.driver_usage_type === 'coverage_only');
      const replacementEligible = planningDrivers.filter(d => d.can_cover_other_drivers !== false || d.driver_usage_type === 'coverage_only');

      if (selectedDriverIds.size === 0) { setPlannerError('Keine Fahrer ausgewählt. Bitte mindestens einen Fahrer in der Fahrer-Auswahl aktivieren.'); return; }
      if (planningDrivers.length === 0) { setPlannerError('Keine der ausgewählten Fahrer ist für die Planung aktiviert.'); return; }
      if (regularDrivers.length === 0)  { setPlannerError('Kein regulärer Fahrer unter den ausgewählten Fahrern. Bitte mindestens einen regulären Fahrer auswählen.'); return; }

      // ── Detect stale assignments using EFFECTIVE driver resolution ──────────
      // A trip is "stale" if its effective driver (assigned → original_id →
      // original_name match) is not part of the user-selected pool. Fresh
      // imports often have assigned_driver_id = null, so checking only that
      // column would miss trips owned via original_driver_id / original_driver_name.
      const staleSet = new Set<string>();
      const staleDetails: StaleTripDetail[] = [];
      for (const t of trips) {
        if (t.is_canceled) continue;
        const effective = getEffectiveTripDriver(t, allActiveDrivers);
        if (effective.driverId && !selectedDriverIds.has(effective.driverId)) {
          staleSet.add(t.id);
          staleDetails.push({
            tripId: t.id,
            effectiveDriverId: effective.driverId,
            effectiveDriverName: effective.driverName,
            source: effective.source,
          });
        }
      }
      setStaleAssignedTripIds(staleSet);
      setStaleAssignedTripDetails(staleDetails);

      // ── Load notes ───────────────────────────────────────────────────────────
      setPlannerStep('Lade Notizen …');
      await yieldToUI();

      const firstDay = `${selYear}-${String(selMonth).padStart(2,'0')}-01`;
      const lastDay  = new Date(selYear, selMonth, 0).getDate();
      const lastDate = `${selYear}-${String(selMonth).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

      // Load all company notes — notes table is small, simpler than complex OR filter
      const { data: notesData, error: notesError } = await supabase
        .from('driver_notes')
        .select('id, driver_id, note_date, note_text, note_type, note_planning_behavior, is_full_day, start_time, end_time, start_date, end_date')
        .eq('company_id', companyId);

      if (notesError) { setPlannerError(`Notizen konnten nicht geladen werden: ${notesError.message}`); return; }
      // Filter in JS to include notes that overlap the target month
      const allNotes = (notesData ?? []) as DriverNote[];
      const notes = allNotes.filter(n => {
        const sd = n.start_date ?? n.note_date.slice(0, 10);
        const ed = n.end_date   ?? sd;
        return sd <= lastDate && ed >= firstDay;
      });

      const nonCanceledCount = trips.filter(t => !t.is_canceled).length;
      setDebugInfo({
        'Monat/Jahr':             `${selMonth}/${selYear}`,
        'Import-ID':              importId,
        'Fahrten geladen':        trips.length,
        'Nicht storniert':        nonCanceledCount,
        'Fahrer (gesamt aktiv)':  allActiveDrivers.length,
        'Fahrer (ausgewählt)':    selectedDriverIds.size,
        'Fahrer (Planung)':       planningDrivers.length,
        'Reguläre Fahrer':        regularDrivers.length,
        'Deckungsfahrer':         coverageDrivers.length,
        'Vertretungsberecht.':    replacementEligible.length,
        'Notizen geladen':        notes.length,
        'Max. Arbeitszeit (Min.)': maxShiftMinutes,
        'Ziel-Toleranz (Std.)':   parsedToleranceHours,
      });

      // ── Run planner ──────────────────────────────────────────────────────────
      console.time('planner-total');
      let planResult: PlanResult;
      try {
        planResult = await runPlannerAsync(trips, drivers, notes, maxShiftMinutes, parsedToleranceHours, parsedMinBlockMin, parsedSalaryTolerance, setPlannerStep);
      } catch (planErr) {
        const msg = planErr instanceof Error ? planErr.message : String(planErr);
        setPlannerError(`Planungsalgorithmus-Fehler: ${msg}`);
        console.error('Planner error:', planErr);
        return;
      }
      console.timeEnd('planner-total');

      setDebugInfo(prev => ({
        ...prev,
        'Blöcke generiert':    planResult.allBlocks.length,
        'Blöcke OK':           planResult.allBlocks.filter(b => b.status === 'ok').length,
        'Wechsel-Vorschläge':  planResult.allBlocks.filter(b => b.status === 'proposed_reassignment').length,
        'Unbekannte Fahrer':   planResult.allBlocks.filter(b => b.status === 'missing_driver').length,
        'Kurze Blöcke':        planResult.allBlocks.filter(b => b.status === 'short_block').length,
        'Mitternacht-Blöcke':  planResult.allBlocks.filter(b => b.status === 'cross_midnight').length,
        'Min. Blockdauer':     `${parsedMinBlockMin} Min.`,
      }));

      setResult(planResult);

      // ── Car block validation ────────────────────────────────────────────────
      setPlannerStep('Fahrzeug-Zuweisung prüfen …');
      await yieldToUI();
      try {
        const { data: carsData } = await supabase
          .from('cars')
          .select('id, kennzeichen')
          .eq('company_id', companyId);

        const carMap = new Map<string, string>();
        for (const c of carsData ?? []) carMap.set(c.id, c.kennzeichen);

        const hasCarTrips = trips.some(t => t.car_id);

        if (hasCarTrips && carMap.size > 0) {
          const allNormForCars: NormalizedTrip[] = [];
          for (const t of trips) {
            if (t.is_canceled || !t.car_id) continue;
            allNormForCars.push(...normalizeTripServiceDate(t));
          }

          const carBlocks = buildCarBlocksFromTrips(allNormForCars, carMap);

          const poolDrivers: PoolDriver[] = drivers.map(d => ({
            id: d.id,
            name: d.name,
            hourlyRate: d.planning_hourly_rate ?? null,
            targetSalary: d.planning_target_salary ?? null,
            currentMonthMinutes: 0,
          }));

          const resolverResult = resolveCarBlocks(carBlocks, poolDrivers);
          const assignmentMap = buildTripAssignmentMap(resolverResult, allNormForCars);
          const validation = validateResolvedFahrtenbuch(assignmentMap);

          setCarResolverResult(resolverResult);
          setResolvedAssignmentMap(assignmentMap);
          setFahrtenbuchValidation(validation);
        } else {
          setCarResolverResult(null);
    setVehiclePlanResult(null);
    setVehiclePlanApplied(false);
    setVehiclePlanApplyError(null);
          setResolvedAssignmentMap(null);
          setFahrtenbuchValidation(null);
        }
      } catch (carErr) {
        console.error('Car block validation error:', carErr);
        setCarResolverResult(null);
    setVehiclePlanResult(null);
    setVehiclePlanApplied(false);
    setVehiclePlanApplyError(null);
        setResolvedAssignmentMap(null);
        setFahrtenbuchValidation(null);
      }

      // ── Vehicle-block-first planner (new pipeline) ──────────────────────────
      setPlannerStep('Fahrzeug-Block-Planer ausführen …');
      await yieldToUI();
      try {
        const vbTrips: VBPlannerTrip[] = trips.map(t => ({
          id: t.id,
          trip_date: t.trip_date,
          start_time: t.start_time,
          end_time: t.end_time,
          duration_minutes: t.duration_minutes,
          car_id: t.car_id,
          car_identifier: t.car_identifier,
          original_driver_id: t.original_driver_id,
          original_driver_name: t.original_driver_name,
          is_canceled: t.is_canceled,
        }));
        const vbDrivers: VBPlannerDriver[] = drivers.map(d => ({
          id: d.id,
          name: d.name,
          work_window_start: d.work_window_start,
          work_window_end: d.work_window_end,
          allowed_weekdays: d.allowed_weekdays,
          allow_outside_shift_exceptions: d.allow_outside_shift_exceptions,
          max_daily_hours: null,
          target_monthly_hours: d.target_monthly_hours ?? null,
          max_monthly_hours: d.max_monthly_hours ?? null,
          planning_target_salary: d.planning_target_salary ?? null,
          planning_hourly_rate: d.planning_hourly_rate ?? null,
          planning_priority: d.planning_priority,
          notes: null,
        }));
        const vbPlan = planVehicleBlocks(vbTrips, vbDrivers);
        setVehiclePlanResult(vbPlan);
        setVehiclePlanApplied(false);
        setVehiclePlanApplyError(null);
      } catch (vbErr) {
        console.error('Vehicle block planner error:', vbErr);
        setVehiclePlanResult(null);
      }

      setPlannerStep('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPlannerError(`Plan-Vorschlag konnte nicht erstellt werden: ${msg}`);
      console.error('handleRun error:', e);
    } finally {
      setRunning(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!result || !companyId) return;
    setSaving(true);
    try {
      const importId     = selImportId || filteredImports[0]?.id || null;
      const totalWarnings = result.planDrivers.reduce((s, pd) => s + pd.warnings.length, 0);

      const { data: runRow, error: runErr } = await supabase
        .from('company_planning_runs')
        .insert({
          company_id: companyId, month: selMonth, year: selYear,
          import_id: importId, status: 'draft',
          max_shift_minutes: maxShiftMinutes,
          summary_json: result,
          settings_json: { maxShiftHours, targetToleranceHours },
          created_by: user?.id ?? null,
        })
        .select('id')
        .single();
      if (runErr) throw runErr;
      const runId = runRow.id as string;
      setCurrentRunId(runId);

      if (result.allBlocks.length > 0) {
        const blockRows = result.allBlocks.map(b => ({
          company_id:          companyId, run_id: runId,
          driver_id:           result.planDrivers[b.driverIndex]?.driver.id ?? null,
          driver_name:         result.planDrivers[b.driverIndex]?.driver.name ?? null,
          driver_usage_type:   result.planDrivers[b.driverIndex]?.driver.driver_usage_type ?? null,
          block_date:          b.date, start_time: b.startTime, end_time: b.endTime,
          duration_minutes:    Math.round(b.durationHours * 60),
          source: b.blockSource, status: b.status, reason: b.reason || null,
          trip_ids:            b.tripIds.length > 0 ? b.tripIds : null,
          original_driver_id:  b.originalDriverId, original_driver_name: b.originalDriverName,
          proposed_driver_id:  b.isReassigned ? (result.planDrivers[b.driverIndex]?.driver.id ?? null) : null,
          proposed_driver_name: b.isReassigned ? (result.planDrivers[b.driverIndex]?.driver.name ?? null) : null,
        }));
        for (let i = 0; i < blockRows.length; i += 100) {
          const { error } = await supabase.from('company_planning_run_blocks').insert(blockRows.slice(i, i + 100));
          if (error) throw error;
        }
      }

      await loadSavedRuns();
      setShowSavedRuns(true);
      toast.success('Planentwurf gespeichert', `${result.allBlocks.length} Blöcke, ${totalWarnings} Warnungen`);
    } catch (e: any) {
      toast.error('Fehler beim Speichern', e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleOpenDraft = (run: SavedRun) => {
    setResult(run.summary_json);
    setSelMonth(run.month);
    setSelYear(run.year);
    if (run.import_id) setSelImportId(run.import_id);
    setMaxShiftHours(String(run.max_shift_minutes / 60));
    if ((run as any).settings_json?.targetToleranceHours != null)
      setTargetToleranceHours(String((run as any).settings_json.targetToleranceHours));
    setCurrentRunId(run.id);
    setPlannerError(null);
    setExpandedDrivers(new Set());
    setShowAllBlocks(false);
    setConflictBlockIndex(null);
    setPlanApplied(run.status === 'applied');
    setApplyError(null);
    setDebugInfo({ 'Geladener Entwurf': run.id.slice(0, 8), 'Erstellt': new Date(run.created_at).toLocaleString('de-DE') });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDeleteDraft = (runId: string) => {
    setConfirmModal({
      open: true,
      title: 'Planentwurf löschen',
      message: 'Planentwurf wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.',
      type: 'confirm',
      onConfirm: async () => {
        const { error } = await supabase
          .from('company_planning_runs')
          .delete()
          .eq('id', runId)
          .eq('company_id', companyId);
        if (error) { toast.error('Fehler', error.message); return; }
        if (currentRunId === runId) setCurrentRunId(null);
        await loadSavedRuns();
        toast.success('Planentwurf gelöscht');
      },
    });
  };

  const toggleDriver = (id: string) =>
    setExpandedDrivers(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  // User-driven mutation of the selected driver pool. Always marks any
  // existing planning result as outdated and clears it so the UI cannot keep
  // showing a stale "Fahrtenbuch ist bereits sauber" state after the pool
  // changes. The freshly-loaded plan from a new handleRun resets isPlanOutdated.
  const updateSelectedDrivers = (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setSelectedDriverIds(prev => (typeof updater === 'function' ? (updater as (p: Set<string>) => Set<string>)(prev) : updater));
    setIsPlanOutdated(true);
    setResult(null);
    setFahrtenbuchValidation(null);
    setCarResolverResult(null);
    setVehiclePlanResult(null);
    setVehiclePlanApplied(false);
    setVehiclePlanApplyError(null);
    setResolvedAssignmentMap(null);
    setStaleAssignedTripIds(new Set());
    setStaleAssignedTripDetails([]);
    setPlanApplied(false);
    setCurrentRunId(null);
    setApplyError(null);
  };

  const conflictBlock = conflictBlockIndex != null && result ? result.allBlocks[conflictBlockIndex] : null;

  const eligibleDriversForConflict = useMemo(() => {
    if (!conflictBlock || !result) return [];
    const block = conflictBlock;
    const blockDate = block.date;
    const blockStartMin = timeToMinutes(block.startTime);
    const blockEndMin = effectiveEndMinutes(blockStartMin, timeToMinutes(block.endTime));
    const blockDurMins = block.durationHours * 60;

    return result.planDrivers
      .map((pd, idx) => {
        const d = pd.driver;
        if (d.planning_enabled === false) return null;

        const driverId = d.id;
        const sameDriver = driverId === block.originalDriverId ||
          (block.manualResolution?.assignedDriverId === driverId);

        const dailyBlocks = result.allBlocks.filter(
          b => b.date === blockDate &&
            result.planDrivers[b.driverIndex]?.driver.id === driverId &&
            b !== block &&
            b.status !== 'excluded_from_apply'
        );

        const dailyHours = dailyBlocks.reduce((s, b) => s + b.durationHours, 0);
        const dailyBlockCount = dailyBlocks.length;

        const hasOverlap = dailyBlocks.some(existing => {
          const exStart = timeToMinutes(existing.startTime);
          const exEnd = effectiveEndMinutes(exStart, timeToMinutes(existing.endTime));
          return blockStartMin < exEnd && blockEndMin > exStart;
        });

        const monthlyHours = pd.totalHours;
        const maxMonthly = d.max_monthly_hours;
        const wouldExceedMonthly = maxMonthly != null && (monthlyHours + block.durationHours) > maxMonthly;

        const maxShiftMins = Math.max(60, Math.min(24 * 60, Math.round((parseFloat(maxShiftHours) || 8) * 60)));
        const wouldExceedDaily = (dailyHours + block.durationHours) * 60 > maxShiftMins;
        const wouldExceedBlocks = dailyBlockCount >= MAX_BLOCKS_PER_DAY;

        const remaining = maxMonthly != null ? maxMonthly - monthlyHours : null;

        const issues: string[] = [];
        if (hasOverlap) issues.push('Zeitüberschneidung');
        if (wouldExceedMonthly) issues.push(`Über Max. (${fmtHours(monthlyHours)} / ${fmtHours(maxMonthly!)})`);
        if (wouldExceedDaily) issues.push('Über Tageslimit');
        if (wouldExceedBlocks) issues.push('Zu viele Schichten');

        return {
          driverIndex: idx,
          driver: d,
          monthlyHours,
          remainingHours: remaining,
          dailyHours,
          dailyBlockCount,
          isValid: issues.length === 0,
          issues,
          isSameAsOriginal: sameDriver,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .sort((a, b) => {
        if (a.isValid !== b.isValid) return a.isValid ? -1 : 1;
        if (a.remainingHours != null && b.remainingHours != null) return b.remainingHours - a.remainingHours;
        return a.monthlyHours - b.monthlyHours;
      });
  }, [conflictBlock, result, maxShiftHours]);

  const resolveConflict = (
    blockIdx: number,
    resolution: 'assign_driver' | 'keep_original' | 'exclude',
    assignedDriverIdx?: number,
  ) => {
    if (!result) return;
    const updatedBlocks = [...result.allBlocks];
    const block = { ...updatedBlocks[blockIdx] };
    const previousStatus = block.status;
    const previousReason = block.reason;

    if (resolution === 'assign_driver' && assignedDriverIdx != null) {
      const targetDriver = result.planDrivers[assignedDriverIdx].driver;
      block.manualResolution = {
        type: 'assign_driver',
        assignedDriverId: targetDriver.id,
        assignedDriverName: targetDriver.name,
        previousStatus,
        previousReason,
      };
      block.status = 'manually_assigned';
      block.reason = `Manuell zugewiesen an ${targetDriver.name} (vorher: ${previousReason})`;
      block.driverIndex = assignedDriverIdx;
      block.isReassigned = true;
    } else if (resolution === 'keep_original') {
      block.manualResolution = {
        type: 'keep_original',
        previousStatus,
        previousReason,
      };
      block.status = 'manually_confirmed';
      block.reason = `Manuell bestätigt beim Originalfahrer (vorher: ${previousReason})`;
    } else if (resolution === 'exclude') {
      block.manualResolution = {
        type: 'exclude',
        previousStatus,
        previousReason,
      };
      block.status = 'excluded_from_apply';
      block.reason = `Ausgeschlossen von Anwendung (vorher: ${previousReason})`;
    }

    updatedBlocks[blockIdx] = block;

    const updatedPlanDrivers = result.planDrivers.map((pd, pdi) => {
      const driverBlocks = updatedBlocks.filter(b => b.driverIndex === pdi);
      const totalHours = driverBlocks
        .filter(b => b.status !== 'excluded_from_apply')
        .reduce((s, b) => s + b.durationHours, 0);
      return { ...pd, blocks: driverBlocks, totalHours };
    });

    setResult({
      ...result,
      allBlocks: updatedBlocks,
      planDrivers: updatedPlanDrivers,
    });
    setConflictBlockIndex(null);
    setCurrentRunId(null);
  };

  const undoResolution = (blockIdx: number) => {
    if (!result) return;
    const updatedBlocks = [...result.allBlocks];
    const block = { ...updatedBlocks[blockIdx] };
    if (!block.manualResolution) return;

    block.status = block.manualResolution.previousStatus;
    block.reason = block.manualResolution.previousReason;
    if (block.manualResolution.type === 'assign_driver') {
      const origIdx = result.planDrivers.findIndex(
        pd => pd.driver.id === block.originalDriverId
      );
      if (origIdx >= 0) block.driverIndex = origIdx;
      block.isReassigned = block.originalDriverId !== result.planDrivers[block.driverIndex]?.driver.id;
    }
    delete block.manualResolution;
    updatedBlocks[blockIdx] = block;

    const updatedPlanDrivers = result.planDrivers.map((pd, pdi) => {
      const driverBlocks = updatedBlocks.filter(b => b.driverIndex === pdi);
      const totalHours = driverBlocks
        .filter(b => b.status !== 'excluded_from_apply')
        .reduce((s, b) => s + b.durationHours, 0);
      return { ...pd, blocks: driverBlocks, totalHours };
    });

    setResult({ ...result, allBlocks: updatedBlocks, planDrivers: updatedPlanDrivers });
    setCurrentRunId(null);
  };

  const APPLICABLE_STATUSES = new Set<ProposedBlock['status']>(['proposed_reassignment', 'manually_assigned']);

  const applicableBlocks = useMemo(() => {
    if (!result) return [];
    return result.allBlocks.filter(b => {
      if (!APPLICABLE_STATUSES.has(b.status)) return false;
      if (b.tripIds.length === 0) return false;
      const proposedDriver = result.planDrivers[b.driverIndex]?.driver;
      if (!proposedDriver?.id) return false;
      // Block is applicable if the proposed driver differs from the original
      // OR if any trip in the block is currently assigned to a driver outside
      // the selected pool (stale state must be cleaned even if the proposed
      // driver matches the original Fahrtenbuch driver).
      const hasStaleTrip = b.tripIds.some(tid => staleAssignedTripIds.has(tid));
      const currentDriverId = b.originalDriverId;
      if (proposedDriver.id === currentDriverId && !hasStaleTrip) return false;
      return true;
    });
  }, [result, staleAssignedTripIds]);

  const applicableTripCount = useMemo(() =>
    applicableBlocks.reduce((s, b) => s + b.tripIds.length, 0),
  [applicableBlocks]);

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-subtle)',
    border: '1px solid var(--border)',
    borderRadius: '0.5rem',
    color: 'var(--text-primary)',
    fontSize: '0.875rem',
    padding: '0.5rem 0.75rem',
    outline: 'none',
  };

  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];

  const CRITICAL_STATUSES = new Set<ProposedBlock['status']>(['no_capacity', 'missing_driver', 'exceeds_monthly_max', 'exceeds_daily_limit']);
  const WARNING_STATUSES  = new Set<ProposedBlock['status']>(['short_block', 'cross_midnight', 'blocked_by_note', 'too_many_blocks']);

  const RESOLVED_STATUSES = new Set<ProposedBlock['status']>(['manually_assigned', 'manually_confirmed', 'excluded_from_apply']);

  const MAX_PLAN_SHIFT_HOURS = 4.5;
  const MAX_PLAN_DAILY_HOURS = 8.5;

  const readiness = useMemo(() => {
    if (!result) return null;
    const blocks = result.allBlocks;
    const criticalBlocks  = blocks.filter(b => CRITICAL_STATUSES.has(b.status));
    const warningBlocks   = blocks.filter(b => WARNING_STATUSES.has(b.status));
    const reassignments   = blocks.filter(b => b.status === 'proposed_reassignment');
    const shortBlocks     = blocks.filter(b => b.status === 'short_block' || b.isShortBlock);
    const midnightBlocks  = blocks.filter(b => b.status === 'cross_midnight' || b.crossesMidnight);
    const resolvedBlocks  = blocks.filter(b => RESOLVED_STATUSES.has(b.status));
    const excludedBlocks  = blocks.filter(b => b.status === 'excluded_from_apply');
    const overMax         = result.planDrivers.filter(pd => pd.driver.max_monthly_hours != null && pd.totalHours > pd.driver.max_monthly_hours);
    const underTarget     = result.planDrivers.filter(pd => pd.driver.target_monthly_hours != null && pd.totalHours < pd.driver.target_monthly_hours * 0.9);
    const coverageOverRegular = result.planDrivers.filter(pd => pd.isCoverageOverTargetWhileRegularsNeed);

    // Stundennachweis-Regeln: per-block max 4:30, per driver-day max 8:30
    const assignedBlocks = blocks.filter(b =>
      b.status === 'ok' ||
      b.status === 'proposed_reassignment' ||
      b.status === 'manually_assigned' ||
      b.status === 'manually_confirmed'
    );
    const tooLongBlocks = assignedBlocks.filter(b => b.durationHours > MAX_PLAN_SHIFT_HOURS + 1e-6);

    const dayTotals = new Map<string, number>();
    for (const b of assignedBlocks) {
      const key = `${b.driverIndex}|${b.date}`;
      dayTotals.set(key, (dayTotals.get(key) ?? 0) + b.durationHours);
    }
    const dayMaxViolations: Array<{ driverIndex: number; date: string; totalHours: number }> = [];
    for (const [key, total] of dayTotals) {
      if (total > MAX_PLAN_DAILY_HOURS + 1e-6) {
        const [diStr, date] = key.split('|');
        dayMaxViolations.push({ driverIndex: Number(diStr), date, totalHours: total });
      }
    }

    const stundennachweisValid =
      criticalBlocks.length === 0 &&
      tooLongBlocks.length === 0 &&
      dayMaxViolations.length === 0;

    // Dienstzeitfenster (driver shift window) violations
    type ShiftException = {
      key: string;
      driverIndex: number;
      driverName: string;
      date: string;
      startTime: string;
      endTime: string;
      windowStart: string | null;
      windowEnd: string | null;
      reason: 'outside_window' | 'wrong_weekday';
      minutesOutside: number;
      allowedByDriver: boolean;
    };
    const shiftExceptions: ShiftException[] = [];
    for (const b of assignedBlocks) {
      const pd = result.planDrivers[b.driverIndex];
      if (!pd) continue;
      const drv = pd.driver as any;
      const sm = timeToMinutes(b.startTime);
      const em = timeToMinutes(b.endTime);
      const chk = checkShiftWindow(drv, b.date, sm, em);
      if (chk.ok) continue;
      const mo = minutesOutsideWindow(chk.windowStartMin, chk.windowEndMin, sm, em);
      shiftExceptions.push({
        key: `${b.driverIndex}|${b.date}|${b.startTime}|${b.endTime}`,
        driverIndex: b.driverIndex,
        driverName: pd.driver.name,
        date: b.date,
        startTime: b.startTime,
        endTime: b.endTime,
        windowStart: chk.windowStartMin != null ? timeStringFromMinutes(chk.windowStartMin) : null,
        windowEnd: chk.windowEndMin != null ? timeStringFromMinutes(chk.windowEndMin) : null,
        reason: chk.reason === 'wrong_weekday' ? 'wrong_weekday' : 'outside_window',
        minutesOutside: mo,
        allowedByDriver: !!drv.allow_outside_shift_exceptions,
      });
    }
    const acceptedShiftExceptionList = shiftExceptions.filter(e => acceptedShiftExceptions.has(e.key));
    const unacceptedShiftExceptionList = shiftExceptions.filter(e => !acceptedShiftExceptions.has(e.key));
    const shiftWindowValid = unacceptedShiftExceptionList.length === 0;

    // Zielstunden/Wunschgehalt: only count drivers that actually have a target/rate configured
    const targetGaps = result.planDrivers
      .filter(pd => pd.driver.target_monthly_hours != null && pd.totalHours < (pd.driver.target_monthly_hours as number) * 0.9)
      .map(pd => ({
        driverId: pd.driver.id,
        driverName: pd.driver.name,
        targetHours: pd.driver.target_monthly_hours as number,
        plannedHours: pd.totalHours,
        gapHours: (pd.driver.target_monthly_hours as number) - pd.totalHours,
      }));

    const salaryGaps = result.planDrivers
      .filter(pd => pd.salaryStatus === 'under' && pd.salaryDiff != null)
      .map(pd => ({
        driverId: pd.driver.id,
        driverName: pd.driver.name,
        targetSalary: pd.driver.planning_target_salary ?? null,
        expectedGross: pd.expectedGross,
        salaryGap: Math.abs(pd.salaryDiff ?? 0),
      }));

    const targetOptimized = targetGaps.length === 0 && salaryGaps.length === 0;

    return {
      criticalCount: criticalBlocks.length,
      warningCount: warningBlocks.length + coverageOverRegular.length,
      reassignmentCount: reassignments.length,
      shortBlockCount: shortBlocks.length,
      midnightBlockCount: midnightBlocks.length,
      resolvedCount: resolvedBlocks.length,
      excludedCount: excludedBlocks.length,
      driversOverMax: overMax.length,
      driversUnderTarget: underTarget.length,
      coverageOverRegularCount: coverageOverRegular.length,
      isApplicable: criticalBlocks.length === 0,
      tooLongBlocks,
      dayMaxViolations,
      stundennachweisValid,
      shiftExceptions,
      acceptedShiftExceptionList,
      unacceptedShiftExceptionList,
      shiftWindowValid,
      targetGaps,
      salaryGaps,
      targetOptimized,
    };
  }, [result, acceptedShiftExceptions]);

  const fahrtenbuchNotClean = fahrtenbuchValidation != null && !fahrtenbuchValidation.isClean;

  const isFahrtenbuchAlreadyClean = !!(
    result && readiness &&
    readiness.criticalCount === 0 &&
    !fahrtenbuchNotClean &&
    applicableBlocks.length === 0 &&
    staleAssignedTripIds.size === 0 &&
    readiness.stundennachweisValid &&
    readiness.shiftWindowValid &&
    readiness.targetOptimized
  );

  const canApply = !!(
    result && readiness &&
    readiness.criticalCount === 0 &&
    readiness.stundennachweisValid &&
    readiness.shiftWindowValid &&
    !fahrtenbuchNotClean &&
    currentRunId &&
    !planApplied &&
    !applying &&
    applicableBlocks.length > 0 &&
    (isAdmin || isSuperAdmin)
  );

  const canGenerateStundennachweis = !!(
    result && readiness &&
    readiness.stundennachweisValid &&
    readiness.shiftWindowValid &&
    !fahrtenbuchNotClean &&
    staleAssignedTripIds.size === 0
  );

  const handleApplyPlan = async () => {
    if (!result || !companyId || !user || !currentRunId) return;
    if (!resolvedAssignmentMap || resolvedAssignmentMap.size === 0) {
      setApplyError('Keine aufgeloeste Fahrtenbuch-Zuweisung vorhanden. Bitte den Planer erneut ausfuehren.');
      return;
    }
    setShowApplyModal(false);
    setApplying(true);
    setApplyError(null);

    // Build per-original-trip assignments from the resolved assignment map.
    // Normalized trips may split a single DB trip (cross-midnight), so group by originalTripId.
    const perOriginalTrip = new Map<string, { driverId: string; driverName: string; reason: string }>();
    for (const [, a] of resolvedAssignmentMap) {
      if (a.assignmentStatus !== 'resolved' || !a.resolvedDriverId || !a.resolvedDriverName) continue;
      const origId = a.originalTripId;
      if (!perOriginalTrip.has(origId)) {
        perOriginalTrip.set(origId, {
          driverId: a.resolvedDriverId,
          driverName: a.resolvedDriverName,
          reason: a.assignmentReason || 'Car-Block Resolver',
        });
      }
    }

    const allTripIds: Array<{ tripId: string; driverId: string; driverName: string; reason: string; note: string }> = [];

    for (const [origTripId, assignment] of perOriginalTrip) {
      const note = [
        `Planungslauf: ${currentRunId.slice(0, 8)}`,
        `Neu: ${assignment.driverName}`,
        `Quelle: Car-Block Resolver`,
        `Angewendet von: ${user.email ?? user.id}`,
        `Zeitpunkt: ${new Date().toISOString()}`,
      ].join(' | ');

      allTripIds.push({
        tripId: origTripId,
        driverId: assignment.driverId,
        driverName: assignment.driverName,
        reason: assignment.reason,
        note,
      });
    }

    if (allTripIds.length === 0) {
      setApplyError('Keine Fahrten zum Anwenden gefunden.');
      setApplying(false);
      return;
    }

    setApplyProgress({ done: 0, total: allTripIds.length });

    let applied = 0;

    for (const item of allTripIds) {
      try {
        const { data, error } = await supabase.rpc('reassign_fahrtenbuch_trip', {
          p_trip_id: item.tripId,
          p_new_driver_id: item.driverId,
          p_new_driver_name: item.driverName,
          p_plausibility_status: 'planned_reassignment',
          p_reason: item.reason,
          p_note: item.note,
        });
        if (error) throw error;
        if (data && !(data as any).success) throw new Error(`RPC returned failure for trip ${item.tripId}`);
        applied++;
        setApplyProgress({ done: applied, total: allTripIds.length });
      } catch (e: any) {
        setApplyError(`Fehler bei Fahrt ${item.tripId.slice(0, 8)}: ${e.message}. ${applied} von ${allTripIds.length} Fahrten wurden bereits angewendet.`);
        setApplying(false);
        return;
      }

      if (applied % 20 === 0) await yieldToUI();
    }

    const skippedBlocks = result.allBlocks.filter(b => !APPLICABLE_STATUSES.has(b.status));
    const applySummary = {
      applied_blocks: applicableBlocks.length,
      applied_trips: applied,
      skipped_blocks: skippedBlocks.length,
      warnings_count: readiness?.warningCount ?? 0,
      resolved_count: readiness?.resolvedCount ?? 0,
      excluded_count: readiness?.excludedCount ?? 0,
    };

    const { error: updateErr } = await supabase
      .from('company_planning_runs')
      .update({
        status: 'applied',
        applied_at: new Date().toISOString(),
        applied_by: user.id,
        apply_summary_json: applySummary,
      })
      .eq('id', currentRunId)
      .eq('company_id', companyId);

    if (updateErr) {
      console.error('Failed to update planning run status:', updateErr);
    }

    setPlanApplied(true);
    setApplying(false);
    await loadSavedRuns();
  };

  const [exporting, setExporting] = useState(false);
  const [showStundennachweisModal, setShowStundennachweisModal] = useState(false);

  const handleApplyVehiclePlan = async () => {
    if (!vehiclePlanResult || !companyId || !user) return;
    if (vehiclePlanResult.unresolved.length > 0) {
      setVehiclePlanApplyError('Es gibt nicht zugewiesene Blöcke. Plan kann nicht angewendet werden.');
      return;
    }
    setVehiclePlanApplying(true);
    setVehiclePlanApplyError(null);
    let applied = 0;
    try {
      for (const block of vehiclePlanResult.resolved) {
        const note = [
          `Fahrzeug-Block-Planer: ${block.block_id}`,
          `Fahrzeug: ${block.vehicle_identifier}`,
          `Block: ${block.service_date} ${block.block_start_time}-${block.block_end_time}`,
          `Neu: ${block.resolved_driver_name}`,
          `Grund: ${block.assignment_reason}`,
          `Quelle: vehicle_block_planner`,
          `Angewendet von: ${user.email ?? user.id}`,
          `Zeitpunkt: ${new Date().toISOString()}`,
        ].join(' | ');

        for (const tripId of block.trip_ids) {
          const { error } = await supabase.rpc('reassign_fahrtenbuch_trip', {
            p_trip_id: tripId,
            p_new_driver_id: block.resolved_driver_id,
            p_new_driver_name: block.resolved_driver_name,
            p_plausibility_status: 'planned_reassignment',
            p_reason: block.assignment_reason,
            p_note: note,
          });
          if (error) throw error;
          applied++;
        }
      }
      setVehiclePlanApplied(true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setVehiclePlanApplyError(`Fehler nach ${applied} Fahrten: ${msg}`);
    } finally {
      setVehiclePlanApplying(false);
    }
  };

  const handleExportFahrtenbuch = async () => {
    if (!companyId) return;
    if (!canGenerateStundennachweis) return;
    const importId = selImportId || filteredImports[0]?.id;
    if (!importId) return;
    setExporting(true);
    try {
      const BATCH = 1000;
      const allTrips: FahrtenbuchTrip[] = [];
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from('fahrtenbuch_trips')
          .select('*')
          .eq('company_id', companyId)
          .eq('import_id', importId)
          .order('source_row_index', { ascending: true, nullsFirst: false })
          .range(offset, offset + BATCH - 1);
        if (error) throw error;
        const rows = (data ?? []) as FahrtenbuchTrip[];
        allTrips.push(...rows);
        if (rows.length < BATCH) break;
        offset += BATCH;
      }

      const imp = filteredImports.find(i => i.id === importId);
      exportFahrtenbuch({
        trips: allTrips,
        month: selMonth,
        year: selYear,
        importFileName: imp?.file_name,
        sourceColumns: imp?.source_columns_json,
        sourceSheetName: imp?.source_sheet_name,
      });
    } catch (e: any) {
      toast.error('Export fehlgeschlagen', e.message);
    } finally {
      setExporting(false);
    }
  };

  const applyPreset = (preset: 'standard' | 'strict' | 'flexible') => {
    const presets = {
      standard: { shift: '8', tol: '3', block: '60' },
      strict:   { shift: '8', tol: '1', block: '90' },
      flexible: { shift: '10', tol: '5', block: '30' },
    };
    const p = presets[preset];
    setMaxShiftHours(p.shift);
    setTargetToleranceHours(p.tol);
    setMinBlockMinStr(p.block);
  };

  const handleReset = () => {
    setResult(null);
    setPlannerError(null);
    setCurrentRunId(null);
    setDebugInfo({});
    setExpandedDrivers(new Set());
    setShowAllBlocks(false);
    setShowReview(false);
    setConflictBlockIndex(null);
    setPlanApplied(false);
    setApplyError(null);
    setShowApplyModal(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #1e40af 0%, #1d4ed8 100%)' }}>
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.2)' }}><Calendar size={28} /></div>
          <div>
            <h1 className="text-2xl font-bold">Planung aus Fahrtenbuch</h1>
            <p className="text-sm mt-0.5" style={{ color: 'rgba(255,255,255,0.8)' }}>Vorschau und Anwendung von Fahrerzuordnungen</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 mt-3 text-xs px-3 py-1.5 rounded-full w-fit"
          style={{ background: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.9)' }}>
          <Shield size={12} />
          <span>Fahrtenbuch-Daten werden erst nach Bestätigung von &quot;Plan anwenden&quot; geändert.</span>
        </div>
      </div>

      {/* Controls — Planungsparameter */}
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <div className="px-5 py-4 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border)' }}>
          <Settings2 size={16} style={{ color: 'var(--text-secondary)' }} />
          <h2 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>Planungsparameter</h2>
        </div>

        <div className="p-5 space-y-5">
          {/* Gruppe 1: Zeitraum & Fahrtenbuch */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-tertiary)' }}>Zeitraum & Fahrtenbuch</p>
            <div className="flex flex-wrap gap-3 items-end">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Monat</label>
                <select value={selMonth} onChange={e => { setSelMonth(Number(e.target.value)); setSelImportId(''); setResult(null); }} style={inputStyle}>
                  {MONTH_NAMES.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Jahr</label>
                <select value={selYear} onChange={e => { setSelYear(Number(e.target.value)); setSelImportId(''); setResult(null); }} style={inputStyle}>
                  {years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
              <div className="flex-1 min-w-52">
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Fahrtenbuch-Import</label>
                {loadingImports ? (
                  <div className="text-sm px-3 py-2 rounded-lg" style={{ background: 'var(--bg-muted)', color: 'var(--text-tertiary)' }}>Lädt …</div>
                ) : filteredImports.length === 0 ? (
                  <div className="text-sm px-3 py-2 rounded-lg" style={{ background: 'var(--bg-muted)', color: 'var(--text-tertiary)' }}>
                    Kein Import für {MONTH_NAMES[selMonth-1]} {selYear}
                  </div>
                ) : (
                  <select value={selImportId || filteredImports[0]?.id}
                    onChange={e => { setSelImportId(e.target.value); setResult(null); }}
                    style={{ ...inputStyle, width: '100%' }}>
                    {filteredImports.map(i => (
                      <option key={i.id} value={i.id}>{i.file_name} ({i.row_count} Fahrten)</option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          </div>

          {/* Gruppe 2: Planungsregeln */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Planungsregeln</p>
              <div className="flex gap-1.5">
                {([
                  { key: 'standard', label: 'Standard' },
                  { key: 'strict',   label: 'Streng' },
                  { key: 'flexible', label: 'Flexibel' },
                ] as const).map(p => (
                  <button key={p.key} onClick={() => applyPreset(p.key)}
                    className="px-2.5 py-1 rounded text-xs font-medium transition-colors"
                    style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent-subtle)'; e.currentTarget.style.color = 'var(--accent-text)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-subtle)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-lg p-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Max. Arbeitszeit / Tag</label>
                <div className="relative">
                  <input type="number" value={maxShiftHours} onChange={e => setMaxShiftHours(e.target.value)}
                    min="1" max="24" step="0.5"
                    style={{ ...inputStyle, width: '100%', padding: '0.5rem 2.5rem 0.5rem 0.75rem', background: 'var(--bg-surface)' }} />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs pointer-events-none"
                    style={{ color: 'var(--text-tertiary)' }}>Std.</span>
                </div>
                <p className="text-xs mt-1.5" style={{ color: 'var(--text-tertiary)' }}>Begrenzt Tagesarbeitszeit pro Fahrer.</p>
              </div>
              <div className="rounded-lg p-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Ziel-Toleranz</label>
                <div className="relative">
                  <input type="number" value={targetToleranceHours} onChange={e => setTargetToleranceHours(e.target.value)}
                    min="0" max="24" step="0.5"
                    style={{ ...inputStyle, width: '100%', padding: '0.5rem 2.5rem 0.5rem 0.75rem', background: 'var(--bg-surface)' }} />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs pointer-events-none"
                    style={{ color: 'var(--text-tertiary)' }}>Std.</span>
                </div>
                <p className="text-xs mt-1.5" style={{ color: 'var(--text-tertiary)' }}>Erlaubte Abweichung vom Monatsziel.</p>
              </div>
              <div className="rounded-lg p-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Min. Blockdauer</label>
                <div className="relative">
                  <input type="number" value={minBlockMinStr} onChange={e => setMinBlockMinStr(e.target.value)}
                    min="0" max="480" step="10"
                    style={{ ...inputStyle, width: '100%', padding: '0.5rem 2.5rem 0.5rem 0.75rem', background: 'var(--bg-surface)' }} />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs pointer-events-none"
                    style={{ color: 'var(--text-tertiary)' }}>Min.</span>
                </div>
                <p className="text-xs mt-1.5" style={{ color: 'var(--text-tertiary)' }}>Kurze Blöcke werden markiert.</p>
              </div>
              <div className="rounded-lg p-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Gehalts-Toleranz</label>
                <div className="relative">
                  <input type="number" value={salaryToleranceStr} onChange={e => setSalaryToleranceStr(e.target.value)}
                    min="0" max="10000" step="10"
                    style={{ ...inputStyle, width: '100%', padding: '0.5rem 2.5rem 0.5rem 0.75rem', background: 'var(--bg-surface)' }} />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs pointer-events-none"
                    style={{ color: 'var(--text-tertiary)' }}>€</span>
                </div>
                <p className="text-xs mt-1.5" style={{ color: 'var(--text-tertiary)' }}>Erlaubte Abweichung vom Wunschgehalt.</p>
              </div>
            </div>
          </div>

          {/* Gruppe 3: Fahrer-Auswahl */}
          {availableDrivers.length > 0 && (
            <div>
              <button
                onClick={() => setShowDriverSelection(v => !v)}
                className="flex items-center gap-2 w-full text-left mb-2"
              >
                <UserCheck size={14} style={{ color: 'var(--accent-text)' }} />
                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                  Fahrer-Auswahl
                </span>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                  style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}>
                  {selectedDriverIds.size} / {availableDrivers.length}
                </span>
                <ChevronDown size={14} style={{
                  color: 'var(--text-tertiary)', marginLeft: 'auto',
                  transform: showDriverSelection ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.2s',
                }} />
              </button>

              {showDriverSelection && (
                <div className="rounded-lg p-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                  <div className="flex flex-wrap gap-2 mb-3">
                    <button onClick={() => updateSelectedDrivers(new Set(availableDrivers.map(d => d.id)))}
                      className="px-2.5 py-1 rounded text-xs font-medium"
                      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                      Alle ausw&auml;hlen
                    </button>
                    <button onClick={() => updateSelectedDrivers(new Set())}
                      className="px-2.5 py-1 rounded text-xs font-medium"
                      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                      Alle abw&auml;hlen
                    </button>
                    <button onClick={() => {
                      const reg = new Set(availableDrivers.filter(d => d.driver_usage_type !== 'coverage_only').map(d => d.id));
                      updateSelectedDrivers(reg);
                    }}
                      className="px-2.5 py-1 rounded text-xs font-medium"
                      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                      Nur regul&auml;re Fahrer
                    </button>
                    <button onClick={() => {
                      const inFb = new Set<string>();
                      for (const d of availableDrivers) {
                        if (fahrtenbuchDriverIds.has(d.id)) inFb.add(d.id);
                      }
                      if (inFb.size > 0) updateSelectedDrivers(inFb);
                    }}
                      className="px-2.5 py-1 rounded text-xs font-medium"
                      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                      Nur Fahrer mit Fahrten
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 max-h-64 overflow-y-auto">
                    {availableDrivers.map(d => {
                      const checked = selectedDriverIds.has(d.id);
                      const inFahrtenbuch = fahrtenbuchDriverIds.has(d.id);
                      return (
                        <label key={d.id}
                          className="flex items-center gap-2 px-2.5 py-1.5 rounded-md cursor-pointer transition-colors"
                          style={{
                            background: checked ? 'var(--accent-subtle)' : 'var(--bg-surface)',
                            border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                          }}
                        >
                          <input type="checkbox" checked={checked}
                            onChange={() => {
                              updateSelectedDrivers(prev => {
                                const next = new Set(prev);
                                if (next.has(d.id)) next.delete(d.id); else next.add(d.id);
                                return next;
                              });
                            }}
                            className="rounded"
                            style={{ accentColor: 'var(--accent)' }}
                          />
                          <span className="text-xs font-medium truncate" style={{ color: checked ? 'var(--accent-text)' : 'var(--text-primary)' }}>
                            {d.name}
                          </span>
                          {inFahrtenbuch && (
                            <span className="text-xs px-1.5 py-0 rounded-full ml-auto flex-shrink-0"
                              style={{ background: 'var(--success-subtle)', color: 'var(--success)', fontSize: 10, fontWeight: 600 }}>
                              FB
                            </span>
                          )}
                          {d.driver_usage_type === 'coverage_only' && (
                            <span className="text-xs px-1.5 py-0 rounded-full flex-shrink-0"
                              style={{ background: 'var(--warning-subtle)', color: 'var(--warning)', fontSize: 10, fontWeight: 600 }}>
                              Deckung
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>

                  {selectedDriverIds.size === 0 && (
                    <p className="text-xs mt-2 font-medium" style={{ color: 'var(--danger)' }}>
                      Mindestens ein Fahrer muss ausgew&auml;hlt werden.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Gruppe 4: Aktionen */}
          <div className="flex flex-wrap items-center gap-2 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
            <button onClick={handleRun} disabled={running || loadingImports || filteredImports.length === 0 || selectedDriverIds.size === 0}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg font-semibold text-sm transition-all"
              style={{
                background: (loadingImports || filteredImports.length === 0 || selectedDriverIds.size === 0) ? 'var(--bg-muted)' : 'var(--accent)',
                color:      (loadingImports || filteredImports.length === 0 || selectedDriverIds.size === 0) ? 'var(--text-tertiary)' : 'var(--accent-text)',
                cursor:     (loadingImports || filteredImports.length === 0 || selectedDriverIds.size === 0) ? 'not-allowed' : 'pointer',
              }}>
              {running
                ? <><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /><span>Berechne …</span></>
                : <><Play size={16} /><span>Plan-Vorschlag erstellen</span></>}
            </button>
            {isPlanOutdated && !running && (
              <span className="text-xs font-medium px-2.5 py-1 rounded-full flex items-center gap-1.5"
                style={{ background: 'var(--warning-subtle)', color: 'var(--warning)', border: '1px solid var(--warning)' }}>
                <AlertTriangle size={12} />
                Fahrer-Auswahl ge&auml;ndert &mdash; bitte Plan-Vorschlag neu erstellen.
              </span>
            )}
            {result && (
              <>
                <button onClick={handleSaveDraft} disabled={saving || !!currentRunId}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors"
                  style={{
                    background: currentRunId ? 'var(--bg-muted)' : 'var(--success-subtle)',
                    color:      currentRunId ? 'var(--text-tertiary)' : 'var(--success)',
                    border:     `1px solid ${currentRunId ? 'var(--border)' : 'var(--success)'}`,
                    cursor:     currentRunId ? 'not-allowed' : 'pointer',
                  }}>
                  <Save size={14} />{saving ? 'Speichert …' : currentRunId ? 'Gespeichert' : 'Planentwurf speichern'}
                </button>
                {currentRunId && (
                  <button onClick={handleRun} disabled={running}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
                    style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)', background: 'var(--bg-subtle)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}>
                    <RefreshCw size={14} />Neu berechnen
                  </button>
                )}
                <button onClick={handleReset}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
                  style={{ border: '1px solid var(--border)', color: 'var(--text-tertiary)', background: 'var(--bg-subtle)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}>
                  <RotateCcw size={14} />Zurücksetzen
                </button>
              </>
            )}
            {currentRunId && (
              <span className="text-xs px-2.5 py-1 rounded-full ml-auto" style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}>
                Entwurf gespeichert
              </span>
            )}
          </div>
        </div>

        {/* Progress indicator */}
        {running && plannerStep && (
          <div className="flex items-center gap-2 text-sm px-5 py-3"
            style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)', borderTop: '1px solid var(--border)' }}>
            <Clock size={14} className="animate-pulse" />
            {plannerStep}
          </div>
        )}
      </div>

      {/* Error */}
      {plannerError && (
        <div className="rounded-xl p-4 flex items-start gap-3" style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)' }}>
          <AlertTriangle size={16} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 2 }} />
          <div>
            <p className="font-semibold text-sm mb-1" style={{ color: 'var(--danger)' }}>Plan konnte nicht erstellt werden</p>
            <p className="text-sm" style={{ color: 'var(--danger)' }}>{plannerError}</p>
          </div>
        </div>
      )}

      {/* Debug box */}
      {Object.keys(debugInfo).length > 0 && (
        <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <button onClick={() => setShowDebug(v => !v)}
            className="w-full flex items-center justify-between px-5 py-3 text-sm font-medium"
            style={{ color: 'var(--text-secondary)' }}>
            <span className="flex items-center gap-2"><Info size={14} />Debug / Status</span>
            {showDebug ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {showDebug && (
            <div className="px-5 pb-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
              {Object.entries(debugInfo).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 text-xs py-1" style={{ borderBottom: '1px solid var(--border)' }}>
                  <span style={{ color: 'var(--text-tertiary)' }}>{k}</span>
                  <span className="font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>{String(v)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Results */}
      {result && readiness && (
        <div className="space-y-6">
          {/* Stale-assignment banner: trips currently owned by drivers removed from the selected pool */}
          {staleAssignedTripIds.size > 0 && (
            <div className="rounded-xl p-4" style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)' }}>
              <div className="flex items-start gap-3">
                <AlertTriangle size={18} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold" style={{ color: 'var(--warning)' }}>
                    Nicht ausgew&auml;hlte Fahrer mit aktuellen Fahrten: {(() => {
                      const set = new Set<string>();
                      for (const d of staleAssignedTripDetails) if (d.effectiveDriverId) set.add(d.effectiveDriverId);
                      return set.size;
                    })()} &nbsp;&middot;&nbsp; {staleAssignedTripIds.size} Fahrt(en) betroffen
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'var(--warning)', opacity: 0.85 }}>
                    Das Fahrtenbuch ist deshalb nicht sauber. Bitte den Plan anwenden, damit die betroffenen Fahrten neu zugewiesen werden,
                    oder die entfernten Fahrer wieder in die Auswahl aufnehmen.
                  </p>
                  {staleAssignedTripDetails.length > 0 && (() => {
                    type Group = { name: string; sources: Set<EffectiveTripDriver['source']>; tripIds: string[] };
                    const groups = new Map<string, Group>();
                    for (const det of staleAssignedTripDetails) {
                      const key = det.effectiveDriverId ?? `name:${det.effectiveDriverName ?? 'unbekannt'}`;
                      let g = groups.get(key);
                      if (!g) {
                        g = { name: det.effectiveDriverName ?? 'Unbekannter Fahrer', sources: new Set(), tripIds: [] };
                        groups.set(key, g);
                      }
                      g.sources.add(det.source);
                      g.tripIds.push(det.tripId);
                    }
                    const sourceLabel: Record<EffectiveTripDriver['source'], string> = {
                      assigned: 'assigned',
                      original_id: 'original_id',
                      original_name: 'original_name',
                      none: 'none',
                    };
                    return (
                      <div className="mt-3 space-y-1.5">
                        {Array.from(groups.values()).map((g, idx) => (
                          <div key={idx} className="text-xs" style={{ color: 'var(--warning)' }}>
                            <span className="font-semibold">{g.name}</span>
                            <span style={{ opacity: 0.85 }}>
                              {' '}&middot; Quelle: {Array.from(g.sources).map(s => sourceLabel[s]).join(', ')}
                              {' '}&middot; {g.tripIds.length} Fahrt(en)
                              {' '}&middot; Beispiele: {g.tripIds.slice(0, 3).map(id => id.slice(0, 8)).join(', ')}
                              {g.tripIds.length > 3 ? ` … (+${g.tripIds.length - 3})` : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          )}

          {/* Readiness summary */}
          {(() => {
            const safetyOk = readiness.isApplicable && !fahrtenbuchNotClean;
            const stundennachweisOk = readiness.stundennachweisValid;
            const shiftWindowOk = readiness.shiftWindowValid;
            const targetOk = readiness.targetOptimized;
            const allOk = safetyOk && stundennachweisOk && shiftWindowOk && targetOk;
            const headerColor = !safetyOk
              ? 'var(--danger)'
              : !stundennachweisOk
                ? 'var(--danger)'
                : !targetOk
                  ? 'var(--warning)'
                  : 'var(--success)';
            const headerBg = !safetyOk || !stundennachweisOk
              ? 'var(--danger-subtle)'
              : !targetOk
                ? 'var(--warning-subtle, #fff7e6)'
                : 'var(--success-subtle)';
            const headlineText = !safetyOk
              ? 'Plan nicht sicher – Fahrtenbuch enthält Konflikte.'
              : !stundennachweisOk
                ? 'Plan verletzt Stundennachweis-Regeln.'
                : !targetOk
                  ? 'Plan ist sicher, aber noch nicht zieloptimiert.'
                  : 'Plan ist sicher, regelkonform und zieloptimiert.';
            const subText = !safetyOk
              ? 'Fahrer-Ueberlappungen, Fahrzeugwechsel-Verletzungen oder kritische Bloecke muessen behoben werden.'
              : !stundennachweisOk
                ? `${readiness.tooLongBlocks.length} Block(s) > 4:30 Std und ${readiness.dayMaxViolations.length} Tag(e) > 8:30 Std verhindern Stundennachweis.`
                : !targetOk
                  ? `${readiness.targetGaps.length} Fahrer unter Zielstunden, ${readiness.salaryGaps.length} unter Wunschgehalt — weitere Umverteilung kann sinnvoll sein.`
                  : 'Keine kritischen Fehler. Stundennachweis-Regeln eingehalten. Alle Fahrer auf Zielstunden/Wunschgehalt.';
            return (
          <div className="rounded-xl overflow-hidden" style={{
            background: headerBg,
            border: `1px solid ${headerColor}`,
          }}>
            <div className="p-5">
              <div className="flex items-start gap-3 mb-4">
                {allOk
                  ? <CheckCircle size={20} style={{ color: 'var(--success)', flexShrink: 0, marginTop: 1 }} />
                  : <AlertTriangle size={20} style={{ color: headerColor, flexShrink: 0, marginTop: 1 }} />}
                <div>
                  <h3 className="font-semibold text-sm" style={{ color: headerColor }}>
                    {headlineText}
                  </h3>
                  <p className="text-xs mt-0.5" style={{ color: headerColor, opacity: 0.85 }}>
                    {subText}
                  </p>
                </div>
              </div>

              {/* Tri-state planning status */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mb-4">
                {[
                  {
                    label: 'Fahrtenbuch-Sicherheit',
                    ok: safetyOk,
                    detail: safetyOk
                      ? 'Keine Überlappungen, keine Pufferverletzungen, keine ungelösten Blöcke.'
                      : `${readiness.criticalCount} kritische Blöcke / Fahrtenbuch-Konflikte.`,
                  },
                  {
                    label: 'Stundennachweis-Regeln',
                    ok: stundennachweisOk,
                    detail: stundennachweisOk
                      ? 'Alle Schichten ≤ 4:30 Std, alle Tage ≤ 8:30 Std.'
                      : `${readiness.tooLongBlocks.length} Schicht(en) > 4:30 Std · ${readiness.dayMaxViolations.length} Tag(e) > 8:30 Std`,
                  },
                  {
                    label: 'Dienstzeitfenster',
                    ok: shiftWindowOk,
                    detail: shiftWindowOk
                      ? readiness.shiftExceptions.length === 0
                        ? 'Alle Blöcke innerhalb der geplanten Arbeitszeitfenster.'
                        : `${readiness.acceptedShiftExceptionList.length} akzeptierte Ausnahme(n).`
                      : `${readiness.unacceptedShiftExceptionList.length} nicht akzeptierte Ausnahme(n) außerhalb Dienstzeit.`,
                  },
                  {
                    label: 'Zielstunden / Wunschgehalt',
                    ok: targetOk,
                    detail: targetOk
                      ? 'Alle Fahrer erreichen Zielstunden und Wunschgehalt.'
                      : `${readiness.targetGaps.length} unter Ziel · ${readiness.salaryGaps.length} unter Wunschgehalt`,
                  },
                ].map((s, i) => (
                  <div key={i} className="rounded-lg p-3 flex items-start gap-2" style={{
                    background: 'var(--bg-surface)',
                    border: `1px solid ${s.ok ? 'var(--success)' : 'var(--warning)'}`,
                  }}>
                    {s.ok
                      ? <CheckCircle size={14} style={{ color: 'var(--success)', flexShrink: 0, marginTop: 2 }} />
                      : <AlertTriangle size={14} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 2 }} />}
                    <div className="min-w-0">
                      <p className="text-xs font-semibold" style={{ color: s.ok ? 'var(--success)' : 'var(--warning)' }}>{s.label}</p>
                      <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{s.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
                {[
                  { label: 'Kritische Fehler',      value: readiness.criticalCount,      color: readiness.criticalCount > 0 ? 'var(--danger)' : 'var(--success)',        border: readiness.criticalCount > 0 ? 'var(--danger)' : 'var(--success)' },
                  { label: 'Gelöst',                value: readiness.resolvedCount,      color: readiness.resolvedCount > 0 ? '#3b82f6' : 'var(--text-tertiary)',         border: readiness.resolvedCount > 0 ? '#3b82f6' : 'var(--border)' },
                  { label: 'Warnungen',             value: readiness.warningCount,       color: readiness.warningCount > 0 ? 'var(--warning)' : 'var(--success)',         border: readiness.warningCount > 0 ? 'var(--warning)' : 'var(--success)' },
                  { label: 'Vorgeschl. Wechsel',    value: readiness.reassignmentCount,  color: readiness.reassignmentCount > 0 ? 'var(--warning)' : 'var(--success)',    border: readiness.reassignmentCount > 0 ? 'var(--warning)' : 'var(--success)' },
                  { label: 'Ausgeschlossen',        value: readiness.excludedCount,      color: readiness.excludedCount > 0 ? 'var(--text-secondary)' : 'var(--text-tertiary)', border: 'var(--border)' },
                  { label: 'Mitternacht',           value: readiness.midnightBlockCount, color: readiness.midnightBlockCount > 0 ? 'var(--accent-text)' : 'var(--success)', border: readiness.midnightBlockCount > 0 ? 'var(--accent-text)' : 'var(--success)' },
                  { label: 'Über Max-Std.',         value: readiness.driversOverMax,     color: readiness.driversOverMax > 0 ? 'var(--danger)' : 'var(--success)',        border: readiness.driversOverMax > 0 ? 'var(--danger)' : 'var(--success)' },
                  { label: 'Unter Ziel',            value: readiness.driversUnderTarget, color: readiness.driversUnderTarget > 0 ? 'var(--warning)' : 'var(--success)',   border: readiness.driversUnderTarget > 0 ? 'var(--warning)' : 'var(--success)' },
                ].map((c, i) => (
                  <div key={i} className="rounded-lg px-3 py-2.5 text-center" style={{
                    background: 'var(--bg-surface)',
                    border: `1px solid color-mix(in srgb, ${c.border} 35%, transparent)`,
                    boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
                  }}>
                    <p className="text-xl font-bold tracking-tight" style={{ color: c.color }}>{c.value}</p>
                    <p className="text-[11px] font-medium mt-0.5" style={{ color: 'var(--text-secondary)' }}>{c.label}</p>
                  </div>
                ))}
              </div>

              {/* Fahrtenbuch Assignment Check */}
              {fahrtenbuchValidation && (
                <div style={{ borderTop: '1px solid var(--border)' }}>
                  <button
                    onClick={() => setShowFahrtenbuchCheck(!showFahrtenbuchCheck)}
                    className="w-full flex items-center gap-3 px-5 py-3 text-left hover:opacity-90 transition-opacity"
                    style={{ background: fahrtenbuchValidation.isClean ? 'var(--success-subtle)' : 'var(--danger-subtle)' }}
                  >
                    <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{
                      background: fahrtenbuchValidation.isClean ? 'var(--success-subtle)' : 'var(--danger-subtle)',
                      color: fahrtenbuchValidation.isClean ? 'var(--success)' : 'var(--danger)',
                      border: `1px solid ${fahrtenbuchValidation.isClean ? 'var(--success)' : 'var(--danger)'}`,
                    }}>
                      {fahrtenbuchValidation.isClean ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        Fahrtenbuch-Zuweisungspruefung
                      </div>
                      <div className="text-xs" style={{ color: fahrtenbuchValidation.isClean ? 'var(--success)' : 'var(--danger)' }}>
                        {fahrtenbuchValidation.isClean
                          ? 'Alle Pruefungen bestanden'
                          : 'Probleme gefunden – Plan kann nicht angewendet werden'}
                      </div>
                    </div>
                    {showFahrtenbuchCheck
                      ? <ChevronUp size={14} style={{ color: 'var(--text-tertiary)' }} />
                      : <ChevronDown size={14} style={{ color: 'var(--text-tertiary)' }} />
                    }
                  </button>

                  {/* Summary stats */}
                  <div className="px-5 py-2.5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-6 gap-y-1.5" style={{
                    borderTop: '1px solid var(--border)', background: 'var(--bg-surface)',
                  }}>
                    {[
                      { label: 'Zugewiesene Fahrten', value: fahrtenbuchValidation.resolvedTrips, color: 'var(--success)' },
                      { label: 'Nicht zugewiesene Fahrten', value: fahrtenbuchValidation.unresolvedTrips, color: fahrtenbuchValidation.unresolvedTrips > 0 ? 'var(--danger)' : 'var(--text-tertiary)' },
                      { label: 'Fahrer-Ueberlappungen', value: fahrtenbuchValidation.driverOverlaps.length, color: fahrtenbuchValidation.driverOverlaps.length > 0 ? 'var(--danger)' : 'var(--success)' },
                      { label: 'Fahrzeugwechsel-Verletzungen', value: fahrtenbuchValidation.vehicleSwitchViolations.length, color: fahrtenbuchValidation.vehicleSwitchViolations.length > 0 ? 'var(--danger)' : 'var(--success)' },
                      { label: 'Fahrzeug-Ueberlappungen', value: fahrtenbuchValidation.vehicleOverlaps.length, color: fahrtenbuchValidation.vehicleOverlaps.length > 0 ? 'var(--danger)' : 'var(--success)' },
                      { label: 'Same-vehicle Konflikte', value: fahrtenbuchValidation.sameVehicleConflicts.length, color: fahrtenbuchValidation.sameVehicleConflicts.length > 0 ? 'var(--warning, #e6a817)' : 'var(--text-tertiary)' },
                      { label: 'Puffer', value: `${MIN_VEHICLE_SWITCH_BUFFER_MINUTES} Min.`, color: 'var(--text-tertiary)' },
                    ].map((s, i) => (
                      <div key={i} className="flex items-center justify-between gap-2 text-xs">
                        <span style={{ color: 'var(--text-tertiary)' }}>{s.label}:</span>
                        <span className="font-bold" style={{ color: s.color }}>{s.value}</span>
                      </div>
                    ))}
                  </div>

                  {/* Detailed violations */}
                  {showFahrtenbuchCheck && (
                    <div className="px-5 py-3 space-y-3" style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-muted)' }}>
                      {/* Driver overlaps */}
                      {fahrtenbuchValidation.driverOverlaps.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>
                            Fahrer-Ueberlappungen ({fahrtenbuchValidation.driverOverlaps.length}):
                          </p>
                          {fahrtenbuchValidation.driverOverlaps.slice(0, 15).map((v, i) => (
                            <div key={i} className="p-2 rounded-lg text-xs" style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)' }}>
                              <div className="flex items-start gap-2" style={{ color: 'var(--danger)' }}>
                                <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
                                <div>
                                  <span className="font-medium">Fahrer-Ueberlappung{v.driverName && ` (${v.driverName})`}</span>
                                  <div className="mt-0.5" style={{ color: 'var(--text-secondary)' }}>{v.details}</div>
                                </div>
                              </div>
                            </div>
                          ))}
                          {fahrtenbuchValidation.driverOverlaps.length > 15 && (
                            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>... und {fahrtenbuchValidation.driverOverlaps.length - 15} weitere</div>
                          )}
                        </div>
                      )}

                      {/* Vehicle-switch violations */}
                      {fahrtenbuchValidation.vehicleSwitchViolations.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>
                            Fahrzeugwechsel-Puffer Verletzungen ({fahrtenbuchValidation.vehicleSwitchViolations.length}):
                          </p>
                          {fahrtenbuchValidation.vehicleSwitchViolations.slice(0, 15).map((v, i) => (
                            <div key={i} className="p-2 rounded-lg text-xs" style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)' }}>
                              <div className="flex items-start gap-2" style={{ color: 'var(--danger)' }}>
                                <CarIcon size={10} className="mt-0.5 flex-shrink-0" />
                                <div>
                                  <span className="font-medium">Fahrzeugwechsel-Puffer{v.driverName && ` (${v.driverName})`}</span>
                                  <div className="mt-0.5" style={{ color: 'var(--text-secondary)' }}>{v.details}</div>
                                </div>
                              </div>
                            </div>
                          ))}
                          {fahrtenbuchValidation.vehicleSwitchViolations.length > 15 && (
                            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>... und {fahrtenbuchValidation.vehicleSwitchViolations.length - 15} weitere</div>
                          )}
                        </div>
                      )}

                      {/* Vehicle overlaps */}
                      {fahrtenbuchValidation.vehicleOverlaps.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>
                            Fahrzeug-Ueberlappungen ({fahrtenbuchValidation.vehicleOverlaps.length}):
                          </p>
                          {fahrtenbuchValidation.vehicleOverlaps.slice(0, 15).map((v, i) => (
                            <div key={i} className="p-2 rounded-lg text-xs" style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)' }}>
                              <div className="flex items-start gap-2" style={{ color: 'var(--danger)' }}>
                                <CarIcon size={10} className="mt-0.5 flex-shrink-0" />
                                <div>
                                  <span className="font-medium">Fahrzeug-Ueberlappung{v.vehicleKennzeichen && ` (${v.vehicleKennzeichen})`}</span>
                                  <div className="mt-0.5" style={{ color: 'var(--text-secondary)' }}>{v.details}</div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Same-vehicle conflicts (non-blocking) */}
                      {fahrtenbuchValidation.sameVehicleConflicts.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-xs font-semibold" style={{ color: '#e6a817' }}>
                            Same-vehicle Konflikte ({fahrtenbuchValidation.sameVehicleConflicts.length}):
                          </p>
                          <p className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                            Rohdaten-Konflikte im Fahrtenbuch — blockieren die Planung nicht.
                          </p>
                          {fahrtenbuchValidation.sameVehicleConflicts.slice(0, 15).map((v, i) => (
                            <div key={i} className="p-2 rounded-lg text-xs" style={{ background: 'rgba(230,168,23,0.08)', border: '1px solid rgba(230,168,23,0.3)' }}>
                              <div className="flex items-start gap-2" style={{ color: '#e6a817' }}>
                                <Info size={10} className="mt-0.5 flex-shrink-0" />
                                <div>
                                  <span className="font-medium">Same-vehicle Konflikt{v.vehicleKennzeichen && ` (${v.vehicleKennzeichen})`}{v.driverName && ` — ${v.driverName}`}</span>
                                  <div className="mt-0.5" style={{ color: 'var(--text-secondary)' }}>{v.details}</div>
                                </div>
                              </div>
                            </div>
                          ))}
                          {fahrtenbuchValidation.sameVehicleConflicts.length > 15 && (
                            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>... und {fahrtenbuchValidation.sameVehicleConflicts.length - 15} weitere</div>
                          )}
                        </div>
                      )}

                      {/* Unresolved blocks */}
                      {carResolverResult && carResolverResult.unresolved.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>
                            Nicht zuweisbare Bloecke ({carResolverResult.unresolved.length}):
                          </p>
                          <div className="flex items-center gap-2 p-2 rounded-lg text-xs" style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)' }}>
                            <AlertTriangle size={12} style={{ color: 'var(--warning)', flexShrink: 0 }} />
                            <span style={{ color: 'var(--warning)' }}>
                              Nicht gen&uuml;gend ausgew&auml;hlte Fahrer f&uuml;r saubere Planung. Bitte weitere Fahrer in der Fahrer-Auswahl aktivieren.
                            </span>
                          </div>
                          {carResolverResult.unresolved.slice(0, 10).map((ub, i) => (
                            <div key={i} className="p-2 rounded-lg text-xs space-y-1" style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)' }}>
                              <div className="flex items-center gap-2 font-medium" style={{ color: 'var(--danger)' }}>
                                <CarIcon size={10} />
                                <span>{ub.kennzeichen} | {ub.date} | {minutesToTime(ub.startMin)}-{minutesToTime(ub.endMin)}</span>
                              </div>
                              <div style={{ color: 'var(--text-secondary)' }}>{ub.reason}</div>
                              {ub.triedDrivers.length > 0 && (
                                <div className="pl-3 space-y-0.5" style={{ color: 'var(--text-tertiary)' }}>
                                  {ub.triedDrivers.slice(0, 5).map((td, j) => (
                                    <div key={j}>{td.driverName}: {td.rejectReason}</div>
                                  ))}
                                  {ub.triedDrivers.length > 5 && <div>... und {ub.triedDrivers.length - 5} weitere</div>}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Resolved blocks */}
                      {carResolverResult && carResolverResult.resolved.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-xs font-semibold" style={{ color: 'var(--success)' }}>
                            Zugewiesene Bloecke ({carResolverResult.resolved.length}):
                          </p>
                          <div className="max-h-40 overflow-y-auto space-y-0.5">
                            {carResolverResult.resolved.map((rb, i) => (
                              <div key={i} className="flex items-center gap-2 text-xs py-1 px-2 rounded" style={{ background: 'var(--bg-surface)' }}>
                                <span className="font-mono font-medium" style={{ color: 'var(--accent-text)', minWidth: '80px' }}>{rb.kennzeichen}</span>
                                <span style={{ color: 'var(--text-tertiary)', minWidth: '80px' }}>{rb.date}</span>
                                <span style={{ color: 'var(--text-secondary)', minWidth: '90px' }}>{minutesToTime(rb.startMin)}-{minutesToTime(rb.endMin)}</span>
                                <span className="flex-1 truncate" style={{ color: 'var(--success)' }}>{rb.assignedDriverName}</span>
                                <span className="text-[10px] truncate" style={{ color: 'var(--text-tertiary)', maxWidth: '160px' }}>{rb.reason}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Clean state */}
                      {fahrtenbuchValidation.isClean && (
                        <div className="flex items-center gap-2 p-3 rounded-lg" style={{ background: 'var(--success-subtle)' }}>
                          <CheckCircle size={14} style={{ color: 'var(--success)' }} />
                          <span className="text-xs font-medium" style={{ color: 'var(--success)' }}>
                            Fahrtenbuch-Zuweisung ist sauber. Keine Cross-car Ueberlappungen, keine Pufferverletzungen, keine ungeloesten Bloecke.
                            {fahrtenbuchValidation.sameVehicleConflicts.length > 0
                              ? ` (${fahrtenbuchValidation.sameVehicleConflicts.length} Same-vehicle Konflikte — Rohdaten, nicht planungsrelevant)`
                              : ''}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

            </div>
            <div className="px-5 py-3 flex items-center gap-2" style={{
              borderTop: `1px solid ${readiness.isApplicable && !fahrtenbuchNotClean ? 'var(--success)' : 'var(--danger)'}`,
              background: 'var(--bg-surface)',
            }}>
              {planApplied ? (
                <div className="flex items-center gap-2 text-xs font-medium flex-wrap">
                  <CheckCircle size={14} style={{ color: 'var(--success)' }} />
                  <span style={{ color: 'var(--success)' }}>
                    {applicableBlocks.length > 0
                      ? `Plan wurde bereits angewendet. ${applicableBlocks.length} Bloecke mit ${applicableTripCount} Fahrten verarbeitet.`
                      : 'Fahrtenbuch ist bereits sauber. Keine Aenderungen erforderlich.'}
                  </span>
                  <div className="flex items-center gap-2 ml-auto">
                    <button
                      onClick={() => canGenerateStundennachweis && setShowStundennachweisModal(true)}
                      disabled={!canGenerateStundennachweis}
                      title={!canGenerateStundennachweis ? 'Stundennachweis blockiert — Plan verletzt Sicherheits-, Stundennachweis- oder Dienstzeit-Regeln.' : undefined}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{ background: 'var(--accent)', color: 'white' }}>
                      <Clock size={12} />Stundennachweise erstellen
                    </button>
                    <button onClick={handleExportFahrtenbuch} disabled={exporting || !canGenerateStundennachweis}
                      title={!canGenerateStundennachweis ? 'Fahrtenbuch-Export blockiert — Plan verletzt Sicherheits-, Stundennachweis- oder Dienstzeit-Regeln.' : undefined}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{ background: 'var(--success)', color: 'white' }}>
                      <Download size={12} />{exporting ? 'Exportiert...' : 'Fahrtenbuch herunterladen'}
                    </button>
                  </div>
                </div>
              ) : applying ? (
                <div className="flex items-center gap-2 text-xs font-medium w-full" style={{ color: 'var(--accent-text)' }}>
                  <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-current" />
                  <span>Fahrten werden aktualisiert... {applyProgress.done} / {applyProgress.total}</span>
                  <div className="flex-1 h-1.5 rounded-full overflow-hidden ml-2" style={{ background: 'var(--bg-muted)' }}>
                    <div className="h-full rounded-full transition-all" style={{
                      width: `${applyProgress.total > 0 ? (applyProgress.done / applyProgress.total) * 100 : 0}%`,
                      background: 'var(--accent)',
                    }} />
                  </div>
                </div>
              ) : !currentRunId ? (
                <div className="flex items-center gap-2 text-xs font-medium" style={{ color: 'var(--text-tertiary)' }}>
                  <Save size={14} />
                  Bitte speichern Sie den Planentwurf vor der Anwendung.
                </div>
              ) : isFahrtenbuchAlreadyClean && !planApplied && currentRunId && (isAdmin || isSuperAdmin) ? (
                <div className="flex items-center gap-2 text-xs font-medium flex-wrap">
                  <CheckCircle size={14} style={{ color: 'var(--success)' }} />
                  <span style={{ color: 'var(--success)' }}>
                    Plan ist sicher, regelkonform und zieloptimiert. Keine Aenderungen erforderlich.
                  </span>
                  <button onClick={() => setPlanApplied(true)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ml-auto"
                    style={{ background: 'var(--accent)', color: 'white' }}>
                    <ArrowRight size={12} />Weiter zu Stundennachweis
                  </button>
                </div>
              ) : !canApply ? (
                <div className="flex items-center gap-2 text-xs font-medium" style={{ color: 'var(--text-tertiary)', opacity: 0.7 }}>
                  <Lock size={14} />
                  Plan anwenden — {fahrtenbuchNotClean
                    ? 'Fahrtenbuch nicht sauber – Plan kann nicht angewendet werden.'
                    : readiness.criticalCount > 0
                    ? 'Kritische Fehler muessen zuerst behoben werden.'
                    : !readiness.stundennachweisValid
                    ? 'Stundennachweis-Regeln verletzt (Schicht > 4:30 Std oder Tag > 8:30 Std).'
                    : !readiness.shiftWindowValid
                    ? `${readiness.unacceptedShiftExceptionList.length} Block/Bloecke außerhalb Dienstzeit ohne Akzeptanz.`
                    : !(isAdmin || isSuperAdmin)
                      ? 'Nur Admins koennen den Plan anwenden.'
                      : 'Keine anwendbaren Bloecke vorhanden.'}
                </div>
              ) : (
                <button onClick={() => setShowApplyModal(true)}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors"
                  style={{ background: 'var(--success)', color: 'white' }}>
                  <Play size={13} />
                  Plan anwenden ({applicableBlocks.length} Bloecke, {applicableTripCount} Fahrten)
                </button>
              )}
            </div>
            {applyError && (
              <div className="px-5 py-3 flex items-start gap-2 text-xs" style={{ borderTop: '1px solid var(--danger)', background: 'var(--danger-subtle)', color: 'var(--danger)' }}>
                <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                {applyError}
              </div>
            )}
          </div>
            );
          })()}

          {/* Stundennachweis-Regel Verletzungen */}
          {readiness && !readiness.stundennachweisValid && (
            <div className="rounded-xl p-4" style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)' }}>
              <div className="flex items-start gap-2 mb-2">
                <AlertTriangle size={16} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 1 }} />
                <div>
                  <p className="text-sm font-semibold" style={{ color: 'var(--danger)' }}>
                    Stundennachweis kann nicht erstellt werden
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--danger)', opacity: 0.85 }}>
                    {readiness.tooLongBlocks.length} Schicht(en) &uuml;berschreiten 4:30 Std und {readiness.dayMaxViolations.length} Tag(e) &uuml;berschreiten 8:30 Std.
                    Diese Verletzungen muessen im Planentwurf behoben werden.
                  </p>
                </div>
              </div>
              {readiness.tooLongBlocks.length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>Schichten &gt; 4:30 Std:</p>
                  {readiness.tooLongBlocks.slice(0, 6).map((b, i) => {
                    const drv = result.planDrivers[b.driverIndex];
                    return (
                      <div key={i} className="text-xs px-2 py-1 rounded" style={{ background: 'var(--bg-surface)', color: 'var(--text-secondary)' }}>
                        {drv?.driver.name ?? `Fahrer #${b.driverIndex}`} &middot; {b.date} &middot; {b.startTime}-{b.endTime} &middot; {b.durationHours.toFixed(2)} Std
                      </div>
                    );
                  })}
                  {readiness.tooLongBlocks.length > 6 && (
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>... und {readiness.tooLongBlocks.length - 6} weitere</p>
                  )}
                </div>
              )}
              {readiness.dayMaxViolations.length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>Tage &gt; 8:30 Std:</p>
                  {readiness.dayMaxViolations.slice(0, 6).map((v, i) => {
                    const drv = result.planDrivers[v.driverIndex];
                    return (
                      <div key={i} className="text-xs px-2 py-1 rounded" style={{ background: 'var(--bg-surface)', color: 'var(--text-secondary)' }}>
                        {drv?.driver.name ?? `Fahrer #${v.driverIndex}`} &middot; {v.date} &middot; {v.totalHours.toFixed(2)} Std
                      </div>
                    );
                  })}
                  {readiness.dayMaxViolations.length > 6 && (
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>... und {readiness.dayMaxViolations.length - 6} weitere</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Fahrzeug-Block-Planer (vehicle-block-first pipeline) ───────── */}
          {vehiclePlanResult && (() => {
            const v = vehiclePlanResult.validation;
            const allOk =
              v.unresolved_blocks === 0 &&
              v.driver_overlaps === 0 &&
              v.vehicle_switch_violations === 0 &&
              v.working_time_window_violations === 0 &&
              v.daily_max_violations === 0 &&
              v.monthly_max_violations === 0;
            return (
            <div className="rounded-xl overflow-hidden" style={{
              background: 'var(--bg-surface)',
              border: `1px solid ${allOk ? 'var(--success)' : 'var(--warning)'}`,
            }}>
              <div className="px-5 py-4 flex items-start justify-between gap-3" style={{
                background: allOk ? 'var(--success-subtle)' : 'var(--warning-subtle, #fff7e6)',
              }}>
                <div className="flex items-start gap-2">
                  {allOk
                    ? <CheckCircle size={18} style={{ color: 'var(--success)', flexShrink: 0, marginTop: 1 }} />
                    : <AlertTriangle size={18} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />}
                  <div>
                    <p className="text-sm font-semibold" style={{ color: allOk ? 'var(--success)' : 'var(--warning)' }}>
                      Fahrzeug-Block-Planer
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                      Vehikel-Timeline → Blöcke (Gap &gt; {VEHICLE_BLOCK_GAP_MINUTES} Min.) → Fahrerzuweisung mit harten Regeln.
                    </p>
                  </div>
                </div>
                {vehiclePlanResult.resolved.length > 0 && (
                  vehiclePlanApplied ? (
                    <div className="px-3 py-1.5 rounded-lg text-xs font-semibold" style={{
                      background: 'var(--success-subtle)', color: 'var(--success)', border: '1px solid var(--success)',
                    }}>Angewendet</div>
                  ) : (
                    <button
                      onClick={handleApplyVehiclePlan}
                      disabled={vehiclePlanApplying || vehiclePlanResult.unresolved.length > 0 || !(isAdmin || isSuperAdmin)}
                      title={vehiclePlanResult.unresolved.length > 0
                        ? 'Es gibt nicht zugewiesene Blöcke.'
                        : !(isAdmin || isSuperAdmin)
                          ? 'Nur Admins koennen den Plan anwenden.'
                          : undefined}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5"
                      style={{
                        background: vehiclePlanResult.unresolved.length > 0 ? 'var(--bg-muted)' : 'var(--success)',
                        color: vehiclePlanResult.unresolved.length > 0 ? 'var(--text-tertiary)' : 'white',
                        opacity: vehiclePlanApplying ? 0.6 : 1,
                      }}
                    >
                      <Play size={12} />
                      {vehiclePlanApplying ? 'Wird angewendet …' : `Plan anwenden (${vehiclePlanResult.resolved.length} Bl.)`}
                    </button>
                  )
                )}
              </div>

              <div className="px-5 py-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-6 gap-y-1.5 text-xs" style={{
                borderTop: '1px solid var(--border)',
              }}>
                {[
                  { label: 'Erzeugte Blöcke',            value: v.vehicle_blocks_built,            color: 'var(--text-primary)' },
                  { label: 'Zugewiesen',                 value: v.assigned_blocks,                 color: v.assigned_blocks > 0 ? 'var(--success)' : 'var(--text-tertiary)' },
                  { label: 'Nicht zugewiesen',           value: v.unresolved_blocks,               color: v.unresolved_blocks > 0 ? 'var(--danger)' : 'var(--success)' },
                  { label: 'Resolved Fahrten',           value: v.resolved_trips,                  color: 'var(--text-primary)' },
                  { label: 'Fahrer-Überlappungen',       value: v.driver_overlaps,                 color: v.driver_overlaps > 0 ? 'var(--danger)' : 'var(--success)' },
                  { label: 'Fahrzeugwechsel-Verletzg.',  value: v.vehicle_switch_violations,       color: v.vehicle_switch_violations > 0 ? 'var(--danger)' : 'var(--success)' },
                  { label: 'Dienstzeit-Verletzg.',       value: v.working_time_window_violations,  color: v.working_time_window_violations > 0 ? 'var(--danger)' : 'var(--success)' },
                  { label: 'Tageslimit-Verletzg.',       value: v.daily_max_violations,            color: v.daily_max_violations > 0 ? 'var(--danger)' : 'var(--success)' },
                  { label: 'Monatslimit-Verletzg.',      value: v.monthly_max_violations,          color: v.monthly_max_violations > 0 ? 'var(--danger)' : 'var(--success)' },
                  { label: 'Notiz-Warnungen',            value: v.note_warnings,                   color: v.note_warnings > 0 ? 'var(--warning)' : 'var(--text-tertiary)' },
                ].map((s, i) => (
                  <div key={i} className="flex items-center justify-between gap-2">
                    <span style={{ color: 'var(--text-tertiary)' }}>{s.label}:</span>
                    <span className="font-bold" style={{ color: s.color }}>{s.value}</span>
                  </div>
                ))}
              </div>

              {vehiclePlanApplyError && (
                <div className="px-5 py-2 text-xs" style={{
                  borderTop: '1px solid var(--danger)', background: 'var(--danger-subtle)', color: 'var(--danger)',
                }}>{vehiclePlanApplyError}</div>
              )}

              <button
                onClick={() => setShowVehicleBlockDetails(s => !s)}
                className="w-full px-5 py-2 text-xs font-semibold flex items-center justify-between"
                style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
              >
                <span>{showVehicleBlockDetails ? 'Block-Details ausblenden' : 'Block-Details anzeigen'}</span>
                {showVehicleBlockDetails ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>

              {showVehicleBlockDetails && (
                <div className="px-5 py-3 space-y-3" style={{ borderTop: '1px solid var(--border)' }}>
                  {vehiclePlanResult.unresolved.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold mb-2" style={{ color: 'var(--danger)' }}>
                        Nicht zugewiesene Blöcke ({vehiclePlanResult.unresolved.length})
                      </p>
                      <div className="space-y-2">
                        {vehiclePlanResult.unresolved.slice(0, 25).map(ub => (
                          <div key={ub.block_id} className="p-2 rounded-lg text-xs" style={{
                            background: 'var(--danger-subtle)', border: '1px solid var(--danger)',
                          }}>
                            <div className="font-semibold" style={{ color: 'var(--danger)' }}>
                              {ub.vehicle_identifier} · {ub.service_date} · {ub.block_start_time}–{ub.block_end_time} · {(ub.duration_minutes / 60).toFixed(2)}h · {ub.trip_count} Fahrten
                            </div>
                            {ub.rejected.length > 0 ? (
                              <ul className="mt-1 space-y-0.5" style={{ color: 'var(--text-secondary)' }}>
                                {ub.rejected.map((r, ri) => (
                                  <li key={ri}>· {r.driver_name}: {r.detail}</li>
                                ))}
                              </ul>
                            ) : (
                              <p className="mt-1" style={{ color: 'var(--text-secondary)' }}>Keine ausgewählten Fahrer für diesen Block verfügbar.</p>
                            )}
                          </div>
                        ))}
                        {vehiclePlanResult.unresolved.length > 25 && (
                          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            … und {vehiclePlanResult.unresolved.length - 25} weitere
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {vehiclePlanResult.note_warnings.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold mb-2" style={{ color: 'var(--warning)' }}>
                        Notiz-Warnungen ({vehiclePlanResult.note_warnings.length})
                      </p>
                      <div className="space-y-1">
                        {vehiclePlanResult.note_warnings.map((w, i) => (
                          <div key={i} className="p-2 rounded-lg text-xs" style={{
                            background: 'var(--warning-subtle, #fff7e6)', border: '1px solid var(--warning)', color: 'var(--text-secondary)',
                          }}>
                            <span className="font-semibold" style={{ color: 'var(--warning)' }}>{w.driver_name}: </span>
                            {w.reason} <span style={{ color: 'var(--text-tertiary)' }}>({w.note})</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <p className="text-xs font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                      Blockzuweisung ({vehiclePlanResult.blocks.length})
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr style={{ color: 'var(--text-tertiary)' }}>
                            <th className="text-left py-1 pr-2">Datum</th>
                            <th className="text-left py-1 pr-2">Fahrzeug</th>
                            <th className="text-right py-1 px-2">Start</th>
                            <th className="text-right py-1 px-2">Ende</th>
                            <th className="text-right py-1 px-2">Dauer</th>
                            <th className="text-right py-1 px-2">Fahrten</th>
                            <th className="text-left py-1 px-2">Fahrer</th>
                            <th className="text-left py-1 px-2">Status</th>
                            <th className="text-left py-1 pl-2">Grund</th>
                          </tr>
                        </thead>
                        <tbody>
                          {vehiclePlanResult.blocks.slice(0, 200).map(b => {
                            const r = vehiclePlanResult.resolved.find(x => x.block_id === b.block_id);
                            const u = vehiclePlanResult.unresolved.find(x => x.block_id === b.block_id);
                            const status = r ? 'Zugewiesen' : 'Nicht zugewiesen';
                            const color = r ? 'var(--success)' : 'var(--danger)';
                            const reason = r ? r.assignment_reason : (u && u.rejected.length > 0 ? u.rejected.map(x => `${x.driver_name}: ${x.detail}`).join(' · ') : 'kein gültiger Fahrer');
                            return (
                              <tr key={b.block_id} style={{ borderTop: '1px solid var(--border)' }}>
                                <td className="py-1.5 pr-2" style={{ color: 'var(--text-primary)' }}>{b.service_date}</td>
                                <td className="py-1.5 pr-2" style={{ color: 'var(--text-primary)' }}>{b.vehicle_identifier}</td>
                                <td className="py-1.5 px-2 text-right" style={{ color: 'var(--text-secondary)' }}>{b.block_start_time}</td>
                                <td className="py-1.5 px-2 text-right" style={{ color: 'var(--text-secondary)' }}>{b.block_end_time}</td>
                                <td className="py-1.5 px-2 text-right" style={{ color: 'var(--text-secondary)' }}>{(b.duration_minutes / 60).toFixed(2)}h</td>
                                <td className="py-1.5 px-2 text-right" style={{ color: 'var(--text-secondary)' }}>{b.trip_count}</td>
                                <td className="py-1.5 px-2" style={{ color: 'var(--text-primary)' }}>{r?.resolved_driver_name ?? '—'}</td>
                                <td className="py-1.5 px-2 font-semibold" style={{ color }}>{status}</td>
                                <td className="py-1.5 pl-2 max-w-md truncate" style={{ color: 'var(--text-tertiary)' }} title={reason}>{reason}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {vehiclePlanResult.blocks.length > 200 && (
                        <p className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>
                          … {vehiclePlanResult.blocks.length - 200} weitere Blöcke (nur erste 200 gezeigt)
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
            );
          })()}

          {/* Dienstzeitfenster Ausnahmen */}
          {readiness && readiness.shiftExceptions.length > 0 && (
            <div className="rounded-xl p-4" style={{
              background: readiness.shiftWindowValid ? 'var(--warning-subtle, #fff7e6)' : 'var(--danger-subtle)',
              border: `1px solid ${readiness.shiftWindowValid ? 'var(--warning)' : 'var(--danger)'}`,
            }}>
              <div className="flex items-start gap-2 mb-3">
                <AlertTriangle size={16} style={{ color: readiness.shiftWindowValid ? 'var(--warning)' : 'var(--danger)', flexShrink: 0, marginTop: 1 }} />
                <div className="flex-1">
                  <p className="text-sm font-semibold" style={{ color: readiness.shiftWindowValid ? 'var(--warning)' : 'var(--danger)' }}>
                    Dienstzeitfenster: {readiness.shiftExceptions.length} Block/Bloecke außerhalb der geplanten Arbeitszeit
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                    {readiness.acceptedShiftExceptionList.length} akzeptiert &middot; {readiness.unacceptedShiftExceptionList.length} nicht akzeptiert.
                    Jede Ausnahme muss explizit bestätigt werden, bevor der Plan angewendet oder ein Stundennachweis erstellt werden kann.
                  </p>
                </div>
                {readiness.unacceptedShiftExceptionList.length > 0 && (
                  <button
                    onClick={() => {
                      setAcceptedShiftExceptions(prev => {
                        const next = new Set(prev);
                        for (const e of readiness.shiftExceptions) next.add(e.key);
                        return next;
                      });
                    }}
                    className="text-xs px-3 py-1.5 rounded-lg font-semibold"
                    style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                  >
                    Alle akzeptieren
                  </button>
                )}
              </div>
              <div className="space-y-1 max-h-72 overflow-y-auto">
                {readiness.shiftExceptions.slice(0, 50).map(e => {
                  const accepted = acceptedShiftExceptions.has(e.key);
                  const windowLabel = e.windowStart && e.windowEnd ? `${e.windowStart}–${e.windowEnd}` : '—';
                  const reasonLabel = e.reason === 'wrong_weekday'
                    ? 'Fahrer an diesem Wochentag nicht verfügbar'
                    : `außerhalb Dienstzeit (${windowLabel})`;
                  return (
                    <label key={e.key} className="flex items-start gap-2 text-xs px-2 py-1.5 rounded cursor-pointer" style={{
                      background: accepted ? 'var(--success-subtle)' : 'var(--bg-surface)',
                      border: `1px solid ${accepted ? 'var(--success)' : 'var(--border)'}`,
                    }}>
                      <input
                        type="checkbox"
                        checked={accepted}
                        onChange={() => {
                          setAcceptedShiftExceptions(prev => {
                            const next = new Set(prev);
                            if (next.has(e.key)) next.delete(e.key);
                            else next.add(e.key);
                            return next;
                          });
                        }}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                          {e.driverName} &middot; {e.date} &middot; {e.startTime}–{e.endTime}
                        </div>
                        <div style={{ color: 'var(--text-secondary)' }}>
                          {reasonLabel}
                          {e.minutesOutside > 0 && ` · ${e.minutesOutside} Min. außerhalb`}
                          {e.allowedByDriver && ' · Fahrer erlaubt Ausnahmen'}
                        </div>
                      </div>
                      {accepted && <span className="text-[10px] font-semibold" style={{ color: 'var(--success)' }}>AKZEPTIERT</span>}
                    </label>
                  );
                })}
                {readiness.shiftExceptions.length > 50 && (
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>... und {readiness.shiftExceptions.length - 50} weitere</p>
                )}
              </div>
            </div>
          )}

          {/* Ziel-Optimierung Diagnostik (per Fahrer) */}
          {readiness && readiness.stundennachweisValid && !readiness.targetOptimized && (readiness.targetGaps.length > 0 || readiness.salaryGaps.length > 0) && (
            <div className="rounded-xl p-4" style={{ background: 'var(--warning-subtle, #fff7e6)', border: '1px solid var(--warning)' }}>
              <div className="flex items-start gap-2 mb-3">
                <AlertTriangle size={16} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
                <div>
                  <p className="text-sm font-semibold" style={{ color: 'var(--warning)' }}>
                    Plan ist sicher, aber noch nicht zieloptimiert
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                    Folgende Fahrer haben offene Zielstunden oder Wunschgehalt-Luecken. Reassignments koennen vorgeschlagen werden, selbst wenn das Fahrtenbuch ueberlapp-frei ist.
                  </p>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ color: 'var(--text-tertiary)' }}>
                      <th className="text-left py-1 pr-3">Fahrer</th>
                      <th className="text-right py-1 px-2">Ziel-Std</th>
                      <th className="text-right py-1 px-2">Geplant</th>
                      <th className="text-right py-1 px-2">Luecke</th>
                      <th className="text-right py-1 px-2">Wunschgehalt</th>
                      <th className="text-right py-1 pl-2">Gehalt-Luecke</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.planDrivers
                      .filter(pd => {
                        const hasTargetGap = pd.driver.target_monthly_hours != null && pd.totalHours < (pd.driver.target_monthly_hours as number) * 0.9;
                        const hasSalaryGap = pd.salaryStatus === 'under';
                        return hasTargetGap || hasSalaryGap;
                      })
                      .map((pd, i) => {
                        const tgt = pd.driver.target_monthly_hours;
                        const gap = tgt != null ? tgt - pd.totalHours : null;
                        const salGap = pd.salaryStatus === 'under' && pd.salaryDiff != null ? Math.abs(pd.salaryDiff) : null;
                        return (
                          <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                            <td className="py-1.5 pr-3 font-medium" style={{ color: 'var(--text-primary)' }}>{pd.driver.name}</td>
                            <td className="py-1.5 px-2 text-right" style={{ color: 'var(--text-secondary)' }}>{tgt != null ? `${tgt.toFixed(1)} h` : '—'}</td>
                            <td className="py-1.5 px-2 text-right" style={{ color: 'var(--text-secondary)' }}>{pd.totalHours.toFixed(1)} h</td>
                            <td className="py-1.5 px-2 text-right font-semibold" style={{ color: gap != null && gap > 0 ? 'var(--warning)' : 'var(--success)' }}>{gap != null ? `${gap.toFixed(1)} h` : '—'}</td>
                            <td className="py-1.5 px-2 text-right" style={{ color: 'var(--text-secondary)' }}>{pd.driver.planning_target_salary != null ? `${(pd.driver.planning_target_salary as number).toFixed(0)} €` : '—'}</td>
                            <td className="py-1.5 pl-2 text-right font-semibold" style={{ color: salGap != null ? 'var(--warning)' : 'var(--text-tertiary)' }}>{salGap != null ? `${salGap.toFixed(0)} €` : '—'}</td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: 'Gesamt Fahrten',         value: result.totalTrips,            color: 'var(--text-primary)' },
              { label: 'Storniert',              value: result.canceledTrips,         color: 'var(--text-tertiary)' },
              { label: 'Abgedeckte Fahrten',     value: result.coveredTrips,          color: 'var(--success)' },
              { label: 'Nicht abgedeckt',        value: result.uncoveredTrips,        color: result.uncoveredTrips > 0 ? 'var(--danger)' : 'var(--success)' },
              { label: 'Vorgeschlagene Wechsel', value: result.proposedReassignments, color: result.proposedReassignments > 0 ? 'var(--warning)' : 'var(--success)' },
              { label: 'Geplante Fahrer',        value: result.planDrivers.length,    color: 'var(--accent-text)' },
              { label: 'Über Zielstunden',       value: result.driversOverTarget,     color: result.driversOverTarget > 0 ? 'var(--warning)' : 'var(--success)' },
              { label: 'Über Maximalstunden',    value: result.driversOverMax,        color: result.driversOverMax > 0 ? 'var(--danger)' : 'var(--success)' },
            ].map((c, i) => (
              <div key={i} className="rounded-xl p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                <p className="text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{c.label}</p>
                <p className="text-2xl font-bold" style={{ color: c.color }}>{c.value}</p>
              </div>
            ))}
          </div>

          {/* Per-driver table — all rows collapsed by default */}
          <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="px-6 py-4 font-semibold text-sm" style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' }}>
              Fahrer-Übersicht
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead style={{ background: 'var(--bg-subtle)' }}>
                  <tr>
                    {['Fahrer','Typ','Wunschgehalt','Berechnet','Differenz','Zielstunden','Max Std.','Geplante Std.','Fahrten','Übernahmen','Warnungen',''].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.planDrivers.map(pd => {
                    const targetH = pd.driver.target_monthly_hours;
                    const maxH    = pd.driver.max_monthly_hours;
                    const toleranceMins = parsedToleranceHours;
                    const overMax    = maxH != null && pd.totalHours > maxH;
                    const overTarget = targetH != null && pd.totalHours > targetH && !overMax;
                    const belowTarget = targetH != null && pd.totalHours < targetH * 0.9;
                    const inRange    = targetH != null && !overMax && !overTarget && !belowTarget;

                    // Row color: salary status takes priority if available
                    const hasSalTarget = pd.salaryStatus !== 'no_target' && pd.salaryStatus !== 'no_rate';
                    let hoursColor = 'var(--text-secondary)';
                    let rowBg = 'transparent';
                    if (hasSalTarget) {
                      if (pd.salaryStatus === 'over')       { rowBg = 'rgba(239,68,68,0.04)'; }
                      else if (pd.salaryStatus === 'under') { rowBg = 'rgba(245,158,11,0.02)'; }
                      else if (pd.salaryStatus === 'ok')    { rowBg = 'rgba(5,150,105,0.03)'; }
                    } else {
                      if (overMax)         { rowBg = 'rgba(239,68,68,0.04)'; }
                      else if (overTarget) { rowBg = 'rgba(245,158,11,0.04)'; }
                      else if (belowTarget){ rowBg = 'rgba(245,158,11,0.02)'; }
                    }
                    if (overMax)         { hoursColor = 'var(--danger)'; }
                    else if (overTarget) { hoursColor = 'var(--warning)'; }
                    else if (belowTarget){ hoursColor = 'var(--warning)'; }
                    else if (inRange)    { hoursColor = 'var(--success)'; }

                    const targetLow  = targetH != null ? Math.max(0, targetH - toleranceMins) : null;
                    const targetHigh = targetH != null ? targetH + toleranceMins : null;
                    const isExpanded = expandedDrivers.has(pd.driver.id);

                    const fmtEuro = (v: number) => v.toFixed(2).replace('.', ',') + ' €';
                    const salaryColor = pd.salaryStatus === 'ok' ? 'var(--success)'
                      : pd.salaryStatus === 'over' ? 'var(--danger)'
                      : pd.salaryStatus === 'under' ? 'var(--warning)'
                      : 'var(--text-secondary)';

                    return (
                      <React.Fragment key={pd.driver.id}>
                        <tr style={{ borderBottom: '1px solid var(--border)', background: rowBg }}>
                          <td className="px-4 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>
                            <div className="flex items-center gap-2"><User size={14} style={{ color: 'var(--text-tertiary)' }} />{pd.driver.name}</div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-col gap-0.5">
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium inline-block w-fit"
                                style={pd.driver.driver_usage_type === 'coverage_only'
                                  ? { background: 'var(--warning-subtle)', color: 'var(--warning)' }
                                  : { background: 'var(--accent-subtle)',  color: 'var(--accent-text)' }}>
                                {pd.driver.driver_usage_type === 'coverage_only' ? 'Reserve' : 'Regulär'}
                              </span>
                              {pd.driver.driver_usage_type === 'coverage_only' && pd.blocks.filter(b => b.status === 'ok' || b.status === 'proposed_reassignment' || b.status === 'short_block' || b.status === 'cross_midnight').length > 0 && (
                                <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                                  {pd.coverageReasons.length > 0
                                    ? pd.coverageReasons.map(r => {
                                        const labels: Record<string, string> = {
                                          daily_limit: 'Tageslimit', salary_limit: 'Gehaltslimit',
                                          monthly_limit: 'Monatslimit', note_blocked: 'Notiz',
                                          no_regular_capacity: 'Kein Regulärer frei',
                                        };
                                        return `${labels[r.type] ?? r.type} (${r.count})`;
                                      }).join(', ')
                                    : 'Nur Deckung'
                                  }
                                </span>
                              )}
                              {pd.isCoverageOverTargetWhileRegularsNeed && (
                                <span className="text-[10px] font-medium" style={{ color: 'var(--danger)' }}>
                                  Über Ziel trotz reg. Bedarf
                                </span>
                              )}
                            </div>
                          </td>
                          {/* Wunschgehalt */}
                          <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                            {pd.driver.planning_target_salary != null && pd.driver.planning_target_salary > 0
                              ? <span>{fmtEuro(pd.driver.planning_target_salary)}</span>
                              : pd.driver.planning_hourly_rate != null && pd.driver.planning_hourly_rate > 0
                                ? <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{pd.driver.planning_hourly_rate.toFixed(2).replace('.', ',')} €/Std.</span>
                                : <span className="text-xs" style={{ color: 'var(--warning)' }}>Stundensatz fehlt</span>
                            }
                          </td>
                          {/* Berechnet */}
                          <td className="px-4 py-3 font-semibold text-sm" style={{ color: salaryColor }}>
                            {pd.expectedGross != null ? fmtEuro(pd.expectedGross) : '—'}
                          </td>
                          {/* Differenz */}
                          <td className="px-4 py-3 text-sm">
                            {pd.salaryDiff != null ? (
                              <div>
                                <span className="font-semibold" style={{ color: salaryColor }}>
                                  {pd.salaryDiff >= 0 ? '+' : ''}{fmtEuro(pd.salaryDiff)}
                                </span>
                                <span className="block text-xs" style={{ color: salaryColor }}>
                                  {pd.salaryStatus === 'ok' ? 'Im Zielbereich'
                                    : pd.salaryStatus === 'over' ? 'Über Wunschgehalt'
                                    : 'Unter Wunschgehalt'}
                                </span>
                              </div>
                            ) : '—'}
                          </td>
                          <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                            {targetH != null ? (
                              <div>
                                <span>{fmtHours(targetH)}</span>
                                {targetLow != null && targetHigh != null && (
                                  <span className="block text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                    Bereich: {targetLow.toFixed(0)}–{targetHigh.toFixed(0)}
                                  </span>
                                )}
                              </div>
                            ) : '—'}
                          </td>
                          <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                            {maxH != null ? fmtHours(maxH) : '—'}
                          </td>
                          <td className="px-4 py-3 font-semibold" style={{ color: hoursColor }}>
                            <span>{fmtHours(pd.totalHours)}</span>
                            {overMax && <span className="block text-xs font-normal" style={{ color: 'var(--danger)' }}>Maximalstunden überschritten</span>}
                            {belowTarget && <span className="block text-xs font-normal" style={{ color: 'var(--warning)' }}>Unter Zielstunden</span>}
                          </td>
                          <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{pd.tripCount}</td>
                          <td className="px-4 py-3" style={{ color: pd.proposedOverflows > 0 ? 'var(--warning)' : 'var(--text-tertiary)' }}>
                            {pd.proposedOverflows > 0 ? pd.proposedOverflows : '—'}
                          </td>
                          <td className="px-4 py-3">
                            {pd.warnings.length > 0
                              ? <div className="flex items-center gap-1" style={{ color: overMax ? 'var(--danger)' : 'var(--warning)' }}><AlertTriangle size={14} /><span className="text-xs">{pd.warnings.length}</span></div>
                              : <CheckCircle size={14} style={{ color: 'var(--success)' }} />}
                          </td>
                          <td className="px-4 py-3">
                            {pd.blocks.length > 0 && (
                              <button onClick={() => toggleDriver(pd.driver.id)} className="text-xs flex items-center gap-1" style={{ color: 'var(--accent-text)' }}>
                                {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                {pd.blocks.length} Blöcke
                              </button>
                            )}
                          </td>
                        </tr>
                        {isExpanded && pd.blocks.length > 0 && (
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <td colSpan={12} className="px-4 pb-4 pt-2">
                              <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                                <table className="w-full text-xs">
                                  <thead style={{ background: 'var(--bg-subtle)' }}>
                                    <tr>
                                      {['Datum','Start','Ende','Stunden','Fahrten','Quelle','Status','Grund'].map(h => (
                                        <th key={h} className="px-3 py-2 text-left font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {pd.blocks.map((b, bi) => (
                                      <tr key={bi} style={{ borderTop: '1px solid var(--border)' }}>
                                        <td className="px-3 py-2 font-medium whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                                          {new Date(b.date + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}
                                        </td>
                                        <td className="px-3 py-2" style={{ color: 'var(--text-primary)' }}>{b.startTime}</td>
                                        <td className="px-3 py-2" style={{ color: 'var(--text-primary)' }}>{b.endTime}</td>
                                        <td className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>{fmtHours(b.durationHours)}</td>
                                        <td className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>{b.tripCount || '—'}</td>
                                        <td className="px-3 py-2">
                                          <span className="text-xs px-1 py-0.5 rounded" style={{
                                            background: b.blockSource === 'fahrtenbuch+note' ? 'var(--warning-subtle)' : b.blockSource === 'note' ? 'var(--accent-subtle)' : 'var(--bg-muted)',
                                            color:      b.blockSource === 'fahrtenbuch+note' ? 'var(--warning)' : b.blockSource === 'note' ? 'var(--accent-text)' : 'var(--text-tertiary)',
                                          }}>
                                            {b.blockSource === 'fahrtenbuch+note' ? 'FB+Notiz' : b.blockSource === 'note' ? 'Notiz' : 'FB'}
                                          </span>
                                        </td>
                                        <td className="px-3 py-2"><StatusBadge status={b.status} /></td>
                                        <td className="px-3 py-2" style={{ color: 'var(--text-tertiary)' }}>{b.reason || '—'}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              {pd.warnings.length > 0 && (
                                <div className="mt-2 space-y-1">
                                  {pd.warnings.map((w, wi) => (
                                    <div key={wi} className="flex items-center gap-1.5 text-xs px-2 py-1 rounded"
                                      style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}>
                                      <AlertTriangle size={12} />{w}
                                    </div>
                                  ))}
                                </div>
                              )}
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

          {/* All blocks — collapsed by default */}
          <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <button onClick={() => setShowAllBlocks(v => !v)}
              className="w-full flex items-center justify-between px-6 py-4 text-sm font-semibold"
              style={{ borderBottom: showAllBlocks ? '1px solid var(--border)' : 'none', color: 'var(--text-primary)' }}>
              <span>Alle geplanten Blöcke ({result.allBlocks.length})</span>
              {showAllBlocks ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {showAllBlocks && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead style={{ background: 'var(--bg-subtle)' }}>
                    <tr>
                      {['Datum','Vorgeschlagener Fahrer','Originalfahrer','Start','Ende','Stunden','Fahrten','Quelle','Status','Grund'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.allBlocks.map((b, i) => {
                      const assignedDriver = result.planDrivers[b.driverIndex]?.driver;
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td className="px-4 py-3 font-medium whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                            {new Date(b.date + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit' })}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                            <div className="flex items-center gap-1.5">
                              {b.isReassigned && <ArrowRight size={12} style={{ color: 'var(--warning)' }} />}
                              {assignedDriver?.name ?? '—'}
                            </div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{b.originalDriverName}</td>
                          <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{b.startTime}</td>
                          <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{b.endTime}</td>
                          <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>{fmtHours(b.durationHours)}</td>
                          <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>{b.tripCount || '—'}</td>
                          <td className="px-4 py-3">
                            <span className="text-xs px-1.5 py-0.5 rounded" style={{
                              background: b.blockSource === 'fahrtenbuch+note' ? 'var(--warning-subtle)' : b.blockSource === 'note' ? 'var(--accent-subtle)' : 'var(--bg-muted)',
                              color:      b.blockSource === 'fahrtenbuch+note' ? 'var(--warning)' : b.blockSource === 'note' ? 'var(--accent-text)' : 'var(--text-tertiary)',
                            }}>
                              {b.blockSource === 'fahrtenbuch+note' ? 'FB + Notiz' : b.blockSource === 'note' ? 'Notiz' : 'Fahrtenbuch'}
                            </span>
                          </td>
                          <td className="px-4 py-3"><StatusBadge status={b.status} /></td>
                          <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>{b.reason || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Finale Prüfungsansicht */}
          <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <button onClick={() => setShowReview(v => !v)}
              className="w-full flex items-center justify-between px-6 py-4 text-sm font-semibold"
              style={{ borderBottom: showReview ? '1px solid var(--border)' : 'none', color: 'var(--text-primary)' }}>
              <span className="flex items-center gap-2"><Filter size={16} />Finale Prüfungsansicht</span>
              {showReview ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {showReview && (() => {
              const blocks = result.allBlocks;
              const reassignments = blocks.filter(b => b.status === 'proposed_reassignment');
              const warnings = blocks.filter(b => WARNING_STATUSES.has(b.status));
              const critical = blocks.filter(b => CRITICAL_STATUSES.has(b.status));
              const shortBlocks = blocks.filter(b => b.status === 'short_block' || b.isShortBlock);
              const midnightBlocks = blocks.filter(b => b.status === 'cross_midnight' || b.crossesMidnight);
              const allWarnings = result.planDrivers.reduce((a, pd) => a + pd.warnings.length, 0);

              const filterOptions: Array<{ key: typeof reviewFilter; label: string; count: number; icon: React.ReactNode }> = [
                { key: 'all',          label: 'Alle',                     count: blocks.length,        icon: <CheckCircle size={13} /> },
                { key: 'reassignment', label: 'Nur vorgeschlagene Wechsel', count: reassignments.length, icon: <ArrowRight size={13} /> },
                { key: 'warnings',     label: 'Nur Warnungen',            count: warnings.length,      icon: <AlertTriangle size={13} /> },
                { key: 'critical',     label: 'Nur kritische Fehler',     count: critical.length,      icon: <Zap size={13} /> },
                { key: 'short',        label: 'Nur kurze Blöcke',         count: shortBlocks.length,   icon: <Clock size={13} /> },
                { key: 'midnight',     label: 'Nur Mitternacht-Probleme', count: midnightBlocks.length,icon: <Moon size={13} /> },
              ];

              const filteredBlocks = reviewFilter === 'all' ? blocks
                : reviewFilter === 'reassignment' ? reassignments
                : reviewFilter === 'warnings' ? warnings
                : reviewFilter === 'critical' ? critical
                : reviewFilter === 'short' ? shortBlocks
                : midnightBlocks;

              return (
                <div className="p-5 space-y-4">
                  {/* Summary cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
                    {[
                      { label: 'Gesamtblöcke',      value: blocks.length,        color: 'var(--text-primary)' },
                      { label: 'OK',                 value: blocks.filter(b => b.status === 'ok').length, color: 'var(--success)' },
                      { label: 'Kritisch',           value: critical.length,      color: critical.length > 0 ? 'var(--danger)' : 'var(--success)' },
                      { label: 'Gelöst',             value: blocks.filter(b => RESOLVED_STATUSES.has(b.status)).length, color: '#1d4ed8' },
                      { label: 'Wechselvorschläge',  value: reassignments.length, color: reassignments.length > 0 ? 'var(--warning)' : 'var(--success)' },
                      { label: 'Warnungen (Fahrer)', value: allWarnings,          color: allWarnings > 0 ? 'var(--warning)' : 'var(--success)' },
                      { label: 'Kurze Blöcke',       value: shortBlocks.length,   color: shortBlocks.length > 0 ? 'var(--warning)' : 'var(--success)' },
                      { label: 'Mitternacht',        value: midnightBlocks.length,color: midnightBlocks.length > 0 ? 'var(--accent-text)' : 'var(--success)' },
                    ].map((c, i) => (
                      <div key={i} className="rounded-lg p-3 text-center" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                        <p className="text-xs mb-0.5" style={{ color: 'var(--text-tertiary)' }}>{c.label}</p>
                        <p className="text-xl font-bold" style={{ color: c.color }}>{c.value}</p>
                      </div>
                    ))}
                  </div>

                  {/* Filter tabs */}
                  <div className="flex flex-wrap gap-2">
                    {filterOptions.map(opt => (
                      <button key={opt.key}
                        onClick={() => setReviewFilter(opt.key)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                        style={{
                          background: reviewFilter === opt.key ? 'var(--accent)' : 'var(--bg-subtle)',
                          color: reviewFilter === opt.key ? 'var(--accent-text)' : 'var(--text-secondary)',
                          border: `1px solid ${reviewFilter === opt.key ? 'var(--accent)' : 'var(--border)'}`,
                        }}>
                        {opt.icon}
                        {opt.label}
                        <span className="px-1.5 py-0.5 rounded-full text-xs" style={{
                          background: reviewFilter === opt.key ? 'rgba(255,255,255,0.2)' : 'var(--bg-muted)',
                        }}>{opt.count}</span>
                      </button>
                    ))}
                  </div>

                  {/* Filtered table */}
                  {filteredBlocks.length === 0 ? (
                    <div className="text-center py-8 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                      Keine Blöcke in dieser Kategorie.
                    </div>
                  ) : (
                    <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--border)' }}>
                      <table className="w-full text-sm">
                        <thead style={{ background: 'var(--bg-subtle)' }}>
                          <tr>
                            {['Datum','Fahrer','Originalfahrer','Start','Ende','Stunden','Fahrten','Status','Grund','Aktion'].map(h => (
                              <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filteredBlocks.map((b, i) => {
                            const assignedDriver = result.planDrivers[b.driverIndex]?.driver;
                            const globalIdx = result.allBlocks.indexOf(b);
                            const isCritical = CRITICAL_STATUSES.has(b.status);
                            const isResolved = RESOLVED_STATUSES.has(b.status);
                            return (
                              <tr key={i} style={{ borderTop: i > 0 ? '1px solid var(--border)' : 'none' }}>
                                <td className="px-3 py-2 font-medium whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                                  {new Date(b.date + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}
                                </td>
                                <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                                  <div className="flex items-center gap-1">
                                    {b.isReassigned && <ArrowRight size={11} style={{ color: 'var(--warning)' }} />}
                                    {assignedDriver?.name ?? '—'}
                                  </div>
                                </td>
                                <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{b.originalDriverName}</td>
                                <td className="px-3 py-2" style={{ color: 'var(--text-primary)' }}>{b.startTime}</td>
                                <td className="px-3 py-2" style={{ color: 'var(--text-primary)' }}>{b.endTime}</td>
                                <td className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>{fmtHours(b.durationHours)}</td>
                                <td className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>{b.tripCount || '—'}</td>
                                <td className="px-3 py-2"><StatusBadge status={b.status} /></td>
                                <td className="px-3 py-2 text-xs max-w-xs" style={{ color: 'var(--text-tertiary)' }}>{b.reason || '—'}</td>
                                <td className="px-3 py-2 whitespace-nowrap">
                                  {isCritical && (
                                    <button onClick={() => setConflictBlockIndex(globalIdx)}
                                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors"
                                      style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid var(--danger)' }}>
                                      <Zap size={11} />Konflikt lösen
                                    </button>
                                  )}
                                  {isResolved && (
                                    <button onClick={() => undoResolution(globalIdx)}
                                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors"
                                      style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                                      <RotateCcw size={11} />Rückgängig
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Status hint */}
          {planApplied ? (
            <div className="rounded-xl p-4 flex items-start gap-3" style={{ background: 'var(--success-subtle)', border: '1px solid var(--success)' }}>
              <CheckCircle size={16} style={{ color: 'var(--success)', flexShrink: 0, marginTop: 2 }} />
              <div className="flex-1">
                <p className="text-sm" style={{ color: 'var(--success)' }}>
                  {applicableBlocks.length > 0 ? (
                    <><strong>Plan wurde angewendet.</strong> Die Fahrerzuordnungen im Fahrtenbuch wurden aktualisiert.
                    Preise, Zeiten, Routen und Originalfahrer sind unveraendert. Alle Aenderungen sind im Audit-Log nachvollziehbar.</>
                  ) : (
                    <><strong>Fahrtenbuch ist bereits sauber.</strong> Keine Aenderungen erforderlich.
                    Sie koennen direkt mit der Stundennachweis-Erstellung fortfahren.</>
                  )}
                </p>
                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={() => canGenerateStundennachweis && setShowStundennachweisModal(true)}
                    disabled={!canGenerateStundennachweis}
                    title={!canGenerateStundennachweis ? 'Stundennachweis blockiert — Plan verletzt Sicherheits-, Stundennachweis- oder Dienstzeit-Regeln.' : undefined}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ background: 'var(--accent)', color: 'white' }}>
                    <Clock size={14} />Stundennachweise erstellen
                  </button>
                  <button onClick={handleExportFahrtenbuch} disabled={exporting || !canGenerateStundennachweis}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
                    style={{ background: 'var(--success)', color: 'white' }}>
                    <Download size={14} />{exporting ? 'Exportiert...' : 'Fahrtenbuch herunterladen'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl p-4 flex items-start gap-3" style={{ background: 'var(--accent-subtle)', border: '1px solid var(--accent)' }}>
              <Info size={16} style={{ color: 'var(--accent-text)', flexShrink: 0, marginTop: 2 }} />
              <p className="text-sm" style={{ color: 'var(--accent-text)' }}>
                <strong>Vorschau.</strong> Keine Fahrtenbuch-Daten wurden veraendert. Speichern Sie den Plan und klicken Sie auf &quot;Plan anwenden&quot;, um Fahrerzuordnungen zu uebernehmen.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Saved planning runs */}
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <button onClick={() => { setShowSavedRuns(v => !v); if (!showSavedRuns) loadSavedRuns(); }}
          className="w-full flex items-center justify-between px-6 py-4 text-sm font-semibold"
          style={{ borderBottom: showSavedRuns ? '1px solid var(--border)' : 'none', color: 'var(--text-primary)' }}>
          <span className="flex items-center gap-2">
            <FolderOpen size={16} />
            Gespeicherte Planentwürfe {savedRuns.length > 0 && `(${savedRuns.length})`}
          </span>
          {showSavedRuns ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {showSavedRuns && (
          <div>
            {loadingRuns ? (
              <div className="px-6 py-4 text-sm" style={{ color: 'var(--text-tertiary)' }}>Lädt …</div>
            ) : savedRuns.length === 0 ? (
              <div className="px-6 py-6 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>Noch keine Planentwürfe gespeichert.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead style={{ background: 'var(--bg-subtle)' }}>
                    <tr>
                      {['Monat/Jahr','Fahrtenbuch Import','Erstellt am','Max. Schicht','Blöcke','Warnungen','Status','Aktionen'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {savedRuns.map(run => (
                      <tr key={run.id} style={{ borderBottom: '1px solid var(--border)', background: currentRunId === run.id ? 'var(--accent-subtle)' : 'transparent' }}>
                        <td className="px-4 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>{MONTH_NAMES[run.month-1]} {run.year}</td>
                        <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {run.import_file_name ?? (run.import_id ? run.import_id.slice(0,8)+'…' : '—')}
                        </td>
                        <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {new Date(run.created_at).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' })}
                        </td>
                        <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{(run.max_shift_minutes/60).toFixed(1)} Std.</td>
                        <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{run.block_count}</td>
                        <td className="px-4 py-3">
                          {run.warning_count > 0
                            ? <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--warning)' }}><AlertTriangle size={12} />{run.warning_count}</span>
                            : <CheckCircle size={14} style={{ color: 'var(--success)' }} />}
                        </td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={{
                            background: run.status === 'applied' ? 'var(--success-subtle)' : 'var(--bg-muted)',
                            color: run.status === 'applied' ? 'var(--success)' : 'var(--text-secondary)',
                          }}>
                            {run.status === 'applied' ? 'Angewendet' : 'Entwurf'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <button onClick={() => handleOpenDraft(run)}
                              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium"
                              style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}
                              onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
                              onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}>
                              <FolderOpen size={12} />Öffnen
                            </button>
                            <button onClick={() => handleDeleteDraft(run.id)}
                              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium"
                              style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}
                              onMouseEnter={e => { e.currentTarget.style.background = 'var(--danger)'; e.currentTarget.style.color = 'white'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'var(--danger-subtle)'; e.currentTarget.style.color = 'var(--danger)'; }}>
                              <Trash2 size={12} />Löschen
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
      {/* Apply Confirmation Modal */}
      {showApplyModal && result && readiness && createPortal(
        <div className="fixed inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)', zIndex: 9999 }}>
          <div className="w-full max-w-lg mx-4 rounded-2xl shadow-2xl overflow-hidden" style={{ background: 'var(--bg-surface)' }}>
            <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border)', background: 'var(--success-subtle)' }}>
              <div className="flex items-center gap-2">
                <Play size={18} style={{ color: 'var(--success)' }} />
                <h3 className="font-semibold text-sm" style={{ color: 'var(--success)' }}>Plan wirklich anwenden?</h3>
              </div>
              <button onClick={() => setShowApplyModal(false)} className="p-1 rounded-lg transition-colors hover:bg-black/10">
                <X size={18} style={{ color: 'var(--text-secondary)' }} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Vorgeschl. Fahrerwechsel', value: readiness.reassignmentCount },
                  { label: 'Warnungen', value: readiness.warningCount },
                  { label: 'Mitternacht-Blöcke', value: readiness.midnightBlockCount },
                  { label: 'Kurze Blöcke', value: readiness.shortBlockCount },
                  { label: 'Gelöste Konflikte', value: readiness.resolvedCount },
                  { label: 'Ausgeschlossene Blöcke', value: readiness.excludedCount },
                  { label: 'Anwendbare Blöcke', value: applicableBlocks.length },
                  { label: 'Betroffene Fahrten', value: applicableTripCount },
                ].map((c, i) => (
                  <div key={i} className="flex justify-between items-center px-3 py-2 rounded-lg text-sm" style={{ background: 'var(--bg-subtle)' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{c.label}</span>
                    <span className="font-bold" style={{ color: 'var(--text-primary)' }}>{c.value}</span>
                  </div>
                ))}
              </div>

              <div className="rounded-lg p-3 text-xs space-y-2" style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)' }}>
                <div className="flex items-start gap-2">
                  <AlertTriangle size={13} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
                  <p style={{ color: 'var(--warning)' }}>
                    Es werden nur Fahrerzuordnungen im Fahrtenbuch geändert. Preise, Zeiten, Routen und Originalfahrer bleiben unverändert.
                  </p>
                </div>
                <div className="flex items-start gap-2">
                  <Shield size={13} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
                  <p style={{ color: 'var(--warning)' }}>
                    Diese Aktion schreibt Audit-Einträge und kann später nachvollzogen werden.
                  </p>
                </div>
                <div className="flex items-start gap-2">
                  <AlertTriangle size={13} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
                  <p style={{ color: 'var(--warning)' }}>
                    Bei einem Fehler kann eine teilweise Anwendung entstehen. Der Vorgang wird bei einem Fehler sofort abgebrochen.
                  </p>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button onClick={() => setShowApplyModal(false)}
                  className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)', background: 'var(--bg-subtle)' }}>
                  Abbrechen
                </button>
                <button onClick={handleApplyPlan}
                  className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-colors"
                  style={{ background: 'var(--success)', color: 'white' }}>
                  <Play size={14} />Plan anwenden
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Conflict Resolution Modal */}
      {conflictBlock && conflictBlockIndex != null && result && createPortal(
        <div className="fixed inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)', zIndex: 9999 }}>
          <div className="w-full max-w-2xl mx-4 rounded-2xl shadow-2xl overflow-hidden" style={{ background: 'var(--bg-surface)', maxHeight: '90vh' }}>
            <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border)', background: 'var(--danger-subtle)' }}>
              <div className="flex items-center gap-2">
                <Zap size={18} style={{ color: 'var(--danger)' }} />
                <h3 className="font-semibold text-sm" style={{ color: 'var(--danger)' }}>Konfliktlösung</h3>
              </div>
              <button onClick={() => setConflictBlockIndex(null)} className="p-1 rounded-lg transition-colors hover:bg-black/10">
                <X size={18} style={{ color: 'var(--text-secondary)' }} />
              </button>
            </div>

            <div className="overflow-y-auto p-6 space-y-5" style={{ maxHeight: 'calc(90vh - 60px)' }}>
              {/* Block details */}
              <div className="rounded-xl p-4 space-y-2" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Betroffener Block</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: 'Datum', value: new Date(conflictBlock.date + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) },
                    { label: 'Originalfahrer', value: conflictBlock.originalDriverName },
                    { label: 'Zeit', value: `${conflictBlock.startTime} – ${conflictBlock.endTime}` },
                    { label: 'Dauer', value: fmtHours(conflictBlock.durationHours) },
                  ].map((item, i) => (
                    <div key={i}>
                      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{item.label}</p>
                      <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{item.value}</p>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <StatusBadge status={conflictBlock.status} />
                  <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{conflictBlock.reason}</span>
                </div>
              </div>

              {/* Option 1: Assign to another driver */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <UserPlus size={15} style={{ color: '#1d4ed8' }} />
                  <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Anderem Fahrer zuweisen</p>
                </div>
                <div className="space-y-1.5">
                  {eligibleDriversForConflict.length === 0 ? (
                    <p className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--bg-subtle)', color: 'var(--text-tertiary)' }}>
                      Keine Fahrer verfügbar.
                    </p>
                  ) : (
                    eligibleDriversForConflict.map(ed => (
                      <div key={ed.driver.id}
                        className="flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors"
                        style={{
                          background: ed.isValid ? 'var(--bg-subtle)' : 'var(--bg-muted)',
                          border: '1px solid var(--border)',
                          opacity: ed.isValid ? 1 : 0.6,
                        }}>
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
                            style={{ background: ed.isValid ? '#dbeafe' : 'var(--bg-muted)', color: ed.isValid ? '#1d4ed8' : 'var(--text-tertiary)' }}>
                            {ed.driver.name.charAt(0)}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                              {ed.driver.name}
                              {ed.isSameAsOriginal && <span className="text-xs ml-1" style={{ color: 'var(--text-tertiary)' }}>(Original)</span>}
                            </p>
                            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                              {fmtHours(ed.monthlyHours)} geplant
                              {ed.remainingHours != null && ` · ${fmtHours(ed.remainingHours)} frei`}
                              {ed.dailyBlockCount > 0 && ` · ${ed.dailyBlockCount} Schichten am Tag`}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                          {!ed.isValid && (
                            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}>
                              {ed.issues[0]}
                            </span>
                          )}
                          <button
                            disabled={!ed.isValid}
                            onClick={() => resolveConflict(conflictBlockIndex, 'assign_driver', ed.driverIndex)}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                            style={{
                              background: ed.isValid ? '#1d4ed8' : 'var(--bg-muted)',
                              color: ed.isValid ? 'white' : 'var(--text-tertiary)',
                              cursor: ed.isValid ? 'pointer' : 'not-allowed',
                            }}>
                            <UserCheck size={12} />Zuweisen
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Option 2: Keep original driver */}
              <div className="rounded-xl p-4" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <UserCheck size={15} style={{ color: 'var(--warning)' }} />
                    <div>
                      <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Beim Originalfahrer belassen</p>
                      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        Block bleibt bei {conflictBlock.originalDriverName}. Als manuell bestätigt markiert.
                      </p>
                    </div>
                  </div>
                  <button onClick={() => resolveConflict(conflictBlockIndex, 'keep_original')}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                    style={{ background: 'var(--warning-subtle)', color: 'var(--warning)', border: '1px solid var(--warning)' }}>
                    <CheckCircle size={12} />Bestätigen
                  </button>
                </div>
              </div>

              {/* Option 3: Exclude from apply */}
              <div className="rounded-xl p-4" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Ban size={15} style={{ color: 'var(--text-tertiary)' }} />
                    <div>
                      <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Von Anwendung ausschließen</p>
                      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        Block wird bei Plan-Anwendung ignoriert und nicht übernommen.
                      </p>
                    </div>
                  </div>
                  <button onClick={() => resolveConflict(conflictBlockIndex, 'exclude')}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                    style={{ background: 'var(--bg-muted)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                    <Ban size={12} />Ausschließen
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
      {showStundennachweisModal && (() => {
        const impId = selImportId || filteredImports[0]?.id;
        const imp = filteredImports.find(i => i.id === impId);
        return impId ? (
          <GenerateStundennachweisModal
            open={showStundennachweisModal}
            onClose={() => setShowStundennachweisModal(false)}
            importId={impId}
            month={selMonth}
            year={selYear}
            importFileName={imp?.file_name}
            planRunId={currentRunId}
          />
        ) : null;
      })()}
      <ConfirmationModal
        isOpen={confirmModal.open}
        onClose={() => setConfirmModal(prev => ({ ...prev, open: false }))}
        onConfirm={confirmModal.onConfirm}
        title={confirmModal.title}
        message={confirmModal.message}
        type={confirmModal.type || 'confirm'}
        confirmText="Löschen"
        cancelText="Abbrechen"
      />
    </div>
  );
};

export default CompanyPlannerPage;
