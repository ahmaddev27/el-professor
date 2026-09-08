// Vehicle-block-first Fahrtenbuch planner.
//
// Pipeline (Step 1 -> Step 9):
//   1. Group trips by vehicle + service date.
//   2. Split into VehicleBlocks separated by gaps > VEHICLE_BLOCK_GAP_MINUTES.
//   3. Carry only audit-level original driver metadata on each trip.
//   4. The driver pool is the explicitly selected drivers.
//   5. Per-block driver candidacy is checked against: notes / working-time
//      window / daily max / monthly max / overlap / vehicle-switch buffer.
//   6. Assign each block to the best valid driver (fair distribution by gap
//      to monthly target / salary target).
//   7. Blocks with no valid driver become UnresolvedBlock with per-driver
//      rejection reasons.
//   8. Resolved blocks expose tripIds for write-back through the existing
//      reassign RPC.
//   9. Final validation summarises overlaps / window / daily / monthly /
//      vehicle-switch / unresolved counts.

import { checkShiftWindow } from './shiftWindow';

export const VEHICLE_BLOCK_GAP_MINUTES = 60;
export const MIN_VEHICLE_SWITCH_BUFFER_MINUTES = 60;
export const DEFAULT_MAX_DAILY_WORK_HOURS = 8;

// ─── Inputs ─────────────────────────────────────────────────────────────────

export interface PlannerTrip {
  id: string;
  trip_date: string;          // YYYY-MM-DD (service date)
  start_time: string | null;  // HH:MM
  end_time: string | null;    // HH:MM
  duration_minutes: number | null;
  car_id: string | null;
  car_identifier: string | null;
  original_driver_id: string | null;
  original_driver_name: string;
  is_canceled: boolean;
}

export interface PlannerDriver {
  id: string;
  name: string;
  work_window_start?: string | null;
  work_window_end?: string | null;
  allowed_weekdays?: number[] | null;     // ISO 1=Mon..7=Sun
  allow_outside_shift_exceptions?: boolean;
  max_daily_hours?: number | null;
  target_monthly_hours?: number | null;
  max_monthly_hours?: number | null;
  planning_target_salary?: number | null;
  planning_hourly_rate?: number | null;
  notes?: string | null;
  planning_priority?: number;
}

// ─── Outputs ────────────────────────────────────────────────────────────────

export interface VehicleBlock {
  block_id: string;
  vehicle_id: string;
  vehicle_identifier: string;
  service_date: string;
  block_start_minute: number;
  block_end_minute: number;
  block_start_time: string;
  block_end_time: string;
  duration_minutes: number;
  trip_ids: string[];
  trip_count: number;
  internal_gaps: number[];
  longest_internal_gap_minutes: number;
  // Carry original metadata for audit / display ONLY — never used for assignment.
  original_driver_ids: string[];
  original_driver_names: string[];
}

export interface ResolvedVehicleBlock extends VehicleBlock {
  resolved_driver_id: string;
  resolved_driver_name: string;
  resolved_block_id: string;
  assignment_source: 'vehicle_block_planner';
  assignment_reason: string;
}

export interface RejectedCandidate {
  driver_id: string;
  driver_name: string;
  reason:
    | 'outside_working_time_window'
    | 'wrong_weekday'
    | 'daily_max_exceeded'
    | 'monthly_max_exceeded'
    | 'driver_overlap'
    | 'vehicle_switch_buffer_violation'
    | 'blocked_by_note';
  detail: string;
}

export interface UnresolvedVehicleBlock extends VehicleBlock {
  rejected: RejectedCandidate[];
}

export interface DriverPlanState {
  driver_id: string;
  driver_name: string;
  assigned_blocks: ResolvedVehicleBlock[];
  daily_minutes: Map<string, number>;
  monthly_minutes: number;
  warnings: string[];
}

