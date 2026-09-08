import { groupRidesIntoBlocks, minutesToTime, type NormalizedTrip } from './shiftBlockEngine';

// ─── Constants ──────────────────────────────────────────────────────────────

export const MIN_VEHICLE_SWITCH_BUFFER_MINUTES = 60;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PoolDriver {
  id: string;
  name: string;
  hourlyRate: number | null;
  targetSalary: number | null;
  currentMonthMinutes: number;
}

export interface CarBlock {
  blockId: string;
  carId: string;
  kennzeichen: string;
  date: string;
  startMin: number;
  endMin: number;
  tripIds: string[];
}

export interface ResolvedBlock extends CarBlock {
  assignedDriverId: string;
  assignedDriverName: string;
  reason: string;
}

export interface UnresolvedBlock extends CarBlock {
  reason: string;
  triedDrivers: Array<{ driverId: string; driverName: string; rejectReason: string }>;
}

export interface DriverWorkloadEntry {
  carId: string;
  kennzeichen: string;
  date: string;
  startMin: number;
  endMin: number;
}

export interface CarBlockResolverResult {
  resolved: ResolvedBlock[];
  unresolved: UnresolvedBlock[];
  driverWorkload: Map<string, DriverWorkloadEntry[]>;
}

// ─── Trip Assignment (per-trip resolved metadata) ───────────────────────────

export interface TripAssignment {
  tripId: string;
  originalTripId: string;
  resolvedDriverId: string | null;
  resolvedDriverName: string | null;
  resolvedVehicleId: string;
  resolvedVehicleKennzeichen: string;
  resolvedBlockId: string;
  assignmentSource: 'car_block_resolver';
  assignmentReason: string;
  assignmentStatus: 'resolved' | 'unresolved';
  date: string;
  startMin: number;
  endMin: number;
}

// ─── Validation types ───────────────────────────────────────────────────────

export interface ValidationViolation {
  type: 'driver_overlap' | 'vehicle_switch_buffer' | 'vehicle_overlap' | 'same_vehicle_conflict';
  driverName?: string;
  driverId?: string;
  vehicleKennzeichen?: string;
  details: string;
}

export interface ResolvedFahrtenbuchValidation {
  totalTrips: number;
  resolvedTrips: number;
  unresolvedTrips: number;
  driverOverlaps: ValidationViolation[];
  vehicleSwitchViolations: ValidationViolation[];
  vehicleOverlaps: ValidationViolation[];
  sameVehicleConflicts: ValidationViolation[];
  isClean: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeBlockId(carId: string, date: string, startMin: number): string {
  return `blk_${carId.slice(0, 8)}_${date}_${startMin}`;
}

function dateToAbsoluteMinutes(date: string, minuteOfDay: number): number {
  const [y, m, d] = date.split('-').map(Number);
  const daysSinceEpoch = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  return daysSinceEpoch * 1440 + minuteOfDay;
}

function absOverlap(
  a: { date: string; startMin: number; endMin: number },
  b: { date: string; startMin: number; endMin: number },
): boolean {
  const aStart = dateToAbsoluteMinutes(a.date, a.startMin);
  const aEnd = dateToAbsoluteMinutes(a.date, a.endMin);
  const bStart = dateToAbsoluteMinutes(b.date, b.startMin);
  const bEnd = dateToAbsoluteMinutes(b.date, b.endMin);
  return aStart < bEnd && bStart < aEnd;
}

function violatesVehicleSwitchBuffer(
  existing: DriverWorkloadEntry[],
  candidate: { date: string; startMin: number; endMin: number; carId: string },
  bufferMinutes: number,
): { violates: boolean; reason: string } {
  const candStart = dateToAbsoluteMinutes(candidate.date, candidate.startMin);
  const candEnd = dateToAbsoluteMinutes(candidate.date, candidate.endMin);

  for (const entry of existing) {
    if (entry.carId === candidate.carId) continue;

    const entStart = dateToAbsoluteMinutes(entry.date, entry.startMin);
    const entEnd = dateToAbsoluteMinutes(entry.date, entry.endMin);

    const gapAfter = candStart - entEnd;
    const gapBefore = entStart - candEnd;

    if (gapAfter >= 0 && gapAfter < bufferMinutes) {
      return {
        violates: true,
        reason: `Fahrzeugwechsel-Puffer verletzt: nur ${gapAfter} Min. zwischen ${entry.kennzeichen} und neuem Block (min. ${bufferMinutes} Min.)`,
      };
    }
    if (gapBefore >= 0 && gapBefore < bufferMinutes) {
      return {
        violates: true,
        reason: `Fahrzeugwechsel-Puffer verletzt: nur ${gapBefore} Min. zwischen neuem Block und ${entry.kennzeichen} (min. ${bufferMinutes} Min.)`,
      };
    }
  }
  return { violates: false, reason: '' };
}

function countVehicleSwitches(entries: DriverWorkloadEntry[]): number {
  if (entries.length <= 1) return 0;
  const sorted = [...entries].sort((a, b) =>
    dateToAbsoluteMinutes(a.date, a.startMin) - dateToAbsoluteMinutes(b.date, b.startMin),
  );
  let switches = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].carId !== sorted[i - 1].carId) switches++;
  }
  return switches;
}

