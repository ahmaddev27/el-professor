// Monatsplanung – Phase 7: Stundennachweis Preview from assigned blocks (read-only).
// Loads an APPLIED planning run from DB, reconstructs the assigned blocks from
// fahrtenbuch_trips (grouped by assignment_block_id), and renders compact,
// collapsible per-driver summaries with German night-hour buckets
// (23-00, 00-04, 04-06) and expected Brutto using existing Stundennachweis
// Generator salary logic (planning_hourly_rate + 40% night premium + 50% sunday).
// No PDF export, no DB writes.

import { SimulatedNotice } from './simulatedRides/SimulatedBadge';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Save,
  Users,
  X,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';
import { deleteChecked, type WriteOutcome } from '../lib/writeOutcome';
import { resolveActualRideWindow } from '../utils/planningQualityChecks';
import { isPublicHoliday } from '../utils/germanHolidays';
import { writeMarkedWorkbook } from '../utils/simulatedRides/marker';
import { exportStundennachweisAsPdf, type PdfDayRow, type PdfTotals, getStundennachweisBlob } from '../utils/stundennachweisPdfExport';
import { exportAppliedRunXlsx, type AppliedRunSummary } from '../utils/monatsplanungXlsxExport';
import { exportFahreruebersichtImportFormat, type FahreruebersichtImportRow } from '../utils/fahreruebersichtExport';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey, TranslationVars } from '../i18n';
import { localHourMs, localMidnightMs, nextLocalMidnightMs } from '../utils/localDayWindow';

// Screen-text month names for the preview heading. TranslationKeys, because
// this table is module-level and t() is a hook value. The PDF keeps its own
// German table (MONTHS_DE_PDF, inside exportDriverPdf) — that one names the
// document handed to the Steuerberater and must not follow the UI language.
const MONTH_NAME_KEYS: TranslationKey[] = [
  'doc.month.january',   'doc.month.february', 'doc.month.march',    'doc.month.april',
  'doc.month.may',       'doc.month.june',     'doc.month.july',     'doc.month.august',
  'doc.month.september', 'doc.month.october',  'doc.month.november', 'doc.month.december',
];

interface AppliedRunRef {
  id: string;
  company_id: string;
  month: number;
  year: number;
  status: string;
  file_name: string;
  applied_at: string | null;
  import_id: string | null;
  source_sheet_name?: string | null;
  source_columns_json?: string[] | null;
}

interface Props {
  run: AppliedRunRef;
  onClose: () => void;
  /** Called after a transfer is successfully applied so the parent can mark the finalization stale. */
  onTransferApplied?: (runId: string) => void;
}

interface TripRow {
  id: string;
  trip_date: string;
  start_time: string;
  end_time: string;
  car_identifier: string | null;
  assigned_driver_id: string | null;
  assigned_driver_name: string;
  assignment_block_id: string | null;
  assignment_source: string | null;
  is_canceled: boolean;
  raw_data_json: Record<string, unknown> | null;
  /** Copied from the import by the database; a document built from such a ride says so. */
  is_simulated?: boolean;
}

interface ExceptionRow {
  block_id: string;
  dienstzeit_exception: boolean;
  tageslimit_exception: boolean;
  monatslimit_exception: boolean;
  reason: string | null;
}

interface DriverWage {
  id: string;
  personalnummer: string | null;
  planning_hourly_rate: number | null;
  planning_target_salary: number | null;
  planning_min_salary: number | null;
  planning_max_salary: number | null;
  planned_shift_start_time: string | null;   // HH:MM or null
  planned_shift_end_time: string | null;     // HH:MM or null
  planned_working_days: string[] | null;     // ['mon','tue',...]
  is_full_day_available: boolean | null;
}

interface ShiftBlock {
  block_id: string;
  driver_id: string;
  driver_name: string;
  vehicle: string;
  service_date: string;       // YYYY-MM-DD from block_start
  block_start_ms: number;     // actual start (from Fahrtenbuch)
  block_end_ms: number;       // actual end (from Fahrtenbuch)
  duration_minutes: number;   // actual duration
  // Paid / displayed values (may differ from actual when minimum shift rule applies)
  paid_end_ms: number;        // = block_start_ms + paid_duration_minutes * 60000
  paid_duration_minutes: number; // = max(duration_minutes, MIN_STUNDENNACHWEIS_SHIFT_MINUTES)
  minimum_applied: boolean;      // true when paid > actual
  minimum_added_minutes: number; // paid_duration_minutes - duration_minutes
  trip_count: number;
  assignment_source: string;
  // night buckets computed on paid interval [block_start_ms, paid_end_ms]
  night_23_00: number;
  night_00_04: number;
  night_04_06: number;
  // PDF column values (23:00–06:00 total and 00:00–04:00 subset)
  nachtarbeit_minutes: number;
  nacht0bis4_minutes: number;
  dienstzeit_exception: boolean;
  tageslimit_exception: boolean;
  monatslimit_exception: boolean;
  manual_exception: boolean;
  exception_reason: string;
}

interface DriverGroup {
  driver_id: string;
  driver_name: string;
  personalnummer: string | null;
  shifts: ShiftBlock[];
  trips: number;
  total_minutes: number;
  work_days: number;
  night_23_00: number;
  night_00_04: number;
  night_04_06: number;
  night_total: number;
  nachtarbeit_minutes: number;
  nacht0bis4_minutes: number;
  sunday_minutes: number;
  holiday_minutes: number;
  manual_exceptions: number;
  dienstzeit_exceptions: number;
  tageslimit_exceptions: number;
  monatslimit_exceptions: number;
  hourly_rate: number | null;
  target_salary: number | null;
  min_salary: number | null;
  max_salary: number | null;
  expected_brutto: number | null;
  ausgleich_hours?: number;
  ausgleich_amount?: number;
}

interface AdjustmentRecord {
  id: string;
  driver_id: string;
  driver_name: string;
  adjustment_type: string;
  hours: number;
  amount: number;
  hourly_rate: number;
}

interface ValidationIssue {
  type:
    | 'run_missing'
    | 'wrong_status'
    | 'no_trips_for_run'
    | 'block_missing_driver'
    | 'block_missing_vehicle'
    | 'block_missing_times'
    | 'orphan_trip_without_block'
    | 'trip_count_mismatch'
    | 'negative_duration'
    | 'negative_night';
  // Issues are raised in pure module-level helpers where t() is not available,
  // so they carry a key and its variables and are resolved where they render.
  detailKey: TranslationKey;
  detailVars?: TranslationVars;
  /** Already-formatted data lines (names, dates, plates) appended under the message. */
  detailLines?: string[];
}

const BATCH = 1000;
const PREM_NIGHT = 0.40;
const PREM_SUN = 0.50;
const PREM_HOLIDAY = 1.25;
// Minimum paid duration per Stundennachweis shift (payroll rule — not a planning rule).
const MIN_STUNDENNACHWEIS_SHIFT_MINUTES = 30;

function parseTimestamp(date: string, time: string): number {
  return new Date(`${date}T${time}`).getTime();
}

// Local YYYY-MM-DD from a ms timestamp. Must not use toISOString() because that
// converts to UTC and would shift early-morning shifts (e.g. 00:15 local) to the
// previous calendar day.
function localDateString(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Compute minutes between `startMs` and `endMs` that fall in [bucketStartHour, bucketEndHour)
// applied recurrently for every calendar day touched by the shift.
//
// Both the day step and the bucket edges are CALENDAR/WALL-CLOCK, never fixed
// millisecond arithmetic, and this function carried both mistakes:
//
//   - `d += 24 * 60 * 60 * 1000` is an hour off on each of the two days a year
//     the offset changes, and it does not recover — once the walk is an hour off
//     local midnight it stays off for every later day of the same shift, so the
//     buckets of an ordinary Monday after a transition are shifted too.
//   - `d + hour * 3600000` is an hour off on the transition day itself: a
//     spring-forward day is 23 hours, so `midnight + 4h` is local 05:00 and the
//     00:00-04:00 bucket swallows an hour of the next one; a fall-back day is 25
//     hours, so it is local 03:00 and the bucket gives an hour away.
//
// 26 production trips sit on 29.03.2026 and the next transition is 25.10.2026.
// The bucket HOURS are untouched: this screen's Nachtarbeit still opens at 23:00
// while the clean engine's opens at 20:00, because choosing between the two is a
// decision about §3b EStG and not about timezones.
function minutesInBucket(startMs: number, endMs: number, bucketStartHour: number, bucketEndHour: number): number {
  if (endMs <= startMs) return 0;
  let total = 0;
  // Walk by day-of-shift: snap startMs back to local midnight, iterate per day.
  for (let d = localMidnightMs(startMs); d < endMs; d = nextLocalMidnightMs(d)) {
    const bs = localHourMs(d, bucketStartHour);
    const be = localHourMs(d, bucketEndHour);
    const overlap = Math.max(0, Math.min(endMs, be) - Math.max(startMs, bs));
    total += overlap;
  }
  // Use floor so sub-minute seconds never round up to an extra minute.
  return Math.floor(total / 60000);
}

function computeNightBuckets(startMs: number, endMs: number) {
  const n23 = minutesInBucket(startMs, endMs, 23, 24);
  const n00 = minutesInBucket(startMs, endMs, 0, 4);
  const n04 = minutesInBucket(startMs, endMs, 4, 6);
  // Nachtarbeit = 23:00–00:00 plus 04:00–06:00 only.
  // Nacht 0–4 Uhr = 00:00–04:00 exclusively.
  // The two columns must be mutually exclusive — the same minute must not
  // appear in both Nachtarbeit and Nacht 0–4 Uhr.
  const nNachtarbeit = n23 + n04;  // excludes the 00:00–04:00 bucket
  return {
    n23_00: n23,
    n00_04: n00,
    n04_06: n04,
    n_total: nNachtarbeit + n00,
    n_nachtarbeit: nNachtarbeit,
  };
}

function buildBlocks(
  trips: TripRow[],
  exceptions: Map<string, ExceptionRow>,
  issues: ValidationIssue[],
): ShiftBlock[] {
  // ── Step 1: build raw absolute intervals from every assigned trip ─────────
  // We no longer rely on assignment_block_id for grouping — trips without one
  // would be silently dropped, causing coverage failures.  Instead we derive
  // shift blocks from the actual ride times.
  interface RawInterval {
    tripId: string;
    driverId: string;
    driverName: string;
    vehicle: string;
    serviceDate: string;   // trip_date (billing date)
    startMs: number;
    endMs: number;
    blockId: string | null; // original assignment_block_id, kept for exception lookup
    assignmentSource: string;
  }

  const rawIntervals: RawInterval[] = [];
  for (const trip of trips) {
    if (!trip.assigned_driver_id) continue;
    if (!trip.start_time || !trip.end_time || !trip.trip_date) {
      issues.push({ type: 'block_missing_times', detailKey: 'stn.issue.tripMissingTime', detailVars: { tripId: trip.id } });
      continue;
    }
    const rw = resolveActualRideWindow({
      trip_date: trip.trip_date,
      start_time: trip.start_time,
      end_time: trip.end_time,
      raw_data_json: trip.raw_data_json,
    });
    const startMs = rw.actualStartMs > 0 ? rw.actualStartMs : parseTimestamp(trip.trip_date, trip.start_time);
    let endMs = rw.actualEndMs > 0 ? rw.actualEndMs : parseTimestamp(trip.trip_date, trip.end_time);
    if (endMs <= startMs) endMs += 24 * 60 * 60 * 1000;
    rawIntervals.push({
      tripId: trip.id,
      driverId: trip.assigned_driver_id,
      driverName: trip.assigned_driver_name?.trim() || `Fahrer ${trip.assigned_driver_id.slice(0, 8)}`,
      vehicle: trip.car_identifier ?? '',
      serviceDate: trip.trip_date,
      startMs,
      endMs,
      blockId: trip.assignment_block_id,
      assignmentSource: trip.assignment_source ?? 'auto',
    });
  }

  // ── Step 2: group by (driverId, serviceDate) ──────────────────────────────
  interface IntervalGroup {
    driverId: string;
    driverName: string;
    serviceDate: string;
    intervals: RawInterval[];
  }
  const groupMap = new Map<string, IntervalGroup>();
  for (const iv of rawIntervals) {
    const key = `${iv.driverId}|${iv.serviceDate}`;
    const g = groupMap.get(key) ?? {
      driverId: iv.driverId,
      driverName: iv.driverName,
      serviceDate: iv.serviceDate,
      intervals: [],
    };
    g.intervals.push(iv);
    groupMap.set(key, g);
  }

  // ── Step 3: within each group, sort and merge touching/overlapping intervals ─
  const blocks: ShiftBlock[] = [];

  for (const [, grp] of groupMap) {
    const sorted = [...grp.intervals].sort((a, b) => a.startMs - b.startMs);

    // Merge overlapping or touching (gap = 0) intervals into contiguous spans
    interface Span {
      startMs: number;
      endMs: number;
      tripIds: string[];
      blockIds: Set<string>;
      vehicles: string[];
      assignmentSource: string;
    }

    const spans: Span[] = [];
    for (const iv of sorted) {
      const last = spans[spans.length - 1];
      if (!last || iv.startMs > last.endMs) {
        spans.push({
          startMs: iv.startMs,
          endMs: iv.endMs,
          tripIds: [iv.tripId],
          blockIds: new Set(iv.blockId ? [iv.blockId] : []),
          vehicles: [iv.vehicle].filter(Boolean),
          assignmentSource: iv.assignmentSource,
        });
      } else {
        // Overlap or touching — extend the current span
        last.endMs = Math.max(last.endMs, iv.endMs);
        last.tripIds.push(iv.tripId);
        if (iv.blockId) last.blockIds.add(iv.blockId);
        if (iv.vehicle && !last.vehicles.includes(iv.vehicle)) last.vehicles.push(iv.vehicle);
      }
    }

    // ── Step 4: turn each span into a ShiftBlock ──────────────────────────────
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];

      // Choose a stable block_id from the original assignment_block_ids if any,
      // otherwise use a synthetic key.
      const blockIds = [...span.blockIds];
      const blockId = blockIds.length > 0 ? blockIds[0] : `syn_${grp.driverId}_${grp.serviceDate}_${i}`;
      const exc = blockIds.length > 0 ? exceptions.get(blockIds[0]) : undefined;

      const vehicle = span.vehicles.join(', ') || grp.intervals[0]?.vehicle || '';
      if (!vehicle) {
        issues.push({ type: 'block_missing_vehicle', detailKey: 'stn.issue.blockNoVehicle', detailVars: { blockId } });
      }

      const actualDurationMinutes = Math.floor((span.endMs - span.startMs) / 60000);
      if (actualDurationMinutes <= 0) {
        issues.push({ type: 'negative_duration', detailKey: 'stn.issue.blockBadDuration', detailVars: { blockId } });
        continue;
      }
      const paidDurationMinutes = Math.max(actualDurationMinutes, MIN_STUNDENNACHWEIS_SHIFT_MINUTES);
      const paidEndMs = span.startMs + paidDurationMinutes * 60000;
      const minimumApplied = paidDurationMinutes > actualDurationMinutes;

      const night = computeNightBuckets(span.startMs, paidEndMs);

      blocks.push({
        block_id: blockId,
        driver_id: grp.driverId,
        driver_name: grp.driverName,
        vehicle,
        service_date: grp.serviceDate,
        block_start_ms: span.startMs,
        block_end_ms: span.endMs,
        duration_minutes: actualDurationMinutes,
        paid_end_ms: paidEndMs,
        paid_duration_minutes: paidDurationMinutes,
        minimum_applied: minimumApplied,
        minimum_added_minutes: minimumApplied ? paidDurationMinutes - actualDurationMinutes : 0,
        trip_count: span.tripIds.length,
        assignment_source: span.assignmentSource,
        night_23_00: night.n23_00,
        night_00_04: night.n00_04,
        night_04_06: night.n04_06,
        nachtarbeit_minutes: night.n_nachtarbeit,
        nacht0bis4_minutes: night.n00_04,
        dienstzeit_exception: !!exc?.dienstzeit_exception,
        tageslimit_exception: !!exc?.tageslimit_exception,
        monatslimit_exception: !!exc?.monatslimit_exception,
        manual_exception: !!exc,
        exception_reason: exc?.reason ?? '',
      });
    }
  }

  blocks.sort((a, b) =>
    a.driver_name.localeCompare(b.driver_name) ||
    a.block_start_ms - b.block_start_ms,
  );
  return blocks;
}

const MAX_SCHICHTEN_PER_DAY = 3;

interface CompressionInfo {
  totalBefore: number;
  totalAfter: number;
  daysCompressed: Array<{ date: string; before: number; after: number }>;
}

