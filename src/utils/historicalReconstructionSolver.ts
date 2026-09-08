/**
 * Max-Inhaber-Einzelfahrt-Rekonstruktion
 *
 * Reconstructs historical month assignment at the individual Fahrt level.
 * The Inhaber takes as many real Fahrten as possible without hard conflicts.
 * Selected Steuerberater drivers absorb remaining Fahrten without exceeding Zielwerte.
 * Missing target hours are covered by positive correction lines only.
 * No negative corrections, no fake Fahrten, no Fahrtenbuch mutations.
 */

import type { FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
import { normalizeTripServiceDate, timeToMinutes } from './shiftBlockEngine';
import { MIN_VEHICLE_SWITCH_BUFFER_MINUTES } from './carBlockResolver';

// ── Budget constants ──────────────────────────────────────────────────────────
const MAX_SOLVER_MS = 10_000;
const MAX_CANDIDATES = 50_000;
const YIELD_EVERY_MS = 8;

// ── Buffer mode ───────────────────────────────────────────────────────────────
export type HistoricalBufferMode = 'strict' | 'warning' | 'none';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReconstructionUnit {
  fahrtId: string;
  date: string;          // YYYY-MM-DD
  startMin: number;      // minutes from midnight
  endMin: number;
  vehicleId: string | null;
  vehicleKennzeichen: string | null;
  originalDriverId: string | null;
  originalDriverName: string;
  workSec: number;
  nightSec: number;
  night0to4Sec: number;
  sunSec: number;
  holSec: number;
  isOwnerOriginalConflict: boolean;
  priorityScore: number; // higher = assign to Inhaber first
}

export interface ReconstructionAssignment {
  unit: ReconstructionUnit;
  assignedDriverId: string;
  assignedDriverName: string;
  role: 'owner' | 'payroll' | 'zusatzfahrer';
  entlastungsGrund: string;
  bufferWarning: string | null;
}

export interface ReconstructionConflict {
  type: 'unassigned' | 'owner_original' | 'driver_overlap' | 'vehicle_overlap' | 'over_target' | 'buffer_warning';
  fahrtId: string;
  date: string;
  description: string;
}

export interface ReconstructionCorrectionLine {
  driverId: string;
  driverName: string;
  personalnummer: string;
  wageCode: string;
  wageLabel: string;
  targetSec: number;
  planActualSec: number;
  correctionSec: number;
  correctedActualSec: number;
  reason: string;
}

export interface ReconstructionDriverTarget {
  driverId: string;
  driverName: string;
  personalnummer: string;
  workSec: number;
  nightSec: number;
  night0to4Sec: number;
  sunSec: number;
  holSec: number;
  isZusatzfahrer?: boolean;
}

export interface ReconstructionProgress {
  phase: string;
  candidatesTried: number;
  ownerAssigned: number;
  payrollAssigned: number;
  unassigned: number;
  limitReached: boolean;
  cancelled: boolean;
}

export interface ReconstructionController {
  cancel: () => void;
  shouldStop: () => boolean;
  reportProgress: (p: Partial<ReconstructionProgress>) => void;
  yield: () => Promise<void>;
  readonly cancelled: boolean;
  readonly limitReached: boolean;
  readonly startMs: number;
  budget: { candidates: number };
}

export function createReconstructionController(
  onProgress?: (p: ReconstructionProgress) => void,
): ReconstructionController {
  let _cancelled = false;
  let _limitReached = false;
  let _lastYieldMs = performance.now();
  const _startMs = performance.now();
  const _progress: ReconstructionProgress = {
    phase: 'Initialisierung',
    candidatesTried: 0,
    ownerAssigned: 0,
    payrollAssigned: 0,
    unassigned: 0,
    limitReached: false,
    cancelled: false,
  };
  return {
    cancel() { _cancelled = true; _progress.cancelled = true; },
    shouldStop() {
      if (_cancelled) return true;
      if (_limitReached) return true;
      if (performance.now() - _startMs > MAX_SOLVER_MS) { _limitReached = true; _progress.limitReached = true; return true; }
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
    budget: { candidates: MAX_CANDIDATES },
  };
}

export interface ReconstructionResult {
  assignments: ReconstructionAssignment[];
  unassigned: ReconstructionUnit[];
  conflicts: ReconstructionConflict[];
  corrections: ReconstructionCorrectionLine[];
  driverActuals: Map<string, { workSec: number; nightSec: number; night0to4Sec: number; sunSec: number; holSec: number }>;
  driversOverTarget: string[];
  negativeCorrectionsRequired: number;
  // Counts
  totalFahrten: number;
  ownerFahrten: number;
  payrollFahrten: number;
  zusatzfahrerFahrten: number;
  unassignedCount: number;
  ownerOriginalCount: number;
  bufferWarnings: number;
  // Finalization
  isFinalizable: boolean;
  finalizationBlockers: string[];
  // Budget
  solverLimitReached: boolean;
  solverCancelled: boolean;
  solverElapsedMs: number;
  candidatesTried: number;
}

// ── Per-Fahrt time computation ─────────────────────────────────────────────────

function segDurationMin(startMin: number, endMin: number): number {
  return endMin >= startMin ? endMin - startMin : 1440 - startMin + endMin;
}

// Night: 23:00 (1380 min) – 06:00 (360 min next day = 1440+360=1800)
function nightSecsForRange(startMin: number, endMin: number): number {
  const absEnd = endMin >= startMin ? endMin : endMin + 1440;
  // Night window 1: 23:00 – 24:00 (1380 – 1440)
  const seg1 = Math.max(0, Math.min(absEnd, 1440) - Math.max(startMin, 1380));
  // Night window 2: 24:00 – 06:00 (= 1440 – 1800)
  const seg2 = Math.max(0, Math.min(absEnd, 1800) - Math.max(startMin, 1440));
  return (seg1 + seg2) * 60;
}

// Night 0–4: 00:00 (0 min) – 04:00 (240 min)
function night0to4SecsForRange(startMin: number, endMin: number): number {
  const absEnd = endMin >= startMin ? endMin : endMin + 1440;
  // Window: 0–240 (00:00–04:00), plus wrap-around from previous midnight (1440–1680)
  const seg1 = Math.max(0, Math.min(absEnd, 240) - Math.max(startMin, 0));
  const seg2 = Math.max(0, Math.min(absEnd, 1680) - Math.max(startMin, 1440));
  return (seg1 + seg2) * 60;
}

function easterSunday(year: number): Date {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month, day);
}

export function getHolidaysForYear(year: number): Set<string> {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const add = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const easter = easterSunday(year);
  return new Set<string>([
    fmt(new Date(year, 0, 1)),
    fmt(add(easter, -2)),
    fmt(add(easter, 1)),
    fmt(new Date(year, 4, 1)),
    fmt(add(easter, 39)),
    fmt(add(easter, 50)),
    fmt(new Date(year, 9, 3)),
    fmt(new Date(year, 11, 25)),
    fmt(new Date(year, 11, 26)),
  ]);
}

// ── Build reconstruction units ────────────────────────────────────────────────

export function buildReconstructionUnits(
  trips: FahrtenbuchTrip[],
  holidays: Set<string>,
  ownerDriverId: string | null,
  excludeOwnerAsSource: boolean,
): ReconstructionUnit[] {
  const units: ReconstructionUnit[] = [];

  for (const trip of trips) {
    if (trip.is_canceled) continue;
    if (!trip.start_time || !trip.end_time) continue;

    // Use normalizeTripServiceDate to handle cross-midnight and actual-start-date
    const normalized = normalizeTripServiceDate(trip);
    if (normalized.length === 0) continue;

    // For reconstruction we use the primary normalized segment (first one after any split)
    const seg = normalized[0];
    const dateStr = seg.serviceDate;
    const dateObj = new Date(dateStr + 'T12:00:00');
    const isSun = dateObj.getDay() === 0;
    const isHol = holidays.has(dateStr);

    const startMin = timeToMinutes(seg.original.start_time);
    const endMin = timeToMinutes(seg.original.end_time);
    const durMin = segDurationMin(startMin, endMin);
    if (durMin <= 0) continue;

    const workSec = durMin * 60;
    const nightSec = nightSecsForRange(startMin, endMin);
    const night0to4Sec = night0to4SecsForRange(startMin, endMin);
    const sunSec = (isSun && !isHol) ? workSec : 0;
    const holSec = isHol ? workSec : 0;

    // Resolve source driver
    const srcId = trip.original_driver_id ?? null;
    const srcName = trip.original_driver_name || 'Unbekannt';
    const assignedId = trip.assigned_driver_id ?? null;
    const assignedName = trip.assigned_driver_name || '';

    let effectiveDriverId: string | null;
    let effectiveDriverName: string;
    let isOwnerOriginalConflict = false;

    if (excludeOwnerAsSource && ownerDriverId) {
      if (srcId && srcId !== ownerDriverId) {
        effectiveDriverId = srcId;
        effectiveDriverName = srcName;
      } else if (assignedId && assignedId !== ownerDriverId) {
        effectiveDriverId = assignedId;
        effectiveDriverName = assignedName;
      } else {
        effectiveDriverId = null;
        effectiveDriverName = srcName || 'Unbekannt';
        isOwnerOriginalConflict = true;
      }
    } else {
      effectiveDriverId = assignedId || srcId || null;
      effectiveDriverName = (assignedId ? assignedName : '') || srcName || 'Unbekannt';
    }

    // Priority score: higher score → assign to Inhaber first
    // Holiday > Sunday > Night > Normal; then by duration
    let priorityScore = durMin;
    if (holSec > 0) priorityScore += 100_000;
    else if (sunSec > 0) priorityScore += 50_000;
    else if (nightSec > 0) priorityScore += 20_000;

    units.push({
      fahrtId: trip.id,
      date: dateStr,
      startMin,
      endMin,
      vehicleId: trip.car_id ?? null,
      vehicleKennzeichen: trip.car_identifier ?? null,
      originalDriverId: effectiveDriverId,
      originalDriverName: effectiveDriverName,
      workSec,
      nightSec,
      night0to4Sec,
      sunSec,
      holSec,
      isOwnerOriginalConflict,
      priorityScore,
    });
  }

  // Sort by priority descending, then date/start/id for determinism
  units.sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return a.fahrtId < b.fahrtId ? -1 : 1;
  });

  return units;
}

