// Monatsplanung – Final Overlap Pass
// Runs after Phase 3 completes. Detects driver/vehicle overlaps in the final
// assigned block list and REPORTS them. It moves nothing.
//
// ── The owner's rule, which is the requirement ───────────────────────────────
//
// "التخطيط يومي وللسيارة. إسناد السائقين بصير آخر الشهر" — planning is daily and
// per vehicle; drivers are assigned at month end. A driver can pick up a fine,
// an accident, a roadside incident or take leave mid-month, so his hours cannot
// be committed in advance.
//
// So the vehicle's day is the FACT and the driver is PROVISIONAL. This pass used
// to resolve a driver-side conflict by moving the vehicle's block in time — up
// to 200 iterations of it, a median of seven days away on the data that still
// reached it — which is the rule exactly backwards: a driver's problem reshaped
// a vehicle's day. It no longer does. A block whose assignment cannot hold
// loses its DRIVER, keeps its times, and is reported unassigned for a person to
// decide at month end.
//
// `src/utils/monthlyPlan/assign.ts` already refuses this and records why ("No
// repair pass, deliberately" — §7 rule 6, and the recorded boundary of
// 22.09.2026: never an engine function that shifts a block's time). This module
// now keeps the same rule, in the same vocabulary.
//
// What this pass does NOT touch, and must not grow into: the hard/bypassable
// reject split is Phase 3's. `wrong_weekday`, `driver_overlap`,
// `vehicle_switch_buffer_violation`, `one_vehicle_per_day` and `note_constraint`
// can never be bypassed; `outside_working_time_window`, `daily_max_exceeded` and
// `monthly_max_exceeded` keep their manual-exception path and their
// `monthly_planning_manual_exceptions` audit rows. That machinery lives in
// Phase 3's `applyManualAssignment` / `applyDienstzeitException`, reached only
// from the operator's resolver — never from this pass.
//
// Two bases this pass keeps straight, both from measured defects:
//
// - Driver identity is the `driver_id`, never the display name. A company can
//   hold two driver records with one name (the owner and an inactive employee
//   record). Keyed on the name, their ordinary simultaneous blocks "overlapped"
//   and the pass moved one of them, in time, by days.
// - Time is local. Phase 1 builds `actual_start_ms` with `new Date(y, m, d, h,
//   min)` and writes the wall clock beside it, so every number here is a real
//   instant and every string and boundary is read and written through LOCAL
//   calendar parts. `Date.UTC` and `getUTC*` are one or two hours away from the
//   instant the same block carries (the defect Phase 3's `parseLocalIsoMs`
//   documents), and a day is 23, 24 or 25 hours long.

// `unassignBlock` is Phase 3's own primitive for taking a block out of
// `assigned`: it rebuilds the `UnassignedBlock`, decrements the driver's daily
// and monthly minutes and recomputes the validation counters. Reusing it is what
// keeps that bookkeeping in the one module that owns it. Phase 3 imports nothing
// from here, so there is no cycle.
import { unassignBlock, type AssignedBlock, type Phase3Result } from './monatsplanungPhase3';
import type { PlanningDriver } from '../components/MonatsplanungDriverPool';
// Type-only: the pass names a dictionary key beside its German text.
import type { EngineMessageKey, EngineMessageVars } from '../i18n/engineMessageTypes';
import { parseLocalDatetime } from './driverNoteValidation';
import { localDateKey, nextLocalMidnightMs } from './localDayWindow';

const LOG_PREFIX = '[FinalOverlapRepair]';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RepairEntry {
  blockId: string;
  driverName: string;
  driverId: string;
  vehicle: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  isInhaber: boolean;
  /** True if this block was placed by repair/shift/manual logic (moveable). */
  isShiftable: boolean;
  assignmentReason: string;
}

export interface ConflictPair {
  kind: 'driver' | 'vehicle' | 'inhaber';
  blockA: RepairEntry;
  blockB: RepairEntry;
  overlapMs: number;
}

/**
 * A block relocation. **Nothing produces one any more**: `movedBlocks` is always
 * empty, because the vehicle's day is the fact (see the header). The type and the
 * always-empty array stay so the screen's existing panel keeps compiling and
 * simply renders nothing; deleting them is a separate, screen-side change.
 */
