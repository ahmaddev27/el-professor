// Monatsplanung – Phase 3
// Read-only driver-to-vehicle-block assignment preview.
// No persistence, no DB writes, no RPC calls.

import type { Phase1VehicleBlock } from './monatsplanungPhase1';
import type { PlanningDriver } from '../components/MonatsplanungDriverPool';
import { buildRideIntervalsFromBlocks, validateDriverNotesForPlanStep, type NoteViolation } from './driverNoteValidation';
export type { NoteViolation };

export const DEFAULT_MAX_DAILY_HOURS = 8;
export const MIN_VEHICLE_SWITCH_BUFFER_MINUTES = 30;
export const DEFAULT_VEHICLE_SWITCH_BUFFER_MINUTES = 30;

export type RejectReason =
  | 'wrong_weekday'
  | 'outside_working_time_window'
  | 'daily_max_exceeded'
  | 'monthly_max_exceeded'
  | 'driver_overlap'
  | 'vehicle_switch_buffer_violation'
  | 'one_vehicle_per_day'
  | 'note_constraint';

export interface Phase3Options {
  oneVehiclePerDriverDay?: boolean;
  /** Minimum gap in minutes required when a driver switches to a different vehicle. Default 30. */
  vehicleSwitchBufferMinutes?: number;
  /**
   * Structured notes loaded from driver_notes table, keyed by driver_id.
   * Used to apply exclude_from_plan constraints. Legacy drivers.notes remains as fallback.
   */
  driverNotesMap?: Map<string, StructuredNote[]>;
  /**
   * Stable planning run identifier used for deterministic salary target derivation.
   * If omitted, a pseudo-stable seed derived from the driver pool is used.
   */
  planningRunId?: string;
  /**
   * Target share of total planned working hours for the Inhaber (company_owner) driver.
   * Value is a percentage, e.g. 20 means the Inhaber should receive ~20% of total hours.
   * Default: 20. Range: 0–100.
   */
  inhaberSharePercent?: number;
}

/** A structured note row from the driver_notes table (subset of columns needed for planning). */
export interface StructuredNote {
  id: string;
  driver_id: string;
  note_type: string;
  note_text: string;
  note_planning_behavior: 'neutral' | 'exclude_from_plan' | 'must_include_in_plan';
  is_full_day: boolean;
  start_date: string | null;  // YYYY-MM-DD
  end_date: string | null;    // YYYY-MM-DD
  note_date: string | null;   // ISO timestamp fallback
  start_time: string | null;  // HH:MM
  end_time: string | null;    // HH:MM
}

export const DEFAULT_PHASE3_OPTIONS: Required<Omit<Phase3Options, 'driverNotesMap' | 'planningRunId'>> = {
  oneVehiclePerDriverDay: true,
  vehicleSwitchBufferMinutes: DEFAULT_VEHICLE_SWITCH_BUFFER_MINUTES,
  inhaberSharePercent: 20,
};

function resolveOptions(opts?: Phase3Options): Required<Omit<Phase3Options, 'driverNotesMap' | 'planningRunId'>> & { driverNotesMap: Map<string, StructuredNote[]>; planningRunId: string } {
  return {
    oneVehiclePerDriverDay: opts?.oneVehiclePerDriverDay ?? DEFAULT_PHASE3_OPTIONS.oneVehiclePerDriverDay,
    vehicleSwitchBufferMinutes: (opts?.vehicleSwitchBufferMinutes != null && opts.vehicleSwitchBufferMinutes >= 0)
      ? opts.vehicleSwitchBufferMinutes
      : DEFAULT_VEHICLE_SWITCH_BUFFER_MINUTES,
    driverNotesMap: opts?.driverNotesMap ?? new Map(),
    planningRunId: opts?.planningRunId ?? 'default-run',
    inhaberSharePercent: (opts?.inhaberSharePercent != null && opts.inhaberSharePercent >= 0 && opts.inhaberSharePercent <= 100)
      ? opts.inhaberSharePercent
      : DEFAULT_PHASE3_OPTIONS.inhaberSharePercent,
  };
}

function startDayKey(b: { block_start_datetime: string }): string {
  return b.block_start_datetime.slice(0, 10);
}

export interface RejectedCandidate {
  driver_id: string;
  driver_name: string;
  reason: RejectReason;
  detail: string;
}

export interface AssignedBlock extends Phase1VehicleBlock {
  driver_id: string;
  driver_name: string;
  assignment_reason: string;
  effective_max_daily_hours: number;
  used_default_max_daily: boolean;
  repair_applied?: boolean;
  repair_moved?: boolean;
  manual_exception?: {
    dienstzeit: boolean;
    daily: boolean;
    monthly?: boolean;
    confirmed_by_user: boolean;
    reason: string;
  };
}

export interface RepairAttemptLog {
  strategy: string;
  driver: string;
  rejection_reason: string;
}

export interface AustauschReparaturLog {
  success: boolean;
  donor_driver_name: string;
  donor_block_id: string;
  donor_block_desc: string;
  reason: string;
}

export interface UnassignedBlock extends Phase1VehicleBlock {
  rejected: RejectedCandidate[];
  repair_attempted: boolean;
  repair_reason: string;
  repair_attempts: RepairAttemptLog[];
  intentionally_open?: boolean;
  /** Why the Inhaber (company_owner) could not take this block, if present in the pool. */
  inhaber_rejection?: RejectedCandidate | null;
  /** Result of the Austausch-Reparatur capacity-unlocking swap attempt. */
  austausch_log?: AustauschReparaturLog;
}

export interface DriverPlanState {
  driver_id: string;
  driver_name: string;
  driver: PlanningDriver;
  effective_max_daily_hours: number;
  used_default_max_daily: boolean;
  assigned: AssignedBlock[];
  daily_minutes: Map<string, number>;
  monthly_minutes: number;
}

export interface Phase3Result {
  assigned: AssignedBlock[];
  unassigned: UnassignedBlock[];
  driverStates: DriverPlanState[];
  validation: {
    vehicle_blocks_total: number;
    assigned_blocks: number;
    unassigned_blocks: number;
    resolved_trips: number;
    unassigned_trips: number;
    driver_overlaps: number;
    vehicle_switch_violations: number;
    working_time_window_violations: number;
    daily_max_violations: number;
    monthly_max_violations: number;
    non_selected_assignments: number;
    multiple_vehicles_per_day_violations: number;
  };
  options: Phase3Options;
  multiple_vehicles_per_day_details: Array<{
    date: string;
    driver_id: string;
    driver_name: string;
    vehicles: string[];
    block_ids: string[];
  }>;
  noteWarnings: Array<{ driver_id: string; driver_name: string; note: string; reason: string }>;
  /**
   * Hard Dienstzeit violations for regular (non-Inhaber) drivers with no accepted exception.
   * Each entry can be resolved via manual re-assignment or a block-specific Dienstzeit exception.
   */
  window_violation_details: Array<{
    block_id: string;
    driver_id: string;
    driver_name: string;
    service_date: string;
    vehicle_identifier: string;
    block_start: string;
    block_end: string;
    work_window_start: string | null;
    work_window_end: string | null;
    detail: string;
  }>;
  /**
   * Non-blocking informational warnings for Inhaber (company_owner) working-time violations.
   * These do NOT contribute to hard validation counts and do NOT block Phase 4.
   */
  inhaber_time_warnings: Array<{
    driver_id: string;
    driver_name: string;
    kind: 'dienstzeit' | 'tageslimit' | 'monatslimit';
    detail: string;
  }>;
  repair_summary: {
    attempted: number;
    resolved: number;
    moved_blocks: number;
  };
  manual_summary: {
    resolved_blocks: number;
    dienstzeit_exceptions: number;
    daily_exceptions: number;
    monthly_exceptions: number;
    intentionally_open: number;
  };
  final_purge_debug: {
    assigned_count_before_purge: number;
    assigned_count_after_purge: number;
    unassigned_count_before_purge: number;
    unassigned_count_after_purge: number;
    evicted_blocks_count: number;
    evicted_block_ids: string[];
    configured_vehicle_switch_buffer_minutes: number;
    validation_source: 'block-level';
  };
  inhaber_summary: {
    inhaber_trips: number;
    inhaber_hours: number;
    employee_trips: number;
    employee_hours: number;
    drivers_above_max: number;
    drivers_below_min: number;
    drivers_in_range: number;
    blocks_inhaber_could_not_take: number;
    inhaber_rejection_reasons: Record<string, number>;
    /** Total planned hours across all blocks (used for target computation). */
    total_planned_hours: number;
    /** Inhaber target hours = total_planned_hours × inhaberSharePercent / 100. */
    inhaber_target_hours: number;
    /** Configured share percentage (0–100). */
    inhaber_share_percent: number;
    /** Deviation of actual from target in hours (positive = over, negative = under). */
    inhaber_deviation_hours: number;
    /** Whether Inhaber is below, within, or above the tolerance band. */
    inhaber_status: 'below_target' | 'on_target' | 'above_target';
  };
  austausch_summary: {
    attempted: number;
    resolved: number;
    swaps: Array<{
      open_block_id: string;
      open_block_desc: string;
      freed_driver: string;
      donor_block_id: string;
      donor_block_desc: string;
    }>;
  };
  /**
   * Driver-note violations detected after assignment.
   * A non-empty array means some assigned blocks still violate "Von Planung ausschließen"
   * notes — these must be resolved before export.
   */
  note_violations: NoteViolation[];
}

// ── helpers ────────────────────────────────────────────────────────────────

type ResolvedOptions = Required<Omit<Phase3Options, 'driverNotesMap' | 'planningRunId'>> & { driverNotesMap: Map<string, StructuredNote[]>; planningRunId: string };

const HARD_NOTE_TOKENS: Array<{ token: RegExp; reason: string }> = [
  { token: /keine\s+nachtschicht/i, reason: 'Notiz: keine Nachtschicht' },
  { token: /nur\s+morgens/i, reason: 'Notiz: nur morgens' },
  { token: /nur\s+wochenende/i, reason: 'Notiz: nur Wochenende' },
  { token: /nicht\s+montag/i, reason: 'Notiz: nicht montags' },
  { token: /nicht\s+dienstag/i, reason: 'Notiz: nicht dienstags' },
  { token: /nicht\s+mittwoch/i, reason: 'Notiz: nicht mittwochs' },
  { token: /nicht\s+donnerstag/i, reason: 'Notiz: nicht donnerstags' },
  { token: /nicht\s+freitag/i, reason: 'Notiz: nicht freitags' },
  { token: /nicht\s+samstag/i, reason: 'Notiz: nicht samstags' },
  { token: /nicht\s+sonntag/i, reason: 'Notiz: nicht sonntags' },
];