function compressShiftBlocksPerDay(blocks: ShiftBlock[]): { blocks: ShiftBlock[]; compression: CompressionInfo } {
  const byDriverDate = new Map<string, ShiftBlock[]>();

  for (const b of blocks) {
    const key = `${b.driver_id}|${b.service_date}`;
    const arr = byDriverDate.get(key) ?? [];
    arr.push(b);
    byDriverDate.set(key, arr);
  }

  const compression: CompressionInfo = { totalBefore: blocks.length, totalAfter: 0, daysCompressed: [] };
  const result: ShiftBlock[] = [];

  for (const [, dayBlocks] of byDriverDate) {
    if (dayBlocks.length <= MAX_SCHICHTEN_PER_DAY) {
      result.push(...dayBlocks);
      compression.totalAfter += dayBlocks.length;
      continue;
    }

    const before = dayBlocks.length;
    dayBlocks.sort((a, b) => a.block_start_ms - b.block_start_ms);

    while (dayBlocks.length > MAX_SCHICHTEN_PER_DAY) {
      let bestIdx = -1;
      let bestGap = Infinity;
      for (let i = 0; i < dayBlocks.length - 1; i++) {
        const gap = dayBlocks[i + 1].block_start_ms - dayBlocks[i].block_end_ms;
        if (gap < bestGap) {
          bestGap = gap;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break;

      const a = dayBlocks[bestIdx];
      const b = dayBlocks[bestIdx + 1];
      const mergedActual = a.duration_minutes + b.duration_minutes;
      const mergedPaid   = a.paid_duration_minutes + b.paid_duration_minutes;
      const merged: ShiftBlock = {
        block_id: `${a.block_id}+${b.block_id}`,
        driver_id: a.driver_id,
        driver_name: a.driver_name,
        vehicle: [a.vehicle, b.vehicle].filter(Boolean).join(', '),
        service_date: a.service_date,
        block_start_ms: a.block_start_ms,
        block_end_ms: Math.max(a.block_end_ms, b.block_end_ms),
        duration_minutes: mergedActual,
        paid_end_ms: Math.max(a.paid_end_ms, b.paid_end_ms),
        paid_duration_minutes: mergedPaid,
        minimum_applied: a.minimum_applied || b.minimum_applied,
        minimum_added_minutes: a.minimum_added_minutes + b.minimum_added_minutes,
        trip_count: a.trip_count + b.trip_count,
        assignment_source: a.assignment_source,
        // Night buckets sum from both paid intervals (sequential, non-overlapping blocks)
        night_23_00: a.night_23_00 + b.night_23_00,
        night_00_04: a.night_00_04 + b.night_00_04,
        night_04_06: a.night_04_06 + b.night_04_06,
        nachtarbeit_minutes: a.nachtarbeit_minutes + b.nachtarbeit_minutes,
        nacht0bis4_minutes: a.nacht0bis4_minutes + b.nacht0bis4_minutes,
        dienstzeit_exception: a.dienstzeit_exception || b.dienstzeit_exception,
        tageslimit_exception: a.tageslimit_exception || b.tageslimit_exception,
        monatslimit_exception: a.monatslimit_exception || b.monatslimit_exception,
        manual_exception: a.manual_exception || b.manual_exception,
        exception_reason: [a.exception_reason, b.exception_reason].filter(Boolean).join('; '),
      };
      dayBlocks.splice(bestIdx, 2, merged);
    }

    result.push(...dayBlocks);
    compression.totalAfter += dayBlocks.length;
    compression.daysCompressed.push({ date: dayBlocks[0].service_date, before, after: dayBlocks.length });
  }

  result.sort((a, b) => a.driver_name.localeCompare(b.driver_name) || a.block_start_ms - b.block_start_ms);
  return { blocks: result, compression };
}

function isSundayLocal(serviceDate: string): boolean {
  const d = new Date(`${serviceDate}T12:00`);
  return d.getDay() === 0;
}

function calcExpectedBrutto(shifts: ShiftBlock[], hourlyRate: number | null, bundesland?: string | null): number | null {
  if (hourlyRate == null || hourlyRate <= 0) return null;
  let cents = 0;
  for (const s of shifts) {
    // Split at midnight so sunday/holiday premiums apply to the correct date
    for (const seg of splitBlockForDisplay(s)) {
      cents += (seg.seg_minutes * hourlyRate * 100) / 60;
      cents += (seg.nachtarbeit_minutes * hourlyRate * 100 * PREM_NIGHT) / 60;
      if (isSundayLocal(seg.display_date)) {
        cents += (seg.seg_minutes * hourlyRate * 100 * PREM_SUN) / 60;
      }
      if (isHoliday(seg.display_date, bundesland)) {
        cents += (seg.seg_minutes * hourlyRate * 100 * PREM_HOLIDAY) / 60;
      }
    }
  }
  return Math.round(cents) / 100;
}

function groupByDriver(blocks: ShiftBlock[], wageMap: Map<string, DriverWage>, bundesland?: string | null): DriverGroup[] {
  const map = new Map<string, DriverGroup>();
  for (const b of blocks) {
    const g = map.get(b.driver_id) ?? {
      driver_id: b.driver_id,
      driver_name: b.driver_name,
      shifts: [],
      trips: 0,
      total_minutes: 0,
      work_days: 0,
      night_23_00: 0,
      night_00_04: 0,
      night_04_06: 0,
      night_total: 0,
      nachtarbeit_minutes: 0,
      nacht0bis4_minutes: 0,
      sunday_minutes: 0,
      holiday_minutes: 0,
      manual_exceptions: 0,
      dienstzeit_exceptions: 0,
      tageslimit_exceptions: 0,
      monatslimit_exceptions: 0,
      hourly_rate: null,
      target_salary: null,
      min_salary: null,
      max_salary: null,
      expected_brutto: null,
      personalnummer: null as string | null,
    };
    g.shifts.push(b);
    g.trips += b.trip_count;
    g.total_minutes += b.paid_duration_minutes;
    g.night_23_00 += b.night_23_00;
    g.night_00_04 += b.night_00_04;
    g.night_04_06 += b.night_04_06;
    g.nachtarbeit_minutes += b.nachtarbeit_minutes;
    g.nacht0bis4_minutes  += b.nacht0bis4_minutes;
    // Use split segments so sunday/holiday minutes are assigned to the correct date
    for (const seg of splitBlockForDisplay(b)) {
      if (isSundayLocal(seg.display_date)) g.sunday_minutes += seg.seg_minutes;
      if (isHoliday(seg.display_date, bundesland)) g.holiday_minutes += seg.seg_minutes;
    }
    if (b.manual_exception) g.manual_exceptions++;
    if (b.dienstzeit_exception) g.dienstzeit_exceptions++;
    if (b.tageslimit_exception) g.tageslimit_exceptions++;
    if (b.monatslimit_exception) g.monatslimit_exceptions++;
    map.set(b.driver_id, g);
  }
  for (const g of map.values()) {
    const dates = new Set(g.shifts.map(s => s.service_date));
    g.work_days = dates.size;
    g.shifts.sort((a, b) => a.block_start_ms - b.block_start_ms);
    g.night_total = g.night_23_00 + g.night_00_04 + g.night_04_06;
    const wage = wageMap.get(g.driver_id);
    g.hourly_rate = wage?.planning_hourly_rate ?? null;
    g.target_salary = wage?.planning_target_salary ?? null;
    g.min_salary = wage?.planning_min_salary ?? wage?.planning_target_salary ?? null;
    g.max_salary = wage?.planning_max_salary ?? wage?.planning_target_salary ?? null;
    g.expected_brutto = calcExpectedBrutto(g.shifts, g.hourly_rate, bundesland);
    g.personalnummer = wage?.personalnummer ?? null;
  }
  return [...map.values()].sort((a, b) => a.driver_name.localeCompare(b.driver_name));
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso: string): string {
  return new Date(`${iso}T00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function fmtDuration(min: number): string {
  if (min <= 0) return '0:00 h';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}:${String(m).padStart(2, '0')} h`;
}
function fmtHours(min: number): string {
  return (min / 60).toFixed(2).replace('.', ',') + ' h';
}
function fmtEuro(v: number | null): string {
  if (v == null) return '—';
  return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

// ── HH:MM formatter for PdfDayRow ───────────────────────────────────────────

function minsToHHMM(m: number): string {
  if (m <= 0) return '';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function isHoliday(dateStr: string, bundesland?: string | null): boolean {
  return isPublicHoliday(dateStr, bundesland);
}

// ── Cross-midnight split ───────────────────────────────────────────────────────
// A DisplaySegment represents one calendar-day slice of a ShiftBlock for
// Stundennachweis display, PDF, and daily totals.  The original ShiftBlock is
// never mutated — this is purely a presentation layer.

interface DisplaySegment {
  // Which block this segment came from
  block_id: string;
  driver_id: string;
  vehicle: string;
  // Calendar date this segment belongs to (YYYY-MM-DD)
  display_date: string;
  // Inclusive timestamps of this slice [segStartMs, segEndMs)
  seg_start_ms: number;
  seg_end_ms: number;
  // Duration of this slice in minutes
  seg_minutes: number;
  // Night buckets for this slice only
  nachtarbeit_minutes: number;
  nacht0bis4_minutes: number;
  // Whether minimum-shift-duration was applied to the original block
  minimum_applied: boolean;
  // Display strings (HH:MM, no + suffix)
  display_start: string;  // HH:MM
  display_end: string;    // HH:MM  (23:59 for pre-midnight slice, actual for last slice)
  // Exception flags forwarded from the original block
  manual_exception: boolean;
  dienstzeit_exception: boolean;
  tageslimit_exception: boolean;
  monatslimit_exception: boolean;
}

// Local HH:MM string from a millisecond timestamp (no date part).
function msToHHMM(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// Local midnight (00:00:00.000) of the calendar day containing `ms`.
function localMidnightOf(ms: number): number {
  return localMidnightMs(ms);
}

// Split a ShiftBlock at calendar-day boundaries for Stundennachweis display.
// Returns one DisplaySegment per calendar day touched by [startMs, endMs).
// The minimum-shift rule is applied to the FIRST segment only (same as the
// original behavior — the paid extension is always on the start day).
function splitBlockForDisplay(block: ShiftBlock): DisplaySegment[] {
  const startMs = block.block_start_ms;
  const endMs   = block.paid_end_ms;   // use paid end so minimum-rule is respected

  const segments: DisplaySegment[] = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const midnightNext = nextLocalMidnightMs(localMidnightOf(cursor));
    const sliceEnd = Math.min(endMs, midnightNext);

    const dateStr = localDateString(cursor);
    const segMinutes = Math.floor((sliceEnd - cursor) / 60000);

    // Night buckets for this slice only
    const nb = computeNightBuckets(cursor, sliceEnd);

    // Display end: if the slice ends exactly at midnight, show 23:59 for the
    // previous day (the actual midnight minute is assigned to the next day's
    // 00:00 start, so no minutes are lost in the total).
    const isLastSlice = sliceEnd >= endMs;
    const endsAtMidnight = sliceEnd === midnightNext && !isLastSlice;
    const displayEnd = endsAtMidnight ? '23:59' : msToHHMM(sliceEnd);

    segments.push({
      block_id:             block.block_id,
      driver_id:            block.driver_id,
      vehicle:              block.vehicle,
      display_date:         dateStr,
      seg_start_ms:         cursor,
      seg_end_ms:           sliceEnd,
      seg_minutes:          segMinutes,
      nachtarbeit_minutes:  nb.n_nachtarbeit,
      nacht0bis4_minutes:   nb.n00_04,
      minimum_applied:      block.minimum_applied,
      display_start:        msToHHMM(cursor),
      display_end:          displayEnd,
      manual_exception:     block.manual_exception,
      dienstzeit_exception: block.dienstzeit_exception,
      tageslimit_exception: block.tageslimit_exception,
      monatslimit_exception: block.monatslimit_exception,
    });

    cursor = sliceEnd;
  }

  return segments;
}

/**
 * Merge overlapping/touching DisplaySegments from multiple source ShiftBlocks
 * that land on the same calendar day, then compress to ≤ MAX_SCHICHTEN_PER_DAY
 * using the smallest-gap algorithm.
 *
 * Night-bucket and minute values are recomputed from the merged timestamps so
 * they are always consistent with the merged interval.
 */
function mergeAndCompressDisplaySegments(segments: DisplaySegment[]): DisplaySegment[] {
  if (segments.length === 0) return [];
  if (segments.length === 1) return segments;

  // Sort by start time
  const sorted = [...segments].sort((a, b) => a.seg_start_ms - b.seg_start_ms);

  // Step 1: merge overlapping / touching intervals
  interface MergedSeg {
    startMs: number;
    endMs: number;
    // carry over metadata from first constituent segment
    block_id: string;
    driver_id: string;
    vehicle: string;
    display_date: string;
    minimum_applied: boolean;
    manual_exception: boolean;
    dienstzeit_exception: boolean;
    tageslimit_exception: boolean;
    monatslimit_exception: boolean;
  }
  const merged: MergedSeg[] = [];
  for (const seg of sorted) {
    const last = merged[merged.length - 1];
    if (!last || seg.seg_start_ms > last.endMs) {
      merged.push({
        startMs: seg.seg_start_ms,
        endMs: seg.seg_end_ms,
        block_id: seg.block_id,
        driver_id: seg.driver_id,
        vehicle: seg.vehicle,
        display_date: seg.display_date,
        minimum_applied: seg.minimum_applied,
        manual_exception: seg.manual_exception,
        dienstzeit_exception: seg.dienstzeit_exception,
        tageslimit_exception: seg.tageslimit_exception,
        monatslimit_exception: seg.monatslimit_exception,
      });
    } else {
      last.endMs = Math.max(last.endMs, seg.seg_end_ms);
      last.minimum_applied = last.minimum_applied || seg.minimum_applied;
      last.manual_exception = last.manual_exception || seg.manual_exception;
      last.dienstzeit_exception = last.dienstzeit_exception || seg.dienstzeit_exception;
      last.tageslimit_exception = last.tageslimit_exception || seg.tageslimit_exception;
      last.monatslimit_exception = last.monatslimit_exception || seg.monatslimit_exception;
    }
  }

  // Step 2: smallest-gap compression to ≤ MAX_SCHICHTEN_PER_DAY
  while (merged.length > MAX_SCHICHTEN_PER_DAY) {
    let bestIdx = -1;
    let bestGap = Infinity;
    for (let i = 0; i < merged.length - 1; i++) {
      const gap = merged[i + 1].startMs - merged[i].endMs;
      if (gap < bestGap) { bestGap = gap; bestIdx = i; }
    }
    if (bestIdx === -1) break;
    const a = merged[bestIdx];
    const b = merged[bestIdx + 1];
    merged[bestIdx] = {
      ...a,
      endMs: Math.max(a.endMs, b.endMs),
      minimum_applied: a.minimum_applied || b.minimum_applied,
      manual_exception: a.manual_exception || b.manual_exception,
      dienstzeit_exception: a.dienstzeit_exception || b.dienstzeit_exception,
      tageslimit_exception: a.tageslimit_exception || b.tageslimit_exception,
      monatslimit_exception: a.monatslimit_exception || b.monatslimit_exception,
    };
    merged.splice(bestIdx + 1, 1);
  }

  // Step 3: convert back to DisplaySegment (recompute minutes + night buckets
  // from the actual merged timestamps for accuracy)
  return merged.map((m): DisplaySegment => {
    const night = computeNightBuckets(m.startMs, m.endMs);
    const endsAtMidnight =
      m.endMs === nextLocalMidnightMs(localMidnightOf(m.startMs));
    const displayEnd = endsAtMidnight ? '23:59' : msToHHMM(m.endMs);
    return {
      block_id:             m.block_id,
      driver_id:            m.driver_id,
      vehicle:              m.vehicle,
      display_date:         m.display_date,
      seg_start_ms:         m.startMs,
      seg_end_ms:           m.endMs,
      seg_minutes:          Math.floor((m.endMs - m.startMs) / 60000),
      nachtarbeit_minutes:  night.n_nachtarbeit,
      nacht0bis4_minutes:   night.n00_04,
      minimum_applied:      m.minimum_applied,
      display_start:        msToHHMM(m.startMs),
      display_end:          displayEnd,
      manual_exception:     m.manual_exception,
      dienstzeit_exception: m.dienstzeit_exception,
      tageslimit_exception: m.tageslimit_exception,
      monatslimit_exception: m.monatslimit_exception,
    };
  });
}

/**
 * Convert display segments for a single calendar day into a PdfDayRow.
 * Up to 3 segments → Schicht 1–3 von/bis columns.
 * Each segment is already clipped to its calendar day — no + suffix needed.
 */
function buildPdfDayRow(date: Date, segments: DisplaySegment[], bundesland?: string | null): PdfDayRow {
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const dow = date.getDay();
  const isSat = dow === 6;
  const isSun = dow === 0;
  const isHol = isHoliday(dateStr, bundesland);
  const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const weekday = WEEKDAY_SHORT[dow];

  // Segments have already been merged + compressed to ≤3 in buildPdfRows.
  const sorted = [...segments].sort((a, b) => a.seg_start_ms - b.seg_start_ms);

  const von1 = sorted[0] ? sorted[0].display_start : '';
  const bis1 = sorted[0] ? sorted[0].display_end   : '';
  const von2 = sorted[1] ? sorted[1].display_start : '';
  const bis2 = sorted[1] ? sorted[1].display_end   : '';
  const von3 = sorted[2] ? sorted[2].display_start : '';
  const bis3 = sorted[2] ? sorted[2].display_end   : '';

  const totalMin       = segments.reduce((s, x) => s + x.seg_minutes, 0);
  const nachtarbeitMin = segments.reduce((s, x) => s + x.nachtarbeit_minutes, 0);
  const nacht0bis4Min  = segments.reduce((s, x) => s + x.nacht0bis4_minutes, 0);
  const sunMin  = isSun && !isHol ? totalMin : 0;
  const holMin  = isHol ? totalMin : 0;
  const isXmas =
    (date.getMonth() === 11 && (date.getDate() === 25 || date.getDate() === 26)) ||
    (date.getMonth() === 4  && date.getDate() === 1);
  const xmasMin = isXmas && totalMin > 0 ? totalMin : 0;
  const hasMinimumAdjustment = segments.some(s => s.minimum_applied);

  return {
    date,
    weekday,
    isSat,
    isSun,
    isHol,
    von1, bis1, von2, bis2, von3, bis3,
    grundlohn:     minsToHHMM(totalMin),
    nachtarbeit:   minsToHHMM(nachtarbeitMin),
    nachtarbeit04: minsToHHMM(nacht0bis4Min),
    sonntag:       minsToHHMM(sunMin),
    feiertag:      minsToHHMM(holMin),
    weihnachten:   minsToHHMM(xmasMin),
    hasMinimumAdjustment,
  };
}

function minsFromHHMM(s: string): number {
  if (!s) return 0;
  const m = /^(\d+):(\d{2})/.exec(s);
  return m ? +m[1] * 60 + +m[2] : 0;
}

function buildPdfRows(group: DriverGroup, month: number, year: number, bundesland?: string | null): { rows: PdfDayRow[]; totals: PdfTotals } {
  // Split every ShiftBlock at calendar-day boundaries and group by display_date.
  const byDate = new Map<string, DisplaySegment[]>();
  for (const s of group.shifts) {
    for (const seg of splitBlockForDisplay(s)) {
      const arr = byDate.get(seg.display_date) ?? [];
      arr.push(seg);
      byDate.set(seg.display_date, arr);
    }
  }

  const rows: PdfDayRow[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month - 1, d);
    const key = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const rawSegs = byDate.get(key) ?? [];
    // Merge overlapping/touching segments from different source blocks that land
    // on the same calendar day (e.g. a cross-midnight block from service_date=D-1
    // and a block from service_date=D both contribute segments to display_date=D).
    const merged = mergeAndCompressDisplaySegments(rawSegs);
    rows.push(buildPdfDayRow(date, merged, bundesland));
  }

  const totals: PdfTotals = {
    grundlohn:   rows.reduce((s, r) => s + minsFromHHMM(r.grundlohn), 0),
    nachtarbeit: rows.reduce((s, r) => s + minsFromHHMM(r.nachtarbeit), 0),
    nacht04:     rows.reduce((s, r) => s + minsFromHHMM(r.nachtarbeit04), 0),
    sonntag:     rows.reduce((s, r) => s + minsFromHHMM(r.sonntag), 0),
    feiertag:    rows.reduce((s, r) => s + minsFromHHMM(r.feiertag), 0),
    weihnachten: rows.reduce((s, r) => s + minsFromHHMM(r.weihnachten), 0),
  };

  return { rows, totals };
}

function exportDriverPdf(group: DriverGroup, month: number, year: number, bundesland: string | null | undefined, simulated: boolean): void {
  const { rows, totals } = buildPdfRows(group, month, year, bundesland);
  const MONTHS_DE_PDF = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  exportStundennachweisAsPdf(
    { driver: { name: group.driver_name }, month, year, rows, totals, simulated },
    `Stundennachweis_${group.driver_name.replace(/\s+/g, '_')}_${MONTHS_DE_PDF[month - 1]}_${year}`,
  );
}

/**
 * Audit-trail workbook for the Steuerberater. Every sheet name, header and
 * warning label in here stays German in both UI languages — the export is a
 * record, not a screen, and it has to read the same whoever produced it.
 */
function buildPruefExportXlsx(
  driverGroups: DriverGroup[],
  trips: TripRow[],
  month: number,
  year: number,
  simulated: boolean,
): void {
  const wb = XLSX.utils.book_new();
  const pad2 = (n: number) => String(n).padStart(2, '0');

  const fmtMs = (ms: number) => {
    const d = new Date(ms);
    return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const fmtMsTime = (ms: number) => {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };

  // ── Sheet A: Schichten ────────────────────────────────────────────────────
  const shiftHeaders = [
    'Fahrer', 'Service-Datum',
    'Tatsächlicher Start', 'Tatsächliches Ende', 'Tatsächliche Dauer Min',
    'Bezahlter Start', 'Bezahltes Ende', 'Bezahlte Dauer Min',
    'Mindest-Schichtdauer angewendet', 'Zusätzliche Minuten durch Mindest-Schichtdauer',
    'Kennzeichen', 'Fahrten', 'Quelle',
    'Nacht 23–00 Min', 'Nacht 00–04 Min', 'Nacht 04–06 Min',
    'PDF Nachtarbeit Min', 'PDF Nacht 0–4 Min',
    'Nachtarbeit Anzeige', 'Nacht 0–4 Anzeige',
    'Ausnahme',
  ];
  const shiftRows: (string | number)[][] = [shiftHeaders];
  const warnings: string[][] = [['Warnung', 'Fahrer', 'Service-Datum', 'Detail']];

  for (const g of driverGroups) {
    for (const s of g.shifts) {
      const actualEndSameDay = new Date(s.block_end_ms).toDateString() === new Date(`${s.service_date}T12:00`).toDateString();
      const paidEndSameDay   = new Date(s.paid_end_ms).toDateString()  === new Date(`${s.service_date}T12:00`).toDateString();
      const excLabel = [
        s.dienstzeit_exception ? 'Dienstzeit' : '',
        s.tageslimit_exception ? 'Tageslimit' : '',
        s.monatslimit_exception ? 'Monatslimit' : '',
      ].filter(Boolean).join(', ') || (s.manual_exception ? 'Manuell' : '—');

      const pdfNachtarbeitMin = s.nachtarbeit_minutes;
      const pdfNacht0bis4Min  = s.nacht0bis4_minutes;
      const nachtarbeitAnz    = minsToHHMM(pdfNachtarbeitMin);
      const nacht0bis4Anz     = minsToHHMM(pdfNacht0bis4Min);

      shiftRows.push([
        g.driver_name,
        s.service_date,
        fmtMs(s.block_start_ms),
        `${fmtMs(s.block_end_ms)}${actualEndSameDay ? '' : ' +1d'}`,
        s.duration_minutes,
        fmtMs(s.block_start_ms),
        `${fmtMs(s.paid_end_ms)}${paidEndSameDay ? '' : ' +1d'}`,
        s.paid_duration_minutes,
        s.minimum_applied ? 'Ja' : 'Nein',
        s.minimum_added_minutes,
        s.vehicle || '—',
        s.trip_count,
        s.assignment_source,
        s.night_23_00,
        s.night_00_04,
        s.night_04_06,
        pdfNachtarbeitMin,
        pdfNacht0bis4Min,
        nachtarbeitAnz || '—',
        nacht0bis4Anz  || '—',
        excLabel,
      ]);

      // ── Mindest-Schichtdauer audit warnings ──────────────────────────────
      if (s.minimum_applied) {
        warnings.push([
          'Mindest-Schichtdauer angewendet',
          g.driver_name,
          s.service_date,
          `Block ${s.block_id}: Ist ${s.duration_minutes} Min. (${fmtMsTime(s.block_start_ms)}–${fmtMsTime(s.block_end_ms)})`
          + ` → Bezahlt ${s.paid_duration_minutes} Min. (${fmtMsTime(s.block_start_ms)}–${fmtMsTime(s.paid_end_ms)})`
          + ` · +${s.minimum_added_minutes} Min. · ${s.vehicle || '—'} · ${s.trip_count} Fahrt(en)`,
        ]);
      }

      // ── Night consistency warnings ────────────────────────────────────────
      if (s.paid_duration_minutes <= 0) {
        warnings.push(['Bezahlte Dauer <= 0', g.driver_name, s.service_date, `Block ${s.block_id}: ${s.paid_duration_minutes} Min`]);
      }
      if (s.paid_duration_minutes > 12 * 60) {
        warnings.push(['Bezahlte Dauer > 12h', g.driver_name, s.service_date, `Block ${s.block_id}: ${fmtDuration(s.paid_duration_minutes)}`]);
      }
      if (!s.vehicle) {
        warnings.push(['Kennzeichen fehlt', g.driver_name, s.service_date, `Block ${s.block_id}`]);
      }
      if (s.night_23_00 < 0 || s.night_00_04 < 0 || s.night_04_06 < 0) {
        warnings.push(['Negatives Nachtbucket', g.driver_name, s.service_date, `Block ${s.block_id}: 23–00=${s.night_23_00} 00–04=${s.night_00_04} 04–06=${s.night_04_06}`]);
      }
      const bucketSum = s.night_23_00 + s.night_00_04 + s.night_04_06;
      if (pdfNachtarbeitMin !== bucketSum) {
        warnings.push(['Nachtarbeit Inkonsistenz', g.driver_name, s.service_date, `Block ${s.block_id}: PDF Nachtarbeit ${pdfNachtarbeitMin} ≠ 23–00+00–04+04–06 ${bucketSum}`]);
      }
      if (pdfNacht0bis4Min !== s.night_00_04) {
        warnings.push(['Nacht 0–4 Inkonsistenz', g.driver_name, s.service_date, `Block ${s.block_id}: PDF Nacht0–4 ${pdfNacht0bis4Min} ≠ 00–04 ${s.night_00_04}`]);
      }
      if (pdfNachtarbeitMin > s.paid_duration_minutes) {
        warnings.push(['Nachtarbeit > Schichtdauer', g.driver_name, s.service_date, `Block ${s.block_id}: ${pdfNachtarbeitMin} Min > ${s.paid_duration_minutes} Min`]);
      }
      if (s.minimum_added_minutes < 0) {
        warnings.push(['Negative Mindest-Minuten', g.driver_name, s.service_date, `Block ${s.block_id}: minimum_added_minutes=${s.minimum_added_minutes}`]);
      }
    }

    // Check max 3 Schichten per day
    const byDay = new Map<string, number>();
    for (const s of g.shifts) {
      byDay.set(s.service_date, (byDay.get(s.service_date) ?? 0) + 1);
    }
    for (const [date, count] of byDay) {
      if (count > 3) {
        warnings.push(['> 3 Schichten/Tag', g.driver_name, date, `${count} Schichten nach Komprimierung`]);
      }
    }
  }

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(shiftRows), 'Schichten');

  // ── Sheet B: Fahrten ─────────────────────────────────────────────────────
  const tripHeaders = [
    'Fahrer', 'Service-Datum', 'Kennzeichen',
    'Tatsächlicher Fahrtbeginn', 'Tatsächliches Fahrtende',
    'Anzeige Start', 'Anzeige Ende',
    'Trip ID', 'assignment_block_id',
    'Original Fahrer', 'Zugewiesener Fahrer', 'Storniert',
  ];
  const tripRows: (string | number | boolean)[][] = [tripHeaders];

  for (const trip of trips) {
    const rw = resolveActualRideWindow({
      trip_date: trip.trip_date,
      start_time: trip.start_time,
      end_time: trip.end_time,
      raw_data_json: trip.raw_data_json,
    });
    const actualStart = rw.actualStartMs > 0 ? fmtMs(rw.actualStartMs) : '—';
    const actualEnd   = rw.actualEndMs   > 0 ? fmtMs(rw.actualEndMs)   : '—';
    const dispStart   = rw.displayStart || trip.start_time || '—';
    const dispEnd     = rw.displayEnd   || trip.end_time   || '—';

    tripRows.push([
      trip.assigned_driver_name || '—',
      trip.trip_date,
      trip.car_identifier || '—',
      actualStart,
      actualEnd,
      dispStart,
      dispEnd,
      trip.id,
      trip.assignment_block_id || '—',
      '—',
      trip.assigned_driver_name || '—',
      trip.is_canceled ? 'Ja' : 'Nein',
    ]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tripRows), 'Fahrten');

  // ── Sheet C: Monatssummen ─────────────────────────────────────────────────
  const sumHeaders = [
    'Fahrer', 'Schichten', 'Fahrten', 'Arbeitstage',
    'Arbeitsstunden', 'Stundensatz',
    'Grundlohn €',
    'Nachtarbeit h', 'Nachtzuschlag 40% €',
    'Sonntag h', 'Sonntagszuschlag 50% €',
    'Feiertag/1. Mai h', 'Feiertagszuschlag 125% €',
    'Brutto (ohne Ausgleich) €', 'Ausgleich €', 'Brutto erwartet €',
    'Mindestgehalt €', 'Maximalgehalt €',
  ];
  const sumRows: (string | number | null)[][] = [sumHeaders];
  for (const g of driverGroups) {
    const rate = g.hourly_rate ?? null;
    const arbStd = Math.round(g.total_minutes / 60 * 100) / 100;
    const grundlohnEur  = rate != null ? Math.round(g.total_minutes / 60 * rate * 100) / 100 : null;
    const nachtStd      = Math.round(g.nachtarbeit_minutes / 60 * 100) / 100;
    const nachtZuschlag = rate != null ? Math.round(g.nachtarbeit_minutes / 60 * rate * PREM_NIGHT * 100) / 100 : null;
    const sonntagStd    = Math.round(g.sunday_minutes / 60 * 100) / 100;
    const sonnZuschlag  = rate != null ? Math.round(g.sunday_minutes / 60 * rate * PREM_SUN * 100) / 100 : null;
    const feierStd      = Math.round(g.holiday_minutes / 60 * 100) / 100;
    const feierZuschlag = rate != null ? Math.round(g.holiday_minutes / 60 * rate * PREM_HOLIDAY * 100) / 100 : null;
    const bruttoBase    = grundlohnEur != null && nachtZuschlag != null && sonnZuschlag != null && feierZuschlag != null
      ? Math.round((grundlohnEur + nachtZuschlag + sonnZuschlag + feierZuschlag) * 100) / 100
      : null;
    const ausgleich     = (g as DriverGroup & { ausgleich_amount?: number }).ausgleich_amount ?? 0;
    const bruttoTotal   = bruttoBase != null ? Math.round((bruttoBase + ausgleich) * 100) / 100 : null;

    // Warnings for salary calculation issues
    if (g.holiday_minutes > 0 && feierZuschlag === 0) {
      warnings.push(['Feiertagszuschlag fehlt', g.driver_name, '', `${feierStd} h Feiertagsarbeit aber Zuschlag = 0`]);
    }
    if (bruttoTotal != null && g.expected_brutto != null && Math.abs(bruttoTotal - g.expected_brutto) > 0.05) {
      warnings.push(['Brutto Inkonsistenz', g.driver_name, '', `Komponenten-Summe ${bruttoTotal} € ≠ Brutto erwartet ${g.expected_brutto} €`]);
    }
    if (grundlohnEur != null && grundlohnEur < 0) {
      warnings.push(['Negatives Grundlohn', g.driver_name, '', `${grundlohnEur} €`]);
    }
    if (nachtZuschlag != null && nachtZuschlag < 0) {
      warnings.push(['Negativer Nachtzuschlag', g.driver_name, '', `${nachtZuschlag} €`]);
    }

    sumRows.push([
      g.driver_name,
      g.shifts.length,
      g.trips,
      g.work_days,
      arbStd,
      rate ?? '—',
      grundlohnEur ?? '—',
      nachtStd,
      nachtZuschlag ?? '—',
      sonntagStd,
      sonnZuschlag ?? '—',
      feierStd,
      feierZuschlag ?? '—',
      bruttoBase ?? '—',
      ausgleich > 0 ? ausgleich : '—',
      g.expected_brutto ?? '—',
      g.min_salary ?? '—',
      g.max_salary ?? '—',
    ]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sumRows), 'Monatssummen');

  // ── Sheet D: Warnungen ────────────────────────────────────────────────────
  if (warnings.length === 1) warnings.push(['(keine Warnungen)', '', '', '']);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(warnings), 'Warnungen');

  const MONTHS_XLSX = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  writeMarkedWorkbook(wb, `Stundennachweis_Pruefexport_${MONTHS_XLSX[month - 1]}_${year}.xlsx`, simulated);
}

function MonatsplanungStundennachweisPreview({ run, onClose, onTransferApplied }: Props) {
  const { t, tPlural } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [trips, setTrips] = useState<TripRow[]>([]);
  // The trips decide: a document with any simulated ride behind it says so.
  const simulated = trips.some(trip => trip.is_simulated === true);
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([]);
  const [wages, setWages] = useState<DriverWage[]>([]);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [adjustments, setAdjustments] = useState<AdjustmentRecord[]>([]);
  const [companyBundesland, setCompanyBundesland] = useState<string | null>(null);  const [selectedDriverId, setSelectedDriverId] = useState<string>('__all__');
  const [expandedDrivers, setExpandedDrivers] = useState<Set<string>>(new Set());
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [expandedAllShifts, setExpandedAllShifts] = useState<Set<string>>(new Set());
  const [expectedTripCount, setExpectedTripCount] = useState<number | null>(null);
  const [pdfExporting, setPdfExporting] = useState(false);
  const [xlsxExporting, setXlsxExporting] = useState(false);
  const [fahrtenbuchExporting, setFahrtenbuchExporting] = useState(false);
  const [fahreruebersichtExporting, setFahreruebersichtExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [selectedPdfDriverIds, setSelectedPdfDriverIds] = useState<Set<string>>(new Set());
  const [showPdfDriverSelect, setShowPdfDriverSelect] = useState(false);
  const [savingStundennachweise, setSavingStundennachweise] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccessCount, setSaveSuccessCount] = useState(0);
  const [debug, setDebug] = useState<{
    planning_run_id: string;
    planning_run_status: string | null;
    planning_run_query_error: string | null;
    trips_query_error: string | null;
    manual_exceptions_query_error: string | null;
    loaded_trips: number | null;
    trips_after_cancel_filter: number | null;
    rows_missing_block_id: number | null;
    distinct_block_ids: number | null;
    distinct_drivers: number | null;
    expected_trips: number | null;
    selected_run_company_id_prop: string | null;
    db_company_id: string | null;
    trips_count_with_company_filter: number | null;
    trips_count_without_company_filter: number | null;
    query_table_planning_run: string;
    query_table_trips: string;
  }>({
    planning_run_id: run.id,
    planning_run_status: null,
    planning_run_query_error: null,
    trips_query_error: null,
    manual_exceptions_query_error: null,
    loaded_trips: null,
    trips_after_cancel_filter: null,
    rows_missing_block_id: null,
    distinct_block_ids: null,
    distinct_drivers: null,
    expected_trips: null,
    selected_run_company_id_prop: run.company_id ?? null,
    db_company_id: null,
    trips_count_with_company_filter: null,
    trips_count_without_company_filter: null,
    query_table_planning_run: 'company_planning_runs',
    query_table_trips: 'fahrtenbuch_trips',
  });

  const fmtPgErr = (e: unknown): string => {
    if (!e) return '';
    if (typeof e === 'object') {
      const o = e as { message?: string; details?: string; hint?: string; code?: string };
      return [o.message, o.details, o.hint, o.code].filter(Boolean).join(' | ');
    }
    return String(e);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setIssues([]);
    setTrips([]);
    setExceptions([]);
    setWages([]);
    setAdjustments([]);
    setCompanyBundesland(null);

    const dbg = {
      planning_run_id: run.id,
      planning_run_status: null as string | null,
      planning_run_query_error: null as string | null,
      trips_query_error: null as string | null,
      manual_exceptions_query_error: null as string | null,
      loaded_trips: null as number | null,
      trips_after_cancel_filter: null as number | null,
      rows_missing_block_id: null as number | null,
      distinct_block_ids: null as number | null,
      distinct_drivers: null as number | null,
      expected_trips: null as number | null,
      selected_run_company_id_prop: run.company_id ?? null,
      db_company_id: null as string | null,
      trips_count_with_company_filter: null as number | null,
      trips_count_without_company_filter: null as number | null,
      query_table_planning_run: 'company_planning_runs',
      query_table_trips: 'fahrtenbuch_trips',
    };

    try {
      // 1. Load planning run from the canonical table (company_planning_runs).
      //    company_id may be missing on the prop — always trust the DB row.
      const { data: runRow, error: runErr } = await supabase
        .from('company_planning_runs')
        .select('id, company_id, status, apply_summary_json, month, year')
        .eq('id', run.id)
        .maybeSingle();

      if (runErr) {
        dbg.planning_run_query_error = fmtPgErr(runErr);
        setDebug(dbg);
        setError(t('stn.err.runQuery', { detail: dbg.planning_run_query_error }));
        return;
      }
      if (!runRow) {
        dbg.planning_run_query_error = 'NOT FOUND in company_planning_runs';
        setDebug(dbg);
        setIssues([{ type: 'run_missing', detailKey: 'stn.issue.runMissing', detailVars: { runId: run.id } }]);
        return;
      }

      dbg.planning_run_status = String(runRow.status ?? '');
      dbg.db_company_id = (runRow.company_id as string | null) ?? null;
      const apply = (runRow.apply_summary_json as Record<string, unknown> | null) ?? null;
      const exp = apply && typeof apply['updated_trips'] === 'number' ? (apply['updated_trips'] as number) : null;
      dbg.expected_trips = exp;
      setExpectedTripCount(exp);

      if (dbg.planning_run_status !== 'applied') {
        setDebug(dbg);
        setIssues([{ type: 'wrong_status', detailKey: 'stn.issue.wrongStatus', detailVars: { status: dbg.planning_run_status } }]);
        return;
      }

      const effectiveCompanyId = dbg.db_company_id || dbg.selected_run_company_id_prop;
      if (!effectiveCompanyId) {
        setDebug(dbg);
        setError(t('stn.err.runNoCompany'));
        return;
      }

      // 2a. Diagnostic: trips count WITHOUT company filter
      const { count: countNoCo, error: countNoCoErr } = await supabase
        .from('fahrtenbuch_trips')
        .select('id', { count: 'exact', head: true })
        .eq('assignment_planning_run_id', run.id);
      if (countNoCoErr) {
        dbg.trips_query_error = `(count w/o company) ${fmtPgErr(countNoCoErr)}`;
      } else {
        dbg.trips_count_without_company_filter = countNoCo ?? 0;
      }

      // 2b. Diagnostic: trips count WITH company filter
      const { count: countWithCo, error: countWithCoErr } = await supabase
        .from('fahrtenbuch_trips')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', effectiveCompanyId)
        .eq('assignment_planning_run_id', run.id);
      if (countWithCoErr && !dbg.trips_query_error) {
        dbg.trips_query_error = `(count w/ company) ${fmtPgErr(countWithCoErr)}`;
      } else if (!countWithCoErr) {
        dbg.trips_count_with_company_filter = countWithCo ?? 0;
      }

      // 2c. Choose effective company filter — fall back to no-company filter if
      //     it returns 0 but the unfiltered count is > 0 (company_id mismatch).
      const useCompanyFilter =
        (dbg.trips_count_with_company_filter ?? 0) > 0 ||
        (dbg.trips_count_without_company_filter ?? 0) === 0;

      // 3. Load assigned Fahrten (assigned blocks reconstructed from these rows).
      const allTrips: TripRow[] = [];
      let offset = 0;
      while (true) {
        let q = supabase
          .from('fahrtenbuch_trips')
          .select('id, trip_date, start_time, end_time, car_identifier, assigned_driver_id, assigned_driver_name, assignment_block_id, assignment_source, is_canceled, raw_data_json, is_simulated')
          .eq('assignment_planning_run_id', run.id)
          .order('trip_date', { ascending: true })
          .order('start_time', { ascending: true })
          .order('id', { ascending: true })
          .range(offset, offset + BATCH - 1);
        if (useCompanyFilter) q = q.eq('company_id', effectiveCompanyId);

        const { data, error } = await q;
        if (error) {
          dbg.trips_query_error = fmtPgErr(error);
          setDebug(dbg);
          setError(`Trips Query Error: ${dbg.trips_query_error}`);
          return;
        }
        const rows = (data ?? []) as TripRow[];
        allTrips.push(...rows);
        if (rows.length < BATCH) break;
        offset += BATCH;
      }

      const usableTrips = allTrips.filter(trip => !trip.is_canceled);
      const missingBlockIdCount = usableTrips.filter(trip => !trip.assignment_block_id).length;
      const distinctBlockIds = new Set(usableTrips.map(trip => trip.assignment_block_id).filter((x): x is string => !!x)).size;
      const distinctDrivers = new Set(usableTrips.map(trip => trip.assigned_driver_id).filter((x): x is string => !!x)).size;

      dbg.loaded_trips = allTrips.length;
      dbg.trips_after_cancel_filter = usableTrips.length;
      dbg.rows_missing_block_id = missingBlockIdCount;
      dbg.distinct_block_ids = distinctBlockIds;
      dbg.distinct_drivers = distinctDrivers;

      if (usableTrips.length === 0) {
        if ((dbg.trips_count_without_company_filter ?? 0) > 0 && !useCompanyFilter === false) {
          setIssues([{
            type: 'no_trips_for_run',
            detailKey: 'stn.issue.companyIdMismatch',
            detailVars: {
              withoutFilter: dbg.trips_count_without_company_filter ?? 0,
              companyId: effectiveCompanyId,
            },
          }]);
        } else {
          setIssues([{ type: 'no_trips_for_run', detailKey: 'stn.issue.noTrips' }]);
        }
      } else if (missingBlockIdCount > 0 && distinctBlockIds === 0) {
        setIssues([{
          type: 'orphan_trip_without_block',
          detailKey: 'stn.issue.allTripsWithoutBlock',
          detailVars: { count: missingBlockIdCount },
        }]);
      } else if (missingBlockIdCount > 0) {
        setIssues([{
          type: 'orphan_trip_without_block',
          detailKey: 'stn.issue.someTripsWithoutBlock',
          detailVars: { count: missingBlockIdCount },
        }]);
      }
      setTrips(usableTrips);

      // 4. Manual exceptions for this planning run
      const { data: excData, error: excErr } = await supabase
        .from('monthly_planning_manual_exceptions')
        .select('block_id, dienstzeit_exception, tageslimit_exception, monatslimit_exception, reason')
        .eq('planning_run_id', run.id);
      if (excErr) {
        dbg.manual_exceptions_query_error = fmtPgErr(excErr);
      } else {
        setExceptions((excData ?? []) as ExceptionRow[]);
      }

      // 5. Driver wage data
      const driverIds = Array.from(new Set(usableTrips.map(trip => trip.assigned_driver_id).filter((x): x is string => !!x)));
      if (driverIds.length > 0) {
        const { data: wd, error: we } = await supabase
          .from('drivers')
          .select('id, personalnummer, planning_hourly_rate, planning_target_salary, planning_min_salary, planning_max_salary, planned_shift_start_time, planned_shift_end_time, planned_working_days, is_full_day_available')
          .in('id', driverIds);
        if (!we) setWages((wd ?? []) as DriverWage[]);
      }

      // 6. Ausgleichsstunden adjustments for this planning run
      const { data: adjData } = await supabase
        .from('planning_run_adjustments')
        .select('id, driver_id, driver_name, adjustment_type, hours, amount, hourly_rate')
        .eq('planning_run_id', run.id);
      setAdjustments((adjData ?? []) as AdjustmentRecord[]);

      // 7. Company Bundesland for public holiday calculation
      if (effectiveCompanyId) {
        const { data: settingsData } = await supabase
          .from('company_settings')
          .select('state')
          .eq('company_id', effectiveCompanyId)
          .maybeSingle();
        setCompanyBundesland((settingsData as { state?: string | null } | null)?.state ?? null);
      }

      setDebug(dbg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('stn.err.loadFailed');
      setError(msg);
      setDebug(dbg);
    } finally {
      setLoading(false);
    }
  }, [run.id, run.company_id, run.status, t]);

  useEffect(() => { void load(); }, [load]);

  const excMap = useMemo(() => {
    const m = new Map<string, ExceptionRow>();
    for (const e of exceptions) m.set(e.block_id, e);
    return m;
  }, [exceptions]);

  const wageMap = useMemo(() => {
    const m = new Map<string, DriverWage>();
    for (const w of wages) m.set(w.id, w);
    return m;
  }, [wages]);

  const adjustmentMap = useMemo(() => {
    const m = new Map<string, AdjustmentRecord[]>();
    for (const a of adjustments) {
      const arr = m.get(a.driver_id) ?? [];
      arr.push(a);
      m.set(a.driver_id, arr);
    }
    return m;
  }, [adjustments]);

  const { blocks, compressedBlocks, compressionInfo, validationIssues } = useMemo(() => {
    const localIssues: ValidationIssue[] = [...issues];
    const built = buildBlocks(trips, excMap, localIssues);

    // trip-count cross-check (informational only — new builder always captures all trips)
    const sumBlockTrips = built.reduce((s, b) => s + b.trip_count, 0);
    if (expectedTripCount != null && sumBlockTrips !== expectedTripCount) {
      localIssues.push({
        type: 'trip_count_mismatch',
        detailKey: 'stn.issue.tripCountMismatch',
        detailVars: { blockSum: sumBlockTrips, planSum: expectedTripCount },
      });
    }

    // Compress to at most MAX_SCHICHTEN_PER_DAY per driver/day
    const { blocks: compressed, compression } = compressShiftBlocksPerDay(built);

    // Coverage validation runs against compressed blocks — compression must
    // never reduce block_end_ms below any trip's actual end.
    const COVERAGE_TOL_MS = 2 * 60 * 1000;
    const compressedByDriverId = new Map<string, { sMs: number; eMs: number }[]>();
    for (const b of compressed) {
      const arr = compressedByDriverId.get(b.driver_id) ?? [];
      arr.push({ sMs: b.block_start_ms, eMs: b.block_end_ms });
      compressedByDriverId.set(b.driver_id, arr);
    }
    const uncoveredForDisplay: string[] = [];
    let uncoveredCount = 0;
    for (const trip of trips) {
      if (!trip.assigned_driver_id || !trip.start_time || !trip.end_time || !trip.trip_date) continue;
      const rw = resolveActualRideWindow({ trip_date: trip.trip_date, start_time: trip.start_time, end_time: trip.end_time, raw_data_json: trip.raw_data_json });
      const tSMs = rw.actualStartMs > 0 ? rw.actualStartMs : new Date(`${trip.trip_date}T${trip.start_time}`).getTime();
      let tEMs = rw.actualEndMs > 0 ? rw.actualEndMs : new Date(`${trip.trip_date}T${trip.end_time}`).getTime();
      if (tEMs <= tSMs) tEMs += 86400000;
      const driverBlocks = compressedByDriverId.get(trip.assigned_driver_id) ?? [];
      const isCovered = driverBlocks.some(b =>
        b.sMs <= tSMs + COVERAGE_TOL_MS &&
        b.eMs >= tEMs - COVERAGE_TOL_MS,
      );
      if (!isCovered) {
        uncoveredCount++;
        if (uncoveredForDisplay.length < 20) {
          const startStr = new Date(tSMs).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
          const endStr   = new Date(tEMs).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
          uncoveredForDisplay.push(`${trip.assigned_driver_name ?? '?'} · ${trip.trip_date} · ${trip.car_identifier ?? '—'} · ${startStr}–${endStr}`);
        }
      }
    }
    if (uncoveredCount > 0) {
      const extra = uncoveredCount - uncoveredForDisplay.length;
      localIssues.push({
        type: 'orphan_trip_without_block',
        detailKey: uncoveredCount === 1
          ? 'stn.issue.uncoveredTrips.one'
          : 'stn.issue.uncoveredTrips.other',
        detailVars: { count: uncoveredCount },
        detailLines: [
          ...uncoveredForDisplay,
          ...(extra > 0 ? [t('stn.issue.andMoreTrips', { count: extra })] : []),
        ],
      });
    }

    return { blocks: built, compressedBlocks: compressed, compressionInfo: compression, validationIssues: localIssues };
  }, [trips, excMap, issues, expectedTripCount, t]);

  const driverGroups = useMemo(() => {
    const groups = groupByDriver(compressedBlocks, wageMap, companyBundesland);
    // Add Ausgleichsstunden amounts to expected_brutto
    return groups.map(g => {
      const adjs = adjustmentMap.get(g.driver_id) ?? [];
      if (adjs.length === 0) return g;
      const adjTotal = adjs.reduce((s, a) => s + a.amount, 0);
      const adjHours = adjs.reduce((s, a) => s + a.hours, 0);
      return {
        ...g,
        expected_brutto: g.expected_brutto != null ? Math.round((g.expected_brutto + adjTotal) * 100) / 100 : null,
        ausgleich_hours: Math.round(adjHours * 100) / 100,
        ausgleich_amount: Math.round(adjTotal * 100) / 100,
      } as DriverGroup & { ausgleich_hours: number; ausgleich_amount: number };
    });
  }, [compressedBlocks, wageMap, adjustmentMap, companyBundesland]);

  const visibleGroups = useMemo(() => {
    if (selectedDriverId === '__all__') return driverGroups;
    return driverGroups.filter(g => g.driver_id === selectedDriverId);
  }, [driverGroups, selectedDriverId]);

  const totalShifts = visibleGroups.reduce((s, g) => s + g.shifts.length, 0);
  const totalMinutes = visibleGroups.reduce((s, g) => s + g.total_minutes, 0);
  const totalTrips = visibleGroups.reduce((s, g) => s + g.trips, 0);

  const isValid = validationIssues.length === 0 && !error;

  // Keep PDF driver selection in sync: add newly loaded drivers (all selected by default).
  // Don't remove drivers that were already selected — reload shouldn't deselect manual choices.
  useEffect(() => {
    setSelectedPdfDriverIds(prev => {
      const next = new Set(prev);
      for (const g of driverGroups) next.add(g.driver_id);
      return next;
    });
  }, [driverGroups]);

  const toggleDriver = (id: string) =>
    setExpandedDrivers(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const toggleDay = (key: string) =>
    setExpandedDays(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  const toggleAllShifts = (key: string) =>
    setExpandedAllShifts(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const handleExportPdf = () => {
    setExportError('');
    const target = driverGroups.find(g => g.driver_id === selectedDriverId);
    if (!target) return;
    try {
      setPdfExporting(true);
      exportDriverPdf(target, run.month, run.year, companyBundesland, simulated);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : t('stn.err.pdfExportFailed'));
    } finally {
      setPdfExporting(false);
    }
  };

  const handleExportAllPdfs = () => {
    setExportError('');
    const targetGroups = driverGroups.filter(g => selectedPdfDriverIds.has(g.driver_id));
    if (targetGroups.length === 0) {
      setExportError(t('stn.err.selectAtLeastOneDriver'));
      return;
    }
    if (targetGroups.length > 5) {
      setExportError(t('stn.err.tooManyDownloads', { count: targetGroups.length }));
    }
    try {
      setPdfExporting(true);
      for (const g of targetGroups) {
        exportDriverPdf(g, run.month, run.year, companyBundesland, simulated);
      }
    } catch (e) {
      setExportError(e instanceof Error ? e.message : t('stn.err.pdfExportFailed'));
    } finally {
      setPdfExporting(false);
    }
  };

  const handleSaveStundennachweise = async () => {
    const targetGroups = driverGroups.filter(g => selectedPdfDriverIds.has(g.driver_id));
    if (targetGroups.length === 0) return;
    setSavingStundennachweise(true);
    setSaveError('');
    setSaveSuccessCount(0);
    try {
      // Build all rows first (same snapshot used for PDF download)
      const built = targetGroups.map(g => {
        const { rows: pdfRows, totals } = buildPdfRows(g, run.month, run.year, companyBundesland);
        const rowsForStorage = pdfRows.map(r => {
          const { date: rowDate, ...rest } = r;
          return {
            ...rest,
            date_key: `${run.year}-${String(run.month).padStart(2, '0')}-${String(rowDate.getDate()).padStart(2, '0')}`,
          };
        });
        const satMins = g.shifts
          .filter(s => new Date(s.service_date + 'T00:00:00').getDay() === 6)
          .reduce((sum, s) => sum + s.paid_duration_minutes, 0);

        // Generate the EXACT same PDF blob as the download button would produce.
        // Using the same data object ensures Documents page always shows the
        // same PDF that was shown/downloaded in this preview session.
        const pdfData = {
          driver: { name: g.driver_name, personalnummer: g.personalnummer ?? undefined },
          month: run.month,
          year: run.year,
          rows: pdfRows,
          totals,
          simulated,
        };
        const pdfBlob = getStundennachweisBlob(pdfData);

        // Compute a lightweight snapshot hash for staleness detection.
        const hashInput = [
          g.driver_id, run.id,
          String(run.month), String(run.year),
          String(totals.grundlohn), String(totals.nachtarbeit),
          String(totals.sonntag), String(totals.feiertag),
        ].join('|');
        let h = 0;
        for (const c of hashInput) h = Math.imul(31, h) + c.charCodeAt(0) | 0;
        const snapshotHash = (h >>> 0).toString(36);

        const storagePath = `${run.company_id}/${run.year}/${String(run.month).padStart(2, '0')}/${g.driver_id}.pdf`;

        return {
          g,
          totals,
          satMins,
          rowsForStorage,
          pdfBlob,
          snapshotHash,
          storagePath,
        };
      });

      // Upload PDF blobs to Storage (fire-and-forget; DB save proceeds even on upload failure)
      const uploadedPaths: Map<string, string> = new Map();
      await Promise.all(built.map(async ({ g, pdfBlob, storagePath }) => {
        try {
          const { error: uploadErr } = await supabase.storage
            .from('stundennachweise-pdfs')
            .upload(storagePath, pdfBlob, { contentType: 'application/pdf', upsert: true });
          if (!uploadErr) uploadedPaths.set(g.driver_id, storagePath);
        } catch {
          // Storage upload failure is non-fatal; DB record saves without pdf_storage_path
        }
      }));

      const upsertRows = built.map(({ g, totals, satMins, rowsForStorage, snapshotHash }) => ({
        company_id:        run.company_id,
        driver_id:         g.driver_id,
        driver_name:       g.driver_name,
        personalnummer:    g.personalnummer ?? null,
        month:             run.month,
        year:              run.year,
        grundlohn_min:     totals.grundlohn,
        nachtarbeit_min:   totals.nachtarbeit,
        nacht04_min:       totals.nacht04,
        samstag_min:       satMins,
        sonntag_min:       totals.sonntag,
        feiertag_min:      totals.feiertag,
        weihnachten_min:   totals.weihnachten,
        working_days:      g.work_days,
        rows_json:         rowsForStorage,
        generation_source: 'monatsplanung',
        source_run_id:     run.id,
        is_simulated:      simulated,
        generated_at:      new Date().toISOString(),
        hourly_rate:       g.hourly_rate ?? null,
        target_salary:     g.target_salary ?? null,
        calculated_salary: g.expected_brutto ?? null,
        pdf_storage_path:  uploadedPaths.get(g.driver_id) ?? null,
        snapshot_hash:     snapshotHash,
        updated_at:        new Date().toISOString(),
      }));

      const { error } = await supabase
        .from('saved_stundennachweise')
        .upsert(upsertRows, { onConflict: 'company_id,driver_id,month,year' });
      if (error) throw error;
      setSaveSuccessCount(targetGroups.length);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : t('stn.err.saveFailed'));
    } finally {
      setSavingStundennachweise(false);
    }
  };

  const handlePruefExportXlsx = () => {
    setExportError('');
    try {
      setXlsxExporting(true);
      buildPruefExportXlsx(driverGroups, trips, run.month, run.year, simulated);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : t('stn.err.xlsxExportFailed'));
    } finally {
      setXlsxExporting(false);
    }
  };

  const handleExportFahreruebersicht = () => {
    setExportError('');
    if (driverGroups.length === 0) {
      setExportError(t('stn.err.noFinalSnapshot'));
      return;
    }
    setFahreruebersichtExporting(true);
    try {
      // Build per-driver rows from the final snapshot (driverGroups + trips).
      // Compute Fahrpreise, Trinkgeld, Gesammeltes_Bargeld from raw_data_json of assigned trips.
      const tripsByDriver = new Map<string, TripRow[]>();
      for (const trip of trips) {
        if (trip.is_canceled || !trip.assigned_driver_id) continue;
        const arr = tripsByDriver.get(trip.assigned_driver_id) ?? [];
        arr.push(trip);
        tripsByDriver.set(trip.assigned_driver_id, arr);
      }

      const rows: FahreruebersichtImportRow[] = driverGroups.map(g => {
        const dTrips = tripsByDriver.get(g.driver_id) ?? [];
        let fahrpreise = 0;
        let trinkgeld = 0;
        let bargeld = 0;
        for (const trip of dTrips) {
          const raw = trip.raw_data_json ?? {};
          const fp = parseFloat(String(raw['Fahrpreis'] ?? '0').replace(',', '.')) || 0;
          const tg = parseFloat(String(raw['Trinkgeld'] ?? '0').replace(',', '.')) || 0;
          const za = String(raw['Zahlungsart'] ?? '').toLowerCase();
          fahrpreise += fp;
          trinkgeld += tg;
          if (za.includes('bar') || za.includes('cash')) bargeld += fp;
        }
        return {
          driver_id: g.driver_id,
          driver_name: g.driver_name,
          personalnummer: g.personalnummer,
          online_hours: g.total_minutes / 60,
          fahrten: g.trips,
          fahrpreise,
          trinkgeld,
          gesammeltes_bargeld: bargeld,
        };
      });

      exportFahreruebersichtImportFormat({
        month: run.month,
        year: run.year,
        companyId: run.company_id ?? null,
        rows,
        simulated,
      });
    } catch (e) {
      setExportError(e instanceof Error ? e.message : t('stn.err.driverOverviewFailed'));
    } finally {
      setFahreruebersichtExporting(false);
    }
  };

  const handleExportFinalFahrtenbuch = async () => {
    setExportError('');
    if (!run.import_id) {
      setExportError(t('stn.err.fahrtenbuchNoImportId'));
      return;
    }
    setFahrtenbuchExporting(true);
    try {
      const runSummary: AppliedRunSummary = {
        id: run.id,
        company_id: run.company_id,
        import_id: run.import_id,
        month: run.month,
        year: run.year,
        status: run.status,
        file_name: run.file_name,
        applied_at: run.applied_at,
        applied_by: null,
        apply_summary_json: null,
        settings_json: null,
        summary_json: null,
        source_columns_json: run.source_columns_json ?? null,
        source_sheet_name: run.source_sheet_name ?? null,
        imported_at: '',
      };
      // 'original' reproduces the imported sheet byte for byte — nothing handed
      // to exportAppliedRunXlsx may be translated.
      await exportAppliedRunXlsx(runSummary, 'original');
    } catch (e) {
      setExportError(e instanceof Error ? e.message : t('stn.err.fahrtenbuchExportFailed'));
    } finally {
      setFahrtenbuchExporting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center p-4"
      style={{ background: 'rgba(15, 23, 42, 0.7)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl shadow-2xl w-full max-w-6xl max-h-[92vh] flex flex-col"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
        onClick={e => e.stopPropagation()}
      >
        {simulated ? <div className="px-5 pt-4"><SimulatedNotice /></div> : null}
        <div className="flex items-start justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="min-w-0">
            <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <CalendarClock size={16} /> {t('stn.preview.title')} · {t(MONTH_NAME_KEYS[run.month - 1])} {run.year}
            </h3>
            <div className="text-xs mt-1 font-mono" style={{ color: 'var(--text-tertiary)' }}>
              {t('stn.preview.runId', { id: run.id })}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50"
              style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> {t('stn.preview.reload')}
            </button>
            <button onClick={onClose} className="p-1 rounded" style={{ color: 'var(--text-tertiary)' }}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="px-5 py-3 border-b flex flex-wrap items-center gap-3" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2">
            <Users size={14} style={{ color: 'var(--text-tertiary)' }} />
            <label className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('stn.preview.driverLabel')}</label>
            <select
              value={selectedDriverId}
              onChange={e => setSelectedDriverId(e.target.value)}
              className="px-2 py-1 rounded-lg text-sm"
              style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              <option value="__all__">{t('common.allDrivers')} ({driverGroups.length})</option>
              {driverGroups.map(g => (
                <option key={g.driver_id} value={g.driver_id}>
                  {g.driver_name} ({t('stn.preview.shiftCount', { count: g.shifts.length })})
                </option>
              ))}
            </select>
          </div>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            {selectedDriverId !== '__all__' && (
              <button
                onClick={handleExportPdf}
                disabled={pdfExporting || loading || driverGroups.length === 0}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50 transition-opacity"
                style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              >
                <Download size={12} /> {pdfExporting ? t('stn.preview.exporting') : t('stn.preview.downloadPdf')}
              </button>
            )}
            {import.meta.env.DEV && localStorage.getItem('showPlanningDebug') === '1' && (
              <button
                onClick={handlePruefExportXlsx}
                disabled={xlsxExporting || loading || driverGroups.length === 0}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50 transition-opacity"
                style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              >
                <FileSpreadsheet size={12} /> {xlsxExporting ? t('stn.preview.exporting') : t('stn.preview.auditExportXlsx')}
              </button>
            )}
            <button
              onClick={() => void handleExportFinalFahrtenbuch()}
              disabled={fahrtenbuchExporting || loading || !run.import_id}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50 transition-opacity"
              style={{ background: 'rgba(34,197,94,0.1)', color: '#15803d', border: '1px solid rgba(34,197,94,0.3)' }}
              title={t('stn.preview.fahrtenbuchTitle')}
            >
              <FileSpreadsheet size={12} /> {fahrtenbuchExporting ? t('stn.preview.exporting') : t('stn.preview.downloadFahrtenbuch')}
            </button>
            <button
              onClick={handleExportFahreruebersicht}
              disabled={fahreruebersichtExporting || loading || driverGroups.length === 0}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50 transition-opacity"
              style={{ background: 'rgba(59,130,246,0.1)', color: '#1d4ed8', border: '1px solid rgba(59,130,246,0.3)' }}
              title={t('stn.preview.driverOverviewTitle')}
            >
              <FileSpreadsheet size={12} /> {fahreruebersichtExporting ? t('stn.preview.driverOverviewBuilding') : t('stn.preview.downloadDriverOverview')}
            </button>
            <span className="text-xs pl-2" style={{ color: 'var(--text-secondary)', borderLeft: '1px solid var(--border)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>{totalShifts}</strong> {t('stn.label.shifts')}
            </span>
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>{totalTrips}</strong> {t('stn.label.trips')}
            </span>
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>{fmtHours(totalMinutes)}</strong> {t('stn.label.totalSuffix')}
            </span>
          </div>
        </div>

        {/* Stundennachweise auswählen — PDF export driver selection */}
        {!loading && driverGroups.length > 0 && (
          <div className="px-5 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
            <button
              className="inline-flex items-center gap-1.5 text-xs font-semibold mb-0"
              style={{ color: 'var(--text-secondary)' }}
              onClick={() => setShowPdfDriverSelect(v => !v)}
            >
              <Download size={12} />
              {t('stn.select.title')}
              {showPdfDriverSelect ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>
            {showPdfDriverSelect && (
              <div className="mt-3 space-y-2">
                {/* Alle auswählen */}
                <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={driverGroups.every(g => selectedPdfDriverIds.has(g.driver_id))}
                    ref={el => {
                      if (el) {
                        const allSelected = driverGroups.every(g => selectedPdfDriverIds.has(g.driver_id));
                        const noneSelected = driverGroups.every(g => !selectedPdfDriverIds.has(g.driver_id));
                        el.indeterminate = !allSelected && !noneSelected;
                      }
                    }}
                    onChange={e => {
                      if (e.target.checked) {
                        setSelectedPdfDriverIds(new Set(driverGroups.map(g => g.driver_id)));
                      } else {
                        setSelectedPdfDriverIds(new Set());
                      }
                    }}
                    className="rounded"
                  />
                  <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('stn.select.all')}</span>
                </label>
                <div className="pl-1 flex flex-wrap gap-x-5 gap-y-1.5">
                  {driverGroups.map(g => (
                    <label key={g.driver_id} className="flex items-center gap-2 text-xs cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={selectedPdfDriverIds.has(g.driver_id)}
                        onChange={e => {
                          setSelectedPdfDriverIds(prev => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(g.driver_id);
                            else next.delete(g.driver_id);
                            return next;
                          });
                        }}
                        className="rounded"
                      />
                      <span style={{ color: 'var(--text-primary)' }}>{g.driver_name}</span>
                      <span style={{ color: 'var(--text-tertiary)' }}>({t('stn.preview.shiftCount', { count: g.shifts.length })})</span>
                    </label>
                  ))}
                </div>
                <div className="flex items-center gap-3 pt-1 flex-wrap">
                  {selectedPdfDriverIds.size === 0 && (
                    <span className="text-xs" style={{ color: '#dc2626' }}>{t('stn.err.selectAtLeastOneDriver')}</span>
                  )}
                  <button
                    onClick={handleExportAllPdfs}
                    disabled={pdfExporting || loading || selectedPdfDriverIds.size === 0}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50 transition-opacity"
                    style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                  >
                    <Download size={12} /> {pdfExporting ? t('stn.preview.exporting') : t('stn.select.downloadSelectedPdfs', { count: selectedPdfDriverIds.size })}
                  </button>
                  <button
                    onClick={() => void handleSaveStundennachweise()}
                    disabled={savingStundennachweise || loading || selectedPdfDriverIds.size === 0}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50 transition-opacity"
                    style={{ background: 'rgba(34,197,94,0.1)', color: '#15803d', border: '1px solid rgba(34,197,94,0.3)' }}
                  >
                    <Save size={12} /> {savingStundennachweise
                      ? t('stn.select.saving')
                      : saveSuccessCount > 0
                        ? t('stn.select.saved')
                        : t('stn.select.saveSelected')}
                  </button>
                </div>
                {saveError && (
                  <p className="text-xs mt-1.5" style={{ color: '#dc2626' }}>{saveError}</p>
                )}
                {saveSuccessCount > 0 && !savingStundennachweise && (
                  <p className="text-xs mt-1.5" style={{ color: '#16a34a' }}>
                    {tPlural(
                      { one: 'stn.select.savedToDocuments.one', other: 'stn.select.savedToDocuments.other' },
                      saveSuccessCount,
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {exportError && (
          <div className="px-5 py-2 text-xs flex items-start gap-2" style={{ background: 'rgba(245,158,11,0.08)', color: '#fcd34d', borderBottom: '1px solid rgba(245,158,11,0.25)' }}>
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <span>{exportError}</span>
            <button className="ml-auto shrink-0 opacity-70 hover:opacity-100" onClick={() => setExportError('')}>
              <X size={12} />
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {loading && (
            <div className="px-3 py-6 rounded-lg text-sm flex items-center justify-center gap-2" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
              <Loader2 size={14} className="animate-spin" /> {t('stn.preview.loadingBlocks')}
            </div>
          )}

          {error && (
            <div className="px-3 py-2 rounded-lg text-sm" style={{ background: 'rgba(239,68,68,0.1)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.35)' }}>
              {t('stn.err.loadFailed')} {error}
            </div>
          )}

          {!loading && (
            <details
              open={!!error || trips.length === 0}
              className="rounded-lg text-xs"
              style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            >
              <summary className="px-3 py-2 cursor-pointer font-semibold select-none" style={{ color: 'var(--text-primary)' }}>
                {t('stn.preview.debugTitle')}
              </summary>
              {/* DebugRow labels name DB columns and props verbatim — technical
                  identifiers, not UI copy, so they are not translated. */}
              <div className="px-3 pb-3 pt-1 font-mono leading-relaxed">
                <DebugRow label="Planning Run ID" value={debug.planning_run_id} />
                <DebugRow label="Planning Run Status" value={debug.planning_run_status} />
                <DebugRow label="Query table used for planning run" value={debug.query_table_planning_run} />
                <DebugRow label="Query table used for trips" value={debug.query_table_trips} />
                <DebugRow label="Selected run company_id (prop)" value={debug.selected_run_company_id_prop} />
                <DebugRow label="company_id loaded from DB" value={debug.db_company_id} />
                <DebugRow label="Planning Run Query Error" value={debug.planning_run_query_error} />
                <DebugRow label="Trips Query Error" value={debug.trips_query_error} />
                <DebugRow label="Manual Exceptions Query Error" value={debug.manual_exceptions_query_error} />
                <DebugRow label="Trips count WITHOUT company_id filter" value={debug.trips_count_without_company_filter} />
                <DebugRow label="Trips count WITH company_id filter" value={debug.trips_count_with_company_filter} />
                <DebugRow label="Loaded assigned Fahrten count" value={debug.loaded_trips} />
                <DebugRow label="Trips after cancel filter" value={debug.trips_after_cancel_filter} />
                <DebugRow label="Rows missing assignment_block_id" value={debug.rows_missing_block_id} />
                <DebugRow label="Distinct assignment_block_id count" value={debug.distinct_block_ids} />
                <DebugRow label="Distinct assigned drivers count" value={debug.distinct_drivers} />
                <DebugRow label="Expected trips (apply_summary_json.updated_trips)" value={debug.expected_trips} />
              </div>
            </details>
          )}

          {!loading && validationIssues.length > 0 && (
            <div
              className="px-3 py-3 rounded-lg text-xs space-y-1"
              style={{ background: 'rgba(245,158,11,0.1)', color: '#fcd34d', border: '1px solid rgba(245,158,11,0.35)' }}
            >
              <div className="font-semibold inline-flex items-center gap-1">
                <AlertTriangle size={13} /> {t('stn.issue.title')} ({validationIssues.length})
              </div>
              <ul className="list-disc pl-5 space-y-0.5">
                {validationIssues.slice(0, 50).map((issue, idx) => (
                  <li key={idx} style={{ whiteSpace: 'pre-wrap' }}>
                    {[t(issue.detailKey, issue.detailVars), ...(issue.detailLines ?? [])].join('\n')}
                  </li>
                ))}
              </ul>
              {validationIssues.length > 50 && (
                <div className="opacity-70">{t('stn.issue.andMore', { count: validationIssues.length - 50 })}</div>
              )}
            </div>
          )}

          {!loading && isValid && driverGroups.length > 0 && (
            <div className="px-3 py-2 rounded-lg text-xs inline-flex items-center gap-1.5" style={{ background: 'rgba(34,197,94,0.1)', color: '#86efac', border: '1px solid rgba(34,197,94,0.35)' }}>
              <CheckCircle2 size={13} /> {t('stn.preview.integrityOk', { drivers: driverGroups.length, shifts: compressedBlocks.length })}
            </div>
          )}

          {!loading && visibleGroups.map(g => (
            <DriverCard
              key={g.driver_id}
              group={g}
              expanded={expandedDrivers.has(g.driver_id)}
              onToggle={() => toggleDriver(g.driver_id)}
              expandedDays={expandedDays}
              onToggleDay={toggleDay}
              expandedAllShifts={expandedAllShifts}
              onToggleAllShifts={toggleAllShifts}
            />
          ))}

          {!loading && visibleGroups.length === 0 && !error && validationIssues.length === 0 && (
            <div className="px-3 py-8 text-center text-sm rounded-lg" style={{ background: 'var(--bg-subtle)', color: 'var(--text-tertiary)' }}>
              {t('stn.preview.noBlocks')}
            </div>
          )}

          {!loading && driverGroups.length > 0 && (
            <GehaltsabweichungSection
              groups={driverGroups}
              wageMap={wageMap}
              rawTrips={trips}
              onReload={load}
              runId={run.id}
              companyId={run.company_id}
              adjustmentMap={adjustmentMap}
              onAdjustmentSaved={load}
              onTransferApplied={onTransferApplied ? () => onTransferApplied(run.id) : undefined}
              bundesland={companyBundesland}
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t" style={{ borderColor: 'var(--border)' }}>
          <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {t('stn.preview.sourceFooter')} <span className="font-mono">{run.id.slice(0, 8)}…</span>
          </div>
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-lg text-sm font-semibold"
            style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

function DriverCard({
  group,
  expanded,
  onToggle,
  expandedDays,
  onToggleDay,
  expandedAllShifts,
  onToggleAllShifts,
}: {
  group: DriverGroup;
  expanded: boolean;
  onToggle: () => void;
  expandedDays: Set<string>;
  onToggleDay: (key: string) => void;
  expandedAllShifts: Set<string>;
  onToggleAllShifts: (key: string) => void;
}) {
  const { t } = useTranslation();
  const days = useMemo(() => {
    const m = new Map<string, ShiftBlock[]>();
    for (const s of group.shifts) {
      const arr = m.get(s.service_date) ?? [];
      arr.push(s);
      m.set(s.service_date, arr);
    }
    return [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, shifts]) => ({
        date,
        shifts: shifts.sort((a, b) => a.block_start_ms - b.block_start_ms),
      }));
  }, [group.shifts]);

  return (
    <div className="rounded-lg overflow-hidden" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex flex-wrap items-start justify-between gap-3 transition-colors hover:brightness-110"
        style={{ background: 'var(--bg-surface)', borderBottom: expanded ? '1px solid var(--border)' : 'none' }}
      >
        <div className="flex items-start gap-2 min-w-0">
          {expanded ? <ChevronDown size={16} style={{ color: 'var(--text-secondary)' }} /> : <ChevronRight size={16} style={{ color: 'var(--text-secondary)' }} />}
          <div className="min-w-0">
            <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>
              {group.driver_name}
            </div>
            <div className="text-[11px] mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5" style={{ color: 'var(--text-secondary)' }}>
              <span>{t('stn.card.shifts')} <strong style={{ color: 'var(--text-primary)' }}>{group.shifts.length}</strong></span>
              <span>{t('stn.card.trips')} <strong style={{ color: 'var(--text-primary)' }}>{group.trips}</strong></span>
              <span>
                {t('stn.card.workedHours')} <strong style={{ color: 'var(--text-primary)' }}>
                  {fmtHours(group.total_minutes)}
                </strong>
              </span>
              {group.ausgleich_hours != null && group.ausgleich_hours > 0 && (
                <span>
                  {t('stn.card.ausgleichHours')} <strong style={{ color: '#86efac' }}>
                    +{group.ausgleich_hours.toFixed(2).replace('.', ',')} h
                  </strong>
                </span>
              )}
              {group.ausgleich_hours != null && group.ausgleich_hours > 0 && (
                <span>
                  {t('stn.card.totalHours')} <strong style={{ color: 'var(--text-primary)' }}>
                    {((group.total_minutes / 60) + group.ausgleich_hours).toFixed(2).replace('.', ',')} h
                  </strong>
                </span>
              )}
              <span>{t('stn.card.days')} <strong style={{ color: 'var(--text-primary)' }}>{group.work_days}</strong></span>
              <span>{t('stn.card.expectedGross')} <strong style={{ color: group.expected_brutto != null ? '#86efac' : 'var(--text-tertiary)' }}>{fmtEuro(group.expected_brutto)}</strong></span>
              {group.manual_exceptions > 0 && (
                <span>{t('stn.card.manualExceptions')} <strong style={{ color: '#fcd34d' }}>{group.manual_exceptions}</strong></span>
              )}
            </div>
            <div className="text-[11px] mt-0.5 flex flex-wrap items-center gap-x-3" style={{ color: 'var(--text-tertiary)' }}>
              <span>{t('stn.card.nightTotal')} <strong style={{ color: 'var(--text-secondary)' }}>{fmtHours(group.night_total)}</strong></span>
              <span>23–00: <strong style={{ color: 'var(--text-secondary)' }}>{fmtHours(group.night_23_00)}</strong></span>
              <span>00–04: <strong style={{ color: 'var(--text-secondary)' }}>{fmtHours(group.night_00_04)}</strong></span>
              <span>04–06: <strong style={{ color: 'var(--text-secondary)' }}>{fmtHours(group.night_04_06)}</strong></span>
              {group.hourly_rate != null && (
                <span>{t('stn.card.hourlyRate')} <strong style={{ color: 'var(--text-secondary)' }}>{group.hourly_rate.toFixed(2).replace('.', ',')} €</strong></span>
              )}
              {(group.min_salary != null || group.max_salary != null) && (
                <span>
                  {t('stn.card.salaryRange')}{' '}
                  <strong style={{ color: 'var(--text-secondary)' }}>
                    {group.min_salary != null ? fmtEuro(group.min_salary) : '—'}
                    {' – '}
                    {group.max_salary != null ? fmtEuro(group.max_salary) : '—'}
                  </strong>
                </span>
              )}
              {group.expected_brutto != null && group.min_salary != null && group.expected_brutto < group.min_salary - 0.01 && (
                <span style={{ color: '#fcd34d', fontWeight: 600 }}>{t('stn.summary.belowMinSalary')}</span>
              )}
              {group.expected_brutto != null && group.max_salary != null && group.expected_brutto > group.max_salary + 0.01 && (
                <span style={{ color: '#f87171', fontWeight: 600 }}>{t('stn.summary.aboveMaxSalary')}</span>
              )}
            </div>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-3 py-3 space-y-1.5">
          {days.map(({ date, shifts }) => (
            <DayBlock
              key={date}
              driverId={group.driver_id}
              date={date}
              shifts={shifts}
              expanded={expandedDays.has(`${group.driver_id}|${date}`)}
              allShiftsExpanded={expandedAllShifts.has(`${group.driver_id}|${date}`)}
              onToggle={() => onToggleDay(`${group.driver_id}|${date}`)}
              onToggleAllShifts={() => onToggleAllShifts(`${group.driver_id}|${date}`)}
            />
          ))}

          <div
            className="mt-2 px-3 py-2 rounded text-xs flex flex-wrap items-center gap-x-4 gap-y-1"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          >
            <strong style={{ color: 'var(--text-primary)' }}>{t('stn.card.monthTotal')}</strong>
            <span>{fmtDuration(group.total_minutes)}</span>
            <span>{group.trips} {t('stn.label.trips')}</span>
            <span>{group.shifts.length} {t('stn.label.shifts')}</span>
            <span>{group.work_days} {t('stn.label.workingDays')}</span>
            <span>{t('stn.card.nightShort')} {fmtHours(group.night_total)}</span>
            <span>23–00: {fmtHours(group.night_23_00)}</span>
            <span>00–04: {fmtHours(group.night_00_04)}</span>
            <span>04–06: {fmtHours(group.night_04_06)}</span>
            <span style={{ color: group.expected_brutto != null ? '#86efac' : 'var(--text-tertiary)' }}>
              {t('stn.card.expectedGross')} {fmtEuro(group.expected_brutto)}
            </span>
            {group.expected_brutto != null && group.min_salary != null && group.expected_brutto < group.min_salary - 0.01 && (
              <span style={{ color: '#fcd34d', fontWeight: 600 }}>{t('stn.summary.belowMinSalary')} ({fmtEuro(group.min_salary)})</span>
            )}
            {group.expected_brutto != null && group.max_salary != null && group.expected_brutto > group.max_salary + 0.01 && (
              <span style={{ color: '#f87171', fontWeight: 600 }}>{t('stn.summary.aboveMaxSalary')} ({fmtEuro(group.max_salary)})</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DayBlock({
  date,
  shifts,
  expanded,
  allShiftsExpanded,
  onToggle,
  onToggleAllShifts,
}: {
  driverId: string;
  date: string;
  shifts: ShiftBlock[];
  expanded: boolean;
  allShiftsExpanded: boolean;
  onToggle: () => void;
  onToggleAllShifts: () => void;
}) {
  const { t } = useTranslation();
  const dayMinutes = shifts.reduce((s, x) => s + x.duration_minutes, 0);
  const dayTrips = shifts.reduce((s, x) => s + x.trip_count, 0);
  const dayN23 = shifts.reduce((s, x) => s + x.night_23_00, 0);
  const dayN00 = shifts.reduce((s, x) => s + x.night_00_04, 0);
  const dayN04 = shifts.reduce((s, x) => s + x.night_04_06, 0);
  const dayNTotal = dayN23 + dayN00 + dayN04;
  const dayExceptions = shifts.reduce(
    (n, s) => n + (s.dienstzeit_exception ? 1 : 0) + (s.tageslimit_exception ? 1 : 0) + (s.monatslimit_exception ? 1 : 0),
    0,
  );
  const wasCompressed = shifts.some(s => s.block_id.includes('+'));

  const MAX_SHOWN = 3;
  const visibleShifts = allShiftsExpanded ? shifts : shifts.slice(0, MAX_SHOWN);
  const hidden = shifts.length - visibleShifts.length;

  return (
    <div className="rounded" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-3 py-2 flex items-center justify-between gap-2 transition-colors hover:brightness-110"
      >
        <div className="flex items-center gap-2 min-w-0">
          {expanded ? <ChevronDown size={13} style={{ color: 'var(--text-secondary)' }} /> : <ChevronRight size={13} style={{ color: 'var(--text-secondary)' }} />}
          <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
            {fmtDate(date)} · {t('stn.day.dayTotal')} {fmtDuration(dayMinutes)}
          </span>
        </div>
        <div className="text-[11px] flex flex-wrap items-center gap-x-3" style={{ color: 'var(--text-secondary)' }}>
          <span>{shifts.length} {t('stn.label.shifts')}</span>
          <span>{dayTrips} {t('stn.label.trips')}</span>
          <span>{t('stn.day.night')} {fmtHours(dayNTotal)}</span>
          {dayExceptions > 0 && <span style={{ color: '#fcd34d' }}>{t('stn.day.exceptions')} {dayExceptions}</span>}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                <th className="px-2 py-1 text-left">{t('stn.day.col.start')}</th>
                <th className="px-2 py-1 text-left">{t('stn.day.col.end')}</th>
                <th className="px-2 py-1 text-right">{t('stn.day.col.duration')}</th>
                <th className="px-2 py-1 text-left">{t('stn.day.col.plate')}</th>
                <th className="px-2 py-1 text-right">{t('stn.label.trips')}</th>
                <th className="px-2 py-1 text-left">{t('stn.day.col.source')}</th>
                <th className="px-2 py-1 text-right">23–00</th>
                <th className="px-2 py-1 text-right">00–04</th>
                <th className="px-2 py-1 text-right">04–06</th>
                <th className="px-2 py-1 text-left">{t('stn.day.col.exception')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleShifts.map(s => {
                // +1d display based on PAID end (what actually appears in the PDF).
                const paidEndSameDay = localDateString(s.paid_end_ms) === s.service_date;
                const endLabel = `${fmtTime(s.paid_end_ms)}${paidEndSameDay ? '' : ' +1d'}`;
                return (
                  <tr key={s.block_id} style={{ borderTop: '1px dashed var(--border)' }}>
                    <td className="px-2 py-1 font-mono" style={{ color: 'var(--text-primary)' }}>{fmtTime(s.block_start_ms)}</td>
                    <td className="px-2 py-1 font-mono" style={{ color: 'var(--text-primary)' }}>{endLabel}</td>
                    <td className="px-2 py-1 font-mono text-right" style={{ color: 'var(--text-primary)' }}>
                      {fmtDuration(s.paid_duration_minutes)}
                      {s.minimum_applied && (
                        <span
                          className="ml-1.5 inline-block px-1 py-0 rounded text-[9px] font-bold uppercase"
                          style={{ background: 'rgba(59,130,246,0.2)', color: '#93c5fd', border: '1px solid rgba(59,130,246,0.4)', verticalAlign: 'middle' }}
                          title={t('stn.day.minimumTitle', { actual: fmtDuration(s.duration_minutes), added: s.minimum_added_minutes })}
                        >
                          {t('stn.day.minimumBadge')}
                        </span>
                      )}
                      {s.minimum_applied && (
                        <div className="text-[9px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                          {t('stn.day.actual')} {fmtDuration(s.duration_minutes)} · {t('stn.day.paid')} {fmtDuration(s.paid_duration_minutes)}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1 font-mono" style={{ color: 'var(--text-secondary)' }}>{s.vehicle || '—'}</td>
                    <td className="px-2 py-1 text-right" style={{ color: 'var(--text-secondary)' }}>{s.trip_count}</td>
                    <td className="px-2 py-1"><SourceBadge source={s.assignment_source} /></td>
                    <td className="px-2 py-1 text-right font-mono" style={{ color: s.night_23_00 ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>{s.night_23_00 ? fmtDuration(s.night_23_00) : '—'}</td>
                    <td className="px-2 py-1 text-right font-mono" style={{ color: s.night_00_04 ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>{s.night_00_04 ? fmtDuration(s.night_00_04) : '—'}</td>
                    <td className="px-2 py-1 text-right font-mono" style={{ color: s.night_04_06 ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>{s.night_04_06 ? fmtDuration(s.night_04_06) : '—'}</td>
                    <td className="px-2 py-1"><ExceptionBadges shift={s} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {hidden > 0 && (
            <button
              type="button"
              onClick={onToggleAllShifts}
              className="mt-2 text-xs font-semibold px-2 py-1 rounded"
              style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
            >
              {t('stn.day.showMoreShifts', { count: hidden })}
            </button>
          )}
          {allShiftsExpanded && shifts.length > MAX_SHOWN && (
            <button
              type="button"
              onClick={onToggleAllShifts}
              className="mt-2 ml-2 text-xs font-semibold px-2 py-1 rounded"
              style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
            >
              {t('stn.day.showLess')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// `label` holds a TranslationKey: this map is module-level and t() is a hook
// value, so the badge resolves it at render.
const SOURCE_BADGES: Record<string, { bg: string; fg: string; label: TranslationKey }> = {
  auto:             { bg: 'rgba(34,197,94,0.15)',  fg: '#86efac', label: 'stn.source.auto' },
  repair:           { bg: 'rgba(59,130,246,0.15)', fg: '#93c5fd', label: 'stn.source.repair' },
  manual_exception: { bg: 'rgba(245,158,11,0.18)', fg: '#fcd34d', label: 'stn.source.manual' },
  manual:           { bg: 'rgba(245,158,11,0.18)', fg: '#fcd34d', label: 'stn.source.manual' },
};

function SourceBadge({ source }: { source: string }) {
  const { t } = useTranslation();
  const cfg = SOURCE_BADGES[source];
  // An unknown source is raw DB data, not a label — show it verbatim.
  const label = cfg ? t(cfg.label) : (source || t('stn.source.auto'));
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold"
      style={{ background: cfg?.bg ?? 'var(--bg-subtle)', color: cfg?.fg ?? 'var(--text-secondary)' }}
    >
      {label}
    </span>
  );
}

function ExceptionBadges({ shift }: { shift: ShiftBlock }) {
  const { t } = useTranslation();
  if (!shift.manual_exception && !shift.dienstzeit_exception && !shift.tageslimit_exception && !shift.monatslimit_exception) {
    return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
  }
  const badgeKeys: TranslationKey[] = [];
  if (shift.dienstzeit_exception) badgeKeys.push('stn.exception.dutyTime');
  if (shift.tageslimit_exception) badgeKeys.push('stn.exception.dailyLimit');
  if (shift.monatslimit_exception) badgeKeys.push('stn.exception.monthlyLimit');
  return (
    <span className="inline-flex flex-wrap items-center gap-1" title={shift.exception_reason}>
      {badgeKeys.map(key => (
        <span
          key={key}
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold"
          style={{ background: 'rgba(245,158,11,0.18)', color: '#fcd34d' }}
        >
          {t(key)}
        </span>
      ))}
      {badgeKeys.length === 0 && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: 'rgba(245,158,11,0.18)', color: '#fcd34d' }}>
          {t('stn.exception.manual')}
        </span>
      )}
    </span>
  );
}

function DebugRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  const display = value === null || value === undefined || value === '' ? '—' : String(value);
  return (
    <div className="flex gap-3 py-0.5">
      <span style={{ color: 'var(--text-tertiary)', minWidth: 280 }}>{label}:</span>
      <span style={{ color: 'var(--text-primary)' }}>{display}</span>
    </div>
  );
}

// ─── Salary Deviation Analysis ───────────────────────────────────────────────

const SALARY_TOLERANCE_DEFAULT = 100;

type DeviationStatus = 'over' | 'in_range' | 'under';

interface DriverDeviation {
  driver_id: string;
  driver_name: string;
  target: number;
  min_salary: number | null;
  max_salary: number | null;
  actual: number;
  diff: number;
  status: DeviationStatus;
  shifts: ShiftBlock[];
  hourly_rate: number | null;
}

type TransferType = 'single' | 'multi_day' | 'full_day';

interface TransferCandidate {
  shifts: ShiftBlock[];
  transfer_type: TransferType;
  // Candidates are built in a pure module-level helper where t() is not
  // available, so the label is carried as a key plus its variables.
  labelKey: TranslationKey;
  labelVars: TranslationVars;
  brutto_at_source_rate: number;
  duration_minutes: number;
}

type ValidationStatus = 'gueltig' | 'nicht_moeglich' | 'pruefung_erforderlich';

interface ValidationResult {
  status: ValidationStatus;
  reasons: string[];
  /**
   * Explicit outcome flags. Callers used to re-derive these by substring-matching
   * the German reason text, which stops matching as soon as the reasons are
   * translated — and would silently let a note-blocked transfer through.
   */
  noteBlocked: boolean;
  overlapDetected: boolean;
}

interface TransferSuggestion {
  source_driver_id: string;
  source_driver_name: string;
  source_diff: number;
  target_driver_id: string;
  target_driver_name: string;
  target_diff: number;
  candidate: TransferCandidate;
  shift_brutto: number;
  source_after: number;
  target_after: number;
  impact_score: number;
  validation: ValidationResult;
}

const MIN_TRANSFER_BRUTTO = 25;

// ── Driver note types used for transfer validation ───────────────────────────

interface DriverNote {
  driver_id: string;
  note_planning_behavior: 'neutral' | 'exclude_from_plan' | 'must_include_in_plan';
  is_full_day: boolean;
  start_date: string | null;   // YYYY-MM-DD
  end_date: string | null;     // YYYY-MM-DD
  note_date: string | null;    // ISO timestamp fallback
  start_time: string | null;   // HH:MM
  end_time: string | null;     // HH:MM
}

/**
 * Returns true if any exclude_from_plan note for this driver overlaps
 * the interval [shiftStartMs, shiftEndMs).
 */
function isNoteBlockingTransfer(
  notes: DriverNote[],
  shiftStartMs: number,
  shiftEndMs: number,
): boolean {
  const MS_PER_DAY = 86_400_000;
  for (const note of notes) {
    if (note.note_planning_behavior !== 'exclude_from_plan') continue;

    const rawStart = note.start_date ?? (note.note_date ? note.note_date.slice(0, 10) : null);
    const rawEnd = note.end_date ?? rawStart;
    if (!rawStart) continue;

    const rangeStart = new Date(`${rawStart}T00:00:00`).getTime();
    const rangeEnd = new Date(`${rawEnd ?? rawStart}T00:00:00`).getTime();
    if (isNaN(rangeStart) || isNaN(rangeEnd)) continue;

    const cappedRangeEnd = Math.min(rangeEnd, rangeStart + 366 * MS_PER_DAY);
    for (let dayMs = rangeStart; dayMs <= cappedRangeEnd; dayMs += MS_PER_DAY) {
      let noteStart: number;
      let noteEnd: number;
      if (note.is_full_day || !note.start_time || !note.end_time) {
        noteStart = dayMs;
        noteEnd = dayMs + MS_PER_DAY;
      } else {
        const [sh, sm] = note.start_time.split(':').map(Number);
        const [eh, em] = note.end_time.split(':').map(Number);
        const sMin = sh * 60 + (sm ?? 0);
        const eMin = eh * 60 + (em ?? 0);
        if (eMin > sMin) {
          noteStart = dayMs + sMin * 60_000;
          noteEnd = dayMs + eMin * 60_000;
        } else {
          // cross-midnight
          noteStart = dayMs + sMin * 60_000;
          noteEnd = dayMs + MS_PER_DAY + eMin * 60_000;
        }
      }
      if (shiftStartMs < noteEnd && shiftEndMs > noteStart) return true;
    }
  }
  return false;
}

function calcShiftBrutto(shift: ShiftBlock, hourlyRate: number, bundesland?: string | null): number {
  let cents = (shift.duration_minutes * hourlyRate * 100) / 60;
  cents += (shift.nachtarbeit_minutes * hourlyRate * 100 * PREM_NIGHT) / 60;
  if (isSundayLocal(shift.service_date)) {
    cents += (shift.duration_minutes * hourlyRate * 100 * PREM_SUN) / 60;
  }
  if (isHoliday(shift.service_date, bundesland)) {
    cents += (shift.duration_minutes * hourlyRate * 100 * PREM_HOLIDAY) / 60;
  }
  return Math.round(cents) / 100;
}

function calcCandidateBrutto(candidate: TransferCandidate, hourlyRate: number, bundesland?: string | null): number {
  return Math.round(
    candidate.shifts.reduce((sum, s) => sum + calcShiftBrutto(s, hourlyRate, bundesland), 0) * 100,
  ) / 100;
}

function buildCandidates(src: DriverDeviation, bundesland?: string | null): TransferCandidate[] {
  if (!src.hourly_rate || src.hourly_rate <= 0) return [];
  const rate = src.hourly_rate;

  const candidates: TransferCandidate[] = [];

  // Group shifts by service_date
  const byDate = new Map<string, ShiftBlock[]>();
  for (const s of src.shifts) {
    const list = byDate.get(s.service_date) ?? [];
    list.push(s);
    byDate.set(s.service_date, list);
  }

  for (const [date, dayShifts] of byDate.entries()) {
    const atomicShifts = dayShifts.filter(s => !s.block_id.includes('+'));

    // Level 1: single shifts
    for (const s of atomicShifts) {
      const brutto = calcShiftBrutto(s, rate, bundesland);
      if (brutto <= 0) continue;
      candidates.push({
        shifts: [s],
        transfer_type: 'single',
        labelKey: 'stn.candidate.single',
        labelVars: { from: fmtTime(s.block_start_ms), to: fmtTime(s.block_end_ms) },
        brutto_at_source_rate: brutto,
        duration_minutes: s.duration_minutes,
      });
    }

    // Level 2: same-day multi-shift combos (pairs/triples, excluding full-day)
    if (atomicShifts.length >= 2) {
      for (let i = 0; i < atomicShifts.length; i++) {
        for (let j = i + 1; j < atomicShifts.length; j++) {
          const combo = [atomicShifts[i], atomicShifts[j]];
          const brutto = combo.reduce((s, sh) => s + calcShiftBrutto(sh, rate, bundesland), 0);
          if (brutto <= 0) continue;
          const dur = combo.reduce((s, sh) => s + sh.duration_minutes, 0);
          candidates.push({
            shifts: combo,
            transfer_type: 'multi_day',
            labelKey: 'stn.candidate.multiSameDay',
            labelVars: { date: fmtDate(date) },
            brutto_at_source_rate: Math.round(brutto * 100) / 100,
            duration_minutes: dur,
          });
        }
      }
    }

    // Level 3: full day (all shifts on date, including compressed blocks)
    if (dayShifts.length > 0) {
      const allBrutto = dayShifts.reduce((s, sh) => s + calcShiftBrutto(sh, rate, bundesland), 0);
      if (allBrutto > 0) {
        const dur = dayShifts.reduce((s, sh) => s + sh.duration_minutes, 0);
        candidates.push({
          shifts: dayShifts,
          transfer_type: 'full_day',
          labelKey: dayShifts.length === 1 ? 'stn.candidate.fullDay.one' : 'stn.candidate.fullDay.other',
          labelVars: { date: fmtDate(date), count: dayShifts.length },
          brutto_at_source_rate: Math.round(allBrutto * 100) / 100,
          duration_minutes: dur,
        });
      }
    }
  }

  return candidates;
}

function buildDeviations(groups: DriverGroup[], tolerance: number): DriverDeviation[] {
  return groups
    .filter(g => (g.min_salary != null || g.max_salary != null || g.target_salary != null) && g.expected_brutto != null)
    .map(g => {
      const minSal = g.min_salary ?? g.target_salary ?? 0;
      const maxSal = g.max_salary ?? g.target_salary ?? 0;
      const midpoint = (minSal + maxSal) / 2;
      const actual = g.expected_brutto!;
      const diff = Math.round((actual - midpoint) * 100) / 100;
      let status: DeviationStatus = 'in_range';
      if (actual > maxSal + tolerance) status = 'over';
      else if (actual < minSal - tolerance) status = 'under';
      return {
        driver_id: g.driver_id,
        driver_name: g.driver_name,
        target: midpoint,
        min_salary: g.min_salary,
        max_salary: g.max_salary,
        actual,
        diff,
        status,
        shifts: g.shifts,
        hourly_rate: g.hourly_rate,
      };
    })
    .sort((a, b) => b.diff - a.diff);
}

function buildTransferSuggestions(
  deviations: DriverDeviation[],
  tolerance: number,
  bundesland?: string | null,
): TransferSuggestion[] {
  const overDrivers = deviations.filter(d => d.status === 'over');
  const underDrivers = deviations.filter(d => d.status === 'under');
  if (overDrivers.length === 0 || underDrivers.length === 0) return [];

  const MAX_PER_SOURCE = 5;
  const allSuggestions: TransferSuggestion[] = [];

  for (const src of overDrivers) {
    if (!src.hourly_rate || src.hourly_rate <= 0) continue;

    const candidates = buildCandidates(src, bundesland);
    const srcBeforeAbs = Math.abs(src.diff);

    // For each candidate, find the best under-target driver by impact score
    interface RankedSuggestion { suggestion: TransferSuggestion; impact: number }
    const ranked: RankedSuggestion[] = [];

    for (const candidate of candidates) {
      const srcBrutto = candidate.brutto_at_source_rate;

      if (srcBrutto < MIN_TRANSFER_BRUTTO) continue;

      for (const tgt of underDrivers) {
        if (!tgt.hourly_rate || tgt.hourly_rate <= 0) continue;

        const tgtBrutto = calcCandidateBrutto(candidate, tgt.hourly_rate, bundesland);
        const sourceAfter = Math.round((src.actual - srcBrutto) * 100) / 100;
        const targetAfter = Math.round((tgt.actual + tgtBrutto) * 100) / 100;
        const sourceAfterDiff = sourceAfter - src.target;
        const targetAfterDiff = targetAfter - tgt.target;

        // Reject if transfer doesn't help source (still more over than before)
        if (sourceAfterDiff >= src.diff) continue;
        // Reject if transfer doesn't help target
        if (targetAfterDiff <= tgt.diff) continue;
        // Penalize: source pushed below target beyond tolerance (would become under)
        if (sourceAfterDiff < -tolerance * 1.5) continue;
        // Penalize: target pushed above target beyond tolerance (would become over)
        if (targetAfterDiff > tolerance * 1.5) continue;

        const tgtBeforeAbs = Math.abs(tgt.diff);
        const sourceAfterAbs = Math.abs(sourceAfterDiff);
        const targetAfterAbs = Math.abs(targetAfterDiff);
        const impact = srcBeforeAbs + tgtBeforeAbs - sourceAfterAbs - targetAfterAbs;

        ranked.push({
          impact,
          suggestion: {
            source_driver_id: src.driver_id,
            source_driver_name: src.driver_name,
            source_diff: src.diff,
            target_driver_id: tgt.driver_id,
            target_driver_name: tgt.driver_name,
            target_diff: tgt.diff,
            candidate,
            shift_brutto: srcBrutto,
            source_after: sourceAfter,
            target_after: targetAfter,
            impact_score: impact,
            // Placeholder: every suggestion is replaced by validateTransfer's
            // result before it reaches the UI, so this text never renders.
            validation: {
              status: 'pruefung_erforderlich' as ValidationStatus,
              reasons: [],
              noteBlocked: false,
              overlapDetected: false,
            },
          },
        });
      }
    }

    // Pick top MAX_PER_SOURCE by impact, deduplicate by candidate label+target
    ranked.sort((a, b) => b.impact - a.impact);
    const seen = new Set<string>();
    let count = 0;
    for (const { suggestion } of ranked) {
      if (count >= MAX_PER_SOURCE) break;
      const key = `${suggestion.candidate.labelKey}|${JSON.stringify(suggestion.candidate.labelVars)}|${suggestion.target_driver_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allSuggestions.push(suggestion);
      count++;
    }
  }

  // Final sort: highest impact overall
  allSuggestions.sort((a, b) => b.impact_score - a.impact_score);
  return allSuggestions;
}

// ─── Validation ───────────────────────────────────────────────────────────────

const WEEKDAY_CODES: Record<number, string> = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat' };

// Weekday codes are data (they index the tables above); the names shown next to
// them are TranslationKeys, resolved wherever the reason text is built.
const WEEKDAY_NAME_KEYS: Record<string, TranslationKey> = {
  mon: 'fleet.weekday.mon', tue: 'fleet.weekday.tue', wed: 'fleet.weekday.wed',
  thu: 'fleet.weekday.thu', fri: 'fleet.weekday.fri', sat: 'fleet.weekday.sat',
  sun: 'fleet.weekday.sun',
};

const ALL_WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAYS_ONLY = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WEEKEND_ONLY = ['sat', 'sun'];

interface EffectiveWeekdays {
  codes: string[];
  source: 'business_rule_ahmed' | 'business_rule_alev' | 'business_rule_all_week';
  labelKey: TranslationKey;
}

// Transfer Analysis weekday availability — DB data is intentionally bypassed here
// because planning_working_days is not yet reliably populated for all drivers.
// Business rules take full precedence for this read-only analysis.
function getTransferAnalysisWeekdayAvailability(driverName: string): EffectiveWeekdays {
  // Normalize: lowercase, collapse multiple spaces, strip accents for matching
  const n = driverName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  if (n.includes('ahmed') && n.includes('hemaid')) {
    return { codes: WEEKEND_ONLY, source: 'business_rule_ahmed', labelKey: 'stn.weekdayRule.weekendOnly' };
  }

  // Match "alev" + ("buyukay" or "büyükay" — accent already stripped above)
  if (n.includes('alev') && (n.includes('buyukay') || n.includes('b yukay'))) {
    return { codes: WEEKDAYS_ONLY, source: 'business_rule_alev', labelKey: 'stn.weekdayRule.weekdaysOnly' };
  }

  return { codes: ALL_WEEK, source: 'business_rule_all_week', labelKey: 'stn.weekdayRule.allWeek' };
}

function timeHHMMtoMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m ?? 0);
}

function shiftMinutesFromMidnight(ms: number, serviceDate: string): number {
  const midnight = new Date(`${serviceDate}T00:00`).getTime();
  return Math.round((ms - midnight) / 60000);
}

function validateTransfer(
  suggestion: TransferSuggestion,
  deviations: DriverDeviation[],
  allGroups: DriverGroup[],
  wageMap: Map<string, DriverWage>,
  tolerance: number,
  driverNotesMap: Map<string, DriverNote[]>,
  translate: (key: TranslationKey, vars?: TranslationVars) => string,
): ValidationResult {
  const reasons: string[] = [];
  let hardFail = false;
  let needsReview = false;
  let noteBlocked = false;
  let overlapDetected = false;

  const candidate = suggestion.candidate;
  const tgtDev = deviations.find(d => d.driver_id === suggestion.target_driver_id);
  const srcDev = deviations.find(d => d.driver_id === suggestion.source_driver_id);
  const tgtGroup = allGroups.find(g => g.driver_id === suggestion.target_driver_id);
  const tgtWage = wageMap.get(suggestion.target_driver_id);

  if (!tgtDev || !srcDev || !tgtGroup || !tgtWage) {
    return {
      status: 'pruefung_erforderlich',
      reasons: [translate('stn.reason.driverDataIncomplete')],
      noteBlocked: false,
      overlapDetected: false,
    };
  }

  // ── Check 0: Target driver note constraint ────────────────────────────────
  {
    const tgtNotes = driverNotesMap.get(suggestion.target_driver_id) ?? [];
    for (const candidateShift of candidate.shifts) {
      if (isNoteBlockingTransfer(tgtNotes, candidateShift.block_start_ms, candidateShift.block_end_ms)) {
        hardFail = true;
        noteBlocked = true;
        reasons.push(translate('stn.reason.noteBlocked', { date: fmtDate(candidateShift.service_date) }));
        break;
      }
    }
  }

  // ── Check 1: Target driver overlap ───────────────────────────────────────
  for (const candidateShift of candidate.shifts) {
    const csStart = candidateShift.block_start_ms;
    const csEnd = candidateShift.block_end_ms;
    for (const tgtShift of tgtGroup.shifts) {
      if (tgtShift.block_start_ms < csEnd && tgtShift.block_end_ms > csStart) {
        hardFail = true;
        overlapDetected = true;
        reasons.push(translate('stn.reason.targetOverlap', {
          date: fmtDate(candidateShift.service_date),
          from: fmtTime(tgtShift.block_start_ms),
          to: fmtTime(tgtShift.block_end_ms),
        }));
        break;
      }
    }
  }

  // ── Check 2: Source driver remaining validity ─────────────────────────────
  const srcGroup = allGroups.find(g => g.driver_id === suggestion.source_driver_id);
  if (srcGroup) {
    const transferredIds = new Set(candidate.shifts.map(s => s.block_id));
    const remaining = srcGroup.shifts.filter(s => !transferredIds.has(s.block_id));
    const remainingMinutes = remaining.reduce((s, sh) => s + sh.duration_minutes, 0);
    if (remainingMinutes < 0) {
      hardFail = true;
      reasons.push(translate('stn.reason.sourceNegativeDuration'));
    } else if (suggestion.source_after < 0) {
      hardFail = true;
      reasons.push(translate('stn.reason.sourceNegativeGross'));
    }
  } else {
    needsReview = true;
    reasons.push(translate('stn.reason.sourceDataUnavailable'));
  }

  // ── Check 3: Vehicle overlap ──────────────────────────────────────────────
  // Check if any of the transferred vehicles are already assigned to another driver at the same time
  const transferredVehicles = candidate.shifts.map(s => s.vehicle).filter(Boolean);
  if (transferredVehicles.length > 0) {
    for (const g of allGroups) {
      if (g.driver_id === suggestion.source_driver_id) continue; // source itself
      if (g.driver_id === suggestion.target_driver_id) continue; // target (handled separately)
      for (const candidateShift of candidate.shifts) {
        if (!candidateShift.vehicle) continue;
        for (const otherShift of g.shifts) {
          if (otherShift.vehicle !== candidateShift.vehicle) continue;
          if (otherShift.block_start_ms < candidateShift.block_end_ms &&
              otherShift.block_end_ms > candidateShift.block_start_ms) {
            hardFail = true;
            overlapDetected = true;
            reasons.push(translate('stn.reason.vehicleOverlap', {
              vehicle: candidateShift.vehicle,
              driver: g.driver_name,
              from: fmtTime(otherShift.block_start_ms),
              to: fmtTime(otherShift.block_end_ms),
            }));
          }
        }
      }
    }
  } else {
    needsReview = true;
    reasons.push(translate('stn.reason.vehicleIdUnavailable'));
  }

  // ── Check 4: Target driver max 3 Schichten/day ────────────────────────────
  if (!hardFail) {
    const affectedDates = new Set(candidate.shifts.map(s => s.service_date));
    for (const date of affectedDates) {
      const tgtOnDate = tgtGroup.shifts.filter(s => s.service_date === date).length;
      const transferredOnDate = candidate.shifts.filter(s => s.service_date === date).length;
      const totalAfter = tgtOnDate + transferredOnDate;
      if (totalAfter > MAX_SCHICHTEN_PER_DAY) {
        // Check if compression can handle it
        if (totalAfter <= MAX_SCHICHTEN_PER_DAY + 2) {
          // compression merges adjacent pairs — can reduce by 1 per merge
          const mergesNeeded = totalAfter - MAX_SCHICHTEN_PER_DAY;
          if (mergesNeeded <= Math.floor(totalAfter / 2)) {
            reasons.push(translate('stn.reason.willCompress', {
              date: fmtDate(date), total: totalAfter, max: MAX_SCHICHTEN_PER_DAY,
            }));
          } else {
            hardFail = true;
            reasons.push(translate('stn.reason.tooManyShifts', {
              date: fmtDate(date), total: totalAfter, max: MAX_SCHICHTEN_PER_DAY,
            }));
          }
        } else {
          hardFail = true;
          reasons.push(translate('stn.reason.tooManyShifts', {
            date: fmtDate(date), total: totalAfter, max: MAX_SCHICHTEN_PER_DAY,
          }));
        }
      }
    }
  }

  // ── Check 5: Target driver Arbeitszeit ───────────────────────────────────
  if (tgtWage.is_full_day_available) {
    reasons.push(translate('stn.reason.fullDayAvailable'));
  } else if (tgtWage.planned_shift_start_time && tgtWage.planned_shift_end_time) {
    const windowStart = timeHHMMtoMinutes(tgtWage.planned_shift_start_time);
    const windowEnd = timeHHMMtoMinutes(tgtWage.planned_shift_end_time);
    const crossMidnight = windowStart > windowEnd;

    for (const candidateShift of candidate.shifts) {
      const shiftStartMin = shiftMinutesFromMidnight(candidateShift.block_start_ms, candidateShift.service_date);
      const shiftEndMin = shiftMinutesFromMidnight(candidateShift.block_end_ms, candidateShift.service_date);

      let fits: boolean;
      if (!crossMidnight) {
        fits = shiftStartMin >= windowStart && shiftEndMin <= windowEnd;
      } else {
        // cross-midnight window: fits if start >= windowStart OR end <= windowEnd
        fits = shiftStartMin >= windowStart || shiftEndMin <= windowEnd;
      }

      if (!fits) {
        hardFail = true;
        reasons.push(translate('stn.reason.outsideWorkWindow', {
          windowFrom: tgtWage.planned_shift_start_time,
          windowTo: tgtWage.planned_shift_end_time,
          shiftFrom: fmtTime(candidateShift.block_start_ms),
          shiftTo: fmtTime(candidateShift.block_end_ms),
        }));
      }
    }
    if (!hardFail) {
      reasons.push(translate('stn.reason.withinWorkWindow', {
        windowFrom: tgtWage.planned_shift_start_time,
        windowTo: tgtWage.planned_shift_end_time,
      }));
    }
  } else {
    needsReview = true;
    reasons.push(translate('stn.reason.workWindowNotConfigured'));
  }

  // ── Check 6: Allowed weekdays ─────────────────────────────────────────────
  {
    const effectiveWeekdays = getTransferAnalysisWeekdayAvailability(suggestion.target_driver_name);
    const allowedCodes = new Set(effectiveWeekdays.codes);
    let weekdayFailed = false;
    for (const candidateShift of candidate.shifts) {
      const d = new Date(`${candidateShift.service_date}T12:00`);
      const dayCode = WEEKDAY_CODES[d.getDay()];
      if (!allowedCodes.has(dayCode)) {
        hardFail = true;
        weekdayFailed = true;
        const nameKey = WEEKDAY_NAME_KEYS[dayCode];
        reasons.push(translate('stn.reason.weekdayNotAllowed', {
          day: nameKey ? translate(nameKey) : dayCode,
          allowed: translate(effectiveWeekdays.labelKey),
        }));
      }
    }
    if (!weekdayFailed) {
      const transferDays = [...new Set(candidate.shifts.map(s => {
        const d = new Date(`${s.service_date}T12:00`);
        const nameKey = WEEKDAY_NAME_KEYS[WEEKDAY_CODES[d.getDay()]];
        return nameKey ? translate(nameKey) : '';
      }))].join(', ');
      reasons.push(translate('stn.reason.weekdaysAllowed', {
        allowed: translate(effectiveWeekdays.labelKey),
        days: transferDays,
      }));
    }
  }

  // ── Check 7: Salary tolerance ─────────────────────────────────────────────
  const sourceNewDiff = suggestion.source_after - srcDev.target;
  const targetNewDiff = suggestion.target_after - tgtDev.target;

  if (targetNewDiff > tolerance) {
    hardFail = true;
    reasons.push(translate('stn.reason.targetOverTolerance', {
      amount: targetNewDiff.toFixed(2), tolerance,
    }));
  } else {
    reasons.push(translate('stn.reason.targetWithinTolerance', {
      amount: `${targetNewDiff >= 0 ? '+' : ''}${targetNewDiff.toFixed(2)}`,
    }));
  }

  if (sourceNewDiff < -tolerance) {
    needsReview = true;
    reasons.push(translate('stn.reason.sourceBelowTarget', {
      amount: sourceNewDiff.toFixed(2), tolerance,
    }));
  }

  // ── Final status ──────────────────────────────────────────────────────────
  let status: ValidationStatus;
  if (hardFail) {
    status = 'nicht_moeglich';
  } else if (needsReview) {
    status = 'pruefung_erforderlich';
  } else {
    status = 'gueltig';
    if (!overlapDetected) {
      reasons.unshift(translate('stn.reason.noTargetOverlap'));
    }
  }

  return { status, reasons, noteBlocked, overlapDetected };
}

interface PendingApply {
  suggestion: TransferSuggestion;
  tripIds: string[];
}

interface LastApplied {
  source: string;
  target: string;
  date: string;
  tripCount: number;
}

function GehaltsabweichungSection({
  groups,
  wageMap,
  rawTrips,
  onReload,
  runId,
  companyId,
  adjustmentMap,
  onAdjustmentSaved,
  onTransferApplied,
  bundesland,
}: {
  groups: DriverGroup[];
  wageMap: Map<string, DriverWage>;
  rawTrips: TripRow[];
  onReload: () => void;
  runId: string;
  companyId: string;
  adjustmentMap: Map<string, AdjustmentRecord[]>;
  onAdjustmentSaved: () => void;
  onTransferApplied?: () => void;
  bundesland?: string | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pendingApply, setPendingApply] = useState<PendingApply | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [lastApplied, setLastApplied] = useState<LastApplied | null>(null);
  const [transferAppliedCount, setTransferAppliedCount] = useState(0);
  const [savingAusgleich, setSavingAusgleich] = useState<string | null>(null); // driver_id being saved
  const [ausgleichError, setAusgleichError] = useState<string>('');
  const [isApplyingAllAusgleich, setIsApplyingAllAusgleich] = useState(false);
  const [applyAllMessage, setApplyAllMessage] = useState<string>('');
  // Tracked explicitly: the banner used to decide its colour by testing whether
  // the message started with "Fehler", which stops working once it is translated.
  const [applyAllHasError, setApplyAllHasError] = useState(false);
  const [driverNotesMap, setDriverNotesMap] = useState<Map<string, DriverNote[]>>(new Map());
  const tolerance = SALARY_TOLERANCE_DEFAULT;

  // Load exclude_from_plan notes for all drivers in this run
  useEffect(() => {
    const driverIds = groups.map(g => g.driver_id).filter(Boolean);
    if (driverIds.length === 0) return;
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('driver_notes')
        .select('driver_id, note_planning_behavior, is_full_day, start_date, end_date, note_date, start_time, end_time')
        .in('driver_id', driverIds)
        .eq('note_planning_behavior', 'exclude_from_plan');
      if (cancelled || !data) return;
      const m = new Map<string, DriverNote[]>();
      for (const row of data as DriverNote[]) {
        const arr = m.get(row.driver_id) ?? [];
        arr.push(row);
        m.set(row.driver_id, arr);
      }
      setDriverNotesMap(m);
    })();
    return () => { cancelled = true; };
  }, [groups]);

  const deviations = useMemo(() => buildDeviations(groups, tolerance), [groups, tolerance]);
  const rawSuggestions = useMemo(() => buildTransferSuggestions(deviations, tolerance, bundesland), [deviations, tolerance, bundesland]);
  const validatedSuggestions = useMemo(
    () => rawSuggestions.map(s => ({ ...s, validation: validateTransfer(s, deviations, groups, wageMap, tolerance, driverNotesMap, t) })),
    [rawSuggestions, deviations, groups, wageMap, tolerance, driverNotesMap, t],
  );

  const statusOrder: Record<ValidationStatus, number> = { gueltig: 0, pruefung_erforderlich: 1, nicht_moeglich: 2 };
  const suggestions = useMemo(
    () => [...validatedSuggestions].sort((a, b) => {
      const statusDiff = statusOrder[a.validation.status] - statusOrder[b.validation.status];
      return statusDiff !== 0 ? statusDiff : b.impact_score - a.impact_score;
    }),
    [validatedSuggestions],
  );

  // Build a lookup from block_id → trip IDs using raw trip rows
  const blockToTripIds = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const trip of rawTrips) {
      if (!trip.assignment_block_id || trip.is_canceled) continue;
      const arr = m.get(trip.assignment_block_id) ?? [];
      arr.push(trip.id);
      m.set(trip.assignment_block_id, arr);
    }
    return m;
  }, [rawTrips]);

  const requestApply = (suggestion: TransferSuggestion) => {
    if (suggestion.validation.status !== 'gueltig') return;
    const tripIds = suggestion.candidate.shifts.flatMap(s => blockToTripIds.get(s.block_id) ?? []);
    if (tripIds.length === 0) {
      setApplyError(t('stn.transfer.noTripsFound'));
      return;
    }
    setApplyError('');
    setPendingApply({ suggestion, tripIds });
  };

  const confirmApply = async () => {
    if (!pendingApply) return;
    const { suggestion, tripIds } = pendingApply;

    // Re-run validation before writing (includes note check)
    const freshValidation = validateTransfer(suggestion, deviations, groups, wageMap, tolerance, driverNotesMap, t);
    if (freshValidation.status !== 'gueltig') {
      setPendingApply(null);
      setApplyError(
        freshValidation.noteBlocked
          ? t('stn.transfer.blockedByNote')
          : t('stn.transfer.validationStale'),
      );
      return;
    }

    setApplying(true);
    setApplyError('');
    let updatedCount = 0;

    /*
     * Mark this run's active finalization stale, and reload.
     *
     * One function because **both** exits need it. A transfer is a loop of
     * `reassign_fahrtenbuch_trip` calls with no transaction — CLAUDE.md records
     * the non-atomicity as a known defect and it stays — so a failure part way
     * through leaves the earlier trips already moved. Until now the failure path
     * returned before this write, so the finalization went on reading
     * `is_stale = false` over trips that had changed underneath it: the operator
     * saw the error, the documents stayed downloadable, and nothing said they no
     * longer matched the data. 10 production finalizations exist and all 10 are
     * `is_stale = false`.
     *
     * `stale_reason` names the partial case separately, because "a transfer was
     * applied" and "a transfer was applied to some of its trips and then failed"
     * are different facts for whoever reads the audit row. It is stored audit
     * text and stays German, like the reason and note the RPC persists above.
     */
    const markStaleAndReload = (partialOf: number | null) => {
      void supabase
        .from('planning_finalizations')
        .update({
          is_stale: true,
          stale_reason: partialOf === null
            ? 'Transfer nach Finalisierung angewendet'
            : `Transfer nach Finalisierung teilweise angewendet: ${updatedCount} von ${partialOf} Fahrten`,
          stale_at: new Date().toISOString(),
        })
        .eq('planning_run_id', runId)
        .eq('is_stale', false);
      onReload();
      onTransferApplied?.();
    };

    for (const tripId of tripIds) {
      const { data, error } = await supabase.rpc('reassign_fahrtenbuch_trip', {
        p_trip_id: tripId,
        p_new_driver_id: suggestion.target_driver_id,
        p_new_driver_name: suggestion.target_driver_name,
        p_plausibility_status: 'planned_reassignment',
        // p_reason / p_note are persisted as the trip's audit trail, not shown
        // as a label — they stay German so the record reads consistently.
        p_reason: `Gehaltsausgleich: Transfer von ${suggestion.source_driver_name}`,
        p_note: `Transfer angewendet via Gehaltsabweichung-Analyse`,
      });
      if (error || (data && data.success === false)) {
        setApplyError(t('stn.transfer.applyFailed', {
          tripId,
          error: error?.message ?? data?.error ?? t('stn.transfer.unknownError'),
          updated: updatedCount,
          total: tripIds.length,
        }));
        setApplying(false);
        setPendingApply(null);
        // Only when something actually moved. A transfer that failed on its first
        // trip changed nothing, so the finalization is still true and marking it
        // stale would send the operator to re-finalize over identical data.
        if (updatedCount > 0) markStaleAndReload(tripIds.length);
        return;
      }
      updatedCount++;
    }

    setLastApplied({
      source: suggestion.source_driver_name,
      target: suggestion.target_driver_name,
      date: suggestion.candidate.shifts.map(s => fmtDate(s.service_date)).join(', '),
      tripCount: updatedCount,
    });

    setApplying(false);
    setPendingApply(null);
    setTransferAppliedCount(c => c + 1);
    markStaleAndReload(null);
  };

  const applyAusgleich = async (dev: DriverDeviation) => {
    if (!dev.hourly_rate || dev.hourly_rate <= 0) return;
    const missingAmount = Math.round((dev.target - dev.actual) * 100) / 100;
    if (missingAmount <= 0) return;
    const neededHours = Math.round((missingAmount / dev.hourly_rate) * 100) / 100;
    setSavingAusgleich(dev.driver_id);
    setAusgleichError('');
    const { error } = await supabase.from('planning_run_adjustments').insert({
      planning_run_id: runId,
      company_id: companyId,
      driver_id: dev.driver_id,
      driver_name: dev.driver_name,
      adjustment_type: 'gehaltsausgleich',
      hours: neededHours,
      amount: missingAmount,
      hourly_rate: dev.hourly_rate,
    });
    setSavingAusgleich(null);
    if (error) {
      setAusgleichError(t('stn.ausgleich.saveFailed', { error: error.message }));
    } else {
      onAdjustmentSaved();
    }
  };

  const removeAusgleich = async (driverId: string) => {
    const adjs = adjustmentMap.get(driverId) ?? [];
    if (adjs.length === 0) return;
    setSavingAusgleich(driverId);
    setAusgleichError('');
    let outcome: WriteOutcome | { error: string };
    try {
      outcome = await deleteChecked(supabase, 'planning_run_adjustments', q => q.in('id', adjs.map(a => a.id)), adjs.length);
    } catch (e: any) {
      outcome = { error: e?.message ?? '' };
    }
    setSavingAusgleich(null);
    if (typeof outcome === 'object') {
      setAusgleichError(t('stn.ausgleich.removeFailed', { error: outcome.error }));
    } else if (outcome === 'refused') {
      setAusgleichError(t('common.writeRefused'));
    } else {
      onAdjustmentSaved();
    }
  };

  const applyAllAusgleich = async () => {
    const underDrivers = deviations.filter(d => d.status === 'under' && d.hourly_rate && d.hourly_rate > 0);
    // Only drivers without an existing adjustment
    const pending = underDrivers.filter(dev => (adjustmentMap.get(dev.driver_id) ?? []).length === 0);
    if (pending.length === 0) {
      setApplyAllMessage(t('stn.ausgleich.allAlreadyApplied'));
      setApplyAllHasError(false);
      return;
    }
    setIsApplyingAllAusgleich(true);
    setApplyAllMessage('');
    setApplyAllHasError(false);
    setAusgleichError('');

    const applied: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    for (const dev of pending) {
      const missingAmount = Math.round((dev.target - dev.actual) * 100) / 100;
      if (missingAmount <= 0 || !dev.hourly_rate || dev.hourly_rate <= 0) {
        skipped.push(dev.driver_name);
        continue;
      }
      const neededHours = Math.round((missingAmount / dev.hourly_rate) * 100) / 100;
      const { error } = await supabase.from('planning_run_adjustments').insert({
        planning_run_id: runId,
        company_id: companyId,
        driver_id: dev.driver_id,
        driver_name: dev.driver_name,
        adjustment_type: 'gehaltsausgleich',
        hours: neededHours,
        amount: missingAmount,
        hourly_rate: dev.hourly_rate,
      });
      if (error) {
        failed.push(`${dev.driver_name}: ${error.message}`);
      } else {
        applied.push(dev.driver_name);
      }
    }

    setIsApplyingAllAusgleich(false);

    const parts: string[] = [];
    if (applied.length > 0) parts.push(t('stn.ausgleich.appliedFor', { drivers: applied.join(', ') }));
    if (skipped.length > 0) parts.push(t('stn.ausgleich.someSkipped'));
    if (failed.length > 0) parts.push(t('stn.ausgleich.errors', { errors: failed.join('; ') }));
    setApplyAllMessage(parts.join(' '));
    setApplyAllHasError(failed.length > 0);

    if (applied.length > 0) {
      onAdjustmentSaved();
    }
  };
  const overCount = deviations.filter(d => d.status === 'over').length;
  const underCount = deviations.filter(d => d.status === 'under').length;
  const totalOver = deviations.filter(d => d.status === 'over').reduce((s, d) => s + d.diff, 0);
  const totalUnder = deviations.filter(d => d.status === 'under').reduce((s, d) => s + Math.abs(d.diff), 0);
  const netDiff = Math.round((totalOver - totalUnder) * 100) / 100;

  const driversPresentWithTarget = deviations.length;

  if (driversPresentWithTarget === 0) return null;

  const fmtDiff = (v: number) => {
    const sign = v >= 0 ? '+' : '';
    return `${sign}${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  };
  const fmtEuroVal = (v: number) =>
    v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

  const statusColor = (s: DeviationStatus) =>
    s === 'over' ? '#f87171' : s === 'under' ? '#fcd34d' : '#86efac';
  const statusLabel = (s: DeviationStatus) =>
    s === 'over' ? t('stn.summary.aboveMaxSalary')
      : s === 'under' ? t('stn.summary.belowMinSalary')
        : t('stn.summary.inSalaryRange');

  const transferTypeLabel = (type: TransferType) =>
    type === 'single' ? t('stn.transferType.single')
      : type === 'multi_day' ? t('stn.transferType.multiDay')
        : t('stn.transferType.fullDay');

  return (
    <>
    {/* Confirmation dialog */}
    {pendingApply && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.65)' }}>
        <div className="rounded-xl shadow-2xl p-6 max-w-sm w-full space-y-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2">
            <ArrowRightLeft size={16} style={{ color: '#86efac' }} />
            <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{t('stn.transfer.confirmTitle')}</h3>
          </div>
          <div className="text-xs space-y-1.5 rounded-lg px-3 py-2.5" style={{ background: 'var(--bg-surface)', color: 'var(--text-secondary)' }}>
            <div className="flex gap-2"><span style={{ color: 'var(--text-tertiary)' }}>{t('stn.transfer.from')}</span><strong>{pendingApply.suggestion.source_driver_name}</strong></div>
            <div className="flex gap-2"><span style={{ color: 'var(--text-tertiary)' }}>{t('stn.transfer.to')}</span><strong>{pendingApply.suggestion.target_driver_name}</strong></div>
            <div className="flex gap-2"><span style={{ color: 'var(--text-tertiary)' }}>{t('common.date')}:</span><span>{pendingApply.suggestion.candidate.shifts.map(s => fmtDate(s.service_date)).join(', ')}</span></div>
            <div className="flex gap-2"><span style={{ color: 'var(--text-tertiary)' }}>{t('stn.transfer.type')}</span><span>{transferTypeLabel(pendingApply.suggestion.candidate.transfer_type)}</span></div>
            <div className="flex gap-2"><span style={{ color: 'var(--text-tertiary)' }}>{t('stn.transfer.gross')}</span><strong style={{ color: '#86efac' }}>{pendingApply.suggestion.shift_brutto.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</strong></div>
            <div className="flex gap-2"><span style={{ color: 'var(--text-tertiary)' }}>{t('stn.label.trips')}:</span><span>{t('stn.transfer.tripCount', { count: pendingApply.tripIds.length })}</span></div>
          </div>
          <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {t('stn.transfer.confirmHint')}
          </p>
          {applyError && (
            <div className="text-[11px] rounded px-2 py-1.5" style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.3)' }}>
              {applyError}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => { setPendingApply(null); setApplyError(''); }}
              disabled={applying}
              className="flex-1 px-3 py-2 rounded text-xs font-medium transition-all hover:brightness-110 disabled:opacity-50"
              style={{ background: 'var(--bg-surface)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={confirmApply}
              disabled={applying}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded text-xs font-semibold transition-all hover:brightness-110 disabled:opacity-50"
              style={{ background: 'rgba(134,239,172,0.2)', color: '#86efac', border: '1px solid rgba(134,239,172,0.4)' }}
            >
              {applying ? <Loader2 size={12} className="animate-spin" /> : <ArrowRightLeft size={12} />}
              {applying ? t('stn.transfer.applying') : t('stn.transfer.apply')}
            </button>
          </div>
        </div>
      </div>
    )}

    <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:brightness-110 transition-all"
        style={{ background: 'var(--bg-surface)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('stn.dev.title')}
          </span>
          <div className="flex items-center gap-1.5 text-[11px]">
            {overCount > 0 && (
              <span className="px-1.5 py-0.5 rounded font-semibold" style={{ background: 'rgba(248,113,113,0.15)', color: '#f87171' }}>
                {t('stn.dev.badgeOverTarget', { count: overCount })}
              </span>
            )}
            {underCount > 0 && (
              <span className="px-1.5 py-0.5 rounded font-semibold" style={{ background: 'rgba(252,211,77,0.15)', color: '#fcd34d' }}>
                {t('stn.dev.badgeUnderTarget', { count: underCount })}
              </span>
            )}
            {adjustmentMap.size > 0 && (
              <span className="px-1.5 py-0.5 rounded font-semibold" style={{ background: 'rgba(134,239,172,0.15)', color: '#86efac' }}>
                {t('stn.dev.badgeAdjustments', { count: adjustmentMap.size })}
              </span>
            )}
            {suggestions.length > 0 && (() => {
              const valid = suggestions.filter(s => s.validation.status === 'gueltig').length;
              const invalid = suggestions.filter(s => s.validation.status === 'nicht_moeglich').length;
              return (
                <>
                  {valid > 0 && (
                    <span className="px-1.5 py-0.5 rounded font-semibold" style={{ background: 'rgba(134,239,172,0.15)', color: '#86efac' }}>
                      {t('stn.dev.badgeValid', { count: valid })}
                    </span>
                  )}
                  {invalid > 0 && (
                    <span className="px-1.5 py-0.5 rounded font-semibold" style={{ background: 'rgba(248,113,113,0.15)', color: '#f87171' }}>
                      {t('stn.dev.badgeImpossible', { count: invalid })}
                    </span>
                  )}
                  {suggestions.length - valid - invalid > 0 && (
                    <span className="px-1.5 py-0.5 rounded font-semibold" style={{ background: 'rgba(147,197,253,0.15)', color: '#93c5fd' }}>
                      {t('stn.dev.badgeReview', { count: suggestions.length - valid - invalid })}
                    </span>
                  )}
                </>
              );
            })()}
          </div>
        </div>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-3 space-y-4" style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>

          {/* Section 1: Deviation table */}
          <div>
            <p className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
              {t('stn.dev.tableTitle', { tolerance })}
            </p>
            <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--border)' }}>
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)' }}>
                    <th className="px-3 py-2 text-left font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('common.driver')}</th>
                    <th className="px-3 py-2 text-right font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('stn.dev.col.salaryRange')}</th>
                    <th className="px-3 py-2 text-right font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('stn.dev.col.expectedGross')}</th>
                    <th className="px-3 py-2 text-right font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('stn.dev.col.difference')}</th>
                    <th className="px-3 py-2 text-left font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('common.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {deviations.map(d => (
                    <tr key={d.driver_id} style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
                      <td className="px-3 py-2 font-medium" style={{ color: 'var(--text-primary)' }}>{d.driver_name}</td>
                      <td className="px-3 py-2 text-right font-mono" style={{ color: 'var(--text-secondary)' }}>
                        {d.min_salary != null && d.max_salary != null
                          ? `${fmtEuroVal(d.min_salary)} – ${fmtEuroVal(d.max_salary)}`
                          : fmtEuroVal(d.target)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono" style={{ color: 'var(--text-primary)' }}>{fmtEuroVal(d.actual)}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold" style={{ color: statusColor(d.status) }}>
                        {fmtDiff(d.diff)}
                      </td>
                      <td className="px-3 py-2">
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: `${statusColor(d.status)}20`, color: statusColor(d.status) }}>
                          {statusLabel(d.status)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Section 2: Summary */}
          <div className="rounded-lg px-4 py-3 text-xs grid grid-cols-2 sm:grid-cols-5 gap-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div>
              <div style={{ color: 'var(--text-tertiary)' }}>{t('stn.dev.overTarget')}</div>
              <div className="font-bold mt-0.5" style={{ color: '#f87171' }}>{t('stn.dev.driverCount', { count: overCount })}</div>
            </div>
            <div>
              <div style={{ color: 'var(--text-tertiary)' }}>{t('stn.dev.underTarget')}</div>
              <div className="font-bold mt-0.5" style={{ color: '#fcd34d' }}>{t('stn.dev.driverCount', { count: underCount })}</div>
            </div>
            <div>
              <div style={{ color: 'var(--text-tertiary)' }}>{t('stn.dev.totalOver')}</div>
              <div className="font-bold mt-0.5" style={{ color: '#f87171' }}>{fmtEuroVal(Math.round(totalOver * 100) / 100)}</div>
            </div>
            <div>
              <div style={{ color: 'var(--text-tertiary)' }}>{t('stn.dev.totalUnder')}</div>
              <div className="font-bold mt-0.5" style={{ color: '#fcd34d' }}>{fmtEuroVal(Math.round(totalUnder * 100) / 100)}</div>
            </div>
            <div>
              <div style={{ color: 'var(--text-tertiary)' }}>{t('stn.dev.netDeviation')}</div>
              <div className="font-bold mt-0.5" style={{ color: netDiff > 0 ? '#f87171' : netDiff < 0 ? '#fcd34d' : '#86efac' }}>
                {fmtDiff(netDiff)}
              </div>
            </div>
          </div>

          {/* Section 3: Ausgleichsstunden suggestions for under-target drivers */}
          {(() => {
            const underDrivers = deviations.filter(d => d.status === 'under' && d.hourly_rate && d.hourly_rate > 0);
            if (underDrivers.length === 0) return null;
            return (
              <div>
                <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                  <p className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    {t('stn.ausgleich.suggestionsTitle', { count: underDrivers.length })}
                  </p>
                  {underDrivers.filter(dev => (adjustmentMap.get(dev.driver_id) ?? []).length === 0).length > 1 && (
                    <button
                      type="button"
                      onClick={() => void applyAllAusgleich()}
                      disabled={isApplyingAllAusgleich || !!savingAusgleich}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-semibold transition-all hover:brightness-110 disabled:opacity-50"
                      style={{ background: 'rgba(252,211,77,0.15)', color: '#fcd34d', border: '1px solid rgba(252,211,77,0.35)' }}
                    >
                      {isApplyingAllAusgleich ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                      {isApplyingAllAusgleich ? t('stn.ausgleich.applyingAll') : t('stn.ausgleich.applyAll')}
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {underDrivers.map(dev => {
                    const missingAmount = Math.round((dev.target - dev.actual) * 100) / 100;
                    const neededHours = Math.round((missingAmount / dev.hourly_rate!) * 100) / 100;
                    const afterBrutto = Math.round((dev.actual + missingAmount) * 100) / 100;
                    const hasAdj = (adjustmentMap.get(dev.driver_id) ?? []).length > 0;
                    const existingAdj = adjustmentMap.get(dev.driver_id)?.[0];
                    const isSaving = savingAusgleich === dev.driver_id;
                    return (
                      <div
                        key={dev.driver_id}
                        className="rounded-lg px-3 py-2.5 text-xs space-y-2"
                        style={{ background: 'var(--bg-surface)', border: `1px solid ${hasAdj ? 'rgba(134,239,172,0.35)' : 'rgba(252,211,77,0.3)'}` }}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{dev.driver_name}</span>
                            <span className="ml-2" style={{ color: '#fcd34d' }}>
                              {t('stn.dev.underTarget')}: {fmtDiff(dev.diff)}
                            </span>
                          </div>
                          {hasAdj && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: 'rgba(134,239,172,0.15)', color: '#86efac' }}>
                              {t('stn.ausgleich.applied')}
                            </span>
                          )}
                        </div>
                        {hasAdj && existingAdj ? (
                          <div className="space-y-1.5">
                            <div className="grid grid-cols-3 gap-3 text-[11px]">
                              <div>
                                <div style={{ color: 'var(--text-tertiary)' }}>{t('stn.ausgleich.hours')}</div>
                                <div className="font-semibold" style={{ color: '#86efac' }}>{existingAdj.hours.toFixed(2).replace('.', ',')} h</div>
                              </div>
                              <div>
                                <div style={{ color: 'var(--text-tertiary)' }}>{t('common.amount')}</div>
                                <div className="font-semibold" style={{ color: '#86efac' }}>{fmtEuroVal(existingAdj.amount)}</div>
                              </div>
                              <div>
                                <div style={{ color: 'var(--text-tertiary)' }}>{t('stn.ausgleich.grossAfter')}</div>
                                <div className="font-semibold" style={{ color: '#86efac' }}>{fmtEuroVal(afterBrutto)}</div>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => void removeAusgleich(dev.driver_id)}
                              disabled={isSaving}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-semibold transition-all hover:brightness-110 disabled:opacity-50"
                              style={{ background: 'rgba(248,113,113,0.12)', color: '#f87171', border: '1px solid rgba(248,113,113,0.3)' }}
                            >
                              {isSaving ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
                              {t('stn.ausgleich.remove')}
                            </button>
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            <div className="grid grid-cols-3 gap-3 text-[11px]">
                              <div>
                                <div style={{ color: 'var(--text-tertiary)' }}>{t('stn.ausgleich.neededHours')}</div>
                                <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{neededHours.toFixed(2).replace('.', ',')} h</div>
                                <div style={{ color: 'var(--text-tertiary)', fontSize: 10 }}>{t('stn.ausgleich.atRate', { rate: dev.hourly_rate!.toFixed(2).replace('.', ',') })}</div>
                              </div>
                              <div>
                                <div style={{ color: 'var(--text-tertiary)' }}>{t('stn.ausgleich.shortfall')}</div>
                                <div className="font-semibold" style={{ color: '#fcd34d' }}>{fmtEuroVal(missingAmount)}</div>
                              </div>
                              <div>
                                <div style={{ color: 'var(--text-tertiary)' }}>{t('stn.ausgleich.grossAfter')}</div>
                                <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{fmtEuroVal(afterBrutto)}</div>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => void applyAusgleich(dev)}
                              disabled={isSaving}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-semibold transition-all hover:brightness-110 disabled:opacity-50"
                              style={{ background: 'rgba(252,211,77,0.15)', color: '#fcd34d', border: '1px solid rgba(252,211,77,0.35)' }}
                            >
                              {isSaving ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                              {t('stn.ausgleich.apply')}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {ausgleichError && (
                  <div className="mt-2 text-[11px] rounded px-2 py-1.5" style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.3)' }}>
                    {ausgleichError}
                  </div>
                )}
                {applyAllMessage && (
                  <div className="mt-2 text-[11px] rounded px-2 py-1.5" style={{ background: applyAllHasError ? 'rgba(248,113,113,0.1)' : 'rgba(134,239,172,0.1)', color: applyAllHasError ? '#f87171' : '#86efac', border: `1px solid ${applyAllHasError ? 'rgba(248,113,113,0.3)' : 'rgba(134,239,172,0.3)'}` }}>
                    {applyAllMessage}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Section 4: Transfer suggestions */}
          {(() => {
            if (overCount === 0 && underCount === 0) return null;

            // Check if all candidates were tiny (skipped due to MIN_TRANSFER_BRUTTO)
            const overDriversList = deviations.filter(d => d.status === 'over');
            const allCandidatesSmall = overDriversList.length > 0 && suggestions.length === 0 &&
              overDriversList.every(src => {
                if (!src.hourly_rate || src.hourly_rate <= 0) return true;
                return buildCandidates(src, bundesland).every(c => c.brutto_at_source_rate < MIN_TRANSFER_BRUTTO);
              });

            if (suggestions.length === 0 && !allCandidatesSmall) {
              return (
                <div className="text-xs py-2" style={{ color: 'var(--text-tertiary)' }}>
                  {t('stn.suggest.none')}
                </div>
              );
            }

            if (allCandidatesSmall) {
              return (
                <div className="rounded-lg px-3 py-2.5 text-xs" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-tertiary)' }}>
                  {t('stn.suggest.onlySmall', { min: MIN_TRANSFER_BRUTTO })}
                </div>
              );
            }

            const deviationMap = new Map(deviations.map(d => [d.driver_id, d]));

            const actionable = suggestions.filter(s => s.validation.status !== 'nicht_moeglich');
            const impossible = suggestions.filter(s => s.validation.status === 'nicht_moeglich');

            const bestActionable = actionable[0] ?? suggestions[0];

            const renderSuggestionGroup = (list: TransferSuggestion[]) => {
              const bySource = new Map<string, TransferSuggestion[]>();
              for (const s of list) {
                const arr = bySource.get(s.source_driver_id) ?? [];
                arr.push(s);
                bySource.set(s.source_driver_id, arr);
              }
              return Array.from(bySource.entries()).map(([srcId, srcSuggestions]) => {
                const srcDev = deviationMap.get(srcId);
                return (
                  <div key={srcId}>
                    <div className="text-[11px] font-semibold mb-1.5 flex items-center gap-2" style={{ color: '#f87171' }}>
                      <span>{t('stn.transfer.from')} {srcSuggestions[0].source_driver_name}</span>
                      <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}>
                        ({t('stn.suggest.currentValue', { value: fmtDiff(srcSuggestions[0].source_diff) })})
                      </span>
                    </div>
                    <div className="space-y-2">
                      {srcSuggestions.map((s, i) => {
                        const tgtDev = deviationMap.get(s.target_driver_id);
                        const sourceNewDiff = Math.round((s.source_after - (srcDev?.target ?? 0)) * 100) / 100;
                        const targetNewDiff = Math.round((s.target_after - (tgtDev?.target ?? 0)) * 100) / 100;
                        const vs = s.validation.status;
                        const vColor = vs === 'gueltig' ? '#86efac' : vs === 'nicht_moeglich' ? '#f87171' : '#fcd34d';
                        const vBg = vs === 'gueltig' ? 'rgba(134,239,172,0.15)' : vs === 'nicht_moeglich' ? 'rgba(248,113,113,0.15)' : 'rgba(245,158,11,0.18)';
                        const vLabel = vs === 'gueltig' ? t('stn.validity.valid')
                          : vs === 'nicht_moeglich' ? t('stn.validity.impossible')
                            : t('stn.validity.review');
                        return (
                          <div key={i} className="rounded-lg px-3 py-2.5 text-xs space-y-1.5" style={{ background: 'var(--bg-surface)', border: `1px solid ${vs === 'nicht_moeglich' ? 'rgba(248,113,113,0.25)' : 'var(--border)'}` }}>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <span className="font-semibold" style={{ color: '#fcd34d' }}>
                                {t('stn.transfer.to')} {s.target_driver_name}
                              </span>
                              <span style={{ color: 'var(--text-tertiary)', fontSize: 10 }}>
                                ({t('stn.suggest.currentValue', { value: fmtDiff(s.target_diff) })})
                              </span>
                              <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: 'rgba(134,239,172,0.12)', color: '#86efac' }}>
                                {t('stn.suggest.impact', { value: s.impact_score.toFixed(0) })}
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5" style={{ color: 'var(--text-secondary)' }}>
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: 'rgba(147,197,253,0.12)', color: '#93c5fd' }}>
                                {transferTypeLabel(s.candidate.transfer_type)}
                              </span>
                              <span style={{ color: 'var(--text-tertiary)' }}>{t(s.candidate.labelKey, s.candidate.labelVars)}</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5" style={{ color: 'var(--text-secondary)' }}>
                              <span>{t('stn.card.shifts')} <strong style={{ color: 'var(--text-primary)' }}>{s.candidate.shifts.length}</strong></span>
                              <span>{t('stn.transfer.gross')} <strong style={{ color: '#86efac' }}>{fmtEuroVal(s.shift_brutto)}</strong></span>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                              <span>
                                {t('stn.suggest.after', { driver: s.source_driver_name })}{' '}
                                <strong style={{ color: 'var(--text-secondary)' }}>{fmtEuroVal(s.source_after)}</strong>
                                {' '}({fmtDiff(sourceNewDiff)})
                              </span>
                              <span>
                                {t('stn.suggest.after', { driver: s.target_driver_name })}{' '}
                                <strong style={{ color: 'var(--text-secondary)' }}>{fmtEuroVal(s.target_after)}</strong>
                                {' '}({fmtDiff(targetNewDiff)})
                              </span>
                            </div>
                            <div className="pt-0.5 space-y-1">
                              <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: vBg, color: vColor }}>
                                {vLabel}
                              </span>
                              <ul className="text-[10px] space-y-0.5 pl-0 list-none" style={{ color: 'var(--text-tertiary)' }}>
                                {s.validation.reasons.map((r, ri) => (
                                  <li key={ri} className="flex items-start gap-1">
                                    <span style={{ color: vColor, flexShrink: 0 }}>–</span>
                                    <span>{r}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                            {vs === 'gueltig' && (
                              <div className="pt-1.5 border-t" style={{ borderColor: 'rgba(134,239,172,0.2)' }}>
                                <button
                                  type="button"
                                  onClick={() => requestApply(s)}
                                  disabled={applying}
                                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-semibold transition-all hover:brightness-110 disabled:opacity-50"
                                  style={{ background: 'rgba(134,239,172,0.15)', color: '#86efac', border: '1px solid rgba(134,239,172,0.35)' }}
                                >
                                  <ArrowRightLeft size={11} />
                                  {t('stn.transfer.apply')}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              });
            };

            return (
              <div className="space-y-4">
                {/* Beste Ausgleichsrichtung */}
                {bestActionable && (
                  <div className="rounded-lg px-3 py-2.5 text-xs" style={{ background: 'rgba(134,239,172,0.08)', border: '1px solid rgba(134,239,172,0.25)' }}>
                    <span className="font-semibold mr-2" style={{ color: '#86efac' }}>{t('stn.suggest.bestDirection')}</span>
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {bestActionable.source_driver_name} → {bestActionable.target_driver_name}
                      {' '}({t('stn.suggest.impactLabel')} <span className="font-mono">{bestActionable.impact_score.toFixed(0)} €</span>)
                      {' '}· {t(bestActionable.candidate.labelKey, bestActionable.candidate.labelVars)}
                    </span>
                  </div>
                )}

                {/* Actionable suggestions */}
                {actionable.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                      {t('stn.suggest.possible', { count: actionable.length })}
                    </p>
                    <div className="space-y-4">
                      {renderSuggestionGroup(actionable)}
                    </div>
                  </div>
                )}

                {/* Impossible suggestions collapsible */}
                {impossible.length > 0 && (
                  <details className="group">
                    <summary className="cursor-pointer text-xs font-semibold select-none flex items-center gap-1.5" style={{ color: '#f87171' }}>
                      <span className="group-open:rotate-90 inline-block transition-transform">▶</span>
                      {t('stn.suggest.impossible', { count: impossible.length })}
                    </summary>
                    <div className="mt-2 space-y-4">
                      {renderSuggestionGroup(impossible)}
                    </div>
                  </details>
                )}
              </div>
            );
          })()}

          {/* Apply error outside confirmation dialog */}
          {applyError && !pendingApply && (
            <div className="mx-3 mb-3 text-[11px] rounded px-2 py-1.5" style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.3)' }}>
              {applyError}
            </div>
          )}

          {/* Last applied transfer notice + post-transfer action required box */}
          {lastApplied && (
            <div className="mx-3 mb-3 space-y-2">
              {/* Success banner */}
              <div className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs" style={{ background: 'rgba(134,239,172,0.08)', border: '1px solid rgba(134,239,172,0.25)' }}>
                <CheckCircle2 size={13} style={{ color: '#86efac', flexShrink: 0, marginTop: 1 }} />
                <div style={{ color: 'var(--text-secondary)' }}>
                  <div className="font-semibold mb-0.5" style={{ color: '#86efac' }}>{t('stn.applied.banner')}</div>
                  <div>{lastApplied.source} → {lastApplied.target}</div>
                  <div style={{ color: 'var(--text-tertiary)' }}>{lastApplied.date} · {t('stn.applied.tripsUpdated', { count: lastApplied.tripCount })}</div>
                </div>
              </div>

              {/* Post-transfer required actions */}
              {transferAppliedCount > 0 && (
                <div className="rounded-lg px-3 py-3 text-xs space-y-2" style={{ background: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.35)', color: '#92400e' }}>
                  <div className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle size={12} />
                    {t('stn.applied.recheckTitle')}
                  </div>
                  <ul className="space-y-1 pl-1" style={{ color: 'var(--text-secondary)' }}>
                    <li>• {t('stn.applied.recheckQuality')}</li>
                    <li>• {t('stn.applied.recheckStundennachweis')}</li>
                    <li>• {t('stn.applied.recheckDocuments')}</li>
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
    </>
  );
}

export default MonatsplanungStundennachweisPreview