export interface VehicleBlockPlanResult {
  blocks: VehicleBlock[];
  resolved: ResolvedVehicleBlock[];
  unresolved: UnresolvedVehicleBlock[];
  driver_states: Map<string, DriverPlanState>;
  validation: {
    vehicle_blocks_built: number;
    assigned_blocks: number;
    unresolved_blocks: number;
    resolved_trips: number;
    driver_overlaps: number;
    vehicle_switch_violations: number;
    working_time_window_violations: number;
    daily_max_violations: number;
    monthly_max_violations: number;
    note_warnings: number;
  };
  note_warnings: Array<{ driver_id: string; driver_name: string; note: string; reason: string }>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function timeToMin(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minToTime(m: number): string {
  const mm = ((m % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(mm / 60);
  const r = mm % 60;
  return `${String(h).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

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

function isoWeekdayFromDateString(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  const js = dt.getDay();
  return js === 0 ? 7 : js;
}

function checkNoteBlock(
  note: string | null | undefined,
  block: VehicleBlock,
): { blocked: boolean; reason: string } {
  if (!note || !note.trim()) return { blocked: false, reason: '' };
  const iso = isoWeekdayFromDateString(block.service_date);
  const lowerNote = note.toLowerCase();

  if (HARD_NOTE_TOKENS[0].token.test(lowerNote) && block.block_end_minute > 22 * 60) {
    return { blocked: true, reason: 'Notiz: keine Nachtschicht' };
  }
  if (HARD_NOTE_TOKENS[1].token.test(lowerNote) && block.block_end_minute > 12 * 60) {
    return { blocked: true, reason: 'Notiz: nur morgens' };
  }
  if (HARD_NOTE_TOKENS[2].token.test(lowerNote) && iso < 6) {
    return { blocked: true, reason: 'Notiz: nur Wochenende' };
  }
  const nichtMap: Record<number, RegExp> = {
    1: HARD_NOTE_TOKENS[3].token,
    2: HARD_NOTE_TOKENS[4].token,
    3: HARD_NOTE_TOKENS[5].token,
    4: HARD_NOTE_TOKENS[6].token,
    5: HARD_NOTE_TOKENS[7].token,
    6: HARD_NOTE_TOKENS[8].token,
    7: HARD_NOTE_TOKENS[9].token,
  };
  const rx = nichtMap[iso];
  if (rx && rx.test(lowerNote)) {
    const names = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
    return { blocked: true, reason: `Notiz: nicht ${names[iso]}s` };
  }
  return { blocked: false, reason: '' };
}

// ─── Step 1 + 2: build vehicle blocks ───────────────────────────────────────

export function buildVehicleBlocks(
  trips: PlannerTrip[],
  gapMinutes: number = VEHICLE_BLOCK_GAP_MINUTES,
): VehicleBlock[] {
  // Group active trips by vehicle + date.
  type Key = string;
  const groups = new Map<Key, PlannerTrip[]>();
  for (const t of trips) {
    if (t.is_canceled) continue;
    const sm = timeToMin(t.start_time);
    const em = timeToMin(t.end_time);
    if (sm == null || em == null) continue;
    const vehicleId = t.car_id ?? t.car_identifier;
    if (!vehicleId) continue;
    const key = `${vehicleId}|${t.trip_date}`;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(t);
  }

  const blocks: VehicleBlock[] = [];
  for (const [key, arr] of groups) {
    arr.sort((a, b) => (timeToMin(a.start_time) ?? 0) - (timeToMin(b.start_time) ?? 0));
    const [vehicleId, dateStr] = key.split('|');

    let blockTrips: PlannerTrip[] = [];
    let internalGaps: number[] = [];
    const flush = () => {
      if (blockTrips.length === 0) return;
      const startMin = timeToMin(blockTrips[0].start_time)!;
      const endMin = Math.max(...blockTrips.map(t => timeToMin(t.end_time) ?? 0));
      const longestGap = internalGaps.length > 0 ? Math.max(...internalGaps) : 0;
      const kennzeichen = blockTrips[0].car_identifier ?? vehicleId;
      const origIds = Array.from(new Set(blockTrips.map(t => t.original_driver_id).filter((x): x is string => !!x)));
      const origNames = Array.from(new Set(blockTrips.map(t => t.original_driver_name).filter(Boolean)));
      blocks.push({
        block_id: `${vehicleId}|${dateStr}|${minToTime(startMin)}|${minToTime(endMin)}`,
        vehicle_id: vehicleId,
        vehicle_identifier: kennzeichen,
        service_date: dateStr,
        block_start_minute: startMin,
        block_end_minute: endMin,
        block_start_time: minToTime(startMin),
        block_end_time: minToTime(endMin),
        duration_minutes: Math.max(0, endMin - startMin),
        trip_ids: blockTrips.map(t => t.id),
        trip_count: blockTrips.length,
        internal_gaps: [...internalGaps],
        longest_internal_gap_minutes: longestGap,
        original_driver_ids: origIds,
        original_driver_names: origNames,
      });
      blockTrips = [];
      internalGaps = [];
    };

    for (let i = 0; i < arr.length; i++) {
      const t = arr[i];
      if (blockTrips.length === 0) { blockTrips.push(t); continue; }
      const prev = blockTrips[blockTrips.length - 1];
      const prevEnd = timeToMin(prev.end_time) ?? 0;
      const curStart = timeToMin(t.start_time) ?? 0;
      const gap = curStart - prevEnd;
      if (gap > gapMinutes) {
        flush();
        blockTrips.push(t);
      } else {
        if (gap > 0) internalGaps.push(gap);
        blockTrips.push(t);
      }
    }
    flush();
  }

  blocks.sort((a, b) =>
    a.service_date.localeCompare(b.service_date) ||
    a.block_start_minute - b.block_start_minute ||
    a.vehicle_identifier.localeCompare(b.vehicle_identifier),
  );
  return blocks;
}

// ─── Step 5: candidate checks ───────────────────────────────────────────────

function checkWindow(driver: PlannerDriver, block: VehicleBlock): RejectedCandidate | null {
  const chk = checkShiftWindow(
    driver,
    block.service_date,
    block.block_start_minute,
    block.block_end_minute,
  );
  if (chk.ok) return null;
  if (chk.reason === 'wrong_weekday') {
    return {
      driver_id: driver.id,
      driver_name: driver.name,
      reason: 'wrong_weekday',
      detail: 'Fahrer an diesem Wochentag nicht verfügbar',
    };
  }
  return {
    driver_id: driver.id,
    driver_name: driver.name,
    reason: 'outside_working_time_window',
    detail: `Block ${block.block_start_time}-${block.block_end_time} liegt außerhalb der Dienstzeit`,
  };
}

function checkDaily(driver: PlannerDriver, block: VehicleBlock, state: DriverPlanState): RejectedCandidate | null {
  const maxDailyHours = driver.max_daily_hours ?? DEFAULT_MAX_DAILY_WORK_HOURS;
  const maxDailyMin = Math.round(maxDailyHours * 60);
  const used = state.daily_minutes.get(block.service_date) ?? 0;
  if (used + block.duration_minutes > maxDailyMin) {
    return {
      driver_id: driver.id,
      driver_name: driver.name,
      reason: 'daily_max_exceeded',
      detail: `Tageslimit ${(maxDailyHours).toFixed(1)}h überschritten (${((used + block.duration_minutes) / 60).toFixed(2)}h)`,
    };
  }
  return null;
}

function checkMonthly(driver: PlannerDriver, block: VehicleBlock, state: DriverPlanState): RejectedCandidate | null {
  const cap = driver.max_monthly_hours ?? driver.target_monthly_hours;
  if (cap == null) return null;
  const capMin = Math.round(cap * 60);
  if (state.monthly_minutes + block.duration_minutes > capMin) {
    return {
      driver_id: driver.id,
      driver_name: driver.name,
      reason: 'monthly_max_exceeded',
      detail: `Monatslimit ${cap.toFixed(1)}h überschritten`,
    };
  }
  return null;
}

function checkOverlap(driver: PlannerDriver, block: VehicleBlock, state: DriverPlanState): RejectedCandidate | null {
  for (const a of state.assigned_blocks) {
    if (a.service_date !== block.service_date) continue;
    if (block.block_start_minute < a.block_end_minute && block.block_end_minute > a.block_start_minute) {
      return {
        driver_id: driver.id,
        driver_name: driver.name,
        reason: 'driver_overlap',
        detail: `Überlappung mit Block ${a.vehicle_identifier} ${a.block_start_time}-${a.block_end_time}`,
      };
    }
  }
  return null;
}

function checkVehicleSwitch(driver: PlannerDriver, block: VehicleBlock, state: DriverPlanState): RejectedCandidate | null {
  for (const a of state.assigned_blocks) {
    if (a.service_date !== block.service_date) continue;
    if (a.vehicle_id === block.vehicle_id) continue;
    let gap: number;
    if (a.block_end_minute <= block.block_start_minute) {
      gap = block.block_start_minute - a.block_end_minute;
    } else if (block.block_end_minute <= a.block_start_minute) {
      gap = a.block_start_minute - block.block_end_minute;
    } else {
      continue; // overlap already caught
    }
    if (gap < MIN_VEHICLE_SWITCH_BUFFER_MINUTES) {
      return {
        driver_id: driver.id,
        driver_name: driver.name,
        reason: 'vehicle_switch_buffer_violation',
        detail: `Fahrzeugwechsel ${a.vehicle_identifier} → ${block.vehicle_identifier}, Puffer ${gap} Min. < ${MIN_VEHICLE_SWITCH_BUFFER_MINUTES} Min.`,
      };
    }
  }
  return null;
}

function checkNote(driver: PlannerDriver, block: VehicleBlock): RejectedCandidate | null {
  const r = checkNoteBlock(driver.notes, block);
  if (!r.blocked) return null;
  return {
    driver_id: driver.id,
    driver_name: driver.name,
    reason: 'blocked_by_note',
    detail: r.reason,
  };
}

// ─── Step 6: assignment ─────────────────────────────────────────────────────

function scoreDriver(driver: PlannerDriver, state: DriverPlanState): number {
  // Higher score = better candidate. Prefer drivers furthest below target.
  const targetMin = driver.target_monthly_hours != null ? driver.target_monthly_hours * 60 : 0;
  const gap = Math.max(0, targetMin - state.monthly_minutes);
  // Light tie-break: fewer hours assigned so far.
  return gap * 1000 - state.monthly_minutes;
}

export function planVehicleBlocks(
  trips: PlannerTrip[],
  selectedDrivers: PlannerDriver[],
): VehicleBlockPlanResult {
  const blocks = buildVehicleBlocks(trips);
  const driverStates = new Map<string, DriverPlanState>();
  for (const d of selectedDrivers) {
    driverStates.set(d.id, {
      driver_id: d.id,
      driver_name: d.name,
      assigned_blocks: [],
      daily_minutes: new Map(),
      monthly_minutes: 0,
      warnings: [],
    });
  }

  const noteWarnings: VehicleBlockPlanResult['note_warnings'] = [];
  for (const d of selectedDrivers) {
    if (!d.notes || !d.notes.trim()) continue;
    const text = d.notes.toLowerCase();
    const matched = HARD_NOTE_TOKENS.some(({ token }) => token.test(text));
    if (!matched) {
      noteWarnings.push({
        driver_id: d.id,
        driver_name: d.name,
        note: d.notes,
        reason: 'Notiz konnte nicht automatisch interpretiert werden, bitte manuell prüfen.',
      });
    }
  }

  const resolved: ResolvedVehicleBlock[] = [];
  const unresolved: UnresolvedVehicleBlock[] = [];

  for (const block of blocks) {
    const rejected: RejectedCandidate[] = [];
    const candidates: Array<{ driver: PlannerDriver; state: DriverPlanState; score: number }> = [];

    for (const d of selectedDrivers) {
      const state = driverStates.get(d.id)!;
      const checks: Array<RejectedCandidate | null> = [
        checkWindow(d, block),
        checkNote(d, block),
        checkOverlap(d, block, state),
        checkVehicleSwitch(d, block, state),
        checkDaily(d, block, state),
        checkMonthly(d, block, state),
      ];
      const fail = checks.find(c => c !== null);
      if (fail) {
        rejected.push(fail!);
        continue;
      }
      candidates.push({ driver: d, state, score: scoreDriver(d, state) });
    }

    if (candidates.length === 0) {
      unresolved.push({ ...block, rejected });
      continue;
    }

    candidates.sort((a, b) => b.score - a.score);
    const winner = candidates[0];
    const targetMin = winner.driver.target_monthly_hours != null ? winner.driver.target_monthly_hours * 60 : 0;
    const targetGap = Math.max(0, targetMin - winner.state.monthly_minutes);
    const reason = targetGap > 0
      ? `Zugewiesen — Fahrer ${winner.state.monthly_minutes / 60 | 0}h vergeben, ${(targetGap / 60).toFixed(1)}h unter Zielstunden, Block innerhalb Dienstzeit`
      : `Zugewiesen — Block innerhalb Dienstzeit, alle harten Regeln erfüllt`;

    const resolvedBlock: ResolvedVehicleBlock = {
      ...block,
      resolved_driver_id: winner.driver.id,
      resolved_driver_name: winner.driver.name,
      resolved_block_id: block.block_id,
      assignment_source: 'vehicle_block_planner',
      assignment_reason: reason,
    };
    resolved.push(resolvedBlock);

    winner.state.assigned_blocks.push(resolvedBlock);
    winner.state.daily_minutes.set(
      block.service_date,
      (winner.state.daily_minutes.get(block.service_date) ?? 0) + block.duration_minutes,
    );
    winner.state.monthly_minutes += block.duration_minutes;
  }

  // ─── Step 9: final validation ─────────────────────────────────────────────
  let driverOverlaps = 0;
  let switchViolations = 0;
  let dailyViolations = 0;
  let monthlyViolations = 0;
  let windowViolations = 0;

  for (const state of driverStates.values()) {
    const sorted = [...state.assigned_blocks].sort((a, b) =>
      a.service_date.localeCompare(b.service_date) || a.block_start_minute - b.block_start_minute,
    );
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        if (a.service_date !== b.service_date) break;
        if (a.block_start_minute < b.block_end_minute && a.block_end_minute > b.block_start_minute) {
          driverOverlaps++;
        }
        if (a.vehicle_id !== b.vehicle_id) {
          let gap: number;
          if (a.block_end_minute <= b.block_start_minute) gap = b.block_start_minute - a.block_end_minute;
          else if (b.block_end_minute <= a.block_start_minute) gap = a.block_start_minute - b.block_end_minute;
          else gap = -1;
          if (gap >= 0 && gap < MIN_VEHICLE_SWITCH_BUFFER_MINUTES) switchViolations++;
        }
      }
    }
    const driver = selectedDrivers.find(d => d.id === state.driver_id);
    if (driver) {
      const maxDailyMin = Math.round(((driver.max_daily_hours ?? DEFAULT_MAX_DAILY_WORK_HOURS)) * 60);
      for (const [, mins] of state.daily_minutes) {
        if (mins > maxDailyMin) dailyViolations++;
      }
      const cap = driver.max_monthly_hours ?? driver.target_monthly_hours;
      if (cap != null && state.monthly_minutes > cap * 60) monthlyViolations++;
      for (const a of state.assigned_blocks) {
        const chk = checkShiftWindow(driver, a.service_date, a.block_start_minute, a.block_end_minute);
        if (!chk.ok) windowViolations++;
      }
    }
  }

  const resolvedTrips = resolved.reduce((s, b) => s + b.trip_count, 0);

  return {
    blocks,
    resolved,
    unresolved,
    driver_states: driverStates,
    note_warnings: noteWarnings,
    validation: {
      vehicle_blocks_built: blocks.length,
      assigned_blocks: resolved.length,
      unresolved_blocks: unresolved.length,
      resolved_trips: resolvedTrips,
      driver_overlaps: driverOverlaps,
      vehicle_switch_violations: switchViolations,
      working_time_window_violations: windowViolations,
      daily_max_violations: dailyViolations,
      monthly_max_violations: monthlyViolations,
      note_warnings: noteWarnings.length,
    },
  };
}