// ── Occupancy tracking ────────────────────────────────────────────────────────

interface OccupancyEntry {
  fahrtId: string;
  date: string;
  startMin: number;
  endMin: number;
  vehicleKennzeichen: string | null;
}

class DriverOccupancy {
  private entries = new Map<string, OccupancyEntry[]>(); // driverId → entries

  getEntries(driverId: string): OccupancyEntry[] {
    return this.entries.get(driverId) ?? [];
  }

  add(driverId: string, entry: OccupancyEntry) {
    if (!this.entries.has(driverId)) this.entries.set(driverId, []);
    this.entries.get(driverId)!.push(entry);
  }

  remove(driverId: string, fahrtId: string) {
    const list = this.entries.get(driverId);
    if (!list) return;
    const idx = list.findIndex(e => e.fahrtId === fahrtId);
    if (idx >= 0) list.splice(idx, 1);
  }

  hasDriverOverlap(driverId: string, unit: ReconstructionUnit): boolean {
    const list = this.entries.get(driverId);
    if (!list) return false;
    for (const e of list) {
      if (e.date !== unit.date) continue;
      if (e.startMin < unit.endMin && unit.startMin < e.endMin) return true;
    }
    return false;
  }

  hasVehicleOverlap(
    driverId: string,
    unit: ReconstructionUnit,
    allOccupancy: Map<string, OccupancyEntry[]>,
  ): boolean {
    if (!unit.vehicleKennzeichen) return false;
    for (const [dId, list] of allOccupancy) {
      if (dId === driverId) continue;
      for (const e of list) {
        if (e.date !== unit.date) continue;
        if (e.vehicleKennzeichen !== unit.vehicleKennzeichen) continue;
        if (e.startMin < unit.endMin && unit.startMin < e.endMin) return true;
      }
    }
    return false;
  }