export interface RepairMove {
  blockId: string;
  vehicle: string;
  driverName: string;
  oldStartMs: number;
  oldEndMs: number;
  newStartMs: number;
  newEndMs: number;
  /** German, as the pass has always written it. The screen's fallback. */
  reason: string;
  reasonKey?: EngineMessageKey;
  bufferUsedMin: number;
}

/**
 * A block whose driver assignment cannot hold. The block keeps every one of its
 * times; it loses its driver and is reported unassigned, for a person to decide
 * at month end. This is what the pass produces instead of a `RepairMove`.
 */
export interface RepairRelease {
  blockId: string;
  /** The driver the block is released FROM, for the report. */
  driverName: string;
  driverId: string;
  vehicle: string;
  /** The block it overlapped, and by how much. */
  otherBlockId: string;
  otherVehicle: string;
  overlapMs: number;
  conflictKind: ConflictPair['kind'];
  /** German, exactly as the engine writes it. The screen's fallback. */
  reason: string;
  reasonKey?: EngineMessageKey;
  reasonVars?: EngineMessageVars;
}

export interface UnrepairableBlock {
  blockId: string;
  driverName: string;
  vehicle: string;
  durationMs: number;
  /** Either a ConflictPair kind ('driver' | 'vehicle' | 'inhaber') or German text. */
  conflictKind: string;
  conflictKindKey?: EngineMessageKey;
  freeDriverWindowsChecked: number;
  freeVehicleWindowsChecked: number;
  sharedWindowsChecked: number;
  /** German, as the pass has always written it. The screen's fallback. */
  reason: string;
  reasonKey?: EngineMessageKey;
  reasonVars?: EngineMessageVars;
}

export interface RepairPassResult {
  /**
   * The input blocks, unchanged. The pass rewrites no time, so this is the
   * caller's own array content; the released blocks are still in it, and
   * `applyRepairPass` is what takes them out of `Phase3Result.assigned`.
   */
  assignedBlocks: AssignedBlock[];
  /** Overlaps detected in the Phase 3 output, before anything was released. */
  conflictsBefore: number;
  conflictsAfter: number;
  /** Always empty. See `RepairMove`. */
  movedBlocks: RepairMove[];
  /** Blocks released from their driver and reported unassigned. */
  releases: RepairRelease[];
  unrepairable: UnrepairableBlock[];
  iterations: number;
  diagnostics: {
    fahrerUeberschneidungen: number;
    fahrzeugUeberschneidungen: number;
    inhaberUeberschneidungen: number;
    daueraenderungen: number;
    ausserhalb: number;
    pufferVerletzt: number;
    nichtGeplant: number;
    nichtReparierbar: number;
  };
}

// ── Ms helpers ────────────────────────────────────────────────────────────────

// The fallback for a block that carries no instant of its own. Its string is a
// local wall clock, so it is read as one; read as UTC it lands one or two hours
// away from the instant Phase 1 stores for the same block.
function blockStartMs(b: AssignedBlock): number {
  return b.actual_start_ms != null ? b.actual_start_ms : parseLocalDatetime(b.block_start_datetime);
}

function blockEndMs(b: AssignedBlock): number {
  return b.actual_end_ms != null ? b.actual_end_ms : parseLocalDatetime(b.block_end_datetime);
}

