/**
 * Which rows the analysis can measure, and why the others cannot.
 *
 * A row is ANALYSED when it is completed, has a driver, and has a start, an
 * end not before it, and no DST-ambiguous local time. Every other row is kept
 * in the result with its reasons; none is dropped from a count or a report.
 * Cancelled rows are expected exclusions; every other exclusion is a review
 * item. A missing vehicle does not exclude a row, it only makes the vehicle
 * check unverifiable for it.
 */
import type { AnalysisTrip, Confidence, TripAnalysisInput, TripExclusionReason } from './types';

/** Row-quality findings; each is also the reason a row is on the review list. */
export type RowQualityType =
  | 'missing_driver'
  | 'missing_vehicle'
  | 'missing_start'
  | 'missing_end'
  | 'end_before_start'
  | 'status_unknown'
  | 'ambiguous_local_time';

export interface ClassifiedTrip {
  readonly trip: AnalysisTrip;
  /** Input position, so results can be returned in input order. */
  readonly position: number;
  readonly driverKey: string | null;
  readonly vehicleKey: string | null;
  readonly exclusions: readonly TripExclusionReason[];
  readonly quality: readonly RowQualityType[];
  /** Set only for analysed rows. */
  readonly start: number;
  readonly end: number;
  readonly confidence: Confidence;
}

/** Trimmed, inner whitespace collapsed; null when nothing is left. */
export function keyOf(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const key = value.trim().replace(/\s+/g, ' ');
  return key === '' ? null : key;
}

function finite(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

/** Minute-precision fallback times make a finding less certain; absolute and full local times do not. */
export function timeConfidence(trip: AnalysisTrip): Confidence {
  return trip.time_source === 'trip_date_hhmm' ? 'medium' : 'high';
}

const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = { high: 2, medium: 1, low: 0 };

export function lowestConfidence(...values: Confidence[]): Confidence {
  return values.reduce<Confidence>((low, c) => (CONFIDENCE_RANK[c] < CONFIDENCE_RANK[low] ? c : low), 'high');
}

/** A driver id is matched exactly, as shifts and budgets are keyed; only a blank one counts as missing. */
function driverIdOf(trip: AnalysisTrip): string | null {
  return trip.driver_id !== null && trip.driver_id.trim() !== '' ? trip.driver_id : null;
}

export function classifyTrip(trip: AnalysisTrip, position: number): ClassifiedTrip {
  const driverKey = driverIdOf(trip);
  const vehicleKey = keyOf(trip.vehicle);
  const exclusions: TripExclusionReason[] = [];
  const quality: RowQualityType[] = [];

  if (trip.status === 'cancelled') {
    exclusions.push('cancelled');
  } else {
    if (trip.status === 'unknown') {
      exclusions.push('status_unknown');
      quality.push('status_unknown');
    }
    if (driverKey === null) {
      exclusions.push('missing_driver');
      quality.push('missing_driver');
    }
    const hasStart = finite(trip.start_ms);
    const hasEnd = finite(trip.end_ms);
    if (!hasStart) {
      exclusions.push('missing_start');
      quality.push('missing_start');
    }
    if (!hasEnd) {
      exclusions.push('missing_end');
      quality.push('missing_end');
    }
    // An ambiguous local time can put the end before the start by itself (02:50
    // then 02:10 on the October Sunday); that row is judged ambiguous, not wrong.
    if (hasStart && hasEnd && !trip.time_ambiguity && (trip.end_ms as number) < (trip.start_ms as number)) {
      exclusions.push('end_before_start');
      quality.push('end_before_start');
    }
    if (trip.time_ambiguity) {
      exclusions.push('ambiguous_local_time');
      quality.push('ambiguous_local_time');
    }
    if (vehicleKey === null) quality.push('missing_vehicle');
  }

  return {
    trip,
    position,
    driverKey,
    vehicleKey,
    exclusions,
    quality,
    start: finite(trip.start_ms) ? trip.start_ms : Number.NaN,
    end: finite(trip.end_ms) ? trip.end_ms : Number.NaN,
    confidence: timeConfidence(trip),
  };
}

export function isAnalysed(trip: ClassifiedTrip): boolean {
  return trip.exclusions.length === 0;
}

/** Sort key of the whole engine: start, then id. */
export function byStartThenId(a: ClassifiedTrip, b: ClassifiedTrip): number {
  if (a.start !== b.start) return a.start - b.start;
  if (a.trip.id < b.trip.id) return -1;
  if (a.trip.id > b.trip.id) return 1;
  return 0;
}

/** Contract checks. A broken contract throws; bad data never does, it becomes a finding. */
export function assertValidInput(input: TripAnalysisInput): void {
  const { blockGapMinutes, travelMarginMinutes } = input.settings;
  if (!Number.isFinite(blockGapMinutes) || blockGapMinutes < 0) {
    throw new RangeError('analyzeTrips: settings.blockGapMinutes must be a finite number ≥ 0');
  }
  if (!Number.isFinite(travelMarginMinutes) || travelMarginMinutes < 0) {
    throw new RangeError('analyzeTrips: settings.travelMarginMinutes must be a finite number ≥ 0');
  }
  assertUniqueIds(input.trips.map(t => t.id), 'trip');
  assertUniqueIds((input.shifts ?? []).map(s => s.id), 'shift');
}

function assertUniqueIds(ids: readonly string[], what: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') throw new RangeError(`analyzeTrips: every ${what} needs a non-empty id`);
    if (seen.has(id)) throw new RangeError(`analyzeTrips: duplicate ${what} id "${id}"`);
    seen.add(id);
  }
}

/** Analysed rows grouped by driver, each group sorted by start, then id. */
export function analysedByDriver(classified: readonly ClassifiedTrip[]): Map<string, ClassifiedTrip[]> {
  const groups = new Map<string, ClassifiedTrip[]>();
  for (const c of classified) {
    if (!isAnalysed(c) || c.driverKey === null) continue;
    const group = groups.get(c.driverKey);
    if (group) group.push(c);
    else groups.set(c.driverKey, [c]);
  }
  for (const group of groups.values()) group.sort(byStartThenId);
  return groups;
}