  checkBufferViolation(
    driverId: string,
    unit: ReconstructionUnit,
    mode: HistoricalBufferMode,
  ): { blocked: boolean; warning: string | null } {
    if (mode === 'none') return { blocked: false, warning: null };
    const list = this.entries.get(driverId);
    if (!list) return { blocked: false, warning: null };
    const buf = MIN_VEHICLE_SWITCH_BUFFER_MINUTES;
    for (const e of list) {
      if (e.date !== unit.date) continue;
      if (!e.vehicleKennzeichen || !unit.vehicleKennzeichen) continue;
      if (e.vehicleKennzeichen === unit.vehicleKennzeichen) continue;
      const gap1 = unit.startMin - e.endMin;
      const gap2 = e.startMin - unit.endMin;
      if (gap1 >= 0 && gap1 < buf) {
        const msg = `Fahrzeugwechsel-Puffer verletzt: ${e.vehicleKennzeichen}→${unit.vehicleKennzeichen} (${gap1} min Abstand, Mindest: ${buf} min)`;
        return mode === 'strict' ? { blocked: true, warning: msg } : { blocked: false, warning: msg };
      }
      if (gap2 >= 0 && gap2 < buf) {
        const msg = `Fahrzeugwechsel-Puffer verletzt: ${unit.vehicleKennzeichen}→${e.vehicleKennzeichen} (${gap2} min Abstand, Mindest: ${buf} min)`;
        return mode === 'strict' ? { blocked: true, warning: msg } : { blocked: false, warning: msg };
      }
    }
    return { blocked: false, warning: null };
  }

  get allEntries(): Map<string, OccupancyEntry[]> {
    return this.entries;
  }
}

// ── Totals tracking ───────────────────────────────────────────────────────────

class DriverTotals {
  private totals = new Map<string, { workSec: number; nightSec: number; night0to4Sec: number; sunSec: number; holSec: number }>();

  get(driverId: string) {
    return this.totals.get(driverId) ?? { workSec: 0, nightSec: 0, night0to4Sec: 0, sunSec: 0, holSec: 0 };
  }