/** HH:mm on the local wall clock. */
function msToHHMM(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Interval index ────────────────────────────────────────────────────────────

/** Build a RepairEntry from an AssignedBlock. */
function toEntry(b: AssignedBlock, inhaberDriverId: string): RepairEntry {
  // The owner is a driver record. Another record with the same display name is
  // not the owner: a namesake employee is a regular driver, so not shiftable.
  const isInhaber =
    (inhaberDriverId && b.driver_id === inhaberDriverId) ||
    b.driver_name?.toLowerCase().includes('inhaber') ||
    b.assignment_reason?.toLowerCase().includes('inhaber') ||
    false;
  const isShiftable =
    (b.repair_moved === true) ||
    (b.repair_applied === true) ||
    isInhaber ||
    b.assignment_reason?.toLowerCase().includes('repair') ||
    b.assignment_reason?.toLowerCase().includes('reparatur') ||
    b.assignment_reason?.toLowerCase().includes('verschoben') ||
    b.assignment_reason?.toLowerCase().includes('tausch');
  return {
    blockId: b.block_id,
    driverName: b.driver_name ?? '',
    driverId: b.driver_id ?? '',
    vehicle: b.vehicle_identifier ?? '',
    startMs: blockStartMs(b),
    endMs: blockEndMs(b),
    durationMs: b.duration_minutes * 60 * 1000,
    isInhaber,
    isShiftable,
    assignmentReason: b.assignment_reason ?? '',
  };
}

/** Detect all overlap pairs. */
function detectConflicts(entries: RepairEntry[]): ConflictPair[] {
  const pairs: ConflictPair[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.startMs <= 0 || a.endMs <= 0 || b.startMs <= 0 || b.endMs <= 0) continue;

      const overlapMs = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
      if (overlapMs <= 0) continue;

      const pairKey = [a.blockId, b.blockId].sort().join('|');
      if (seen.has(pairKey)) continue;

      // Driver overlap: one driver record holding two blocks at once. The display
      // name is not identity, and an empty id is "unknown", which is never the
      // same driver as another unknown (the rule an empty name already had).
      if (a.driverId === b.driverId && a.driverId) {
        seen.add(pairKey);
        const kind: ConflictPair['kind'] = a.isInhaber ? 'inhaber' : 'driver';
        pairs.push({ kind, blockA: a, blockB: b, overlapMs });
        continue;
      }
      // Vehicle overlap
      if (a.vehicle === b.vehicle && a.vehicle) {
        seen.add(pairKey);
        pairs.push({ kind: 'vehicle', blockA: a, blockB: b, overlapMs });
      }
    }
  }

  return pairs;
}

/**
 * Choose which block of a conflict pair loses its driver. Returns null when
 * neither may: two regular-driver assignments, which are reported instead.
 *
 * The preference order is the one this function has always had — it used to pick
 * the block to MOVE and now picks the block to RELEASE, and the answer is the
 * same block either way: the owner's or an earlier pass's, because a regular
 * driver's assignment is not the planner's to undo, and the shorter of two when
 * both qualify, because that is the smaller loss.
 */
function chooseCandidate(pair: ConflictPair): RepairEntry | null {
  const a = pair.blockA;
  const b = pair.blockB;

  // Regular driver vs regular driver — neither may lose its driver here
  if (!a.isShiftable && !b.isShiftable) return null;
  if (a.isShiftable && b.isShiftable) {
    // Prefer shorter block, then b
    return a.durationMs <= b.durationMs ? a : b;
  }
  return a.isShiftable ? a : b;
}

/**
 * Month boundary ms: local midnights. Blocks are local instants, so a month that
 * began at 00:00 UTC began at 02:00 Berlin time in summer and 01:00 in winter,
 * and a month is its days plus or minus the hour a clock change adds or takes.
 */
function monthBounds(year: number, month: number): { monthStartMs: number; monthEndMs: number } {
  const monthStartMs = new Date(year, month - 1, 1).getTime();
  const monthEndMs = new Date(year, month, 1).getTime() - 1; // last ms of month
  return { monthStartMs, monthEndMs };
}

// `belongsToDriver` lived here: it answered whether a block was a given driver
// record's, for the busy-slot and free-window scans that looked for a new place
// to put a block. Nothing searches for a slot any more, so it went with them.
// Its rule — an empty driver id owns nothing, and is never "the same driver" as
// another unknown — is not lost: it is `detectConflicts`' own
// `a.driverId === b.driverId && a.driverId`, which is where identity is decided.

/**
 * The overlap pass. Takes the Phase 3 `assigned` array plus month/year and the
 * Inhaber driver, and reports what overlaps. **It changes no block.**
 *
 * `assignedBlocks` comes back with every time exactly as it went in. A conflict
 * is answered by naming the block that must lose its driver (`releases`), never
 * by moving one: see the header. `applyRepairPass` is what carries a release
 * into `Phase3Result`.
 *
 * `inhaberDriverId` identifies the owner; `inhaberDriverName` is only logged.
 * Without an id no block is the owner's by identity.
 *
 * `vehicleSwitchBufferMinutes` is accepted and logged, and no longer decides
 * anything here: it bounded the search for a new slot, and there is no search.
 * Phase 3 enforces the buffer as a hard constraint, which is where it belongs.
 */