function totalDriverMinutes(entries: DriverWorkloadEntry[]): number {
  return entries.reduce((sum, e) => sum + (e.endMin - e.startMin), 0);
}

function salaryGap(driver: PoolDriver, workMinutes: number): number {
  if (!driver.targetSalary || !driver.hourlyRate || driver.hourlyRate <= 0) return 0;
  const currentEarnings = ((driver.currentMonthMinutes + workMinutes) / 60) * driver.hourlyRate;
  return driver.targetSalary - currentEarnings;
}

// ─── Main resolver ──────────────────────────────────────────────────────────

export function resolveCarBlocks(
  carBlocks: CarBlock[],
  allDrivers: PoolDriver[],
  bufferMinutes: number = MIN_VEHICLE_SWITCH_BUFFER_MINUTES,
): CarBlockResolverResult {
  const resolved: ResolvedBlock[] = [];
  const unresolved: UnresolvedBlock[] = [];
  const driverWorkload = new Map<string, DriverWorkloadEntry[]>();

  for (const driver of allDrivers) {
    driverWorkload.set(driver.id, []);
  }

  const sorted = [...carBlocks].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.startMin - b.startMin;
  });

  for (const block of sorted) {
    const tried: Array<{ driverId: string; driverName: string; rejectReason: string }> = [];
    let assigned = false;

    const candidates = rankDrivers(block, allDrivers, driverWorkload);

    for (const { driver } of candidates) {
      const entries = driverWorkload.get(driver.id) ?? [];

      const hasOverlap = entries.some(e => absOverlap(e, block));
      if (hasOverlap) {
        tried.push({
          driverId: driver.id,
          driverName: driver.name,
          rejectReason: 'Zeitlicher Konflikt (Ueberlappung)',
        });
        continue;
      }

      const switchCheck = violatesVehicleSwitchBuffer(entries, block, bufferMinutes);
      if (switchCheck.violates) {
        tried.push({
          driverId: driver.id,
          driverName: driver.name,
          rejectReason: switchCheck.reason,
        });
        continue;
      }

      const entry: DriverWorkloadEntry = {
        carId: block.carId,
        kennzeichen: block.kennzeichen,
        date: block.date,
        startMin: block.startMin,
        endMin: block.endMin,
      };
      entries.push(entry);
      driverWorkload.set(driver.id, entries);

      resolved.push({
        ...block,
        assignedDriverId: driver.id,
        assignedDriverName: driver.name,
        reason: buildAssignmentReason(driver, entries, block),
      });
      assigned = true;
      break;
    }

    if (!assigned) {
      unresolved.push({
        ...block,
        reason: allDrivers.length === 0
          ? 'Keine aktiven Fahrer verfuegbar'
          : 'Kein Fahrer ohne Konflikt verfuegbar',
        triedDrivers: tried,
      });
    }
  }

  return { resolved, unresolved, driverWorkload };
}

// ─── Driver ranking ─────────────────────────────────────────────────────────

