// Monatsplanung – Final Overlap Repair Pass
// Runs after Phase 3 completes. Detects driver/vehicle overlaps in the final
// assigned block list and attempts to move Inhaber / planned blocks to clean
// free slots. Regular driver blocks are never moved automatically.
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

import type { AssignedBlock } from './monatsplanungPhase3';
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
  assignedBlocks: AssignedBlock[];
  conflictsBefore: number;
  conflictsAfter: number;
  movedBlocks: RepairMove[];
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

/** The local wall clock of an instant, in the form Phase 1 writes `block_*_datetime`. */
function msToIso(ms: number): string {
  return `${localDateKey(ms)}T${msToHHMM(ms)}`;
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

/** Choose which block in a conflict pair to move. Returns null if neither can be moved. */
function chooseCandidate(pair: ConflictPair): RepairEntry | null {
  const a = pair.blockA;
  const b = pair.blockB;

  // Regular driver vs regular driver — not moveable
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

/** Whether `b` is a block of the driver record `driverId`. An empty id owns nothing. */
function belongsToDriver(b: AssignedBlock, driverId: string): boolean {
  return driverId !== '' && (b.driver_id ?? '') === driverId;
}

/**
 * Build free windows for one driver record (or vehicle) from the current
 * index, within the month boundaries.
 */
function buildFreeWindowsForEntity(
  busySlots: Array<{ startMs: number; endMs: number }>,
  monthStartMs: number,
  monthEndMs: number,
): Array<{ startMs: number; endMs: number }> {
  // Sort by start
  const sorted = [...busySlots]
    .filter(s => s.startMs > 0 && s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  // Merge overlapping busy slots
  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const slot of sorted) {
    if (merged.length === 0) {
      merged.push({ ...slot });
    } else {
      const last = merged[merged.length - 1];
      if (slot.startMs <= last.endMs) {
        last.endMs = Math.max(last.endMs, slot.endMs);
      } else {
        merged.push({ ...slot });
      }
    }
  }

  // Gaps are free windows
  const free: Array<{ startMs: number; endMs: number }> = [];
  let cursor = monthStartMs;
  for (const busy of merged) {
    if (busy.startMs > cursor && busy.startMs > monthStartMs) {
      const winStart = Math.max(cursor, monthStartMs);
      const winEnd = Math.min(busy.startMs, monthEndMs + 1);
      if (winEnd > winStart) free.push({ startMs: winStart, endMs: winEnd });
    }
    cursor = Math.max(cursor, busy.endMs);
  }
  // Trailing free window
  if (cursor < monthEndMs + 1) {
    free.push({ startMs: cursor, endMs: monthEndMs + 1 });
  }

  return free;
}

/**
 * Main repair pass. Takes the Phase 3 `assigned` array plus month/year and
 * the Inhaber driver. Returns a new assigned array with conflicts resolved
 * where possible, plus a full diagnostic report.
 *
 * `inhaberDriverId` identifies the owner; `inhaberDriverName` is only logged.
 * Without an id no block is the owner's by identity.
 */
export function repairFinalOverlaps(
  assigned: AssignedBlock[],
  year: number,
  month: number,
  inhaberDriverName: string,
  vehicleSwitchBufferMinutes = 30,
  inhaberDriverId = '',
): RepairPassResult {
  const MAX_ITERATIONS = 200;
  const MIN_BUFFER_MIN = 30;
  const { monthStartMs, monthEndMs } = monthBounds(year, month);

  // Work on a mutable copy
  let blocks: AssignedBlock[] = assigned.map(b => ({ ...b }));

  const movedBlocks: RepairMove[] = [];
  const unrepairable: UnrepairableBlock[] = [];
  let iterations = 0;

  // Track durations at entry to detect accidental changes
  const originalDurationMs = new Map<string, number>(
    blocks.map(b => [b.block_id, b.duration_minutes * 60 * 1000])
  );

  console.log(LOG_PREFIX, 'start', {
    totalBlocks: blocks.length,
    year,
    month,
    inhaberDriverName,
    vehicleSwitchBufferMinutes,
  });

  // ── Main repair loop ───────────────────────────────────────────────────────
  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const entries = blocks.map(b => toEntry(b, inhaberDriverId));
    const conflicts = detectConflicts(entries);

    console.log(LOG_PREFIX, `iteration ${iterations}: ${conflicts.length} conflicts`);

    if (conflicts.length === 0) break;

    let anyRepaired = false;

    for (const conflict of conflicts) {
      const candidate = chooseCandidate(conflict);
      if (!candidate) {
        // Both regular drivers — mark as unrepairable if not already
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

      // Build current busy slots for driver and vehicle of candidate
      const driverBusy = blocks
        .filter(b => b.block_id !== candidate.blockId && belongsToDriver(b, candidate.driverId))
        .map(b => ({ startMs: blockStartMs(b), endMs: blockEndMs(b) }));
      const vehicleBusy = blocks
        .filter(b => b.block_id !== candidate.blockId && b.vehicle_identifier === candidate.vehicle)
        .map(b => ({ startMs: blockStartMs(b), endMs: blockEndMs(b) }));

      const driverFree = buildFreeWindowsForEntity(driverBusy, monthStartMs, monthEndMs + 1);
      const vehicleFree = buildFreeWindowsForEntity(vehicleBusy, monthStartMs, monthEndMs + 1);

      // Find intersection of free windows
      const sharedFree: Array<{ startMs: number; endMs: number }> = [];
      for (const df of driverFree) {
        for (const vf of vehicleFree) {
          const start = Math.max(df.startMs, vf.startMs);
          const end = Math.min(df.endMs, vf.endMs);
          if (end > start) sharedFree.push({ startMs: start, endMs: end });
        }
      }
      // Sort by largest window first, then earliest
      sharedFree.sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs) || a.startMs - b.startMs);

      const durationMs = candidate.durationMs;
      let placed = false;
      let freeDriverWindowsChecked = driverFree.length;
      let freeVehicleWindowsChecked = vehicleFree.length;
      let sharedWindowsChecked = 0;

      for (const win of sharedFree) {
        sharedWindowsChecked++;
        if (win.endMs - win.startMs < durationMs) continue;

        // Scan minute-by-minute within the window
        const stepMs = 60 * 1000;
        const scanEnd = win.endMs - durationMs;

        for (let tryStart = win.startMs; tryStart <= scanEnd; tryStart += stepMs) {
          const tryEnd = tryStart + durationMs;

          // Month boundary check
          if (tryStart < monthStartMs || tryEnd > monthEndMs + 1) continue;

          // Exact overlap check with all OTHER blocks
          const driverOk = !blocks.some(b => {
            if (b.block_id === candidate.blockId) return false;
            if (!belongsToDriver(b, candidate.driverId)) return false;
            const bs = blockStartMs(b);
            const be = blockEndMs(b);
            return tryStart < be && tryEnd > bs;
          });
          if (!driverOk) continue;

          const vehicleOk = !blocks.some(b => {
            if (b.block_id === candidate.blockId) return false;
            if (b.vehicle_identifier !== candidate.vehicle) return false;
            const bs = blockStartMs(b);
            const be = blockEndMs(b);
            return tryStart < be && tryEnd > bs;
          });
          if (!vehicleOk) continue;

          // Vehicle switch buffer check for Inhaber
          if (candidate.isInhaber) {
            let bufferOk = true;
            let bufferToUse = vehicleSwitchBufferMinutes;
            const candidateVehicle = candidate.vehicle;

            // Find adjacent blocks for this driver
            const driverBlocks = blocks
              .filter(b => b.block_id !== candidate.blockId && belongsToDriver(b, candidate.driverId))
              .map(b => ({ startMs: blockStartMs(b), endMs: blockEndMs(b), vehicle: b.vehicle_identifier }))
              .sort((a, b) => a.startMs - b.startMs);

            for (const adj of driverBlocks) {
              const isSameVehicle = adj.vehicle === candidateVehicle;
              if (isSameVehicle) continue; // No buffer needed for same vehicle

              const gapBefore = tryStart - adj.endMs;
              const gapAfter = adj.startMs - tryEnd;

              const minBuffer = MIN_BUFFER_MIN * 60 * 1000;
              const maxBuffer = bufferToUse * 60 * 1000;

              if (gapBefore > 0 && gapBefore < minBuffer) { bufferOk = false; break; }
              if (gapAfter > 0 && gapAfter < minBuffer) { bufferOk = false; break; }
              void maxBuffer; // used conceptually above
            }
            if (!bufferOk) continue;
          }

          // Found valid slot — move the block
          const oldStartMs = candidate.startMs;
          const oldEndMs = candidate.endMs;

          blocks = blocks.map(b => {
            if (b.block_id !== candidate.blockId) return b;
            const newStartIso = msToIso(tryStart);
            const newEndIso = msToIso(tryEnd);
            return {
              ...b,
              block_start_datetime: newStartIso,
              block_end_datetime: newEndIso,
              service_date: newStartIso.slice(0, 10),
              actual_start_ms: tryStart,
              actual_end_ms: tryEnd,
              repair_moved: true,
            };
          });

          movedBlocks.push({
            blockId: candidate.blockId,
            vehicle: candidate.vehicle,
            driverName: candidate.driverName,
            oldStartMs,
            oldEndMs,
            newStartMs: tryStart,
            newEndMs: tryEnd,
            reason: conflict.kind === 'driver' ? 'Fahrerüberschneidung' :
                    conflict.kind === 'vehicle' ? 'Fahrzeugüberschneidung' : 'Inhaberüberschneidung',
            reasonKey: `engine.repair.conflictKind.${conflict.kind}`,
            bufferUsedMin: vehicleSwitchBufferMinutes,
          });

          console.log(LOG_PREFIX, 'moved block', {
            blockId: candidate.blockId,
            from: `${msToHHMM(oldStartMs)}–${msToHHMM(oldEndMs)}`,
            to: `${msToHHMM(tryStart)}–${msToHHMM(tryEnd)}`,
            reason: conflict.kind,
          });

          placed = true;
          anyRepaired = true;
          break;
        }
        if (placed) break;
      }

      if (!placed) {
        const alreadyUnrep = unrepairable.some(u => u.blockId === candidate.blockId);
        if (!alreadyUnrep) {
          const noSharedWindow = sharedFree.length === 0;
          const reason =
            noSharedWindow
              ? 'Kein freies Zeitfenster gefunden, das für Fahrer und Fahrzeug gleichzeitig frei ist'
              : `${sharedWindowsChecked} gemeinsame Zeitfenster geprüft – keines war groß genug oder hatte ausreichend Puffer`;
          unrepairable.push({
            blockId: candidate.blockId,
            driverName: candidate.driverName,
            vehicle: candidate.vehicle,
            durationMs,
            conflictKind: conflict.kind,
            conflictKindKey: `engine.repair.conflictKind.${conflict.kind}`,
            freeDriverWindowsChecked,
            freeVehicleWindowsChecked,
            sharedWindowsChecked,
            reason,
            reasonKey: noSharedWindow
              ? 'engine.repair.unrepairable.noSharedWindow'
              : 'engine.repair.unrepairable.noWindowBigEnough',
            reasonVars: { windows: sharedWindowsChecked },
          });
          console.warn(LOG_PREFIX, 'unrepairable', candidate.blockId, reason);
        }
      }
    }

    if (!anyRepaired) break;
  }

  // ── Final validation ───────────────────────────────────────────────────────
  const finalEntries = blocks.map(b => toEntry(b, inhaberDriverId));
  const finalConflicts = detectConflicts(finalEntries);

  const fahrerConflicts = finalConflicts.filter(c => c.kind === 'driver');
  const fahrzeugConflicts = finalConflicts.filter(c => c.kind === 'vehicle');
  const inhaberConflicts = finalConflicts.filter(c => c.kind === 'inhaber');

  // Duration change check
  let daueraenderungen = 0;
  for (const b of blocks) {
    const orig = originalDurationMs.get(b.block_id);
    if (orig == null) continue;
    const cur = blockEndMs(b) - blockStartMs(b);
    if (Math.abs(cur - orig) > 60000) daueraenderungen++;
  }

  // Outside month check
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
    nichtGeplant: 0,
    nichtReparierbar: unrepairable.length,
  };

  console.log(LOG_PREFIX, 'final diagnostics', diagnostics);
  console.log(LOG_PREFIX, 'moved', movedBlocks.length, 'blocks in', iterations, 'iterations');

  return {
    assignedBlocks: blocks,
    conflictsBefore: movedBlocks.length + finalConflicts.length,
    conflictsAfter: finalConflicts.length,
    movedBlocks,
    unrepairable,
    iterations,
    diagnostics,
  };
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