export function repairFinalOverlaps(
  assigned: AssignedBlock[],
  year: number,
  month: number,
  inhaberDriverName: string,
  vehicleSwitchBufferMinutes = 30,
  inhaberDriverId = '',
): RepairPassResult {
  const { monthStartMs, monthEndMs } = monthBounds(year, month);

  // A shallow copy, as the pass has always returned. Not one field is written.
  const blocks: AssignedBlock[] = assigned.map(b => ({ ...b }));

  const movedBlocks: RepairMove[] = [];
  const releases: RepairRelease[] = [];
  const unrepairable: UnrepairableBlock[] = [];

  console.log(LOG_PREFIX, 'start', {
    totalBlocks: blocks.length,
    year,
    month,
    inhaberDriverName,
    vehicleSwitchBufferMinutes,
  });

  // ── One detection pass ─────────────────────────────────────────────────────
  //
  // There is exactly one, and `iterations` is 1 for every run. The old loop ran
  // up to 200 times because each move changed the layout and could create a new
  // overlap; releasing a driver only ever REMOVES a block from the layout, so a
  // second sweep could find no conflict the first did not already name.
  const entries = blocks.map(b => toEntry(b, inhaberDriverId));
  const conflicts = detectConflicts(entries);
  const conflictsBefore = conflicts.length;

  console.log(LOG_PREFIX, `detected ${conflictsBefore} conflicts`);

  // Block ids already released. A block overlapping two others is released once,
  // and the second conflict is then already answered.
  const released = new Set<string>();

  for (const conflict of conflicts) {
    if (released.has(conflict.blockA.blockId) || released.has(conflict.blockB.blockId)) continue;

    const candidate = chooseCandidate(conflict);

    if (!candidate) {
      // Neither block is the owner's or an earlier pass's: two regular-driver
      // assignments Phase 3 produced. Reported exactly as this pass has always
      // reported it, with the same German text, key and vars — and still NOT
      // released, because Phase 3 placed both deliberately and a hard constraint
      // it believes it kept is a defect to surface, not an assignment to undo.
      const existingKey = `${conflict.blockA.blockId}|${conflict.blockB.blockId}`;
      const alreadyLogged = unrepairable.some(
        u => u.blockId === conflict.blockA.blockId || u.blockId === conflict.blockB.blockId
      );
      if (!alreadyLogged) {
        unrepairable.push({
          blockId: conflict.blockA.blockId,
          driverName: conflict.blockA.driverName,
          vehicle: conflict.blockA.vehicle,
          durationMs: conflict.blockA.durationMs,
          conflictKind: 'Regulärer Fahrer-Konflikt aus Ausgangsplanung',
          conflictKindKey: 'engine.repair.conflictKind.regularDriver',
          freeDriverWindowsChecked: 0,
          freeVehicleWindowsChecked: 0,
          sharedWindowsChecked: 0,
          reason: `Regulärer Fahrer-Konflikt aus Ausgangsplanung: ${conflict.blockA.driverName} · ${conflict.blockA.vehicle} und ${conflict.blockB.vehicle} überlappen um ${Math.round(conflict.overlapMs / 60000)} Min.`,
          reasonKey: 'engine.repair.unrepairable.regularDriverConflict',
          reasonVars: {
            driver: conflict.blockA.driverName,
            vehicleA: conflict.blockA.vehicle,
            vehicleB: conflict.blockB.vehicle,
            overlapMinutes: Math.round(conflict.overlapMs / 60000),
          },
        });
        console.warn(LOG_PREFIX, 'unrepairable regular driver conflict', existingKey);
      }
      continue;
    }

    // The candidate loses its driver. Its times are not read, not written and
    // not compared against a free window: the vehicle's day stands.
    const other = candidate.blockId === conflict.blockA.blockId ? conflict.blockB : conflict.blockA;
    const overlapMinutes = Math.round(conflict.overlapMs / 60000);
    const kindText =
      conflict.kind === 'driver' ? 'Fahrerüberschneidung' :
      conflict.kind === 'vehicle' ? 'Fahrzeugüberschneidung' : 'Inhaberüberschneidung';

    released.add(candidate.blockId);
    releases.push({
      blockId: candidate.blockId,
      driverName: candidate.driverName,
      driverId: candidate.driverId,
      vehicle: candidate.vehicle,
      otherBlockId: other.blockId,
      otherVehicle: other.vehicle,
      overlapMs: conflict.overlapMs,
      conflictKind: conflict.kind,
      // The dictionary entry must render exactly this sentence in German. The
      // `kind` var is itself a dictionary key, which `engineText` resolves
      // first — the documented way a closed vocabulary travels inside an
      // engine message without the engine reaching the dictionaries.
      reason: `Nicht zugewiesen (${kindText}): ${candidate.driverName} · ${candidate.vehicle} und ${other.vehicle} überlappen um ${overlapMinutes} Min. Blockzeiten werden nicht verschoben; Fahrer werden am Monatsende zugewiesen.`,
      reasonKey: 'engine.repair.released.conflict',
      reasonVars: {
        kind: `engine.repair.conflictKind.${conflict.kind}`,
        driver: candidate.driverName,
        vehicleA: candidate.vehicle,
        vehicleB: other.vehicle,
        overlapMinutes,
      },
    });

    console.warn(LOG_PREFIX, 'released block from its driver', {
      blockId: candidate.blockId,
      driver: candidate.driverName,
      at: `${msToHHMM(candidate.startMs)}–${msToHHMM(candidate.endMs)}`,
      kind: conflict.kind,
    });
  }

  // ── Final validation ───────────────────────────────────────────────────────
  //
  // What survives once the released blocks are out: the conflicts a person still
  // has to answer. The regular-driver pairs above are exactly these.
  const survivors = blocks.filter(b => !released.has(b.block_id));
  const finalConflicts = detectConflicts(survivors.map(b => toEntry(b, inhaberDriverId)));

  const fahrerConflicts = finalConflicts.filter(c => c.kind === 'driver');
  const fahrzeugConflicts = finalConflicts.filter(c => c.kind === 'vehicle');
  const inhaberConflicts = finalConflicts.filter(c => c.kind === 'inhaber');

  // Duration change check. Structurally zero now — nothing writes a time — and
  // kept as the assertion that says so on every real run.
  let daueraenderungen = 0;
  for (const b of blocks) {
    const orig = b.duration_minutes * 60 * 1000;
    const cur = blockEndMs(b) - blockStartMs(b);
    if (Math.abs(cur - orig) > 60000) daueraenderungen++;
  }

  // Outside month check. A block Phase 1 built outside the planned month is
  // reported, as before; the pass can no longer put one there.
  let ausserhalb = 0;
  for (const b of blocks) {
    const bs = blockStartMs(b);
    const be = blockEndMs(b);
    if (bs < monthStartMs || be > monthEndMs + 1) ausserhalb++;
  }

  const diagnostics = {
    fahrerUeberschneidungen: fahrerConflicts.length,
    fahrzeugUeberschneidungen: fahrzeugConflicts.length,
    inhaberUeberschneidungen: inhaberConflicts.length,
    daueraenderungen,
    ausserhalb,
    pufferVerletzt: 0, // computed separately if needed
    nichtGeplant: releases.length,
    nichtReparierbar: unrepairable.length,
  };

  console.log(LOG_PREFIX, 'final diagnostics', diagnostics);
  console.log(LOG_PREFIX, 'released', releases.length, 'blocks; moved 0 (the pass moves nothing)');

  return {
    assignedBlocks: blocks,
    conflictsBefore,
    conflictsAfter: finalConflicts.length,
    movedBlocks,
    releases,
    unrepairable,
    iterations: 1,
    diagnostics,
  };
}