function rankDrivers(
  block: CarBlock,
  allDrivers: PoolDriver[],
  driverWorkload: Map<string, DriverWorkloadEntry[]>,
): Array<{ driver: PoolDriver; score: number }> {
  return allDrivers
    .map(driver => {
      const entries = driverWorkload.get(driver.id) ?? [];
      let score = 0;

      const sameCarNearby = entries.filter(e => {
        if (e.carId !== block.carId) return false;
        const gap = Math.abs(
          dateToAbsoluteMinutes(block.date, block.startMin) - dateToAbsoluteMinutes(e.date, e.endMin),
        );
        return gap < 1440;
      });
      if (sameCarNearby.length > 0) score += 1000;

      const gap = salaryGap(driver, totalDriverMinutes(entries));
      if (gap > 0) score += Math.min(gap, 500);

      const totalMins = driver.currentMonthMinutes + totalDriverMinutes(entries);
      score -= totalMins * 0.01;

      const currentSwitches = countVehicleSwitches(entries);
      score -= currentSwitches * 100;

      return { driver, score };
    })
    .sort((a, b) => b.score - a.score);
}

function buildAssignmentReason(
  driver: PoolDriver,
  entries: DriverWorkloadEntry[],
  block: CarBlock,
): string {
  const sameCarSameDay = entries.filter(
    e => e.date === block.date && e.carId === block.carId,
  );
  if (sameCarSameDay.length > 1) {
    return `Gleicher Fahrer (${driver.name}) am gleichen Fahrzeug ${block.kennzeichen}`;
  }
  const gap = salaryGap(driver, totalDriverMinutes(entries));
  if (gap > 0) {
    return `${driver.name}: Gehaltsluecke ${Math.round(gap)} EUR`;
  }
  return `${driver.name}: Kapazitaet verfuegbar`;
}

// ─── Build car blocks from fahrtenbuch trips ────────────────────────────────

export function buildCarBlocksFromTrips(
  trips: NormalizedTrip[],
  carMap: Map<string, string>,
  gapMinutes: number = 90,
): CarBlock[] {
  const tripsByCarDate = new Map<string, NormalizedTrip[]>();

  for (const trip of trips) {
    const carId = trip.original.car_id;
    if (!carId) continue;
    const key = `${carId}|${trip.serviceDate}`;
    if (!tripsByCarDate.has(key)) tripsByCarDate.set(key, []);
    tripsByCarDate.get(key)!.push(trip);
  }

  const allBlocks: CarBlock[] = [];

  for (const [key, segs] of tripsByCarDate) {
    const [carId, date] = key.split('|');
    const kennzeichen = carMap.get(carId) ?? carId;
    const sorted = [...segs].sort((a, b) => a.startMinutes - b.startMinutes);
    const workBlocks = groupRidesIntoBlocks(sorted, carId, date, gapMinutes);

    for (const wb of workBlocks) {
      const blockId = makeBlockId(carId, date, wb.startMin);
      allBlocks.push({
        blockId,
        carId,
        kennzeichen,
        date,
        startMin: wb.startMin,
        endMin: wb.endMin,
        tripIds: wb.tripIds,
      });
    }
  }

  return allBlocks;
}

// ─── Build per-trip assignment map ──────────────────────────────────────────

export function buildTripAssignmentMap(
  result: CarBlockResolverResult,
  normalizedTrips: NormalizedTrip[],
): Map<string, TripAssignment> {
  const tripLookup = new Map<string, NormalizedTrip>();
  for (const nt of normalizedTrips) {
    tripLookup.set(nt.id, nt);
  }

  const assignments = new Map<string, TripAssignment>();

  for (const rb of result.resolved) {
    for (const tripId of rb.tripIds) {
      const nt = tripLookup.get(tripId);
      assignments.set(tripId, {
        tripId,
        originalTripId: nt?.original.id ?? tripId,
        resolvedDriverId: rb.assignedDriverId,
        resolvedDriverName: rb.assignedDriverName,
        resolvedVehicleId: rb.carId,
        resolvedVehicleKennzeichen: rb.kennzeichen,
        resolvedBlockId: rb.blockId,
        assignmentSource: 'car_block_resolver',
        assignmentReason: rb.reason,
        assignmentStatus: 'resolved',
        date: rb.date,
        startMin: nt?.startMinutes ?? rb.startMin,
        endMin: nt?.endMinutes ?? rb.endMin,
      });
    }
  }

  for (const ub of result.unresolved) {
    for (const tripId of ub.tripIds) {
      const nt = tripLookup.get(tripId);
      assignments.set(tripId, {
        tripId,
        originalTripId: nt?.original.id ?? tripId,
        resolvedDriverId: null,
        resolvedDriverName: null,
        resolvedVehicleId: ub.carId,
        resolvedVehicleKennzeichen: ub.kennzeichen,
        resolvedBlockId: ub.blockId,
        assignmentSource: 'car_block_resolver',
        assignmentReason: ub.reason,
        assignmentStatus: 'unresolved',
        date: ub.date,
        startMin: nt?.startMinutes ?? ub.startMin,
        endMin: nt?.endMinutes ?? ub.endMin,
      });
    }
  }

  return assignments;
}

