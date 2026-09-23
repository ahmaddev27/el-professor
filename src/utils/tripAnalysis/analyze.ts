/**
 * analyzeTrips: one pass over a period's trips that reads and reports.
 *
 * The phases, in order: classify every row, build each driver's blocks, sweep
 * for overlaps (per driver across vehicles, per vehicle across drivers), check
 * the travel between consecutive trips, measure against the recorded shifts,
 * compare each driver with the budget, then index every finding back to its
 * trips, blocks and drivers. Nothing in here writes to an input object, and
 * no output carries a changed driver, time or price.
 */
import { buildBlocks, blockPrices, intervalsOf, timeMetrics, type BuiltBlock } from './blocks';
import { computeBudget } from './budget';
import {
  analysedByDriver,
  assertValidInput,
  classifyTrip,
  isAnalysed,
  keyOf,
  lowestConfidence,
  type ClassifiedTrip,
} from './classify';
import {
  ISSUE_TYPE_ORDER,
  budgetIssues,
  driverNameMismatchIssue,
  driverOverlapIssue,
  noShiftRecordsIssue,
  outsideShiftIssue,
  rowQualityIssue,
  shiftInvalidIssue,
  shiftIsValid,
  shiftOverlapIssue,
  shiftWithoutActivityIssue,
  vehicleOverlapIssue,
} from './findings';
import { compareIds, coveredLength, mergeIntervals, overlappingPairs, totalLength, type Interval } from './intervals';
import { priceSummary } from './prices';
import { noRoutingEstimator, travelFinding, travelPairs } from './travel';
import {
  TRIP_ANALYSIS_ALGORITHM_VERSION,
  type AnalysisShift,
  type AnalyzedTrip,
  type BudgetComparison,
  type BudgetResult,
  type CheckTally,
  type DriverAnalysis,
  type Issue,
  type IssueStatus,
  type TravelTimeEstimator,
  type TripAnalysisInput,
  type TripAnalysisResult,
  type TripBlock,
  type TripStatus,
} from './types';

const MINUTE_MS = 60_000;

type Tally = { -readonly [K in keyof CheckTally]: number };