function parseLocalIsoMs(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

/** Prefer actual UTC ms from raw_data_json; fall back to ISO datetime parse. */
function blockStartMs(b: Phase1VehicleBlock): number {
  return b.actual_start_ms != null ? b.actual_start_ms : parseLocalIsoMs(b.block_start_datetime);
}
function blockEndMs(b: Phase1VehicleBlock): number {
  return b.actual_end_ms != null ? b.actual_end_ms : parseLocalIsoMs(b.block_end_datetime);
}

function isoWeekday(dateStr: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return 0;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const js = dt.getUTCDay();
  return js === 0 ? 7 : js;
}

function timeToMin(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? +m[1] * 60 + +m[2] : null;
}

function blockTimeOfDayMinutes(b: Phase1VehicleBlock): { start: number; end: number } {
  const sm = /T(\d{2}):(\d{2})/.exec(b.block_start_datetime);
  const em = /T(\d{2}):(\d{2})/.exec(b.block_end_datetime);
  const start = sm ? +sm[1] * 60 + +sm[2] : 0;
  let end = em ? +em[1] * 60 + +em[2] : 0;
  const sd = b.block_start_datetime.slice(0, 10);
  const ed = b.block_end_datetime.slice(0, 10);
  if (ed > sd) end += 24 * 60;
  if (end < start) end += 24 * 60;
  return { start, end };
}

function fmtMinAsTime(m: number): string {
  const dayMin = ((m % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(dayMin / 60);
  const mm = dayMin % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function fmtHours(min: number): string {
  return `${(min / 60).toFixed(2)}h`;
}

// ── rule checks ────────────────────────────────────────────────────────────

function checkWindow(driver: PlanningDriver, block: Phase1VehicleBlock): RejectedCandidate | null {
  if (driver.allowed_weekdays && driver.allowed_weekdays.length > 0) {
    const iso = isoWeekday(block.service_date);
    if (!driver.allowed_weekdays.includes(iso)) {
      const names = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
      return {
        driver_id: driver.id,
        driver_name: driver.name,
        reason: 'wrong_weekday',
        detail: `Arbeitstag nicht erlaubt (${names[iso] ?? '?'})`,
      };
    }
  }
  if (driver.is_full_day_available) {
    return null;
  }
  if (driver.work_window_start && driver.work_window_end) {
    const wStart = timeToMin(driver.work_window_start);
    const wEnd = timeToMin(driver.work_window_end);
    if (wStart != null && wEnd != null) {
      const { start: bStart, end: bEnd } = blockTimeOfDayMinutes(block);
      let ok = false;
      if (wStart <= wEnd) {
        ok = bStart >= wStart && bEnd <= wEnd;
      } else {
        ok = bStart >= wStart && bEnd <= 24 * 60 + wEnd;
      }
      if (!ok) {
        return {
          driver_id: driver.id,
          driver_name: driver.name,
          reason: 'outside_working_time_window',
          detail: `Block ${fmtMinAsTime(bStart)}–${fmtMinAsTime(bEnd)} liegt außerhalb Dienstzeit ${driver.work_window_start}–${driver.work_window_end}`,
        };
      }
    }
  }
  return null;
}

function checkDaily(state: DriverPlanState, block: Phase1VehicleBlock): RejectedCandidate | null {
  if (state.driver.employment_type === 'company_owner') return null;
  const maxMin = Math.round(state.effective_max_daily_hours * 60);
  const used = state.daily_minutes.get(block.service_date) ?? 0;
  if (used + block.duration_minutes > maxMin) {
    return {
      driver_id: state.driver_id,
      driver_name: state.driver_name,
      reason: 'daily_max_exceeded',
      detail: `Tageslimit ${state.effective_max_daily_hours}h überschritten (${fmtHours(used + block.duration_minutes)})${
        state.used_default_max_daily ? ' [Fallback 8h]' : ''
      }`,
    };
  }
  return null;
}

function checkMonthly(state: DriverPlanState, block: Phase1VehicleBlock): RejectedCandidate | null {
  const driver = state.driver;
  if (driver.employment_type === 'company_owner') return null;
  if (driver.max_monthly_hours == null) return null;
  const capMin = Math.round(driver.max_monthly_hours * 60);
  if (state.monthly_minutes + block.duration_minutes > capMin) {
    return {
      driver_id: state.driver_id,
      driver_name: state.driver_name,
      reason: 'monthly_max_exceeded',
      detail: `Monatslimit ${driver.max_monthly_hours}h überschritten`,
    };
  }
  return null;
}

function checkOverlap(state: DriverPlanState, block: Phase1VehicleBlock): RejectedCandidate | null {
  const bs = blockStartMs(block);
  const be = blockEndMs(block);
  for (const a of state.assigned) {
    const as = blockStartMs(a);
    const ae = blockEndMs(a);
    if (bs < ae && be > as) {
      return {
        driver_id: state.driver_id,
        driver_name: state.driver_name,
        reason: 'driver_overlap',
        detail: `Überlappung mit ${a.vehicle_identifier} ${a.block_start_datetime.slice(11, 16)}–${a.block_end_datetime.slice(11, 16)} am ${a.service_date}`,
      };
    }
  }
  return null;
}

function checkVehicleSwitch(state: DriverPlanState, block: Phase1VehicleBlock, bufferMinutes: number): RejectedCandidate | null {
  const bs = blockStartMs(block);
  const be = blockEndMs(block);
  for (const a of state.assigned) {
    if (a.vehicle_id === block.vehicle_id) continue;
    const as = blockStartMs(a);
    const ae = blockEndMs(a);
    // Use full ms timestamps — handles overnight blocks spanning midnight correctly.
    let gap: number;
    if (ae <= bs) gap = (bs - ae) / 60000;
    else if (be <= as) gap = (as - be) / 60000;
    else continue; // overlapping — caught by checkOverlap
    if (gap >= bufferMinutes) continue;
    return {
      driver_id: state.driver_id,
      driver_name: state.driver_name,
      reason: 'vehicle_switch_buffer_violation',
      detail: `Fahrzeugwechsel ${a.vehicle_identifier} → ${block.vehicle_identifier}, Puffer ${Math.round(gap)} Min. < ${bufferMinutes} Min.`,
    };
  }
  return null;
}

function checkOneVehiclePerDay(state: DriverPlanState, block: Phase1VehicleBlock): RejectedCandidate | null {
  const dayKey = startDayKey(block);
  for (const a of state.assigned) {
    if (startDayKey(a) !== dayKey) continue;
    if (a.vehicle_id === block.vehicle_id) continue;
    return {
      driver_id: state.driver_id,
      driver_name: state.driver_name,
      reason: 'one_vehicle_per_day',
      detail: `Fahrer nutzt bereits Fahrzeug ${a.vehicle_identifier} an ${dayKey}`,
    };
  }
  return null;
}

function checkNote(driver: PlanningDriver, block: Phase1VehicleBlock): RejectedCandidate | null {
  const note = driver.notes;
  if (!note || !note.trim()) return null;
  const lower = note.toLowerCase();
  const iso = isoWeekday(block.service_date);
  const { end: bEnd } = blockTimeOfDayMinutes(block);
  // Legacy fallback: night threshold aligned with project definition (Nachtarbeit starts 23:00)
  if (HARD_NOTE_TOKENS[0].token.test(lower) && bEnd > 23 * 60) {
    return { driver_id: driver.id, driver_name: driver.name, reason: 'note_constraint', detail: 'Legacy-Fahrer-Notiz: keine Nachtschicht' };
  }
  if (HARD_NOTE_TOKENS[1].token.test(lower) && bEnd > 12 * 60) {
    return { driver_id: driver.id, driver_name: driver.name, reason: 'note_constraint', detail: 'Legacy-Fahrer-Notiz: nur morgens' };
  }
  if (HARD_NOTE_TOKENS[2].token.test(lower) && iso < 6) {
    return { driver_id: driver.id, driver_name: driver.name, reason: 'note_constraint', detail: 'Legacy-Fahrer-Notiz: nur Wochenende' };
  }
  const map: Record<number, RegExp> = {
    1: HARD_NOTE_TOKENS[3].token, 2: HARD_NOTE_TOKENS[4].token, 3: HARD_NOTE_TOKENS[5].token,
    4: HARD_NOTE_TOKENS[6].token, 5: HARD_NOTE_TOKENS[7].token, 6: HARD_NOTE_TOKENS[8].token,
    7: HARD_NOTE_TOKENS[9].token,
  };
  const rx = map[iso];
  if (rx && rx.test(lower)) {
    const names = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
    return { driver_id: driver.id, driver_name: driver.name, reason: 'note_constraint', detail: `Legacy-Fahrer-Notiz: nicht ${names[iso]}s` };
  }
  return null;
}

/** Parse a YYYY-MM-DD date string into UTC midnight ms. Returns NaN on failure. */
function parseDateMs(d: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

/** Humanise a structured note type/text for rejection detail messages. */
function structuredNoteLabel(note: StructuredNote): string {
  const typeLabels: Record<string, string> = {
    sick: 'Krank',
    vacation: 'Urlaub',
    off: 'Nicht verfügbar',
    blitzer: 'Blitzer',
    accident: 'Unfall',
    kontrolle: 'Kontrolle',
    breakdown: 'Panne',
    wait: 'Wartezeit',
    other: 'Sonstiges',
    general: 'Allgemeine Notiz',
  };
  return typeLabels[note.note_type] ?? note.note_text ?? note.note_type;
}

/** Format a date YYYY-MM-DD → DD.MM.YYYY for display. */
function fmtDateDe(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : d;
}

/**
 * Check whether any exclude_from_plan structured note for this driver overlaps
 * the candidate block. Returns a RejectedCandidate if blocked, null otherwise.
 */
function checkStructuredNote(
  driver: PlanningDriver,
  block: Phase1VehicleBlock,
  driverNotesMap: Map<string, StructuredNote[]>,
): RejectedCandidate | null {
  const notes = driverNotesMap.get(driver.id);
  if (!notes || notes.length === 0) return null;

  const bStartMs = blockStartMs(block);
  const bEndMs = blockEndMs(block);

  for (const note of notes) {
    if (note.note_planning_behavior !== 'exclude_from_plan') continue;

    // Determine the note's active date range (UTC midnight boundaries)
    const noteStartDate = note.start_date ?? (note.note_date ? note.note_date.slice(0, 10) : null);
    const noteEndDate = note.end_date ?? noteStartDate;
    if (!noteStartDate) continue;

    const noteRangeStart = parseDateMs(noteStartDate);
    const noteRangeEnd = parseDateMs(noteEndDate!);
    if (isNaN(noteRangeStart) || isNaN(noteRangeEnd)) continue;

    // Cap to 366 days to avoid freezing the browser with open-ended or far-future dates.
    const MS_PER_DAY = 86_400_000;
    const cappedRangeEnd = Math.min(noteRangeEnd, noteRangeStart + 366 * MS_PER_DAY);
    let dateMs = noteRangeStart;
    while (dateMs <= cappedRangeEnd) {
      let noteIntervalStart: number;
      let noteIntervalEnd: number;

      if (note.is_full_day || !note.start_time || !note.end_time) {
        // Full-day: entire calendar day
        noteIntervalStart = dateMs;
        noteIntervalEnd = dateMs + MS_PER_DAY;
      } else {
        const sMin = timeToMin(note.start_time);
        const eMin = timeToMin(note.end_time);
        if (sMin == null || eMin == null) {
          // Malformed times — treat as full day
          noteIntervalStart = dateMs;
          noteIntervalEnd = dateMs + MS_PER_DAY;
        } else if (eMin > sMin) {
          // Same-day interval
          noteIntervalStart = dateMs + sMin * 60_000;
          noteIntervalEnd = dateMs + eMin * 60_000;
        } else {
          // Cross-midnight interval: start on this day, end next day
          noteIntervalStart = dateMs + sMin * 60_000;
          noteIntervalEnd = dateMs + MS_PER_DAY + eMin * 60_000;
        }
      }

      // Overlap check: [bStart, bEnd) ∩ [noteStart, noteEnd) ≠ ∅
      if (bStartMs < noteIntervalEnd && bEndMs > noteIntervalStart) {
        const label = structuredNoteLabel(note);
        const datePart = noteStartDate === noteEndDate
          ? fmtDateDe(noteStartDate)
          : `${fmtDateDe(noteStartDate)}–${fmtDateDe(noteEndDate!)}`;
        const timePart = (!note.is_full_day && note.start_time && note.end_time)
          ? ` ${note.start_time}–${note.end_time}`
          : ' ganztägig';
        return {
          driver_id: driver.id,
          driver_name: driver.name,
          reason: 'note_constraint',
          detail: `Notiz-Einschränkung: ${label} (${datePart}${timePart})`,
        };
      }

      dateMs += MS_PER_DAY;
    }
  }
  return null;
}

// ── scoring ────────────────────────────────────────────────────────────────

/**
 * Deterministic per-run salary target inside [min, max].
 * Seed: company_id xor driver_id substring xor month xor year.
 * Stable for the same planning run — no random() calls at score time.
 */
function deriveRunSalaryTarget(
  planningRunId: string,
  driverId: string,
  min: number,
  max: number,
): number {
  if (max <= min) return min;
  // Very simple deterministic hash: sum char codes of run+driver, shift by month/year
  let h = 0;
  const seed = planningRunId + '|' + driverId;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  const frac = Math.abs(h) / 0x7fffffff;
  return min + frac * (max - min);
}

function scoreDriver(
  state: DriverPlanState,
  block: Phase1VehicleBlock,
  expectedBruttoFn: ((state: DriverPlanState) => number) | null,
  planningRunId: string,
  inhaberTargetHours: number,
  toleranceHours: number,
): number {
  const driver = state.driver;

  // ── Scoring hierarchy (Inhaber target-share balanced + Mindestgehalt) ─────
  //
  // Goal A: Keep Inhaber near inhaberSharePercent of total hours.
  // Goal B: Keep employees within their Mindestgehalt / Maximalgehalt range.
  //
  // Both goals compete using the same 600k–1M score band:
  //   • Inhaber urgency  = how far below target as fraction of target
  //   • Employee urgency = how far below Mindestgehalt as fraction of minSal
  //
  // When inhaberTargetHours is 0 (share=0%), Inhaber is only used for coverage.
  //
  // Hard constraints (overlap, buffer, notes) are evaluated BEFORE scoring.

  // ── Inhaber scoring ───────────────────────────────────────────────────────
  if (driver.employment_type === 'company_owner') {
    const inhaberCurrentHours = state.monthly_minutes / 60;
    if (inhaberTargetHours <= 0) {
      // Share = 0%: Inhaber is pure fallback for coverage only.
      return 5_000;
    }
    const below = inhaberTargetHours - inhaberCurrentHours - toleranceHours;
    if (below > 0) {
      // Below tolerance band: urgency 0→1 as hours approach 0.
      const urgency = Math.min(1, below / Math.max(inhaberTargetHours, 1));
      return Math.round(600_000 + urgency * 400_000);
    } else if (inhaberCurrentHours <= inhaberTargetHours + toleranceHours) {
      // Inside tolerance band: medium priority.
      return 400_000;
    } else {
      // Above target + tolerance: still available but low priority (above in-range employees
      // so coverage doesn't fail when all employees are saturated).
      return 20_000;
    }
  }

  // ── Employee scoring ──────────────────────────────────────────────────────
  const minSal = driver.planning_min_salary ?? driver.planning_target_salary ?? null;
  const maxSal = driver.planning_max_salary ?? driver.planning_target_salary ?? null;
  const currentBrutto = expectedBruttoFn ? expectedBruttoFn(state) : null;

  let salaryScore = 0;

  if (minSal != null && maxSal != null && currentBrutto != null) {
    if (currentBrutto < minSal) {
      // Below minimum: urgency 0→1 as fraction of minSal.
      const gap = minSal - currentBrutto;
      const gapFraction = Math.min(1, gap / Math.max(minSal, 1));
      const blockContrib = expectedBruttoFn
        ? expectedBruttoFn({ ...state, monthly_minutes: state.monthly_minutes + block.duration_minutes }) - currentBrutto
        : 0;
      const projectedBrutto = currentBrutto + blockContrib;
      const overshootPenalty = projectedBrutto > maxSal ? (projectedBrutto - maxSal) * 500 : 0;
      salaryScore = Math.round(600_000 + gapFraction * 400_000) - overshootPenalty;
    } else if (currentBrutto <= maxSal) {
      // Inside range: low priority — Inhaber and below-min employees take precedence.
      const rangeWidth = Math.max(maxSal - minSal, 1);
      const posInRange = (currentBrutto - minSal) / rangeWidth;
      salaryScore = 10_000 - posInRange * 5_000;
    } else {
      // Above maximum: strongly avoid.
      salaryScore = -1_000_000 - (currentBrutto - maxSal) * 1000;
    }
  } else if (minSal != null && currentBrutto != null) {
    // Only min set (no max configured).
    const gap = minSal - currentBrutto;
    if (gap > 0) {
      const gapFraction = Math.min(1, gap / Math.max(minSal, 1));
      salaryScore = Math.round(600_000 + gapFraction * 400_000);
    } else {
      salaryScore = 10_000;
    }
  } else {
    // No salary range: hour-based fallback below Inhaber when near target.
    const targetMin = driver.target_monthly_hours != null ? driver.target_monthly_hours * 60 : 0;
    const hourGap = Math.max(0, targetMin - state.monthly_minutes);
    salaryScore = hourGap > 0 ? Math.min(hourGap * 5, 590_000) : -state.monthly_minutes * 0.1;
  }

  // Small window-affinity tiebreaker among same-tier candidates.
  let windowAffinity = 0;
  if (!driver.is_full_day_available && driver.work_window_start && driver.work_window_end) {
    const ws = timeToMin(driver.work_window_start);
    const we = timeToMin(driver.work_window_end);
    if (ws != null && we != null) {
      const winLen = ws <= we ? we - ws : 24 * 60 + we - ws;
      windowAffinity = -Math.abs(winLen - block.duration_minutes);
    }
  }
  return salaryScore + windowAffinity * 0.01;
}

// ── mutation helpers ───────────────────────────────────────────────────────

function tryAccept(
  state: DriverPlanState,
  block: Phase1VehicleBlock,
  options: ResolvedOptions,
): RejectedCandidate | null {
  return (
    checkWindow(state.driver, block) ||
    checkStructuredNote(state.driver, block, options.driverNotesMap) ||
    checkNote(state.driver, block) ||
    checkOverlap(state, block) ||
    (options.oneVehiclePerDriverDay && state.driver.employment_type !== 'company_owner' ? checkOneVehiclePerDay(state, block) : null) ||
    checkVehicleSwitch(state, block, options.vehicleSwitchBufferMinutes) ||
    checkDaily(state, block) ||
    checkMonthly(state, block)
  );
}

function reAddBlockToState(state: DriverPlanState, ab: AssignedBlock): void {
  state.assigned.push(ab);
  state.daily_minutes.set(
    ab.service_date,
    (state.daily_minutes.get(ab.service_date) ?? 0) + ab.duration_minutes,
  );
  state.monthly_minutes += ab.duration_minutes;
}

function uncommitFromState(state: DriverPlanState, blockId: string): AssignedBlock | null {
  const i = state.assigned.findIndex(b => b.block_id === blockId);
  if (i < 0) return null;
  const r = state.assigned.splice(i, 1)[0];
  state.daily_minutes.set(
    r.service_date,
    (state.daily_minutes.get(r.service_date) ?? 0) - r.duration_minutes,
  );
  state.monthly_minutes -= r.duration_minutes;
  return r;
}

function moveBlockTo(
  target: DriverPlanState,
  source: AssignedBlock,
  reason: string,
  repairMoved: boolean,
): AssignedBlock {
  const ab: AssignedBlock = {
    ...source,
    driver_id: target.driver_id,
    driver_name: target.driver_name,
    assignment_reason: reason,
    effective_max_daily_hours: target.effective_max_daily_hours,
    used_default_max_daily: target.used_default_max_daily,
    repair_moved: repairMoved,
    repair_applied: source.repair_applied,
  };
  reAddBlockToState(target, ab);
  return ab;
}

function commitBlockTo(
  target: DriverPlanState,
  block: Phase1VehicleBlock,
  reason: string,
  repairApplied: boolean,
): AssignedBlock {
  const ab: AssignedBlock = {
    ...block,
    driver_id: target.driver_id,
    driver_name: target.driver_name,
    assignment_reason: reason,
    effective_max_daily_hours: target.effective_max_daily_hours,
    used_default_max_daily: target.used_default_max_daily,
    repair_applied: repairApplied,
  };
  reAddBlockToState(target, ab);
  return ab;
}

function blocksOverlap(
  a: Phase1VehicleBlock,
  b: Phase1VehicleBlock,
): boolean {
  const as = blockStartMs(a);
  const ae = blockEndMs(a);
  const bs = blockStartMs(b);
  const be = blockEndMs(b);
  return as < be && ae > bs;
}

function describeBlock(b: Phase1VehicleBlock | AssignedBlock): string {
  const s = b.block_start_datetime.slice(11, 16);
  const e = b.block_end_datetime.slice(11, 16);
  return `${b.vehicle_identifier} ${s}-${e} am ${b.service_date}`;
}

// ── repair pass (transactional simulation) ─────────────────────────────────
// Every repair attempt is built on a deep clone of the driver states. Only
// after a full re-validation reports zero violations is the clone copied back
// onto the real states. Any failed simulation is simply discarded; the real
// state is never mutated until acceptance.

interface RepairOutcome {
  resolved: boolean;
  reason: string;
  movedCount: number;
  rejected_attempts: RepairAttemptLog[];
}

function cloneStates(states: DriverPlanState[]): DriverPlanState[] {
  return states.map(s => ({
    driver_id: s.driver_id,
    driver_name: s.driver_name,
    driver: s.driver,
    effective_max_daily_hours: s.effective_max_daily_hours,
    used_default_max_daily: s.used_default_max_daily,
    assigned: [...s.assigned],
    daily_minutes: new Map(s.daily_minutes),
    monthly_minutes: s.monthly_minutes,
  }));
}

function copyStatesBack(target: DriverPlanState[], source: DriverPlanState[]): void {
  const byId = new Map(source.map(s => [s.driver_id, s]));
  for (const t of target) {
    const s = byId.get(t.driver_id);
    if (!s) continue;
    t.assigned = [...s.assigned];
    t.daily_minutes = new Map(s.daily_minutes);
    t.monthly_minutes = s.monthly_minutes;
  }
}

function validateClone(
  states: DriverPlanState[],
  selectedSet: Set<string>,
  options: ResolvedOptions,
): { violations: number; firstDetail: string } {
  let v = 0;
  let firstDetail = '';
  const note = (d: string) => { if (!firstDetail) firstDetail = d; };
  for (const state of states) {
    const sorted = [...state.assigned].sort((a, b) => blockStartMs(a) - blockStartMs(b));
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      if (!selectedSet.has(a.driver_id)) { v++; note(`Nicht-ausgewählter Fahrer ${a.driver_name}`); }
      if (checkWindow(state.driver, a)) { v++; note(`Dienstzeit-Verstoß ${state.driver_name}`); }
      if (checkNote(state.driver, a)) { v++; note(`Notiz-Verstoß ${state.driver_name}`); }
      const as = blockStartMs(a);
      const ae = blockEndMs(a);
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        const bs = blockStartMs(b);
        const be = blockEndMs(b);
        if (as < be && ae > bs) {
          v++;
          note(`would create driver overlap (${state.driver_name}: ${a.vehicle_identifier} ${a.block_start_datetime.slice(11,16)}–${a.block_end_datetime.slice(11,16)} ↔ ${b.vehicle_identifier} ${b.block_start_datetime.slice(11,16)}–${b.block_end_datetime.slice(11,16)})`);
        }
        if (a.vehicle_id !== b.vehicle_id) {
          let gap: number;
          if (ae <= bs) gap = (bs - ae) / 60000;
          else if (be <= as) gap = (as - be) / 60000;
          else gap = -1;
          if (gap >= 0 && gap < options.vehicleSwitchBufferMinutes) { v++; note(`Fahrzeugwechsel-Puffer ${state.driver_name}`); }
        }
      }
    }
    if (options.oneVehiclePerDriverDay && state.driver.employment_type !== 'company_owner') {
      const byDay = new Map<string, Set<string>>();
      for (const a of state.assigned) {
        const k = startDayKey(a);
        const set = byDay.get(k) ?? new Set<string>();
        set.add(a.vehicle_id);
        byDay.set(k, set);
      }
      for (const [day, vehicles] of byDay.entries()) {
        if (vehicles.size > 1) { v++; note(`Mehrere Fahrzeuge ${state.driver_name} am ${day}`); }
      }
    }
    const maxMin = Math.round(state.effective_max_daily_hours * 60);
    if (state.driver.employment_type !== 'company_owner') {
      for (const mins of state.daily_minutes.values()) {
        if (mins > maxMin) { v++; note(`Tageslimit ${state.driver_name}`); }
      }
      const cap = state.driver.max_monthly_hours;
      if (cap != null && state.monthly_minutes > cap * 60) { v++; note(`Monatslimit ${state.driver_name}`); }
    }
  }
  return { violations: v, firstDetail };
}

interface PlanResult {
  ok: boolean;
  reason: string;
  description: string;
  movedCount: number;
  targetDriverName: string;
}

function trySimulatedPlan(
  realStates: DriverPlanState[],
  selectedSet: Set<string>,
  options: ResolvedOptions,
  planFn: (clone: DriverPlanState[]) => PlanResult,
): { ok: boolean; reason: string; description: string; movedCount: number; targetDriverName: string; rejection?: string } {
  const clone = cloneStates(realStates);
  const r = planFn(clone);
  if (!r.ok) return { ...r, rejection: r.reason };
  const val = validateClone(clone, selectedSet, options);
  if (val.violations !== 0) {
    return { ok: false, reason: r.reason, description: r.description, movedCount: r.movedCount, targetDriverName: r.targetDriverName, rejection: `Repair attempt rejected: ${val.firstDetail}` };
  }
  copyStatesBack(realStates, clone);
  return { ok: true, reason: r.reason, description: r.description, movedCount: r.movedCount, targetDriverName: r.targetDriverName };
}

function planDirect(D_id: string, block: UnassignedBlock, options: ResolvedOptions) {
  return (clone: DriverPlanState[]): PlanResult => {
    const D = clone.find(s => s.driver_id === D_id)!;
    const fail = tryAccept(D, block, options);
    if (fail) return { ok: false, reason: fail.detail, description: `Direct → ${D.driver_name}`, movedCount: 0, targetDriverName: D.driver_name };
    commitBlockTo(D, block, `Reparatur (Direkt): Slot bei ${D.driver_name} jetzt frei`, true);
    return { ok: true, reason: `Reparatur (Direkt): Slot bei ${D.driver_name} jetzt frei`, description: `Direct → ${D.driver_name}`, movedCount: 0, targetDriverName: D.driver_name };
  };
}

function planMove(D_id: string, block: UnassignedBlock, options: ResolvedOptions) {
  return (clone: DriverPlanState[]): PlanResult => {
    const D = clone.find(s => s.driver_id === D_id)!;
    const conflicts = D.assigned.filter(a => blocksOverlap(a, block));
    if (conflicts.length === 0) return { ok: false, reason: 'no conflicts on D', description: `Move via ${D.driver_name}`, movedCount: 0, targetDriverName: D.driver_name };

    const removed: AssignedBlock[] = [];
    for (const c of conflicts) {
      const r = uncommitFromState(D, c.block_id);
      if (r) removed.push(r);
    }
    if (tryAccept(D, block, options) !== null) {
      return { ok: false, reason: 'D rejects U even after removing conflicts', description: `Move via ${D.driver_name}`, movedCount: 0, targetDriverName: D.driver_name };
    }

    const moves: Array<{ target: string }> = [];
    for (const c of removed) {
      let placed = false;
      for (const Dp of clone) {
        if (Dp.driver_id === D.driver_id) continue;
        if (tryAccept(Dp, c, options) === null) {
          moveBlockTo(Dp, c, `Reparatur-Verschiebung wegen ${describeBlock(block)}`, true);
          moves.push({ target: Dp.driver_name });
          placed = true; break;
        }
      }
      if (!placed) return { ok: false, reason: `cannot relocate conflict ${describeBlock(c)}`, description: `Move via ${D.driver_name}`, movedCount: moves.length, targetDriverName: D.driver_name };
    }

    const reason = `Reparatur: ${moves.map(m => `Konfliktblock von ${D.driver_name} zu ${m.target} verschoben`).join(' · ')}`;
    commitBlockTo(D, block, reason, true);
    return { ok: true, reason, description: `Move via ${D.driver_name}`, movedCount: moves.length, targetDriverName: D.driver_name };
  };
}

function planSwap(D_id: string, block: UnassignedBlock, options: ResolvedOptions) {
  return (clone: DriverPlanState[]): PlanResult => {
    const D = clone.find(s => s.driver_id === D_id)!;
    const conflicts = D.assigned.filter(a => blocksOverlap(a, block));
    if (conflicts.length === 0) return { ok: false, reason: 'no conflicts on D', description: `Swap via ${D.driver_name}`, movedCount: 0, targetDriverName: D.driver_name };

    const removed: AssignedBlock[] = [];
    for (const c of conflicts) {
      const r = uncommitFromState(D, c.block_id);
      if (r) removed.push(r);
    }
    if (tryAccept(D, block, options) !== null) {
      return { ok: false, reason: 'D rejects U even after removing conflicts', description: `Swap via ${D.driver_name}`, movedCount: 0, targetDriverName: D.driver_name };
    }

    const moves: Array<{ target: string }> = [];
    for (const c of removed) {
      let placed = false;
      for (const Dp of clone) {
        if (Dp.driver_id === D.driver_id) continue;
        if (tryAccept(Dp, c, options) === null) {
          moveBlockTo(Dp, c, `Reparatur-Verschiebung wegen ${describeBlock(block)}`, true);
          moves.push({ target: Dp.driver_name });
          placed = true; break;
        }
      }
      if (placed) continue;
      outerSwap: for (const Dp of clone) {
        if (Dp.driver_id === D.driver_id) continue;
        const cpCandidates = Dp.assigned.filter(a => blocksOverlap(a, c));
        for (const cp of cpCandidates) {
          const evicted = uncommitFromState(Dp, cp.block_id);
          if (!evicted) continue;
          if (tryAccept(Dp, c, options) !== null) {
            reAddBlockToState(Dp, evicted);
            continue;
          }
          let evictedPlaced = false;
          for (const Dpp of clone) {
            if (Dpp.driver_id === Dp.driver_id) continue;
            if (Dpp.driver_id === D.driver_id) continue;
            if (tryAccept(Dpp, evicted, options) === null) {
              moveBlockTo(Dpp, evicted, `Reparatur-Verschiebung wegen ${describeBlock(block)}`, true);
              evictedPlaced = true; break;
            }
          }
          if (!evictedPlaced) { reAddBlockToState(Dp, evicted); continue; }
          moveBlockTo(Dp, c, `Reparatur-Verschiebung wegen ${describeBlock(block)}`, true);
          moves.push({ target: Dp.driver_name });
          placed = true;
          break outerSwap;
        }
      }
      if (!placed) return { ok: false, reason: `swap failed for conflict ${describeBlock(c)}`, description: `Swap via ${D.driver_name}`, movedCount: moves.length, targetDriverName: D.driver_name };
    }

    const reason = `Reparatur (Swap): ${moves.length} Blöcke verschoben → ${D.driver_name}`;
    commitBlockTo(D, block, reason, true);
    return { ok: true, reason, description: `Swap via ${D.driver_name}`, movedCount: moves.length, targetDriverName: D.driver_name };
  };
}

function attemptRepair(
  block: UnassignedBlock,
  realStates: DriverPlanState[],
  selectedSet: Set<string>,
  options: ResolvedOptions,
): RepairOutcome {
  const rejections: RepairAttemptLog[] = [];

  for (const D of realStates) {
    const r = trySimulatedPlan(realStates, selectedSet, options, planDirect(D.driver_id, block, options));
    if (r.ok) return { resolved: true, reason: r.reason, movedCount: r.movedCount, rejected_attempts: rejections };
    if (r.rejection && r.rejection.startsWith('Repair attempt rejected')) {
      rejections.push({ strategy: 'Direct', driver: r.targetDriverName, rejection_reason: r.rejection });
    }
  }

  for (const D of realStates) {
    if (D.assigned.every(a => !blocksOverlap(a, block))) continue;
    const r = trySimulatedPlan(realStates, selectedSet, options, planMove(D.driver_id, block, options));
    if (r.ok) return { resolved: true, reason: r.reason, movedCount: r.movedCount, rejected_attempts: rejections };
    if (r.rejection) rejections.push({ strategy: 'Move', driver: D.driver_name, rejection_reason: r.rejection });
  }

  for (const D of realStates) {
    if (D.assigned.every(a => !blocksOverlap(a, block))) continue;
    const r = trySimulatedPlan(realStates, selectedSet, options, planSwap(D.driver_id, block, options));
    if (r.ok) return { resolved: true, reason: r.reason, movedCount: r.movedCount, rejected_attempts: rejections };
    if (r.rejection) rejections.push({ strategy: 'Swap', driver: D.driver_name, rejection_reason: r.rejection });
  }

  return {
    resolved: false,
    reason: rejections.length > 0 ? 'no valid move/swap found (all candidates rejected by full validation)' : 'no valid move/swap found',
    movedCount: 0,
    rejected_attempts: rejections,
  };
}

// ── final conflict purge ───────────────────────────────────────────────────

function fmtMsDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Final safety pass after all repair attempts. Iterates driver states and
 * removes any block that still causes a driver overlap or vehicle-switch
 * violation. The evicted block is turned into an UnassignedBlock with a
 * German rejection reason. Runs up to MAX_ITERATIONS times until clean.
 */
function purgeFinalConflicts(
  driverStates: DriverPlanState[],
  opts: ResolvedOptions,
): UnassignedBlock[] {
  const extraUnassigned: UnassignedBlock[] = [];
  const MAX_ITERATIONS = 50;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let foundConflict = false;

    outer: for (const state of driverStates) {
      const sorted = [...state.assigned].sort((a, b) => blockStartMs(a) - blockStartMs(b));

      for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i];
        const b = sorted[i + 1];
        const ae = blockEndMs(a);
        const bs = blockStartMs(b);

        let toUnassign: AssignedBlock | null = null;
        let detail = '';
        let conflictReason: RejectReason = 'driver_overlap';

        if (bs < ae) {
          const overlapMin = Math.round((ae - bs) / 60000);
          toUnassign = b;
          conflictReason = 'driver_overlap';
          detail =
            `Nicht sicher zugewiesen: Fahrer-Überschneidung (${state.driver_name}: ` +
            `${a.vehicle_identifier} ${fmtMsDateTime(blockStartMs(a))}–${fmtMsDateTime(ae)} ↔ ` +
            `${b.vehicle_identifier} ${fmtMsDateTime(bs)}–${fmtMsDateTime(blockEndMs(b))}, ` +
            `${overlapMin} Min Überschneidung).`;
        } else if (a.vehicle_id !== b.vehicle_id) {
          const gapMin = (bs - ae) / 60000;
          if (gapMin < opts.vehicleSwitchBufferMinutes) {
            toUnassign = b;
            conflictReason = 'vehicle_switch_buffer_violation';
            detail =
              `Nicht sicher zugewiesen: Fahrzeugwechsel zu kurz (${state.driver_name}: ` +
              `${a.vehicle_identifier} → ${b.vehicle_identifier}, ` +
              `Abstand ${gapMin.toFixed(1).replace('.', ',')} Min, ` +
              `erforderlich: ${opts.vehicleSwitchBufferMinutes} Min).`;
          }
        }

        if (toUnassign) {
          const removed = uncommitFromState(state, toUnassign.block_id);
          if (removed) {
            const {
              driver_id, driver_name,
              assignment_reason: _ar,
              effective_max_daily_hours: _em,
              used_default_max_daily: _ud,
              repair_applied: _ra,
              repair_moved: _rm,
              manual_exception: _me,
              ...phase1Fields
            } = removed;
            extraUnassigned.push({
              ...phase1Fields,
              rejected: [{
                driver_id,
                driver_name,
                reason: conflictReason,
                detail,
              }],
              repair_attempted: true,
              repair_reason: detail,
              repair_attempts: [],
            });
            foundConflict = true;
            break outer;
          }
        }
      }
    }

    if (!foundConflict) break;
  }

  return extraUnassigned;
}