/**
 * The pass as the screen applies it: detect, then carry every release into the
 * `Phase3Result`.
 *
 * A released block is taken out of `assigned` and put into `unassigned` by
 * Phase 3's own `unassignBlock`, so the driver's daily and monthly minutes, the
 * validation counters and the manual summary are all rebuilt by the code that
 * owns them — this module never does that bookkeeping itself. The reason is then
 * stamped onto the resulting `UnassignedBlock` in the shape the review UI
 * already renders (`repair_reason` + `repair_reason_key` + `repair_reason_vars`,
 * read through `engineText`).
 *
 * Pure and in-memory, like every other phase: nothing is written until the
 * operator presses "Plan anwenden".
 */
export function applyRepairPass(
  result: Phase3Result,
  selectedDrivers: PlanningDriver[],
  year: number,
  month: number,
  inhaberDriverName: string,
  vehicleSwitchBufferMinutes = 30,
  inhaberDriverId = '',
): { result: Phase3Result; repair: RepairPassResult } {
  const repair = repairFinalOverlaps(
    result.assigned, year, month, inhaberDriverName, vehicleSwitchBufferMinutes, inhaberDriverId,
  );

  let next: Phase3Result = result;
  for (const release of repair.releases) {
    const afterUnassign = unassignBlock(next, selectedDrivers, release.blockId);
    // `unassignBlock` returns its input unchanged when the id is not in
    // `assigned`. Nothing to stamp then, and nothing to report twice.
    if (afterUnassign === next) continue;
    next = {
      ...afterUnassign,
      unassigned: afterUnassign.unassigned.map(b =>
        b.block_id === release.blockId
          ? {
              ...b,
              repair_attempted: true,
              repair_reason: release.reason,
              repair_reason_key: release.reasonKey,
              repair_reason_vars: release.reasonVars,
            }
          : b),
    };
  }

  return { result: next, repair };
}