// ─── Resolved Fahrtenbuch validation ────────────────────────────────────────

export function validateResolvedFahrtenbuch(
  assignments: Map<string, TripAssignment>,
  bufferMinutes: number = MIN_VEHICLE_SWITCH_BUFFER_MINUTES,
): ResolvedFahrtenbuchValidation {
  const all = [...assignments.values()];
  const resolvedTrips = all.filter(a => a.assignmentStatus === 'resolved');
  const unresolvedTrips = all.filter(a => a.assignmentStatus === 'unresolved');

  const { crossCar: driverOverlaps, sameVehicle: sameVehicleConflicts } = checkDriverOverlaps(resolvedTrips);
  const vehicleSwitchViolations = checkVehicleSwitchBuffer(resolvedTrips, bufferMinutes);
  const vehicleOverlaps = checkVehicleOverlaps(resolvedTrips);

  return {
    totalTrips: all.length,
    resolvedTrips: resolvedTrips.length,
    unresolvedTrips: unresolvedTrips.length,
    driverOverlaps,
    vehicleSwitchViolations,
    vehicleOverlaps,
    sameVehicleConflicts,
    isClean:
      unresolvedTrips.length === 0 &&
      driverOverlaps.length === 0 &&
      vehicleSwitchViolations.length === 0 &&
      vehicleOverlaps.length === 0,
  };
}

// ─── Driver overlap check ───────────────────────────────────────────────────
// Group resolved trips by driver, sort by absolute start time across the full
// month (not per-date), detect overlaps including across midnight.

function checkDriverOverlaps(
  resolved: TripAssignment[],
): { crossCar: ValidationViolation[]; sameVehicle: ValidationViolation[] } {
  const crossCar: ValidationViolation[] = [];
  const sameVehicle: ValidationViolation[] = [];

  const byDriver = new Map<string, TripAssignment[]>();
  for (const a of resolved) {
    if (!a.resolvedDriverId) continue;
    if (!byDriver.has(a.resolvedDriverId)) byDriver.set(a.resolvedDriverId, []);
    byDriver.get(a.resolvedDriverId)!.push(a);
  }

  for (const [driverId, trips] of byDriver) {
    const sorted = [...trips].sort((a, b) =>
      dateToAbsoluteMinutes(a.date, a.startMin) - dateToAbsoluteMinutes(b.date, b.startMin),
    );

    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      const aEnd = dateToAbsoluteMinutes(a.date, a.endMin);

      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        const bStart = dateToAbsoluteMinutes(b.date, b.startMin);

        if (bStart >= aEnd) break;

        const bEnd = dateToAbsoluteMinutes(b.date, b.endMin);
        const overlapMin = Math.min(aEnd, bEnd) - bStart;
        if (overlapMin > 0) {
          const isSameVehicle = a.resolvedVehicleId === b.resolvedVehicleId;
          const violation: ValidationViolation = {
            type: isSameVehicle ? 'same_vehicle_conflict' : 'driver_overlap',
            driverId,
            driverName: a.resolvedDriverName ?? '?',
            vehicleKennzeichen: isSameVehicle ? a.resolvedVehicleKennzeichen : undefined,
            details: `${a.date}: ${a.resolvedDriverName} hat ueberlappende Fahrten `
              + `${minutesToTime(a.startMin)}-${minutesToTime(a.endMin)} (${a.resolvedVehicleKennzeichen}) `
              + `und ${b.date} ${minutesToTime(b.startMin)}-${minutesToTime(b.endMin)} (${b.resolvedVehicleKennzeichen}) `
              + `(${overlapMin} Min. Ueberlappung)`,
          };
          if (isSameVehicle) {
            sameVehicle.push(violation);
          } else {
            crossCar.push(violation);
          }
        }
      }
    }
  }

  return { crossCar, sameVehicle };
}

// ─── Vehicle-switch buffer check ────────────────────────────────────────────
// For each driver, compare consecutive blocks across the full month (not per-date).
// If vehicle changes, gap must be >= bufferMinutes.