// ── main planner ───────────────────────────────────────────────────────────

export function assignBlocksPhase3(
  blocks: Phase1VehicleBlock[],
  selectedDrivers: PlanningDriver[],
  options?: Phase3Options,
): Phase3Result {
  const opts = resolveOptions(options);
  const driverStates: DriverPlanState[] = selectedDrivers.map(d => {
    const maxDailyConfigured = d.max_daily_hours;
    const effectiveMax = maxDailyConfigured != null ? maxDailyConfigured : DEFAULT_MAX_DAILY_HOURS;
    return {
      driver_id: d.id,
      driver_name: d.name,
      driver: d,
      effective_max_daily_hours: effectiveMax,
      used_default_max_daily: maxDailyConfigured == null,
      assigned: [],
      daily_minutes: new Map(),
      monthly_minutes: 0,
    };
  });
  const noteWarnings: Phase3Result['noteWarnings'] = [];
  for (const d of selectedDrivers) {
    if (!d.notes || !d.notes.trim()) continue;
    const lower = d.notes.toLowerCase();
    const matched = HARD_NOTE_TOKENS.some(({ token }) => token.test(lower));
    if (!matched) {
      noteWarnings.push({
        driver_id: d.id,
        driver_name: d.name,
        note: d.notes,
        reason: 'Notiz konnte nicht automatisch interpretiert werden, bitte manuell prüfen.',
      });
    }
  }

  const sortedBlocks = [...blocks].sort((a, b) => {
    const sA = blockStartMs(a), sB = blockStartMs(b);
    if (sA !== sB) return sA - sB;
    return a.block_start_datetime.localeCompare(b.block_start_datetime);
  });

  const unassigned: UnassignedBlock[] = [];
  // Track Inhaber rejection reasons across all blocks (assigned and unassigned)
  const allBlockInhaberRejections: RejectedCandidate[] = [];

  // Rough brutto estimator: monthly_minutes / 60 × hourly_rate.
  // Used only for salary-range scoring; Stundennachweis uses the exact calculation.
  const bruttoEstimator = (state: DriverPlanState): number => {
    const hourlyRate = state.driver.planning_hourly_rate;
    if (hourlyRate == null || hourlyRate <= 0) return 0;
    return (state.monthly_minutes / 60) * hourlyRate;
  };

  // ── Inhaber target-share computation ─────────────────────────────────────
  // Total working hours = sum of all block durations in the input set.
  const totalBlockHours = blocks.reduce((s, b) => s + b.duration_minutes, 0) / 60;
  const inhaberSharePercent = opts.inhaberSharePercent;
  const inhaberTargetHours = totalBlockHours * inhaberSharePercent / 100;
  // Tolerance band: larger of ±5 % of total hours or ±10 h.
  const toleranceHours = Math.max(totalBlockHours * 0.05, 10);

  for (const block of sortedBlocks) {
    const rejected: RejectedCandidate[] = [];
    const candidates: Array<{ state: DriverPlanState; score: number }> = [];
    let inhaberRejection: RejectedCandidate | null = null;

    for (const state of driverStates) {
      const driver = state.driver;
      const checks: Array<RejectedCandidate | null> = [
        checkWindow(driver, block),
        checkStructuredNote(driver, block, opts.driverNotesMap),
        checkNote(driver, block),
        checkOverlap(state, block),
        opts.oneVehiclePerDriverDay && driver.employment_type !== 'company_owner' ? checkOneVehiclePerDay(state, block) : null,
        checkVehicleSwitch(state, block, opts.vehicleSwitchBufferMinutes),
        checkDaily(state, block),
        checkMonthly(state, block),
      ];
      const fail = checks.find(c => c !== null);
      if (fail) {
        rejected.push(fail);
        if (driver.employment_type === 'company_owner') {
          inhaberRejection = fail;
          allBlockInhaberRejections.push(fail);
        }
        continue;
      }
      candidates.push({ state, score: scoreDriver(state, block, bruttoEstimator, opts.planningRunId, inhaberTargetHours, toleranceHours) });
    }

    if (candidates.length === 0) {
      unassigned.push({ ...block, rejected, repair_attempted: false, repair_reason: '', repair_attempts: [], inhaber_rejection: inhaberRejection });
      continue;
    }

    candidates.sort((a, b) => b.score - a.score);
    const winner = candidates[0].state;
    const driver = winner.driver;
    const targetMin = driver.target_monthly_hours != null ? driver.target_monthly_hours * 60 : 0;
    const remaining = Math.max(0, targetMin - winner.monthly_minutes);
    const reasonParts: string[] = [];
    if (driver.work_window_start && driver.work_window_end) {
      reasonParts.push(`innerhalb ${driver.work_window_start}–${driver.work_window_end}`);
    }
    if (targetMin > 0) {
      reasonParts.push(`${fmtHours(remaining)} unter Monatsziel`);
    }
    reasonParts.push(`Tag ${fmtHours((winner.daily_minutes.get(block.service_date) ?? 0) + block.duration_minutes)}/${winner.effective_max_daily_hours}h`);

    const assignedBlock: AssignedBlock = {
      ...block,
      driver_id: winner.driver_id,
      driver_name: winner.driver_name,
      assignment_reason: reasonParts.join(' · '),
      effective_max_daily_hours: winner.effective_max_daily_hours,
      used_default_max_daily: winner.used_default_max_daily,
    };
    winner.assigned.push(assignedBlock);
    winner.daily_minutes.set(
      block.service_date,
      (winner.daily_minutes.get(block.service_date) ?? 0) + block.duration_minutes,
    );
    winner.monthly_minutes += block.duration_minutes;
  }

  // ── repair pass ──────────────────────────────────────────────────────────
  const selectedSet = new Set(selectedDrivers.map(d => d.id));
  let repairAttempted = 0;
  let repairResolved = 0;
  let repairMovedTotal = 0;
  const stillUnassigned: UnassignedBlock[] = [];
  for (const u of unassigned) {
    repairAttempted++;
    const outcome = attemptRepair(u, driverStates, selectedSet, opts);
    if (outcome.resolved) {
      repairResolved++;
      repairMovedTotal += outcome.movedCount;
    } else {
      stillUnassigned.push({
        ...u,
        repair_attempted: true,
        repair_reason: outcome.reason,
        repair_attempts: outcome.rejected_attempts,
      });
    }
  }

  // ── coverage completion pass ──────────────────────────────────────────────
  // For any block still unassigned after the repair pass, attempt assignment
  // with relaxed soft constraints (Dienstzeit window, one-vehicle-per-day, daily limit).
  // Hard constraints (overlap, vehicle switch, notes, monthly cap) are never relaxed.
  // Priority: Inhaber first, then employees ordered by salary gap (below-min first).
  const coverageResolved: string[] = [];
  const afterCoverage: UnassignedBlock[] = [];

  for (const u of stillUnassigned) {
    // Build candidate list with only the irreducible hard constraints.
    const relaxedCandidates: Array<{ state: DriverPlanState; score: number }> = [];
    const relaxedRejected: RejectedCandidate[] = [];

    // Sort states: Inhaber first, then by salary gap
    const orderedStates = [...driverStates].sort((a, b) => {
      const aOwner = a.driver.employment_type === 'company_owner' ? 1 : 0;
      const bOwner = b.driver.employment_type === 'company_owner' ? 1 : 0;
      if (aOwner !== bOwner) return bOwner - aOwner;
      return 0;
    });

    for (const state of orderedStates) {
      const driver = state.driver;
      // Irreducible hard constraints — never skip these.
      const hardChecks: Array<RejectedCandidate | null> = [
        // Weekday constraint (part of checkWindow) is still hard.
        (() => {
          if (driver.allowed_weekdays && driver.allowed_weekdays.length > 0) {
            const iso = isoWeekday(u.service_date);
            if (!driver.allowed_weekdays.includes(iso)) {
              const names = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
              return {
                driver_id: driver.id,
                driver_name: driver.name,
                reason: 'wrong_weekday' as RejectReason,
                detail: `Arbeitstag nicht erlaubt (${names[iso] ?? '?'})`,
              };
            }
          }
          return null;
        })(),
        checkStructuredNote(driver, u, opts.driverNotesMap),
        checkNote(driver, u),
        checkOverlap(state, u),
        checkVehicleSwitch(state, u, opts.vehicleSwitchBufferMinutes),
        checkMonthly(state, u),
        // one-vehicle-per-day is still applied to employees (coverage pass relaxes Dienstzeit & daily only)
        opts.oneVehiclePerDriverDay && driver.employment_type !== 'company_owner' ? checkOneVehiclePerDay(state, u) : null,
      ];
      const fail = hardChecks.find(c => c !== null);
      if (fail) {
        relaxedRejected.push(fail);
        continue;
      }
      // Score: reuse the same balanced scoreDriver logic (respects target-share for Inhaber).
      relaxedCandidates.push({ state, score: scoreDriver(state, u, bruttoEstimator, opts.planningRunId, inhaberTargetHours, toleranceHours) });
    }

    if (relaxedCandidates.length === 0) {
      // Truly no valid candidate even with relaxed constraints — keep unassigned with updated rejection info.
      afterCoverage.push({
        ...u,
        rejected: [...u.rejected, ...relaxedRejected],
        repair_reason: u.repair_reason + ' · Kein gültiger Kandidat (Dienstzeit-Entspannung versucht)',
      });
      continue;
    }

    relaxedCandidates.sort((a, b) => b.score - a.score);
    const winner = relaxedCandidates[0].state;
    const ab: AssignedBlock = {
      ...u,
      driver_id: winner.driver_id,
      driver_name: winner.driver_name,
      assignment_reason: 'Deckungspass (entspannte Dienstzeit)',
      effective_max_daily_hours: winner.effective_max_daily_hours,
      used_default_max_daily: winner.used_default_max_daily,
    };
    winner.assigned.push(ab);
    winner.daily_minutes.set(
      u.service_date,
      (winner.daily_minutes.get(u.service_date) ?? 0) + u.duration_minutes,
    );
    winner.monthly_minutes += u.duration_minutes;
    allBlockInhaberRejections.push(...relaxedRejected.filter(r => {
      const s = driverStates.find(st => st.driver_id === r.driver_id);
      return s?.driver.employment_type === 'company_owner';
    }));
    coverageResolved.push(u.block_id);
  }

  // ── Austausch-Reparatur (capacity-unlocking swap pass) ────────────────────
  // For each still-unassigned block after the coverage pass:
  //   1. Find a driver who fails only because of monthly_max_exceeded.
  //   2. Find a donor block assigned to that driver that the Inhaber can absorb
  //      (no overlap, no vehicle switch violation, no note, no weekday constraint).
  //   3. Move the donor block to the Inhaber, then assign the open block to the
  //      freed driver. All other hard constraints remain enforced.
  // Bounded: max MAX_AUSTAUSCH_ATTEMPTS per open block, max MAX_DONORS_PER_DRIVER donor
  // blocks inspected per candidate driver.
  const MAX_AUSTAUSCH_ATTEMPTS = 6;
  const MAX_DONORS_PER_DRIVER = 8;

  const inhaberState = driverStates.find(s => s.driver.employment_type === 'company_owner') ?? null;
  const austauschSwaps: Phase3Result['austausch_summary']['swaps'] = [];
  let austauschAttempted = 0;
  let austauschResolved = 0;
  const afterAustausch: UnassignedBlock[] = [];

  for (const u of afterCoverage) {
    // Only attempt swap for blocks that aren't intentionally open.
    if (!inhaberState) { afterAustausch.push(u); continue; }

    // Find drivers blocked specifically by monthly limit for this block.
    const monthlyBlockedDrivers = driverStates.filter(state => {
      if (state.driver.employment_type === 'company_owner') return false;
      // Driver would pass all other checks but fails monthly cap.
      const monthlyFail = checkMonthly(state, u);
      if (!monthlyFail) return false;
      // Confirm that without the monthly constraint this driver could take the block.
      const otherFails = [
        checkWindow(state.driver, u),
        checkStructuredNote(state.driver, u, opts.driverNotesMap),
        checkNote(state.driver, u),
        checkOverlap(state, u),
        checkVehicleSwitch(state, u, opts.vehicleSwitchBufferMinutes),
        opts.oneVehiclePerDriverDay ? checkOneVehiclePerDay(state, u) : null,
      ].find(c => c !== null);
      return !otherFails;
    });

    if (monthlyBlockedDrivers.length === 0) { afterAustausch.push(u); continue; }

    let swapped = false;
    let austauschLog: AustauschReparaturLog | undefined;
    let attemptsLeft = MAX_AUSTAUSCH_ATTEMPTS;

    outerAustausch: for (const freedDriver of monthlyBlockedDrivers) {
      if (attemptsLeft <= 0) break;

      // Candidate donor blocks: blocks already assigned to this driver that
      // the Inhaber can absorb (sorted shortest first to free minimal capacity).
      const donors = [...freedDriver.assigned]
        .sort((a, b) => a.duration_minutes - b.duration_minutes)
        .slice(0, MAX_DONORS_PER_DRIVER);

      for (const donor of donors) {
        if (attemptsLeft <= 0) break;
        austauschAttempted++;
        attemptsLeft--;

        // Check whether the Inhaber can take the donor block.
        const inhaberChecks: Array<RejectedCandidate | null> = [
          checkOverlap(inhaberState, donor),
          checkVehicleSwitch(inhaberState, donor, opts.vehicleSwitchBufferMinutes),
          checkStructuredNote(inhaberState.driver, donor, opts.driverNotesMap),
          checkNote(inhaberState.driver, donor),
        ];
        const inhaberDonorFail = inhaberChecks.find(c => c !== null);
        if (inhaberDonorFail) continue;

        // Simulate: remove donor from freedDriver, assign open block to freedDriver,
        // add donor to Inhaber. Validate the full clone.
        const result = trySimulatedPlan(
          driverStates,
          selectedSet,
          opts,
          (clone) => {
            const cloneFreed = clone.find(s => s.driver_id === freedDriver.driver_id)!;
            const cloneInhaber = clone.find(s => s.driver.employment_type === 'company_owner')!;

            // Remove donor from freed driver
            const removed = uncommitFromState(cloneFreed, donor.block_id);
            if (!removed) return { ok: false, reason: 'donor not found in clone', description: '', movedCount: 0, targetDriverName: freedDriver.driver_name };

            // Check freed driver can now accept the open block
            const freedFail = tryAccept(cloneFreed, u, opts);
            if (freedFail) return { ok: false, reason: `Freed driver still can't take open block: ${freedFail.detail}`, description: '', movedCount: 0, targetDriverName: freedDriver.driver_name };

            // Check Inhaber can accept the donor block
            const inhaberFail = tryAccept(cloneInhaber, removed, opts);
            if (inhaberFail) return { ok: false, reason: `Inhaber rejects donor: ${inhaberFail.detail}`, description: '', movedCount: 0, targetDriverName: inhaberState.driver_name };

            // Apply both mutations
            moveBlockTo(cloneInhaber, removed, `Austausch-Reparatur: Geberblock von ${freedDriver.driver_name} übernommen`, true);
            commitBlockTo(cloneFreed, u, `Austausch-Reparatur: Kapazität durch Inhaber-Tausch freigemacht (${donor.vehicle_identifier} ${donor.block_start_datetime.slice(11, 16)}–${donor.block_end_datetime.slice(11, 16)})`, true);

            return {
              ok: true,
              reason: `Austausch-Reparatur: ${freedDriver.driver_name} gibt ${describeBlock(donor)} an Inhaber ab`,
              description: `Austausch via ${freedDriver.driver_name}`,
              movedCount: 1,
              targetDriverName: freedDriver.driver_name,
            };
          },
        );

        if (result.ok) {
          austauschResolved++;
          swapped = true;
          austauschSwaps.push({
            open_block_id: u.block_id,
            open_block_desc: describeBlock(u),
            freed_driver: freedDriver.driver_name,
            donor_block_id: donor.block_id,
            donor_block_desc: describeBlock(donor),
          });
          // Update Inhaber rejection tracking for moved donor
          allBlockInhaberRejections.push(...[]);
          break outerAustausch;
        } else {
          austauschLog = {
            success: false,
            donor_driver_name: freedDriver.driver_name,
            donor_block_id: donor.block_id,
            donor_block_desc: describeBlock(donor),
            reason: result.reason ?? 'Simulation fehlgeschlagen',
          };
        }
      }
    }

    if (!swapped) {
      afterAustausch.push({ ...u, austausch_log: austauschLog });
    }
    // If swapped, the block is now in driverStates.assigned — not in afterAustausch.
  }

  // ── final hard validation: purge any remaining overlap / switch violations ─
  const assignedCountBeforePurge = driverStates.reduce((s, st) => s + st.assigned.length, 0);
  const unassignedCountBeforePurge = afterAustausch.length;
  const finalConflictUnassigned = purgeFinalConflicts(driverStates, opts);
  for (const u of finalConflictUnassigned) afterAustausch.push(u);

  // rebuild assigned from states (sources of truth after repair mutations)
  const assigned: AssignedBlock[] = [];
  for (const state of driverStates) {
    for (const ab of state.assigned) assigned.push(ab);
  }
  assigned.sort((a, b) => {
    const sA = blockStartMs(a), sB = blockStartMs(b);
    if (sA !== sB) return sA - sB;
    return a.block_start_datetime.localeCompare(b.block_start_datetime);
  });

  // ── validation pass ──────────────────────────────────────────────────────
  let overlaps = 0;
  let switchViolations = 0;
  let dailyViolations = 0;
  let monthlyViolations = 0;
  let windowViolations = 0;
  let nonSelectedAssignments = 0;
  const inhaberTimeWarnings: Phase3Result['inhaber_time_warnings'] = [];

  for (const a of assigned) {
    if (!selectedSet.has(a.driver_id)) nonSelectedAssignments++;
  }

  for (const state of driverStates) {
    const isOwner = state.driver.employment_type === 'company_owner';
    const sorted = [...state.assigned].sort((a, b) => blockStartMs(a) - blockStartMs(b));
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      const as = blockStartMs(a);
      const ae = blockEndMs(a);
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        const bs = blockStartMs(b);
        const be = blockEndMs(b);
        if (as < be && ae > bs) overlaps++;
        if (a.vehicle_id !== b.vehicle_id) {
          let gap: number;
          if (ae <= bs) gap = (bs - ae) / 60000;
          else if (be <= as) gap = (as - be) / 60000;
          else gap = -1;
          if (gap >= 0 && gap < opts.vehicleSwitchBufferMinutes) switchViolations++;
        }
      }
      const wrong = checkWindow(state.driver, a);
      if (wrong) {
        if (isOwner) {
          inhaberTimeWarnings.push({
            driver_id: state.driver_id,
            driver_name: state.driver_name,
            kind: 'dienstzeit',
            detail: wrong.detail,
          });
        } else {
          windowViolations++;
        }
      }
    }
    const maxMin = Math.round(state.effective_max_daily_hours * 60);
    if (!isOwner) {
      for (const mins of state.daily_minutes.values()) {
        if (mins > maxMin) dailyViolations++;
      }
      const cap = state.driver.max_monthly_hours;
      if (cap != null && state.monthly_minutes > cap * 60) monthlyViolations++;
    } else {
      // Inhaber: collect non-blocking time warnings only.
      const maxDayMin = Math.round(state.effective_max_daily_hours * 60);
      for (const [date, mins] of state.daily_minutes.entries()) {
        if (mins > maxDayMin) {
          inhaberTimeWarnings.push({
            driver_id: state.driver_id,
            driver_name: state.driver_name,
            kind: 'tageslimit',
            detail: `${date}: ${fmtHours(mins)} / ${state.effective_max_daily_hours}h`,
          });
        }
      }
      const cap = state.driver.max_monthly_hours;
      if (cap != null && state.monthly_minutes > cap * 60) {
        inhaberTimeWarnings.push({
          driver_id: state.driver_id,
          driver_name: state.driver_name,
          kind: 'monatslimit',
          detail: `${fmtHours(state.monthly_minutes)} / ${cap}h`,
        });
      }
    }
  }

  const multiPerDayDetails: Phase3Result['multiple_vehicles_per_day_details'] = [];
  let multiPerDayViolations = 0;
  if (opts.oneVehiclePerDriverDay) {
    for (const state of driverStates) {
      if (state.driver.employment_type === 'company_owner') continue;
      const byDay = new Map<string, Map<string, { identifier: string; blockIds: string[] }>>();
      for (const ab of state.assigned) {
        const k = startDayKey(ab);
        const dayMap = byDay.get(k) ?? new Map();
        const entry = dayMap.get(ab.vehicle_id) ?? { identifier: ab.vehicle_identifier, blockIds: [] };
        entry.blockIds.push(ab.block_id);
        dayMap.set(ab.vehicle_id, entry);
        byDay.set(k, dayMap);
      }
      for (const [day, vehicles] of byDay.entries()) {
        if (vehicles.size > 1) {
          multiPerDayViolations++;
          const ids: string[] = [];
          const identifiers: string[] = [];
          for (const v of vehicles.values()) {
            identifiers.push(v.identifier);
            ids.push(...v.blockIds);
          }
          multiPerDayDetails.push({
            date: day,
            driver_id: state.driver_id,
            driver_name: state.driver_name,
            vehicles: identifiers,
            block_ids: ids,
          });
        }
      }
    }
  }

  const resolvedTrips = assigned.reduce((s, b) => s + b.trip_count, 0);
  const unassignedTrips = afterAustausch.reduce((s, b) => s + b.trip_count, 0);

  // Inhaber / salary range summary
  let inhaberTrips = 0;
  let inhaberMinutes = 0;
  let employeeTrips = 0;
  let employeeMinutes = 0;
  let driversAboveMax = 0;
  let driversBelowMin = 0;
  let driversInRange = 0;
  const bruttoEstimatorFinal = (state: DriverPlanState): number => {
    const hourlyRate = state.driver.planning_hourly_rate;
    if (hourlyRate == null || hourlyRate <= 0) return 0;
    return (state.monthly_minutes / 60) * hourlyRate;
  };
  for (const state of driverStates) {
    const blockCount = state.assigned.reduce((s, ab) => s + ab.trip_count, 0);
    if (state.driver.employment_type === 'company_owner') {
      inhaberTrips += blockCount;
      inhaberMinutes += state.monthly_minutes;
    } else {
      employeeTrips += blockCount;
      employeeMinutes += state.monthly_minutes;
      const minSal = state.driver.planning_min_salary ?? state.driver.planning_target_salary ?? null;
      const maxSal = state.driver.planning_max_salary ?? state.driver.planning_target_salary ?? null;
      const brutto = bruttoEstimatorFinal(state);
      if (minSal != null && maxSal != null && brutto > 0) {
        if (brutto < minSal - 0.01) driversBelowMin++;
        else if (brutto > maxSal + 0.01) driversAboveMax++;
        else driversInRange++;
      }
    }
  }
  // Count blocks that went to non-Inhaber AND where Inhaber was rejected
  const inhaberInPool = selectedDrivers.some(d => d.employment_type === 'company_owner');
  const inhaberRejectionReasons: Record<string, number> = {};
  for (const rc of allBlockInhaberRejections) {
    inhaberRejectionReasons[rc.reason] = (inhaberRejectionReasons[rc.reason] ?? 0) + 1;
  }
  if (!inhaberInPool) {
    inhaberRejectionReasons['not_in_pool'] = (inhaberRejectionReasons['not_in_pool'] ?? 0) + blocks.length;
  }
  const blocksInhaberCouldNotTake = inhaberInPool ? allBlockInhaberRejections.length : blocks.length;

  return {
    assigned,
    unassigned: afterAustausch,
    driverStates,
    noteWarnings,
    inhaber_time_warnings: inhaberTimeWarnings,
    window_violation_details: computeWindowViolationDetails(driverStates),
    options: {
      oneVehiclePerDriverDay: opts.oneVehiclePerDriverDay,
      vehicleSwitchBufferMinutes: opts.vehicleSwitchBufferMinutes,
      inhaberSharePercent: opts.inhaberSharePercent,
    },
    multiple_vehicles_per_day_details: multiPerDayDetails,
    validation: {
      vehicle_blocks_total: blocks.length,
      assigned_blocks: assigned.length,
      unassigned_blocks: afterAustausch.length,
      resolved_trips: resolvedTrips,
      unassigned_trips: unassignedTrips,
      driver_overlaps: overlaps,
      vehicle_switch_violations: switchViolations,
      working_time_window_violations: windowViolations,
      daily_max_violations: dailyViolations,
      monthly_max_violations: monthlyViolations,
      non_selected_assignments: nonSelectedAssignments,
      multiple_vehicles_per_day_violations: multiPerDayViolations,
    },
    repair_summary: {
      attempted: repairAttempted,
      resolved: repairResolved,
      moved_blocks: repairMovedTotal,
    },
    manual_summary: {
      resolved_blocks: 0,
      dienstzeit_exceptions: 0,
      daily_exceptions: 0,
      monthly_exceptions: 0,
      intentionally_open: 0,
    },
    final_purge_debug: {
      assigned_count_before_purge: assignedCountBeforePurge,
      assigned_count_after_purge: assigned.length,
      unassigned_count_before_purge: unassignedCountBeforePurge,
      unassigned_count_after_purge: afterAustausch.length,
      evicted_blocks_count: finalConflictUnassigned.length,
      evicted_block_ids: finalConflictUnassigned.map(u => u.block_id),
      configured_vehicle_switch_buffer_minutes: opts.vehicleSwitchBufferMinutes,
      validation_source: 'block-level',
    },
    inhaber_summary: {
      inhaber_trips: inhaberTrips,
      inhaber_hours: Math.round(inhaberMinutes / 60 * 100) / 100,
      employee_trips: employeeTrips,
      employee_hours: Math.round(employeeMinutes / 60 * 100) / 100,
      drivers_above_max: driversAboveMax,
      drivers_below_min: driversBelowMin,
      drivers_in_range: driversInRange,
      blocks_inhaber_could_not_take: blocksInhaberCouldNotTake,
      inhaber_rejection_reasons: inhaberRejectionReasons,
      total_planned_hours: Math.round(totalBlockHours * 100) / 100,
      inhaber_target_hours: Math.round(inhaberTargetHours * 100) / 100,
      inhaber_share_percent: inhaberSharePercent,
      inhaber_deviation_hours: Math.round((Math.round(inhaberMinutes / 60 * 100) / 100 - inhaberTargetHours) * 100) / 100,
      inhaber_status: inhaberMinutes / 60 < inhaberTargetHours - toleranceHours
        ? 'below_target'
        : inhaberMinutes / 60 > inhaberTargetHours + toleranceHours
          ? 'above_target'
          : 'on_target',
    },
    austausch_summary: {
      attempted: austauschAttempted,
      resolved: austauschResolved,
      swaps: austauschSwaps,
    },
    note_violations: validateDriverNotesForPlanStep({
      stepName: 'Phase 3: Fahrer-Zuweisung',
      rides: buildRideIntervalsFromBlocks(assigned),
      driverNotesMap: opts.driverNotesMap,
      driverProfiles: selectedDrivers,
    }).violations,
  };
}

