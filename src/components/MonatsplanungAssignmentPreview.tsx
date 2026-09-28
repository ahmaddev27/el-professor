import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Play, AlertTriangle, CalendarClock, CheckCircle2, ChevronDown, ChevronUp, UserCheck, ListChecks, XCircle, Info, Wrench, Hand, X, ShieldAlert, RotateCcw, FileDiff, Lock, Database, Download, Loader2, Sparkles, Clipboard, ClipboardCheck, Shield, ArrowRight } from 'lucide-react';
import type { Phase1VehicleBlock } from '../utils/monatsplanungPhase1';
import type { PlanningDriver } from './MonatsplanungDriverPool';
import type { FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
import { supabase } from '../lib/supabase';
import {
  resolveActualRideWindow,
  fmtAbsDateTime,
  fmtAbsTime,
  fmtAbsDate,
  type ActualRideWindow,
} from '../utils/planningQualityChecks';
import {
  assignBlocksPhase3,
  applyManualAssignment,
  applyLeaveOpen,
  undoManualResolution,
  applyDienstzeitException,
  unassignBlock,
  evaluateManualCandidate,
  type Phase3Result,
  type RejectReason,
  type UnassignedBlock,
  type StructuredNote,
  type AustauschReparaturLog,
  DEFAULT_MAX_DAILY_HOURS,
  MIN_VEHICLE_SWITCH_BUFFER_MINUTES,
} from '../utils/monatsplanungPhase3';
import { buildChangeSet, type Phase4Result } from '../utils/monatsplanungPhase4';
import { repairFinalOverlaps, fmtRepairMs, type RepairPassResult } from '../utils/monatsplanungRepairPass';
import { type AppliedRunSummary } from '../utils/monatsplanungXlsxExport';
import MonatsplanungStundennachweisPreview from './MonatsplanungStundennachweisPreview';
import FinalizePlanningModal from './FinalizePlanningModal';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { engineText } from '../i18n/engineMessage';
import { assessDay, formatShiftDuration, type DayWindow } from '../utils/shiftDayLimits';
import {
  validateDriverNotesForPlanStep,
  buildRideIntervalsFromBlocks,
  parseLocalDatetime,
  type NoteViolation,
} from '../utils/driverNoteValidation';

interface Props {
  blocks: Phase1VehicleBlock[];
  selectedDrivers: PlanningDriver[];
  trips: FahrtenbuchTrip[];
  importId: string;
  month: number;
  year: number;
  blockSeparatorMinutes: number;
  minBlockDurationMinutes: number;
  maxBlockDurationMinutes: number;
  /** Minimum gap in minutes required when a driver switches to a different vehicle. */
  vehicleSwitchBufferMinutes?: number;
  sourceFileName: string;
  companyId: string;
  onApplied?: () => void;
}

interface ApplyResultSummary {
  success: boolean;
  already_applied?: boolean;
  planning_run_id?: string;
  updated_trips?: number;
  skipped_canceled?: number;
  manual_exceptions_saved?: number;
  applied_at?: string;
  applied_by?: string;
  verify_assigned_in_import?: number;
  verify_canceled_in_import?: number;
  verify_rows_with_run?: number;
  verify_exceptions_in_run?: number;
  message?: string;
}

// The RejectReason codes are Phase 3 data — hard constraints (wrong_weekday,
// driver_overlap, vehicle_switch_buffer_violation, one_vehicle_per_day,
// note_constraint) and bypassable ones (outside_working_time_window,
// daily_max_exceeded, monthly_max_exceeded) are told apart by these codes and
// audited under them. Only the labels are translated; every consumer resolves
// the TranslationKey with t().
const REASON_LABEL: Record<RejectReason, TranslationKey> = {
  wrong_weekday: 'mp.reason.wrongWeekday',
  outside_working_time_window: 'mp.reason.outsideWorkingTime',
  daily_max_exceeded: 'mp.reason.dailyMaxExceeded',
  monthly_max_exceeded: 'mp.reason.monthlyMaxExceeded',
  driver_overlap: 'mp.reason.driverOverlap',
  vehicle_switch_buffer_violation: 'mp.reason.vehicleSwitchBuffer',
  one_vehicle_per_day: 'mp.reason.oneVehiclePerDay',
  note_constraint: 'mp.reason.noteConstraint',
};

// `evaluateManualCandidate` in monatsplanungPhase3.ts returns its blocking
// checks as German strings. Those strings are the engine's output — they are
// compared against, not shown — so they stay verbatim here and only the
// rendered label is translated.
const BLOCKING_CHECK_LABEL: Record<string, TranslationKey> = {
  'Arbeitstag nicht erlaubt': 'mp.reason.wrongWeekday',
  'Außerhalb Dienstzeit': 'mp.reason.outsideWorkingTime',
  'Tageslimit überschritten': 'mp.reason.dailyMaxExceeded',
  'Monatslimit überschritten': 'mp.reason.monthlyMaxExceeded',
  'Fahrer-Überlappung': 'mp.reason.driverOverlap',
  'Fahrzeugwechsel-Puffer': 'mp.reason.vehicleSwitchBuffer',
  'Fahrer nutzt bereits anderes Fahrzeug an diesem Tag': 'mp.reason.oneVehiclePerDay',
  'Notiz-Einschränkung': 'mp.reason.noteConstraint',
  'Nicht ausgewählter Fahrer': 'mp.reason.driverNotSelected',
  'Fahrer nicht in Auswahl': 'mp.reason.driverNotInPool',
};

function fmtTime(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : iso;
}

function fmtDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : d;
}

function fmtH(min: number): string {
  return `${(min / 60).toFixed(2)}h`;
}

/**
 * The imported sheet's own identity, read from `fahrtenbuch_imports`.
 *
 * `exportAppliedRunXlsx(…, 'original')` must reproduce the imported sheet's
 * headers byte for byte — that is the whole point of the `'original'` mode, and
 * CLAUDE.md states it as a rule. It takes both of these off the run summary:
 * `source_columns_json` is the header row it emits and validates against, and
 * `source_sheet_name` is the tab name. With neither in hand it falls back to the
 * union of every trip's `raw_data_json` keys and to the sheet name `Sheet1` —
 * and that key order is the source's only by accident (most rides list the
 * ride's end before its start), so the fallback is a different document.
 */
export interface ImportSheetMeta {
  source_sheet_name: string | null;
  source_columns_json: string[] | null;
}

/**
 * The run reference `MonatsplanungStundennachweisPreview` takes. It is the
 * component's own `AppliedRunRef`, restated here because the object literal that
 * used to be written inline omitted `import_id` altogether — a standing
 * `TS2741` — which left the preview's "Fahrtenbuch herunterladen" button
 * (`disabled={… || !run.import_id}`) permanently disabled when it was opened
 * from this screen.
 */
export interface StundennachweisRunRef {
  id: string;
  company_id: string;
  month: number;
  year: number;
  status: string;
  file_name: string;
  applied_at: string | null;
  import_id: string | null;
  source_sheet_name: string | null;
  source_columns_json: string[] | null;
}

/** True when the header row we hold can actually reproduce the source sheet. */
export function importHeadersUsable(meta: ImportSheetMeta | null): boolean {
  const headers = meta?.source_columns_json;
  return Array.isArray(headers) && headers.some(h => typeof h === 'string' && h.length > 0);
}

/**
 * Builds the reference handed to the Stundennachweis preview.
 *
 * `import_id` is withheld while the header metadata is missing, and that is
 * deliberate: the preview gates its Fahrtenbuch download on `run.import_id`, so
 * a null keeps a statutory ride log from being produced against metadata we
 * failed to read, rather than emitting one whose header row and sheet name came
 * from a fallback. CLAUDE.md: a figure whose load failed is not shown.
 */
export function buildStundennachweisRunRef(
  run: AppliedRunSummary,
  meta: ImportSheetMeta | null,
): StundennachweisRunRef {
  const usable = importHeadersUsable(meta);
  return {
    id: run.id,
    company_id: run.company_id,
    month: run.month,
    year: run.year,
    status: run.status,
    file_name: run.file_name,
    applied_at: run.applied_at,
    import_id: usable ? run.import_id : null,
    source_sheet_name: usable ? (meta?.source_sheet_name ?? null) : null,
    source_columns_json: usable ? (meta?.source_columns_json ?? null) : null,
  };
}

/**
 * Why the "Plan anwenden" button is refused, or null when it is not.
 *
 * The order is the precedence the screen has always shown, with one arm added:
 * `notes_unavailable` sits ahead of `notes`, because a `driver_notes` read that
 * failed leaves an empty map, and an empty map produces zero violations — which
 * is indistinguishable from "no driver is excluded". `exclude_from_plan` is a
 * hard phase-3 constraint, so the gate has to refuse rather than report a clean
 * check it never ran.
 */
export type ApplyGateBlocker =
  | 'not_complete'
  | 'needs_change_set'
  | 'open_blocks'
  | 'validation'
  | 'quality'
  | 'notes_unavailable'
  | 'notes'
  | 'no_import_id'
  | 'already_applied';

export interface ApplyGateInput {
  phase3Ok: boolean;
  phase4Ok: boolean;
  hasOpenBlocks: boolean;
  hasValidationViolations: boolean;
  hasQualityBlockers: boolean;
  notesLoadFailed: boolean;
  hasNoteViolations: boolean;
  hasImportId: boolean;
  alreadyApplied: boolean;
}

export function evaluateApplyGate(input: ApplyGateInput): { canApply: boolean; blockedBy: ApplyGateBlocker | null } {
  const blockedBy: ApplyGateBlocker | null =
    !input.phase3Ok ? 'not_complete'
    : !input.phase4Ok ? 'needs_change_set'
    : input.hasOpenBlocks ? 'open_blocks'
    : input.hasValidationViolations ? 'validation'
    : input.hasQualityBlockers ? 'quality'
    : input.notesLoadFailed ? 'notes_unavailable'
    : input.hasNoteViolations ? 'notes'
    : !input.hasImportId ? 'no_import_id'
    : input.alreadyApplied ? 'already_applied'
    : null;
  return { canApply: blockedBy === null, blockedBy };
}

