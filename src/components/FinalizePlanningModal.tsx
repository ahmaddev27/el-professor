/**
 * Finale Dokumente erstellen – modal for V1 planning finalization.
 *
 * Flow:
 *  1. Run pre-flight consistency checks against live DB data.
 *  2. If all checks pass, generate Fahrtenbuch XLSX + per-driver Stundennachweis
 *     summaries from the same data snapshot (same DB read).
 *  3. Persist a planning_finalizations record so stale detection works later.
 *  4. Trigger browser downloads for Fahrtenbuch XLSX.
 *  5. Expose download buttons for each Stundennachweis (PDF via existing util).
 *
 * Read-only from the trip perspective — no writes to fahrtenbuch_trips.
 * Only write: one INSERT into planning_finalizations.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  FileText,
  Loader2,
  Lock,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { exportAppliedRunXlsx, type AppliedRunSummary } from '../utils/monatsplanungXlsxExport';
import {
  exportStundennachweisAsPdf,
  type PdfDayRow,
  type PdfTotals,
} from '../utils/stundennachweisPdfExport';
import {
  resolveActualRideWindow,
  fmtAbsDateTime,
  fmtAbsTime,
  fmtAbsDate,
} from '../utils/planningQualityChecks';
import MonatsplanungStundennachweisPreview from './MonatsplanungStundennachweisPreview';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

// ── Types ──────────────────────────────────────────────────────────────────

const DEFAULT_CAR_SWITCH_GAP_MINUTES = 30;

interface Props {
  run: AppliedRunSummary;
  companyId: string;
  userId: string | undefined;
  onClose: () => void;
  /** Called after successful finalization so parent can reload and mark stale. */
  onFinalized: (finalizationId: string) => void;
}

/**
 * Stable, language-independent identity of a pre-flight check.
 *
 * The check name used to be its own identity: it was pushed as `label`, matched
 * with `===` in the blocked banner, and used to index `CHECK_SUGGESTIONS`.
 * Translating the name would have made those lookups miss silently, and a check
 * whose suggestions or banner text disappear is a check that stops protecting.
 * The id carries identity; the name is only ever rendered, via `CHECK_LABEL_KEYS`.
 */
type CheckId =
  | 'runPresent'
  | 'runStatus'
  | 'tripCount'
  | 'noDuplicateTrips'
  | 'driverAssigned'
  | 'blockIdPresent'
  | 'timesPresent'
  | 'maxThreeShifts'
  | 'vehicleSwitchGap'
  | 'driverOverlap'
  | 'vehicleOverlap'
  | 'stundennachweisCoverage'
  | 'stundennachweisPreview';

interface CheckResult {
  id: CheckId;
  ok: boolean;
  detail: string;
}

interface DriverSummary {
  id: string;
  name: string;
  trips: number;
  blocks: number;
  workMinutes: number;
  nightMinutes: number;
  sundayMinutes: number;
  expectedBrutto: number | null;
  /** Per-driver PDF rows built from the finalized snapshot. Available in-session only. */
  pdfData?: { rows: PdfDayRow[]; totals: PdfTotals };
}

interface FinalSnapshot {
  totalTrips: number;
  driverCount: number;
  drivers: DriverSummary[];
  driverSummaryJson: Record<string, unknown>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatError(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const parts: string[] = [];
    if (o['message']) parts.push(`Message: ${o['message']}`);
    if (o['details']) parts.push(`Details: ${o['details']}`);
    if (o['code']) parts.push(`Code: ${o['code']}`);
    if (o['hint']) parts.push(`Hint: ${o['hint']}`);
    if (parts.length > 0) return parts.join('\n');
    try { return JSON.stringify(err, null, 2); } catch { return String(err); }
  }
  return String(err);
}

/**
 * Month names for the generated Stundennachweis PDF and its filename. These
 * reach the Steuerberater on a statutory document, so they stay German in both
 * UI languages — the on-screen month uses `MONTH_KEYS` instead.
 */
const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/** Month names as rendered on screen. Resolved with t() at the call site. */
const MONTH_KEYS: readonly TranslationKey[] = [
  'doc.month.january', 'doc.month.february', 'doc.month.march',     'doc.month.april',
  'doc.month.may',     'doc.month.june',     'doc.month.july',      'doc.month.august',
  'doc.month.september', 'doc.month.october', 'doc.month.november', 'doc.month.december',
];

/** Display name per check. Identity lives in the `CheckId`, never in this text. */
const CHECK_LABEL_KEYS: Record<CheckId, TranslationKey> = {
  runPresent:              'fin.check.runPresent',
  runStatus:               'fin.check.runStatus',
  tripCount:               'fin.check.tripCount',
  noDuplicateTrips:        'fin.check.noDuplicateTrips',
  driverAssigned:          'fin.check.driverAssigned',
  blockIdPresent:          'fin.check.blockIdPresent',
  timesPresent:            'fin.check.timesPresent',
  maxThreeShifts:          'fin.check.maxThreeShifts',
  vehicleSwitchGap:        'fin.check.vehicleSwitchGap',
  driverOverlap:           'fin.check.driverOverlap',
  vehicleOverlap:          'fin.check.vehicleOverlap',
  stundennachweisCoverage: 'fin.check.stundennachweisCoverage',
  stundennachweisPreview:  'fin.check.stundennachweisPreview',
};

/**
 * Remediation hints per failed check, keyed by the stable id. Values are
 * TranslationKeys resolved where they are rendered.
 */
const CHECK_SUGGESTIONS: Partial<Record<CheckId, readonly TranslationKey[]>> = {
  vehicleSwitchGap: [
    'fin.suggest.vehicleSwitchGap.1',
    'fin.suggest.vehicleSwitchGap.2',
    'fin.suggest.vehicleSwitchGap.3',
    'fin.suggest.vehicleSwitchGap.4',
  ],
  driverOverlap: [
    'fin.suggest.driverOverlap.1',
    'fin.suggest.driverOverlap.2',
    'fin.suggest.driverOverlap.3',
  ],
  vehicleOverlap: [
    'fin.suggest.vehicleOverlap.1',
    'fin.suggest.vehicleOverlap.2',
    'fin.suggest.vehicleOverlap.3',
    'fin.suggest.vehicleOverlap.4',
  ],
  maxThreeShifts: [
    'fin.suggest.maxThreeShifts.1',
    'fin.suggest.maxThreeShifts.2',
    'fin.suggest.maxThreeShifts.3',
    'fin.suggest.maxThreeShifts.4',
  ],
  driverAssigned: [
    'fin.suggest.driverAssigned.1',
  ],
  blockIdPresent: [
    'fin.suggest.blockIdPresent.1',
    'fin.suggest.blockIdPresent.2',
  ],
  timesPresent: [
    'fin.suggest.timesPresent.1',
    'fin.suggest.timesPresent.2',
  ],
  stundennachweisPreview: [
    'fin.suggest.stundennachweisPreview.1',
    'fin.suggest.stundennachweisPreview.2',
    'fin.suggest.stundennachweisPreview.3',
  ],
  stundennachweisCoverage: [
    'fin.suggest.stundennachweisCoverage.1',
    'fin.suggest.stundennachweisCoverage.2',
    'fin.suggest.stundennachweisCoverage.3',
    'fin.suggest.stundennachweisCoverage.4',
  ],
};