// ── manual resolver ────────────────────────────────────────────────────────
// Allow user-confirmed exceptions on Dienstzeit and/or Tageslimit for a single
// unassigned block, while STRICTLY preventing overlaps, switch violations,
// monthly-cap violations, non-selected assignments, weekday violations, and
// note-constraint violations.

export interface ManualAssignOptions {
  allowDienstzeit: boolean;
  allowDaily: boolean;
  allowMonthly?: boolean;
}

export function evaluateManualCandidate(
  result: Phase3Result,
  blockId: string,
  driverId: string,
  options: ManualAssignOptions,
): { feasible: boolean; reason: string; blockingChecks: string[] } {
  const u = result.unassigned.find(b => b.block_id === blockId);
  if (!u) return { feasible: false, reason: 'Block nicht in Liste der offenen Blöcke', blockingChecks: [] };
  const state = result.driverStates.find(s => s.driver_id === driverId);
  if (!state) return { feasible: false, reason: 'Fahrer nicht in Auswahl', blockingChecks: ['non_selected'] };

  const blocking: string[] = [];
  const driver = state.driver;

  // Weekday (Arbeitstag) is ALWAYS strict
  if (driver.allowed_weekdays && driver.allowed_weekdays.length > 0) {
    const iso = isoWeekday(u.service_date);
    if (!driver.allowed_weekdays.includes(iso)) {
      blocking.push('Arbeitstag nicht erlaubt');
    }
  }
  // Dienstzeit (window) — bypassable via exception
  if (!options.allowDienstzeit && !driver.is_full_day_available) {
    if (driver.work_window_start && driver.work_window_end) {
      const wStart = timeToMin(driver.work_window_start);
      const wEnd = timeToMin(driver.work_window_end);
      if (wStart != null && wEnd != null) {
        const { start: bStart, end: bEnd } = blockTimeOfDayMinutes(u);
        const ok = wStart <= wEnd ? bStart >= wStart && bEnd <= wEnd : bStart >= wStart && bEnd <= 24 * 60 + wEnd;
        if (!ok) blocking.push('Außerhalb Dienstzeit');
      }
    }
  }
  // Notiz (strict) — legacy fallback only (structured notes not available in manual eval without notes map)
  if (checkNote(driver, u)) blocking.push('Notiz-Einschränkung');
  // Overlap (ALWAYS strict)
  if (checkOverlap(state, u)) blocking.push('Fahrer-Überlappung');
  // Switch (ALWAYS strict)
  if (checkVehicleSwitch(state, u, result.options.vehicleSwitchBufferMinutes)) blocking.push('Fahrzeugwechsel-Puffer');
  // Ein Fahrzeug pro Fahrer/Tag (ALWAYS strict when enabled)
  if (result.options.oneVehiclePerDriverDay && state.driver.employment_type !== 'company_owner' && checkOneVehiclePerDay(state, u)) {
    blocking.push('Fahrer nutzt bereits anderes Fahrzeug an diesem Tag');
  }
  // Daily (bypassable)
  if (!options.allowDaily) {
    if (checkDaily(state, u)) blocking.push('Tageslimit überschritten');
  }
  // Monthly (bypassable via explicit Monatslimit-Ausnahme)
  if (!options.allowMonthly) {
    if (checkMonthly(state, u)) blocking.push('Monatslimit überschritten');
  }

  if (blocking.length === 0) return { feasible: true, reason: '', blockingChecks: [] };
  return { feasible: false, reason: blocking.join(', '), blockingChecks: blocking };
}