  add(driverId: string, unit: ReconstructionUnit) {
    const t = this.get(driverId);
    this.totals.set(driverId, {
      workSec: t.workSec + unit.workSec,
      nightSec: t.nightSec + unit.nightSec,
      night0to4Sec: t.night0to4Sec + unit.night0to4Sec,
      sunSec: t.sunSec + unit.sunSec,
      holSec: t.holSec + unit.holSec,
    });
  }

  subtract(driverId: string, unit: ReconstructionUnit) {
    const t = this.get(driverId);
    this.totals.set(driverId, {
      workSec: Math.max(0, t.workSec - unit.workSec),
      nightSec: Math.max(0, t.nightSec - unit.nightSec),
      night0to4Sec: Math.max(0, t.night0to4Sec - unit.night0to4Sec),
      sunSec: Math.max(0, t.sunSec - unit.sunSec),
      holSec: Math.max(0, t.holSec - unit.holSec),
    });
  }

  wouldExceedTarget(driverId: string, unit: ReconstructionUnit, target: ReconstructionDriverTarget): boolean {
    const t = this.get(driverId);
    return (
      (unit.workSec > 0 && t.workSec + unit.workSec > target.workSec) ||
      (unit.nightSec > 0 && t.nightSec + unit.nightSec > target.nightSec) ||
      (unit.night0to4Sec > 0 && t.night0to4Sec + unit.night0to4Sec > target.night0to4Sec) ||
      (unit.sunSec > 0 && t.sunSec + unit.sunSec > target.sunSec) ||
      (unit.holSec > 0 && t.holSec + unit.holSec > target.holSec)
    );
  }

  remainingCapacity(driverId: string, target: ReconstructionDriverTarget) {
    const t = this.get(driverId);
    return {
      workSec: Math.max(0, target.workSec - t.workSec),
      nightSec: Math.max(0, target.nightSec - t.nightSec),
      night0to4Sec: Math.max(0, target.night0to4Sec - t.night0to4Sec),
      sunSec: Math.max(0, target.sunSec - t.sunSec),
      holSec: Math.max(0, target.holSec - t.holSec),
    };
  }

  asMap(): Map<string, { workSec: number; nightSec: number; night0to4Sec: number; sunSec: number; holSec: number }> {
    return new Map(this.totals);
  }
}

// ── Best-fit driver selection ─────────────────────────────────────────────────

function bestFitDriver(
  unit: ReconstructionUnit,
  targets: ReconstructionDriverTarget[],
  totals: DriverTotals,
  occupancy: DriverOccupancy,
  bufferMode: HistoricalBufferMode,
): { driverId: string; driverName: string; bufferWarning: string | null } | null {
  let bestDriver: ReconstructionDriverTarget | null = null;
  let bestScore = -Infinity;
  let bestWarning: string | null = null;

  for (const target of targets) {
    if (totals.wouldExceedTarget(target.driverId, unit, target)) continue;
    if (occupancy.hasDriverOverlap(target.driverId, unit)) continue;
    if (occupancy.hasVehicleOverlap(target.driverId, unit, occupancy.allEntries)) continue;
    const { blocked, warning } = occupancy.checkBufferViolation(target.driverId, unit, bufferMode);
    if (blocked) continue;

    const capacity = totals.remainingCapacity(target.driverId, target);

    // Prefer driver whose capacity best matches what this Fahrt contributes
    // (minimize leftover waste on rare components)
    let score = 0;
    if (unit.holSec > 0 && capacity.holSec >= unit.holSec) score += 40;
    if (unit.sunSec > 0 && capacity.sunSec >= unit.sunSec) score += 20;
    if (unit.nightSec > 0 && capacity.nightSec >= unit.nightSec) score += 10;
    if (unit.night0to4Sec > 0 && capacity.night0to4Sec >= unit.night0to4Sec) score += 8;
    if (unit.workSec > 0 && capacity.workSec >= unit.workSec) score += 5;
    // Prefer driver with less remaining capacity (closer to target = better fit)
    score -= capacity.workSec / 3600;

    if (score > bestScore) {
      bestScore = score;
      bestDriver = target;
      bestWarning = warning;
    }
  }

  if (!bestDriver) return null;
  return { driverId: bestDriver.driverId, driverName: bestDriver.driverName, bufferWarning: bestWarning };
}

// ── Main solver ───────────────────────────────────────────────────────────────

const WAGE_LABELS: Record<string, string> = {
  '1000': 'Stundenlohn',
  '1501': 'Nachtzuschlag, 40% frei',
  '1502': 'Nacht 0–4 Uhr',
  '1510': 'Sonntagszuschlag, 50% frei',
  '1520': 'Feiertagszuschlag, 125% frei',
};

