import type { FahrtenbuchTrip } from '../hooks/useFahrtenbuch';

// ─── Scope: this engine does not consult driver absence ─────────────────────
//
// This is the engine of the Brutto-Gehälter pipeline (HistoricalReconciliationWizard),
// and absence is not an input to it, on purpose. That pipeline reconciles gross
// pay against figures the Steuerberater already has, for a month that has already
// been driven: each ride is attributed to the driver the Fahrtenbuch names
// (original_driver_id / original_driver_name), so who was available is not a
// question it asks, and a note saying a driver was sick or on leave says nothing
// about a ride that happened. The wizard reads no driver notes at all, and
// shiftBlockEngine.scope.test.ts fails if that stops being true, so this
// paragraph cannot go stale quietly.
//
// validateCoverage and enforceBlockCoverageInvariant used to take a blockedDates
// map (date → reason). It was filled by GenerateStundennachweisModal, a different
// feature that generated a Stundennachweis from a plan; that modal was deleted in
// c3a8a8b (2026-09-09) as unreachable, and nothing has called either function
// since (checked 22.10.2026). The parameter went with its only caller rather than
// being left to look like a hook this pipeline forgot to fill: wiring absence
// into the pipeline that produces the accountant's figures would be a product
// decision about those figures, not a missing line.
//
// If absence ever has to be consulted by code that uses this engine, build the
// windows with noteExclusionIntervals (utils/driverNoteValidation.ts) and never
// with a new copy of the date arithmetic: the header there records what the two
// earlier copies cost.

// ─── Constants ──────────────────────────────────────────────────────────────

export const BLOCK_SEPARATOR_GAP_MINUTES = 90;
export const BUFFER_MIN_MINUTES = 5;
export const BUFFER_MAX_MINUTES = 15;
export const MAX_DAILY_WORK_MINUTES = 600;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NormalizedTrip {
  id: string;
  rawDate: string;
  serviceDate: string;
  startMinutes: number;
  endMinutes: number;
  crossesMidnight: boolean;
  /** For the day-D segment of a cross-midnight trip: the actual end minutes on day D+1 (e.g. 78 for 01:18). */
  crossMidnightActualEndMinutes?: number;
  /** For the day-D segment of a cross-midnight trip: the YYYY-MM-DD of day D+1. */
  crossMidnightNextDate?: string;
  reason: string;
  original: FahrtenbuchTrip;
}

export interface WorkBlock {
  startMin: number;
  endMin: number;
  tripIds: string[];
  bufferBefore: number;
  bufferAfter: number;
}

export interface Schicht {
  von: string;
  bis: string;
  blockIndex: number;
  /** Set when the last ride in this block crosses midnight. Formatted as "HH:MM+ (DD.MM.)" */
  bisDisplay?: string;
}

export interface OverlapWarning {
  date: string;
  tripA: { id: string; start: string; end: string };
  tripB: { id: string; start: string; end: string };
  overlapMinutes: number;
}

export interface TransferWarning {
  date: string;
  fromTrip: { id: string; end: string; routeEnd: string | null };
  toTrip: { id: string; start: string; routeStart: string | null };
  gapMinutes: number;
  severity: 'critical' | 'warning' | 'low';
  reason: string;
}

export type TripCoverageStatus = 'fully_covered' | 'partially_covered' | 'uncovered';

export interface CoverageResult {
  tripId: string;
  date: string;
  startTime: string;
  endTime: string;
  status: TripCoverageStatus;
  reason: string;
  debug?: {
    rawTripDate: string;
    actualStartDatetime: string | null;
    normalizedServiceDate: string;
    startMinutes: number;
    endMinutes: number;
    shiftsOnDate: string[];
  };
}

export interface CoverageSummary {
  total_rides: number;
  fully_covered: number;
  partially_covered: number;
  uncovered: number;
}

export interface GenerationSettings {
  block_separator_gap_minutes: number;
  buffer_min_minutes: number;
  buffer_max_minutes: number;
  salary_priority_enabled: boolean;
  target_salary: number | null;
  target_hours: number | null;
  hourly_rate: number | null;
}

export interface DriverShiftConfig {
  driverId: string;
  workWindowStart: number | null;
  workWindowEnd: number | null;
  preferredStart: number | null;
  preferredEnd: number | null;
  allowExtraBefore: boolean;
  allowExtraAfter: boolean;
  targetSalary: number | null;
  hourlyRate: number | null;
  targetMonthlyHours: number | null;
  maxMonthlyHours: number | null;
}