function computeWindowViolationDetails(driverStates: DriverPlanState[]): Phase3Result['window_violation_details'] {
  const out: Phase3Result['window_violation_details'] = [];
  for (const state of driverStates) {
    if (state.driver.employment_type === 'company_owner') continue;
    for (const a of state.assigned) {
      if (a.manual_exception?.dienstzeit) continue;
      const wrong = checkWindow(state.driver, a);
      if (wrong) {
        out.push({
          block_id: a.block_id,
          driver_id: state.driver_id,
          driver_name: state.driver_name,
          service_date: a.service_date,
          vehicle_identifier: a.vehicle_identifier,
          block_start: a.block_start_datetime.slice(11, 16),
          block_end: a.block_end_datetime.slice(11, 16),
          work_window_start: state.driver.work_window_start ?? null,
          work_window_end: state.driver.work_window_end ?? null,
          detail: wrong.detail,
        });
      }
    }
  }
  return out;
}

function recomputeValidation(result: Phase3Result, selectedDrivers: PlanningDriver[]): { validation: Phase3Result['validation']; inhaber_time_warnings: Phase3Result['inhaber_time_warnings']; window_violation_details: Phase3Result['window_violation_details'] } {
  let overlaps = 0;
  let switchViolations = 0;
  let dailyViolations = 0;
  let monthlyViolations = 0;
  let windowViolations = 0;
  let nonSelectedAssignments = 0;
  let multiPerDayViolations = 0;
  const inhaberTimeWarnings: Phase3Result['inhaber_time_warnings'] = [];
  const selectedSet = new Set(selectedDrivers.map(d => d.id));

  for (const a of result.assigned) {
    if (!selectedSet.has(a.driver_id)) nonSelectedAssignments++;
  }

  for (const state of result.driverStates) {
    const isOwner = state.driver.employment_type === 'company_owner';
    const sorted = [...state.assigned].sort((a, b) => blockStartMs(a) - blockStartMs(b));
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      const as = blockStartMs(a);
      const ae = blockEndMs(a);
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        const bs = blockStartMs(b);
        const be = blockEndMs(b);
        if (as < be && ae > bs) overlaps++;
        if (a.vehicle_id !== b.vehicle_id) {
          let gap: number;
          if (ae <= bs) gap = (bs - ae) / 60000;
          else if (be <= as) gap = (as - be) / 60000;
          else gap = -1;
          if (gap >= 0 && gap < result.options.vehicleSwitchBufferMinutes) switchViolations++;
        }
      }
      // window violations: Inhaber exempt from hard count, collect as non-blocking warning.
      if (!a.manual_exception?.dienstzeit) {
        const wrong = checkWindow(state.driver, a);
        if (wrong) {
          if (isOwner) {
            inhaberTimeWarnings.push({ driver_id: state.driver_id, driver_name: state.driver_name, kind: 'dienstzeit', detail: wrong.detail });
          } else {
            windowViolations++;
          }
        }
      }
    }
    const maxMin = Math.round(state.effective_max_daily_hours * 60);
    if (!isOwner) {
      const dailyExceptionDates = new Set(
        state.assigned.filter(a => a.manual_exception?.daily).map(a => a.service_date),
      );
      for (const [date, mins] of state.daily_minutes.entries()) {
        if (dailyExceptionDates.has(date)) continue;
        if (mins > maxMin) dailyViolations++;
      }
      const cap = state.driver.max_monthly_hours;
      const monthlyExcepted = state.assigned.some(a => a.manual_exception?.monthly);
      if (cap != null && state.monthly_minutes > cap * 60 && !monthlyExcepted) monthlyViolations++;
    } else {
      // Inhaber: non-blocking time warnings.
      for (const [date, mins] of state.daily_minutes.entries()) {
        if (mins > maxMin) {
          inhaberTimeWarnings.push({ driver_id: state.driver_id, driver_name: state.driver_name, kind: 'tageslimit', detail: `${date}: ${fmtHours(mins)} / ${state.effective_max_daily_hours}h` });
        }
      }
      const cap = state.driver.max_monthly_hours;
      if (cap != null && state.monthly_minutes > cap * 60) {
        inhaberTimeWarnings.push({ driver_id: state.driver_id, driver_name: state.driver_name, kind: 'monatslimit', detail: `${fmtHours(state.monthly_minutes)} / ${cap}h` });
      }
    }
    if (result.options.oneVehiclePerDriverDay && !isOwner) {
      const byDay = new Map<string, Set<string>>();
      for (const a of state.assigned) {
        const k = startDayKey(a);
        const set = byDay.get(k) ?? new Set<string>();
        set.add(a.vehicle_id);
        byDay.set(k, set);
      }
      for (const vehicles of byDay.values()) {
        if (vehicles.size > 1) multiPerDayViolations++;
      }
    }
  }

  const resolvedTrips = result.assigned.reduce((s, b) => s + b.trip_count, 0);
  const unassignedTrips = result.unassigned
    .filter(b => !b.intentionally_open)
    .reduce((s, b) => s + b.trip_count, 0);

  return {
    validation: {
      vehicle_blocks_total: result.validation.vehicle_blocks_total,
      assigned_blocks: result.assigned.length,
      unassigned_blocks: result.unassigned.filter(b => !b.intentionally_open).length,
      resolved_trips: resolvedTrips,
      unassigned_trips: unassignedTrips,
      driver_overlaps: overlaps,
      vehicle_switch_violations: switchViolations,
      working_time_window_violations: windowViolations,
      daily_max_violations: dailyViolations,
      monthly_max_violations: monthlyViolations,
      non_selected_assignments: nonSelectedAssignments,
      multiple_vehicles_per_day_violations: multiPerDayViolations,
    },
    inhaber_time_warnings: inhaberTimeWarnings,
    window_violation_details: computeWindowViolationDetails(result.driverStates),
  };
}

