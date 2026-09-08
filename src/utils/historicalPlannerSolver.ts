import type { FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
import {
  normalizeTripServiceDate,
  groupRidesIntoBlocks,
  mergeBlocksIfNeeded,
  timeToMinutes,
} from './shiftBlockEngine';
import { MIN_VEHICLE_SWITCH_BUFFER_MINUTES } from './carBlockResolver';

// ── Solver budget constants ───────────────────────────────────────────────────
const MAX_SOLVER_MS = 12000;          // hard wall: stop solver after 12 s
const MAX_MAIN_ITERATIONS = 8000;     // outer while-loop restarts
const MAX_CANDIDATE_ATTEMPTS = 25000; // total candidate block attempts
const MAX_SWAP_ATTEMPTS_HARD = 4000;  // total swap transactions
const MAX_GRANULAR_ATTEMPTS = 40000;  // total granular trip transfer tries
const MAX_REJECTED_DIAGNOSTICS = 500; // cap on rejectedCandidates array
const YIELD_EVERY_MS = 8;             // yield to browser every N ms of CPU work

// ── SolverController ──────────────────────────────────────────────────────────
export interface SolverProgress {
  phase: string;
  candidatesTried: number;
  swapAttempts: number;
  granularAttempts: number;
  limitReached: boolean;
  cancelled: boolean;
  diagnosticsTruncated: number;
}

export interface SolverController {
  /** Call this to signal cancellation from outside */
  cancel: () => void;
  /** Internal: returns true when the solver should stop immediately */
  shouldStop: () => boolean;
  /** Internal: update progress for UI callbacks */
  reportProgress: (p: Partial<SolverProgress>) => void;
  /** Internal: periodic yield so browser stays responsive */
  yield: () => Promise<void>;
  readonly cancelled: boolean;
  readonly limitReached: boolean;
  readonly startMs: number;
  budget: {
    mainIterations: number;
    candidateAttempts: number;
    swapAttempts: number;
    granularAttempts: number;
  };
}

export function createSolverController(
  onProgress?: (p: SolverProgress) => void,
): SolverController {
  let _cancelled = false;
  let _limitReached = false;
  let _lastYieldMs = performance.now();
  const _startMs = performance.now();
  const _progress: SolverProgress = {
    phase: 'Initialisierung',
    candidatesTried: 0,
    swapAttempts: 0,
    granularAttempts: 0,
    limitReached: false,
    cancelled: false,
    diagnosticsTruncated: 0,
  };

  const ctrl: SolverController = {
    cancel() { _cancelled = true; _progress.cancelled = true; },
    shouldStop() {
      if (_cancelled) return true;
      if (_limitReached) return true;
      const elapsed = performance.now() - _startMs;
      if (elapsed > MAX_SOLVER_MS) { _limitReached = true; _progress.limitReached = true; return true; }
      return false;
    },
    reportProgress(p) {
      Object.assign(_progress, p);
      onProgress?.({ ..._progress });
    },
    async yield() {
      const now = performance.now();
      if (now - _lastYieldMs >= YIELD_EVERY_MS) {
        _lastYieldMs = now;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    },
    get cancelled() { return _cancelled; },
    get limitReached() { return _limitReached; },
    get startMs() { return _startMs; },
    budget: {
      mainIterations: MAX_MAIN_ITERATIONS,
      candidateAttempts: MAX_CANDIDATE_ATTEMPTS,
      swapAttempts: MAX_SWAP_ATTEMPTS_HARD,
      granularAttempts: MAX_GRANULAR_ATTEMPTS,
    },
  };
  return ctrl;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface CandidateBlock {
  id: string;
  tripIds: string[];          // original trip IDs (not segment IDs)
  date: string;               // YYYY-MM-DD service date
  startMin: number;
  endMin: number;
  vehicleId: string | null;
  vehicleKennzeichen: string | null;
  originalDriverId: string | null;   // resolved source driver (never the owner when ownerExcluded=true)
  originalDriverName: string;
  sourceDriverId: string | null;     // raw Fahrtenbuch driver before any override (always original_driver_id)
  sourceDriverName: string;
  ownerOriginalConflict: boolean;    // true when owner was the only available source and exclusion is ON
  workSec: number;            // Lohnart 1000 — total shift seconds
  nightSec: number;           // Lohnart 1501 — 20:00–06:00 overlap seconds
  sunSec: number;             // Lohnart 1510 — Sunday seconds (non-holiday)
  holSec: number;             // Lohnart 1520 — holiday seconds
  // Vehicle analysis (populated by computeBlockVehicleCounts)
  activeVehicleCount?: number;
  isEinzelwagenZeit?: boolean;
}

export interface AssignedBlock extends CandidateBlock {
  assignedDriverId: string;
  assignedDriverName: string;
  role: 'payroll' | 'owner';
  // Granular retry metadata — undefined for first-pass Schichtblock assignments
  originalBlockId?: string;
  granularity: 'Schichtblock' | 'Einzelfahrt' | 'Sub-Block';
  isSplit: boolean;
  entlastungsGrund?: string;
  // Owner assignment priority (populated for owner-role blocks in relief solver)
  ownerAssignmentPriority?: 'critical_over_target_relief' | 'einzelwagen_optional_relief' | 'normal_optional_relief';
}

export interface DriverTargetSeconds {
  driverId: string;
  driverName: string;
  personalnummer: string;
  workSec: number;
  nightSec: number;
  sunSec: number;
  holSec: number;
}

export interface PlanningConflict {
  type: 'driver_overlap' | 'vehicle_overlap' | 'vehicle_switch' | 'unassigned';
  description: string;
  date?: string;
  blockId?: string;
  kennzeichen?: string;
  originalDriverName?: string;
  reason?: string;
}

export interface PlanningDeviation {
  driverId: string;
  driverName: string;
  personalnummer: string;
  wageCode: string;
  wageLabel: string;
  targetSec: number;
  actualSec: number;
  diffSec: number;
}

/** A transparent payroll correction line — never becomes a Fahrt */
export interface CorrectionLine {
  driverId: string;
  driverName: string;
  personalnummer: string;
  wageCode: string;
  wageLabel: string;
  targetSec: number;
  planActualSec: number;
  correctionSec: number;       // targetSec - planActualSec (positive = add, negative = subtract)
  correctedActualSec: number;  // planActualSec + correctionSec === targetSec exactly
  reason: string;
}

/**
 * Compute transparent correction lines from a planning result and the original targets.
 * Corrections are purely payroll adjustments — they never affect Fahrtenbuch.
 * Only emits POSITIVE corrections (driver is under target).
 * Negative cases (driver over target) are handled separately as Konflikte.
 */
export function computeCorrections(
  deviations: PlanningDeviation[],
): CorrectionLine[] {
  const lines: CorrectionLine[] = [];
  for (const d of deviations) {
    if (d.diffSec === 0) continue;
    const correctionSec = d.targetSec - d.actualSec;
    if (correctionSec <= 0) continue; // over target — not correctable via payroll addition
    lines.push({
      driverId:           d.driverId,
      driverName:         d.driverName,
      personalnummer:     d.personalnummer,
      wageCode:           d.wageCode,
      wageLabel:          d.wageLabel,
      targetSec:          d.targetSec,
      planActualSec:      d.actualSec,
      correctionSec,
      correctedActualSec: d.actualSec + correctionSec,
      reason:             'Korrektur laut übermittelter Steuerberater-Werte',
    });
  }
  return lines;
}

export interface PlanningResult {
  assignments: AssignedBlock[];
  unassigned: CandidateBlock[];
  conflicts: PlanningConflict[];
  driverActuals: Map<string, { workSec: number; nightSec: number; sunSec: number; holSec: number }>;
  deviations: PlanningDeviation[];
  isExact: boolean;
  isFinalizable: boolean;
  // Block counts — clearly separated
  totalBlocks: number;              // original Schichtblöcke (before any granular splitting)
  finalAssignmentUnits: number;     // total entries in assignmentMap (incl. granular splits)
  granularEinzelfahrten: number;    // Einzelfahrt-granularity units in assignmentMap
  payrollAssigned: number;
  ownerAssigned: number;
  unassignedCount: number;
  vehicleOverlapCount: number;
  driverOverlapCount: number;
  vehicleSwitchCount: number;
  // Granular retry stats (only populated when correctionMode was true and retry ran)
  granularRetryUsed: boolean;
  unassignedBeforeRetry: number;
  granularAssignedCount: number;
  splitBlockCount: number;
  // Owner relief stats (only populated when runOwnerReliefSolver was used)
  einzelwagenZeitenTotal: number;
  einzelwagenZeitenToOwner: number;
  reliefPassTotal: number;
  reliefCandidatesTried: number;       // Schichtblock candidates tried in relief pass
  reliefGranularTransfers: number;     // Einzelfahrt transfers made in granular fallback
  swapAttemptsTotal: number;           // swap attempts made
  swapAcceptedTotal: number;           // swaps that improved the objective and were accepted
  unresolvedOverTargetCount: number;   // blocks that could not be transferred after all attempts
  driversOverTarget: string[];
  negativeCorrectionsRequired: number;
  ownerOriginalCount: number;          // blocks where owner was sole source (conflict when ownerExcluded=true)
  // Mutually exclusive owner assignment breakdown
  ownerCriticalReliefCount: number;
  ownerOptionalEinzelwagenCount: number;
  ownerBaselineCount: number;
  rejectedCandidates: RejectedCandidate[];
  ownerCapacityEntries: OwnerCapacityEntry[];
  // Budget / abort info
  solverLimitReached: boolean;
  solverCancelled: boolean;
  solverElapsedMs: number;
  solverGranularAttempts: number;
  diagnosticsTruncated: number;
}

/** Diagnostic entry for a transfer candidate that could not be moved to the owner */
export interface RejectedCandidate {
  driverName: string;
  overTargetWageCode: string;
  overTargetWageLabel: string;
  overageSec: number;
  blockId: string;
  date: string;
  startMin: number;
  endMin: number;
  kennzeichen: string | null;
  contributionSec: number;       // contribution to the over-target Lohnart
  triedAsSchichtblock: boolean;
  triedAsEinzelfahrt: boolean;
  swapAttempted: boolean;
  swapAccepted: boolean;
  swapReason: string;
  conflictingOwnerUnits: string[];  // IDs of owner blocks that were blocking this candidate
  rejectionReason: string;
  ownerConflictReason: string;
}

/** Diagnostic entry for an owner-assigned block (for Inhaber-Kapazität sheet) */
export interface OwnerCapacityEntry {
  blockId: string;
  date: string;
  startMin: number;
  endMin: number;
  kennzeichen: string | null;
  entlastungsGrund: string;
  priority: 'critical_over_target_relief' | 'einzelwagen_optional_relief' | 'normal_optional_relief';
  conflictingOverTargetCandidateId: string | null;
  swapAttempted: boolean;
  swapAccepted: boolean;
  swapReason: string;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

// Same window as GenerateStundennachweisModal (20:00–06:00)
function nightMinsForSeg(from: string, to: string): number {
  if (!from || !to) return 0;
  const f = timeToMinutes(from), t = timeToMinutes(to);
  const absTo = t >= f ? t : t + 1440;
  const seg1 = Math.max(0, Math.min(absTo, 24 * 60) - Math.max(f, 20 * 60));
  const seg2 = Math.max(0, Math.min(absTo, 30 * 60) - Math.max(f, 24 * 60));
  return seg1 + seg2;
}

function segDuration(from: string, to: string): number {
  if (!from || !to) return 0;
  const f = timeToMinutes(from), t = timeToMinutes(to);
  return t >= f ? t - f : 1440 - f + t;
}

function minsToTimeStr(m: number): string {
  const clamped = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(clamped / 60);
  const min = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function overlaps(a: { startMin: number; endMin: number }, b: { startMin: number; endMin: number }): boolean {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

// ── Build candidate blocks ────────────────────────────────────────────────────

/**
 * Build candidate blocks from all trips for the historical month.
 * Groups trips by (effective driver, serviceDate) and applies the same shift-block pipeline
 * as GenerateStundennachweisModal.
 *
 * When ownerDriverId is provided and excludeOwnerAsSource=true:
 *   - Blocks whose assigned_driver_id equals the owner fall back to original_driver_id.
 *   - If original_driver_id is also the owner (or missing), the block is flagged as
 *     ownerOriginalConflict=true and originalDriverId is set to null.
 */
export function buildCandidateBlocks(
  trips: FahrtenbuchTrip[],
  holidays: Set<string>,
  ownerDriverId?: string | null,
  excludeOwnerAsSource = false,
): CandidateBlock[] {
  // Normalize trips (cross-midnight splitting, actual-start-date detection)
  const normalized = trips.flatMap(t => normalizeTripServiceDate(t));

  // Group by (effectiveDriverId, serviceDate)
  type SegEntry = { driverId: string | null; driverName: string; sourceDriverId: string | null; sourceDriverName: string; ownerConflict: boolean; segs: typeof normalized };
  const grouped = new Map<string, SegEntry>();
  for (const seg of normalized) {
    // Raw source driver (always from original_driver_id — the Fahrtenbuch import field)
    const srcId = seg.original.original_driver_id ?? null;
    const srcName = seg.original.original_driver_name || 'Unbekannt';

    // Effective assigned driver (may have been overridden by a previous solver run)
    const assignedId = seg.original.assigned_driver_id || null;
    const assignedName = seg.original.assigned_driver_name || '';

    let effectiveId: string | null;
    let effectiveName: string;
    let ownerConflict = false;

    if (excludeOwnerAsSource && ownerDriverId) {
      // When owner exclusion is ON: use original_driver_id as the authoritative source.
      // If the trip's only known driver is the owner, flag as ownerOriginalConflict.
      if (srcId && srcId !== ownerDriverId) {
        effectiveId = srcId;
        effectiveName = srcName;
      } else if (assignedId && assignedId !== ownerDriverId) {
        // assigned_driver_id is non-owner — use it as fallback source
        effectiveId = assignedId;
        effectiveName = assignedName;
      } else {
        // Only owner known — this is the conflict case
        effectiveId = null;
        effectiveName = srcName || assignedName || 'Unbekannt';
        ownerConflict = true;
      }
    } else {
      // Normal mode: assigned_driver_id takes priority
      effectiveId = assignedId || srcId || null;
      effectiveName = (assignedId ? assignedName : '') || srcName || 'Unbekannt';
    }

    const groupKey = `${effectiveId ?? '__conflict__'}|${seg.serviceDate}`;
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, { driverId: effectiveId, driverName: effectiveName, sourceDriverId: srcId, sourceDriverName: srcName, ownerConflict, segs: [] });
    }
    grouped.get(groupKey)!.segs.push(seg);
  }

  const blocks: CandidateBlock[] = [];
  let counter = 0;

  for (const [, entry] of grouped) {
    const { driverId, driverName, sourceDriverId, sourceDriverName, ownerConflict, segs } = entry;
    if (segs.length === 0) continue;

    const dateStr = segs[0].serviceDate;
    const dateObj = new Date(dateStr + 'T12:00:00');
    const isSun = dateObj.getDay() === 0;
    const isHol = holidays.has(dateStr);

    const sorted = [...segs].sort((a, b) => a.startMinutes - b.startMinutes);
    // Use a stable grouping key for shift-block engine
    const groupDriverId = driverId ?? sourceDriverId ?? 'conflict';
    const rawBlocks = groupRidesIntoBlocks(sorted, groupDriverId, dateStr);
    const { merged } = mergeBlocksIfNeeded(rawBlocks);

    for (const b of merged) {
      const von = minsToTimeStr(b.startMin);
      const bis = minsToTimeStr(b.endMin);
      const dur = segDuration(von, bis);
      const nightMins = nightMinsForSeg(von, bis);

      // Resolve original trip IDs from segment IDs
      const segsInBlock = b.tripIds
        .map(sid => segs.find(s => s.id === sid))
        .filter(Boolean);
      const originalTripIds = [...new Set(segsInBlock.map(s => s!.original.id))];

      // Pick vehicle from first trip that has one
      const vehicleTrip = segsInBlock.find(s => s!.original.car_id);
      const vehicleId = vehicleTrip?.original.car_id ?? null;
      const vehicleKennzeichen = vehicleTrip?.original.car_identifier ?? null;

      blocks.push({
        id: `blk_${counter++}`,
        tripIds: originalTripIds,
        date: dateStr,
        startMin: b.startMin,
        endMin: b.endMin,
        vehicleId,
        vehicleKennzeichen,
        originalDriverId: driverId,
        originalDriverName: driverName,
        sourceDriverId: sourceDriverId ?? driverId,
        sourceDriverName: sourceDriverName || driverName,
        ownerOriginalConflict: ownerConflict,
        workSec: dur * 60,
        nightSec: nightMins * 60,
        sunSec: (isSun && !isHol) ? dur * 60 : 0,
        holSec: isHol ? dur * 60 : 0,
      });
    }
  }

  return blocks;
}

// ── Greedy solver ─────────────────────────────────────────────────────────────

const WAGE_LABELS: Record<string, string> = {
  '1000': 'Stundenlohn',
  '1501': 'Nachtzuschlag, 40% frei',
  '1510': 'Sonntagszuschlag, 50% frei',
  '1520': 'Feiertagszuschlag, 125% frei',
};

/**
 * Deterministic greedy solver.
 *
 * Hard constraints enforced for ALL drivers (including owner):
 *   - No driver time overlap
 *   - No vehicle time overlap (vehicle used by any other driver at same time)
 *   - No vehicle switch buffer violation (< MIN_VEHICLE_SWITCH_BUFFER_MINUTES gap with different vehicle)
 *
 * Owner is exempt from budget/hour limits only.
 *
 * When correctionMode is true, payroll drivers are also exempt from budget ceilings —
 * every block is assigned to any safe driver; remaining deviations are handled by correction lines.
 *
 * When correctionMode is true and allTrips is provided, a granular retry second pass runs:
 * unassigned Schichtblöcke are split into their individual Fahrten (Einzelfahrten) and each
 * is retried independently, reusing the same safety constraint state.
 */
export function runGreedySolver(
  blocks: CandidateBlock[],
  targets: DriverTargetSeconds[],
  ownerDriverId: string | null,
  ownerDriverName: string,
  correctionMode = false,
  allTrips?: FahrtenbuchTrip[],
): PlanningResult {
  // Priority: Feiertag (3) > Sonntag (2) > Nacht (1) > normal (0)
  // Within same priority: larger workSec first (greedy fill)
  const blockPriority = (b: CandidateBlock): number =>
    b.holSec > 0 ? 3 : b.sunSec > 0 ? 2 : b.nightSec > 0 ? 1 : 0;

  const sorted = [...blocks].sort((a, b) => {
    const pd = blockPriority(b) - blockPriority(a);
    return pd !== 0 ? pd : b.workSec - a.workSec;
  });

  // Remaining budgets per payroll driver (mutable, in seconds)
  const budgets = new Map<string, { workSec: number; nightSec: number; sunSec: number; holSec: number }>(
    targets.map(t => [t.driverId, { workSec: t.workSec, nightSec: t.nightSec, sunSec: t.sunSec, holSec: t.holSec }]),
  );

  // Track assignments per driver for overlap/switch checks
  const assignedByDriver = new Map<string, AssignedBlock[]>();
  // Global vehicle occupancy: vehicleId|date -> AssignedBlock[]
  const vehicleOccupancy = new Map<string, AssignedBlock[]>();
  const allAssigned: AssignedBlock[] = [];
  const unassigned: CandidateBlock[] = [];

  function getVehicleKey(vehicleId: string, date: string) {
    return `${vehicleId}|${date}`;
  }

  function canAssignToDriver(
    blk: CandidateBlock,
    driverId: string,
    budget: { workSec: number; nightSec: number; sunSec: number; holSec: number } | null,
  ): { ok: boolean; reason?: string } {
    // Budget check (null budget = owner or correctionMode, no limit)
    if (budget !== null && !correctionMode) {
      if (blk.workSec > budget.workSec) return { ok: false, reason: 'Lohnart 1000 Budget überschritten' };
      if (blk.nightSec > budget.nightSec) return { ok: false, reason: 'Lohnart 1501 Budget überschritten' };
      if (blk.sunSec > budget.sunSec) return { ok: false, reason: 'Lohnart 1510 Budget überschritten' };
      if (blk.holSec > budget.holSec) return { ok: false, reason: 'Lohnart 1520 Budget überschritten' };
    }

    const existing = assignedByDriver.get(driverId) ?? [];
    const sameDate = existing.filter(e => e.date === blk.date);

    // Driver time overlap check
    if (sameDate.some(e => overlaps(e, blk))) {
      return { ok: false, reason: 'Fahrer-Überschneidung' };
    }

    // Vehicle switch buffer check for this driver's consecutive blocks
    if (blk.vehicleId) {
      for (const e of sameDate) {
        if (e.vehicleId && e.vehicleId !== blk.vehicleId) {
          const gap = Math.max(blk.startMin - e.endMin, e.startMin - blk.endMin);
          if (gap >= 0 && gap < MIN_VEHICLE_SWITCH_BUFFER_MINUTES) {
            return { ok: false, reason: `Fahrzeugwechsel-Puffer zu kurz (${gap} Min.)` };
          }
        }
      }
    }

    // Global vehicle occupancy check — prevents vehicle from being driven by 2 drivers simultaneously
    if (blk.vehicleId) {
      const vKey = getVehicleKey(blk.vehicleId, blk.date);
      const vOccupied = vehicleOccupancy.get(vKey) ?? [];
      for (const occ of vOccupied) {
        if (occ.assignedDriverId !== driverId && overlaps(occ, blk)) {
          return {
            ok: false,
            reason: `Fahrzeug ${blk.vehicleKennzeichen ?? blk.vehicleId} zur gleichen Zeit bereits von ${occ.assignedDriverName} belegt`,
          };
        }
      }
    }

    return { ok: true };
  }

  function doAssign(
    blk: CandidateBlock,
    driverId: string,
    driverName: string,
    role: 'payroll' | 'owner',
    granularity: 'Schichtblock' | 'Einzelfahrt' | 'Sub-Block' = 'Schichtblock',
    originalBlockId?: string,
  ) {
    const ab: AssignedBlock = {
      ...blk,
      assignedDriverId: driverId,
      assignedDriverName: driverName,
      role,
      granularity,
      isSplit: granularity !== 'Schichtblock',
      originalBlockId,
    };

    if (!assignedByDriver.has(driverId)) assignedByDriver.set(driverId, []);
    assignedByDriver.get(driverId)!.push(ab);

    if (blk.vehicleId) {
      const vKey = getVehicleKey(blk.vehicleId, blk.date);
      if (!vehicleOccupancy.has(vKey)) vehicleOccupancy.set(vKey, []);
      vehicleOccupancy.get(vKey)!.push(ab);
    }

    allAssigned.push(ab);

    if (role === 'payroll') {
      const budget = budgets.get(driverId)!;
      budget.workSec -= blk.workSec;
      budget.nightSec -= blk.nightSec;
      budget.sunSec -= blk.sunSec;
      budget.holSec -= blk.holSec;
    }
  }

  for (const blk of sorted) {
    let assigned = false;

    // In correction mode: try owner first (absorb as many real blocks as possible),
    // then fall back to payroll drivers (corrections will reconcile Lohnart deviations).
    // In normal mode: try payroll drivers first, owner as last resort.
    if (correctionMode && ownerDriverId) {
      const check = canAssignToDriver(blk, ownerDriverId, null);
      if (check.ok) {
        doAssign(blk, ownerDriverId, ownerDriverName, 'owner');
        assigned = true;
      }
    }

    if (!assigned) {
      // Try payroll drivers — sort by most compatible budget for this block type
      const priority = blockPriority(blk);
      const sortedTargets = [...targets].sort((a, b) => {
        const ba = budgets.get(a.driverId)!;
        const bb = budgets.get(b.driverId)!;
        if (priority === 3) return ba.holSec - bb.holSec;
        if (priority === 2) return ba.sunSec - bb.sunSec;
        if (priority === 1) return ba.nightSec - bb.nightSec;
        return ba.workSec - bb.workSec;
      });

      for (const t of sortedTargets) {
        const budget = budgets.get(t.driverId)!;
        const check = canAssignToDriver(blk, t.driverId, budget);
        if (check.ok) {
          doAssign(blk, t.driverId, t.driverName, 'payroll');
          assigned = true;
          break;
        }
      }
    }

    // Normal mode: try owner after payroll drivers
    if (!assigned && !correctionMode && ownerDriverId) {
      const check = canAssignToDriver(blk, ownerDriverId, null);
      if (check.ok) {
        doAssign(blk, ownerDriverId, ownerDriverName, 'owner');
        assigned = true;
      }
    }

    if (!assigned) {
      unassigned.push(blk);
    }
  }

  // ── Granular retry second pass (correction mode only) ────────────────────────
  // For each unassigned Schichtblock, split into individual Fahrt-level units and retry.
  // Reuses the same assignedByDriver / vehicleOccupancy state so hard constraints remain sound.

  let granularRetryUsed = false;
  let unassignedBeforeRetry = 0;
  let granularAssignedCount = 0;
  let splitBlockCount = 0;

  if (correctionMode && allTrips && allTrips.length > 0 && unassigned.length > 0) {
    granularRetryUsed = true;
    unassignedBeforeRetry = unassigned.length;

    // Build a fast lookup: tripId → FahrtenbuchTrip
    const tripById = new Map<string, FahrtenbuchTrip>(allTrips.map(t => [t.id, t]));

    // Track which tripIds have been assigned in the first pass (to prevent duplication)
    const assignedTripIds = new Set<string>(allAssigned.flatMap(ab => ab.tripIds));

    // For each unassigned block, build Einzelfahrt-level candidate blocks
    const stillUnassigned: CandidateBlock[] = [];

    for (const ublk of unassigned) {
      // Gather the trips that make up this block
      const blockTrips = ublk.tripIds
        .map(id => tripById.get(id))
        .filter((t): t is FahrtenbuchTrip => !!t && !t.is_canceled && !assignedTripIds.has(t.id));

      if (blockTrips.length === 0) {
        // No recoverable trips — keep as unassigned
        stillUnassigned.push(ublk);
        continue;
      }

      // Build one CandidateBlock per normalized segment of each trip
      const granularUnits: CandidateBlock[] = [];
      let unitCounter = 0;
      for (const trip of blockTrips) {
        const segs = normalizeTripServiceDate(trip);
        for (const seg of segs) {
          const von = minsToTimeStr(seg.startMinutes);
          const bis = minsToTimeStr(seg.endMinutes);
          const dur = segDuration(von, bis);
          if (dur <= 0) continue;
          const nightMins = nightMinsForSeg(von, bis);
          const dateObj = new Date(seg.serviceDate + 'T12:00:00');
          const isSun = dateObj.getDay() === 0;
          // Use the parent block's holiday classification as approximation for the date
          const isHol = ublk.holSec > 0 && seg.serviceDate === ublk.date;
          granularUnits.push({
            id: `${ublk.id}_g${unitCounter++}`,
            tripIds: [trip.id],
            date: seg.serviceDate,
            startMin: seg.startMinutes,
            endMin: seg.endMinutes,
            vehicleId: trip.car_id ?? null,
            vehicleKennzeichen: trip.car_identifier ?? null,
            originalDriverId: trip.assigned_driver_id ?? trip.original_driver_id ?? null,
            originalDriverName: trip.assigned_driver_name || trip.original_driver_name || 'Unbekannt',
            workSec: dur * 60,
            nightSec: nightMins * 60,
            sunSec: (isSun && !isHol) ? dur * 60 : 0,
            holSec: isHol ? dur * 60 : 0,
          });
        }
      }

      if (granularUnits.length === 0) {
        stillUnassigned.push(ublk);
        continue;
      }

      splitBlockCount++;

      // Sort granular units by the same priority as main pass
      const sortedGranular = [...granularUnits].sort((a, b) => {
        const pd = blockPriority(b) - blockPriority(a);
        return pd !== 0 ? pd : b.workSec - a.workSec;
      });

      let blockFullyAssigned = true;
      for (const gu of sortedGranular) {
        let guAssigned = false;

        // In correction mode: owner first
        if (ownerDriverId) {
          const check = canAssignToDriver(gu, ownerDriverId, null);
          if (check.ok) {
            doAssign(gu, ownerDriverId, ownerDriverName, 'owner', 'Einzelfahrt', ublk.id);
            assignedTripIds.add(gu.tripIds[0]);
            granularAssignedCount++;
            guAssigned = true;
          }
        }

        if (!guAssigned) {
          const priority = blockPriority(gu);
          const sortedTargets = [...targets].sort((a, b) => {
            const ba = budgets.get(a.driverId)!;
            const bb = budgets.get(b.driverId)!;
            if (priority === 3) return ba.holSec - bb.holSec;
            if (priority === 2) return ba.sunSec - bb.sunSec;
            if (priority === 1) return ba.nightSec - bb.nightSec;
            return ba.workSec - bb.workSec;
          });
          for (const t of sortedTargets) {
            const budget = budgets.get(t.driverId)!;
            const check = canAssignToDriver(gu, t.driverId, budget);
            if (check.ok) {
              doAssign(gu, t.driverId, t.driverName, 'payroll', 'Einzelfahrt', ublk.id);
              assignedTripIds.add(gu.tripIds[0]);
              granularAssignedCount++;
              guAssigned = true;
              break;
            }
          }
        }

        if (!guAssigned) {
          blockFullyAssigned = false;
          // Keep a mini-stub in stillUnassigned to preserve the exact reason
          stillUnassigned.push({
            ...gu,
            id: gu.id,
          });
        }
      }

      // If the entire block was split and all granular units assigned, the parent block
      // is no longer unassigned. If some units remain unassigned, they appear individually.
      if (blockFullyAssigned) {
        // nothing to add to stillUnassigned
        void blockFullyAssigned;
      }
    }

    // Replace unassigned with whatever couldn't be resolved granularly
    unassigned.length = 0;
    for (const u of stillUnassigned) unassigned.push(u);
  }

  // ── Compute actual seconds per driver ───────────────────────────────────────
  const driverActuals = new Map<string, { workSec: number; nightSec: number; sunSec: number; holSec: number }>();
  for (const ab of allAssigned) {
    if (!driverActuals.has(ab.assignedDriverId)) {
      driverActuals.set(ab.assignedDriverId, { workSec: 0, nightSec: 0, sunSec: 0, holSec: 0 });
    }
    const a = driverActuals.get(ab.assignedDriverId)!;
    a.workSec += ab.workSec;
    a.nightSec += ab.nightSec;
    a.sunSec += ab.sunSec;
    a.holSec += ab.holSec;
  }

  // ── Deviations for payroll drivers ──────────────────────────────────────────
  const deviations: PlanningDeviation[] = [];
  for (const t of targets) {
    const actual = driverActuals.get(t.driverId) ?? { workSec: 0, nightSec: 0, sunSec: 0, holSec: 0 };
    for (const [code, tSec, aSec] of [
      ['1000', t.workSec,  actual.workSec],
      ['1501', t.nightSec, actual.nightSec],
      ['1510', t.sunSec,   actual.sunSec],
      ['1520', t.holSec,   actual.holSec],
    ] as [string, number, number][]) {
      deviations.push({
        driverId:      t.driverId,
        driverName:    t.driverName,
        personalnummer: t.personalnummer,
        wageCode:      code,
        wageLabel:     WAGE_LABELS[code],
        targetSec:     tSec,
        actualSec:     aSec,
        diffSec:       aSec - tSec,
      });
    }
  }

  // ── Post-assignment conflict detection (should now be zero for overlap/switch) ──
  const conflicts: PlanningConflict[] = [];

  // Driver overlaps (should be prevented above — guard check)
  for (const [, dBlocks] of assignedByDriver) {
    const byDate = new Map<string, AssignedBlock[]>();
    for (const b of dBlocks) {
      if (!byDate.has(b.date)) byDate.set(b.date, []);
      byDate.get(b.date)!.push(b);
    }
    for (const [date, dayBlocks] of byDate) {
      for (let i = 0; i < dayBlocks.length; i++) {
        for (let j = i + 1; j < dayBlocks.length; j++) {
          if (overlaps(dayBlocks[i], dayBlocks[j])) {
            conflicts.push({
              type: 'driver_overlap',
              description: `${dayBlocks[i].assignedDriverName}: Überlappung am ${date} ${minsToTimeStr(dayBlocks[i].startMin)}–${minsToTimeStr(dayBlocks[i].endMin)} und ${minsToTimeStr(dayBlocks[j].startMin)}–${minsToTimeStr(dayBlocks[j].endMin)}`,
              date,
            });
          }
        }
      }
    }
  }

  // Vehicle overlaps across different drivers (should be prevented above — guard check)
  const byVehicleDate = new Map<string, AssignedBlock[]>();
  for (const ab of allAssigned) {
    if (!ab.vehicleId) continue;
    const key = `${ab.vehicleId}|${ab.date}`;
    if (!byVehicleDate.has(key)) byVehicleDate.set(key, []);
    byVehicleDate.get(key)!.push(ab);
  }
  for (const [, vBlocks] of byVehicleDate) {
    for (let i = 0; i < vBlocks.length; i++) {
      for (let j = i + 1; j < vBlocks.length; j++) {
        if (vBlocks[i].assignedDriverId !== vBlocks[j].assignedDriverId && overlaps(vBlocks[i], vBlocks[j])) {
          conflicts.push({
            type: 'vehicle_overlap',
            description: `Fahrzeug ${vBlocks[i].vehicleKennzeichen ?? vBlocks[i].vehicleId}: Überlappung am ${vBlocks[i].date} — ${vBlocks[i].assignedDriverName} und ${vBlocks[j].assignedDriverName}`,
            date: vBlocks[i].date,
            kennzeichen: vBlocks[i].vehicleKennzeichen ?? undefined,
          });
        }
      }
    }
  }

  // Vehicle switch violations (should be prevented above — guard check)
  for (const [, dBlocks] of assignedByDriver) {
    const byDate = new Map<string, AssignedBlock[]>();
    for (const b of dBlocks) {
      if (!byDate.has(b.date)) byDate.set(b.date, []);
      byDate.get(b.date)!.push(b);
    }
    for (const [date, dayBlocks] of byDate) {
      const sorted2 = [...dayBlocks].sort((a, b) => a.startMin - b.startMin);
      for (let i = 0; i < sorted2.length - 1; i++) {
        const a = sorted2[i];
        const b = sorted2[i + 1];
        if (a.vehicleId && b.vehicleId && a.vehicleId !== b.vehicleId) {
          const gap = b.startMin - a.endMin;
          if (gap >= 0 && gap < MIN_VEHICLE_SWITCH_BUFFER_MINUTES) {
            conflicts.push({
              type: 'vehicle_switch',
              description: `${a.assignedDriverName}: Fahrzeugwechsel am ${date} — ${a.vehicleKennzeichen ?? '?'} → ${b.vehicleKennzeichen ?? '?'}, Puffer: ${gap} Min. (mind. ${MIN_VEHICLE_SWITCH_BUFFER_MINUTES} Min. erforderlich)`,
              date,
            });
          }
        }
      }
    }
  }

  // Unassigned blocks — record with reason
  for (const u of unassigned) {
    // Determine why it could not be assigned: try all drivers to get last rejection reason
    let lastReason = 'Keine kompatible Zuweisung möglich';

    const allCandidates: Array<{ id: string; name: string; budget: typeof budgets extends Map<string, infer V> ? V : never | null }> = [
      ...targets.map(t => ({ id: t.driverId, name: t.driverName, budget: budgets.get(t.driverId)! })),
      ...(ownerDriverId ? [{ id: ownerDriverId, name: ownerDriverName, budget: null as never }] : []),
    ];

    for (const cand of allCandidates) {
      const check = canAssignToDriver(u, cand.id, cand.budget as { workSec: number; nightSec: number; sunSec: number; holSec: number } | null);
      if (!check.ok && check.reason) lastReason = check.reason;
    }

    conflicts.push({
      type: 'unassigned',
      description: `Nicht zuweisbar: ${u.date} ${minsToTimeStr(u.startMin)}–${minsToTimeStr(u.endMin)} (${u.originalDriverName}, ${u.vehicleKennzeichen ?? 'kein Kfz'}) — ${lastReason}`,
      date: u.date,
      blockId: u.id,
      kennzeichen: u.vehicleKennzeichen ?? undefined,
      originalDriverName: u.originalDriverName,
      reason: lastReason,
    });
  }

  // ── Compute breakdown counts ─────────────────────────────────────────────────
  const vehicleOverlapCount = conflicts.filter(c => c.type === 'vehicle_overlap').length;
  const driverOverlapCount  = conflicts.filter(c => c.type === 'driver_overlap').length;
  const vehicleSwitchCount  = conflicts.filter(c => c.type === 'vehicle_switch').length;
  const isExact = deviations.every(d => d.diffSec === 0);

  // A plan is finalizable only when ALL hard requirements pass:
  // 1. Zero target deviations
  // 2. Zero vehicle overlaps
  // 3. Zero driver overlaps
  // 4. Zero vehicle switch violations
  // 5. Zero unassigned completed blocks
  const isFinalizable =
    isExact &&
    vehicleOverlapCount === 0 &&
    driverOverlapCount  === 0 &&
    vehicleSwitchCount  === 0 &&
    unassigned.length   === 0;

  return {
    assignments: allAssigned,
    unassigned,
    conflicts,
    driverActuals,
    deviations,
    isExact,
    isFinalizable,
    totalBlocks: blocks.length,
    finalAssignmentUnits: allAssigned.length,
    granularEinzelfahrten: allAssigned.filter(a => a.granularity === 'Einzelfahrt').length,
    payrollAssigned: allAssigned.filter(a => a.role === 'payroll' && !a.isSplit).length,
    ownerAssigned: allAssigned.filter(a => a.role === 'owner').length,
    unassignedCount: unassigned.length,
    vehicleOverlapCount,
    driverOverlapCount,
    vehicleSwitchCount,
    granularRetryUsed,
    unassignedBeforeRetry,
    granularAssignedCount,
    splitBlockCount,
    einzelwagenZeitenTotal: 0,
    einzelwagenZeitenToOwner: 0,
    reliefPassTotal: 0,
    reliefCandidatesTried: 0,
    reliefGranularTransfers: 0,
    swapAttemptsTotal: 0,
    swapAcceptedTotal: 0,
    unresolvedOverTargetCount: 0,
    driversOverTarget: [],
    negativeCorrectionsRequired: 0,
    ownerOriginalCount: 0,
    ownerCriticalReliefCount: 0,
    ownerOptionalEinzelwagenCount: 0,
    ownerBaselineCount: 0,
    rejectedCandidates: [],
    ownerCapacityEntries: [],
    solverLimitReached: false,
    solverCancelled: false,
    solverElapsedMs: 0,
    solverGranularAttempts: 0,
    diagnosticsTruncated: 0,
  };
}

// ── Active vehicle analysis ───────────────────────────────────────────────────

/**
 * For each block, count how many distinct vehicles are active (overlapping) at any point
 * during the block's time window on the same date. Then mark Einzelwagen-Zeit:
 * blocks where the count === 1 (only this vehicle is active the entire interval).
 */
export function computeBlockVehicleCounts(blocks: CandidateBlock[]): CandidateBlock[] {
  // Index all blocks by date for efficient overlap queries
  const byDate = new Map<string, CandidateBlock[]>();
  for (const b of blocks) {
    if (!byDate.has(b.date)) byDate.set(b.date, []);
    byDate.get(b.date)!.push(b);
  }

  return blocks.map(b => {
    if (!b.vehicleId) return { ...b, activeVehicleCount: 0, isEinzelwagenZeit: false };

    const dayBlocks = byDate.get(b.date) ?? [];
    // Count distinct vehicles whose time window overlaps b's window
    const overlappingVehicles = new Set<string>();
    for (const other of dayBlocks) {
      if (!other.vehicleId) continue;
      if (overlaps(b, other)) {
        overlappingVehicles.add(other.vehicleId);
      }
    }
    const count = overlappingVehicles.size;
    return { ...b, activeVehicleCount: count, isEinzelwagenZeit: count === 1 };
  });
}

// ── Owner relief solver ───────────────────────────────────────────────────────

/**
 * Historical correction mode uses transfer-based owner relief.
 * Do NOT use greedy assignment-from-scratch here.
 *
 * Strategy:
 *   Baseline  — register EVERY completed block directly to its original Fahrtenbuch driver.
 *               NO canAssign check at this stage. A block stays with its original driver
 *               unless explicitly transferred. Only truly invalid source data (missing driver,
 *               zero-duration, missing timestamps) goes into the data-error list.
 *   Pass 1    — for blocks assigned to over-target payroll drivers that are Einzelwagen-Zeit,
 *               try a transfer-aware move to owner.
 *   Pass 2    — for any remaining over-target payroll driver, try to transfer blocks to owner.
 *   Transfer  — unregister block from current driver, check if owner can take it, commit or
 *               rollback. The unregister step ensures the same block is not a conflict against
 *               itself in vehicle/driver occupancy.
 *   Residuals — blocks that could not be transferred stay with original driver. They are NOT
 *               "Nicht zuweisbar". Only over-target remaining becomes a conflict entry.
 */
export async function runOwnerReliefSolver(
  blocks: CandidateBlock[],
  targets: DriverTargetSeconds[],
  ownerDriverId: string | null,
  ownerDriverName: string,
  allTrips?: FahrtenbuchTrip[],
  ctrl?: SolverController,
): Promise<PlanningResult> {
  const _ctrl = ctrl ?? createSolverController();
  const WAGE_LABELS_LOCAL: Record<string, string> = {
    '1000': 'Stundenlohn',
    '1501': 'Nachtzuschlag, 40% frei',
    '1510': 'Sonntagszuschlag, 50% frei',
    '1520': 'Feiertagszuschlag, 125% frei',
  };

  const targetById = new Map<string, DriverTargetSeconds>(targets.map(t => [t.driverId, t]));

  // Mutable assignment map: blockId → AssignedBlock
  const assignmentMap = new Map<string, AssignedBlock>();
  // Driver time occupancy for overlap checks
  const driverOccupancy = new Map<string, AssignedBlock[]>();
  // Vehicle occupancy: vehicleId|date → AssignedBlock[]
  const vehicleOccupancy = new Map<string, AssignedBlock[]>();
  // Truly invalid source data blocks (missing driver, zero duration, etc.)
  const dataErrors: CandidateBlock[] = [];

  function getVKey(vehicleId: string, date: string) { return `${vehicleId}|${date}`; }

  function registerAssignment(ab: AssignedBlock) {
    assignmentMap.set(ab.id, ab);
    if (!driverOccupancy.has(ab.assignedDriverId)) driverOccupancy.set(ab.assignedDriverId, []);
    driverOccupancy.get(ab.assignedDriverId)!.push(ab);
    if (ab.vehicleId) {
      const vKey = getVKey(ab.vehicleId, ab.date);
      if (!vehicleOccupancy.has(vKey)) vehicleOccupancy.set(vKey, []);
      vehicleOccupancy.get(vKey)!.push(ab);
    }
  }

  function unregisterAssignment(ab: AssignedBlock) {
    assignmentMap.delete(ab.id);
    const dOcc = driverOccupancy.get(ab.assignedDriverId);
    if (dOcc) { const idx = dOcc.indexOf(ab); if (idx >= 0) dOcc.splice(idx, 1); }
    if (ab.vehicleId) {
      const vKey = getVKey(ab.vehicleId, ab.date);
      const vOcc = vehicleOccupancy.get(vKey);
      if (vOcc) { const idx = vOcc.indexOf(ab); if (idx >= 0) vOcc.splice(idx, 1); }
    }
  }

  function makeAssigned(
    blk: CandidateBlock,
    driverId: string,
    driverName: string,
    role: 'payroll' | 'owner',
    grund?: string,
    granularity: 'Schichtblock' | 'Einzelfahrt' | 'Sub-Block' = 'Schichtblock',
    originalBlockId?: string,
  ): AssignedBlock {
    return {
      ...blk,
      assignedDriverId: driverId,
      assignedDriverName: driverName,
      role,
      granularity,
      isSplit: granularity !== 'Schichtblock',
      entlastungsGrund: grund,
      originalBlockId,
    };
  }

  /**
   * Check if the owner can take blk, given the current occupancy state.
   * Called AFTER the block has been unregistered from its current driver,
   * so the same block never appears as a conflict against itself.
   * Returns conflictingOwnerBlocks so the swap mechanism can directly use them.
   */
  function canOwnerTake(blk: CandidateBlock): {
    ok: boolean;
    reason?: string;
    conflictType?: 'owner_driver_overlap' | 'vehicle_switch_buffer' | 'vehicle_overlap' | 'no_owner';
    conflictingOwnerBlocks: AssignedBlock[];
  } {
    if (!ownerDriverId) return { ok: false, reason: 'Kein Inhaber konfiguriert', conflictType: 'no_owner', conflictingOwnerBlocks: [] };
    const existing = driverOccupancy.get(ownerDriverId) ?? [];
    const sameDate = existing.filter(e => e.date === blk.date);
    const overlapping = sameDate.filter(e => overlaps(e, blk));
    if (overlapping.length > 0) {
      return { ok: false, reason: 'Inhaber: Fahrer-Überschneidung', conflictType: 'owner_driver_overlap', conflictingOwnerBlocks: overlapping };
    }
    if (blk.vehicleId) {
      for (const e of sameDate) {
        if (e.vehicleId && e.vehicleId !== blk.vehicleId) {
          const gap = Math.max(blk.startMin - e.endMin, e.startMin - blk.endMin);
          if (gap >= 0 && gap < MIN_VEHICLE_SWITCH_BUFFER_MINUTES)
            return { ok: false, reason: `Inhaber: Fahrzeugwechsel-Puffer zu kurz (${gap} Min.)`, conflictType: 'vehicle_switch_buffer', conflictingOwnerBlocks: [e] };
        }
      }
      // Vehicle occupancy: check other drivers (block already unregistered, so same vehicle is safe)
      const vKey = getVKey(blk.vehicleId, blk.date);
      const vOcc = vehicleOccupancy.get(vKey) ?? [];
      for (const occ of vOcc) {
        if (occ.assignedDriverId !== ownerDriverId && overlaps(occ, blk))
          return { ok: false, reason: `Inhaber: Fahrzeug ${blk.vehicleKennzeichen ?? blk.vehicleId} bereits von ${occ.assignedDriverName} belegt`, conflictType: 'vehicle_overlap', conflictingOwnerBlocks: [] };
      }
    }
    return { ok: true, conflictingOwnerBlocks: [] };
  }

  /**
   * Transfer-aware move: unregister block from current driver, check if owner can take it.
   * On success, register under owner. On failure, rollback to original driver.
   * Returns { newAb, reason } — newAb is non-null on success, reason is non-null on failure.
   */
  function tryTransferToOwner(
    ab: AssignedBlock,
    grund: string,
    granularity: 'Schichtblock' | 'Einzelfahrt' | 'Sub-Block' = 'Schichtblock',
    originalBlockId?: string,
  ): { newAb: AssignedBlock | null; reason: string; conflictingOwnerBlocks: AssignedBlock[] } {
    if (!ownerDriverId) return { newAb: null, reason: 'Kein Inhaber konfiguriert', conflictingOwnerBlocks: [] };
    unregisterAssignment(ab);
    const check = canOwnerTake(ab);
    if (check.ok) {
      const newAb = makeAssigned(ab, ownerDriverId, ownerDriverName, 'owner', grund, granularity, originalBlockId);
      registerAssignment(newAb);
      return { newAb, reason: '', conflictingOwnerBlocks: [] };
    }
    // Rollback — restore original assignment
    registerAssignment(ab);
    return { newAb: null, reason: check.reason ?? 'Unbekannter Grund', conflictingOwnerBlocks: check.conflictingOwnerBlocks };
  }

  // ── Enrich blocks with vehicle counts ────────────────────────────────────────
  const enrichedBlocks = computeBlockVehicleCounts(blocks);

  let ownerOriginalCount = 0;

  // ── Baseline: register EVERY block directly to its original Fahrtenbuch driver ──
  // No canAssign check here. Every real completed unit is already assigned in the
  // Fahrtenbuch — we just mirror that state. canAssign is only used for transfers.
  for (const blk of enrichedBlocks) {
    // ownerOriginalConflict: source driver is owner but owner exclusion is active
    if (blk.ownerOriginalConflict) {
      ownerOriginalCount++;
      dataErrors.push(blk);
      continue;
    }

    // Data integrity: missing driver or zero duration
    const hasDriver = !!blk.originalDriverId;
    const hasDuration = blk.workSec > 0;
    if (!hasDriver || !hasDuration) {
      dataErrors.push(blk);
      continue;
    }

    const target = targetById.get(blk.originalDriverId!);
    const driverName = target?.driverName ?? blk.originalDriverName;
    const isOwnerBlock = ownerDriverId && blk.originalDriverId === ownerDriverId;
    const role: 'payroll' | 'owner' = isOwnerBlock ? 'owner' : 'payroll';
    const ab = makeAssigned(blk, blk.originalDriverId!, driverName, role);
    registerAssignment(ab);
  }

  // Helper: compute current totals per driver from assignmentMap
  function computeTotals(): Map<string, { workSec: number; nightSec: number; sunSec: number; holSec: number }> {
    const totals = new Map<string, { workSec: number; nightSec: number; sunSec: number; holSec: number }>();
    for (const ab of assignmentMap.values()) {
      if (!totals.has(ab.assignedDriverId)) totals.set(ab.assignedDriverId, { workSec: 0, nightSec: 0, sunSec: 0, holSec: 0 });
      const t = totals.get(ab.assignedDriverId)!;
      t.workSec += ab.workSec; t.nightSec += ab.nightSec; t.sunSec += ab.sunSec; t.holSec += ab.holSec;
    }
    return totals;
  }

  // Compute a global over-target score: sum of (overage * Lohnart priority weight) for all drivers.
  // Higher score = worse. Used to evaluate whether a swap improves the objective.
  const LOHNART_WEIGHT: Record<string, number> = { '1520': 8, '1510': 4, '1501': 2, '1000': 1 };
  function computeOverTargetScore(totals: Map<string, { workSec: number; nightSec: number; sunSec: number; holSec: number }>): number {
    let score = 0;
    for (const t of targets) {
      const actual = totals.get(t.driverId) ?? { workSec: 0, nightSec: 0, sunSec: 0, holSec: 0 };
      score += Math.max(0, actual.workSec  - t.workSec)  * (LOHNART_WEIGHT['1000'] ?? 1);
      score += Math.max(0, actual.nightSec - t.nightSec) * (LOHNART_WEIGHT['1501'] ?? 2);
      score += Math.max(0, actual.sunSec   - t.sunSec)   * (LOHNART_WEIGHT['1510'] ?? 4);
      score += Math.max(0, actual.holSec   - t.holSec)   * (LOHNART_WEIGHT['1520'] ?? 8);
    }
    return score;
  }

  // Lohnart priority for tie-breaking: rarer/higher-value first
  const LOHNART_PRIORITY: Record<string, number> = { '1520': 4, '1510': 3, '1501': 2, '1000': 1 };

  // Build trip lookup for granular fallback
  const tripById = new Map<string, FahrtenbuchTrip>(
    (allTrips ?? []).map(t => [t.id, t]),
  );

  // ── Unified relief pass: over-target drivers + optional Einzelwagen-Zeit → owner ──
  //
  // Strategy:
  //   1. Find all drivers over target. For each, collect candidate blocks sorted by
  //      contribution to the worst Lohnart.
  //   2. For the globally worst driver/Lohnart, try transfer (block → granular → swap).
  //   3. After all over-target reduction is exhausted, do a second pass for optional
  //      Einzelwagen-Zeit relief (for drivers NOT over target, or already resolved).
  //   Swaps: if a candidate is blocked by a lower-priority owner assignment, try swapping.

  let einzelwagenZeitenTotal = 0;
  let einzelwagenZeitenToOwner = 0;
  let reliefPassTotal = 0;
  let reliefCandidatesTried = 0;
  let reliefGranularTransfers = 0;
  let swapAttemptsTotal = 0;
  let swapAcceptedTotal = 0;
  let granularAttemptsTotal = 0;
  let diagnosticsTruncated = 0;
  const rejectedCandidates: RejectedCandidate[] = [];
  const ownerCapacityEntries: OwnerCapacityEntry[] = [];

  // Deduplication sets — prevent retrying known-failing combinations
  const triedTransferKeys = new Set<string>();   // `${candidateId}` when full block transfer failed
  const triedGranularKeys = new Set<string>();   // `${candidateId}|${tripId}` per granular trip
  const triedSwapKeys = new Set<string>();       // `${candidateId}|${ownerBlockId}` per swap pair

  // Track which Einzelwagen-Zeit blocks were pre-counted as candidates
  {
    const t0 = computeTotals();
    for (const ab of assignmentMap.values()) {
      if (ab.role !== 'payroll' || !ab.isEinzelwagenZeit) continue;
      const tgt = targetById.get(ab.assignedDriverId);
      if (!tgt) continue;
      const actual = t0.get(ab.assignedDriverId);
      if (actual && actual.workSec > tgt.workSec) einzelwagenZeitenTotal++;
    }
  }

  if (ownerDriverId) {
    // ── Phase A: over-target reduction loop ────────────────────────────────────
    _ctrl.reportProgress({ phase: 'Phase A: Über-Zielwert-Entlastung' });
    let globalProgress = true;
    let mainIterations = 0;
    while (globalProgress) {
      // Budget check: time + iteration limit
      if (_ctrl.shouldStop() || mainIterations >= _ctrl.budget.mainIterations) break;
      mainIterations++;
      await _ctrl.yield();

      globalProgress = false;
      const totals = computeTotals();

      // Find the most severe over-target driver/Lohnart
      let worstDriverId: string | null = null;
      let worstWageCode = '1000';
      let worstOverageSec = 0;

      for (const t of targets) {
        const actual = totals.get(t.driverId) ?? { workSec: 0, nightSec: 0, sunSec: 0, holSec: 0 };
        for (const [code, tSec, aSec] of [
          ['1520', t.holSec,   actual.holSec],
          ['1510', t.sunSec,   actual.sunSec],
          ['1501', t.nightSec, actual.nightSec],
          ['1000', t.workSec,  actual.workSec],
        ] as [string, number, number][]) {
          const over = aSec - tSec;
          if (over <= 0) continue;
          const pri = LOHNART_PRIORITY[code] ?? 1;
          const worstPri = LOHNART_PRIORITY[worstWageCode] ?? 1;
          if (worstDriverId === null || pri > worstPri || (pri === worstPri && over > worstOverageSec)) {
            worstDriverId = t.driverId;
            worstWageCode = code;
            worstOverageSec = over;
          }
        }
      }

      if (!worstDriverId) break; // All drivers within target

      // Collect candidate blocks for the worst driver
      const driverBlocks = [...assignmentMap.values()]
        .filter(ab => ab.assignedDriverId === worstDriverId && ab.role === 'payroll')
        .sort((a, b) => {
          const cA = worstWageCode === '1000' ? a.workSec : worstWageCode === '1501' ? a.nightSec : worstWageCode === '1510' ? a.sunSec : a.holSec;
          const cB = worstWageCode === '1000' ? b.workSec : worstWageCode === '1501' ? b.nightSec : worstWageCode === '1510' ? b.sunSec : b.holSec;
          if (cB !== cA) return cB - cA;
          const ewA = a.isEinzelwagenZeit ? 0 : 1;
          const ewB = b.isEinzelwagenZeit ? 0 : 1;
          if (ewA !== ewB) return ewA - ewB;
          const vcA = a.activeVehicleCount ?? 99;
          const vcB = b.activeVehicleCount ?? 99;
          if (vcA !== vcB) return vcA - vcB;
          return a.workSec - b.workSec;
        });

      let madeAnyTransfer = false;

      for (const ab of driverBlocks) {
        // Budget check per candidate
        if (_ctrl.shouldStop() || _ctrl.budget.candidateAttempts <= 0) break;
        _ctrl.budget.candidateAttempts--;

        const live = assignmentMap.get(ab.id);
        if (!live || live.assignedDriverId !== worstDriverId) continue;

        // Skip if this candidate already failed a full transfer (deduplication)
        if (triedTransferKeys.has(ab.id)) continue;

        // Re-check still over target (use cached totals — only refresh on budget-friendly interval)
        const refreshed = computeTotals();
        const curr = refreshed.get(worstDriverId) ?? { workSec: 0, nightSec: 0, sunSec: 0, holSec: 0 };
        const tgt = targetById.get(worstDriverId)!;
        const stillOver =
          worstWageCode === '1000' ? curr.workSec > tgt.workSec :
          worstWageCode === '1501' ? curr.nightSec > tgt.nightSec :
          worstWageCode === '1510' ? curr.sunSec > tgt.sunSec :
          curr.holSec > tgt.holSec;
        if (!stillOver) break;

        reliefCandidatesTried++;
        _ctrl.reportProgress({ candidatesTried: reliefCandidatesTried, swapAttempts: swapAttemptsTotal, granularAttempts: granularAttemptsTotal });
        const contribToOver = worstWageCode === '1000' ? live.workSec : worstWageCode === '1501' ? live.nightSec : worstWageCode === '1510' ? live.sunSec : live.holSec;

        // ── Attempt 1: direct Schichtblock transfer ────────────────────────────
        const { newAb, reason: blockReason, conflictingOwnerBlocks: attempt1Conflicts } = tryTransferToOwner(ab, 'Über Zielwert → Inhaber-Entlastung', 'Schichtblock');
        if (newAb) {
          const registered = assignmentMap.get(newAb.id);
          if (registered) registered.ownerAssignmentPriority = 'critical_over_target_relief';
          reliefPassTotal++;
          madeAnyTransfer = true;
          globalProgress = true;
          triedTransferKeys.delete(ab.id); // succeeded — clear if previously tried
          if (live.isEinzelwagenZeit) einzelwagenZeitenToOwner++;
          break;
        }
        // Mark this candidate as tried for direct transfer (no retry next iteration)
        triedTransferKeys.add(ab.id);

        // ── Attempt 2: granular Einzelfahrt fallback ───────────────────────────
        let granularSuccess = false;
        let granularConflicts: AssignedBlock[] = [];
        if (allTrips && allTrips.length > 0 && ab.tripIds.length > 0) {
          const blockTrips = ab.tripIds
            .map(id => tripById.get(id))
            .filter((t): t is FahrtenbuchTrip => !!t && !t.is_canceled);

          if (blockTrips.length > 1) {
            const granularUnits: CandidateBlock[] = [];
            let gCounter = 0;
            for (const trip of blockTrips) {
              const segs = normalizeTripServiceDate(trip);
              for (const seg of segs) {
                const von = minsToTimeStr(seg.startMinutes);
                const bis = minsToTimeStr(seg.endMinutes);
                const dur = segDuration(von, bis);
                if (dur <= 0) continue;
                const nightMins = nightMinsForSeg(von, bis);
                const dateObj = new Date(seg.serviceDate + 'T12:00:00');
                const isSun = dateObj.getDay() === 0;
                const isHolDate = ab.holSec > 0 && seg.serviceDate === ab.date;
                granularUnits.push({
                  id: `${ab.id}_g${gCounter++}`,
                  tripIds: [trip.id],
                  date: seg.serviceDate,
                  startMin: seg.startMinutes,
                  endMin: seg.endMinutes,
                  vehicleId: trip.car_id ?? null,
                  vehicleKennzeichen: trip.car_identifier ?? null,
                  originalDriverId: ab.originalDriverId,
                  originalDriverName: ab.originalDriverName,
                  sourceDriverId: ab.sourceDriverId,
                  sourceDriverName: ab.sourceDriverName,
                  ownerOriginalConflict: false,
                  workSec: dur * 60,
                  nightSec: nightMins * 60,
                  sunSec: (isSun && !isHolDate) ? dur * 60 : 0,
                  holSec: isHolDate ? dur * 60 : 0,
                  activeVehicleCount: ab.activeVehicleCount,
                  isEinzelwagenZeit: ab.isEinzelwagenZeit,
                });
              }
            }

            granularUnits.sort((a, b) => {
              const cA = worstWageCode === '1000' ? a.workSec : worstWageCode === '1501' ? a.nightSec : worstWageCode === '1510' ? a.sunSec : a.holSec;
              const cB = worstWageCode === '1000' ? b.workSec : worstWageCode === '1501' ? b.nightSec : worstWageCode === '1510' ? b.sunSec : b.holSec;
              return cB - cA;
            });

            unregisterAssignment(live);

            let anyGranularTransferred = false;
            const keptUnits: CandidateBlock[] = [];

            for (const gu of granularUnits) {
              // Budget check per granular unit
              if (_ctrl.shouldStop() || _ctrl.budget.granularAttempts <= 0) {
                keptUnits.push(gu);
                continue;
              }

              const tripKey = `${ab.id}|${gu.tripIds[0] ?? gu.id}`;
              if (triedGranularKeys.has(tripKey)) {
                keptUnits.push(gu);
                continue;
              }

              _ctrl.budget.granularAttempts--;
              granularAttemptsTotal++;

              const gContrib = worstWageCode === '1000' ? gu.workSec : worstWageCode === '1501' ? gu.nightSec : worstWageCode === '1510' ? gu.sunSec : gu.holSec;
              const tempAb = makeAssigned(gu, worstDriverId, live.assignedDriverName, 'payroll', undefined, 'Einzelfahrt', ab.id);
              registerAssignment(tempAb);
              const { newAb: granularNewAb, reason: granularReason, conflictingOwnerBlocks: gConflicts } = tryTransferToOwner(tempAb, 'Über Zielwert → Inhaber-Entlastung (Einzelfahrt)', 'Einzelfahrt', ab.id);
              if (granularNewAb) {
                const regG = assignmentMap.get(granularNewAb.id);
                if (regG) regG.ownerAssignmentPriority = 'critical_over_target_relief';
                reliefGranularTransfers++;
                anyGranularTransferred = true;
                granularSuccess = true;
                globalProgress = true;
                madeAnyTransfer = true;
                triedGranularKeys.delete(tripKey); // succeeded
              } else {
                triedGranularKeys.add(tripKey); // mark as failed for deduplication
                keptUnits.push(gu);
                granularConflicts.push(...gConflicts.filter(gc => !granularConflicts.some(x => x.id === gc.id)));
                if (gContrib > 0 && rejectedCandidates.length < MAX_REJECTED_DIAGNOSTICS) {
                  rejectedCandidates.push({
                    driverName: live.assignedDriverName,
                    overTargetWageCode: worstWageCode,
                    overTargetWageLabel: WAGE_LABELS_LOCAL[worstWageCode] ?? worstWageCode,
                    overageSec: worstOverageSec,
                    blockId: gu.id,
                    date: gu.date,
                    startMin: gu.startMin,
                    endMin: gu.endMin,
                    kennzeichen: gu.vehicleKennzeichen,
                    contributionSec: gContrib,
                    triedAsSchichtblock: false,
                    triedAsEinzelfahrt: true,
                    swapAttempted: false,
                    swapAccepted: false,
                    swapReason: '',
                    conflictingOwnerUnits: gConflicts.map(x => x.id),
                    rejectionReason: granularReason,
                    ownerConflictReason: granularReason,
                  });
                } else if (gContrib > 0) {
                  diagnosticsTruncated++;
                }
              }
            }

            if (!anyGranularTransferred) {
              for (const gu of keptUnits) {
                const guAb = assignmentMap.get(gu.id);
                if (guAb) unregisterAssignment(guAb);
              }
              registerAssignment(live);
            } else {
              if (contribToOver > 0) {
                rejectedCandidates.push({
                  driverName: live.assignedDriverName,
                  overTargetWageCode: worstWageCode,
                  overTargetWageLabel: WAGE_LABELS_LOCAL[worstWageCode] ?? worstWageCode,
                  overageSec: worstOverageSec,
                  blockId: ab.id,
                  date: ab.date,
                  startMin: ab.startMin,
                  endMin: ab.endMin,
                  kennzeichen: ab.vehicleKennzeichen,
                  contributionSec: contribToOver,
                  triedAsSchichtblock: true,
                  triedAsEinzelfahrt: true,
                  swapAttempted: false,
                  swapAccepted: false,
                  swapReason: '',
                  conflictingOwnerUnits: granularConflicts.map(x => x.id),
                  rejectionReason: blockReason + ' (als Einzelfahrten teilweise übertragen)',
                  ownerConflictReason: blockReason,
                });
                break;
              }
            }
          }
        }

        if (granularSuccess) continue;

        // ── Attempt 3: swap with a lower-priority owner assignment ─────────────
        // Use the conflicting blocks returned directly from Attempt 1 (and any
        // granular-level conflicts) — no second occupancy query needed.
        if (contribToOver > 0) {
          // Merge conflicting blocks from Attempt 1 and granular phase
          const allConflicting = [...attempt1Conflicts];
          for (const gc of granularConflicts) {
            if (!allConflicting.some(x => x.id === gc.id)) allConflicting.push(gc);
          }

          // If attempt1Conflicts is empty (e.g. single-trip block was not tried as granular),
          // fall back to querying owner occupancy directly.
          const ownerConflictsForSwap = allConflicting.length > 0
            ? allConflicting
            : (driverOccupancy.get(ownerDriverId) ?? []).filter(oa => oa.date === live.date && overlaps(oa, live));

          // Only swap-eligible: must have been transferred (not owner's own original block),
          // must have a restorable payroll driver, must not be a critical relief assignment.
          // A critical candidate (this one) CAN displace another critical owner unit IF the
          // global score improves — but we prefer displacing optional units first.
          const optionalSwapTargets = ownerConflictsForSwap.filter(
            oa => oa.role === 'owner' &&
                  oa.originalDriverId !== null &&
                  oa.originalDriverId !== ownerDriverId &&
                  oa.ownerAssignmentPriority !== 'critical_over_target_relief',
          );
          const criticalSwapTargets = ownerConflictsForSwap.filter(
            oa => oa.role === 'owner' &&
                  oa.originalDriverId !== null &&
                  oa.originalDriverId !== ownerDriverId &&
                  oa.ownerAssignmentPriority === 'critical_over_target_relief',
          );
          const immovableConflicts = ownerConflictsForSwap.filter(
            oa => !optionalSwapTargets.includes(oa) && !criticalSwapTargets.includes(oa),
          );
          // Try optional first, then critical (score-gated)
          const swapCandidates = [...optionalSwapTargets, ...criticalSwapTargets];

          let swapSuccess = false;
          const conflictingIds = ownerConflictsForSwap.map(x => x.id);

          for (const ownerBlock of swapCandidates) {
            // Budget check per swap
            if (_ctrl.shouldStop() || _ctrl.budget.swapAttempts <= 0) break;

            const swapKey = `${ab.id}|${ownerBlock.id}`;
            if (triedSwapKeys.has(swapKey)) continue;

            swapAttemptsTotal++;
            _ctrl.budget.swapAttempts--;

            const origDriverId = ownerBlock.originalDriverId!;
            const origTarget = targetById.get(origDriverId);
            if (!origTarget) { swapAttemptsTotal--; triedSwapKeys.add(swapKey); continue; }

            // Temporarily unregister the owner block
            unregisterAssignment(ownerBlock);

            const restoredAb = makeAssigned(
              ownerBlock,
              origDriverId,
              origTarget.driverName,
              'payroll',
              'Niedrigere Entlastung zurück zum Originalfahrer',
              ownerBlock.granularity,
              ownerBlock.originalBlockId,
            );

            // Check restored block doesn't conflict with original driver's current schedule
            const origDriverBlocks = (driverOccupancy.get(origDriverId) ?? [])
              .filter(e => e.date === ownerBlock.date);
            const origDriverConflict = origDriverBlocks.some(e => overlaps(e, ownerBlock));

            if (origDriverConflict) {
              registerAssignment(ownerBlock);
              swapAttemptsTotal--;
              continue;
            }

            // Check vehicle switch buffer for original driver after restoration
            let switchConflict = false;
            if (ownerBlock.vehicleId) {
              const sorted3 = [...origDriverBlocks, restoredAb].sort((a, b) => a.startMin - b.startMin);
              for (let si = 0; si < sorted3.length - 1; si++) {
                const sA = sorted3[si]; const sB = sorted3[si + 1];
                if (sA.vehicleId && sB.vehicleId && sA.vehicleId !== sB.vehicleId) {
                  const g = sB.startMin - sA.endMin;
                  if (g >= 0 && g < MIN_VEHICLE_SWITCH_BUFFER_MINUTES) { switchConflict = true; break; }
                }
              }
            }

            if (switchConflict) {
              registerAssignment(ownerBlock);
              swapAttemptsTotal--;
              continue;
            }

            // Temporarily register restored block under original payroll driver
            registerAssignment(restoredAb);

            // Score BEFORE: compute with current state (candidate still at payroll driver,
            // owner block already unregistered and restored to payroll)
            const scoreBefore = computeOverTargetScore(computeTotals());

            // Try to transfer the over-target candidate to the now-vacated owner slot
            const { newAb: swappedNewAb, reason: swapFailReason } = tryTransferToOwner(
              live,
              'Höher priorisierte Über-Zielwert-Entlastung (Inhaber-Umbuchung)',
              live.granularity,
              live.originalBlockId,
            );

            if (swappedNewAb) {
              const scoreAfter = computeOverTargetScore(computeTotals());
              if (scoreAfter < scoreBefore) {
                // Accept swap — global score improved
                const regS = assignmentMap.get(swappedNewAb.id);
                if (regS) regS.ownerAssignmentPriority = 'critical_over_target_relief';
                swapAcceptedTotal++;
                swapSuccess = true;
                madeAnyTransfer = true;
                globalProgress = true;
                reliefPassTotal++;
                if (live.isEinzelwagenZeit) einzelwagenZeitenToOwner++;

                ownerCapacityEntries.push({
                  blockId: ownerBlock.id,
                  date: ownerBlock.date,
                  startMin: ownerBlock.startMin,
                  endMin: ownerBlock.endMin,
                  kennzeichen: ownerBlock.vehicleKennzeichen,
                  entlastungsGrund: ownerBlock.entlastungsGrund ?? '—',
                  priority: ownerBlock.ownerAssignmentPriority ?? 'normal_optional_relief',
                  conflictingOverTargetCandidateId: live.id,
                  swapAttempted: true,
                  swapAccepted: true,
                  swapReason: 'Inhaber-Umbuchung: niedrigere Entlastung zurück zum Originalfahrer',
                });
                break;
              } else {
                // Score did not improve — full rollback
                unregisterAssignment(swappedNewAb);
                unregisterAssignment(restoredAb);
                registerAssignment(live);
                registerAssignment(ownerBlock);
                triedSwapKeys.add(swapKey);

                ownerCapacityEntries.push({
                  blockId: ownerBlock.id,
                  date: ownerBlock.date,
                  startMin: ownerBlock.startMin,
                  endMin: ownerBlock.endMin,
                  kennzeichen: ownerBlock.vehicleKennzeichen,
                  entlastungsGrund: ownerBlock.entlastungsGrund ?? '—',
                  priority: ownerBlock.ownerAssignmentPriority ?? 'normal_optional_relief',
                  conflictingOverTargetCandidateId: live.id,
                  swapAttempted: true,
                  swapAccepted: false,
                  swapReason: 'Tausch verschlechtert Gesamt-Score',
                });
              }
            } else {
              // Transfer still failed even after freeing owner slot — full rollback
              unregisterAssignment(restoredAb);
              registerAssignment(ownerBlock);
              triedSwapKeys.add(swapKey);

              ownerCapacityEntries.push({
                blockId: ownerBlock.id,
                date: ownerBlock.date,
                startMin: ownerBlock.startMin,
                endMin: ownerBlock.endMin,
                kennzeichen: ownerBlock.vehicleKennzeichen,
                entlastungsGrund: ownerBlock.entlastungsGrund ?? '—',
                priority: ownerBlock.ownerAssignmentPriority ?? 'normal_optional_relief',
                conflictingOverTargetCandidateId: live.id,
                swapAttempted: true,
                swapAccepted: false,
                swapReason: `Inhaber kann Kandidat nach Tausch immer noch nicht übernehmen: ${swapFailReason}`,
              });
            }
          }

          if (!swapSuccess && contribToOver > 0) {
            // Build diagnostic swap reason
            let swapNote = '';
            if (swapCandidates.length === 0) {
              if (immovableConflicts.length > 0) {
                swapNote = `BUG: Inhaber-Überschneidung ohne tauschfähige Einheiten — ${immovableConflicts.length} Einheit(en) sind Original-Inhaber-Fahrten (nicht verschiebbar): ${immovableConflicts.map(x => x.id).join(', ')}`;
              } else if (ownerConflictsForSwap.length === 0) {
                swapNote = 'Keine Inhaber-Einheiten zur gleichen Zeit (Grund unklar — möglicherweise Fahrzeug- oder Pufferkonflikt)';
              } else {
                swapNote = 'Keine tauschfähigen Inhaber-Einheiten gefunden (alle sind kritische Entlastungen)';
              }
            } else {
              swapNote = 'Alle Tauschversuche abgelehnt (Score verbessert sich nicht oder Rückzuweisung nicht möglich)';
            }
            rejectedCandidates.push({
              driverName: live.assignedDriverName,
              overTargetWageCode: worstWageCode,
              overTargetWageLabel: WAGE_LABELS_LOCAL[worstWageCode] ?? worstWageCode,
              overageSec: worstOverageSec,
              blockId: ab.id,
              date: ab.date,
              startMin: ab.startMin,
              endMin: ab.endMin,
              kennzeichen: ab.vehicleKennzeichen,
              contributionSec: contribToOver,
              triedAsSchichtblock: true,
              triedAsEinzelfahrt: ab.tripIds.length > 1,
              swapAttempted: swapCandidates.length > 0,
              swapAccepted: false,
              swapReason: swapNote,
              conflictingOwnerUnits: conflictingIds,
              rejectionReason: blockReason,
              ownerConflictReason: blockReason,
            });
          } else if (swapSuccess) {
            break;
          }
        }

        if (madeAnyTransfer) break;
      }

      if (!madeAnyTransfer || _ctrl.shouldStop()) break;
    }

    // ── Phase B: optional Einzelwagen-Zeit relief ──────────────────────────────
    // ONLY runs after Phase A confirms ALL drivers are at or below every Lohnart target.
    // If any driver remains over any target, Phase B is skipped entirely —
    // optional relief must never consume owner capacity that critical relief needs.
    {
      const totalsB = computeTotals();
      const anyStillOverTarget = targets.some(t => {
        const actual = totalsB.get(t.driverId);
        if (!actual) return false;
        return actual.workSec > t.workSec || actual.nightSec > t.nightSec ||
               actual.sunSec > t.sunSec || actual.holSec > t.holSec;
      });

      if (!anyStillOverTarget) {
        const optionalCandidates: AssignedBlock[] = [];
        for (const ab of assignmentMap.values()) {
          if (ab.role !== 'payroll' || !ab.isEinzelwagenZeit) continue;
          const tgt = targetById.get(ab.assignedDriverId);
          if (!tgt) continue;
          const actual = totalsB.get(ab.assignedDriverId);
          if (!actual) continue;
          if (actual.workSec > tgt.workSec) optionalCandidates.push(ab);
        }
        optionalCandidates.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
        for (const ab of optionalCandidates) {
          const current = assignmentMap.get(ab.id);
          if (!current || current.assignedDriverId !== ab.assignedDriverId) continue;
          const refreshed = computeTotals().get(ab.assignedDriverId);
          const tgt = targetById.get(ab.assignedDriverId);
          if (!tgt || !refreshed || refreshed.workSec <= tgt.workSec) continue;
          const { newAb } = tryTransferToOwner(ab, 'Einzelwagen-Zeit → Inhaber-Entlastung');
          if (newAb) {
            const reg = assignmentMap.get(newAb.id);
            if (reg) reg.ownerAssignmentPriority = 'einzelwagen_optional_relief';
            einzelwagenZeitenToOwner++;
            reliefPassTotal++;
          }
        }
      }
    }
  }

  // Count unresolved over-target blocks
  let unresolvedOverTargetCount = 0;
  {
    const finalTotals = computeTotals();
    for (const t of targets) {
      const actual = finalTotals.get(t.driverId) ?? { workSec: 0, nightSec: 0, sunSec: 0, holSec: 0 };
      if (actual.workSec > t.workSec || actual.nightSec > t.nightSec || actual.sunSec > t.sunSec || actual.holSec > t.holSec) {
        for (const ab of assignmentMap.values()) {
          if (ab.assignedDriverId !== t.driverId || ab.role !== 'payroll') continue;
          if (
            (actual.workSec  > t.workSec  && ab.workSec  > 0) ||
            (actual.nightSec > t.nightSec && ab.nightSec > 0) ||
            (actual.sunSec   > t.sunSec   && ab.sunSec   > 0) ||
            (actual.holSec   > t.holSec   && ab.holSec   > 0)
          ) unresolvedOverTargetCount++;
        }
      }
    }
  }

  // Build owner capacity entries for all owner-assigned blocks not yet in the list
  {
    const ownerEntryIds = new Set(ownerCapacityEntries.map(e => e.blockId));
    for (const ab of assignmentMap.values()) {
      if (ab.role !== 'owner' || ownerEntryIds.has(ab.id)) continue;
      ownerCapacityEntries.push({
        blockId: ab.id,
        date: ab.date,
        startMin: ab.startMin,
        endMin: ab.endMin,
        kennzeichen: ab.vehicleKennzeichen,
        entlastungsGrund: ab.entlastungsGrund ?? '—',
        priority: ab.ownerAssignmentPriority ?? 'normal_optional_relief',
        conflictingOverTargetCandidateId: null,
        swapAttempted: false,
        swapAccepted: false,
        swapReason: '',
      });
    }
    // Sort by date then start
    ownerCapacityEntries.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
  }

  // ── Compute actuals and deviations ────────────────────────────────────────────
  const driverActuals = computeTotals();
  const deviations: PlanningDeviation[] = [];
  const driversOverTarget: string[] = [];
  let negativeCorrectionsRequired = 0;

  for (const t of targets) {
    const actual = driverActuals.get(t.driverId) ?? { workSec: 0, nightSec: 0, sunSec: 0, holSec: 0 };
    let overInAny = false;
    for (const [code, tSec, aSec] of [
      ['1000', t.workSec,  actual.workSec],
      ['1501', t.nightSec, actual.nightSec],
      ['1510', t.sunSec,   actual.sunSec],
      ['1520', t.holSec,   actual.holSec],
    ] as [string, number, number][]) {
      const diffSec = aSec - tSec;
      deviations.push({ driverId: t.driverId, driverName: t.driverName, personalnummer: t.personalnummer, wageCode: code, wageLabel: WAGE_LABELS_LOCAL[code], targetSec: tSec, actualSec: aSec, diffSec });
      if (diffSec > 0) { overInAny = true; negativeCorrectionsRequired++; }
    }
    if (overInAny) driversOverTarget.push(t.driverName);
  }

  // ── Conflict detection ────────────────────────────────────────────────────────
  const allAssigned = [...assignmentMap.values()];
  const conflicts: PlanningConflict[] = [];

  // Baseline hard conflicts (should be 0 for valid Fahrtenbuch data)
  for (const [, dBlocks] of driverOccupancy) {
    const byDate = new Map<string, AssignedBlock[]>();
    for (const b of dBlocks) { if (!byDate.has(b.date)) byDate.set(b.date, []); byDate.get(b.date)!.push(b); }
    for (const [date, dayBlocks] of byDate) {
      for (let i = 0; i < dayBlocks.length; i++) {
        for (let j = i + 1; j < dayBlocks.length; j++) {
          if (overlaps(dayBlocks[i], dayBlocks[j])) {
            conflicts.push({ type: 'driver_overlap', description: `${dayBlocks[i].assignedDriverName}: Überlappung am ${date}`, date });
          }
        }
      }
    }
  }

  for (const [, vBlocks] of vehicleOccupancy) {
    for (let i = 0; i < vBlocks.length; i++) {
      for (let j = i + 1; j < vBlocks.length; j++) {
        if (vBlocks[i].assignedDriverId !== vBlocks[j].assignedDriverId && overlaps(vBlocks[i], vBlocks[j])) {
          conflicts.push({ type: 'vehicle_overlap', description: `Fahrzeug ${vBlocks[i].vehicleKennzeichen ?? vBlocks[i].vehicleId}: Überlappung — ${vBlocks[i].assignedDriverName} / ${vBlocks[j].assignedDriverName}`, date: vBlocks[i].date, kennzeichen: vBlocks[i].vehicleKennzeichen ?? undefined });
        }
      }
    }
  }

  for (const [, dBlocks] of driverOccupancy) {
    const byDate = new Map<string, AssignedBlock[]>();
    for (const b of dBlocks) { if (!byDate.has(b.date)) byDate.set(b.date, []); byDate.get(b.date)!.push(b); }
    for (const [date, dayBlocks] of byDate) {
      const sorted2 = [...dayBlocks].sort((a, b) => a.startMin - b.startMin);
      for (let i = 0; i < sorted2.length - 1; i++) {
        const a = sorted2[i]; const bx = sorted2[i + 1];
        if (a.vehicleId && bx.vehicleId && a.vehicleId !== bx.vehicleId) {
          const gap = bx.startMin - a.endMin;
          if (gap >= 0 && gap < MIN_VEHICLE_SWITCH_BUFFER_MINUTES)
            conflicts.push({ type: 'vehicle_switch', description: `${a.assignedDriverName}: Fahrzeugwechsel am ${date} — Puffer: ${gap} Min.`, date });
        }
      }
    }
  }

  // Data errors (truly missing/invalid source assignments)
  for (const u of dataErrors) {
    if (u.ownerOriginalConflict) {
      conflicts.push({ type: 'unassigned', description: `Ursprünglicher Fahrer unklar: ${u.date} ${minsToTimeStr(u.startMin)}–${minsToTimeStr(u.endMin)} (${u.vehicleKennzeichen ?? 'kein Kfz'}) — Inhaber darf im Ausgangsmonat nicht als Originalfahrer geführt werden`, date: u.date, blockId: u.id, kennzeichen: u.vehicleKennzeichen ?? undefined, originalDriverName: u.sourceDriverName || undefined, reason: 'Ursprünglicher Fahrer unklar, Inhaber darf im Ausgangsmonat nicht Originalfahrer sein' });
    } else {
      conflicts.push({ type: 'unassigned', description: `Quelldatenfehler: ${u.date} ${minsToTimeStr(u.startMin)}–${minsToTimeStr(u.endMin)} (${u.originalDriverName || 'Kein Fahrer'}, ${u.vehicleKennzeichen ?? 'kein Kfz'}) — Ungültige Quelldaten`, date: u.date, blockId: u.id, kennzeichen: u.vehicleKennzeichen ?? undefined, originalDriverName: u.originalDriverName || undefined, reason: 'Quelldatenfehler: fehlender Fahrer oder Null-Dauer' });
    }
  }

  // Over-target drivers → conflict entries (distinct from "Nicht zuweisbar")
  for (const dName of driversOverTarget) {
    const t = targets.find(x => x.driverName === dName);
    const actual = t ? driverActuals.get(t.driverId) : undefined;
    if (t && actual && actual.workSec > t.workSec) {
      conflicts.push({ type: 'unassigned', description: `Über Zielwert, nicht korrigierbar: ${dName} — Ist: ${(actual.workSec / 3600).toFixed(2)} h, Ziel: ${(t.workSec / 3600).toFixed(2)} h`, originalDriverName: dName, reason: 'Über Zielwert, nicht korrigierbar' });
    }
  }

  const vehicleOverlapCount = conflicts.filter(c => c.type === 'vehicle_overlap').length;
  const driverOverlapCount  = conflicts.filter(c => c.type === 'driver_overlap').length;
  const vehicleSwitchCount  = conflicts.filter(c => c.type === 'vehicle_switch').length;
  const isExact = deviations.every(d => d.diffSec === 0);
  const isFinalizable =
    isExact && vehicleOverlapCount === 0 && driverOverlapCount === 0 &&
    vehicleSwitchCount === 0 && dataErrors.length === 0 && driversOverTarget.length === 0 &&
    ownerOriginalCount === 0;

  return {
    assignments: allAssigned,
    unassigned: dataErrors,
    conflicts,
    driverActuals,
    deviations,
    isExact,
    isFinalizable,
    totalBlocks: blocks.length,
    payrollAssigned: allAssigned.filter(a => a.role === 'payroll' && targetById.has(a.assignedDriverId)).length,
    ownerAssigned: allAssigned.filter(a => a.role === 'owner').length,
    unassignedCount: dataErrors.length,
    vehicleOverlapCount,
    driverOverlapCount,
    vehicleSwitchCount,
    granularRetryUsed: false,
    unassignedBeforeRetry: 0,
    granularAssignedCount: 0,
    splitBlockCount: 0,
    einzelwagenZeitenTotal,
    einzelwagenZeitenToOwner,
    reliefPassTotal,
    reliefCandidatesTried,
    reliefGranularTransfers,
    finalAssignmentUnits: allAssigned.length,
    granularEinzelfahrten: allAssigned.filter(a => a.granularity === 'Einzelfahrt').length,
    unresolvedOverTargetCount,
    driversOverTarget,
    negativeCorrectionsRequired,
    ownerOriginalCount,
    rejectedCandidates,
    swapAttemptsTotal,
    swapAcceptedTotal,
    ownerCapacityEntries,
    ownerCriticalReliefCount: allAssigned.filter(a => a.role === 'owner' && a.ownerAssignmentPriority === 'critical_over_target_relief').length,
    ownerOptionalEinzelwagenCount: allAssigned.filter(a => a.role === 'owner' && a.ownerAssignmentPriority === 'einzelwagen_optional_relief').length,
    ownerBaselineCount: allAssigned.filter(a => a.role === 'owner' && !a.ownerAssignmentPriority).length,
    solverLimitReached: _ctrl.limitReached,
    solverCancelled: _ctrl.cancelled,
    solverElapsedMs: performance.now() - _ctrl.startMs,
    solverGranularAttempts: granularAttemptsTotal,
    diagnosticsTruncated,
  };
}