export interface WindowWarning {
  date: string;
  tripId: string;
  startTime: string;
  endTime: string;
  message: string;
}

// ─── Time helpers ───────────────────────────────────────────────────────────

export function timeToMinutes(t: string | null | undefined): number {
  if (!t) return 0;
  const parts = t.split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

export function minutesToTime(m: number): string {
  const clamped = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(clamped / 60);
  const min = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// ─── Deterministic buffer ───────────────────────────────────────────────────

function hashSeed(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function deterministicBuffer(
  driverId: string,
  dateStr: string,
  blockIndex: number,
  position: 'before' | 'after',
): number {
  const seed = hashSeed(`${driverId}|${dateStr}|${blockIndex}|${position}`);
  const range = BUFFER_MAX_MINUTES - BUFFER_MIN_MINUTES + 1;
  return BUFFER_MIN_MINUTES + (seed % range);
}

// ─── Cross-midnight normalization ───────────────────────────────────────────

const DATETIME_FIELD_CANDIDATES = [
  'Uhrzeit des Fahrtbeginns',
  'Uhrzeit der Fahrt',
  'Fahrtbeginn',
  'Startzeit',
] as const;

function extractActualStartDate(trip: FahrtenbuchTrip): string | null {
  const raw = trip.raw_data_json as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== 'object') return null;
  for (const key of DATETIME_FIELD_CANDIDATES) {
    const val = raw[key];
    if (typeof val === 'string') {
      const m = val.match(/^(\d{4}-\d{2}-\d{2})/);
      if (m) return m[1];
    }
  }
  return null;
}

function fmtIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function normalizeTripServiceDate(trip: FahrtenbuchTrip): NormalizedTrip[] {
  const startMin = timeToMinutes(trip.start_time);
  const endMin = timeToMinutes(trip.end_time);
  const crossesMidnight = endMin > 0 && endMin <= startMin;
  const tripDate = trip.trip_date;

  // Check if the actual ride start datetime is on a different calendar day
  // than the raw trip_date (Uber dispatch date). If so, the ride belongs
  // to the actual start date, not the dispatch date.
  const actualStartDate = extractActualStartDate(trip);
  if (actualStartDate && actualStartDate !== tripDate && !crossesMidnight) {
    return [{
      id: trip.id,
      rawDate: tripDate,
      serviceDate: actualStartDate,
      startMinutes: startMin,
      endMinutes: endMin === 0 ? 1439 : endMin,
      crossesMidnight: false,
      reason: 'actual_start_date_differs',
      original: trip,
    }];
  }

  if (!crossesMidnight) {
    return [{
      id: trip.id,
      rawDate: tripDate,
      serviceDate: tripDate,
      startMinutes: startMin,
      endMinutes: endMin === 0 ? 1439 : endMin,
      crossesMidnight: false,
      reason: 'same_day',
      original: trip,
    }];
  }

  const segments: NormalizedTrip[] = [];

  // Compute day D+1
  const d = new Date(tripDate + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  const nextDate = fmtIsoDate(d);

  // Segment 1: trip start to 23:59 on day D.
  // Carry actual end time + next date so consumers can display "01:18+ (01.06.)" instead of "23:59".
  segments.push({
    id: `${trip.id}_seg1`,
    rawDate: tripDate,
    serviceDate: tripDate,
    startMinutes: startMin,
    endMinutes: 1439,
    crossesMidnight: true,
    crossMidnightActualEndMinutes: endMin > 0 ? endMin : 0,
    crossMidnightNextDate: nextDate,
    reason: 'cross_midnight_day_d',
    original: trip,
  });

  // Segment 2: 00:00 to trip end on day D+1
  if (endMin > 0) {
    segments.push({
      id: `${trip.id}_seg2`,
      rawDate: tripDate,
      serviceDate: nextDate,
      startMinutes: 0,
      endMinutes: endMin,
      crossesMidnight: true,
      reason: 'cross_midnight_day_d1',
      original: trip,
    });
  }

  return segments;
}

// ─── Block grouping ─────────────────────────────────────────────────────────

export function groupRidesIntoBlocks(
  sortedSegments: NormalizedTrip[],
  driverId: string,
  dateStr: string,
  gapMinutes: number = BLOCK_SEPARATOR_GAP_MINUTES,
): WorkBlock[] {
  if (sortedSegments.length === 0) return [];

  const blocks: WorkBlock[] = [];
  let currentStart = sortedSegments[0].startMinutes;
  let currentEnd = sortedSegments[0].endMinutes;
  let currentTrips = [sortedSegments[0].id];

  for (let i = 1; i < sortedSegments.length; i++) {
    const seg = sortedSegments[i];
    const gap = seg.startMinutes - currentEnd;

    if (gap > gapMinutes) {
      const blockIdx = blocks.length;
      const bufBefore = deterministicBuffer(driverId, dateStr, blockIdx, 'before');
      const bufAfter = deterministicBuffer(driverId, dateStr, blockIdx, 'after');
      blocks.push({
        startMin: Math.max(0, currentStart - bufBefore),
        endMin: Math.min(1439, currentEnd + bufAfter),
        tripIds: currentTrips,
        bufferBefore: bufBefore,
        bufferAfter: bufAfter,
      });
      currentStart = seg.startMinutes;
      currentEnd = seg.endMinutes;
      currentTrips = [seg.id];
    } else {
      currentEnd = Math.max(currentEnd, seg.endMinutes);
      currentTrips.push(seg.id);
    }
  }

  const blockIdx = blocks.length;
  const bufBefore = deterministicBuffer(driverId, dateStr, blockIdx, 'before');
  const bufAfter = deterministicBuffer(driverId, dateStr, blockIdx, 'after');
  blocks.push({
    startMin: Math.max(0, currentStart - bufBefore),
    endMin: Math.min(1439, currentEnd + bufAfter),
    tripIds: currentTrips,
    bufferBefore: bufBefore,
    bufferAfter: bufAfter,
  });

  return blocks;
}

// ─── Block merging (reduce to max 3) ────────────────────────────────────────

export function mergeBlocksIfNeeded(blocks: WorkBlock[]): { merged: WorkBlock[]; warnings: string[] } {
  if (blocks.length <= 3) return { merged: blocks, warnings: [] };

  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin);
  const warnings: string[] = [];

  while (sorted.length > 3) {
    let bestIdx = -1;
    let bestGap = Infinity;
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap = sorted[i + 1].startMin - sorted[i].endMin;
      if (gap < bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;

    const a = sorted[bestIdx];
    const b = sorted[bestIdx + 1];
    warnings.push(`Bloecke zusammengefuehrt: ${minutesToTime(a.startMin)}-${minutesToTime(a.endMin)} und ${minutesToTime(b.startMin)}-${minutesToTime(b.endMin)}`);
    const merged: WorkBlock = {
      startMin: a.startMin,
      endMin: Math.max(a.endMin, b.endMin),
      tripIds: [...a.tripIds, ...b.tripIds],
      bufferBefore: a.bufferBefore,
      bufferAfter: b.bufferAfter,
    };
    sorted.splice(bestIdx, 2, merged);
  }

  if (sorted.length > 3) {
    warnings.push('Mehr als 3 Schichten nicht darstellbar');
  }

  return { merged: sorted, warnings };
}

// ─── Overlap detection ──────────────────────────────────────────────────────

export function detectOverlaps(
  tripsByDate: Map<string, NormalizedTrip[]>,
): OverlapWarning[] {
  const warnings: OverlapWarning[] = [];

  for (const [date, segments] of tripsByDate) {
    const sorted = [...segments].sort((a, b) => a.startMinutes - b.startMinutes);
    for (let i = 0; i < sorted.length - 1; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (b.startMinutes < a.endMinutes) {
          const overlapMin = Math.min(a.endMinutes, b.endMinutes) - b.startMinutes;
          if (overlapMin > 0) {
            warnings.push({
              date,
              tripA: { id: a.original.id, start: a.original.start_time ?? '', end: a.original.end_time ?? '' },
              tripB: { id: b.original.id, start: b.original.start_time ?? '', end: b.original.end_time ?? '' },
              overlapMinutes: overlapMin,
            });
          }
        }
      }
    }
  }

  return warnings;
}

// ─── Transfer-time validation ───────────────────────────────────────────────

export function detectTransferWarnings(
  tripsByDate: Map<string, NormalizedTrip[]>,
): TransferWarning[] {
  const warnings: TransferWarning[] = [];

  for (const [date, segments] of tripsByDate) {
    const sorted = [...segments].sort((a, b) => a.startMinutes - b.startMinutes);

    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const gapMin = b.startMinutes - a.endMinutes;
      const routeA = a.original.route_end;
      const routeB = b.original.route_start;

      const sameAddress = routeA && routeB && routeA.trim().toLowerCase() === routeB.trim().toLowerCase();
      const missingAddress = !routeA || !routeB;

      if (sameAddress) continue;

      let severity: 'critical' | 'warning' | 'low' | null = null;
      let reason = '';

      if (gapMin < 0) {
        severity = 'critical';
        reason = 'Ueberlappende Fahrten (negativer Transfer)';
      } else if (missingAddress) {
        if (gapMin < 5) {
          severity = 'low';
          reason = 'Adresse fehlt, kurze Umsteigezeit';
        }
      } else if (gapMin < 5) {
        severity = 'critical';
        reason = `Unrealistischer Transfer: ${gapMin} Min. zwischen verschiedenen Adressen`;
      } else if (gapMin < 10) {
        severity = 'warning';
        reason = `Knapper Transfer: ${gapMin} Min. zwischen verschiedenen Adressen`;
      }

      if (severity) {
        warnings.push({
          date,
          fromTrip: { id: a.original.id, end: a.original.end_time ?? '', routeEnd: routeA },
          toTrip: { id: b.original.id, start: b.original.start_time ?? '', routeStart: routeB },
          gapMinutes: gapMin,
          severity,
          reason,
        });
      }
    }
  }

  return warnings;
}

// ─── Preferred window warnings ──────────────────────────────────────────────

export function checkRidesOutsidePreferredWindow(
  tripsByDate: Map<string, NormalizedTrip[]>,
  config: DriverShiftConfig,
): WindowWarning[] {
  if (config.preferredStart == null && config.preferredEnd == null) return [];
  const warnings: WindowWarning[] = [];
  const pStart = config.preferredStart ?? 0;
  const pEnd = config.preferredEnd ?? 1439;

  for (const [date, segments] of tripsByDate) {
    for (const seg of segments) {
      if (seg.startMinutes < pStart || seg.endMinutes > pEnd) {
        warnings.push({
          date,
          tripId: seg.original.id,
          startTime: seg.original.start_time ?? '',
          endTime: seg.original.end_time ?? '',
          message: `Fahrt liegt ausserhalb bevorzugter Arbeitszeit (${minutesToTime(pStart)}-${minutesToTime(pEnd)})`,
        });
      }
    }
  }

  return warnings;
}

// ─── Coverage validation ────────────────────────────────────────────────────

// Judges rides against the Schichten alone. It takes no absence map: see "Scope"
// at the top of this file.
export function validateCoverage(
  tripsByDate: Map<string, NormalizedTrip[]>,
  schichtenByDate: Map<string, Schicht[]>,
): CoverageResult[] {
  const results: CoverageResult[] = [];
  const processedOriginals = new Set<string>();

  for (const [date, segments] of tripsByDate) {
    const shifts = schichtenByDate.get(date) ?? [];

    for (const seg of segments) {
      if (processedOriginals.has(seg.original.id)) continue;

      const tripStart = seg.startMinutes;
      const tripEnd = seg.endMinutes;

      const isCovered = shifts.some(s => {
        const sStart = timeToMinutes(s.von);
        const sEnd = timeToMinutes(s.bis);
        return tripStart >= sStart && tripEnd <= sEnd;
      });

      if (isCovered) {
        if (!seg.crossesMidnight) {
          processedOriginals.add(seg.original.id);
          results.push({
            tripId: seg.original.id,
            date: seg.original.trip_date,
            startTime: seg.original.start_time ?? '',
            endTime: seg.original.end_time ?? '',
            status: 'fully_covered',
            reason: '',
          });
        }
      } else if (!seg.crossesMidnight) {
        processedOriginals.add(seg.original.id);
        const actualDt = extractActualStartDate(seg.original);
        results.push({
          tripId: seg.original.id,
          date: seg.original.trip_date,
          startTime: seg.original.start_time ?? '',
          endTime: seg.original.end_time ?? '',
          status: 'uncovered',
          reason: `Fahrt ${seg.original.start_time ?? '?'}-${seg.original.end_time ?? '?'} nicht von Schicht abgedeckt`,
          debug: {
            rawTripDate: seg.original.trip_date,
            actualStartDatetime: actualDt,
            normalizedServiceDate: seg.serviceDate,
            startMinutes: seg.startMinutes,
            endMinutes: seg.endMinutes,
            shiftsOnDate: shifts.map(s => `${s.von}-${s.bis}`),
          },
        });
      }
    }
  }

  // Handle cross-midnight original trips separately
  const crossMidnightOriginals = new Map<string, NormalizedTrip[]>();
  for (const [, segments] of tripsByDate) {
    for (const seg of segments) {
      if (seg.crossesMidnight && !processedOriginals.has(seg.original.id)) {
        if (!crossMidnightOriginals.has(seg.original.id)) {
          crossMidnightOriginals.set(seg.original.id, []);
        }
        crossMidnightOriginals.get(seg.original.id)!.push(seg);
      }
    }
  }

  for (const [originalId, segs] of crossMidnightOriginals) {
    processedOriginals.add(originalId);
    const trip = segs[0].original;
    let allCovered = true;
    let anyCovered = false;

    for (const seg of segs) {
      const shifts = schichtenByDate.get(seg.serviceDate) ?? [];
      const covered = shifts.some(s => {
        const sStart = timeToMinutes(s.von);
        const sEnd = timeToMinutes(s.bis);
        return seg.startMinutes >= sStart && seg.endMinutes <= sEnd;
      });
      if (covered) anyCovered = true;
      else allCovered = false;
    }

    results.push({
      tripId: originalId,
      date: trip.trip_date,
      startTime: trip.start_time ?? '',
      endTime: trip.end_time ?? '',
      status: allCovered ? 'fully_covered' : anyCovered ? 'partially_covered' : 'uncovered',
      reason: allCovered
        ? ''
        : anyCovered
          ? `Fahrt ${trip.start_time ?? '?'}-${trip.end_time ?? '?'} ueber Mitternacht, teilweise abgedeckt`
          : `Fahrt ${trip.start_time ?? '?'}-${trip.end_time ?? '?'} nicht von Schicht abgedeckt`,
    });
  }

  return results;
}

export function buildCoverageSummary(results: CoverageResult[]): CoverageSummary {
  return {
    total_rides: results.length,
    fully_covered: results.filter(r => r.status === 'fully_covered').length,
    partially_covered: results.filter(r => r.status === 'partially_covered').length,
    uncovered: results.filter(r => r.status === 'uncovered').length,
  };
}

// ─── Pflichtnotiz insertion ─────────────────────────────────────────────────

export function insertPflichtnotiz(
  schichtenByDate: Map<string, Schicht[]>,
  noteDate: string,
  noteMinute: number,
): { inserted: boolean; warning: string | null } {
  const winStart = Math.max(0, noteMinute - 30);
  const winEnd = Math.min(1439, noteMinute + 30);
  const winStartStr = minutesToTime(winStart);
  const winEndStr = minutesToTime(winEnd);

  const shifts = schichtenByDate.get(noteDate) ?? [];

  const alreadyCovered = shifts.some(s => {
    const sStart = timeToMinutes(s.von);
    const sEnd = timeToMinutes(s.bis);
    return winStart >= sStart && winEnd <= sEnd;
  });

  if (alreadyCovered) return { inserted: false, warning: null };

  // Try to extend nearest shift
  let bestShift: Schicht | null = null;
  let bestDist = Infinity;
  for (const s of shifts) {
    const sStart = timeToMinutes(s.von);
    const sEnd = timeToMinutes(s.bis);
    const dist = Math.min(Math.abs(noteMinute - sStart), Math.abs(noteMinute - sEnd));
    if (dist < bestDist) {
      bestDist = dist;
      bestShift = s;
    }
  }

  if (bestShift && bestDist <= 60) {
    const sStart = timeToMinutes(bestShift.von);
    const sEnd = timeToMinutes(bestShift.bis);
    bestShift.von = minutesToTime(Math.min(sStart, winStart));
    bestShift.bis = minutesToTime(Math.max(sEnd, winEnd));
    shifts.sort((a, b) => timeToMinutes(a.von) - timeToMinutes(b.von));
    schichtenByDate.set(noteDate, shifts);
    return { inserted: true, warning: null };
  }

  // Insert as new shift if slot available
  if (shifts.length < 3) {
    shifts.push({ von: winStartStr, bis: winEndStr, blockIndex: -1 });
    shifts.sort((a, b) => timeToMinutes(a.von) - timeToMinutes(b.von));
    schichtenByDate.set(noteDate, shifts);
    return { inserted: true, warning: null };
  }

  return { inserted: false, warning: 'Pflichtnotiz nicht darstellbar (alle Schichten belegt)' };
}

// ─── Salary-first extension ─────────────────────────────────────────────────

function dayShiftMinutes(shifts: Schicht[]): number {
  return shifts.reduce((s, sh) => s + (timeToMinutes(sh.bis) - timeToMinutes(sh.von)), 0);
}

export function extendShiftsForSalary(
  schichtenByDate: Map<string, Schicht[]>,
  config: DriverShiftConfig,
  currentTotalMinutes: number,
  holidays: Set<string>,
): { extraMinutesAdded: number; warnings: string[] } {
  const warnings: string[] = [];

  if (!config.hourlyRate || config.hourlyRate <= 0) {
    if (config.targetSalary) warnings.push('Stundensatz fehlt');
    return { extraMinutesAdded: 0, warnings };
  }

  let targetMinutes: number | null = null;

  if (config.targetSalary && config.targetSalary > 0) {
    targetMinutes = Math.ceil((config.targetSalary / config.hourlyRate) * 60);
  } else if (config.targetMonthlyHours && config.targetMonthlyHours > 0) {
    targetMinutes = Math.ceil(config.targetMonthlyHours * 60);
  }

  if (!targetMinutes || currentTotalMinutes >= targetMinutes) {
    return { extraMinutesAdded: 0, warnings };
  }

  let neededMinutes = targetMinutes - currentTotalMinutes;
  let addedTotal = 0;
  const maxMonthlyMin = config.maxMonthlyHours ? config.maxMonthlyHours * 60 : Infinity;

  const windowStart = config.workWindowStart ?? 0;
  const windowEnd = config.workWindowEnd ?? 1439;

  const dates = [...schichtenByDate.keys()].sort();

  for (const date of dates) {
    if (neededMinutes <= 0) break;
    if (currentTotalMinutes + addedTotal >= maxMonthlyMin) break;

    const shifts = schichtenByDate.get(date)!;
    if (shifts.length === 0) continue;

    const dayMins = dayShiftMinutes(shifts);
    const dayRemaining = MAX_DAILY_WORK_MINUTES - dayMins;
    if (dayRemaining <= 0) continue;

    const sorted = [...shifts].sort((a, b) => timeToMinutes(a.von) - timeToMinutes(b.von));
    const firstStart = timeToMinutes(sorted[0].von);
    const lastEnd = timeToMinutes(sorted[sorted.length - 1].bis);

    // Priority 1: before first block
    if (config.allowExtraBefore && firstStart > windowStart) {
      const canAdd = Math.min(firstStart - windowStart, neededMinutes, dayRemaining);
      if (canAdd > 0) {
        sorted[0].von = minutesToTime(firstStart - canAdd);
        neededMinutes -= canAdd;
        addedTotal += canAdd;
      }
    }

    // Priority 2: after last block
    if (neededMinutes > 0 && config.allowExtraAfter && lastEnd < windowEnd) {
      const updatedDayMins = dayShiftMinutes(sorted);
      const updatedRemaining = MAX_DAILY_WORK_MINUTES - updatedDayMins;
      const canAdd = Math.min(windowEnd - lastEnd, neededMinutes, updatedRemaining);
      if (canAdd > 0) {
        sorted[sorted.length - 1].bis = minutesToTime(lastEnd + canAdd);
        neededMinutes -= canAdd;
        addedTotal += canAdd;
      }
    }

    // Priority 3: between blocks (fill gaps)
    if (neededMinutes > 0 && sorted.length >= 2) {
      for (let i = 0; i < sorted.length - 1 && neededMinutes > 0; i++) {
        const gapStart = timeToMinutes(sorted[i].bis);
        const gapEnd = timeToMinutes(sorted[i + 1].von);
        const gapSize = gapEnd - gapStart;
        if (gapSize > 10) {
          const updatedDayMins2 = dayShiftMinutes(sorted);
          const updatedRemaining2 = MAX_DAILY_WORK_MINUTES - updatedDayMins2;
          const canAdd = Math.min(gapSize, neededMinutes, updatedRemaining2);
          if (canAdd > 0) {
            sorted[i].bis = minutesToTime(gapStart + canAdd);
            neededMinutes -= canAdd;
            addedTotal += canAdd;
          }
        }
      }
    }

    schichtenByDate.set(date, sorted);
  }

  if (addedTotal > 0) {
    warnings.push(`${Math.round(addedTotal / 6) / 10} Std. Mehrarbeit hinzugefuegt (Gehaltsanpassung)`);
  }

  if (neededMinutes > 0 && targetMinutes) {
    const reachedPct = Math.round(((targetMinutes - neededMinutes) / targetMinutes) * 100);
    warnings.push(`Zielgehalt nicht vollstaendig erreichbar (${reachedPct}% erreicht)`);
  }

  return { extraMinutesAdded: addedTotal, warnings };
}

// ─── Block coverage invariant ───────────────────────────────────────────────
// After all modifications (buffer, Pflichtnotiz, salary extension, splitting),
// ensure every ride segment is fully inside at least one Schicht on its date.
// If not, extend the nearest Schicht to cover it. It takes no absence map either:
// see "Scope" at the top of this file.

export function enforceBlockCoverageInvariant(
  schichtenByDate: Map<string, Schicht[]>,
  segsByDate: Map<string, NormalizedTrip[]>,
): string[] {
  const fixes: string[] = [];

  for (const [date, segments] of segsByDate) {
    const shifts = schichtenByDate.get(date);
    if (!shifts || shifts.length === 0) continue;

    for (const seg of segments) {
      const segStart = seg.startMinutes;
      const segEnd = seg.endMinutes;

      const covered = shifts.some(s => {
        const sStart = timeToMinutes(s.von);
        const sEnd = timeToMinutes(s.bis);
        return segStart >= sStart && segEnd <= sEnd;
      });

      if (!covered) {
        // Find the shift whose range is closest to this segment
        let bestShift: Schicht | null = null;
        let bestDist = Infinity;
        for (const s of shifts) {
          const sStart = timeToMinutes(s.von);
          const sEnd = timeToMinutes(s.bis);
          const dist = Math.min(
            Math.abs(segStart - sStart), Math.abs(segStart - sEnd),
            Math.abs(segEnd - sStart), Math.abs(segEnd - sEnd),
          );
          if (dist < bestDist) {
            bestDist = dist;
            bestShift = s;
          }
        }

        if (bestShift) {
          const sStart = timeToMinutes(bestShift.von);
          const sEnd = timeToMinutes(bestShift.bis);
          const newStart = Math.min(sStart, segStart);
          const newEnd = Math.max(sEnd, segEnd);
          if (newStart !== sStart || newEnd !== sEnd) {
            bestShift.von = minutesToTime(Math.max(0, newStart));
            bestShift.bis = minutesToTime(Math.min(1439, newEnd));
            fixes.push(`${date}: Schicht erweitert auf ${bestShift.von}-${bestShift.bis} (Fahrt ${minutesToTime(segStart)}-${minutesToTime(segEnd)} abdecken)`);
          }
        }
      }
    }

    shifts.sort((a, b) => timeToMinutes(a.von) - timeToMinutes(b.von));
  }

  return fixes;
}

// ─── Long shift detection + safe internal break splitting ───────────────────

export const LONG_SHIFT_THRESHOLD_MINUTES = 420; // 7 hours
export const MIN_BREAK_GAP_MINUTES = 30;

export interface LongShiftWarning {
  date: string;
  von: string;
  bis: string;
  durationMinutes: number;
  wasSplit: boolean;
  message: string;
}

export function detectAndSplitLongShifts(
  schichtenByDate: Map<string, Schicht[]>,
  segsByDate: Map<string, NormalizedTrip[]>,
): LongShiftWarning[] {
  const warnings: LongShiftWarning[] = [];

  for (const [date, shifts] of schichtenByDate) {
    if (shifts.length === 0) continue;

    // Process each shift - iterate with index since we may splice
    let i = 0;
    while (i < shifts.length) {
      const shift = shifts[i];
      const sStart = timeToMinutes(shift.von);
      const sEnd = timeToMinutes(shift.bis);
      const duration = sEnd - sStart;

      if (duration <= LONG_SHIFT_THRESHOLD_MINUTES) {
        i++;
        continue;
      }

      // Find the largest internal gap within this shift's ride segments
      const daySegs = segsByDate.get(date) ?? [];
      const coveredSegs = daySegs
        .filter(seg => seg.startMinutes >= sStart && seg.endMinutes <= sEnd)
        .sort((a, b) => a.startMinutes - b.startMinutes);

      let bestGapStart = -1;
      let bestGapEnd = -1;
      let bestGapSize = 0;

      for (let j = 0; j < coveredSegs.length - 1; j++) {
        const gapStart = coveredSegs[j].endMinutes;
        const gapEnd = coveredSegs[j + 1].startMinutes;
        const gapSize = gapEnd - gapStart;
        if (gapSize > bestGapSize) {
          bestGapSize = gapSize;
          bestGapStart = gapStart;
          bestGapEnd = gapEnd;
        }
      }

      const canSplit = bestGapSize >= MIN_BREAK_GAP_MINUTES && shifts.length < 3;

      if (canSplit) {
        // Split at the largest internal gap
        const breakStart = bestGapStart + Math.floor((bestGapEnd - bestGapStart) * 0.2);
        const breakEnd = bestGapEnd - Math.floor((bestGapEnd - bestGapStart) * 0.2);

        const shift1: Schicht = { von: shift.von, bis: minutesToTime(breakStart), blockIndex: shift.blockIndex };
        const shift2: Schicht = { von: minutesToTime(breakEnd), bis: shift.bis, blockIndex: shift.blockIndex };

        shifts.splice(i, 1, shift1, shift2);

        warnings.push({
          date,
          von: shift.von,
          bis: shift.bis,
          durationMinutes: duration,
          wasSplit: true,
          message: `Schicht ${shift.von}-${shift.bis} (${Math.round(duration / 60 * 10) / 10} Std.) aufgeteilt mit Pause ${minutesToTime(breakStart)}-${minutesToTime(breakEnd)}`,
        });

        // Don't increment i - check the new first part again
        continue;
      } else {
        const noGapMsg = bestGapSize < MIN_BREAK_GAP_MINUTES
          ? 'Keine ausreichende Pause gefunden'
          : 'Max. 3 Schichten pro Tag erreicht';

        warnings.push({
          date,
          von: shift.von,
          bis: shift.bis,
          durationMinutes: duration,
          wasSplit: false,
          message: `Schicht ${shift.von}-${shift.bis} laenger als 7 Std. ohne Pause. ${noGapMsg}`,
        });
      }

      i++;
    }

    shifts.sort((a, b) => timeToMinutes(a.von) - timeToMinutes(b.von));
  }

  return warnings;
}

// ─── Schicht compression (max 3 per day) ──────────────────────────────────

export const MAX_SCHICHTEN_PER_DAY = 3;

export interface SchichtCompressionResult {
  totalBefore: number;
  totalAfter: number;
  daysCompressed: Array<{ date: string; before: number; after: number }>;
}

export function compressSchichtenByDate(
  schichtenByDate: Map<string, Schicht[]>,
): SchichtCompressionResult {
  const result: SchichtCompressionResult = {
    totalBefore: 0,
    totalAfter: 0,
    daysCompressed: [],
  };

  for (const [date, shifts] of schichtenByDate) {
    result.totalBefore += shifts.length;

    if (shifts.length <= MAX_SCHICHTEN_PER_DAY) {
      result.totalAfter += shifts.length;
      continue;
    }

    const before = shifts.length;
    shifts.sort((a, b) => timeToMinutes(a.von) - timeToMinutes(b.von));

    while (shifts.length > MAX_SCHICHTEN_PER_DAY) {
      let bestIdx = -1;
      let bestGap = Infinity;
      for (let i = 0; i < shifts.length - 1; i++) {
        const gap = timeToMinutes(shifts[i + 1].von) - timeToMinutes(shifts[i].bis);
        if (gap < bestGap) {
          bestGap = gap;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break;

      const a = shifts[bestIdx];
      const b = shifts[bestIdx + 1];
      const merged: Schicht = {
        von: a.von,
        bis: timeToMinutes(b.bis) > timeToMinutes(a.bis) ? b.bis : a.bis,
        blockIndex: a.blockIndex,
      };
      shifts.splice(bestIdx, 2, merged);
    }

    schichtenByDate.set(date, shifts);
    result.totalAfter += shifts.length;
    result.daysCompressed.push({ date, before, after: shifts.length });
  }

  return result;
}

// ─── Transfer warning summary (for PDF) ─────────────────────────────────────

export interface TransferWarningSummary {
  totalCount: number;
  criticalCount: number;
  warningCount: number;
  lowCount: number;
  topWarnings: TransferWarning[];
  hasMore: boolean;
}

export function summarizeTransferWarnings(
  warnings: TransferWarning[],
  maxDisplay: number = 10,
): TransferWarningSummary {
  const deduped = new Map<string, TransferWarning>();
  for (const w of warnings) {
    const key = `${w.date}|${w.fromTrip.end}|${w.toTrip.start}|${w.severity}`;
    if (!deduped.has(key)) deduped.set(key, w);
  }

  const unique = [...deduped.values()];
  unique.sort((a, b) => {
    const sevOrder = { critical: 0, warning: 1, low: 2 };
    if (sevOrder[a.severity] !== sevOrder[b.severity]) return sevOrder[a.severity] - sevOrder[b.severity];
    return a.date.localeCompare(b.date);
  });

  return {
    totalCount: unique.length,
    criticalCount: unique.filter(w => w.severity === 'critical').length,
    warningCount: unique.filter(w => w.severity === 'warning').length,
    lowCount: unique.filter(w => w.severity === 'low').length,
    topWarnings: unique.slice(0, maxDisplay),
    hasMore: unique.length > maxDisplay,
  };
}