function recomputeMultiVehicleDetails(result: Phase3Result): Phase3Result['multiple_vehicles_per_day_details'] {
  if (!result.options.oneVehiclePerDriverDay) return [];
  const out: Phase3Result['multiple_vehicles_per_day_details'] = [];
  for (const state of result.driverStates) {
    if (state.driver.employment_type === 'company_owner') continue;
    const byDay = new Map<string, Map<string, { identifier: string; blockIds: string[] }>>();
    for (const ab of state.assigned) {
      const k = startDayKey(ab);
      const dayMap = byDay.get(k) ?? new Map();
      const entry = dayMap.get(ab.vehicle_id) ?? { identifier: ab.vehicle_identifier, blockIds: [] };
      entry.blockIds.push(ab.block_id);
      dayMap.set(ab.vehicle_id, entry);
      byDay.set(k, dayMap);
    }
    for (const [day, vehicles] of byDay.entries()) {
      if (vehicles.size > 1) {
        const ids: string[] = [];
        const identifiers: string[] = [];
        for (const v of vehicles.values()) {
          identifiers.push(v.identifier);
          ids.push(...v.blockIds);
        }
        out.push({ date: day, driver_id: state.driver_id, driver_name: state.driver_name, vehicles: identifiers, block_ids: ids });
      }
    }
  }
  return out;
}