function checkVehicleSwitchBuffer(
  resolved: TripAssignment[],
  bufferMinutes: number,
): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  const byDriver = new Map<string, TripAssignment[]>();
  for (const a of resolved) {
    if (!a.resolvedDriverId) continue;
    if (!byDriver.has(a.resolvedDriverId)) byDriver.set(a.resolvedDriverId, []);
    byDriver.get(a.resolvedDriverId)!.push(a);
  }

  for (const [driverId, trips] of byDriver) {
    // Collapse trips into blocks (by resolvedBlockId), storing date for absolute time
    const blockMap = new Map<string, { blockId: string; carId: string; kennzeichen: string; date: string; startMin: number; endMin: number }>();
    for (const t of trips) {
      const existing = blockMap.get(t.resolvedBlockId);
      if (!existing) {
        blockMap.set(t.resolvedBlockId, {
          blockId: t.resolvedBlockId,
          carId: t.resolvedVehicleId,
          kennzeichen: t.resolvedVehicleKennzeichen,
          date: t.date,
          startMin: t.startMin,
          endMin: t.endMin,
        });
      } else {
        if (dateToAbsoluteMinutes(t.date, t.startMin) < dateToAbsoluteMinutes(existing.date, existing.startMin)) {
          existing.date = t.date;
          existing.startMin = t.startMin;
        }
        if (dateToAbsoluteMinutes(t.date, t.endMin) > dateToAbsoluteMinutes(existing.date, existing.endMin)) {
          existing.endMin = t.endMin;
        }
      }
    }

    const blocks = [...blockMap.values()].sort((a, b) =>
      dateToAbsoluteMinutes(a.date, a.startMin) - dateToAbsoluteMinutes(b.date, b.startMin),
    );

    for (let i = 0; i < blocks.length - 1; i++) {
      const prev = blocks[i];
      const next = blocks[i + 1];

      if (prev.carId === next.carId) continue;

      const gap = dateToAbsoluteMinutes(next.date, next.startMin) - dateToAbsoluteMinutes(prev.date, prev.endMin);
      if (gap < bufferMinutes) {
        const driverName = trips[0]?.resolvedDriverName ?? '?';
        violations.push({
          type: 'vehicle_switch_buffer',
          driverId,
          driverName,
          details: `${prev.date}: ${driverName} wechselt Fahrzeug `
            + `${prev.kennzeichen} (${minutesToTime(prev.startMin)}-${minutesToTime(prev.endMin)}) `
            + `-> ${next.date} ${next.kennzeichen} (${minutesToTime(next.startMin)}-${minutesToTime(next.endMin)}), `
            + `Luecke: ${gap} Min. (min. ${bufferMinutes} Min. erforderlich)`,
        });
      }
    }
  }

  return violations;
}

// ─── Vehicle overlap check ──────────────────────────────────────────────────
// Group resolved trips by vehicle + date, check for time overlaps between
// trips assigned to DIFFERENT drivers on the same vehicle.

function checkVehicleOverlaps(resolved: TripAssignment[]): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  const byVehicleDate = new Map<string, TripAssignment[]>();
  for (const a of resolved) {
    const key = `${a.resolvedVehicleId}|${a.date}`;
    if (!byVehicleDate.has(key)) byVehicleDate.set(key, []);
    byVehicleDate.get(key)!.push(a);
  }

  for (const [, trips] of byVehicleDate) {
    const sorted = [...trips].sort((a, b) => a.startMin - b.startMin);

    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];

        if (a.resolvedDriverId === b.resolvedDriverId) continue;

        if (b.startMin < a.endMin) {
          const overlapMin = Math.min(a.endMin, b.endMin) - b.startMin;
          if (overlapMin > 0) {
            violations.push({
              type: 'vehicle_overlap',
              vehicleKennzeichen: a.resolvedVehicleKennzeichen,
              details: `${a.date}: ${a.resolvedVehicleKennzeichen} wird gleichzeitig genutzt von `
                + `${a.resolvedDriverName} (${minutesToTime(a.startMin)}-${minutesToTime(a.endMin)}) `
                + `und ${b.resolvedDriverName} (${minutesToTime(b.startMin)}-${minutesToTime(b.endMin)}) `
                + `(${overlapMin} Min. Ueberlappung)`,
            });
          }
        }
      }
    }
  }

  return violations;
}