function emptyTally(): Tally {
  return { passed: 0, conflict: 0, unverifiable: 0 };
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// ── Rows ──────────────────────────────────────────────────────────────────────

interface Rows {
  readonly classified: readonly ClassifiedTrip[];
  /** Every row with a driver id, any status. */
  readonly byDriver: ReadonlyMap<string, ClassifiedTrip[]>;
  /** Analysed rows per driver, sorted by start, then id. */
  readonly analysed: ReadonlyMap<string, ClassifiedTrip[]>;
  /** Keys of `analysed`, sorted. */
  readonly analysedDriverIds: readonly string[];
}

function classifyRows(input: TripAnalysisInput, issues: Issue[]): Rows {
  const classified = input.trips.map((trip, position) => classifyTrip(trip, position));
  const byDriver = new Map<string, ClassifiedTrip[]>();
  for (const c of classified) {
    for (const type of c.quality) issues.push(rowQualityIssue(c, type));
    if (c.driverKey !== null) pushTo(byDriver, c.driverKey, c);
  }
  const analysed = analysedByDriver(classified);
  return { classified, byDriver, analysed, analysedDriverIds: [...analysed.keys()].sort(compareIds) };
}

// ── Blocks and overlaps ───────────────────────────────────────────────────────

function buildAllBlocks(rows: Rows, blockGapMinutes: number): Map<string, BuiltBlock[]> {
  const blocks = new Map<string, BuiltBlock[]>();
  for (const driverId of rows.analysedDriverIds) {
    blocks.set(driverId, buildBlocks(driverId, rows.analysed.get(driverId) ?? [], blockGapMinutes));
  }
  return blocks;
}

interface Overlaps {
  readonly byDriver: ReadonlySet<string>;
  readonly byVehicle: ReadonlySet<string>;
}

function findOverlaps(rows: Rows, issues: Issue[]): Overlaps {
  const byDriver = new Set<string>();
  for (const driverId of rows.analysedDriverIds) {
    for (const [a, b] of overlappingPairs(rows.analysed.get(driverId) ?? [], c => c, c => c.trip.id)) {
      issues.push(driverOverlapIssue(a, b));
      byDriver.add(a.trip.id).add(b.trip.id);
    }
  }

  const vehicles = new Map<string, ClassifiedTrip[]>();
  for (const c of rows.classified) if (isAnalysed(c) && c.vehicleKey !== null) pushTo(vehicles, c.vehicleKey, c);
  const byVehicle = new Set<string>();
  for (const vehicle of [...vehicles.keys()].sort(compareIds)) {
    for (const [a, b] of overlappingPairs(vehicles.get(vehicle) ?? [], c => c, c => c.trip.id)) {
      if (a.driverKey === b.driverKey) continue; // one driver: already a driver_overlap
      issues.push(vehicleOverlapIssue(a, b));
      byVehicle.add(a.trip.id).add(b.trip.id);
    }
  }
  return { byDriver, byVehicle };
}

function checkTravel(rows: Rows, estimator: TravelTimeEstimator, marginMinutes: number, issues: Issue[]): Tally {
  const tally = emptyTally();
  for (const driverId of rows.analysedDriverIds) {
    for (const pair of travelPairs(rows.analysed.get(driverId) ?? [])) {
      const finding = travelFinding(pair, estimator, marginMinutes);
      issues.push(finding);
      tally[finding.status] += 1;
    }
  }
  return tally;
}

// ── Shifts ────────────────────────────────────────────────────────────────────

interface Shifts {
  /** Every shift with a driver id, valid or not. */
  readonly all: ReadonlyMap<string, AnalysisShift[]>;
  /** The union of each driver's valid shifts; absent for a driver with none. */
  readonly merged: ReadonlyMap<string, Interval[]>;
  /** The uncovered part of each analysed trip, for drivers with valid shifts. */
  readonly outsideOfTrip: ReadonlyMap<string, number>;
  readonly withoutActivity: ReadonlyMap<string, string[]>;
}

function checkShifts(input: TripAnalysisInput, rows: Rows, issues: Issue[]): Shifts {
  const all = new Map<string, AnalysisShift[]>();
  const valid = new Map<string, AnalysisShift[]>();
  for (const shift of input.shifts ?? []) {
    const isValid = shiftIsValid(shift);
    if (!isValid) issues.push(shiftInvalidIssue(shift));
    if (typeof shift.driver_id !== 'string' || shift.driver_id.trim() === '') continue;
    pushTo(all, shift.driver_id, shift);
    if (isValid) pushTo(valid, shift.driver_id, shift);
  }

  const merged = new Map<string, Interval[]>();
  for (const driverId of [...valid.keys()].sort(compareIds)) {
    const shifts = valid.get(driverId) ?? [];
    merged.set(driverId, mergeIntervals(shifts.map(s => ({ start: s.start_ms, end: s.end_ms }))));
    for (const [a, b] of overlappingPairs(shifts, s => ({ start: s.start_ms, end: s.end_ms }), s => s.id)) {
      issues.push(shiftOverlapIssue(a, b));
    }
  }

  const outsideOfTrip = new Map<string, number>();
  for (const driverId of rows.analysedDriverIds) {
    const trips = rows.analysed.get(driverId) ?? [];
    const cover = merged.get(driverId);
    if (!cover) {
      issues.push(noShiftRecordsIssue(driverId, trips.length));
      continue;
    }
    for (const c of trips) {
      const outsideMs = c.end - c.start - coveredLength(c, cover);
      outsideOfTrip.set(c.trip.id, outsideMs);
      if (outsideMs > 0) issues.push(outsideShiftIssue(c, outsideMs));
    }
  }

  const withoutActivity = new Map<string, string[]>();
  for (const driverId of [...valid.keys()].sort(compareIds)) {
    const activity = mergeIntervals(intervalsOf(rows.analysed.get(driverId) ?? []));
    const openRows = (rows.byDriver.get(driverId) ?? []).filter(c => !isAnalysed(c) && c.trip.status !== 'cancelled').length;
    const idle = (valid.get(driverId) ?? []).filter(s => coveredLength({ start: s.start_ms, end: s.end_ms }, activity) === 0);
    for (const shift of idle) issues.push(shiftWithoutActivityIssue(shift, openRows));
    withoutActivity.set(driverId, idle.map(s => s.id).sort(compareIds));
  }

  return { all, merged, outsideOfTrip, withoutActivity };
}

// ── Drivers and budget ────────────────────────────────────────────────────────

function compareBudget(budget: BudgetResult, activityMs: number, shiftUnionMs: number | null): BudgetComparison | null {
  if (budget.rangeStatus !== 'ok' || budget.hoursMax === null || budget.hoursMin === null) return null;
  const maxMinutes = budget.hoursMax * 60;
  const activityMinutes = activityMs / MINUTE_MS;
  const shiftMinutes = shiftUnionMs === null ? null : shiftUnionMs / MINUTE_MS;
  return {
    maxMinutes,
    minMinutes: budget.hoursMin * 60,
    activityMinutes,
    shiftMinutes,
    activityVsMaxMinutes: activityMinutes - maxMinutes,
    shiftVsMaxMinutes: shiftMinutes === null ? null : shiftMinutes - maxMinutes,
  };
}

function budgetStatus(comparison: BudgetComparison | null): IssueStatus {
  if (!comparison) return 'unverifiable';
  const over = comparison.activityVsMaxMinutes > 0 || (comparison.shiftVsMaxMinutes ?? 0) > 0;
  return over ? 'conflict' : 'passed';
}

function budgetInputOf(input: TripAnalysisInput, driverId: string) {
  const budgets = input.budgets;
  return budgets && Object.prototype.hasOwnProperty.call(budgets, driverId) ? budgets[driverId] : undefined;
}

type DriverDraft = Omit<DriverAnalysis, 'issueIds'>;

function analyseDriver(
  driverId: string,
  input: TripAnalysisInput,
  rows: Rows,
  blocks: readonly BuiltBlock[],
  shifts: Shifts,
  issues: Issue[],
): DriverDraft {
  const driverRows = rows.byDriver.get(driverId) ?? [];
  const trips = rows.analysed.get(driverId) ?? [];
  const cover = shifts.merged.get(driverId) ?? null;

  const nameIssue = driverNameMismatchIssue(driverId, driverRows);
  if (nameIssue) issues.push(nameIssue);

  const spanMs = blocks.reduce((sum, b) => sum + (b.end - b.start), 0);
  const metrics = timeMetrics(trips, spanMs, cover);
  const shiftUnionMs = cover ? totalLength(cover) : null;

  const budgetInput = budgetInputOf(input, driverId);
  const budget = budgetInput ? computeBudget(budgetInput) : null;
  const comparison = budget ? compareBudget(budget, metrics.unionMs, shiftUnionMs) : null;
  if (budget) issues.push(...budgetIssues(driverId, budget, comparison, lowestConfidence(...trips.map(t => t.confidence))));

  const statusCounts: Record<TripStatus, number> = { completed: 0, cancelled: 0, unknown: 0 };
  const names = new Set<string>();
  for (const row of driverRows) {
    statusCounts[row.trip.status] += 1;
    const name = keyOf(row.trip.driver_name);
    if (name !== null) names.add(name);
  }

  return {
    driverId,
    driverNames: [...names].sort(compareIds),
    tripIds: driverRows.map(r => r.trip.id).sort(compareIds),
    statusCounts,
    analysedTripIds: trips.map(t => t.trip.id),
    blockIds: blocks.map(b => b.id),
    metrics,
    shiftIds: (shifts.all.get(driverId) ?? []).map(s => s.id).sort(compareIds),
    shiftUnionMs,
    shiftsWithoutActivityIds: shifts.withoutActivity.get(driverId) ?? [],
    prices: priceSummary(driverRows.map(r => r.trip)),
    budget,
    budgetComparison: comparison,
  };
}

function allDriverIds(input: TripAnalysisInput, rows: Rows, shifts: Shifts): string[] {
  const ids = new Set<string>([...rows.byDriver.keys(), ...shifts.all.keys()]);
  if (input.budgets) for (const id of Object.keys(input.budgets)) ids.add(id);
  return [...ids].sort(compareIds);
}

// ── Indexing the findings ─────────────────────────────────────────────────────

interface IssueIndex {
  /** Per trip and per driver: unique ids, already in the order of `issues`. */
  readonly ofTrip: ReadonlyMap<string, string[]>;
  readonly ofDriver: ReadonlyMap<string, string[]>;
  /** The given ids, deduplicated, in the order of `issues`. */
  readonly inOrder: (ids: Iterable<string>) => string[];
}

/** Sorts `issues` in place (by kind, then id) and maps every finding to its trips and drivers. */
function indexIssues(issues: Issue[], rows: Rows): IssueIndex {
  const typeRank = new Map(ISSUE_TYPE_ORDER.map((type, rank) => [type, rank]));
  issues.sort((a, b) => (typeRank.get(a.type) ?? 0) - (typeRank.get(b.type) ?? 0) || compareIds(a.id, b.id));
  const rank = new Map(issues.map((issue, position) => [issue.id, position]));
  const driverOfTrip = new Map<string, string>();
  for (const c of rows.classified) if (c.driverKey !== null) driverOfTrip.set(c.trip.id, c.driverKey);

  const ofTrip = new Map<string, string[]>();
  const ofDriver = new Map<string, string[]>();
  for (const issue of issues) {
    const drivers = new Set<string>();
    if (issue.driverId !== undefined) drivers.add(issue.driverId);
    for (const tripId of issue.tripIds) {
      pushTo(ofTrip, tripId, issue.id);
      const driverId = driverOfTrip.get(tripId);
      if (driverId !== undefined) drivers.add(driverId);
    }
    for (const driverId of drivers) pushTo(ofDriver, driverId, issue.id);
  }
  const inOrder = (ids: Iterable<string>) => [...new Set(ids)].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  return { ofTrip, ofDriver, inOrder };
}

function assembleBlocks(blocksByDriver: ReadonlyMap<string, BuiltBlock[]>, shifts: Shifts, index: IssueIndex): TripBlock[] {
  const blocks: TripBlock[] = [];
  for (const driverId of [...blocksByDriver.keys()].sort(compareIds)) {
    const cover = shifts.merged.get(driverId) ?? null;
    for (const block of blocksByDriver.get(driverId) ?? []) {
      blocks.push({
        id: block.id,
        driverId: block.driverId,
        index: block.index,
        vehicle: block.vehicleKey,
        startReason: block.startReason,
        gapBeforeMs: block.gapBeforeMs,
        tripIds: block.members.map(m => m.trip.id),
        startMs: block.start,
        endMs: block.end,
        metrics: timeMetrics(block.members, block.end - block.start, cover),
        prices: blockPrices(block),
        issueIds: index.inOrder(block.members.flatMap(m => index.ofTrip.get(m.trip.id) ?? [])),
      });
    }
  }
  return blocks;
}

// ── Tallies ───────────────────────────────────────────────────────────────────

interface RowTallies {
  readonly driverOverlap: Tally;
  readonly vehicleOverlap: Tally;
  readonly shiftCoverage: Tally;
}

function tallyRows(rows: Rows, overlaps: Overlaps, shifts: Shifts): RowTallies {
  const driverOverlap = emptyTally();
  const vehicleOverlap = emptyTally();
  const shiftCoverage = emptyTally();
  for (const c of rows.classified) {
    const analysed = isAnalysed(c);
    if (c.trip.status !== 'cancelled' && c.driverKey !== null) {
      driverOverlap[!analysed ? 'unverifiable' : overlaps.byDriver.has(c.trip.id) ? 'conflict' : 'passed'] += 1;
    }
    if (!analysed) continue;
    vehicleOverlap[c.vehicleKey === null ? 'unverifiable' : overlaps.byVehicle.has(c.trip.id) ? 'conflict' : 'passed'] += 1;
    const outsideMs = shifts.outsideOfTrip.get(c.trip.id);
    shiftCoverage[outsideMs === undefined ? 'unverifiable' : outsideMs > 0 ? 'conflict' : 'passed'] += 1;
  }
  return { driverOverlap, vehicleOverlap, shiftCoverage };
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function analyzeTrips(input: TripAnalysisInput): TripAnalysisResult {
  assertValidInput(input);
  const settings = {
    blockGapMinutes: input.settings.blockGapMinutes,
    travelMarginMinutes: input.settings.travelMarginMinutes,
  };
  const estimator = input.travelEstimator ?? noRoutingEstimator;
  const issues: Issue[] = [];

  const rows = classifyRows(input, issues);
  const blocksByDriver = buildAllBlocks(rows, settings.blockGapMinutes);
  const overlaps = findOverlaps(rows, issues);
  const travelTally = checkTravel(rows, estimator, settings.travelMarginMinutes, issues);
  const shifts = checkShifts(input, rows, issues);

  const budgetTally = emptyTally();
  const drafts = allDriverIds(input, rows, shifts).map(driverId => {
    const draft = analyseDriver(driverId, input, rows, blocksByDriver.get(driverId) ?? [], shifts, issues);
    budgetTally[budgetStatus(draft.budgetComparison)] += 1;
    return draft;
  });

  const index = indexIssues(issues, rows);
  const blockOfTrip = new Map<string, string>();
  for (const blocks of blocksByDriver.values()) for (const b of blocks) for (const m of b.members) blockOfTrip.set(m.trip.id, b.id);

  const trips: AnalyzedTrip[] = rows.classified.map(c => ({
    trip: c.trip,
    blockId: blockOfTrip.get(c.trip.id) ?? null,
    excludedBecause: c.exclusions,
    outsideShiftMs: shifts.outsideOfTrip.get(c.trip.id) ?? null,
    issueIds: index.ofTrip.get(c.trip.id) ?? [],
  }));
  const byStatus: Record<TripStatus, number> = { completed: 0, cancelled: 0, unknown: 0 };
  for (const c of rows.classified) byStatus[c.trip.status] += 1;
  const reviewTripIds = rows.classified.filter(c => c.quality.length > 0).map(c => c.trip.id);
  const rowTallies = tallyRows(rows, overlaps, shifts);

  return {
    algorithmVersion: TRIP_ANALYSIS_ALGORITHM_VERSION,
    settings,
    travelEstimatorSource: estimator.source,
    counts: {
      rows: rows.classified.length,
      byStatus,
      analysed: rows.classified.filter(isAnalysed).length,
      needsReview: reviewTripIds.length,
    },
    trips,
    blocks: assembleBlocks(blocksByDriver, shifts, index),
    drivers: drafts.map(d => ({ ...d, issueIds: index.ofDriver.get(d.driverId) ?? [] })),
    issues,
    reviewTripIds,
    checks: { ...rowTallies, travelGap: travelTally, budget: budgetTally },
  };
}