/**
 * Sentinel for "this check passed and the detail adds nothing" — it is compared
 * with `===` when deciding whether to render the detail, so it is a value, not
 * a label. It reads identically in German and English.
 */
const DETAIL_OK = 'OK';

function minsToHHMM(m: number): string {
  if (m <= 0) return '0:00';
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

function fmtDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

// ── Main component ─────────────────────────────────────────────────────────

export default function FinalizePlanningModal({ run, companyId, userId, onClose, onFinalized }: Props) {
  const { t, tPlural } = useTranslation();

  // `runChecks` reads the translator through a ref rather than taking it as a
  // dependency: it is re-run by an effect keyed on its own identity, so a new
  // `t` after a language switch would re-query the database and reset a
  // finished run back to 'checking', discarding the downloadable snapshot.
  const tRef = useRef(t);
  const tPluralRef = useRef(tPlural);
  useEffect(() => { tRef.current = t; tPluralRef.current = tPlural; }, [t, tPlural]);

  const [step, setStep] = useState<'idle' | 'checking' | 'ready' | 'finalizing' | 'done' | 'blocked'>('idle');
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [snapshot, setSnapshot] = useState<FinalSnapshot | null>(null);
  const [error, setError] = useState('');
  const [finalizationId, setFinalizationId] = useState('');
  const [finalizedAt, setFinalizedAt] = useState('');
  const [xlsxDownloading, setXlsxDownloading] = useState(false);
  const [xlsxDone, setXlsxDone] = useState(false);
  const [downloadingStundenDriverId, setDownloadingStundenDriverId] = useState<string | null>(null);
  const [expandedSuggestions, setExpandedSuggestions] = useState<Set<number>>(new Set());
  const [showStundenPreview, setShowStundenPreview] = useState(false);

  function toggleSuggestions(index: number): void {
    setExpandedSuggestions(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  // ── Pre-flight checks + snapshot build ──────────────────────────────────

  const runChecks = useCallback(async () => {
    setStep('checking');
    setError('');
    setChecks([]);
    setSnapshot(null);

    const tr = tRef.current;
    const trPlural = tPluralRef.current;

    try {
      // Resolve the vehicle switch buffer from the applied run settings.
      // Falls back to the default if not stored (older runs).
      const settingsJson = run.settings_json ?? {};
      const storedBuffer = settingsJson['vehicle_switch_buffer_minutes'];
      const MIN_CAR_SWITCH_GAP_MINUTES: number =
        (typeof storedBuffer === 'number' && storedBuffer >= 0)
          ? storedBuffer
          : DEFAULT_CAR_SWITCH_GAP_MINUTES;

      const results: CheckResult[] = [];

      // 1. Confirm planning run is still 'applied'
      const { data: runRow, error: runErr } = await supabase
        .from('company_planning_runs')
        .select('id, status, apply_summary_json')
        .eq('id', run.id)
        .single();

      if (runErr || !runRow) {
        results.push({ id: 'runPresent', ok: false, detail: runErr ? formatError(runErr) : tr('fin.detail.runNotFound') });
        setChecks(results);
        setStep('blocked');
        return;
      }
      results.push({
        id: 'runStatus',
        ok: runRow.status === 'applied',
        // 'applied' is the stored run status, not a label.
        detail: runRow.status === 'applied' ? 'applied' : tr('fin.detail.runStatusMismatch', { status: String(runRow.status) }),
      });

      // 2. Load all trips for this run (batched)
      const BATCH = 1000;
      const allTrips: Array<{
        id: string;
        trip_date: string;
        start_time: string | null;
        end_time: string | null;
        assigned_driver_id: string | null;
        assigned_driver_name: string | null;
        assignment_block_id: string | null;
        car_identifier: string | null;
        is_canceled: boolean;
        raw_data_json: Record<string, unknown> | null;
      }> = [];

      let offset = 0;
      while (true) {
        const { data, error: tErr } = await supabase
          .from('fahrtenbuch_trips')
          .select('id, trip_date, start_time, end_time, assigned_driver_id, assigned_driver_name, assignment_block_id, car_identifier, is_canceled, raw_data_json')
          .eq('company_id', companyId)
          .eq('assignment_planning_run_id', run.id)
          .order('id', { ascending: true })
          .range(offset, offset + BATCH - 1);
        if (tErr) throw new Error(`${tr('fin.error.loadTrips')}\n${formatError(tErr)}`);
        allTrips.push(...(data ?? []));
        if ((data?.length ?? 0) < BATCH) break;
        offset += BATCH;
      }

      const nonCanceled = allTrips.filter(trip => !trip.is_canceled);
      const expectedUpdated = (runRow.apply_summary_json as Record<string, unknown> | null)?.updated_trips;
      const expectedCount = typeof expectedUpdated === 'number' ? expectedUpdated : null;

      // 3. Trip count
      results.push({
        id: 'tripCount',
        ok: expectedCount === null || nonCanceled.length === expectedCount,
        detail: expectedCount !== null
          ? tr('fin.detail.tripCountExpected', { actual: nonCanceled.length, expected: expectedCount })
          : tr('fin.detail.tripCount', { count: nonCanceled.length }),
      });

      // 4. No duplicate trip IDs
      const idSet = new Set<string>();
      const dups: string[] = [];
      for (const trip of allTrips) {
        if (idSet.has(trip.id)) dups.push(trip.id);
        idSet.add(trip.id);
      }
      results.push({
        id: 'noDuplicateTrips',
        ok: dups.length === 0,
        detail: dups.length === 0 ? DETAIL_OK : tr('fin.detail.duplicates', { count: dups.length }),
      });

      // 5. No trips without driver
      const missingDriver = nonCanceled.filter(trip => !trip.assigned_driver_id).length;
      results.push({
        id: 'driverAssigned',
        ok: missingDriver === 0,
        detail: missingDriver === 0 ? DETAIL_OK : tr('fin.detail.withoutDriver', { count: missingDriver }),
      });

      // 6. No trips without block ID
      const missingBlock = nonCanceled.filter(trip => !trip.assignment_block_id).length;
      results.push({
        id: 'blockIdPresent',
        ok: missingBlock === 0,
        detail: missingBlock === 0 ? DETAIL_OK : tr('fin.detail.withoutBlockId', { count: missingBlock }),
      });

      // 7. No trips without times
      const missingTime = nonCanceled.filter(trip => !trip.start_time || !trip.end_time).length;
      results.push({
        id: 'timesPresent',
        ok: missingTime === 0,
        detail: missingTime === 0 ? DETAIL_OK : tr('fin.detail.withoutTimes', { count: missingTime }),
      });

      // 8. Max-3-Schichten-Regel per driver per day (compressed view)
      const MAX_SHIFT = 270; // 4:30
      const MAX_DAY = 510;   // 8:30
      function toMins(time: string): number {
        const [h, m] = time.split(':').map(Number);
        return h * 60 + m;
      }
      function segDur(s: string, e: string): number {
        const f = toMins(s), t2 = toMins(e);
        return t2 >= f ? t2 - f : 1440 - f + t2;
      }
      type DayKey = string; // "driverId_date"
      const dayShifts = new Map<DayKey, Array<{ s: number; e: number }>>();
      for (const trip of nonCanceled) {
        if (!trip.start_time || !trip.end_time || !trip.assigned_driver_id) continue;
        const key: DayKey = `${trip.assigned_driver_id}_${trip.trip_date}`;
        const arr = dayShifts.get(key) ?? [];
        arr.push({ s: toMins(trip.start_time.slice(0, 5)), e: toMins(trip.end_time.slice(0, 5)) });
        dayShifts.set(key, arr);
      }
      let compressedDayCount = 0;
      let max3HardViolations = 0;
      const max3ViolationDetails: string[] = [];
      for (const [dayKey, windows] of dayShifts) {
        windows.sort((a, b) => a.s - b.s);
        // Step 1: merge overlapping windows
        const merged: Array<{ s: number; e: number }> = [];
        for (const w of windows) {
          const last = merged[merged.length - 1];
          if (!last || w.s > last.e) merged.push({ ...w });
          else last.e = Math.max(last.e, w.e);
        }
        // Step 2: smallest-gap compression — keep merging the closest adjacent pair until ≤3
        const hadMore = merged.length > 3;
        while (merged.length > 3) {
          let minGap = Infinity, minIdx = 0;
          for (let i = 0; i < merged.length - 1; i++) {
            const gap = merged[i + 1].s - merged[i].e;
            if (gap < minGap) { minGap = gap; minIdx = i; }
          }
          merged[minIdx] = { s: merged[minIdx].s, e: Math.max(merged[minIdx].e, merged[minIdx + 1].e) };
          merged.splice(minIdx + 1, 1);
        }
        if (hadMore) compressedDayCount++;
        // After compression merged.length is always ≤3; flag only if somehow still above (safety net)
        if (merged.length > 3) {
          max3HardViolations++;
          const [dId, date] = dayKey.split('_');
          const dName = nonCanceled.find(trip => trip.assigned_driver_id === dId)?.assigned_driver_name ?? dId;
          max3ViolationDetails.push(tr('fin.detail.shiftViolationLine', { driver: dName, date, count: merged.length }));
        }
      }
      results.push({
        id: 'maxThreeShifts',
        ok: max3HardViolations === 0,
        detail: max3HardViolations === 0
          ? compressedDayCount > 0
            ? trPlural({ one: 'fin.detail.compressedDays.one', other: 'fin.detail.compressedDays.other' }, compressedDayCount)
            : DETAIL_OK
          : `${tr('fin.detail.shiftCompressionFailed', { count: max3HardViolations })}\n${max3ViolationDetails.slice(0, 10).join('\n')}${max3ViolationDetails.length > 10 ? `\n${tr('fin.detail.andMore', { count: max3ViolationDetails.length - 10 })}` : ''}`,
      });

      // ── Inner helpers: full-timestamp math (avoids HH:MM wrap-around) ────
      function parseTsMs(date: string, time: string): number {
        return new Date(`${date}T${time.slice(0, 5)}:00`).getTime();
      }
      function localDateStr(ms: number): string {
        const d = new Date(ms);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
      function overlapMs(sMs: number, eMs: number, rS: number, rE: number): number {
        const lo = Math.max(sMs, rS), hi = Math.min(eMs, rE);
        return lo < hi ? hi - lo : 0;
      }
      function computeBlockNight(sMs: number, eMs: number): { nacht: number; n04: number } {
        const sDay = Math.floor(sMs / 86400000) * 86400000;
        const eDay = Math.floor((eMs - 1) / 86400000) * 86400000;
        let nacht = 0, n04 = 0;
        for (let day = sDay; day <= eDay; day += 86400000) {
          // 04:00–06:00 and 23:00–00:00 are Nachtarbeit (mutually exclusive with 0–4)
          nacht += Math.floor(overlapMs(sMs, eMs, day + 4 * 3600000, day + 6 * 3600000) / 60000);
          nacht += Math.floor(overlapMs(sMs, eMs, day + 23 * 3600000, day + 24 * 3600000) / 60000);
          // 00:00–04:00 is Nacht 0–4 exclusively
          n04   += Math.floor(overlapMs(sMs, eMs, day, day + 4 * 3600000) / 60000);
        }
        return { nacht, n04 };
      }
      function msToHHMM(ms: number): string {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }
      function minsToDecStr(m: number): string {
        return (Math.round((m / 60) * 100) / 100).toFixed(2).replace('.', ',');
      }

      // 9. Fahrzeugwechsel zu kurz — same driver, different car, 0 ≤ gap < 30 min
      // Uses resolveActualRideWindow for correct midnight/cross-day timestamps.
      type TripForSwitch = {
        trip_date: string;
        start_time: string | null;
        end_time: string | null;
        assigned_driver_id: string;
        assigned_driver_name: string | null;
        car_identifier: string;
        raw_data_json: Record<string, unknown> | null;
      };
      const switchViolations: string[] = [];
      const byDriver = new Map<string, TripForSwitch[]>();
      for (const trip of nonCanceled) {
        if (!trip.assigned_driver_id || !trip.car_identifier || !trip.start_time || !trip.end_time) continue;
        const key = trip.assigned_driver_id;
        if (!byDriver.has(key)) byDriver.set(key, []);
        byDriver.get(key)!.push(trip as TripForSwitch);
      }
      for (const trips of byDriver.values()) {
        trips.sort((a, b) => {
          const aRw = resolveActualRideWindow(a);
          const bRw = resolveActualRideWindow(b);
          return aRw.actualStartMs - bRw.actualStartMs;
        });
        for (let i = 1; i < trips.length; i++) {
          const prev = trips[i - 1];
          const curr = trips[i];
          if (prev.car_identifier === curr.car_identifier) continue;
          const prevRw = resolveActualRideWindow(prev);
          const currRw = resolveActualRideWindow(curr);
          const gapMs = currRw.actualStartMs - prevRw.actualEndMs;
          const gapMinutes = gapMs / 60000;
          if (gapMinutes < 0 || gapMinutes >= MIN_CAR_SWITCH_GAP_MINUTES) continue;
          const driverName = prev.assigned_driver_name ?? prev.assigned_driver_id;
          switchViolations.push(tr('fin.detail.vehicleSwitchLine', {
            driver: driverName,
            date: fmtAbsDate(prevRw.actualEndMs),
            fromCar: prev.car_identifier,
            toCar: curr.car_identifier,
            end: fmtAbsTime(prevRw.actualEndMs),
            start: fmtAbsTime(currRw.actualStartMs),
            // German decimal comma is kept in both languages.
            gap: gapMinutes.toFixed(1).replace('.', ','),
          }));
        }
      }
      results.push({
        id: 'vehicleSwitchGap',
        ok: switchViolations.length === 0,
        detail: switchViolations.length === 0 ? DETAIL_OK : switchViolations.join('\n'),
      });

      // 10. Fahrer-Überschneidungen — same assigned driver, overlapping trips (negative gap)
      const driverOverlapViolations: string[] = [];
      for (const driverTrips of byDriver.values()) {
        for (let i = 1; i < driverTrips.length; i++) {
          const prev = driverTrips[i - 1];
          const curr = driverTrips[i];
          const prevRw = resolveActualRideWindow(prev);
          const currRw = resolveActualRideWindow(curr);
          const gapMs = currRw.actualStartMs - prevRw.actualEndMs;
          if (gapMs < 0) {
            const overlapMin = Math.round(-gapMs / 60000);
            if (overlapMin <= 0) continue;
            const driverName = prev.assigned_driver_name ?? prev.assigned_driver_id;
            const prevCar = prev.car_identifier ?? '?';
            const currCar = curr.car_identifier ?? '?';
            driverOverlapViolations.push(tr('fin.detail.driverOverlapLine', {
              driver: driverName,
              firstCar: prevCar,
              firstWindow: `${fmtAbsDateTime(prevRw.actualStartMs)}–${fmtAbsTime(prevRw.actualEndMs)}`,
              secondCar: currCar,
              secondWindow: `${fmtAbsDateTime(currRw.actualStartMs)}–${fmtAbsTime(currRw.actualEndMs)}`,
              minutes: overlapMin,
            }));
          }
        }
      }
      results.push({
        id: 'driverOverlap',
        ok: driverOverlapViolations.length === 0,
        detail: driverOverlapViolations.length === 0 ? DETAIL_OK : driverOverlapViolations.join('\n'),
      });

      // 11. Fahrzeug-Überschneidungen — same car, different drivers, overlapping times
      const overlapViolations: string[] = [];
      const byCar = new Map<string, Array<{
        trip_date: string; start_time: string | null; end_time: string | null;
        assigned_driver_id: string; assigned_driver_name: string | null;
        raw_data_json: Record<string, unknown> | null;
      }>>();
      for (const trip of nonCanceled) {
        if (!trip.car_identifier || !trip.start_time || !trip.end_time || !trip.assigned_driver_id) continue;
        const arr = byCar.get(trip.car_identifier) ?? [];
        arr.push({ trip_date: trip.trip_date, start_time: trip.start_time, end_time: trip.end_time, assigned_driver_id: trip.assigned_driver_id, assigned_driver_name: trip.assigned_driver_name, raw_data_json: trip.raw_data_json });
        byCar.set(trip.car_identifier, arr);
      }
      for (const [carId, carTrips] of byCar) {
        carTrips.sort((a, b) => {
          const aRw = resolveActualRideWindow(a);
          const bRw = resolveActualRideWindow(b);
          return aRw.actualStartMs - bRw.actualStartMs;
        });
        for (let i = 1; i < carTrips.length; i++) {
          const prev = carTrips[i - 1];
          const curr = carTrips[i];
          if (prev.assigned_driver_id === curr.assigned_driver_id) continue;
          const prevRw = resolveActualRideWindow(prev);
          const currRw = resolveActualRideWindow(curr);
          if (currRw.actualStartMs < prevRw.actualEndMs) {
            const pd = prev.assigned_driver_name ?? prev.assigned_driver_id;
            const cd = curr.assigned_driver_name ?? curr.assigned_driver_id;
            const overlapMin = Math.round((prevRw.actualEndMs - currRw.actualStartMs) / 60000);
            overlapViolations.push(tr('fin.detail.vehicleOverlapLine', {
              vehicle: carId,
              date: fmtAbsDate(prevRw.actualStartMs),
              firstDriver: pd,
              firstWindow: `${fmtAbsTime(prevRw.actualStartMs)}–${fmtAbsTime(prevRw.actualEndMs)}`,
              secondDriver: cd,
              secondWindow: `${fmtAbsTime(currRw.actualStartMs)}–${fmtAbsTime(currRw.actualEndMs)}`,
              minutes: overlapMin,
            }));
          }
        }
      }
      results.push({
        id: 'vehicleOverlap',
        ok: overlapViolations.length === 0,
        detail: overlapViolations.length === 0 ? DETAIL_OK : overlapViolations.join('\n'),
      });

      // 11. Build blocks from trips (time-interval based — no assignment_block_id dependency).
      // Group every non-canceled trip by (driver_id, trip_date), sort by start,
      // merge overlapping/touching intervals so every trip is covered.
      type FinBlock = {
        block_id: string; driver_id: string; driver_name: string;
        service_date: string;
        block_start_ms: number; block_end_ms: number;
        duration_minutes: number; nachtarbeit: number; nacht04: number;
      };

      // Collect absolute intervals per (driverId, serviceDate)
      interface FinInterval {
        sMs: number; eMs: number;
        driverId: string; driverName: string; serviceDate: string;
      }
      const finIntervals: FinInterval[] = [];
      for (const trip of nonCanceled) {
        if (!trip.start_time || !trip.end_time || !trip.assigned_driver_id) continue;
        const rw = resolveActualRideWindow({
          trip_date: trip.trip_date,
          start_time: trip.start_time,
          end_time: trip.end_time,
          raw_data_json: trip.raw_data_json,
        });
        const sMs = rw.actualStartMs > 0 ? rw.actualStartMs : parseTsMs(trip.trip_date, trip.start_time);
        let eMs = rw.actualEndMs > 0 ? rw.actualEndMs : parseTsMs(trip.trip_date, trip.end_time);
        if (eMs <= sMs) eMs += 86400000;
        finIntervals.push({
          sMs, eMs,
          driverId: trip.assigned_driver_id,
          driverName: trip.assigned_driver_name ?? trip.assigned_driver_id,
          serviceDate: trip.trip_date,
        });
      }

      // Group by (driverId, serviceDate), sort, merge
      const finGroupMap = new Map<string, FinInterval[]>();
      for (const iv of finIntervals) {
        const key = `${iv.driverId}|${iv.serviceDate}`;
        const arr = finGroupMap.get(key) ?? [];
        arr.push(iv);
        finGroupMap.set(key, arr);
      }

      const finBlocks: FinBlock[] = [];
      let finBlockSeq = 0;
      for (const [, ivs] of finGroupMap) {
        ivs.sort((a, b) => a.sMs - b.sMs);
        // Merge overlapping/touching
        interface Span { sMs: number; eMs: number; driverId: string; driverName: string; serviceDate: string; }
        const spans: Span[] = [];
        for (const iv of ivs) {
          const last = spans[spans.length - 1];
          if (!last || iv.sMs > last.eMs) {
            spans.push({ sMs: iv.sMs, eMs: iv.eMs, driverId: iv.driverId, driverName: iv.driverName, serviceDate: iv.serviceDate });
          } else {
            last.eMs = Math.max(last.eMs, iv.eMs);
          }
        }
        for (const span of spans) {
          if (span.eMs <= span.sMs) continue;
          const night = computeBlockNight(span.sMs, span.eMs);
          finBlocks.push({
            block_id: `fin_${finBlockSeq++}`,
            driver_id: span.driverId, driver_name: span.driverName,
            service_date: span.serviceDate,
            block_start_ms: span.sMs, block_end_ms: span.eMs,
            duration_minutes: Math.floor((span.eMs - span.sMs) / 60000),
            nachtarbeit: night.nacht, nacht04: night.n04,
          });
        }
      }

      // ── Coverage validation: every non-canceled trip must be covered by its driver's blocks ──
      // Two minutes tolerance for display rounding (PDFs show HH:MM, trips have seconds).
      const COVERAGE_TOLERANCE_MS = 2 * 60 * 1000;
      const blocksByDriverForCoverage = new Map<string, { sMs: number; eMs: number }[]>();
      for (const b of finBlocks) {
        const arr = blocksByDriverForCoverage.get(b.driver_id) ?? [];
        arr.push({ sMs: b.block_start_ms, eMs: b.block_end_ms });
        blocksByDriverForCoverage.set(b.driver_id, arr);
      }
      interface UncoveredEntry { tripId: string; driverName: string; date: string; vehicle: string; start: string; end: string; }
      const uncoveredTrips: UncoveredEntry[] = [];
      for (const trip of nonCanceled) {
        if (!trip.start_time || !trip.end_time || !trip.assigned_driver_id) continue;
        const rw = resolveActualRideWindow({
          trip_date: trip.trip_date, start_time: trip.start_time, end_time: trip.end_time, raw_data_json: trip.raw_data_json,
        });
        const tSMs = rw.actualStartMs > 0 ? rw.actualStartMs : parseTsMs(trip.trip_date, trip.start_time);
        let tEMs = rw.actualEndMs > 0 ? rw.actualEndMs : parseTsMs(trip.trip_date, trip.end_time);
        if (tEMs <= tSMs) tEMs += 86400000;
        const driverBlocks = blocksByDriverForCoverage.get(trip.assigned_driver_id) ?? [];
        const isCovered = driverBlocks.some(b =>
          b.sMs <= tSMs + COVERAGE_TOLERANCE_MS &&
          b.eMs >= tEMs - COVERAGE_TOLERANCE_MS,
        );
        if (!isCovered) {
          uncoveredTrips.push({
            tripId: trip.id,
            driverName: trip.assigned_driver_name ?? trip.assigned_driver_id,
            date: trip.trip_date,
            vehicle: trip.car_identifier ?? '—',
            start: msToHHMM(tSMs),
            end: msToHHMM(tEMs),
          });
        }
      }
      if (uncoveredTrips.length > 0) {
        console.error('[FinalizePlanningModal] Uncovered trips:', uncoveredTrips);
      }
      const coverageLines: string[] = [];
      if (uncoveredTrips.length > 0) {
        coverageLines.push(trPlural(
          { one: 'fin.detail.uncoveredHeading.one', other: 'fin.detail.uncoveredHeading.other' },
          uncoveredTrips.length,
        ));
        for (const u of uncoveredTrips.slice(0, 20)) {
          coverageLines.push(`${u.driverName} · ${u.date} · ${u.vehicle} · ${u.start}–${u.end}`);
        }
        if (uncoveredTrips.length > 20) {
          coverageLines.push(tr('fin.detail.andMoreTrips', { count: uncoveredTrips.length - 20 }));
        }
      }
      results.push({
        id: 'stundennachweisCoverage',
        ok: uncoveredTrips.length === 0,
        detail: uncoveredTrips.length === 0
          ? tr('fin.detail.coverageOk', { count: nonCanceled.length })
          : coverageLines.join('\n'),
      });
      const driverMap = new Map<string, DriverSummary & { blockSet: Set<string> }>();
      for (const trip of nonCanceled) {
        const name = trip.assigned_driver_name ?? tr('fin.unknownDriver');
        const key = trip.assigned_driver_id ?? name;
        if (!driverMap.has(key)) {
          driverMap.set(key, { id: key, name, trips: 0, blocks: 0, blockSet: new Set(), workMinutes: 0, nightMinutes: 0, sundayMinutes: 0, expectedBrutto: null });
        }
        const d = driverMap.get(key)!;
        d.trips++;
        if (trip.assignment_block_id) d.blockSet.add(trip.assignment_block_id);
      }
      // Accumulate block-level time data (uses ms arithmetic, handles overnight correctly)
      for (const b of finBlocks) {
        const d = driverMap.get(b.driver_id);
        if (!d) continue;
        d.workMinutes  += b.duration_minutes;
        d.nightMinutes += b.nachtarbeit;
        const [by, bm, bd] = b.service_date.split('-').map(Number);
        if (new Date(by, bm - 1, bd).getDay() === 0) d.sundayMinutes += b.duration_minutes;
      }

      // Build per-driver per-day PDF rows (used for Stundennachweis download in done state)
      const driverDateBlocks = new Map<string, Map<string, FinBlock[]>>();
      for (const b of finBlocks) {
        if (!driverDateBlocks.has(b.driver_id)) driverDateBlocks.set(b.driver_id, new Map());
        const dateMap = driverDateBlocks.get(b.driver_id)!;
        const arr = dateMap.get(b.service_date) ?? [];
        arr.push(b);
        dateMap.set(b.service_date, arr);
      }
      // Weekday column of the Stundennachweis PDF — statutory German, never translated.
      const WDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
      const driverPdfMap = new Map<string, { rows: PdfDayRow[]; totals: PdfTotals }>();
      for (const [driverId, dateMap] of driverDateBlocks) {
        const totals: PdfTotals = { grundlohn: 0, nachtarbeit: 0, nacht04: 0, sonntag: 0, feiertag: 0, weihnachten: 0 };
        const rows: PdfDayRow[] = [];
        for (const [serviceDate, dayBlocks] of dateMap) {
          dayBlocks.sort((a, b2) => a.block_start_ms - b2.block_start_ms);
          // Compress to max 3 blocks per day (same rule as Stundennachweis Preview)
          while (dayBlocks.length > 3) {
            let bestIdx = -1, bestGap = Infinity;
            for (let i = 0; i < dayBlocks.length - 1; i++) {
              const g = dayBlocks[i + 1].block_start_ms - dayBlocks[i].block_end_ms;
              if (g < bestGap) { bestGap = g; bestIdx = i; }
            }
            if (bestIdx === -1) break;
            const a2 = dayBlocks[bestIdx], b2 = dayBlocks[bestIdx + 1];
            dayBlocks.splice(bestIdx, 2, {
              block_id: `${a2.block_id}+${b2.block_id}`,
              driver_id: a2.driver_id, driver_name: a2.driver_name,
              service_date: a2.service_date,
              block_start_ms: a2.block_start_ms,
              block_end_ms: Math.max(a2.block_end_ms, b2.block_end_ms),
              duration_minutes: a2.duration_minutes + b2.duration_minutes,
              nachtarbeit: a2.nachtarbeit + b2.nachtarbeit,
              nacht04: a2.nacht04 + b2.nacht04,
            });
          }
          const [sy, sm, sd] = serviceDate.split('-').map(Number);
          const date = new Date(sy, sm - 1, sd);
          const dow = date.getDay();
          const isSun = dow === 0;
          const dayGrund = dayBlocks.reduce((s, b2) => s + b2.duration_minutes, 0);
          const dayNacht = dayBlocks.reduce((s, b2) => s + b2.nachtarbeit, 0);
          const dayN04  = dayBlocks.reduce((s, b2) => s + b2.nacht04, 0);
          const daySon  = isSun ? dayGrund : 0;
          rows.push({
            date, weekday: WDAY_SHORT[dow],
            isSat: dow === 6, isSun, isHol: false,
            von1: dayBlocks[0] ? msToHHMM(dayBlocks[0].block_start_ms) : '',
            bis1: dayBlocks[0] ? msToHHMM(dayBlocks[0].block_end_ms)   : '',
            von2: dayBlocks[1] ? msToHHMM(dayBlocks[1].block_start_ms) : '',
            bis2: dayBlocks[1] ? msToHHMM(dayBlocks[1].block_end_ms)   : '',
            von3: dayBlocks[2] ? msToHHMM(dayBlocks[2].block_start_ms) : '',
            bis3: dayBlocks[2] ? msToHHMM(dayBlocks[2].block_end_ms)   : '',
            grundlohn:     minsToDecStr(dayGrund),
            nachtarbeit:   minsToDecStr(dayNacht),
            nachtarbeit04: minsToDecStr(dayN04),
            sonntag:       minsToDecStr(daySon),
            feiertag:      '0,00',
            weihnachten:   '0,00',
          });
          totals.grundlohn   += dayGrund;
          totals.nachtarbeit += dayNacht;
          totals.nacht04     += dayN04;
          totals.sonntag     += daySon;
        }
        rows.sort((a, b2) => a.date.getTime() - b2.date.getTime());
        driverPdfMap.set(driverId, { rows, totals });
      }

      const drivers: DriverSummary[] = [...driverMap.values()].map(d => ({
        id: d.id,
        name: d.name,
        trips: d.trips,
        blocks: d.blockSet.size,
        workMinutes: d.workMinutes,
        nightMinutes: d.nightMinutes,
        sundayMinutes: d.sundayMinutes,
        expectedBrutto: d.expectedBrutto,
        pdfData: driverPdfMap.get(d.id),
      })).sort((a, b) => b.trips - a.trips);

      // Check: Stundennachweis Preview generierbar for all assigned drivers
      const snMissing = drivers.filter(d => !d.pdfData || d.pdfData.rows.length === 0).map(d => d.name);
      results.push({
        id: 'stundennachweisPreview',
        ok: snMissing.length === 0,
        detail: snMissing.length === 0
          ? tr('fin.detail.previewOk', { count: drivers.length })
          : tr('fin.detail.driversWithoutData', { drivers: snMissing.join(', ') }),
      });

      const snap: FinalSnapshot = {
        totalTrips: nonCanceled.length,
        driverCount: drivers.length,
        drivers,
        // Store aggregate data in DB; exclude pdfData (large, in-session only)
        driverSummaryJson: {
          drivers: drivers.map(d => ({
            id: d.id, name: d.name, trips: d.trips, blocks: d.blocks,
            workMinutes: d.workMinutes, nightMinutes: d.nightMinutes,
            sundayMinutes: d.sundayMinutes, expectedBrutto: d.expectedBrutto,
          })),
        },
      };

      setChecks(results);
      setSnapshot(snap);

      const allOk = results.every(r => r.ok);
      setStep(allOk ? 'ready' : 'blocked');
    } catch (e) {
      console.error('Finalization consistency check failed', e);
      setError(formatError(e));
      setStep('blocked');
    }
  }, [run, companyId]);

  useEffect(() => { void runChecks(); }, [runChecks]);

  // ── Finalization ───────────────────────────────────────────────────────

  const handleFinalize = useCallback(async () => {
    if (!snapshot) return;
    setStep('finalizing');
    setError('');
    try {
      // 1. Insert finalization record
      const { data: finRow, error: finErr } = await supabase
        .from('planning_finalizations')
        .insert({
          planning_run_id: run.id,
          company_id: companyId,
          finalized_by: userId ?? null,
          trip_count: snapshot.totalTrips,
          driver_count: snapshot.driverCount,
          driver_summary_json: snapshot.driverSummaryJson,
          is_stale: false,
          document_status: 'ready',
        })
        .select('id, finalized_at')
        .single();

      if (finErr || !finRow) {
        throw new Error(finErr
          ? `${t('fin.error.database')}\n${formatError(finErr)}`
          : t('fin.error.notSaved'));
      }

      setFinalizationId(finRow.id as string);
      setFinalizedAt(finRow.finalized_at as string);

      setStep('done');
      onFinalized(finRow.id as string);
    } catch (e) {
      console.error('Finalization failed', e);
      setError(formatError(e));
      setStep('ready');
    }
  }, [snapshot, run, companyId, userId, onFinalized, t]);

  // ── Re-download Fahrtenbuch ──────────────────────────────────────────

  const handleRedownload = async () => {
    setXlsxDownloading(true);
    try {
      await exportAppliedRunXlsx(run, 'original');
      setXlsxDone(true);
    } finally {
      setXlsxDownloading(false);
    }
  };

  // ── Download per-driver Stundennachweis PDF from finalized snapshot ──

  function handleDownloadStunden(driver: DriverSummary): void {
    if (!driver.pdfData) return;
    setDownloadingStundenDriverId(driver.id);
    try {
      const safeName = driver.name.replace(/[/\\:*?"<>|]/g, '_');
      // Banner and filename belong to the statutory Stundennachweis PDF and stay
      // German in both UI languages.
      exportStundennachweisAsPdf(
        {
          driver: { name: driver.name },
          month: run.month,
          year: run.year,
          rows: driver.pdfData.rows,
          totals: driver.pdfData.totals,
          warnings: [`Finalisierter Stundennachweis · ${MONTHS_DE[run.month - 1]} ${run.year}`],
        },
        `Stundennachweis_${safeName}_${MONTHS_DE[run.month - 1]}_${run.year}.pdf`,
      );
    } finally {
      setDownloadingStundenDriverId(null);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────

  const allChecksOk = checks.length > 0 && checks.every(c => c.ok);
  const criticalFails = checks.filter(c => !c.ok);
  const coverageFailed = criticalFails.some(f => f.id === 'stundennachweisCoverage');

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,0.75)' }}
      onClick={step === 'finalizing' || step === 'done' ? undefined : onClose}
    >
      <div
        className="rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
          <div>
            <h3 className="text-base font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <Sparkles size={16} style={{ color: '#f59e0b' }} />
              {t('fin.title')}
            </h3>
            <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
              {t(MONTH_KEYS[run.month - 1])} {run.year} · {run.file_name || run.id.slice(0, 8)}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={step === 'finalizing'}
            className="p-1 rounded disabled:opacity-40"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">

          {/* Checks */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                {t('fin.checksHeading')}
              </span>
              {step === 'checking' && <Loader2 size={12} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />}
            </div>
            <div className="space-y-1.5">
              {step === 'checking' && checks.length === 0 && (
                <div className="text-sm py-2" style={{ color: 'var(--text-tertiary)' }}>{t('fin.checksRunning')}</div>
              )}
              {checks.map((c, i) => {
                const suggestions = CHECK_SUGGESTIONS[c.id];
                return (
                <div key={c.id} className="flex items-start gap-2.5 text-sm">
                  {c.ok
                    ? <CheckCircle2 size={15} className="shrink-0 mt-0.5" style={{ color: '#22c55e' }} />
                    : <AlertTriangle size={15} className="shrink-0 mt-0.5" style={{ color: '#dc2626' }} />
                  }
                  <div className="min-w-0 flex-1">
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{t(CHECK_LABEL_KEYS[c.id])}</span>
                    {!c.ok && (
                      <div className="mt-0.5 space-y-0.5">
                        {c.detail.split('\n').map((line, li) => (
                          <div key={li} className="text-xs" style={{ color: '#dc2626' }}>{line}</div>
                        ))}
                      </div>
                    )}
                    {c.ok && c.detail !== DETAIL_OK && (
                      <span className="ml-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>{c.detail}</span>
                    )}
                    {/* Suggestions for failed checks */}
                    {!c.ok && suggestions && (
                      <div className="mt-1.5">
                        <button
                          className="inline-flex items-center gap-1 text-xs font-semibold transition-colors hover:opacity-80"
                          style={{ color: '#2563eb' }}
                          onClick={() => toggleSuggestions(i)}
                        >
                          {expandedSuggestions.has(i)
                            ? <><ChevronUp size={11} /> {t('fin.hideSuggestions')}</>
                            : <><ChevronDown size={11} /> {t('fin.showSuggestions')}</>
                          }
                        </button>
                        {expandedSuggestions.has(i) && (
                          <ul className="mt-1.5 space-y-1 pl-3 border-l-2" style={{ borderColor: 'rgba(37,99,235,0.3)' }}>
                            {suggestions.map((suggestionKey, si) => (
                              <li key={suggestionKey} className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                <span className="font-semibold" style={{ color: '#2563eb' }}>
                                  {t('fin.suggestionNumber', { index: si + 1 })}
                                </span>{' '}{t(suggestionKey)}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
          </div>

          {/* Blocked banner */}
          {step === 'blocked' && criticalFails.length > 0 && (
            <div className="px-4 py-3 rounded-lg text-sm" style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.35)', color: '#991b1b' }}>
              <div className="font-bold flex items-center gap-2 mb-1">
                <Lock size={14} />
                {coverageFailed ? t('fin.blockedCoverageTitle') : t('fin.blockedTitle')}
              </div>
              <p className="text-xs">
                {tPlural({ one: 'fin.blockedCount.one', other: 'fin.blockedCount.other' }, criticalFails.length)}
              </p>
              {coverageFailed && (
                <p className="text-xs mt-1" style={{ color: '#991b1b', fontWeight: 600 }}>
                  {t('fin.blockedCoverageBody')}
                </p>
              )}
              <p className="text-xs mt-1.5" style={{ color: '#7f1d1d' }}>
                {coverageFailed ? t('fin.blockedCoverageHint') : t('fin.blockedGenericHint')}
              </p>
            </div>
          )}

          {/* Snapshot summary */}
          {snapshot && (step === 'ready' || step === 'finalizing' || step === 'done') && (
            <div className="rounded-lg px-4 py-3 space-y-2" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
              <div className="text-xs font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--text-tertiary)' }}>
                {t('fin.snapshotHeading')}
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span style={{ color: 'var(--text-tertiary)' }}>{t('fin.totalTrips')}: </span>
                  <strong style={{ color: 'var(--text-primary)' }}>{snapshot.totalTrips}</strong>
                </div>
                <div>
                  <span style={{ color: 'var(--text-tertiary)' }}>{t('common.driver')}: </span>
                  <strong style={{ color: 'var(--text-primary)' }}>{snapshot.driverCount}</strong>
                </div>
              </div>
              <div className="space-y-1 mt-1">
                {snapshot.drivers.map(d => (
                  <div key={d.name} className="flex items-center justify-between text-xs py-1 border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                    <div className="flex items-center gap-2">
                      <Users size={11} style={{ color: 'var(--text-tertiary)' }} />
                      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{d.name}</span>
                    </div>
                    <div className="flex gap-3" style={{ color: 'var(--text-secondary)' }}>
                      <span>{tPlural({ one: 'fin.tripsCount.one', other: 'fin.tripsCount.other' }, d.trips)}</span>
                      <span>{tPlural({ one: 'fin.blocksCount.one', other: 'fin.blocksCount.other' }, d.blocks)}</span>
                      <span>{minsToHHMM(d.workMinutes)} h</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Done state */}
          {step === 'done' && (
            <div className="rounded-lg px-4 py-4 space-y-3" style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)' }}>
              <div className="flex items-center gap-2 font-bold" style={{ color: '#15803d' }}>
                <CheckCircle2 size={16} />
                {t('fin.doneTitle')}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <div>{t('fin.labelFahrtenbuch')}: <strong style={{ color: 'var(--text-primary)' }}>{t('fin.ready')}</strong></div>
                <div>{t('fin.labelStundennachweise')}: <strong style={{ color: 'var(--text-primary)' }}>{t('fin.driverCount', { count: snapshot?.driverCount ?? 0 })}</strong></div>
                <div>{t('fin.labelTrips')}: <strong style={{ color: 'var(--text-primary)' }}>{snapshot?.totalTrips ?? 0}</strong></div>
                <div>{t('fin.finalizedAt')}: <strong style={{ color: 'var(--text-primary)' }}>{fmtDateTime(finalizedAt)}</strong></div>
              </div>
              {/* Fahrtenbuch download */}
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  onClick={handleRedownload}
                  disabled={xlsxDownloading}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 transition-all"
                  style={{ background: 'rgba(34,197,94,0.15)', color: '#15803d', border: '1px solid rgba(34,197,94,0.4)' }}
                >
                  {xlsxDownloading ? <Loader2 size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />}
                  {t('fin.downloadFahrtenbuch')}
                </button>
                <button
                  onClick={() => setShowStundenPreview(true)}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold transition-all"
                  style={{ background: 'rgba(6,182,212,0.12)', color: '#0e7490', border: '1px solid rgba(6,182,212,0.35)' }}
                >
                  <FileText size={14} />
                  {t('fin.showStundennachweisPreview')}
                </button>
              </div>
              {/* Per-driver Stundennachweis downloads (from the same finalized snapshot) */}
              {snapshot && snapshot.drivers.some(d => d.pdfData) && (
                <div className="space-y-1.5 pt-1">
                  <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                    {t('fin.downloadStundennachweise')}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {snapshot.drivers.map(d => d.pdfData ? (
                      <button
                        key={d.id}
                        onClick={() => handleDownloadStunden(d)}
                        disabled={downloadingStundenDriverId === d.id}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50 transition-all"
                        style={{ background: 'rgba(34,197,94,0.1)', color: '#15803d', border: '1px solid rgba(34,197,94,0.3)' }}
                      >
                        {downloadingStundenDriverId === d.id
                          ? <Loader2 size={11} className="animate-spin" />
                          : <FileText size={11} />
                        }
                        {d.name}
                      </button>
                    ) : null)}
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {t('fin.snapshotNote')}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Note about what finalization does */}
          {(step === 'ready') && (
            <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(6,182,212,0.07)', border: '1px solid rgba(6,182,212,0.2)', color: 'var(--text-secondary)' }}>
              {t('fin.readyNote')}
            </div>
          )}

          {error && (
            <div className="px-3 py-2 rounded-lg text-sm whitespace-pre-wrap" style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', fontFamily: error.includes('\n') ? 'monospace' : 'inherit', fontSize: 12 }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t shrink-0" style={{ borderColor: 'var(--border)' }}>
          <button
            onClick={onClose}
            disabled={step === 'finalizing'}
            className="px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
            style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
          >
            {step === 'done' ? t('common.close') : t('common.cancel')}
          </button>

          {step !== 'done' && (
            <div className="flex items-center gap-2">
              {step === 'blocked' && (
                <button
                  onClick={runChecks}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold"
                  style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                >
                  {t('fin.recheck')}
                </button>
              )}
              <button
                onClick={handleFinalize}
                disabled={step !== 'ready' || !allChecksOk}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold disabled:opacity-40 transition-all"
                style={{
                  background: step === 'ready' && allChecksOk ? '#f59e0b' : 'var(--bg-muted)',
                  color: step === 'ready' && allChecksOk ? '#fff' : 'var(--text-tertiary)',
                  border: 'none',
                }}
              >
                {step === 'finalizing'
                  ? <><Loader2 size={14} className="animate-spin" /> {t('fin.creating')}</>
                  : <><Sparkles size={14} /> {t('fin.title')}</>
                }
              </button>
            </div>
          )}
        </div>
      </div>

      {showStundenPreview && (
        <MonatsplanungStundennachweisPreview
          run={{
            id: run.id,
            company_id: run.company_id,
            month: run.month,
            year: run.year,
            status: run.status,
            file_name: run.file_name,
            applied_at: run.applied_at,
            import_id: run.import_id ?? null,
            source_sheet_name: run.source_sheet_name ?? null,
            source_columns_json: run.source_columns_json ?? null,
          }}
          onClose={() => setShowStundenPreview(false)}
        />
      )}
    </div>
  );
}