export async function runReconstructionSolver(
  trips: FahrtenbuchTrip[],
  targets: ReconstructionDriverTarget[],
  ownerDriverId: string | null,
  ownerDriverName: string,
  holidays: Set<string>,
  excludeOwnerAsSource: boolean,
  bufferMode: HistoricalBufferMode,
  ctrl?: ReconstructionController,
): Promise<ReconstructionResult> {
  const _ctrl = ctrl ?? createReconstructionController();
  const targetById = new Map(targets.map(t => [t.driverId, t]));

  // Build Fahrt-level units
  const units = buildReconstructionUnits(trips, holidays, ownerDriverId, excludeOwnerAsSource);

  const occupancy = new DriverOccupancy();
  const totals = new DriverTotals();
  const assignments = new Map<string, ReconstructionAssignment>(); // fahrtId → assignment

  // Initialize owner occupancy from all trips where owner was the original source
  // (baseline owner Fahrten — if not excluded)
  // We do NOT pre-assign; every Fahrt goes through the solver.

  const ownerConflictUnits = units.filter(u => u.isOwnerOriginalConflict);
  const assignableUnits = units.filter(u => !u.isOwnerOriginalConflict);

  let candidatesTried = 0;

  // ── Phase 1: Assign to Inhaber first ──────────────────────────────────────
  _ctrl.reportProgress({ phase: 'Phase 1 — Inhaber-Zuweisung', candidatesTried: 0 });

  const remaining: ReconstructionUnit[] = [];

  for (const unit of assignableUnits) {
    if (_ctrl.shouldStop() || _ctrl.budget.candidates <= 0) {
      remaining.push(unit);
      continue;
    }
    _ctrl.budget.candidates--;
    candidatesTried++;
    await _ctrl.yield();

    if (!ownerDriverId) {
      remaining.push(unit);
      continue;
    }

    // Check owner conflicts
    if (occupancy.hasDriverOverlap(ownerDriverId, unit)) {
      remaining.push(unit);
      continue;
    }
    if (occupancy.hasVehicleOverlap(ownerDriverId, unit, occupancy.allEntries)) {
      remaining.push(unit);
      continue;
    }
    const { blocked: bufBlocked, warning: bufWarning } = occupancy.checkBufferViolation(ownerDriverId, unit, bufferMode);
    if (bufBlocked) {
      remaining.push(unit);
      continue;
    }

    // Assign to owner
    const entry: OccupancyEntry = {
      fahrtId: unit.fahrtId,
      date: unit.date,
      startMin: unit.startMin,
      endMin: unit.endMin,
      vehicleKennzeichen: unit.vehicleKennzeichen,
    };
    occupancy.add(ownerDriverId, entry);
    assignments.set(unit.fahrtId, {
      unit,
      assignedDriverId: ownerDriverId,
      assignedDriverName: ownerDriverName,
      role: 'owner',
      entlastungsGrund: 'Inhaber-Zuweisung',
      bufferWarning: bufWarning,
    });

    if (candidatesTried % 200 === 0) {
      _ctrl.reportProgress({
        phase: 'Phase 1 — Inhaber-Zuweisung',
        candidatesTried,
        ownerAssigned: assignments.size,
      });
    }
  }

  // ── Phase 2: Assign remaining to best-fit Steuerberater driver ────────────
  _ctrl.reportProgress({ phase: 'Phase 2 — Steuerberater-Zuweisung', candidatesTried });

  const stillRemaining: ReconstructionUnit[] = [];

  for (const unit of remaining) {
    if (_ctrl.shouldStop() || _ctrl.budget.candidates <= 0) {
      stillRemaining.push(unit);
      continue;
    }
    _ctrl.budget.candidates--;
    candidatesTried++;
    await _ctrl.yield();

    const fit = bestFitDriver(unit, targets, totals, occupancy, bufferMode);
    if (!fit) {
      stillRemaining.push(unit);
      continue;
    }

    const entry: OccupancyEntry & { fahrtId: string } = {
      fahrtId: unit.fahrtId,
      date: unit.date,
      startMin: unit.startMin,
      endMin: unit.endMin,
      vehicleKennzeichen: unit.vehicleKennzeichen,
    };
    occupancy.add(fit.driverId, entry);
    totals.add(fit.driverId, unit);
    const isZusatz = targetById.get(fit.driverId)?.isZusatzfahrer ?? false;
    assignments.set(unit.fahrtId, {
      unit,
      assignedDriverId: fit.driverId,
      assignedDriverName: fit.driverName,
      role: isZusatz ? 'zusatzfahrer' : 'payroll',
      entlastungsGrund: isZusatz ? 'Historische Zusatzfahrer-Rekonstruktion' : 'Steuerberater-Zuweisung',
      bufferWarning: fit.bufferWarning,
    });

    if (candidatesTried % 200 === 0) {
      _ctrl.reportProgress({
        phase: 'Phase 2 — Steuerberater-Zuweisung',
        candidatesTried,
        payrollAssigned: totals.asMap().size,
      });
    }
  }

  // ── Phase 3: Bounded repair pass ─────────────────────────────────────────
  // For each still-unassigned unit, try to move a lower-priority owner Fahrt
  // back to a payroll driver to free up owner capacity.
  _ctrl.reportProgress({ phase: 'Phase 3 — Reparatur-Pass', candidatesTried });

  const repairUnassigned: ReconstructionUnit[] = [];
  const MAX_REPAIR_ATTEMPTS = 2000;
  let repairAttempts = 0;

  for (const unit of stillRemaining) {
    if (_ctrl.shouldStop() || repairAttempts >= MAX_REPAIR_ATTEMPTS) {
      repairUnassigned.push(unit);
      continue;
    }

    if (!ownerDriverId) {
      repairUnassigned.push(unit);
      continue;
    }

    // Find an owner-assigned Fahrt with LOWER priority that a payroll driver could absorb
    let repaired = false;
    const ownerAssignedUnits = [...assignments.values()]
      .filter(a => a.assignedDriverId === ownerDriverId && a.unit.priorityScore < unit.priorityScore)
      .sort((a, b) => a.unit.priorityScore - b.unit.priorityScore);

    for (const candidate of ownerAssignedUnits) {
      repairAttempts++;
      if (_ctrl.shouldStop() || repairAttempts >= MAX_REPAIR_ATTEMPTS) break;
      await _ctrl.yield();

      // Try to give the candidate's unit to a payroll driver
      // Temporarily remove candidate from owner's occupancy
      (occupancy as DriverOccupancy).remove(ownerDriverId, candidate.unit.fahrtId);
      totals.subtract(ownerDriverId, candidate.unit); // owner has no target so this is cosmetic

      const fit = bestFitDriver(candidate.unit, targets, totals, occupancy, bufferMode);
      if (!fit) {
        // Can't place candidate on any payroll driver — restore
        const restoreEntry: OccupancyEntry & { fahrtId: string } = {
          fahrtId: candidate.unit.fahrtId,
          date: candidate.unit.date,
          startMin: candidate.unit.startMin,
          endMin: candidate.unit.endMin,
          vehicleKennzeichen: candidate.unit.vehicleKennzeichen,
        };
        occupancy.add(ownerDriverId, restoreEntry);
        continue;
      }

      // Now check if owner can take the high-priority unit
      if (
        occupancy.hasDriverOverlap(ownerDriverId, unit) ||
        occupancy.hasVehicleOverlap(ownerDriverId, unit, occupancy.allEntries)
      ) {
        // Still blocked — restore
        const restoreEntry: OccupancyEntry & { fahrtId: string } = {
          fahrtId: candidate.unit.fahrtId,
          date: candidate.unit.date,
          startMin: candidate.unit.startMin,
          endMin: candidate.unit.endMin,
          vehicleKennzeichen: candidate.unit.vehicleKennzeichen,
        };
        occupancy.add(ownerDriverId, restoreEntry);
        totals.subtract(fit.driverId, candidate.unit);
        continue;
      }

      // Buffer check for owner
      const { blocked: ownerBufBlocked } = occupancy.checkBufferViolation(ownerDriverId, unit, bufferMode);
      if (ownerBufBlocked) {
        const restoreEntry: OccupancyEntry & { fahrtId: string } = {
          fahrtId: candidate.unit.fahrtId,
          date: candidate.unit.date,
          startMin: candidate.unit.startMin,
          endMin: candidate.unit.endMin,
          vehicleKennzeichen: candidate.unit.vehicleKennzeichen,
        };
        occupancy.add(ownerDriverId, restoreEntry);
        totals.subtract(fit.driverId, candidate.unit);
        continue;
      }

      // Accept the repair
      // Move candidate's unit to payroll driver
      const payrollEntry: OccupancyEntry & { fahrtId: string } = {
        fahrtId: candidate.unit.fahrtId,
        date: candidate.unit.date,
        startMin: candidate.unit.startMin,
        endMin: candidate.unit.endMin,
        vehicleKennzeichen: candidate.unit.vehicleKennzeichen,
      };
      occupancy.add(fit.driverId, payrollEntry);
      totals.add(fit.driverId, candidate.unit);
      const isCandZusatz = targetById.get(fit.driverId)?.isZusatzfahrer ?? false;
      assignments.set(candidate.unit.fahrtId, {
        unit: candidate.unit,
        assignedDriverId: fit.driverId,
        assignedDriverName: fit.driverName,
        role: isCandZusatz ? 'zusatzfahrer' : 'payroll',
        entlastungsGrund: isCandZusatz ? 'Reparatur-Pass: Historische Zusatzfahrer-Rekonstruktion' : 'Reparatur-Pass: Umzuweisung',
        bufferWarning: fit.bufferWarning,
      });

      // Now assign high-priority unit to owner
      const { warning: ownerBufWarning } = occupancy.checkBufferViolation(ownerDriverId, unit, bufferMode);
      const ownerEntry: OccupancyEntry & { fahrtId: string } = {
        fahrtId: unit.fahrtId,
        date: unit.date,
        startMin: unit.startMin,
        endMin: unit.endMin,
        vehicleKennzeichen: unit.vehicleKennzeichen,
      };
      occupancy.add(ownerDriverId, ownerEntry);
      assignments.set(unit.fahrtId, {
        unit,
        assignedDriverId: ownerDriverId,
        assignedDriverName: ownerDriverName,
        role: 'owner',
        entlastungsGrund: 'Reparatur-Pass: Inhaber-Zuweisung',
        bufferWarning: ownerBufWarning,
      });

      repaired = true;
      break;
    }

    if (!repaired) {
      // Last chance: try payroll directly
      const fit = bestFitDriver(unit, targets, totals, occupancy, bufferMode);
      if (fit) {
        const entry: OccupancyEntry & { fahrtId: string } = {
          fahrtId: unit.fahrtId,
          date: unit.date,
          startMin: unit.startMin,
          endMin: unit.endMin,
          vehicleKennzeichen: unit.vehicleKennzeichen,
        };
        occupancy.add(fit.driverId, entry);
        totals.add(fit.driverId, unit);
        const isFallbackZusatz = targetById.get(fit.driverId)?.isZusatzfahrer ?? false;
        assignments.set(unit.fahrtId, {
          unit,
          assignedDriverId: fit.driverId,
          assignedDriverName: fit.driverName,
          role: isFallbackZusatz ? 'zusatzfahrer' : 'payroll',
          entlastungsGrund: isFallbackZusatz ? 'Reparatur-Pass: Historische Zusatzfahrer-Fallback' : 'Reparatur-Pass: Steuerberater-Fallback',
          bufferWarning: fit.bufferWarning,
        });
      } else {
        repairUnassigned.push(unit);
      }
    }
  }

  _ctrl.reportProgress({
    phase: 'Abschluss',
    candidatesTried,
    unassigned: repairUnassigned.length + ownerConflictUnits.length,
  });

  // ── Build conflicts ────────────────────────────────────────────────────────
  const conflicts: ReconstructionConflict[] = [];

  for (const unit of ownerConflictUnits) {
    conflicts.push({
      type: 'owner_original',
      fahrtId: unit.fahrtId,
      date: unit.date,
      description: `Inhaber-Originalkonflikt: Einziger bekannter Fahrer ist der Inhaber (Ausschluss aktiv). Quelldaten prüfen.`,
    });
  }

  for (const unit of repairUnassigned) {
    conflicts.push({
      type: 'unassigned',
      fahrtId: unit.fahrtId,
      date: unit.date,
      description: `Fahrt nicht zuweisbar: kein passender Fahrer gefunden (Kapazität erschöpft oder Konflikte).`,
    });
  }

  const bufferWarningConflicts: ReconstructionConflict[] = [];
  for (const [, asgn] of assignments) {
    if (asgn.bufferWarning) {
      bufferWarningConflicts.push({
        type: 'buffer_warning',
        fahrtId: asgn.unit.fahrtId,
        date: asgn.unit.date,
        description: asgn.bufferWarning,
      });
    }
  }
  conflicts.push(...bufferWarningConflicts);

  // ── Build driver actuals & corrections ────────────────────────────────────
  const driverActuals = totals.asMap();
  const corrections: ReconstructionCorrectionLine[] = [];
  const driversOverTarget: string[] = [];
  let negativeCorrectionsRequired = 0;

  for (const target of targets) {
    const actual = driverActuals.get(target.driverId) ?? { workSec: 0, nightSec: 0, night0to4Sec: 0, sunSec: 0, holSec: 0 };
    const codes: Array<{ code: string; label: string; actual: number; target: number }> = [
      { code: '1000', label: WAGE_LABELS['1000'], actual: actual.workSec, target: target.workSec },
      { code: '1501', label: WAGE_LABELS['1501'], actual: actual.nightSec, target: target.nightSec },
      { code: '1502', label: WAGE_LABELS['1502'], actual: actual.night0to4Sec, target: target.night0to4Sec },
      { code: '1510', label: WAGE_LABELS['1510'], actual: actual.sunSec, target: target.sunSec },
      { code: '1520', label: WAGE_LABELS['1520'], actual: actual.holSec, target: target.holSec },
    ];

    let isOverTarget = false;
    for (const { code, label, actual: actualSec, target: targetSec } of codes) {
      if (targetSec === 0) continue;
      const diff = actualSec - targetSec;
      if (diff < -1) {
        // Under target → positive correction
        corrections.push({
          driverId: target.driverId,
          driverName: target.driverName,
          personalnummer: target.personalnummer,
          wageCode: code,
          wageLabel: label,
          targetSec,
          planActualSec: actualSec,
          correctionSec: targetSec - actualSec,
          correctedActualSec: targetSec,
          reason: 'Historische Korrektur laut übermittelter Steuerberater-Werte',
        });
      } else if (diff > 1) {
        // Over target → cannot correct with negative line
        isOverTarget = true;
        negativeCorrectionsRequired++;
        conflicts.push({
          type: 'over_target',
          fahrtId: '',
          date: '',
          description: `${target.driverName} überschreitet Zielwert für Lohnart ${code} (${label}): Ist ${(actualSec / 3600).toFixed(2)} h > Ziel ${(targetSec / 3600).toFixed(2)} h. Nicht korrigierbar ohne negative Zeile.`,
        });
      }
    }

    if (isOverTarget && !driversOverTarget.includes(target.driverName)) {
      driversOverTarget.push(target.driverName);
    }
  }

  // ── Finalization check ────────────────────────────────────────────────────
  const finalizationBlockers: string[] = [];
  const totalUnassigned = repairUnassigned.length + ownerConflictUnits.length;

  if (totalUnassigned > 0)
    finalizationBlockers.push(`${totalUnassigned} Fahrt(en) nicht zugewiesen`);
  if (ownerConflictUnits.length > 0)
    finalizationBlockers.push(`${ownerConflictUnits.length} Inhaber-Originalkonflikt(e)`);
  if (driversOverTarget.length > 0)
    finalizationBlockers.push(`Fahrer über Zielwert: ${driversOverTarget.join(', ')}`);
  if (negativeCorrectionsRequired > 0)
    finalizationBlockers.push(`${negativeCorrectionsRequired} negative Korrekturen erforderlich`);
  if (bufferWarningConflicts.length > 0 && bufferMode === 'strict')
    finalizationBlockers.push(`${bufferWarningConflicts.length} Fahrzeugwechsel-Puffer-Verletzung(en)`);
  if (_ctrl.limitReached || _ctrl.cancelled)
    finalizationBlockers.push('Berechnungslimit oder Abbruch — Ergebnis unvollständig');

  // Verify all corrections align with targets; also check strict 0,00
  const correctionsByDriverCode = new Map<string, number>();
  for (const c of corrections) {
    correctionsByDriverCode.set(`${c.driverId}|${c.wageCode}`, c.correctedActualSec);
  }
  for (const target of targets) {
    for (const [code, targetSec] of [
      ['1000', target.workSec], ['1501', target.nightSec], ['1502', target.night0to4Sec],
      ['1510', target.sunSec], ['1520', target.holSec],
    ] as [string, number][]) {
      const actual = driverActuals.get(target.driverId)?.[
        code === '1000' ? 'workSec' : code === '1501' ? 'nightSec' : code === '1502' ? 'night0to4Sec' : code === '1510' ? 'sunSec' : 'holSec'
      ] ?? 0;
      const corrected = correctionsByDriverCode.get(`${target.driverId}|${code}`) ?? actual;
      if (targetSec === 0) {
        // Strict: when Zielwert is 0, Plan-Ist must also be 0
        if (actual > 1) {
          finalizationBlockers.push(
            `${target.driverName} Lohnart ${code}: Zielwert 0,00 aber Plan-Ist ${(actual / 3600).toFixed(2)} h — nicht korrigierbar ohne negative Zeile.`
          );
        }
      } else if (Math.abs(corrected - targetSec) > 1) {
        finalizationBlockers.push(
          `${target.driverName} Lohnart ${code}: korrigierter Ist-Wert (${(corrected / 3600).toFixed(2)} h) ≠ Ziel (${(targetSec / 3600).toFixed(2)} h)`
        );
      }
    }
  }

  const isFinalizable = finalizationBlockers.length === 0;

  const allAssignments = [...assignments.values()];
  const ownerFahrten = allAssignments.filter(a => a.role === 'owner').length;
  const zusatzfahrerFahrten = allAssignments.filter(a => a.role === 'zusatzfahrer').length;
  const payrollFahrten = allAssignments.filter(a => a.role === 'payroll').length;

  return {
    assignments: allAssignments,
    unassigned: [...repairUnassigned, ...ownerConflictUnits],
    conflicts,
    corrections,
    driverActuals,
    driversOverTarget,
    negativeCorrectionsRequired,
    totalFahrten: units.length,
    ownerFahrten,
    payrollFahrten,
    zusatzfahrerFahrten,
    unassignedCount: totalUnassigned,
    ownerOriginalCount: ownerConflictUnits.length,
    bufferWarnings: bufferWarningConflicts.length,
    isFinalizable,
    finalizationBlockers,
    solverLimitReached: _ctrl.limitReached,
    solverCancelled: _ctrl.cancelled,
    solverElapsedMs: performance.now() - _ctrl.startMs,
    candidatesTried,
  };
}