/**
 * Build Inhaber free windows from the final repaired block list.
 * Returns a Map<YYYY-MM-DD, Array<{startMs, endMs, durationSec}>> for display.
 * Free windows are the gaps between Inhaber blocks within each day.
 *
 * Nothing calls this today, and it still names the owner by display name, so a
 * namesake record's blocks would count as the owner's. Whoever wires it up
 * passes the id and keys on it, as `repairFinalOverlaps` does.
 */
export function buildInhaberFreeWindows(
  assignedBlocks: AssignedBlock[],
  inhaberDriverName: string,
  year: number,
  month: number,
): Map<string, Array<{ startMs: number; endMs: number; durationSec: number }>> {
  const { monthStartMs, monthEndMs } = monthBounds(year, month);

  // Collect Inhaber busy slots per day
  const inhaberBlocks = assignedBlocks.filter(
    b => b.driver_name === inhaberDriverName && blockStartMs(b) > 0
  );

  const result = new Map<string, Array<{ startMs: number; endMs: number; durationSec: number }>>();

  // Group by the local calendar day the block starts on
  const byDate = new Map<string, Array<AssignedBlock>>();
  for (const b of inhaberBlocks) {
    const day = localDateKey(blockStartMs(b));
    const arr = byDate.get(day) ?? [];
    arr.push(b);
    byDate.set(day, arr);
  }

  // For each local day in the month, compute free windows. A day is 23, 24 or 25
  // hours long, so each boundary is the next local midnight and never a fixed
  // step: 86 400 000 ms drifts an hour at a clock change and stays off for the
  // rest of the month.
  for (let dayStart = monthStartMs; dayStart <= monthEndMs; dayStart = nextLocalMidnightMs(dayStart)) {
    const dayKey = localDateKey(dayStart);
    const dayEnd = nextLocalMidnightMs(dayStart);

    const dayBlocks = byDate.get(dayKey) ?? [];
    if (dayBlocks.length === 0) {
      // Entire day is free
      result.set(dayKey, [{ startMs: dayStart, endMs: dayEnd, durationSec: (dayEnd - dayStart) / 1000 }]);
      continue;
    }

    const busySlots = dayBlocks
      .map(b => ({ startMs: blockStartMs(b), endMs: blockEndMs(b) }))
      .filter(s => s.startMs > 0 && s.endMs > s.startMs)
      .sort((a, b) => a.startMs - b.startMs);

    const freeWindows: Array<{ startMs: number; endMs: number; durationSec: number }> = [];
    let cursor = dayStart;

    for (const busy of busySlots) {
      if (busy.startMs > cursor) {
        const winStart = cursor;
        const winEnd = Math.min(busy.startMs, dayEnd);
        if (winEnd > winStart) {
          freeWindows.push({ startMs: winStart, endMs: winEnd, durationSec: (winEnd - winStart) / 1000 });
        }
      }
      cursor = Math.max(cursor, busy.endMs);
    }

    // Trailing free window
    if (cursor < dayEnd) {
      freeWindows.push({ startMs: cursor, endMs: dayEnd, durationSec: (dayEnd - cursor) / 1000 });
    }

    result.set(dayKey, freeWindows);
  }

  return result;
}

/** Format ms as HH:mm on the local wall clock, for display. */
export function fmtRepairMs(ms: number): string {
  return msToHHMM(ms);
}