function recomputeManualSummary(result: Phase3Result): Phase3Result['manual_summary'] {
  let resolved = 0;
  let dienstzeit = 0;
  let daily = 0;
  let monthly = 0;
  for (const a of result.assigned) {
    if (a.manual_exception?.confirmed_by_user) {
      resolved++;
      if (a.manual_exception.dienstzeit) dienstzeit++;
      if (a.manual_exception.daily) daily++;
      if (a.manual_exception.monthly) monthly++;
    }
  }
  const open = result.unassigned.filter(b => b.intentionally_open).length;
  return {
    resolved_blocks: resolved,
    dienstzeit_exceptions: dienstzeit,
    daily_exceptions: daily,
    monthly_exceptions: monthly,
    intentionally_open: open,
  };
}

export function applyManualAssignment(
  current: Phase3Result,
  selectedDrivers: PlanningDriver[],
  blockId: string,
  driverId: string,
  options: ManualAssignOptions,
): { ok: boolean; reason: string; result: Phase3Result } {
  const feas = evaluateManualCandidate(current, blockId, driverId, options);
  if (!feas.feasible) {
    return { ok: false, reason: feas.reason, result: current };
  }
  const block = current.unassigned.find(b => b.block_id === blockId)!;
  const state = current.driverStates.find(s => s.driver_id === driverId)!;

  const reasonParts: string[] = [];
  if (options.allowDienstzeit) reasonParts.push('Dienstzeit-Ausnahme bestätigt durch Benutzer');
  if (options.allowDaily) reasonParts.push('Tageslimit-Ausnahme bestätigt durch Benutzer');
  if (options.allowMonthly) reasonParts.push('Monatslimit-Ausnahme bestätigt durch Benutzer');
  const manualReason = reasonParts.join(' · ') || 'Manuelle Zuweisung';

  const ab: AssignedBlock = {
    ...block,
    driver_id: state.driver_id,
    driver_name: state.driver_name,
    assignment_reason: `Manuelle Ausnahme: ${manualReason}`,
    effective_max_daily_hours: state.effective_max_daily_hours,
    used_default_max_daily: state.used_default_max_daily,
    manual_exception: {
      dienstzeit: options.allowDienstzeit,
      daily: options.allowDaily,
      monthly: !!options.allowMonthly,
      confirmed_by_user: true,
      reason: manualReason,
    },
  };

  // build new result with deep-ish copies
  const newStates = current.driverStates.map(s => {
    if (s.driver_id !== driverId) return s;
    const dm = new Map(s.daily_minutes);
    dm.set(block.service_date, (dm.get(block.service_date) ?? 0) + block.duration_minutes);
    return {
      ...s,
      assigned: [...s.assigned, ab],
      daily_minutes: dm,
      monthly_minutes: s.monthly_minutes + block.duration_minutes,
    };
  });

  const newAssigned = [...current.assigned, ab].sort((a, b) => {
    const sA = blockStartMs(a), sB = blockStartMs(b);
    if (sA !== sB) return sA - sB;
    return a.block_start_datetime.localeCompare(b.block_start_datetime);
  });
  const newUnassigned = current.unassigned.filter(b => b.block_id !== blockId);

  const intermediate: Phase3Result = {
    ...current,
    driverStates: newStates,
    assigned: newAssigned,
    unassigned: newUnassigned,
  };
  const recomputed = recomputeValidation(intermediate, selectedDrivers);
  const manual_summary = recomputeManualSummary(intermediate);
  const multiple_vehicles_per_day_details = recomputeMultiVehicleDetails(intermediate);
  return { ok: true, reason: manualReason, result: { ...intermediate, validation: recomputed.validation, inhaber_time_warnings: recomputed.inhaber_time_warnings, window_violation_details: recomputed.window_violation_details, manual_summary, multiple_vehicles_per_day_details } };
}