export default function MonatsplanungAssignmentPreview({
  blocks,
  selectedDrivers,
  trips,
  importId,
  month,
  year,
  blockSeparatorMinutes,
  minBlockDurationMinutes,
  maxBlockDurationMinutes,
  vehicleSwitchBufferMinutes = MIN_VEHICLE_SWITCH_BUFFER_MINUTES,
  sourceFileName,
  companyId,
  onApplied,
}: Props) {
  const { user } = useAuth();
  const { t, tPlural } = useTranslation();
  // Phase 3 and Phase 4 write their messages in German and name a dictionary
  // key beside each one; `eng` renders the key and falls back to that German.
  const eng = (text: string | null | undefined, key?: string, vars?: Record<string, string | number>) =>
    engineText(t, text, key, vars);
  const [result, setResult] = useState<Phase3Result | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string>('');
  const [phase4, setPhase4] = useState<Phase4Result | null>(null);
  const [building4, setBuilding4] = useState(false);
  const [repairResult, setRepairResult] = useState<RepairPassResult | null>(null);
  const [showRepairDetails, setShowRepairDetails] = useState(false);
  const oneVehiclePerDriverDay = true;
  const [inhaberSharePercent, setInhaberSharePercent] = useState(20);
  const [inhaberShareError, setInhaberShareError] = useState('');

  // Phase 5 apply state
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyConfirmed, setApplyConfirmed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string>('');
  const [applyResult, setApplyResult] = useState<ApplyResultSummary | null>(null);
  const [pruefExporting, setPruefExporting] = useState(false);

  // Post-apply modal state
  const [stundenRun, setStundenRun] = useState<AppliedRunSummary | null>(null);
  const [finalizeRun, setFinalizeRun] = useState<AppliedRunSummary | null>(null);

  // Replace flow state
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceTyped, setReplaceTyped] = useState('');
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [replaceError, setReplaceError] = useState('');

  const canceledCount = useMemo(() => trips.filter(trip => trip.is_canceled).length, [trips]);

  // Detect cross-month blocks: block starts in this month but ends in the next
  const crossMonthBlocks = useMemo(() => {
    return blocks.filter(b => {
      if (!b.block_start_datetime || !b.block_end_datetime) return false;
      const startMonth = b.block_start_datetime.slice(0, 7);
      const endMonth = b.block_end_datetime.slice(0, 7);
      return startMonth !== endMonth;
    });
  }, [blocks]);

  // ── Structured driver notes (exclude_from_plan) ──────────────────────────
  const [driverNotesMap, setDriverNotesMap] = useState<Map<string, StructuredNote[]>>(new Map());
  /**
   * The one failure state this screen gains. `exclude_from_plan` is a HARD
   * phase-3 constraint, and this read used to discard its `error`: on a refusal
   * or a network fault the map stayed empty, `validateDriverNotesForPlanStep`
   * found nothing to violate, and the screen reported "keine Fahrten in
   * ausgeschlossenen Fahrer-Zeiträumen" and let the plan be applied. That is the
   * constraint failing open under a green claim.
   */
  const [notesLoadFailed, setNotesLoadFailed] = useState(false);
  useEffect(() => {
    if (!companyId) return;
    const firstDay = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).toISOString().slice(0, 10);
    setNotesLoadFailed(false);
    const failed = () => {
      setDriverNotesMap(new Map());
      setNotesLoadFailed(true);
    };
    supabase
      .from('driver_notes')
      .select('id, driver_id, note_type, note_text, note_planning_behavior, is_full_day, start_date, end_date, note_date, start_time, end_time')
      .eq('company_id', companyId)
      .eq('note_planning_behavior', 'exclude_from_plan')
      .or(`start_date.lte.${lastDay},end_date.gte.${firstDay},note_date.gte.${firstDay}`)
      .then(({ data, error }) => {
        // postgrest-js turns a fetch failure into `{ data: null, error }` as
        // long as throwOnError() was not called, so this one branch covers a
        // refusal and an unreachable database alike. The rejection handler
        // below is the second wall, not the first.
        if (error || !data) {
          failed();
          return;
        }
        const map = new Map<string, StructuredNote[]>();
        for (const note of data) {
          const arr = map.get(note.driver_id) ?? [];
          arr.push(note as StructuredNote);
          map.set(note.driver_id, arr);
        }
        setDriverNotesMap(map);
      }, failed);
  }, [companyId, month, year]);

  // ── The imported sheet's headers, for the corrected Fahrtenbuch ──────────
  // Read here rather than in the preview because this screen is what hands the
  // run to it; see ImportSheetMeta above for why the export cannot do without
  // them. A read that fails leaves this null, and buildStundennachweisRunRef
  // then withholds import_id.
  const [importMeta, setImportMeta] = useState<ImportSheetMeta | null>(null);
  useEffect(() => {
    if (!importId) {
      setImportMeta(null);
      return;
    }
    let cancelled = false;
    setImportMeta(null);
    const fail = () => { if (!cancelled) setImportMeta(null); };
    supabase
      .from('fahrtenbuch_imports')
      .select('source_sheet_name, source_columns_json')
      .eq('id', importId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) {
          fail();
          return;
        }
        const columns = data.source_columns_json;
        setImportMeta({
          source_sheet_name: (data.source_sheet_name as string | null) ?? null,
          source_columns_json: Array.isArray(columns) ? (columns as string[]) : null,
        });
      }, fail);
    return () => { cancelled = true; };
  }, [importId]);

  // ── Driver-note violations: recomputed whenever result or driverNotesMap changes ──
  // Global: used for Section F display only (all assigned blocks)
  const noteViolations = useMemo<NoteViolation[]>(() => {
    if (!result) return [];
    return validateDriverNotesForPlanStep({
      stepName: t('mp.phase3Step'),
      rides: buildRideIntervalsFromBlocks(result.assigned),
      driverNotesMap,
      driverProfiles: selectedDrivers,
    }).violations;
  }, [result, driverNotesMap, selectedDrivers, t]);

  // "OK" means the check ran and found nothing — not that it found nothing.
  // A failed read leaves driverNotesMap empty, so noteViolations is [] for the
  // same reason it is [] when no driver is excluded at all.
  const noteViolationsOk = !notesLoadFailed && noteViolations.length === 0;

  // Scoped: used for Section E apply gate — only change rows that will actually be written
  // Remaining "Nicht zugewiesen" blocks outside the selected preview must NOT block apply.
  const sectionENoteViolations = useMemo<NoteViolation[]>(() => {
    if (!phase4) return [];
    const rides = phase4.change_rows
      .filter(r => !r.is_canceled && r.new_driver_id && r.new_driver_name)
      .map(r => ({
        blockId: r.block_id,
        vehicleIdentifier: r.vehicle_identifier,
        driverId: r.new_driver_id,
        driverName: r.new_driver_name,
        startMs: parseLocalDatetime(r.block_start_datetime),
        endMs: parseLocalDatetime(r.block_end_datetime),
      }));
    return validateDriverNotesForPlanStep({
      stepName: t('mp.sectionEStep'),
      rides,
      driverNotesMap,
      driverProfiles: selectedDrivers,
    }).violations;
  }, [phase4, driverNotesMap, selectedDrivers, t]);

  // ── Planqualität: early pre-apply quality checks ─────────────────────────
  // car_identifier, trip_date, start_time, end_time are immutable source fields.
  // All time comparisons use resolveActualRideWindow() from planningQualityChecks.ts
  // which reads full absolute datetimes from raw_data_json and rejects Auftrags*
  // / Übermittlung* columns before falling back to trip_date + HH:MM.

  interface TripInOverlap {
    rowIndex: number | null;
    originalDriver: string;
    assignedDriver: string;
    srcStart: string;
    srcEnd: string;
    normStart: string;
    normEnd: string;
    isCanceled: boolean;
    tsStart: number;
    tsEnd: number;
    usedFullDatetime: boolean;
    actualStartDate: string;  // real calendar date from full timestamp
    actualEndDate: string;
    sourceStartColumn: string;
    sourceEndColumn: string;
  }
  interface VehicleOverlapDetail {
    carId: string;
    date: string;
    overlapMin: number;
    tripA: TripInOverlap;
    tripB: TripInOverlap;
    diagnosis: 'source' | 'checker';
    startColUsed: string;
    endColUsed: string;
  }
  // `label` is the internal discriminator the Prüf-Export and the detail
  // renderer switch on — data, never shown. `labelKey` is what renders.
  interface QualityIssue { label: string; labelKey: TranslationKey; details: string[]; vehicleOverlaps?: VehicleOverlapDetail[] }

  const planQualitaet = useMemo<{ issues: QualityIssue[]; vehicleOverlaps: VehicleOverlapDetail[]; durationWarningDetails: string[] } | null>(() => {
    const issues: QualityIssue[] = [];

    const nonCanceled = trips.filter(trip => !trip.is_canceled);

    // ── Vehicle overlaps ──────────────────────────────────────────────────────
    const byCar = new Map<string, typeof nonCanceled>();
    for (const trip of nonCanceled) {
      if (!trip.car_identifier || !trip.start_time || !trip.end_time) continue;
      const arr = byCar.get(trip.car_identifier) ?? [];
      arr.push(trip);
      byCar.set(trip.car_identifier, arr);
    }

    const vehicleOverlaps: VehicleOverlapDetail[] = [];
    const durationWarningDetails: string[] = [];

    for (const [carId, carTrips] of byCar) {
      const withTs = carTrips.map(trip => {
        const rw = resolveActualRideWindow(trip);
        return { t: trip, rw };
      });
      withTs.sort((a, b) => a.rw.actualStartMs - b.rw.actualStartMs);

      for (let i = 1; i < withTs.length; i++) {
        const prev = withTs[i - 1];
        const curr = withTs[i];
        if (curr.rw.actualStartMs <= 0 || prev.rw.actualEndMs <= 0) continue;
        if (curr.rw.actualStartMs < prev.rw.actualEndMs) {
          const overlapMs  = prev.rw.actualEndMs - curr.rw.actualStartMs;
          const overlapMin = Math.round(overlapMs / 60000);
          if (overlapMin <= 0) continue;
          const bothFull   = !prev.rw.usedFallback && !curr.rw.usedFallback;
          const diagnosis: 'source' | 'checker' = bothFull ? 'source' : 'checker';

          const makeTripInfo = (row: typeof prev): TripInOverlap => ({
            rowIndex:       row.t.source_row_index ?? null,
            originalDriver: row.t.original_driver_name ?? '—',
            assignedDriver: row.t.assigned_driver_name || row.t.original_driver_name || '—',
            srcStart:       row.rw.sourceStartValue || row.t.start_time || '',
            srcEnd:         row.rw.sourceEndValue   || row.t.end_time   || '',
            normStart:      row.t.start_time ?? '',
            normEnd:        row.t.end_time   ?? '',
            isCanceled:     row.t.is_canceled,
            tsStart:        row.rw.actualStartMs,
            tsEnd:          row.rw.actualEndMs,
            usedFullDatetime: !row.rw.usedFallback,
            actualStartDate:  row.rw.actualStartDate,
            actualEndDate:    row.rw.actualEndDate,
            sourceStartColumn: row.rw.sourceStartColumn,
            sourceEndColumn:   row.rw.sourceEndColumn,
          });

          vehicleOverlaps.push({
            carId,
            date: prev.t.trip_date,
            overlapMin,
            tripA: makeTripInfo(prev),
            tripB: makeTripInfo(curr),
            diagnosis,
            startColUsed: prev.rw.sourceStartColumn,
            endColUsed:   prev.rw.sourceEndColumn,
          });
        }
      }
    }

    if (vehicleOverlaps.length > 0) {
      issues.push({
        label: 'Fahrzeug-Überschneidungen',
        labelKey: 'mp.quality.vehicleOverlaps',
        details: vehicleOverlaps.map(o => {
          const aDate = fmtAbsDate(o.tripA.tsStart);
          const bDate = fmtAbsDate(o.tripB.tsStart);
          const dateLabel = aDate === bDate ? aDate : `${aDate}→${bDate}`;
          return `${o.carId} · ${dateLabel} · ${t('mp.quality.overlapMinutes', { minutes: o.overlapMin })}`;
        }),
        vehicleOverlaps,
      });
    }

    // ── Driver-level checks ───────────────────────────────────────────────────
    // Use Phase 3 planned assignments (result.assigned) as the source of truth.
    // t.assigned_driver_name reflects the DB import state, not the in-memory plan.
    const DRIVER_SWITCH_MIN = vehicleSwitchBufferMinutes;

    // Build trip_id → planned driver name from Phase 3 result
    const plannedDriverByTripId = new Map<string, string>();
    if (result) {
      for (const ab of result.assigned) {
        for (const row of ab.trip_rows) {
          plannedDriverByTripId.set(row.trip_id, ab.driver_name);
        }
      }
    }

    const byDriver = new Map<string, Array<{ t: typeof nonCanceled[number]; rw: ActualRideWindow }>>();
    for (const trip of nonCanceled) {
      const driverKey = result
        ? (plannedDriverByTripId.get(trip.id) ?? null)
        : (trip.assigned_driver_name || trip.original_driver_name || null);
      if (!driverKey || !trip.start_time || !trip.end_time) continue;
      const rw = resolveActualRideWindow(trip);
      if (rw.actualStartMs <= 0) continue;
      const arr = byDriver.get(driverKey) ?? [];
      arr.push({ t: trip, rw });
      byDriver.set(driverKey, arr);
    }

    const driverOverlapDetails: string[] = [];
    const driverSwitchDetails: string[] = [];

    for (const [driverName, driverTrips] of byDriver) {
      driverTrips.sort((a, b) => a.rw.actualStartMs - b.rw.actualStartMs);
      for (let i = 1; i < driverTrips.length; i++) {
        const prev = driverTrips[i - 1];
        const curr = driverTrips[i];
        if (curr.rw.actualEndMs <= 0 || prev.rw.actualEndMs <= 0) continue;
        const gapMs  = curr.rw.actualStartMs - prev.rw.actualEndMs;
        const gapMin = gapMs / 60000;

        if (gapMin < 0) {
          const overlapMin = Math.round(-gapMin);
          if (overlapMin > 0) {
            const prevCar = prev.t.car_identifier ?? '?';
            const currCar = curr.t.car_identifier ?? '?';
            const prevRange = `${fmtAbsDateTime(prev.rw.actualStartMs)}–${fmtAbsTime(prev.rw.actualEndMs)}`;
            const currRange = `${fmtAbsDateTime(curr.rw.actualStartMs)}–${fmtAbsTime(curr.rw.actualEndMs)}`;
            driverOverlapDetails.push(
              `${driverName} · ${prevCar} ${prevRange} ↔ ${currCar} ${currRange} · ${t('mp.quality.overlapMinutes', { minutes: overlapMin })}`
            );
          }
        } else if (prev.t.car_identifier !== curr.t.car_identifier && gapMin < DRIVER_SWITCH_MIN) {
          const prevCar  = prev.t.car_identifier ?? '?';
          const currCar  = curr.t.car_identifier ?? '?';
          const endDisp   = `${fmtAbsDate(prev.rw.actualEndMs)} ${fmtAbsTime(prev.rw.actualEndMs)}`;
          const startDisp = `${fmtAbsDate(curr.rw.actualStartMs)} ${fmtAbsTime(curr.rw.actualStartMs)}`;
          driverSwitchDetails.push(
            `${driverName} · ${prevCar} → ${currCar} · ${t('mp.quality.switchDetail', {
              end: endDisp,
              start: startDisp,
              gap: gapMin.toFixed(1).replace('.', ','),
            })}`
          );
        }
      }
    }

    if (driverOverlapDetails.length > 0) {
      issues.push({ label: 'Fahrer-Überschneidung', labelKey: 'mp.quality.driverOverlap', details: driverOverlapDetails });
    }
    if (driverSwitchDetails.length > 0) {
      issues.push({ label: 'Fahrzeugwechsel zu kurz', labelKey: 'mp.quality.vehicleSwitchTooShort', details: driverSwitchDetails });
    }

    // Part D: the Stundennachweis duration limits per driver-day, as a warning.
    //
    // This was a "Max. 3 Schichten" blocker and could never fire: the loop above
    // it broke at `count >= 3`, and the condition below asked whether count was
    // `> 3`. It also threw away the absolute instants it had just read, taking
    // `startMs % 86400000` to get a time of day, which is what CLAUDE.md forbids
    // ("never from a bare HH:MM:SS string") — the windows are now compared as
    // instants, so a block over midnight merges correctly.
    //
    // It is a warning and not a blocker on purpose. The count of three is
    // display-only compression, so it is not a limit at all (see
    // utils/shiftDayLimits.ts for the measurement). The two durations are a real
    // rule, but they are enforced on the built Stundennachweis rows, where
    // validateRowDurations blocks save and PDF export; blocking "Plan anwenden"
    // on a different computation of the same rule risks refusing a month the
    // Stundennachweis would accept. So it is surfaced here, where the operator
    // can still act on it, and it does not disable the button.
    if (result) {
      const dayShiftsMap = new Map<string, DayWindow[]>();
      for (const state of result.driverStates) {
        for (const ab of state.assigned) {
          const key = `${state.driver_id}_${ab.service_date}`;
          const arr = dayShiftsMap.get(key) ?? [];
          arr.push({
            startMs: new Date(ab.block_start_datetime).getTime(),
            endMs: new Date(ab.block_end_datetime).getTime(),
          });
          dayShiftsMap.set(key, arr);
        }
      }
      for (const [key, windows] of dayShiftsMap) {
        const day = assessDay(windows);
        if (!day.exceedsDayLimit && !day.exceedsShiftLimit) continue;
        const [driverId, date] = key.split('_');
        const driverName = result.driverStates.find(s => s.driver_id === driverId)?.driver_name ?? driverId;
        durationWarningDetails.push(
          `${driverName} · ${date.split('-').reverse().join('.')} · Tag ${formatShiftDuration(day.dayMinutes)} · längste Schicht ${formatShiftDuration(day.longestShiftMinutes)}`,
        );
      }
    }

    return { issues, vehicleOverlaps, durationWarningDetails };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trips, result]);

  const qualityHardBlockers = planQualitaet?.issues.length ?? 0;

  const [showQualityDetails, setShowQualityDetails] = useState(false);
  // Track which vehicle overlap indices have their pair-detail expanded
  const [expandedOverlaps, setExpandedOverlaps] = useState<Set<number>>(new Set());
  const [copiedOverlaps, setCopiedOverlaps] = useState(false);

  const toggleOverlapExpand = (idx: number) => {
    setExpandedOverlaps(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const copyOverlapReport = () => {
    const overlaps = planQualitaet?.vehicleOverlaps ?? [];
    if (overlaps.length === 0) return;
    const lines: string[] = [];
    for (const o of overlaps) {
      const ta = o.tripA;
      const tb = o.tripB;
      const aDateDisp = fmtAbsDate(ta.tsStart);
      const bDateDisp = fmtAbsDate(tb.tsStart);
      const describeTrip = (label: string, trip: typeof ta) =>
        `${label}: ${trip.rowIndex != null
          ? t('mp.overlap.rowNumber', { row: trip.rowIndex })
          : t('mp.overlap.rowUnknown')}, ` +
        `${t('mp.overlap.originalDriver')}: ${trip.originalDriver}, ${t('mp.overlap.assigned')}: ${trip.assignedDriver}, ` +
        `${t('mp.overlap.actual')}: ${fmtAbsDateTime(trip.tsStart)}–${fmtAbsTime(trip.tsEnd)}, ` +
        `${t('mp.overlap.source')}: ${trip.srcStart || '?'}–${trip.srcEnd || '?'}, ` +
        `${t('mp.overlap.normalized')}: ${trip.normStart}–${trip.normEnd}, ` +
        `${t('mp.overlap.canceled')}: ${trip.isCanceled ? t('common.yes') : t('common.no')}`;

      lines.push(t('mp.overlap.heading'));
      lines.push(`${t('mp.vehicle')}: ${o.carId}`);
      lines.push(`${t('mp.overlap.serviceDate')}: ${o.date.split('-').reverse().join('.')}`);
      lines.push(`${t('mp.overlap.actualDate')}: ${aDateDisp}${aDateDisp !== bDateDisp ? ' → ' + bDateDisp : ''}`);
      lines.push(`${t('mp.overlap.overlap')}: ${t('mp.minutes', { minutes: o.overlapMin })}`);
      lines.push(t('mp.overlap.timeComparison'));
      lines.push(`${t('mp.overlap.columnsUsed')}: ${o.startColUsed} / ${o.endColUsed}`);
      lines.push(`${t('mp.overlap.calculation')}: ${(ta.usedFullDatetime && tb.usedFullDatetime) ? t('mp.overlap.calcRealTimestamps') : t('mp.overlap.calcFallback')}`);
      lines.push(describeTrip(t('mp.overlap.tripA'), ta));
      lines.push(describeTrip(t('mp.overlap.tripB'), tb));
      lines.push(`${t('mp.overlap.diagnosis')}: ${o.diagnosis === 'source' ? t('mp.overlap.diagSource') : t('mp.overlap.diagChecker')}`);
      lines.push('');
    }
    void navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopiedOverlaps(true);
      setTimeout(() => setCopiedOverlaps(false), 2000);
    });
  };
  const [resolverBlock, setResolverBlock] = useState<UnassignedBlock | null>(null);
  const [resolverDriverId, setResolverDriverId] = useState<string>('');
  const [resolverDienstzeit, setResolverDienstzeit] = useState(false);
  const [resolverDaily, setResolverDaily] = useState(false);
  const [resolverMonthly, setResolverMonthly] = useState(false);
  const [resolverError, setResolverError] = useState<string>('');

  const handleRun = () => {
    setRunning(true);
    setRunError('');
    setPhase4(null);
    setRepairResult(null);
    try {
      const planningRunId = `${companyId}|${importId}|${month}|${year}`;
      const r = assignBlocksPhase3(blocks, selectedDrivers, { oneVehiclePerDriverDay, vehicleSwitchBufferMinutes, driverNotesMap, planningRunId, inhaberSharePercent });

      // Detect Inhaber driver name from the result
      const inhaberState = r.driverStates.find(s => s.driver.employment_type === 'company_owner');
      const inhaberDriverName = inhaberState?.driver_name ?? '';
      const inhaberDriverId = inhaberState?.driver_id ?? '';

      // Run final overlap repair pass
      const repair = repairFinalOverlaps(r.assigned, year, month, inhaberDriverName, vehicleSwitchBufferMinutes, inhaberDriverId);
      setRepairResult(repair);

      // Apply repaired blocks back into the result
      const repairedResult: Phase3Result = { ...r, assigned: repair.assignedBlocks };
      setResult(repairedResult);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const handleBuildChangeSet = () => {
    if (!result) return;
    setBuilding4(true);
    try {
      const cs = buildChangeSet(result, trips, selectedDrivers);
      setPhase4(cs);
    } finally {
      setBuilding4(false);
    }
  };

  const openApplyModal = () => {
    setApplyConfirmed(false);
    setApplyError('');
    setApplyResult(null);
    setApplyOpen(true);
  };
  const closeApplyModal = () => {
    if (applying) return;
    setApplyOpen(false);
  };

  const buildAppliedRunSummary = (): AppliedRunSummary | null => {
    if (!applyResult?.planning_run_id) return null;
    return {
      id: applyResult.planning_run_id,
      company_id: companyId,
      month,
      year,
      import_id: importId,
      status: 'applied',
      applied_at: applyResult.applied_at ?? null,
      applied_by: applyResult.applied_by ?? null,
      apply_summary_json: null,
      // R4. The two settings the rest of the chain has to know the run was
      // built with. `apply_monthly_planning_run` does NOT persist either of
      // them yet — measured on staging, where every stored settings_json holds
      // only block_separator_minutes and min/max_block_duration_minutes — so a
      // run re-read from the database still reports neither, and this object is
      // the only place they survive until that migration lands.
      //
      // It is not inert in the meantime: FinalizePlanningModal reads
      // `run.settings_json['vehicle_switch_buffer_minutes']` off this prop and
      // otherwise falls back to its 30-minute default, which is what makes a
      // month planned with a smaller buffer impossible to finalize. The other
      // three keys stay the RPC's to store; MonatsplanungAppliedRuns reads them
      // from the database, never from here.
      settings_json: {
        vehicle_switch_buffer_minutes: vehicleSwitchBufferMinutes,
        one_vehicle_per_driver_day: oneVehiclePerDriverDay,
      },
      summary_json: null,
      file_name: sourceFileName,
      // The imported sheet's own headers and tab name. FinalizePlanningModal's
      // "Fahrtenbuch erneut herunterladen" hands this very object to
      // exportAppliedRunXlsx(…, 'original'), which reproduces them byte for
      // byte or falls back to the union of raw_data_json keys — a different
      // document. Null while the read is in flight or failed.
      source_columns_json: importMeta?.source_columns_json ?? null,
      source_sheet_name: importMeta?.source_sheet_name ?? null,
      imported_at: '',
    };
  };

  const handleApply = async () => {
    if (!result || !phase4 || !importId) return;
    setApplying(true);
    setApplyError('');
    try {
      const payload = {
        import_id: importId,
        month,
        year,
        source_file_name: sourceFileName,
        block_separator_minutes: blockSeparatorMinutes,
        min_block_duration_minutes: minBlockDurationMinutes,
        max_block_duration_minutes: maxBlockDurationMinutes,
        one_vehicle_per_driver_day: oneVehiclePerDriverDay,
        vehicle_switch_buffer_minutes: vehicleSwitchBufferMinutes,
        vehicle_blocks_count: blocks.length,
        assigned_blocks_count: result.assigned.length,
        manual_exceptions_count: phase4.summary.manuelle_ausnahmen,
        dienstzeit_exceptions_count: phase4.summary.dienstzeit_ausnahmen,
        tageslimit_exceptions_count: phase4.summary.tageslimit_ausnahmen,
        monatslimit_exceptions_count: phase4.summary.monatslimit_ausnahmen,
        change_rows: phase4.change_rows.map(r => ({
          trip_id: r.trip_id,
          driver_id: r.new_driver_id,
          driver_name: r.new_driver_name,
          assignment_source: r.assignment_source,
          block_id: r.block_id,
          is_canceled: r.is_canceled,
          dienstzeit_exception: r.dienstzeit_exception,
          tageslimit_exception: r.tageslimit_exception,
          monatslimit_exception: r.monatslimit_exception,
          exception_reason: r.exception_reason,
        })),
        manual_exceptions: phase4.manual_exceptions.map(m => ({
          block_id: m.block_id,
          vehicle_identifier: m.vehicle_identifier,
          service_date: m.service_date,
          block_start_datetime: m.block_start_datetime,
          block_end_datetime: m.block_end_datetime,
          driver_id: m.driver_id,
          driver_name: m.driver_name,
          dienstzeit: m.dienstzeit,
          tageslimit: m.tageslimit,
          monatslimit: m.monatslimit,
          reason: m.reason,
        })),
      };
      const { data, error } = await supabase.rpc('apply_monthly_planning_run', { p_payload: payload });
      if (error) {
        setApplyError(error.message);
      } else {
        const summary = data as ApplyResultSummary;
        setApplyResult(summary);
        if (summary?.success && !summary.already_applied) {
          onApplied?.();
        }
      }
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : t('mp.unknownError'));
    } finally {
      setApplying(false);
    }
  };

  const handleReplace = async () => {
    if (!result || !phase4 || !importId || !applyResult?.planning_run_id) return;
    setReplacing(true);
    setReplaceError('');
    try {
      const payload = {
        import_id: importId,
        month,
        year,
        source_file_name: sourceFileName,
        block_separator_minutes: blockSeparatorMinutes,
        min_block_duration_minutes: minBlockDurationMinutes,
        max_block_duration_minutes: maxBlockDurationMinutes,
        one_vehicle_per_driver_day: oneVehiclePerDriverDay,
        vehicle_switch_buffer_minutes: vehicleSwitchBufferMinutes,
        vehicle_blocks_count: blocks.length,
        assigned_blocks_count: result.assigned.length,
        manual_exceptions_count: phase4.summary.manuelle_ausnahmen,
        dienstzeit_exceptions_count: phase4.summary.dienstzeit_ausnahmen,
        tageslimit_exceptions_count: phase4.summary.tageslimit_ausnahmen,
        monatslimit_exceptions_count: phase4.summary.monatslimit_ausnahmen,
        change_rows: phase4.change_rows.map(r => ({
          trip_id: r.trip_id,
          driver_id: r.new_driver_id,
          driver_name: r.new_driver_name,
          assignment_source: r.assignment_source,
          block_id: r.block_id,
          is_canceled: r.is_canceled,
          dienstzeit_exception: r.dienstzeit_exception,
          tageslimit_exception: r.tageslimit_exception,
          monatslimit_exception: r.monatslimit_exception,
          exception_reason: r.exception_reason,
        })),
        manual_exceptions: phase4.manual_exceptions.map(m => ({
          block_id: m.block_id,
          vehicle_identifier: m.vehicle_identifier,
          service_date: m.service_date,
          block_start_datetime: m.block_start_datetime,
          block_end_datetime: m.block_end_datetime,
          driver_id: m.driver_id,
          driver_name: m.driver_name,
          dienstzeit: m.dienstzeit,
          tageslimit: m.tageslimit,
          monatslimit: m.monatslimit,
          reason: m.reason,
        })),
      };
      const { data, error } = await supabase.rpc('replace_monthly_planning_run', {
        p_payload: payload,
        p_old_run_id: applyResult.planning_run_id,
      });
      if (error) {
        setReplaceError(error.message);
        return;
      }
      const summary = data as ApplyResultSummary;
      setApplyResult({ ...summary, success: true });
      setReplaceOpen(false);
      setReplaceTyped('');
      setReplaceConfirmed(false);
      onApplied?.();
    } catch (e) {
      setReplaceError(e instanceof Error ? e.message : t('mp.unknownError'));
    } finally {
      setReplacing(false);
    }
  };

  const MONTHS_DE_SHORT = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];

  const handlePruefExport = () => {
    if (!phase4 || !planQualitaet) return;
    setPruefExporting(true);
    try {
      const wb = XLSX.utils.book_new();

      // Sheet 1: Vehicle_Blocks — one row per Phase 1 block with actual timestamps
      const blockHeaders = [
        'Service-Datum',
        'Fahrzeug',
        'Tatsächlicher Blockstart',
        'Tatsächliches Blockende',
        'Dauer (Min)',
        'Fahrten',
        'Split-Grund',
        'Min-Blockdauer-Status',
        'Excel Rows',
        'Fallback verwendet',
        'Trip IDs',
      ];
      const blockRows: (string | number | null)[][] = [blockHeaders];
      for (const b of blocks) {
        const startD = b.actual_start_ms && b.actual_start_ms > 0
          ? fmtAbsDateTime(b.actual_start_ms)
          : b.block_start_datetime.replace('T', ' ');
        const endD = b.actual_end_ms && b.actual_end_ms > 0
          ? fmtAbsDateTime(b.actual_end_ms)
          : b.block_end_datetime.replace('T', ' ');
        const usedFallback = !(b.actual_start_ms && b.actual_start_ms > 0);
        const excelRange = b.first_excel_row != null && b.last_excel_row != null
          ? `${b.first_excel_row}–${b.last_excel_row}`
          : null;
        blockRows.push([
          b.service_date,
          b.vehicle_identifier,
          startD,
          endD,
          b.duration_minutes,
          b.trip_count,
          b.split_reason,
          b.merge_status === 'none' ? 'OK' : b.merge_status === 'merged_short' ? 'Short merged' : 'Short Warnung',
          excelRange,
          usedFallback ? 'Ja' : 'Nein',
          b.trip_ids.join(', '),
        ]);
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(blockRows), 'Vehicle_Blocks');

      // Sheet 2: Geplante_Fahrten — includes service/audit date AND actual ride timestamps
      const fahrtHeaders = [
        'Service-/Audit-Datum',
        'Tatsächlicher Fahrtbeginn',
        'Tatsächliches Fahrtende',
        'Quelle Start-Spalte',
        'Quelle Ende-Spalte',
        'Fallback verwendet',
        'Normalisierte Startzeit',
        'Normalisierte Endzeit',
        'Kennzeichen',
        'Original Fahrer',
        'Geplanter Fahrer',
        'Geändert',
      ];
      const fahrtRows: (string | number | null)[][] = [fahrtHeaders];
      for (const trip of trips.filter(candidate => !candidate.is_canceled)) {
        const origDriver = trip.original_driver_name ?? '';
        const planDriver = trip.assigned_driver_name || origDriver;
        const rw = resolveActualRideWindow(trip);
        fahrtRows.push([
          trip.trip_date,
          rw.actualStartMs > 0 ? rw.displayStart : (trip.start_time ?? ''),
          rw.actualEndMs   > 0 ? rw.displayEnd   : (trip.end_time   ?? ''),
          rw.sourceStartColumn,
          rw.sourceEndColumn,
          rw.usedFallback ? 'Ja' : 'Nein',
          trip.start_time ?? '',
          trip.end_time   ?? '',
          trip.car_identifier ?? '',
          origDriver,
          planDriver,
          origDriver !== planDriver ? 'Ja' : 'Nein',
        ]);
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(fahrtRows), 'Geplante_Fahrten');

      // Sheet 3: Konflikte — structured columns for all conflict types
      const confliktHeaders = [
        'Typ',
        'Blockierend',
        'Fahrer',
        'Fahrzeug A',
        'Fahrzeug B',
        'Excel-Zeile A',
        'Excel-Zeile B',
        'Tatsächliche Zeit A',
        'Tatsächliche Zeit B',
        'Quelle Start/Ende A',
        'Quelle Start/Ende B',
        'Original Fahrer A',
        'Original Fahrer B',
        'Geplanter Fahrer A',
        'Geplanter Fahrer B',
        'Überschn./Abstand Min',
        'Konfigurierter Puffer Min',
        'Erläuterung',
      ];
      const confliktRows: (string | number | null)[][] = [confliktHeaders];

      for (const issue of planQualitaet.issues) {
        if (issue.vehicleOverlaps && issue.vehicleOverlaps.length > 0) {
          for (const o of issue.vehicleOverlaps) {
            confliktRows.push([
              issue.label,
              'Ja',
              `${o.tripA.assignedDriver} / ${o.tripB.assignedDriver}`,
              o.carId,
              o.carId,
              o.tripA.rowIndex != null ? o.tripA.rowIndex + 1 : null,
              o.tripB.rowIndex != null ? o.tripB.rowIndex + 1 : null,
              `${fmtAbsDateTime(o.tripA.tsStart)}–${fmtAbsTime(o.tripA.tsEnd)}`,
              `${fmtAbsDateTime(o.tripB.tsStart)}–${fmtAbsTime(o.tripB.tsEnd)}`,
              `${o.tripA.sourceStartColumn} / ${o.tripA.sourceEndColumn}`,
              `${o.tripB.sourceStartColumn} / ${o.tripB.sourceEndColumn}`,
              o.tripA.originalDriver,
              o.tripB.originalDriver,
              o.tripA.assignedDriver,
              o.tripB.assignedDriver,
              o.overlapMin,
              null,
              `${o.carId} · Überschneidung ${o.overlapMin} Min · ${o.diagnosis === 'source' ? 'Quelle enthält Überschneidung' : 'Möglicher Prüfungsfehler'}`,
            ]);
          }
        } else if (issue.label === 'Fahrer-Überschneidung' || issue.label === 'Fahrzeugwechsel zu kurz') {
          // Rebuild structured rows from trip data for driver-level conflicts
          const nonCancelledForXlsx = trips.filter(candidate => !candidate.is_canceled);
          const byDriverForXlsx = new Map<string, Array<{ t: typeof nonCancelledForXlsx[number]; rw: ActualRideWindow }>>();
          for (const trip of nonCancelledForXlsx) {
            const dk = trip.assigned_driver_name || trip.original_driver_name;
            if (!dk || !trip.start_time || !trip.end_time) continue;
            const rw = resolveActualRideWindow(trip);
            if (rw.actualStartMs <= 0) continue;
            const arr = byDriverForXlsx.get(dk) ?? [];
            arr.push({ t: trip, rw });
            byDriverForXlsx.set(dk, arr);
          }
          for (const [driverName, driverTrips] of byDriverForXlsx) {
            driverTrips.sort((a, b) => a.rw.actualStartMs - b.rw.actualStartMs);
            for (let i = 1; i < driverTrips.length; i++) {
              const prev = driverTrips[i - 1];
              const curr = driverTrips[i];
              if (curr.rw.actualEndMs <= 0 || prev.rw.actualEndMs <= 0) continue;
              const gapMs  = curr.rw.actualStartMs - prev.rw.actualEndMs;
              const gapMin = gapMs / 60000;
              if (issue.label === 'Fahrer-Überschneidung' && gapMin < 0) {
                const overlapMin = Math.round(-gapMin);
                if (overlapMin <= 0) continue;
                confliktRows.push([
                  'Fahrer-Überschneidung',
                  'Ja',
                  driverName,
                  prev.t.car_identifier ?? '?',
                  curr.t.car_identifier ?? '?',
                  prev.t.source_row_index != null ? prev.t.source_row_index + 1 : null,
                  curr.t.source_row_index != null ? curr.t.source_row_index + 1 : null,
                  `${fmtAbsDateTime(prev.rw.actualStartMs)}–${fmtAbsTime(prev.rw.actualEndMs)}`,
                  `${fmtAbsDateTime(curr.rw.actualStartMs)}–${fmtAbsTime(curr.rw.actualEndMs)}`,
                  `${prev.rw.sourceStartColumn} / ${prev.rw.sourceEndColumn}`,
                  `${curr.rw.sourceStartColumn} / ${curr.rw.sourceEndColumn}`,
                  prev.t.original_driver_name ?? '—',
                  curr.t.original_driver_name ?? '—',
                  prev.t.assigned_driver_name ?? '—',
                  curr.t.assigned_driver_name ?? '—',
                  overlapMin,
                  null,
                  `${driverName} gleichzeitig auf ${prev.t.car_identifier ?? '?'} und ${curr.t.car_identifier ?? '?'} · Überschneidung ${overlapMin} Min`,
                ]);
              } else if (issue.label === 'Fahrzeugwechsel zu kurz' && gapMin >= 0 && prev.t.car_identifier !== curr.t.car_identifier && gapMin < vehicleSwitchBufferMinutes) {
                confliktRows.push([
                  'Fahrzeugwechsel zu kurz',
                  'Ja',
                  driverName,
                  prev.t.car_identifier ?? '?',
                  curr.t.car_identifier ?? '?',
                  prev.t.source_row_index != null ? prev.t.source_row_index + 1 : null,
                  curr.t.source_row_index != null ? curr.t.source_row_index + 1 : null,
                  `${fmtAbsDateTime(prev.rw.actualStartMs)}–${fmtAbsTime(prev.rw.actualEndMs)}`,
                  `${fmtAbsDateTime(curr.rw.actualStartMs)}–${fmtAbsTime(curr.rw.actualEndMs)}`,
                  `${prev.rw.sourceStartColumn} / ${prev.rw.sourceEndColumn}`,
                  `${curr.rw.sourceStartColumn} / ${curr.rw.sourceEndColumn}`,
                  prev.t.original_driver_name ?? '—',
                  curr.t.original_driver_name ?? '—',
                  prev.t.assigned_driver_name ?? '—',
                  curr.t.assigned_driver_name ?? '—',
                  Math.round(gapMin * 10) / 10,
                  vehicleSwitchBufferMinutes,
                  `${driverName} · ${prev.t.car_identifier ?? '?'} → ${curr.t.car_identifier ?? '?'} · Abstand ${gapMin.toFixed(1).replace('.', ',')} Min < ${vehicleSwitchBufferMinutes} Min Puffer`,
                ]);
              }
            }
          }
        } else {
          for (const d of issue.details) {
            confliktRows.push([issue.label, 'Ja', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, d]);
          }
        }
      }
      if (confliktRows.length === 1) confliktRows.push(['(keine Konflikte)', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null]);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(confliktRows), 'Konflikte');

      // Sheet 4: Nicht_zugewiesene_Bloecke
      const nzbHeaders = [
        'Block ID',
        'Service-Datum',
        'Tatsächlicher Blockstart',
        'Tatsächliches Blockende',
        'Dauer (Min)',
        'Fahrten',
        'Fahrzeug',
        'Excel Rows',
        'Ablehnungsgrund',
        'Betroffener Fahrer',
      ];
      const nzbRows: (string | number | null)[][] = [nzbHeaders];
      for (const u of (result?.unassigned ?? [])) {
        const startMs = u.actual_start_ms ?? null;
        const endMs = u.actual_end_ms ?? null;
        const fmtMs = (ms: number | null) => {
          if (ms == null) return '';
          const d = new Date(ms);
          const pad = (n: number) => String(n).padStart(2, '0');
          return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        };
        const reason = eng(u.repair_reason, u.repair_reason_key, u.repair_reason_vars)
          || u.rejected.map(r => eng(r.detail, r.messageKey, r.messageVars) || r.reason).join('; ')
          || '—';
        const affectedDriver = u.rejected.length > 0 ? u.rejected.map(r => r.driver_name).filter(Boolean).join(', ') : '—';
        nzbRows.push([
          u.block_id,
          u.service_date,
          fmtMs(startMs),
          fmtMs(endMs),
          u.duration_minutes,
          u.trip_count,
          u.vehicle_identifier,
          u.first_excel_row != null && u.last_excel_row != null
            ? u.first_excel_row === u.last_excel_row
              ? String(u.first_excel_row)
              : `${u.first_excel_row}–${u.last_excel_row}`
            : '—',
          reason,
          affectedDriver,
        ]);
      }
      if (nzbRows.length === 1) nzbRows.push(['(keine offenen Blöcke)', null, null, null, null, null, null, null, null, null]);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(nzbRows), 'Nicht_zugewiesene_Bloecke');

      // Sheet 5: Zusammenfassung
      const zusammenHeaders = ['Kennzahl', 'Wert'];
      const p4 = phase4;
      const pd = result?.final_purge_debug;
      const zusammenRows: (string | number)[][] = [
        zusammenHeaders,
        ['Monat', `${MONTHS_DE_SHORT[month - 1]} ${year}`],
        ['Gesamt Fahrten', p4.summary.total_trips],
        ['Abgeschlossene Fahrten', p4.summary.abgeschlossen],
        ['Zu ändernde Fahrten', p4.summary.zu_aendern],
        ['Unveränderte Fahrten', p4.summary.unveraendert],
        ['Offene Fahrten', p4.summary.offene_fahrten],
        ['Zugewiesene Blöcke', p4.summary.zugewiesene_bloecke],
        ['Manuelle Ausnahmen', p4.summary.manuelle_ausnahmen],
        ['Qualitätskonflikte', planQualitaet.issues.length],
        ['Fahrzeug-Überschneidungen', planQualitaet.vehicleOverlaps.length],
        ['Fahrer-Überschneidungen', planQualitaet.issues.find(i => i.label === 'Fahrer-Überschneidung')?.details.length ?? 0],
        ['Fahrzeugwechsel zu kurz', planQualitaet.issues.find(i => i.label === 'Fahrzeugwechsel zu kurz')?.details.length ?? 0],
        ['Fahrzeugwechsel-Puffer', `${vehicleSwitchBufferMinutes} Min`],
        ['Zeitauflösung', 'Uhrzeit des Fahrtbeginns / Uhrzeit des Fahrtendes (raw_data_json)'],
        ['', ''],
        ['── final_purge_debug ──', ''],
        ['purge_assigned_count_before', pd?.assigned_count_before_purge ?? '—'],
        ['purge_assigned_count_after', pd?.assigned_count_after_purge ?? '—'],
        ['purge_unassigned_count_before', pd?.unassigned_count_before_purge ?? '—'],
        ['purge_unassigned_count_after', pd?.unassigned_count_after_purge ?? '—'],
        ['purge_evicted_blocks_count', pd?.evicted_blocks_count ?? '—'],
        ['purge_evicted_block_ids', pd?.evicted_block_ids.join(', ') ?? '—'],
        ['purge_configured_switch_buffer_min', pd?.configured_vehicle_switch_buffer_minutes ?? '—'],
        ['purge_validation_source', pd?.validation_source ?? '—'],
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(zusammenRows), 'Zusammenfassung');

      const monthStr = MONTHS_DE_SHORT[month - 1];
      XLSX.writeFile(wb, `Planqualitaet_Pruefexport_${monthStr}_${year}.xlsx`);
    } finally {
      setPruefExporting(false);
    }
  };

  const openResolver = (b: UnassignedBlock) => {
    setResolverBlock(b);
    setResolverDriverId('');
    setResolverDienstzeit(false);
    setResolverDaily(false);
    setResolverMonthly(false);
    setResolverError('');
  };
  const closeResolver = () => setResolverBlock(null);

  const handleLeaveOpen = (blockId: string) => {
    if (!result) return;
    setResult(applyLeaveOpen(result, selectedDrivers, blockId));
    setPhase4(null);
  };
  const handleUndoOpen = (blockId: string) => {
    if (!result) return;
    setResult(undoManualResolution(result, selectedDrivers, blockId));
    setPhase4(null);
  };
  const handleUndoManual = (blockId: string) => {
    if (!result) return;
    setResult(undoManualResolution(result, selectedDrivers, blockId));
    setPhase4(null);
  };

  const handleAcceptDienstzeitException = (blockId: string) => {
    if (!result) return;
    setResult(applyDienstzeitException(result, selectedDrivers, blockId));
    setPhase4(null);
  };

  const handleManuellLoesen = (blockId: string) => {
    if (!result) return;
    const newResult = unassignBlock(result, selectedDrivers, blockId);
    setResult(newResult);
    setPhase4(null);
    const unassigned = newResult.unassigned.find(b => b.block_id === blockId);
    if (unassigned) openResolver(unassigned);
  };

  const handleConfirmManual = () => {
    if (!result || !resolverBlock || !resolverDriverId) return;
    const beforeUnassigned = result.unassigned.length;
    const beforeAssigned = result.assigned.length;
    const r = applyManualAssignment(result, selectedDrivers, resolverBlock.block_id, resolverDriverId, {
      allowDienstzeit: resolverDienstzeit,
      allowDaily: resolverDaily,
      allowMonthly: resolverMonthly,
    });
    if (!r.ok) {
      // The blocking checks are the engine's discriminators; BLOCKING_CHECK_LABEL
      // turns each into a key. The two refusals that produce none carry a key.
      const blocking = (r.blockingChecks ?? []).filter(c => BLOCKING_CHECK_LABEL[c]);
      setResolverError(
        blocking.length > 0
          ? blocking.map(c => t(BLOCKING_CHECK_LABEL[c])).join(', ')
          : eng(r.reason, r.reasonKey),
      );
      return;
    }
    const v = r.result.validation;
    const bv = (() => {
      const warnings = r.result.inhaber_time_warnings;
      return {
        ...v,
        working_time_window_violations: Math.max(0, v.working_time_window_violations - warnings.filter(w => w.kind === 'dienstzeit').length),
        daily_max_violations: Math.max(0, v.daily_max_violations - warnings.filter(w => w.kind === 'tageslimit').length),
        monthly_max_violations: Math.max(0, v.monthly_max_violations - warnings.filter(w => w.kind === 'monatslimit').length),
      };
    })();
    const phase3Ok =
      bv.unassigned_blocks === 0 && bv.unassigned_trips === 0 &&
      bv.driver_overlaps === 0 && bv.vehicle_switch_violations === 0 &&
      bv.working_time_window_violations === 0 && bv.daily_max_violations === 0 &&
      bv.monthly_max_violations === 0 && bv.non_selected_assignments === 0 &&
      bv.multiple_vehicles_per_day_violations === 0;
    if (typeof console !== 'undefined') {
      console.info('[Monatsplanung] manual assignment confirmed', {
        blockId: resolverBlock.block_id,
        assignedDriverName: r.result.assigned.find(a => a.block_id === resolverBlock.block_id)?.driver_name ?? null,
        exceptions: {
          dienstzeit: resolverDienstzeit,
          tageslimit: resolverDaily,
          monatslimit: resolverMonthly,
        },
        unassignedBlocks: { before: beforeUnassigned, after: r.result.unassigned.length },
        assignedBlocks:   { before: beforeAssigned,   after: r.result.assigned.length },
        validation: v,
        canCreatePreview: phase3Ok,
      });
    }
    setResult(r.result);
    setPhase4(null);
    closeResolver();
  };

  // ── Manual-resolver classification ───────────────────────────────────────
  // For each selectable driver we compute the list of blocking reasons against
  // the current block. Reasons are split into hard blockers (never bypassable)
  // and exception-possible reasons (Dienstzeit / Tageslimit / Monatslimit).
  // Color group is decided by the most severe non-hard reason.
  // These strings are what monatsplanungPhase3.ts emits in `blockingChecks`;
  // they are matched against, never rendered — BLOCKING_CHECK_LABEL supplies
  // the text that is shown.
  const HARD_BLOCKERS = [
    'Fahrer-Überlappung',
    'Fahrzeugwechsel-Puffer',
    'Fahrer nutzt bereits anderes Fahrzeug an diesem Tag',
    'Arbeitstag nicht erlaubt',
    'Nicht ausgewählter Fahrer',
    'Fahrer nicht in Auswahl',
    'Notiz-Einschränkung',
  ] as const;
  const HARD_PRIORITY: Record<string, number> = {
    'Fahrer-Überlappung': 1,
    'Fahrzeugwechsel-Puffer': 2,
    'Fahrer nutzt bereits anderes Fahrzeug an diesem Tag': 2,
    'Arbeitstag nicht erlaubt': 3,
    'Nicht ausgewählter Fahrer': 4,
    'Fahrer nicht in Auswahl': 4,
    'Notiz-Einschränkung': 5,
  };
  type Group = 'green' | 'blue' | 'orange' | 'red';
  type DriverClass = {
    driver: PlanningDriver;
    reasons: string[];
    hardBlockers: string[];
    primaryHardBlocker: string | null;
    requiresDienstzeit: boolean;
    requiresTageslimit: boolean;
    requiresMonatslimit: boolean;
    group: Group;
    groupOrder: number;
    badge: TranslationKey;
  };
  const classifyDriver = (driver: PlanningDriver): DriverClass => {
    // Evaluate with NO bypass flags so every blocking reason surfaces.
    const evalNoBypass = result && resolverBlock
      ? evaluateManualCandidate(result, resolverBlock.block_id, driver.id, {
          allowDienstzeit: false, allowDaily: false, allowMonthly: false,
        })
      : { feasible: false, reason: '', blockingChecks: [] as string[] };
    const reasons = evalNoBypass.feasible ? [] : evalNoBypass.blockingChecks;

    const hardBlockers = reasons.filter(r => (HARD_BLOCKERS as readonly string[]).includes(r));
    const primaryHardBlocker = hardBlockers.length === 0
      ? null
      : [...hardBlockers].sort((a, b) => HARD_PRIORITY[a] - HARD_PRIORITY[b])[0];

    const requiresDienstzeit = reasons.includes('Außerhalb Dienstzeit');
    const requiresTageslimit = reasons.includes('Tageslimit überschritten');
    const requiresMonatslimit = reasons.includes('Monatslimit überschritten');

    let group: Group;
    let badge: TranslationKey;
    if (hardBlockers.length > 0) {
      group = 'red';
      badge = (primaryHardBlocker ? BLOCKING_CHECK_LABEL[primaryHardBlocker] : undefined) ?? 'mp.resolver.notPossible';
    } else if (requiresTageslimit && requiresMonatslimit) {
      group = 'orange'; badge = 'mp.resolver.dailyAndMonthlyExceeded';
    } else if (requiresMonatslimit) {
      group = 'orange'; badge = 'mp.reason.monthlyMaxExceeded';
    } else if (requiresTageslimit) {
      group = 'orange'; badge = 'mp.reason.dailyMaxExceeded';
    } else if (requiresDienstzeit) {
      group = 'blue'; badge = 'mp.reason.outsideWorkingTime';
    } else {
      group = 'green'; badge = 'mp.resolver.possible';
    }
    const groupOrder = group === 'green' ? 0 : group === 'blue' ? 1 : group === 'orange' ? 2 : 3;
    return {
      driver, reasons, hardBlockers, primaryHardBlocker,
      requiresDienstzeit, requiresTageslimit, requiresMonatslimit,
      group, groupOrder, badge,
    };
  };

  const resolverCandidates = useMemo<DriverClass[]>(() => {
    if (!result || !resolverBlock) return [];
    const out = selectedDrivers.map(classifyDriver);
    out.sort((a, b) => a.groupOrder - b.groupOrder || a.driver.name.localeCompare(b.driver.name, 'de'));
    return out;
    // classifyDriver depends on result/resolverBlock; safe to include selectedDrivers only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, resolverBlock, selectedDrivers]);

  const selectedClass = useMemo<DriverClass | null>(() => {
    if (!resolverDriverId) return null;
    return resolverCandidates.find(c => c.driver.id === resolverDriverId) ?? null;
  }, [resolverDriverId, resolverCandidates]);

  // canConfirm — exactly the rule the spec mandates.
  const canConfirm = useMemo(() => {
    if (!selectedClass) return false;
    if (selectedClass.hardBlockers.length > 0) return false;
    if (selectedClass.requiresDienstzeit && !resolverDienstzeit) return false;
    if (selectedClass.requiresTageslimit && !resolverDaily) return false;
    if (selectedClass.requiresMonatslimit && !resolverMonthly) return false;
    return true;
  }, [selectedClass, resolverDienstzeit, resolverDaily, resolverMonthly]);

  // Group → visual tokens. Row backgrounds use theme neutral surfaces so the
  // driver name stays readable in dark mode; the group color appears only as
  // dot, badge, border, and selected-state ring.
  const groupColors: Record<Group, { dot: string; border: string; badgeBg: string; badgeFg: string; ring: string; msgBg: string; msgFg: string }> = {
    green:  { dot: '#22c55e', border: 'rgba(34,197,94,0.35)',  badgeBg: 'rgba(34,197,94,0.18)',  badgeFg: '#86efac', ring: '#22c55e', msgBg: 'rgba(34,197,94,0.10)',  msgFg: '#86efac' },
    blue:   { dot: '#3b82f6', border: 'rgba(59,130,246,0.35)', badgeBg: 'rgba(59,130,246,0.18)', badgeFg: '#93c5fd', ring: '#3b82f6', msgBg: 'rgba(59,130,246,0.10)', msgFg: '#93c5fd' },
    orange: { dot: '#f97316', border: 'rgba(249,115,22,0.35)', badgeBg: 'rgba(249,115,22,0.18)', badgeFg: '#fdba74', ring: '#f97316', msgBg: 'rgba(249,115,22,0.10)', msgFg: '#fdba74' },
    red:    { dot: '#ef4444', border: 'rgba(239,68,68,0.35)',  badgeBg: 'rgba(239,68,68,0.18)',  badgeFg: '#fca5a5', ring: '#ef4444', msgBg: 'rgba(239,68,68,0.10)',  msgFg: '#fca5a5' },
  };

  const allRed = resolverCandidates.length > 0 && resolverCandidates.every(c => c.group === 'red');
  const redBlockerSummary = useMemo(() => {
    if (!allRed) return [] as string[];
    const set = new Set<string>();
    for (const c of resolverCandidates) {
      if (!c.primaryHardBlocker) continue;
      const key = BLOCKING_CHECK_LABEL[c.primaryHardBlocker];
      set.add(key ? t(key) : c.primaryHardBlocker);
    }
    return [...set];
  }, [allRed, resolverCandidates, t]);

  /**
   * Derived validation that strips out Inhaber-only working-time violations.
   * Inhaber Dienstzeit/Tageslimit/Monatslimit are non-blocking and live in
   * result.inhaber_time_warnings instead. All other counters (overlaps,
   * vehicle-switch, multi-vehicle, non-selected) are unchanged.
   */
  const blockingValidation = useMemo(() => {
    if (!result) return null;
    const v = result.validation;
    const warnings = result.inhaber_time_warnings;
    const inhaberDienstzeit = warnings.filter(w => w.kind === 'dienstzeit').length;
    const inhaberTageslimit = warnings.filter(w => w.kind === 'tageslimit').length;
    const inhaberMonatslimit = warnings.filter(w => w.kind === 'monatslimit').length;
    return {
      ...v,
      working_time_window_violations: Math.max(0, v.working_time_window_violations - inhaberDienstzeit),
      daily_max_violations: Math.max(0, v.daily_max_violations - inhaberTageslimit),
      monthly_max_violations: Math.max(0, v.monthly_max_violations - inhaberMonatslimit),
    };
  }, [result]);

  const status = useMemo<{ kind: 'ok' | 'incomplete' | 'failed' | 'ok_manual'; label: string } | null>(() => {
    if (!result || !blockingValidation) return null;
    const v = blockingValidation;
    const hasViolation =
      v.driver_overlaps > 0 ||
      v.vehicle_switch_violations > 0 ||
      v.working_time_window_violations > 0 ||
      v.daily_max_violations > 0 ||
      v.monthly_max_violations > 0 ||
      v.non_selected_assignments > 0 ||
      v.multiple_vehicles_per_day_violations > 0;
    if (hasViolation) return { kind: 'failed', label: t('mp.status.validationFailed') };
    if (v.unassigned_blocks > 0 || v.unassigned_trips > 0)
      return {
        kind: 'incomplete',
        label: t('mp.status.incomplete', { blocks: v.unassigned_blocks, trips: v.unassigned_trips }),
      };
    if (result.manual_summary.resolved_blocks > 0 || result.manual_summary.intentionally_open > 0)
      return { kind: 'ok_manual', label: t('mp.status.okManual') };
    return { kind: 'ok', label: t('mp.validationOk') };
  }, [result, blockingValidation, t]);

  return (
    <div className="space-y-6">
      <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <ListChecks size={16} /> {t('mp.phase3.title')}
            </h2>
            <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
              {t('mp.phase3.subtitle')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleRun}
            disabled={running || blocks.length === 0 || selectedDrivers.length === 0}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold shadow-sm transition-all hover:shadow-md hover:brightness-110 active:scale-[0.98] active:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-sm disabled:active:scale-100"
            style={{ background: 'var(--primary, #2563eb)', color: 'var(--primary-contrast, #fff)' }}
          >
            <Play size={16} />
            {running ? t('mp.phase3.calculating') : t('mp.phase3.calculate')}
          </button>
          <div className="text-xs flex items-center gap-1.5" style={{ color: 'var(--text-tertiary)' }}>
            <Info size={13} />
            {t('mp.phase3.defaultsHint', {
              maxDaily: DEFAULT_MAX_DAILY_HOURS,
              buffer: vehicleSwitchBufferMinutes,
              blocks: blocks.length,
              drivers: selectedDrivers.length,
            })}
          </div>
        </div>

        {/* Inhaber-Anteil setting — only shown when an Inhaber driver is in the pool */}
        {selectedDrivers.some(d => d.employment_type === 'company_owner') && (
          <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-3 flex-wrap">
              <label className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                {t('mp.phase3.ownerShareLabel')}
              </label>
              <input
                type="number"
                min={0}
                max={100}
                value={inhaberSharePercent}
                onChange={e => {
                  const v = Number(e.target.value);
                  if (isNaN(v) || v < 0 || v > 100) {
                    setInhaberShareError(t('mp.phase3.ownerShareError'));
                  } else {
                    setInhaberShareError('');
                    setInhaberSharePercent(v);
                  }
                }}
                className="w-20 text-sm px-2 py-1 rounded border"
                style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
              <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('mp.phase3.ownerShareHint', { percent: inhaberSharePercent })}
              </span>
              {inhaberShareError && (
                <span className="text-xs font-medium" style={{ color: '#dc2626' }}>{inhaberShareError}</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Cross-month info banner */}
      {crossMonthBlocks.length > 0 && (
        <div className="rounded-xl p-4 flex items-start gap-3" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)' }}>
          <Info size={16} style={{ color: '#3b82f6', flexShrink: 0, marginTop: 2 }} />
          <div>
            <p className="text-sm font-semibold" style={{ color: '#1d4ed8' }}>
              {t('mp.crossMonth.title', { count: crossMonthBlocks.length })}
            </p>
            <p className="text-xs mt-0.5" style={{ color: '#1e40af' }}>
              {crossMonthBlocks.length === 1
                ? t('mp.crossMonth.one', {
                    start: fmtTime(crossMonthBlocks[0].block_start_datetime),
                    end: fmtTime(crossMonthBlocks[0].block_end_datetime),
                  })
                : t('mp.crossMonth.many', { count: crossMonthBlocks.length })
              }
            </p>
          </div>
        </div>
      )}

      {runError && (
        <div className="rounded-lg px-4 py-3 text-sm flex items-start gap-2" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b' }}>
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">{t('mp.phase3.runError')}</div>
            <div className="text-xs mt-0.5" style={{ color: '#b91c1c' }}>{runError}</div>
          </div>
        </div>
      )}

      {result && (
        <>
          {/* Validation summary */}
          <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <h3 className="text-base font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>{t('mp.validation')}</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
              <Stat label={t('mp.vehicleBlocks')} value={result.validation.vehicle_blocks_total} />
              <Stat label={t('mp.assigned')} value={result.validation.assigned_blocks} tone="primary" />
              <Stat label={t('mp.unassigned')} value={result.validation.unassigned_blocks} tone={result.validation.unassigned_blocks > 0 ? 'warning' : undefined} />
              <Stat label={t('mp.resolvedTrips')} value={result.validation.resolved_trips} />
              <Stat label={t('mp.openTrips')} value={result.validation.unassigned_trips} tone={result.validation.unassigned_trips > 0 ? 'warning' : undefined} />
              <Stat label={t('mp.overlaps')} value={result.validation.driver_overlaps} tone={result.validation.driver_overlaps > 0 ? 'danger' : 'ok'} />
              <Stat label={t('mp.switchViolations')} value={result.validation.vehicle_switch_violations} tone={result.validation.vehicle_switch_violations > 0 ? 'danger' : 'ok'} />
              <Stat label={t('mp.workingTimeViolations')} value={blockingValidation?.working_time_window_violations ?? result.validation.working_time_window_violations} tone={(blockingValidation?.working_time_window_violations ?? result.validation.working_time_window_violations) > 0 ? 'danger' : 'ok'} />
              <Stat label={t('mp.dailyLimitViolations')} value={blockingValidation?.daily_max_violations ?? result.validation.daily_max_violations} tone={(blockingValidation?.daily_max_violations ?? result.validation.daily_max_violations) > 0 ? 'danger' : 'ok'} />
              <Stat label={t('mp.monthlyLimitViolations')} value={blockingValidation?.monthly_max_violations ?? result.validation.monthly_max_violations} tone={(blockingValidation?.monthly_max_violations ?? result.validation.monthly_max_violations) > 0 ? 'danger' : 'ok'} />
              <Stat label={t('mp.nonSelectedDrivers')} value={result.validation.non_selected_assignments} tone={result.validation.non_selected_assignments > 0 ? 'danger' : 'ok'} />
              {result.options.oneVehiclePerDriverDay && (
                <Stat
                  label={t('mp.multipleVehiclesPerDay')}
                  value={result.validation.multiple_vehicles_per_day_violations}
                  tone={result.validation.multiple_vehicles_per_day_violations > 0 ? 'danger' : 'ok'}
                />
              )}
              <Stat
                label={t('mp.driverNoteViolations')}
                value={noteViolations.length}
                tone={noteViolations.length > 0 ? 'danger' : 'ok'}
              />
              <div className="flex items-center">
                {status?.kind === 'ok' && (
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--success, #15803d)' }}>
                    <CheckCircle2 size={16} /> {status.label}
                  </span>
                )}
                {status?.kind === 'ok_manual' && (
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: '#0369a1' }}>
                    <ShieldAlert size={16} /> {status.label}
                  </span>
                )}
                {status?.kind === 'incomplete' && (
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: '#a16207' }}>
                    <AlertTriangle size={16} /> {status.label}
                  </span>
                )}
                {status?.kind === 'failed' && (
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--danger, #b91c1c)' }}>
                    <XCircle size={16} /> {status.label}
                  </span>
                )}
              </div>
            </div>

            {/* Fahrer-Notizen debug line */}
            <div className="mt-3 flex items-center gap-2 text-xs px-3 py-1.5 rounded" style={{ background: noteViolationsOk ? 'rgba(21,128,61,0.07)' : 'rgba(220,38,38,0.07)', color: noteViolationsOk ? '#166534' : '#991b1b' }}>
              <Shield size={12} />
              {notesLoadFailed
                ? `${t('mp.notes.sectionTitle')} — ${t('common.errorLoad')}`
                : noteViolationsOk
                  ? t('mp.notes.checkedOk')
                  : tPlural({ one: 'mp.notes.checkedError.one', other: 'mp.notes.checkedError.other' }, noteViolations.length)}
            </div>

            {result.repair_summary.attempted > 0 && (
              <div className="mt-4 flex items-center gap-2 text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
                <Wrench size={13} />
                {t('mp.repairPassSummary', {
                  attempted: result.repair_summary.attempted,
                  resolved: result.repair_summary.resolved,
                  moved: result.repair_summary.moved_blocks,
                })}
              </div>
            )}

            {(result.manual_summary.resolved_blocks > 0 || result.manual_summary.intentionally_open > 0 || result.manual_summary.dienstzeit_exceptions > 0 || result.manual_summary.daily_exceptions > 0 || result.manual_summary.monthly_exceptions > 0) && (
              <div className="mt-4 grid grid-cols-2 md:grid-cols-5 gap-3 px-3 py-3 rounded-lg" style={{ background: '#eff6ff', border: '1px solid #bfdbfe' }}>
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: '#1e40af' }}>{t('mp.manuallyResolvedBlocks')}</div>
                  <div className="text-lg font-bold" style={{ color: '#1e3a8a' }}>{result.manual_summary.resolved_blocks}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: '#1e40af' }}>{t('mp.workingTimeExceptions')}</div>
                  <div className="text-lg font-bold" style={{ color: '#1e3a8a' }}>{result.manual_summary.dienstzeit_exceptions}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: '#1e40af' }}>{t('mp.dailyLimitExceptions')}</div>
                  <div className="text-lg font-bold" style={{ color: '#1e3a8a' }}>{result.manual_summary.daily_exceptions}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: '#1e40af' }}>{t('mp.monthlyLimitExceptions')}</div>
                  <div className="text-lg font-bold" style={{ color: '#1e3a8a' }}>{result.manual_summary.monthly_exceptions}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: '#1e40af' }}>{t('mp.intentionallyOpen')}</div>
                  <div className="text-lg font-bold" style={{ color: '#1e3a8a' }}>{result.manual_summary.intentionally_open}</div>
                </div>
              </div>
            )}

            {result.inhaber_time_warnings.length > 0 && (
              <div className="mt-4 rounded-lg px-3 py-3" style={{ background: '#fffbeb', border: '1px solid #fde68a' }}>
                <div className="flex items-center gap-2 mb-2">
                  <Info size={13} style={{ color: '#92400e' }} />
                  <span className="text-xs font-semibold" style={{ color: '#92400e' }}>{t('mp.owner.warningsTitle')}</span>
                </div>
                <div className="space-y-1">
                  {result.inhaber_time_warnings.map((w, i) => {
                    // `w.kind` is Phase 3 data; only the label is translated.
                    const kindLabel = w.kind === 'dienstzeit'
                      ? t('mp.owner.kindWorkingTime')
                      : w.kind === 'tageslimit'
                        ? t('mp.reason.dailyMaxExceeded')
                        : t('mp.reason.monthlyMaxExceeded');
                    return (
                      <div key={i} className="text-xs flex items-center gap-2" style={{ color: '#78350f' }}>
                        <span className="font-medium">{w.driver_name}:</span>
                        <span>{t('mp.owner.nonBlockingSuffix', { label: kindLabel })}</span>
                        {w.detail && <span className="opacity-60">({eng(w.detail, w.detailKey, w.detailVars)})</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Phase-4-Blocker: hard Dienstzeit violations for regular drivers */}
            {result.window_violation_details.length > 0 && (
              <div className="mt-4 rounded-lg overflow-hidden" style={{ border: '1px solid #fca5a5', background: '#fef2f2' }}>
                <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid #fca5a5' }}>
                  <XCircle size={14} style={{ color: '#dc2626' }} />
                  <span className="text-sm font-semibold" style={{ color: '#991b1b' }}>{t('mp.phase4Blocker')}</span>
                  <span className="text-xs ml-1" style={{ color: '#b91c1c' }}>
                    — {tPlural({ one: 'mp.phase4BlockerCount.one', other: 'mp.phase4BlockerCount.other' }, result.window_violation_details.length)}
                  </span>
                </div>
                <div className="divide-y" style={{ borderColor: '#fecaca' }}>
                  {result.window_violation_details.map((v, i) => (
                    <div key={i} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="space-y-0.5 min-w-0">
                          <div className="text-sm font-semibold" style={{ color: '#7f1d1d' }}>
                            {v.driver_name}
                            <span className="font-normal ml-2 text-xs" style={{ color: '#b91c1c' }}>
                              {v.service_date} · {v.vehicle_identifier} · {v.block_start}–{v.block_end}
                            </span>
                          </div>
                          <div className="text-xs" style={{ color: '#991b1b' }}>
                            {eng(v.detail, v.detailKey, v.detailVars)}
                            {v.work_window_start && v.work_window_end && (
                              <span className="ml-1 opacity-70">({t('mp.workingTime')} {v.work_window_start}–{v.work_window_end})</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <button
                            onClick={() => handleAcceptDienstzeitException(v.block_id)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold transition-colors hover:brightness-95"
                            style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5' }}
                            title={t('mp.acceptWorkingTimeExceptionTooltip')}
                          >
                            <CheckCircle2 size={12} />
                            {t('mp.acceptWorkingTimeException')}
                          </button>
                          <button
                            onClick={() => handleManuellLoesen(v.block_id)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold transition-colors hover:brightness-95"
                            style={{ background: '#fff7ed', color: '#9a3412', border: '1px solid #fdba74' }}
                            title={t('mp.resolveManuallyTooltip')}
                          >
                            <Hand size={12} />
                            {t('mp.resolveManually')}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.noteWarnings.length > 0 && (
              <details className="mt-4">
                <summary className="text-sm cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                  {t('mp.noteWarnings', { count: result.noteWarnings.length })}
                </summary>
                <ul className="mt-2 space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {result.noteWarnings.map((w, i) => (
                    <li key={i}>• <strong>{w.driver_name}</strong>: "{w.note}" – {eng(w.reason, w.reasonKey)}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          {/* Inhaber-Priorität summary */}
          {(result.inhaber_summary.inhaber_trips > 0 || result.inhaber_summary.employee_trips > 0 || result.inhaber_summary.blocks_inhaber_could_not_take > 0) && (
            <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
              <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('mp.owner.priorityTitle')}</h3>
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full"
                  style={{
                    background: result.inhaber_summary.inhaber_status === 'on_target' ? '#f0fdf4' : result.inhaber_summary.inhaber_status === 'below_target' ? '#fff7ed' : '#eff6ff',
                    color: result.inhaber_summary.inhaber_status === 'on_target' ? '#15803d' : result.inhaber_summary.inhaber_status === 'below_target' ? '#c2410c' : '#1d4ed8',
                    border: `1px solid ${result.inhaber_summary.inhaber_status === 'on_target' ? '#bbf7d0' : result.inhaber_summary.inhaber_status === 'below_target' ? '#fed7aa' : '#bfdbfe'}`,
                  }}>
                  {t('mp.owner.targetShare', { percent: result.inhaber_summary.inhaber_share_percent })} · {
                    result.inhaber_summary.inhaber_status === 'on_target' ? t('mp.owner.onTarget') :
                    result.inhaber_summary.inhaber_status === 'below_target' ? t('mp.owner.belowTarget') : t('mp.owner.aboveTarget')
                  }
                </span>
              </div>

              {/* Target vs actual row */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 p-3 rounded-lg" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-0.5" style={{ color: 'var(--text-tertiary)' }}>{t('mp.owner.targetShareLabel')}</div>
                  <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{result.inhaber_summary.inhaber_share_percent}%</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-0.5" style={{ color: 'var(--text-tertiary)' }}>{t('mp.owner.targetHours')}</div>
                  <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{result.inhaber_summary.inhaber_target_hours.toFixed(1)} h</div>
                  <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{t('mp.owner.ofTotalHours', { hours: result.inhaber_summary.total_planned_hours.toFixed(1) })}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-0.5" style={{ color: 'var(--text-tertiary)' }}>{t('mp.owner.actualHours')}</div>
                  <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{result.inhaber_summary.inhaber_hours.toFixed(1)} h</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-0.5" style={{ color: 'var(--text-tertiary)' }}>{t('mp.deviation')}</div>
                  <div className="text-lg font-bold" style={{
                    color: result.inhaber_summary.inhaber_status === 'on_target' ? '#15803d' :
                           result.inhaber_summary.inhaber_status === 'below_target' ? '#ea580c' : '#1d4ed8',
                  }}>
                    {result.inhaber_summary.inhaber_deviation_hours >= 0 ? '+' : ''}{result.inhaber_summary.inhaber_deviation_hours.toFixed(1)} h
                  </div>
                  <div className="text-[10px] mt-0.5" style={{
                    color: result.inhaber_summary.inhaber_status === 'on_target' ? '#166534' :
                           result.inhaber_summary.inhaber_status === 'below_target' ? '#c2410c' : '#1d4ed8',
                  }}>
                    {result.inhaber_summary.inhaber_status === 'on_target' ? t('mp.owner.onTarget') :
                     result.inhaber_summary.inhaber_status === 'below_target' ? t('mp.owner.belowTarget') : t('mp.owner.aboveTarget')}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
                <div className="rounded-lg p-3" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: '#166534' }}>{t('mp.owner.ownerTrips')}</div>
                  <div className="text-2xl font-bold" style={{ color: '#15803d' }}>{result.inhaber_summary.inhaber_trips}</div>
                  <div className="text-xs mt-0.5" style={{ color: '#166534' }}>{result.inhaber_summary.inhaber_hours.toFixed(1)} {t('mp.hoursShort')}</div>
                </div>
                <div className="rounded-lg p-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: 'var(--text-tertiary)' }}>{t('mp.owner.employeeTrips')}</div>
                  <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{result.inhaber_summary.employee_trips}</div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{result.inhaber_summary.employee_hours.toFixed(1)} {t('mp.hoursShort')}</div>
                </div>
                <div className="rounded-lg p-3" style={{ background: result.inhaber_summary.drivers_below_min > 0 ? '#fff7ed' : '#f0fdf4', border: `1px solid ${result.inhaber_summary.drivers_below_min > 0 ? '#fed7aa' : '#bbf7d0'}` }}>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: result.inhaber_summary.drivers_below_min > 0 ? '#c2410c' : '#166534' }}>{t('mp.belowMinSalary')}</div>
                  <div className="text-2xl font-bold" style={{ color: result.inhaber_summary.drivers_below_min > 0 ? '#ea580c' : '#15803d' }}>{result.inhaber_summary.drivers_below_min}</div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{t('common.driver')}</div>
                </div>
                <div className="rounded-lg p-3" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: '#166534' }}>{t('mp.inSalaryRange')}</div>
                  <div className="text-2xl font-bold" style={{ color: '#15803d' }}>{result.inhaber_summary.drivers_in_range}</div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{t('mp.aboveMaxCount', { count: result.inhaber_summary.drivers_above_max })}</div>
                </div>
                <div className="rounded-lg p-3" style={{ background: result.inhaber_summary.blocks_inhaber_could_not_take > 0 ? '#fff7ed' : 'var(--bg-subtle)', border: `1px solid ${result.inhaber_summary.blocks_inhaber_could_not_take > 0 ? '#fed7aa' : 'var(--border)'}` }}>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: result.inhaber_summary.blocks_inhaber_could_not_take > 0 ? '#c2410c' : 'var(--text-tertiary)' }}>{t('mp.owner.notPossibleForOwner')}</div>
                  <div className="text-2xl font-bold" style={{ color: result.inhaber_summary.blocks_inhaber_could_not_take > 0 ? '#ea580c' : 'var(--text-tertiary)' }}>{result.inhaber_summary.blocks_inhaber_could_not_take}</div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{t('mp.blocks')}</div>
                </div>
              </div>
              {Object.keys(result.inhaber_summary.inhaber_rejection_reasons).length > 0 && (
                <div>
                  <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>{t('mp.owner.rejectionReasonsTitle')}</div>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(result.inhaber_summary.inhaber_rejection_reasons).map(([reason, count]) => {
                      // The keys of this map are Phase 3 reason codes — data.
                      const labels: Record<string, TranslationKey> = {
                        driver_overlap: 'mp.owner.rejectOverlap',
                        vehicle_switch_buffer_violation: 'mp.owner.rejectSwitchBuffer',
                        note_constraint: 'mp.owner.rejectNote',
                        outside_working_time_window: 'mp.reason.outsideWorkingTime',
                        daily_max_exceeded: 'mp.dailyLimit',
                        monthly_max_exceeded: 'mp.monthlyLimit',
                        one_vehicle_per_day: 'mp.owner.rejectVehicleSwitchPerDay',
                        wrong_weekday: 'mp.owner.rejectWrongWeekdays',
                        not_in_pool: 'mp.owner.rejectNoOwner',
                      };
                      const labelKey = labels[reason];
                      return (
                        <span key={reason} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium"
                          style={{ background: '#fef9c3', color: '#854d0e', border: '1px solid #fde68a' }}>
                          {labelKey ? t(labelKey) : reason}: {count}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Austausch-Reparatur summary */}
          {result.austausch_summary.resolved > 0 && (
            <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
              <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <Wrench size={16} /> {t('mp.swapRepair.title')}
                </h3>
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0' }}>
                  {tPlural({ one: 'mp.swapRepair.freedCount.one', other: 'mp.swapRepair.freedCount.other' }, result.austausch_summary.resolved)}
                </span>
              </div>
              <div className="space-y-2">
                {result.austausch_summary.swaps.map((sw, i) => (
                  <div key={i} className="text-xs rounded-lg px-3 py-2 flex flex-wrap gap-x-3 gap-y-1" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534' }}>
                    <span className="font-semibold">{sw.open_block_desc}</span>
                    <span>→ {sw.freed_driver}</span>
                    <span className="opacity-75">· {t('mp.swapRepair.donorBlock', { block: sw.donor_block_desc })}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Konflikt-Reparatur (Final Overlap Repair Pass) */}
          {repairResult && (
            <div
              className="rounded-xl p-5"
              style={{
                background: 'var(--bg-surface)',
                border: `1px solid ${repairResult.diagnostics.fahrerUeberschneidungen > 0 || repairResult.diagnostics.fahrzeugUeberschneidungen > 0 || repairResult.diagnostics.inhaberUeberschneidungen > 0 ? '#fca5a5' : '#86efac'}`,
              }}
            >
              <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <Shield size={16} /> {t('mp.repair.title')}
                </h3>
                <div className="flex items-center gap-2 flex-wrap">
                  {repairResult.movedBlocks.length > 0 && (
                    <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
                      {tPlural({ one: 'mp.repair.movedCount.one', other: 'mp.repair.movedCount.other' }, repairResult.movedBlocks.length)}
                    </span>
                  )}
                  {repairResult.diagnostics.fahrerUeberschneidungen === 0 && repairResult.diagnostics.fahrzeugUeberschneidungen === 0 && repairResult.diagnostics.inhaberUeberschneidungen === 0 ? (
                    <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0' }}>
                      {t('mp.repair.noConflicts')}
                    </span>
                  ) : (
                    <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' }}>
                      {tPlural({ one: 'mp.repair.conflictsRemaining.one', other: 'mp.repair.conflictsRemaining.other' }, repairResult.diagnostics.fahrerUeberschneidungen + repairResult.diagnostics.fahrzeugUeberschneidungen + repairResult.diagnostics.inhaberUeberschneidungen)}
                    </span>
                  )}
                  <button
                    onClick={() => setShowRepairDetails(v => !v)}
                    className="text-xs flex items-center gap-1 px-2 py-1 rounded"
                    style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                  >
                    {showRepairDetails ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    {t('mp.details')}
                  </button>
                </div>
              </div>

              {/* Summary grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <div className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-subtle)' }}>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-0.5" style={{ color: 'var(--text-tertiary)' }}>{t('mp.repair.conflictsBefore')}</div>
                  <div className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{repairResult.conflictsBefore}</div>
                </div>
                <div className="rounded-lg px-3 py-2" style={{ background: repairResult.movedBlocks.length > 0 ? 'rgba(37,99,235,0.06)' : 'var(--bg-subtle)', border: repairResult.movedBlocks.length > 0 ? '1px solid rgba(37,99,235,0.2)' : '1px solid transparent' }}>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-0.5" style={{ color: repairResult.movedBlocks.length > 0 ? '#1d4ed8' : 'var(--text-tertiary)' }}>{t('mp.repair.movedBlocks')}</div>
                  <div className="text-xl font-bold" style={{ color: repairResult.movedBlocks.length > 0 ? '#1d4ed8' : 'var(--text-primary)' }}>{repairResult.movedBlocks.length}</div>
                </div>
                <div className="rounded-lg px-3 py-2" style={{ background: repairResult.conflictsAfter > 0 ? 'rgba(220,38,38,0.06)' : 'rgba(21,128,61,0.06)', border: repairResult.conflictsAfter > 0 ? '1px solid rgba(220,38,38,0.2)' : '1px solid rgba(21,128,61,0.2)' }}>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-0.5" style={{ color: repairResult.conflictsAfter > 0 ? '#dc2626' : '#15803d' }}>{t('mp.repair.conflictsAfter')}</div>
                  <div className="text-xl font-bold" style={{ color: repairResult.conflictsAfter > 0 ? '#dc2626' : '#15803d' }}>{repairResult.conflictsAfter}</div>
                </div>
                <div className="rounded-lg px-3 py-2" style={{ background: repairResult.unrepairable.length > 0 ? 'rgba(234,88,12,0.06)' : 'var(--bg-subtle)', border: repairResult.unrepairable.length > 0 ? '1px solid rgba(234,88,12,0.2)' : '1px solid transparent' }}>
                  <div className="text-[10px] uppercase tracking-wider font-semibold mb-0.5" style={{ color: repairResult.unrepairable.length > 0 ? '#c2410c' : 'var(--text-tertiary)' }}>{t('mp.repair.unrepairable')}</div>
                  <div className="text-xl font-bold" style={{ color: repairResult.unrepairable.length > 0 ? '#c2410c' : 'var(--text-primary)' }}>{repairResult.unrepairable.length}</div>
                </div>
              </div>

              {/* Final diagnostics */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                {([
                  { key: 'mp.repair.diagDriverOverlaps' as TranslationKey, value: repairResult.diagnostics.fahrerUeberschneidungen, neutral: false },
                  { key: 'mp.repair.diagVehicleOverlaps' as TranslationKey, value: repairResult.diagnostics.fahrzeugUeberschneidungen, neutral: false },
                  { key: 'mp.repair.diagOwnerOverlaps' as TranslationKey, value: repairResult.diagnostics.inhaberUeberschneidungen, neutral: false },
                  { key: 'mp.repair.diagDurationChanges' as TranslationKey, value: repairResult.diagnostics.daueraenderungen, neutral: false },
                  { key: 'mp.repair.diagOutsideMonth' as TranslationKey, value: repairResult.diagnostics.ausserhalb, neutral: false },
                  { key: 'mp.repair.diagBufferViolated' as TranslationKey, value: repairResult.diagnostics.pufferVerletzt, neutral: false },
                  { key: 'mp.repair.unrepairable' as TranslationKey, value: repairResult.diagnostics.nichtReparierbar, neutral: false },
                  { key: 'mp.repair.diagIterations' as TranslationKey, value: repairResult.iterations, neutral: true },
                ]).map(({ key, value, neutral }) => (
                  <div key={key} className="text-xs flex items-center justify-between px-2 py-1 rounded" style={{ background: 'var(--bg-subtle)' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{t(key)}</span>
                    <span className="font-bold ml-2" style={{ color: value > 0 && !neutral ? '#dc2626' : 'var(--text-primary)' }}>{value}</span>
                  </div>
                ))}
              </div>

              {showRepairDetails && (
                <div className="space-y-4">
                  {/* Moved blocks */}
                  {repairResult.movedBlocks.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold mb-2" style={{ color: '#1d4ed8' }}>{t('mp.repair.movedConflictBlocks')}</div>
                      <div className="space-y-1.5">
                        {repairResult.movedBlocks.map((m, i) => (
                          <div key={i} className="text-xs rounded-lg px-3 py-2 flex flex-wrap gap-x-4 gap-y-1" style={{ background: 'rgba(37,99,235,0.04)', border: '1px solid rgba(37,99,235,0.15)', color: '#1e3a8a' }}>
                            <span className="font-mono font-semibold opacity-60">{m.blockId.slice(0, 8)}</span>
                            <span className="font-semibold">{m.vehicle}</span>
                            <span>{m.driverName}</span>
                            <span className="flex items-center gap-1">
                              <span className="opacity-70">{t('mp.repair.old')}:</span> {fmtRepairMs(m.oldStartMs)}–{fmtRepairMs(m.oldEndMs)}
                            </span>
                            <span className="flex items-center gap-1">
                              <ArrowRight size={10} />
                              <span className="opacity-70">{t('mp.repair.new')}:</span> {fmtRepairMs(m.newStartMs)}–{fmtRepairMs(m.newEndMs)}
                            </span>
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: '#dbeafe', color: '#1e40af' }}>{eng(m.reason, m.reasonKey)}</span>
                            <span className="opacity-60">{t('mp.repair.bufferUsed', { minutes: m.bufferUsedMin })}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Unrepairable blocks */}
                  {repairResult.unrepairable.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold mb-2" style={{ color: '#c2410c' }}>{t('mp.repair.unrepairableWhy')}</div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs border-collapse">
                          <thead>
                            <tr style={{ background: 'var(--bg-subtle)' }}>
                              <Th>{t('mp.blockId')}</Th>
                              <Th>{t('common.driver')}</Th>
                              <Th>{t('mp.vehicle')}</Th>
                              <Th align="right">{t('mp.duration')}</Th>
                              <Th align="right">{t('mp.repair.driverWindows')}</Th>
                              <Th align="right">{t('mp.repair.vehicleWindows')}</Th>
                              <Th align="right">{t('mp.repair.sharedWindows')}</Th>
                              <Th>{t('mp.reasonColumn')}</Th>
                            </tr>
                          </thead>
                          <tbody>
                            {repairResult.unrepairable.map((u, i) => (
                              <tr key={i} style={{ borderTop: '1px solid var(--border)', background: 'rgba(234,88,12,0.03)' }}>
                                <Td><span className="font-mono text-[10px]">{u.blockId.slice(0, 8)}</span></Td>
                                <Td>{u.driverName}</Td>
                                <Td><span className="font-mono">{u.vehicle}</span></Td>
                                <Td align="right">{Math.round(u.durationMs / 60000)} {t('mp.minShort')}</Td>
                                <Td align="right">{u.freeDriverWindowsChecked}</Td>
                                <Td align="right">{u.freeVehicleWindowsChecked}</Td>
                                <Td align="right">{u.sharedWindowsChecked}</Td>
                                <Td><span style={{ color: '#c2410c' }}>{eng(u.reason, u.reasonKey, u.reasonVars)}</span></Td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Per-driver summary */}
          <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <UserCheck size={16} /> {t('mp.perDriver')}
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: 'var(--bg-subtle)' }}>
                    <Th>{t('common.driver')}</Th>
                    <Th align="right">{t('mp.blocks')}</Th>
                    <Th align="right">{t('mp.hours')}</Th>
                    <Th align="right">{t('mp.monthlyTarget')}</Th>
                    <Th align="right">{t('mp.maxPerMonth')}</Th>
                    <Th align="right">{t('mp.maxPerDay')}</Th>
                    <Th>{t('mp.workingTime')}</Th>
                    <Th>{t('mp.salaryStatus')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {result.driverStates.map(s => {
                    const target = s.driver.target_monthly_hours;
                    const cap = s.driver.max_monthly_hours;
                    const targetTone =
                      target != null && s.monthly_minutes / 60 < target * 0.5 ? 'warning' :
                      cap != null && s.monthly_minutes / 60 > cap ? 'danger' : undefined;
                    const isOwner = s.driver.employment_type === 'company_owner';
                    const minSal = s.driver.planning_min_salary ?? s.driver.planning_target_salary ?? null;
                    const maxSal = s.driver.planning_max_salary ?? s.driver.planning_target_salary ?? null;
                    const hourlyRate = s.driver.planning_hourly_rate;
                    const brutto = hourlyRate != null && hourlyRate > 0 ? (s.monthly_minutes / 60) * hourlyRate : null;
                    let salaryBadge: React.ReactNode = null;
                    if (isOwner) {
                      salaryBadge = <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0' }}>{t('mp.owner.owner')}</span>;
                    } else if (brutto != null && minSal != null && maxSal != null) {
                      if (brutto < minSal - 0.01) {
                        salaryBadge = <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: '#fff3e0', color: '#e65100', border: '1px solid #ffcc80' }}>{t('mp.belowMinSalary')}</span>;
                      } else if (brutto > maxSal + 0.01) {
                        salaryBadge = <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: '#e3f2fd', color: '#0369a1', border: '1px solid #bfdbfe' }}>{t('mp.aboveMaxSalary')}</span>;
                      } else {
                        salaryBadge = <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0' }}>{t('mp.inSalaryRange')}</span>;
                      }
                    }
                    return (
                      <tr key={s.driver_id} style={{ borderTop: '1px solid var(--border)' }}>
                        <Td>{s.driver_name}</Td>
                        <Td align="right">{s.assigned.length}</Td>
                        <Td align="right">
                          <span style={{ color: targetTone === 'danger' ? 'var(--danger, #b91c1c)' : targetTone === 'warning' ? '#a16207' : 'var(--text-primary)' }}>
                            {fmtH(s.monthly_minutes)}
                          </span>
                        </Td>
                        <Td align="right">{target != null ? `${target}h` : '—'}</Td>
                        <Td align="right">{cap != null ? `${cap}h` : '—'}</Td>
                        <Td align="right">
                          {s.effective_max_daily_hours}h
                          {s.used_default_max_daily && (
                            <span className="ml-1 text-[10px]" style={{ color: 'var(--text-tertiary)' }}>({t('mp.defaultLabel')})</span>
                          )}
                        </Td>
                        <Td>
                          {s.driver.work_window_start && s.driver.work_window_end
                            ? `${s.driver.work_window_start}–${s.driver.work_window_end}`
                            : '—'}
                        </Td>
                        <Td>{salaryBadge ?? '—'}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Unassigned blocks */}
          {result.unassigned.length > 0 && (
            <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
              <div className="px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
                <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <XCircle size={16} /> {t('mp.unassignedBlocks')} ({result.unassigned.length})
                </h3>
              </div>
              <div className="overflow-x-auto max-h-[500px]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0" style={{ background: 'var(--bg-subtle)' }}>
                    <tr>
                      <Th>{t('common.date')}</Th>
                      <Th>{t('mp.licensePlate')}</Th>
                      <Th>{t('mp.start')}</Th>
                      <Th>{t('mp.end')}</Th>
                      <Th align="right">{t('mp.durationMinutes')}</Th>
                      <Th>{t('mp.rejections')}</Th>
                      <Th>{t('mp.action')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.unassigned.map(b => (
                      <tr key={b.block_id} style={{ borderTop: '1px solid var(--border)', background: b.intentionally_open ? '#f1f5f9' : undefined }}>
                        <Td>{fmtDate(b.service_date)}</Td>
                        <Td><span className="font-mono">{b.vehicle_identifier}</span></Td>
                        <Td>{fmtTime(b.block_start_datetime)}</Td>
                        <Td>{fmtTime(b.block_end_datetime)}</Td>
                        <Td align="right">{b.duration_minutes}</Td>
                        <Td>
                          <div className="space-y-0.5">
                            {b.rejected.length === 0 && (
                              <span style={{ color: 'var(--text-tertiary)' }}>{t('mp.noSuitableDrivers')}</span>
                            )}
                            {b.rejected.slice(0, 4).map((r, i) => (
                              <div key={i} className="text-[11px]">
                                <span className="font-semibold">{r.driver_name}</span>: <span style={{ color: 'var(--text-tertiary)' }}>{t(REASON_LABEL[r.reason])}</span> – {eng(r.detail, r.messageKey, r.messageVars)}
                              </div>
                            ))}
                            {b.rejected.length > 4 && (
                              <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{t('mp.andMore', { count: b.rejected.length - 4 })}</div>
                            )}
                            {b.repair_attempted && (
                              <div className="mt-1 space-y-0.5">
                                <div className="text-[11px] inline-flex items-center gap-1" style={{ color: '#a16207' }}>
                                  <Wrench size={11} /> {t('mp.repairAttempted', { reason: eng(b.repair_reason, b.repair_reason_key, b.repair_reason_vars) })}
                                </div>
                                {b.repair_attempts.slice(0, 5).map((ra, k) => (
                                  <div key={k} className="text-[10px] pl-4" style={{ color: 'var(--text-tertiary)' }}>
                                    {ra.strategy} → {ra.driver}: {ra.rejection_reason}
                                  </div>
                                ))}
                                {b.repair_attempts.length > 5 && (
                                  <div className="text-[10px] pl-4" style={{ color: 'var(--text-tertiary)' }}>
                                    {t('mp.andMoreRejectedAttempts', { count: b.repair_attempts.length - 5 })}
                                  </div>
                                )}
                              </div>
                            )}
                            {b.inhaber_rejection && (
                              <div className="mt-1 text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: '#fff7ed', color: '#c2410c' }}>
                                {t('mp.owner.attempted')}: {t(REASON_LABEL[b.inhaber_rejection.reason])} – {eng(b.inhaber_rejection.detail, b.inhaber_rejection.messageKey, b.inhaber_rejection.messageVars)}
                              </div>
                            )}
                            {b.repair_reason?.includes('Deckungspass') && (
                              <div className="mt-1 text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: '#fef9c3', color: '#854d0e' }}>
                                {t('mp.coveragePassAttempted')}
                              </div>
                            )}
                            {b.austausch_log && (
                              <div className="mt-1 text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0' }}>
                                <Wrench size={11} /> {t('mp.swapRepair.attempted', {
                                  donor: b.austausch_log.donor_driver_name,
                                  block: b.austausch_log.donor_block_desc,
                                  reason: b.austausch_log.reason,
                                })}
                              </div>
                            )}
                            {b.intentionally_open && (
                              <div className="mt-1 text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-semibold" style={{ background: '#e0e7ff', color: '#3730a3' }}>
                                <ShieldAlert size={11} /> {t('mp.leftOpenByUser')}
                              </div>
                            )}
                          </div>
                        </Td>
                        <Td>
                          {b.intentionally_open ? (
                            <button
                              onClick={() => handleUndoOpen(b.block_id)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold"
                              style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                            >
                              <RotateCcw size={11} /> {t('mp.reset')}
                            </button>
                          ) : (
                            <div className="flex flex-col gap-1">
                              <button
                                onClick={() => openResolver(b)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold"
                                style={{ background: 'var(--primary)', color: 'var(--primary-contrast, #fff)' }}
                              >
                                <Hand size={11} /> {t('mp.resolveManually')}
                              </button>
                              <button
                                onClick={() => handleLeaveOpen(b.block_id)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold"
                                style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                              >
                                {t('mp.leaveOpen')}
                              </button>
                            </div>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Assigned blocks — hidden from normal UI, data preserved */}
          {false && (
          <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <CheckCircle2 size={16} /> {t('mp.assignedBlocks')} ({result.assigned.length})
              </h3>
            </div>
            <div className="overflow-x-auto max-h-[600px]">
              <table className="w-full text-xs">
                <thead className="sticky top-0" style={{ background: 'var(--bg-subtle)' }}>
                  <tr>
                    <Th>{t('common.date')}</Th>
                    <Th>{t('mp.licensePlate')}</Th>
                    <Th>{t('mp.start')}</Th>
                    <Th>{t('mp.end')}</Th>
                    <Th align="right">{t('mp.durationMinutes')}</Th>
                    <Th>{t('common.driver')}</Th>
                    <Th>{t('mp.reasonColumn')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {result.assigned.map(b => {
                    const isRepairedMove = b.repair_moved === true && repairResult?.movedBlocks.some(m => m.blockId === b.block_id);
                    const hasConflict = repairResult && repairResult.conflictsAfter > 0 && (
                      repairResult.unrepairable.some(u => u.blockId === b.block_id)
                    );
                    return (
                    <tr key={b.block_id} style={{ borderTop: '1px solid var(--border)', background: hasConflict ? 'rgba(220,38,38,0.03)' : undefined }}>
                      <Td>{fmtDate(b.service_date)}</Td>
                      <Td><span className="font-mono">{b.vehicle_identifier}</span></Td>
                      <Td>{fmtTime(b.block_start_datetime)}</Td>
                      <Td>{fmtTime(b.block_end_datetime)}</Td>
                      <Td align="right">{b.duration_minutes}</Td>
                      <Td>
                        <span className="font-semibold">{b.driver_name}</span>
                        {b.used_default_max_daily && (
                          <span className="ml-1 text-[10px]" style={{ color: 'var(--text-tertiary)' }}>({t('mp.defaultHours', { hours: 8 })})</span>
                        )}
                        {isRepairedMove && (
                          <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded" style={{ background: '#dbeafe', color: '#1e40af', border: '1px solid #bfdbfe' }}>
                            <Wrench size={10} /> {t('mp.repaired')}
                          </span>
                        )}
                        {!isRepairedMove && (b.repair_applied || b.repair_moved) && (
                          <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded" style={{ background: '#fef3c7', color: '#92400e' }}>
                            <Wrench size={10} /> {b.repair_moved ? t('mp.movedLower') : t('mp.repairedLower')}
                          </span>
                        )}
                        {hasConflict && (
                          <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded font-semibold" style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' }}>
                            <AlertTriangle size={10} /> {t('mp.conflict')}
                          </span>
                        )}
                        {b.manual_exception?.confirmed_by_user && (
                          <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded font-semibold" style={{ background: '#dbeafe', color: '#1e40af' }} title={b.manual_exception.reason}>
                            <ShieldAlert size={10} /> {t('mp.manualException')}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <div className="flex items-start gap-2">
                          <span style={{ color: 'var(--text-tertiary)' }}>{b.assignment_reason}</span>
                          {b.manual_exception?.confirmed_by_user && (
                            <button
                              onClick={() => handleUndoManual(b.block_id)}
                              className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold"
                              style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                              title={t('mp.undoManualExceptionTooltip')}
                            >
                              <RotateCcw size={10} /> {t('mp.undo')}
                            </button>
                          )}
                        </div>
                      </Td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          )}
          <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h2 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <FileDiff size={16} /> {t('mp.phase4.title')}
                </h2>
                <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                  {t('mp.phase4.subtitle')}
                </p>
              </div>
            </div>

            {!(status?.kind === 'ok' || status?.kind === 'ok_manual') && (
              <div className="px-3 py-2 rounded-lg text-sm flex items-start gap-2" style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                <Lock size={15} className="mt-0.5" />
                {result.options.oneVehiclePerDriverDay && result.validation.multiple_vehicles_per_day_violations > 0
                  ? t('mp.phase4.lockedVehiclePerDay')
                  : t('mp.phase4.lockedGeneral')}
              </div>
            )}

            <div className="flex items-center gap-3 flex-wrap mt-3">
              <button
                onClick={handleBuildChangeSet}
                disabled={building4 || !(status?.kind === 'ok' || status?.kind === 'ok_manual')}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold shadow-sm transition-all hover:shadow-md hover:brightness-110 active:scale-[0.98] active:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-sm disabled:active:scale-100"
                style={{ background: 'var(--primary, #2563eb)', color: 'var(--primary-contrast, #fff)' }}
              >
                <FileDiff size={16} />
                {building4 ? t('mp.phase4.building') : t('mp.phase4.build')}
              </button>
              {(() => {
                const v = blockingValidation ?? result.validation;
                const phase3Ok = status?.kind === 'ok' || status?.kind === 'ok_manual';
                const phase4Ok = phase4 != null && phase4.valid;
                const hasOpen = v.unassigned_blocks > 0 || v.unassigned_trips > 0;
                const hasViolations =
                  v.driver_overlaps > 0 || v.vehicle_switch_violations > 0 ||
                  v.working_time_window_violations > 0 || v.daily_max_violations > 0 ||
                  v.monthly_max_violations > 0 || v.non_selected_assignments > 0 ||
                  v.multiple_vehicles_per_day_violations > 0;
                const hasQualityBlockers = qualityHardBlockers > 0;
                const hasNoteViolations = sectionENoteViolations.length > 0;
                const { canApply, blockedBy } = evaluateApplyGate({
                  phase3Ok,
                  phase4Ok,
                  hasOpenBlocks: hasOpen,
                  hasValidationViolations: hasViolations,
                  hasQualityBlockers,
                  notesLoadFailed,
                  hasNoteViolations,
                  hasImportId: !!importId,
                  alreadyApplied: !!applyResult?.success,
                });
                const disabledReason = blockedBy === 'not_complete' ? t('mp.apply.blockedNotComplete')
                  : blockedBy === 'needs_change_set' ? t('mp.apply.blockedNeedsChangeSet')
                  : blockedBy === 'open_blocks' ? t('mp.apply.blockedOpenBlocks')
                  : blockedBy === 'validation' ? t('mp.apply.blockedValidation')
                  : blockedBy === 'quality' ? t('mp.apply.blockedQuality')
                  // No dictionary key of its own: de.ts and en.ts belong to
                  // another change in this batch, so the sentence is composed
                  // from two keys both dictionaries already carry.
                  : blockedBy === 'notes_unavailable' ? `${t('mp.notes.sectionTitle')} — ${t('common.errorLoad')}`
                  : blockedBy === 'notes' ? t('mp.apply.blockedNotes')
                  : blockedBy === 'no_import_id' ? t('mp.apply.blockedNoImportId')
                  : blockedBy === 'already_applied' ? t('mp.apply.blockedAlreadyApplied')
                  : null;
                return (
                  <>
                    <button
                      type="button"
                      onClick={openApplyModal}
                      disabled={!canApply}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{ background: canApply ? '#15803d' : 'var(--bg-subtle)', color: canApply ? '#fff' : 'var(--text-secondary)', border: canApply ? '1px solid #15803d' : '1px solid var(--border)' }}
                      title={canApply ? t('mp.apply.tooltipReady') : t('mp.apply.lockedWithReason', { reason: disabledReason ?? '' })}
                    >
                      {canApply ? <Database size={14} /> : <Lock size={14} />} {t('mp.apply.applyPlan')}
                    </button>
                    {canApply && (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: '#15803d' }}>
                        <CheckCircle2 size={13} /> {t('mp.apply.readyToApply')}
                      </span>
                    )}
                    {!canApply && disabledReason && (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: '#dc2626' }}>
                        <XCircle size={13} /> {t('mp.apply.lockedWithReason', { reason: disabledReason })}
                      </span>
                    )}
                  </>
                );
              })()}
              <div className="text-xs flex items-center gap-1.5" style={{ color: 'var(--text-tertiary)' }}>
                <Info size={13} /> {t('mp.phase4.previewOnly', { count: trips.length })}
              </div>
            </div>

            {/* Prüf-Export XLSX button — visible once phase4 is built */}
            {phase4 && planQualitaet && (
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={handlePruefExport}
                  disabled={pruefExporting}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 transition-all"
                  style={{ background: 'rgba(37,99,235,0.08)', color: '#1d4ed8', border: '1px solid rgba(37,99,235,0.25)' }}
                >
                  {pruefExporting
                    ? <><Loader2 size={14} className="animate-spin" /> {t('mp.pruefExport.building')}</>
                    : <><Download size={14} /> {t('mp.pruefExport.download')}</>
                  }
                </button>
                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {/* The five sheet names are the workbook's own tabs — data, not labels. */}
                  {t('mp.pruefExport.sheetsHint')}
                </span>
              </div>
            )}

            {/* Planqualität section */}
            {planQualitaet && (
              <div className="mt-4 rounded-lg border overflow-hidden" style={{
                borderColor: qualityHardBlockers > 0 ? '#fca5a5' : '#86efac',
                background: qualityHardBlockers > 0 ? '#fef2f2' : '#f0fdf4',
              }}>
                <div className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-2">
                    {qualityHardBlockers > 0
                      ? <AlertTriangle size={15} style={{ color: '#dc2626' }} />
                      : <CheckCircle2 size={15} style={{ color: '#16a34a' }} />
                    }
                    <span className="text-sm font-semibold" style={{ color: qualityHardBlockers > 0 ? '#991b1b' : '#15803d' }}>
                      {t('mp.quality.title')}
                    </span>
                    {qualityHardBlockers > 0 && (
                      <span className="text-xs" style={{ color: '#b91c1c' }}>
                        — {tPlural({ one: 'mp.quality.conflictsFound.one', other: 'mp.quality.conflictsFound.other' }, qualityHardBlockers)}
                      </span>
                    )}
                    {qualityHardBlockers === 0 && (
                      <span className="text-xs" style={{ color: '#15803d' }}>— {t('mp.quality.noConflictsFound')}</span>
                    )}
                  </div>
                  {/* Purge notice: shown when blocks were moved to unassigned by the safety purge */}
                  {qualityHardBlockers === 0 && result && (result.final_purge_debug.evicted_blocks_count > 0) && (
                    <p className="text-xs px-4 pb-2" style={{ color: '#92400e' }}>
                      {t('mp.quality.purgeNotice')}
                    </p>
                  )}
                  {/* Duration warning: does not block applying — see Part D above. */}
                  {(planQualitaet?.durationWarningDetails.length ?? 0) > 0 && (
                    <div className="text-xs px-4 pb-2">
                      <p className="mb-1 font-semibold">
                        {t('mp.quality.durationWarning', { count: planQualitaet!.durationWarningDetails.length })}
                      </p>
                      {planQualitaet!.durationWarningDetails.slice(0, 10).map((line, i) => (
                        <p key={i} className="tabular-nums">{line}</p>
                      ))}
                    </div>
                  )}
                  {qualityHardBlockers > 0 && (
                    <button
                      onClick={() => setShowQualityDetails(v => !v)}
                      className="text-xs flex items-center gap-1 px-2 py-1 rounded"
                      style={{ background: 'transparent', color: '#991b1b', border: '1px solid #fca5a5' }}
                    >
                      {showQualityDetails ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      {showQualityDetails ? t('mp.hideDetails') : t('mp.showDetails')}
                    </button>
                  )}
                </div>
                {qualityHardBlockers > 0 && (
                  <div className="px-4 pb-3" style={{ color: '#7f1d1d' }}>
                    <p className="text-xs mb-2">
                      {t('mp.quality.cannotApplyYet')}
                    </p>
                    {showQualityDetails && (
                      <div className="space-y-4 mt-3">
                        {planQualitaet.issues.map((issue, i) => (
                          <div key={i}>
                            <div className="text-xs font-semibold mb-1.5" style={{ color: '#991b1b' }}>
                              {t(issue.labelKey)}
                            </div>

                            {/* ── Fahrzeug-Überschneidungen: rich pair diagnostics ── */}
                            {issue.label === 'Fahrzeug-Überschneidungen' && issue.vehicleOverlaps && issue.vehicleOverlaps.length > 0 ? (
                              <div className="space-y-2">
                                {/* Method note */}
                                <p className="text-[11px] px-2 py-1.5 rounded" style={{ background: 'rgba(185,28,28,0.06)', color: '#7f1d1d', border: '1px solid rgba(185,28,28,0.15)' }}>
                                  {t('mp.quality.methodNote')}
                                </p>

                                {/* Copy button */}
                                <div className="flex justify-end">
                                  <button
                                    onClick={copyOverlapReport}
                                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-semibold"
                                    style={{ background: 'rgba(185,28,28,0.08)', color: '#991b1b', border: '1px solid rgba(185,28,28,0.25)' }}
                                  >
                                    {copiedOverlaps ? <><ClipboardCheck size={11} /> {t('mp.copied')}</> : <><Clipboard size={11} /> {t('mp.copyConflictList')}</>}
                                  </button>
                                </div>

                                {/* Per-overlap cards */}
                                {issue.vehicleOverlaps.map((o, oi) => {
                                  const expanded = expandedOverlaps.has(oi);
                                  const diagLabel = o.diagnosis === 'source'
                                    ? t('mp.overlap.diagSource')
                                    : t('mp.overlap.diagChecker');
                                  const diagColor = o.diagnosis === 'source' ? '#991b1b' : '#92400e';
                                  const diagBg = o.diagnosis === 'source' ? 'rgba(185,28,28,0.07)' : 'rgba(234,179,8,0.1)';
                                  return (
                                    <div key={oi} className="rounded border overflow-hidden" style={{ borderColor: 'rgba(185,28,28,0.25)', background: 'rgba(255,255,255,0.6)' }}>
                                      {/* Header line */}
                                      <div className="flex items-center justify-between px-3 py-2">
                                        <div className="space-y-0.5">
                                          <div className="text-[11px] font-semibold font-mono" style={{ color: '#991b1b' }}>
                                            {(() => {
                                              const aDate = fmtAbsDate(o.tripA.tsStart);
                                              const bDate = fmtAbsDate(o.tripB.tsStart);
                                              const dateLabel = aDate === bDate ? aDate : `${aDate}→${bDate}`;
                                              return `${o.carId} · ${dateLabel} · ${t('mp.quality.overlapMinutes', { minutes: o.overlapMin })}`;
                                            })()}
                                          </div>
                                          <div className="flex items-center gap-3 text-[10px]" style={{ color: '#b91c1c' }}>
                                            <span>{t('mp.overlap.timeComparison')}</span>
                                            <span>{t('mp.overlap.columns')}: {o.startColUsed} / {o.endColUsed}</span>
                                          </div>
                                          <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: diagBg, color: diagColor }}>
                                            {diagLabel}
                                          </span>
                                        </div>
                                        <button
                                          onClick={() => toggleOverlapExpand(oi)}
                                          className="text-[11px] flex items-center gap-1 px-2 py-1 rounded shrink-0"
                                          style={{ background: 'transparent', color: '#991b1b', border: '1px solid rgba(185,28,28,0.3)' }}
                                        >
                                          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                                          {expanded ? t('mp.hide') : t('mp.showDetails')}
                                        </button>
                                      </div>

                                      {/* Expanded pair detail */}
                                      {expanded && (() => {
                                        const bothFull = o.tripA.usedFullDatetime && o.tripB.usedFullDatetime;
                                        const renderTrip = (trip: typeof o.tripA, label: string) => (
                                          <div className="px-3 py-2 text-[11px] space-y-0.5" style={{ borderTop: '1px solid rgba(185,28,28,0.15)', background: 'rgba(254,242,242,0.5)' }}>
                                            <div className="font-semibold" style={{ color: '#991b1b' }}>{label}</div>
                                            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5" style={{ color: '#7f1d1d' }}>
                                              {trip.rowIndex != null && <div>{t('mp.overlap.excelRow')}: <span className="font-mono font-semibold">{trip.rowIndex}</span></div>}
                                              <div>{t('mp.overlap.originalDriver')}: <span className="font-semibold">{trip.originalDriver}</span></div>
                                              <div>{t('mp.overlap.assigned')}: <span className="font-semibold">{trip.assignedDriver}</span></div>
                                              <div>{t('mp.overlap.canceled')}: <span className="font-semibold">{trip.isCanceled ? t('common.yes') : t('common.no')}</span></div>
                                              {(trip.srcStart || trip.srcEnd) && (
                                                <div className="col-span-2">
                                                  {t('mp.overlap.source')}: <span className="font-mono">{trip.srcStart || '?'}–{trip.srcEnd || '?'}</span>
                                                  {trip.usedFullDatetime && <span className="ml-1" style={{ color: '#15803d' }}>✓ {t('mp.overlap.fullTimestamp')}</span>}
                                                </div>
                                              )}
                                              <div className="col-span-2">
                                                {t('mp.overlap.normalized')}: <span className="font-mono">{trip.normStart || '?'}–{trip.normEnd || '?'}</span>
                                              </div>
                                            </div>
                                          </div>
                                        );
                                        return (
                                          <>
                                            <div className="px-3 py-1.5 text-[10px]" style={{ borderTop: '1px solid rgba(185,28,28,0.15)', background: 'rgba(254,242,242,0.3)', color: '#7f1d1d' }}>
                                              {t('mp.overlap.calculation')}: {bothFull ? t('mp.overlap.calcRealTimestamps') : t('mp.overlap.calcNormalized')}
                                            </div>
                                            {!bothFull && (
                                              <div className="px-3 py-1.5 text-[10px]" style={{ background: 'rgba(234,179,8,0.08)', borderTop: '1px solid rgba(234,179,8,0.2)', color: '#92400e' }}>
                                                {t('mp.overlap.normalizedHint')}
                                              </div>
                                            )}
                                            {renderTrip(o.tripA, t('mp.overlap.tripA'))}
                                            {renderTrip(o.tripB, t('mp.overlap.tripB'))}
                                          </>
                                        );
                                      })()}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              /* Other issue types: simple list */
                              <ul className="space-y-0.5">
                                {issue.details.slice(0, 10).map((d, j) => (
                                  <li key={j} className="text-[11px] font-mono pl-2" style={{ color: '#991b1b' }}>• {d}</li>
                                ))}
                                {issue.details.length > 10 && (
                                  <li className="text-[11px] pl-2" style={{ color: '#b91c1c' }}>{t('mp.andMore', { count: issue.details.length - 10 })}</li>
                                )}
                              </ul>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    <p className="text-[11px] mt-2" style={{ color: '#b91c1c' }}>
                      {t('mp.quality.safetyRulesNote')}
                    </p>
                  </div>
                )}
              </div>
            )}

            {phase4 && (
              <div className="mt-5 space-y-5">
                {/* Summary */}
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  <Stat label={t('mp.totalTrips')} value={phase4.summary.total_trips} />
                  <Stat label={t('mp.completedTrips')} value={phase4.summary.abgeschlossen} />
                  <Stat label={t('mp.phase4.tripsToChange')} value={phase4.summary.zu_aendern} tone="primary" />
                  <Stat label={t('mp.phase4.unchangedTrips')} value={phase4.summary.unveraendert} />
                  <Stat label={t('mp.assignedBlocks')} value={phase4.summary.zugewiesene_bloecke} />
                  <Stat label={t('mp.manualExceptions')} value={phase4.summary.manuelle_ausnahmen} tone={phase4.summary.manuelle_ausnahmen > 0 ? 'warning' : undefined} />
                  <Stat label={t('mp.workingTimeExceptions')} value={phase4.summary.dienstzeit_ausnahmen} />
                  <Stat label={t('mp.dailyLimitExceptions')} value={phase4.summary.tageslimit_ausnahmen} />
                  <Stat label={t('mp.monthlyLimitExceptions')} value={phase4.summary.monatslimit_ausnahmen} />
                  <Stat label={t('mp.openTrips')} value={phase4.summary.offene_fahrten} tone={phase4.summary.offene_fahrten > 0 ? 'warning' : 'ok'} />
                  <div className="flex items-center">
                    {phase4.valid ? (
                      <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--success, #15803d)' }}>
                        <CheckCircle2 size={16} /> {t('mp.phase4.consistent')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--danger, #b91c1c)' }}>
                        <XCircle size={16} /> {t('mp.phase4.inconsistent')}
                      </span>
                    )}
                  </div>
                </div>

                {phase4.consistencyIssues.length > 0 && (
                  <details className="rounded-lg" style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
                    <summary className="px-3 py-2 text-sm font-semibold cursor-pointer" style={{ color: '#991b1b' }}>
                      {t('mp.phase4.consistencyIssues', { count: phase4.consistencyIssues.length })}
                    </summary>
                    <ul className="px-4 pb-3 space-y-1 text-xs" style={{ color: '#991b1b' }}>
                      {phase4.consistencyIssues.slice(0, 50).map((c, i) => (
                        <li key={i}>• [{c.type}] {eng(c.detail, c.messageKey, c.messageVars)}</li>
                      ))}
                      {phase4.consistencyIssues.length > 50 && (
                        <li>{t('mp.andMore', { count: phase4.consistencyIssues.length - 50 })}</li>
                      )}
                    </ul>
                  </details>
                )}

                {/* Manual exceptions table */}
                {phase4.manual_exceptions.length > 0 && (
                  <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                    <div className="px-5 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                      <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                        <ShieldAlert size={14} /> {t('mp.manualExceptions')} ({phase4.manual_exceptions.length})
                      </h3>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead style={{ background: 'var(--bg-subtle)' }}>
                          <tr>
                            <Th>{t('common.date')}</Th>
                            <Th>{t('mp.licensePlate')}</Th>
                            <Th>{t('mp.start')}</Th>
                            <Th>{t('mp.end')}</Th>
                            <Th>{t('common.driver')}</Th>
                            <Th>{t('mp.exceptionType')}</Th>
                            <Th>{t('mp.justification')}</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {phase4.manual_exceptions.map(m => (
                            <tr key={m.block_id} style={{ borderTop: '1px solid var(--border)' }}>
                              <Td>{fmtDate(m.service_date)}</Td>
                              <Td><span className="font-mono">{m.vehicle_identifier}</span></Td>
                              <Td>{fmtTime(m.block_start_datetime)}</Td>
                              <Td>{fmtTime(m.block_end_datetime)}</Td>
                              <Td>{m.driver_name}</Td>
                              <Td>
                                {[m.dienstzeit && t('mp.workingTime'), m.tageslimit && t('mp.dailyLimit')].filter(Boolean).join(' + ') || '—'}
                              </Td>
                              <Td><span style={{ color: 'var(--text-tertiary)' }}>{m.reason}</span></Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Summary by Fahrer */}
                <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                  <div className="px-5 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                    <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                      <UserCheck size={14} /> {t('mp.summaryPerDriver')}
                    </h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead style={{ background: 'var(--bg-subtle)' }}>
                        <tr>
                          <Th>{t('common.driver')}</Th>
                          <Th align="right">{t('mp.trips')}</Th>
                          <Th align="right">{t('mp.blocks')}</Th>
                          <Th align="right">{t('mp.hours')}</Th>
                          <Th align="right">{t('mp.workingTimeExceptionsShort')}</Th>
                          <Th align="right">{t('mp.dailyLimitExceptionsShort')}</Th>
                          <Th align="right">{t('mp.monthlyLimitExceptionsShort')}</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {phase4.per_driver.map(d => (
                          <tr key={d.driver_id} style={{ borderTop: '1px solid var(--border)' }}>
                            <Td>{d.driver_name}</Td>
                            <Td align="right">{d.trips}</Td>
                            <Td align="right">{d.blocks}</Td>
                            <Td align="right">{(d.minutes / 60).toFixed(2)}h</Td>
                            <Td align="right">{d.dienstzeit_exceptions}</Td>
                            <Td align="right">{d.tageslimit_exceptions}</Td>
                            <Td align="right">{d.monatslimit_exceptions}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Change rows table */}
                <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                  <div className="px-5 py-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
                    <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                      <FileDiff size={14} /> {t('mp.changeSetPerTrip')} ({phase4.change_rows.length})
                    </h3>
                    <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                      {t('mp.showsFirstRows', { count: 500 })}
                    </span>
                  </div>
                  <div className="overflow-x-auto max-h-[600px]">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0" style={{ background: 'var(--bg-subtle)' }}>
                        <tr>
                          <Th>{t('mp.row')}</Th>
                          <Th>{t('common.date')}</Th>
                          <Th>{t('common.time')}</Th>
                          <Th>{t('mp.licensePlate')}</Th>
                          <Th>{t('mp.overlap.originalDriver')}</Th>
                          <Th>{t('mp.newDriver')}</Th>
                          <Th>{t('mp.block')}</Th>
                          <Th>{t('mp.overlap.source')}</Th>
                          <Th>{t('mp.exception')}</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {phase4.change_rows.slice(0, 500).map((r, i) => (
                          <tr key={i} style={{ borderTop: '1px solid var(--border)', background: r.assignment_source === 'manual_exception' ? '#eff6ff' : undefined }}>
                            <Td>{r.excel_row ?? '—'}</Td>
                            <Td>{fmtDate(r.service_date)}</Td>
                            <Td>{fmtTime(r.start_datetime)}–{fmtTime(r.end_datetime)}</Td>
                            <Td><span className="font-mono">{r.vehicle_identifier}</span></Td>
                            <Td>{r.original_driver_name || <span style={{ color: 'var(--text-tertiary)' }}>—</span>}</Td>
                            <Td>
                              <span className="font-semibold">{r.new_driver_name}</span>
                              {r.changed && (
                                <span className="ml-1 text-[10px] px-1 py-0.5 rounded" style={{ background: '#fef3c7', color: '#92400e' }}>{t('mp.changed')}</span>
                              )}
                            </Td>
                            <Td><span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{r.block_id.slice(0, 10)}…</span></Td>
                            <Td>
                              <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold" style={{
                                background: r.assignment_source === 'manual_exception' ? '#dbeafe' : r.assignment_source === 'repair' ? '#fef3c7' : 'var(--bg-subtle)',
                                color: r.assignment_source === 'manual_exception' ? '#1e40af' : r.assignment_source === 'repair' ? '#92400e' : 'var(--text-secondary)',
                              }}>
                                {r.assignment_source}
                              </span>
                            </Td>
                            <Td>
                              {(r.dienstzeit_exception || r.tageslimit_exception || r.monatslimit_exception) ? (
                                <span className="text-[10px]" style={{ color: '#1e40af' }}>
                                  {[r.dienstzeit_exception && t('mp.workingTime'), r.tageslimit_exception && t('mp.dailyLimit'), r.monatslimit_exception && t('mp.monthlyLimit')].filter(Boolean).join(' + ')}
                                </span>
                              ) : <span style={{ color: 'var(--text-tertiary)' }}>—</span>}
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* Fahrer-Notizen Prüfung (Section F) — always shown when result exists */}
            {result && (
              <div className="mt-4 rounded-lg overflow-hidden" style={{
                border: `1px solid ${noteViolationsOk ? '#86efac' : '#fca5a5'}`,
                background: noteViolationsOk ? '#f0fdf4' : '#fef2f2',
              }}>
                <div className="flex items-center gap-2 px-4 py-3">
                  {noteViolationsOk
                    ? <CheckCircle2 size={15} style={{ color: '#16a34a' }} />
                    : <AlertTriangle size={15} style={{ color: '#dc2626' }} />
                  }
                  <span className="text-sm font-semibold" style={{ color: noteViolationsOk ? '#15803d' : '#991b1b' }}>
                    {t('mp.notes.sectionTitle')}
                  </span>
                  <span className="text-xs ml-1" style={{ color: noteViolationsOk ? '#166534' : '#b91c1c' }}>
                    {notesLoadFailed
                      ? `— ${t('common.errorLoad')}`
                      : noteViolationsOk
                        ? `— ${t('mp.notes.noneExcluded')}`
                        : `— ${tPlural({ one: 'mp.notes.violationCount.one', other: 'mp.notes.violationCount.other' }, noteViolations.length)}`}
                  </span>
                </div>

                {/* Nothing to list when the read failed: the three rows below
                    are computed from the violations, and there are none. */}
                {!notesLoadFailed && !noteViolationsOk && (
                  <div className="px-4 pb-4">
                    <div className="grid grid-cols-1 gap-3 mb-3">
                      {/* Row A: Fahrer vollständig zugewiesen */}
                      {(() => {
                        // `reason` is produced by driverNoteValidation.ts; these
                        // substrings are what it emits, so they stay verbatim.
                        const emptyCount = noteViolations.filter(v => v.reason.includes('leer') || v.reason.includes('Nicht zugewiesen')).length;
                        return (
                          <div className="flex items-center gap-3 text-xs px-3 py-2 rounded" style={{ background: emptyCount > 0 ? 'rgba(220,38,38,0.06)' : 'rgba(21,128,61,0.06)', color: emptyCount > 0 ? '#991b1b' : '#166534' }}>
                            {emptyCount > 0 ? <XCircle size={13} /> : <CheckCircle2 size={13} />}
                            <span className="font-semibold">{t('mp.notes.rowADriversAssigned')}</span>
                            <span>{emptyCount > 0 ? tPlural({ one: 'mp.notes.rowABad.one', other: 'mp.notes.rowABad.other' }, emptyCount) : t('mp.notes.rowAGood')}</span>
                          </div>
                        );
                      })()}
                      {/* Row B: Fahrer-Notizen im Export */}
                      {(() => {
                        const noteCount = noteViolations.filter(v => v.noteType !== '—').length;
                        return (
                          <div className="flex items-center gap-3 text-xs px-3 py-2 rounded" style={{ background: noteCount > 0 ? 'rgba(220,38,38,0.06)' : 'rgba(21,128,61,0.06)', color: noteCount > 0 ? '#991b1b' : '#166534' }}>
                            {noteCount > 0 ? <XCircle size={13} /> : <CheckCircle2 size={13} />}
                            <span className="font-semibold">{t('mp.notes.rowBNotesInExport')}</span>
                            <span>{noteCount > 0 ? tPlural({ one: 'mp.notes.rowBBad.one', other: 'mp.notes.rowBBad.other' }, noteCount) : t('mp.notes.rowBGood')}</span>
                          </div>
                        );
                      })()}
                      {/* Row C: Export-Fahrer gegen Planung */}
                      {(() => {
                        const invalidCount = noteViolations.length;
                        return (
                          <div className="flex items-center gap-3 text-xs px-3 py-2 rounded" style={{ background: invalidCount > 0 ? 'rgba(220,38,38,0.06)' : 'rgba(21,128,61,0.06)', color: invalidCount > 0 ? '#991b1b' : '#166534' }}>
                            {invalidCount > 0 ? <XCircle size={13} /> : <CheckCircle2 size={13} />}
                            <span className="font-semibold">{t('mp.notes.rowCExportVsPlan')}</span>
                            <span>{invalidCount > 0 ? tPlural({ one: 'mp.notes.rowCBad.one', other: 'mp.notes.rowCBad.other' }, invalidCount) : t('mp.notes.rowCGood')}</span>
                          </div>
                        );
                      })()}
                    </div>

                    {/* Diagnostic table */}
                    <div className="text-xs font-semibold mb-2" style={{ color: '#991b1b' }}>{t('mp.notes.violationsTableTitle')}</div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          <tr style={{ background: 'rgba(220,38,38,0.08)' }}>
                            <Th>{t('mp.step')}</Th>
                            <Th>{t('common.driver')}</Th>
                            <Th>{t('mp.vehicle')}</Th>
                            <Th>{t('mp.blockId')}</Th>
                            <Th>{t('mp.rideStart')}</Th>
                            <Th>{t('mp.rideEnd')}</Th>
                            <Th>{t('mp.note')}</Th>
                            <Th>{t('common.period')}</Th>
                            <Th>{t('common.error')}</Th>
                            <Th>{t('mp.action')}</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {noteViolations.map((v, i) => {
                            const fmtVDt = (d: Date) => {
                              const pad = (n: number) => String(n).padStart(2, '0');
                              return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
                            };
                            return (
                              <tr key={i} style={{ borderTop: '1px solid rgba(220,38,38,0.15)', background: 'rgba(254,242,242,0.5)' }}>
                                <Td><span style={{ color: '#991b1b' }}>{v.stepName}</span></Td>
                                <Td><span className="font-semibold">{v.driverName}</span></Td>
                                <Td><span className="font-mono">{v.vehicleIdentifier ?? '—'}</span></Td>
                                <Td><span className="font-mono text-[10px]">{v.blockId ? v.blockId.slice(0, 10) : '—'}</span></Td>
                                <Td>{fmtVDt(v.blockStart)}</Td>
                                <Td>{fmtVDt(v.blockEnd)}</Td>
                                <Td>{v.noteType}</Td>
                                <Td>{v.noteRange}</Td>
                                <Td><span style={{ color: '#b91c1c' }}>{v.reason}</span></Td>
                                <Td><span className="px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: '#fee2e2', color: '#991b1b' }}>{v.action}</span></Td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded text-xs font-semibold" style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                      <Lock size={13} className="mt-0.5 shrink-0" />
                      {t('mp.notes.exportLocked')}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {applyOpen && result && phase4 && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(15, 23, 42, 0.6)' }}
          onClick={closeApplyModal}
        >
          <div
            className="rounded-xl shadow-2xl w-full max-w-2xl"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <div>
                <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <Database size={16} /> {t('mp.apply.confirmTitle')}
                </h3>
                <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                  {t('mp.apply.confirmSubtitle')}
                </div>
              </div>
              <button onClick={closeApplyModal} className="p-1 rounded" style={{ color: 'var(--text-tertiary)' }} disabled={applying}>
                <X size={16} />
              </button>
            </div>

            {!applyResult && (
              <>
                <div className="px-5 py-4">
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                    <Row
                      label={t('mp.fahrtenbuchFile')}
                      value={
                        <span
                          className="block truncate font-mono text-xs"
                          style={{ maxWidth: '100%' }}
                          title={sourceFileName || ''}
                        >
                          {sourceFileName || '—'}
                        </span>
                      }
                    />
                    <Row label={t('mp.runs.monthYear')} value={`${month}/${year}`} />
                    <Row label={t('mp.planner.blockSeparator')} value={`${blockSeparatorMinutes} ${t('mp.minShortNoDot')}`} />
                    <Row label={t('mp.planner.minBlockDuration')} value={`${minBlockDurationMinutes} ${t('mp.minShortNoDot')}${minBlockDurationMinutes === 0 ? ` ${t('mp.runs.offSuffix')}` : ''}`} />
                    <Row label={t('mp.planner.maxBlockDuration')} value={`${maxBlockDurationMinutes} ${t('mp.minShortNoDot')}`} />
                    <Row label={t('mp.completedTrips')} value={phase4.summary.abgeschlossen} />
                    <Row label={t('mp.apply.tripsToUpdate')} value={phase4.summary.zu_aendern} />
                    <Row label={t('mp.apply.canceledTripsUnchanged')} value={canceledCount} />
                    <Row label={t('mp.assignedBlocks')} value={phase4.summary.zugewiesene_bloecke} />
                    <Row label={t('mp.manualExceptions')} value={phase4.summary.manuelle_ausnahmen} />
                    <Row label={t('mp.workingTimeExceptions')} value={phase4.summary.dienstzeit_ausnahmen} />
                    <Row label={t('mp.dailyLimitExceptions')} value={phase4.summary.tageslimit_ausnahmen} />
                    <Row label={t('mp.monthlyLimitExceptions')} value={phase4.summary.monatslimit_ausnahmen} />
                  </dl>

                  <label className="mt-4 flex items-start gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={applyConfirmed}
                      onChange={e => setApplyConfirmed(e.target.checked)}
                      className="mt-1"
                      disabled={applying}
                    />
                    <span style={{ color: 'var(--text-primary)' }}>
                      {t('mp.apply.confirmCheckbox')}
                    </span>
                  </label>

                  {applyError && (
                    <div className="mt-3 text-xs px-3 py-2 rounded-lg" style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                      {applyError}
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-end gap-2 px-5 py-3 border-t" style={{ borderColor: 'var(--border)' }}>
                  <button
                    onClick={closeApplyModal}
                    disabled={applying}
                    className="px-3 py-2 rounded-lg text-sm font-semibold"
                    style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={handleApply}
                    disabled={!applyConfirmed || applying}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
                    style={{ background: '#15803d', color: '#fff' }}
                  >
                    <Database size={14} /> {applying ? t('mp.apply.applying') : t('mp.apply.applyFinal')}
                  </button>
                </div>
              </>
            )}

            {applyResult && (
              <div className="px-5 py-4 space-y-3">
                {applyResult.already_applied ? (
                  <div className="space-y-3">
                    <div className="px-3 py-2 rounded-lg text-sm" style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                      {t('mp.apply.alreadyAppliedPrefix')} <span className="font-mono">{applyResult.planning_run_id}</span>{t('mp.apply.alreadyAppliedSuffix', { date: applyResult.applied_at ?? '—' })}
                    </div>
                    <button
                      onClick={() => { setReplaceOpen(true); setReplaceTyped(''); setReplaceConfirmed(false); setReplaceError(''); }}
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold transition-colors hover:brightness-110"
                      style={{ background: '#b91c1c', color: '#fff' }}
                    >
                      <ShieldAlert size={14} /> {t('mp.replace.button')}
                    </button>
                    <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                      {t('mp.replace.explanation')}
                    </div>
                  </div>
                ) : applyResult.success ? (
                  (() => {
                    const expectedUpdated = phase4.summary.zu_aendern;
                    const expectedExceptions = phase4.summary.manuelle_ausnahmen;
                    const verifyOk =
                      applyResult.updated_trips === expectedUpdated &&
                      applyResult.manual_exceptions_saved === expectedExceptions &&
                      applyResult.verify_rows_with_run === expectedUpdated &&
                      applyResult.verify_exceptions_in_run === expectedExceptions &&
                      applyResult.verify_canceled_in_import === canceledCount;
                    return (
                      <>
                        <div className="px-3 py-2 rounded-lg text-sm font-semibold flex items-center gap-2" style={{ background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0' }}>
                          <CheckCircle2 size={15} /> {t('mp.apply.successTitle')}
                        </div>
                        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                          <Row label={t('mp.planningRunId')} value={<span className="font-mono text-xs">{applyResult.planning_run_id}</span>} />
                          <Row label={t('mp.apply.updatedTrips')} value={applyResult.updated_trips ?? 0} />
                          <Row label={t('mp.apply.skippedCanceledTrips')} value={applyResult.skipped_canceled ?? 0} />
                          <Row label={t('mp.apply.manualExceptionsSaved')} value={applyResult.manual_exceptions_saved ?? 0} />
                          <Row label={t('mp.appliedAt')} value={applyResult.applied_at ?? '—'} />
                          <Row label={t('mp.appliedBy')} value={<span className="font-mono text-xs">{applyResult.applied_by ?? '—'}</span>} />
                        </dl>
                        <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
                          <div className="font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{t('mp.apply.verifyTitle')}</div>
                          {t('mp.apply.verifyLine', {
                            assigned: applyResult.verify_assigned_in_import ?? 0,
                            canceled: applyResult.verify_canceled_in_import ?? 0,
                            withRun: applyResult.verify_rows_with_run ?? 0,
                            exceptions: applyResult.verify_exceptions_in_run ?? 0,
                          })}
                        </div>
                        {!verifyOk && (() => {
                          // Only a real mismatch if expected values are defined and non-null
                          const hasExpected = expectedUpdated != null && expectedExceptions != null;
                          const isRealMismatch = hasExpected && (
                            applyResult.updated_trips !== expectedUpdated ||
                            applyResult.manual_exceptions_saved !== expectedExceptions
                          );
                          return (
                            <div className="px-3 py-2 rounded-lg text-xs" style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                              {isRealMismatch ? (
                                <>
                                  <strong>{t('mp.apply.mismatchTitle')}</strong>
                                  <div className="mt-1">
                                    {t('mp.apply.mismatchDetail', {
                                      expectedUpdated,
                                      expectedExceptions,
                                      actualUpdated: applyResult.updated_trips ?? 0,
                                      actualExceptions: applyResult.manual_exceptions_saved ?? 0,
                                    })}
                                  </div>
                                </>
                              ) : (
                                <span>
                                  {t('mp.apply.verifyIncomplete')}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </>
                    );
                  })()
                ) : (
                  <div className="px-3 py-2 rounded-lg text-sm" style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                    {applyResult.message ?? t('mp.apply.failed')}
                  </div>
                )}
                {applyResult.success && !applyResult.already_applied && applyResult.planning_run_id && (
                  <div className="rounded-lg px-3 py-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                    <div className="flex items-start gap-2 mb-2">
                      <Info size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
                      <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {t('mp.apply.appliedTitle')}
                      </div>
                    </div>
                    <p className="text-[11px] mb-2" style={{ color: 'var(--text-secondary)' }}>
                      {t('mp.apply.nextStepsIntro')}
                    </p>
                    <ul className="text-[11px] space-y-1 mb-2" style={{ color: 'var(--text-secondary)' }}>
                      <li className="flex items-center gap-1.5"><CheckCircle2 size={11} style={{ color: 'var(--accent)' }} /> {t('mp.apply.checkTransferAnalysis')}</li>
                      <li className="flex items-center gap-1.5"><CheckCircle2 size={11} style={{ color: 'var(--accent)' }} /> {t('mp.quality.driverOverlap')}</li>
                      <li className="flex items-center gap-1.5"><CheckCircle2 size={11} style={{ color: 'var(--accent)' }} /> {t('mp.quality.vehicleOverlaps')}</li>
                      <li className="flex items-center gap-1.5"><CheckCircle2 size={11} style={{ color: 'var(--accent)' }} /> {t('mp.apply.checkSalaryDeviation')}</li>
                      <li className="flex items-center gap-1.5"><CheckCircle2 size={11} style={{ color: 'var(--accent)' }} /> {t('mp.stundennachweisPreview')}</li>
                    </ul>
                    <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                      {t('mp.apply.finalDocsAfterFinalization')}
                    </p>
                  </div>
                )}
                {(() => {
                  const runSummary = buildAppliedRunSummary();
                  const hasRunId = !!applyResult?.planning_run_id;
                  return (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
                      <div className="flex flex-wrap gap-2">
                        <button
                          disabled={!hasRunId}
                          onClick={() => {
                            const s = buildAppliedRunSummary();
                            if (s) { setApplyOpen(false); setStundenRun(s); }
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-all hover:brightness-110"
                          style={{ background: 'rgba(6,182,212,0.12)', color: '#0891b2', border: '1px solid rgba(6,182,212,0.3)' }}
                          title={!hasRunId ? t('mp.missingRunIdTooltip') : undefined}
                        >
                          <CalendarClock size={14} /> {t('mp.openStundennachweisPreview')}
                        </button>
                        <button
                          disabled={!hasRunId}
                          onClick={() => {
                            const s = buildAppliedRunSummary();
                            if (s) { setApplyOpen(false); setFinalizeRun(s); }
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-all hover:brightness-110"
                          style={{ background: 'rgba(245,158,11,0.12)', color: '#d97706', border: '1px solid rgba(245,158,11,0.3)' }}
                          title={!hasRunId ? t('mp.missingRunIdTooltip') : undefined}
                        >
                          <Sparkles size={14} /> {t('mp.runs.createFinalDocs')}
                        </button>
                      </div>
                      <button
                        onClick={closeApplyModal}
                        className="px-3 py-2 rounded-lg text-sm font-semibold"
                        style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                      >
                        {t('common.close')}
                      </button>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {stundenRun && (
        <MonatsplanungStundennachweisPreview
          run={buildStundennachweisRunRef(stundenRun, importMeta)}
          onClose={() => setStundenRun(null)}
        />
      )}

      {finalizeRun && (
        <FinalizePlanningModal
          run={finalizeRun}
          companyId={companyId}
          userId={user?.id}
          onClose={() => setFinalizeRun(null)}
          onFinalized={() => { if (onApplied) onApplied(); }}
        />
      )}

      {replaceOpen && applyResult?.already_applied && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          style={{ background: 'rgba(15, 23, 42, 0.7)' }}
          onClick={() => { if (!replacing) setReplaceOpen(false); }}
        >
          <div
            className="rounded-xl shadow-2xl w-full max-w-xl"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <div>
                <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: '#991b1b' }}>
                  <ShieldAlert size={16} /> {t('mp.replace.title')}
                </h3>
                <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                  {t('mp.replace.subtitle')}
                </div>
              </div>
              <button onClick={() => setReplaceOpen(false)} className="p-1 rounded" style={{ color: 'var(--text-tertiary)' }} disabled={replacing}>
                <X size={16} />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
                {t('mp.replace.oldRunId')}: <span className="font-mono">{applyResult.planning_run_id}</span><br />
                {t('mp.replace.file')}: <span className="font-mono">{sourceFileName || '—'}</span><br />
                {t('mp.runs.monthYear')}: {month}/{year}
              </div>
              <div>
                {/* ERSETZEN is the literal the user has to type; it is compared
                    verbatim below, so it is data and stays German. */}
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
                  {t('mp.replace.typeToConfirm')} <span className="font-mono font-bold">ERSETZEN</span>:
                </label>
                <input
                  type="text"
                  value={replaceTyped}
                  onChange={e => setReplaceTyped(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-sm font-mono"
                  style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                  placeholder="ERSETZEN"
                  disabled={replacing}
                />
              </div>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={replaceConfirmed}
                  onChange={e => setReplaceConfirmed(e.target.checked)}
                  className="mt-1"
                  disabled={replacing}
                />
                <span style={{ color: 'var(--text-primary)' }}>
                  {t('mp.replace.confirmCheckbox')}
                </span>
              </label>
              {replaceError && (
                <div className="text-xs px-3 py-2 rounded-lg" style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                  {replaceError}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t" style={{ borderColor: 'var(--border)' }}>
              <button
                onClick={() => setReplaceOpen(false)}
                disabled={replacing}
                className="px-3 py-2 rounded-lg text-sm font-semibold"
                style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleReplace}
                disabled={replaceTyped !== 'ERSETZEN' || !replaceConfirmed || replacing}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: '#b91c1c', color: '#fff' }}
              >
                {replacing ? <Loader2 size={14} className="animate-spin" /> : <ShieldAlert size={14} />}
                {replacing ? t('mp.replace.replacing') : t('mp.replace.replaceFinal')}
              </button>
            </div>
          </div>
        </div>
      )}

      {resolverBlock && result && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(15, 23, 42, 0.55)' }}
          onClick={closeResolver}
        >
          <div
            className="rounded-xl shadow-2xl w-full max-w-xl"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <div>
                <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <Hand size={16} /> {t('mp.resolver.title')}
                </h3>
                <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                  {fmtDate(resolverBlock.service_date)} · <span className="font-mono">{resolverBlock.vehicle_identifier}</span> · {fmtTime(resolverBlock.block_start_datetime)}–{fmtTime(resolverBlock.block_end_datetime)} · {t('mp.minutes', { minutes: resolverBlock.duration_minutes })} · {t('mp.tripsCount', { count: resolverBlock.trip_count })}
                </div>
              </div>
              <button onClick={closeResolver} className="p-1 rounded" style={{ color: 'var(--text-tertiary)' }}>
                <X size={16} />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('common.driver')}</label>
                <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                  <div className="max-h-72 overflow-y-auto">
                    {resolverCandidates.length === 0 && (
                      <div className="px-3 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('mp.resolver.noDrivers')}</div>
                    )}
                    {resolverCandidates.map(c => {
                      const sel = resolverDriverId === c.driver.id;
                      const col = groupColors[c.group];
                      const target = c.driver.target_monthly_hours;
                      const state = result?.driverStates.find(s => s.driver_id === c.driver.id);
                      const monthlyH = state ? (state.monthly_minutes / 60).toFixed(2) : null;
                      const dailyH = state && resolverBlock
                        ? ((state.daily_minutes.get(resolverBlock.service_date) ?? 0) / 60).toFixed(2)
                        : null;
                      const maxDaily = state?.effective_max_daily_hours ?? null;
                      const subline: string[] = [];
                      if (monthlyH != null && target != null) {
                        const delta = target - parseFloat(monthlyH);
                        if (delta > 0) subline.push(t('mp.resolver.belowMonthlyTarget', { hours: delta.toFixed(2) }));
                        else if (delta < 0) subline.push(t('mp.resolver.aboveMonthlyTarget', { hours: Math.abs(delta).toFixed(2) }));
                        else subline.push(t('mp.resolver.monthlyTargetReached'));
                      } else if (monthlyH != null) {
                        subline.push(t('mp.resolver.hoursThisMonth', { hours: monthlyH }));
                      }
                      if (dailyH != null && maxDaily != null) {
                        subline.push(t('mp.resolver.dayHours', { hours: dailyH, max: maxDaily }));
                      }
                      return (
                        <button
                          key={c.driver.id}
                          type="button"
                          onClick={() => { setResolverDriverId(c.driver.id); setResolverError(''); }}
                          className="w-full px-3 py-2.5 text-left flex items-center justify-between gap-3 text-sm transition-colors border-b last:border-b-0"
                          style={{
                            background: sel ? 'var(--bg-elevated, var(--bg-subtle))' : 'var(--bg-surface)',
                            borderColor: 'var(--border)',
                            boxShadow: sel ? `inset 3px 0 0 0 ${col.ring}` : `inset 3px 0 0 0 ${col.border}`,
                            color: 'var(--text-primary)',
                          }}
                        >
                          <span className="flex items-center gap-2.5 min-w-0">
                            <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: col.dot }} />
                            <span className="min-w-0">
                              <span className="font-semibold truncate block leading-tight">{c.driver.name}</span>
                              {subline.length > 0 && (
                                <span className="block text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-tertiary)' }}>
                                  {subline.join(' · ')}
                                </span>
                              )}
                            </span>
                          </span>
                          <span
                            className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider"
                            style={{ background: col.badgeBg, color: col.badgeFg }}
                            title={t(c.badge)}
                          >
                            {t(c.badge)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="mt-2 text-[10px] flex flex-wrap gap-x-3 gap-y-1" style={{ color: 'var(--text-tertiary)' }}>
                  <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: groupColors.green.dot }}/> {t('mp.resolver.possible')}</span>
                  <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: groupColors.blue.dot }}/> {t('mp.resolver.legendWorkingTime')}</span>
                  <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: groupColors.orange.dot }}/> {t('mp.resolver.legendLimit')}</span>
                  <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: groupColors.red.dot }}/> {t('mp.resolver.notPossible')}</span>
                </div>
              </div>

              {selectedClass && selectedClass.hardBlockers.length === 0 && (selectedClass.requiresDienstzeit || selectedClass.requiresTageslimit || selectedClass.requiresMonatslimit) && (
                <div className="space-y-2">
                  <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('mp.resolver.requiredExceptions')}</div>
                  {selectedClass.requiresDienstzeit && (
                    <label className="flex items-start gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={resolverDienstzeit}
                        onChange={e => { setResolverDienstzeit(e.target.checked); setResolverError(''); }}
                        className="mt-1"
                      />
                      <span>
                        <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('mp.workingTimeException')}</span>
                        <span className="block text-xs" style={{ color: 'var(--text-tertiary)' }}>
                          {t('mp.resolver.workingTimeExceptionDesc')}
                        </span>
                      </span>
                    </label>
                  )}
                  {selectedClass.requiresTageslimit && (
                    <label className="flex items-start gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={resolverDaily}
                        onChange={e => { setResolverDaily(e.target.checked); setResolverError(''); }}
                        className="mt-1"
                      />
                      <span>
                        <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('mp.dailyLimitException')}</span>
                        <span className="block text-xs" style={{ color: 'var(--text-tertiary)' }}>
                          {t('mp.resolver.dailyLimitExceptionDesc')}
                        </span>
                      </span>
                    </label>
                  )}
                  {selectedClass.requiresMonatslimit && (
                    <label className="flex items-start gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={resolverMonthly}
                        onChange={e => { setResolverMonthly(e.target.checked); setResolverError(''); }}
                        className="mt-1"
                      />
                      <span>
                        <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('mp.monthlyLimitException')}</span>
                        <span className="block text-xs" style={{ color: 'var(--text-tertiary)' }}>
                          {t('mp.resolver.monthlyLimitExceptionDesc')}
                        </span>
                      </span>
                    </label>
                  )}
                </div>
              )}

              {selectedClass && (() => {
                const col = groupColors[selectedClass.group];
                let msg: string;
                const required: string[] = [];
                if (selectedClass.requiresDienstzeit) required.push(t('mp.workingTimeException'));
                if (selectedClass.requiresTageslimit) required.push(t('mp.dailyLimitException'));
                if (selectedClass.requiresMonatslimit) required.push(t('mp.monthlyLimitException'));
                const hardBlockerKey = selectedClass.primaryHardBlocker
                  ? BLOCKING_CHECK_LABEL[selectedClass.primaryHardBlocker]
                  : undefined;
                if (selectedClass.group === 'green') msg = t('mp.resolver.msgPossible');
                else if (selectedClass.group === 'blue') msg = t('mp.resolver.msgWorkingTimeRequired');
                else if (selectedClass.group === 'orange') msg = t('mp.resolver.msgExceptionRequired', { list: required.join(', ') });
                else msg = t('mp.resolver.msgNotPossible', {
                  reason: hardBlockerKey ? t(hardBlockerKey) : (selectedClass.primaryHardBlocker ?? t('mp.resolver.hardBlocker')),
                });
                const isRed = selectedClass.group === 'red';
                return (
                  <div
                    className="text-xs px-3 py-2 rounded-lg"
                    style={{ background: col.msgBg, color: col.msgFg, border: `1px solid ${col.border}` }}
                  >
                    <span className="inline-flex items-start gap-1.5 font-semibold">
                      {isRed ? <XCircle size={12} className="mt-0.5" /> : <CheckCircle2 size={12} className="mt-0.5" />}
                      {msg}
                    </span>
                    {isRed && (
                      <div className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
                        {t('mp.resolver.cannotConfirm')}
                      </div>
                    )}
                  </div>
                );
              })()}

              {!selectedClass && allRed && (
                <div
                  className="text-xs px-3 py-2 rounded-lg"
                  style={{ background: groupColors.red.msgBg, color: groupColors.red.msgFg, border: `1px solid ${groupColors.red.border}` }}
                >
                  <div className="font-semibold inline-flex items-start gap-1.5">
                    <XCircle size={12} className="mt-0.5" />
                    {t('mp.resolver.noAssignableDriver')}
                  </div>
                  {redBlockerSummary.length > 0 && (
                    <div className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
                      {t('mp.resolver.hardBlockers')}: {redBlockerSummary.join(' · ')}
                    </div>
                  )}
                </div>
              )}

              <div className="text-[11px] px-3 py-2 rounded-lg" style={{ background: 'var(--bg-subtle)', color: 'var(--text-tertiary)' }}>
                <div className="font-semibold mb-0.5" style={{ color: 'var(--text-secondary)' }}>{t('mp.resolver.neverBypassable')}:</div>
                {[
                  t('mp.reason.driverOverlap'),
                  t('mp.reason.vehicleSwitchBuffer'),
                  ...(result?.options.oneVehiclePerDriverDay ? [t('mp.reason.oneVehiclePerDay')] : []),
                  t('mp.reason.wrongWeekday'),
                  t('mp.reason.driverNotSelected'),
                  t('mp.reason.noteConstraint'),
                ].join(' · ')}
              </div>

              {resolverError && (
                <div className="text-xs px-3 py-2 rounded-lg" style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                  {resolverError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t" style={{ borderColor: 'var(--border)' }}>
              <button
                onClick={closeResolver}
                className="px-3 py-2 rounded-lg text-sm font-semibold"
                style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleConfirmManual}
                disabled={!canConfirm}
                className="px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: 'var(--primary)', color: 'var(--primary-contrast, #fff)' }}
              >
                {t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'primary' | 'warning' | 'danger' | 'ok' }) {
  const color =
    tone === 'primary' ? 'var(--primary)' :
    tone === 'warning' ? '#a16207' :
    tone === 'danger' ? 'var(--danger, #b91c1c)' :
    tone === 'ok' ? 'var(--success, #15803d)' :
    'var(--text-primary)';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </div>
      <div className="text-xl font-bold" style={{ color }}>{value}</div>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className="px-3 py-2 text-[11px] uppercase tracking-wider font-semibold"
      style={{ color: 'var(--text-tertiary)', textAlign: align ?? 'left' }}>
      {children}
    </th>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs uppercase tracking-wider font-semibold" style={{ color: 'var(--text-tertiary)' }}>{label}</dt>
      <dd className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</dd>
    </>
  );
}

function Td({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <td className="px-3 py-2 align-top" style={{ color: 'var(--text-primary)', textAlign: align ?? 'left' }}>
      {children}
    </td>
  );
}