export function applyLeaveOpen(
  current: Phase3Result,
  selectedDrivers: PlanningDriver[],
  blockId: string,
): Phase3Result {
  const newUnassigned = current.unassigned.map(b =>
    b.block_id === blockId ? { ...b, intentionally_open: true } : b,
  );
  const intermediate: Phase3Result = { ...current, unassigned: newUnassigned };
  const recomputed = recomputeValidation(intermediate, selectedDrivers);
  const manual_summary = recomputeManualSummary(intermediate);
  const multiple_vehicles_per_day_details = recomputeMultiVehicleDetails(intermediate);
  return { ...intermediate, validation: recomputed.validation, inhaber_time_warnings: recomputed.inhaber_time_warnings, window_violation_details: recomputed.window_violation_details, manual_summary, multiple_vehicles_per_day_details };
}

export function undoManualResolution(
  current: Phase3Result,
  selectedDrivers: PlanningDriver[],
  blockId: string,
): Phase3Result {
  // Case 1: block currently in unassigned with intentionally_open → reset
  if (current.unassigned.some(b => b.block_id === blockId && b.intentionally_open)) {
    const newUnassigned = current.unassigned.map(b =>
      b.block_id === blockId ? { ...b, intentionally_open: false } : b,
    );
    const intermediate: Phase3Result = { ...current, unassigned: newUnassigned };
    const recomputed = recomputeValidation(intermediate, selectedDrivers);
    return {
      ...intermediate,
      validation: recomputed.validation,
      inhaber_time_warnings: recomputed.inhaber_time_warnings,
      window_violation_details: recomputed.window_violation_details,
      manual_summary: recomputeManualSummary(intermediate),
      multiple_vehicles_per_day_details: recomputeMultiVehicleDetails(intermediate),
    };
  }
  // Case 2: block currently in assigned with manual_exception → move back to unassigned
  const ab = current.assigned.find(b => b.block_id === blockId && b.manual_exception?.confirmed_by_user);
  if (!ab) return current;
  const newAssigned = current.assigned.filter(b => b.block_id !== blockId);
  const newStates = current.driverStates.map(s => {
    if (s.driver_id !== ab.driver_id) return s;
    const dm = new Map(s.daily_minutes);
    dm.set(ab.service_date, (dm.get(ab.service_date) ?? 0) - ab.duration_minutes);
    return {
      ...s,
      assigned: s.assigned.filter(x => x.block_id !== blockId),
      daily_minutes: dm,
      monthly_minutes: s.monthly_minutes - ab.duration_minutes,
    };
  });
  const { driver_id: _di, driver_name: _dn, assignment_reason: _ar, effective_max_daily_hours: _em, used_default_max_daily: _ud, repair_applied: _ra, repair_moved: _rm, manual_exception: _me, ...phase1Fields } = ab;
  const newUnassigned: UnassignedBlock[] = [
    ...current.unassigned,
    {
      ...phase1Fields,
      rejected: [],
      repair_attempted: false,
      repair_reason: '',
      repair_attempts: [],
    },
  ];
  const intermediate: Phase3Result = { ...current, assigned: newAssigned, driverStates: newStates, unassigned: newUnassigned };
  const recomputed = recomputeValidation(intermediate, selectedDrivers);
  return {
    ...intermediate,
    validation: recomputed.validation,
    inhaber_time_warnings: recomputed.inhaber_time_warnings,
    window_violation_details: recomputed.window_violation_details,
    manual_summary: recomputeManualSummary(intermediate),
  };
}

/**
 * Accepts a Dienstzeit exception for a specific already-assigned block.
 * The exception is block-scoped only — it does not change the driver's
 * general shift window or affect other days/blocks.
 */
export function applyDienstzeitException(
  current: Phase3Result,
  selectedDrivers: PlanningDriver[],
  blockId: string,
): Phase3Result {
  const patchBlock = (b: AssignedBlock): AssignedBlock => {
    if (b.block_id !== blockId) return b;
    const prev = b.manual_exception ?? {};
    return {
      ...b,
      manual_exception: {
        ...prev,
        dienstzeit: true,
        confirmed_by_user: true,
        reason: prev.reason ? prev.reason + ' · Dienstzeit-Ausnahme bestätigt durch Benutzer' : 'Dienstzeit-Ausnahme bestätigt durch Benutzer',
      },
    };
  };
  const newAssigned = current.assigned.map(patchBlock);
  const newStates = current.driverStates.map(s => ({
    ...s,
    assigned: s.assigned.map(patchBlock),
  }));
  const intermediate: Phase3Result = { ...current, assigned: newAssigned, driverStates: newStates };
  const recomputed = recomputeValidation(intermediate, selectedDrivers);
  const manual_summary = recomputeManualSummary(intermediate);
  const multiple_vehicles_per_day_details = recomputeMultiVehicleDetails(intermediate);
  return {
    ...intermediate,
    validation: recomputed.validation,
    inhaber_time_warnings: recomputed.inhaber_time_warnings,
    window_violation_details: recomputed.window_violation_details,
    manual_summary,
    multiple_vehicles_per_day_details,
  };
}

/**
 * Moves an already-assigned block back to the unassigned list so it can be
 * re-assigned via the manual resolver dialog.
 */
export function unassignBlock(
  current: Phase3Result,
  selectedDrivers: PlanningDriver[],
  blockId: string,
): Phase3Result {
  const block = current.assigned.find(b => b.block_id === blockId);
  if (!block) return current;

  // Reconstruct an UnassignedBlock from the AssignedBlock
  const { driver_id: _did, driver_name: _dn, assignment_reason: _ar, effective_max_daily_hours: _emh, used_default_max_daily: _udm, manual_exception: _me, ...rest } = block as AssignedBlock & { driver_id: string; driver_name: string; assignment_reason: string; effective_max_daily_hours: number; used_default_max_daily: boolean; manual_exception?: AssignedBlock['manual_exception'] };
  const unassignedBlock: UnassignedBlock = {
    ...rest,
    rejected: [],
    repair_attempted: false,
    repair_reason: '',
    repair_attempts: [],
    intentionally_open: false,
    inhaber_rejection: null,
  };

  const newAssigned = current.assigned.filter(b => b.block_id !== blockId);
  const newUnassigned = [unassignedBlock, ...current.unassigned];
  const newStates = current.driverStates.map(s => {
    if (!s.assigned.some(b => b.block_id === blockId)) return s;
    const dm = new Map(s.daily_minutes);
    const prev = dm.get(block.service_date) ?? 0;
    const after = Math.max(0, prev - block.duration_minutes);
    if (after === 0) dm.delete(block.service_date); else dm.set(block.service_date, after);
    return {
      ...s,
      assigned: s.assigned.filter(b => b.block_id !== blockId),
      daily_minutes: dm,
      monthly_minutes: Math.max(0, s.monthly_minutes - block.duration_minutes),
    };
  });
  const intermediate: Phase3Result = { ...current, assigned: newAssigned, unassigned: newUnassigned, driverStates: newStates };
  const recomputed = recomputeValidation(intermediate, selectedDrivers);
  const manual_summary = recomputeManualSummary(intermediate);
  const multiple_vehicles_per_day_details = recomputeMultiVehicleDetails(intermediate);
  return {
    ...intermediate,
    validation: recomputed.validation,
    inhaber_time_warnings: recomputed.inhaber_time_warnings,
    window_violation_details: recomputed.window_violation_details,
    manual_summary,
    multiple_vehicles_per_day_details,
  };
}
