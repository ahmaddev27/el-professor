/**
 * analyzeTrips: one pass over a period's trips that reads and reports.
 *
 * Order of work: classify every row, build each driver's blocks, sweep for
 * overlaps (per driver across vehicles, per vehicle across drivers), check the
 * travel between consecutive trips, measure against the recorded shifts,
 * compare with the budget, then index every finding back to its trips,
 * blocks and drivers. Nothing in here writes to an input object, and no
 * output carries a changed driver, time or price.
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
  type BudgetInput,
  type BudgetResult,
  type CheckTally,
  type DriverAnalysis,
  type Issue,
  type TripAnalysisInput,
  type TripAnalysisResult,
  type TripBlock,
  type TripStatus,
} from './types';

const MINUTE_MS = 60_000;

interface ShiftGroup {
  readonly all: AnalysisShift[];
  readonly valid: AnalysisShift[];
}

interface MutableTally {
  passed: number;
  conflict: number;
  unverifiable: number;
}

function tally(): MutableTally {
  return { passed: 0, conflict: 0, unverifiable: 0 };
}

function count(t: MutableTally, status: 'passed' | 'conflict' | 'unverifiable'): void {
  t[status] += 1;
}

function sortedKeys<T>(map: ReadonlyMap<string, T>): string[] {
  return [...map.keys()].sort(compareIds);
}

function groupShifts(shifts: readonly AnalysisShift[], issues: Issue[]): Map<string, ShiftGroup> {
  const groups = new Map<string, ShiftGroup>();
  for (const shift of shifts) {
    const valid = shiftIsValid(shift);
    if (!valid) issues.push(shiftInvalidIssue(shift));
    if (typeof shift.driver_id !== 'string' || shift.driver_id.trim() === '') continue;
    let group = groups.get(shift.driver_id);
    if (!group) {
      group = { all: [], valid: [] };
      groups.set(shift.driver_id, group);
    }
    group.all.push(shift);
    if (valid) group.valid.push(shift);
  }
  return groups;
}

function shiftIntervals(shifts: readonly AnalysisShift[]): Interval[] {
  return shifts.map(s => ({ start: s.start_ms, end: s.end_ms }));
}

function hasBudget(budgets: TripAnalysisInput['budgets'], driverId: string): budgets is Readonly<Record<string, BudgetInput>> {
  return budgets !== undefined && Object.prototype.hasOwnProperty.call(budgets, driverId);
}

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

export function analyzeTrips(input: TripAnalysisInput): TripAnalysisResult {
  assertValidInput(input);
  const settings = {
    blockGapMinutes: input.settings.blockGapMinutes,
    travelMarginMinutes: input.settings.travelMarginMinutes,
  };
  const estimator = input.travelEstimator ?? noRoutingEstimator;
  const issues: Issue[] = [];

  // ── Rows ──
  const classified = input.trips.map((trip, position) => classifyTrip(trip, position));
  for (const c of classified) for (const type of c.quality) issues.push(rowQualityIssue(c, type));

  const rowsByDriver = new Map<string, ClassifiedTrip[]>();
  for (const c of classified) {
    if (c.driverKey === null) continue;
    const rows = rowsByDriver.get(c.driverKey);
    if (rows) rows.push(c);
    else rowsByDriver.set(c.driverKey, [c]);
  }
  const analysed = analysedByDriver(classified);

  // ── Blocks ──
  const blocksByDriver = new Map<string, BuiltBlock[]>();
  const blockOfTrip = new Map<string, string>();
  for (const driverId of sortedKeys(analysed)) {
    const blocks = buildBlocks(driverId, analysed.get(driverId) ?? [], settings.blockGapMinutes);
    blocksByDriver.set(driverId, blocks);
    for (const block of blocks) for (const m of block.members) blockOfTrip.set(m.trip.id, block.id);
  }

  // ── Overlaps: per driver across vehicles, per vehicle across drivers ──
  const inDriverOverlap = new Set<string>();
  for (const driverId of sortedKeys(analysed)) {
    for (const [a, b] of overlappingPairs(analysed.get(driverId) ?? [], c => c, c => c.trip.id)) {
      issues.push(driverOverlapIssue(a, b));
      inDriverOverlap.add(a.trip.id).add(b.trip.id);
    }
  }
  const byVehicle = new Map<string, ClassifiedTrip[]>();
  for (const c of classified) {
    if (!isAnalysed(c) || c.vehicleKey === null) continue;
    const group = byVehicle.get(c.vehicleKey);
    if (group) group.push(c);
    else byVehicle.set(c.vehicleKey, [c]);
  }
  const inVehicleOverlap = new Set<string>();
  for (const vehicle of sortedKeys(byVehicle)) {
    for (const [a, b] of overlappingPairs(byVehicle.get(vehicle) ?? [], c => c, c => c.trip.id)) {
      if (a.driverKey === b.driverKey) continue; // the same driver: already a driver_overlap
      issues.push(vehicleOverlapIssue(a, b));
      inVehicleOverlap.add(a.trip.id).add(b.trip.id);
    }
  }

  // ── Travel ──
  const travelTally = tally();
  for (const driverId of sortedKeys(analysed)) {
    for (const pair of travelPairs(analysed.get(driverId) ?? [])) {
      const finding = travelFinding(pair, estimator, settings.travelMarginMinutes);
      issues.push(finding);
      count(travelTally, finding.status);
    }
  }

  // ── Shifts ──
  const shiftGroups = groupShifts(input.shifts ?? [], issues);
  const mergedShifts = new Map<string, Interval[]>();
  for (const driverId of sortedKeys(shiftGroups)) {
    const group = shiftGroups.get(driverId) as ShiftGroup;
    if (group.valid.length > 0) mergedShifts.set(driverId, mergeIntervals(shiftIntervals(group.valid)));
    for (const [a, b] of overlappingPairs(group.valid, s => ({ start: s.start_ms, end: s.end_ms }), s => s.id)) {
      issues.push(shiftOverlapIssue(a, b));
    }
  }

  const outsideOfTrip = new Map<string, number>();
  for (const driverId of sortedKeys(analysed)) {
    const trips = analysed.get(driverId) ?? [];
    const shifts = mergedShifts.get(driverId);
    if (!shifts) {
      issues.push(noShiftRecordsIssue(driverId, trips.length));
      continue;
    }
    for (const c of trips) {
      const outsideMs = c.end - c.start - coveredLength({ start: c.start, end: c.end }, shifts);
      outsideOfTrip.set(c.trip.id, outsideMs);
      if (outsideMs > 0) issues.push(outsideShiftIssue(c, outsideMs));
    }
  }

  const shiftsWithoutActivity = new Map<string, string[]>();
  for (const driverId of sortedKeys(shiftGroups)) {
    const group = shiftGroups.get(driverId) as ShiftGroup;
    const activity = mergeIntervals(intervalsOf(analysed.get(driverId) ?? []));
    const openRows = (rowsByDriver.get(driverId) ?? []).filter(c => !isAnalysed(c) && c.trip.status !== 'cancelled').length;
    const idle: string[] = [];
    for (const shift of group.valid) {
      if (coveredLength({ start: shift.start_ms, end: shift.end_ms }, activity) > 0) continue;
      idle.push(shift.id);
      issues.push(shiftWithoutActivityIssue(shift, openRows));
    }
    shiftsWithoutActivity.set(driverId, idle.sort(compareIds));
  }

  // ── Drivers ──
  const driverIds = new Set<string>([...rowsByDriver.keys(), ...shiftGroups.keys()]);
  if (input.budgets) for (const id of Object.keys(input.budgets)) driverIds.add(id);

  const budgetTally = tally();
  const driverDrafts: Array<Omit<DriverAnalysis, 'issueIds'>> = [];
  for (const driverId of [...driverIds].sort(compareIds)) {
    const rows = rowsByDriver.get(driverId) ?? [];
    const trips = analysed.get(driverId) ?? [];
    const blocks = blocksByDriver.get(driverId) ?? [];
    const shifts = mergedShifts.get(driverId) ?? null;
    const group = shiftGroups.get(driverId);

    const nameIssue = driverNameMismatchIssue(driverId, rows);
    if (nameIssue) issues.push(nameIssue);

    const spanMs = blocks.reduce((sum, b) => sum + (b.end - b.start), 0);
    const metrics = timeMetrics(trips, spanMs, shifts);
    const shiftUnionMs = shifts ? totalLength(shifts) : null;

    const budget = hasBudget(input.budgets, driverId) ? computeBudget(input.budgets[driverId]) : null;
    const comparison = budget ? compareBudget(budget, metrics.unionMs, shiftUnionMs) : null;
    if (budget) {
      const confidence = lowestConfidence(...trips.map(t => t.confidence));
      issues.push(...budgetIssues(driverId, budget, comparison, confidence));
    }
    if (!comparison) count(budgetTally, 'unverifiable');
    else if (comparison.activityVsMaxMinutes > 0 || (comparison.shiftVsMaxMinutes ?? 0) > 0) count(budgetTally, 'conflict');
    else count(budgetTally, 'passed');

    const statusCounts: Record<TripStatus, number> = { completed: 0, cancelled: 0, unknown: 0 };
    for (const row of rows) statusCounts[row.trip.status] += 1;
    const names = new Set<string>();
    for (const row of rows) {
      const name = keyOf(row.trip.driver_name);
      if (name !== null) names.add(name);
    }

    driverDrafts.push({
      driverId,
      driverNames: [...names].sort(compareIds),
      tripIds: rows.map(r => r.trip.id).sort(compareIds),
      statusCounts,
      analysedTripIds: trips.map(t => t.trip.id),
      blockIds: blocks.map(b => b.id),
      metrics,
      shiftIds: (group?.all ?? []).map(s => s.id).sort(compareIds),
      shiftUnionMs,
      shiftsWithoutActivityIds: shiftsWithoutActivity.get(driverId) ?? [],
      prices: priceSummary(rows.map(r => r.trip)),
      budget,
      budgetComparison: comparison,
    });
  }

  // ── Index the findings ──
  const typeRank = new Map(ISSUE_TYPE_ORDER.map((type, rank) => [type, rank]));
  issues.sort((a, b) => (typeRank.get(a.type) ?? 0) - (typeRank.get(b.type) ?? 0) || compareIds(a.id, b.id));
  const issueRank = new Map(issues.map((issue, rank) => [issue.id, rank]));
  const issuesOfTrip = new Map<string, string[]>();
  const issuesOfDriver = new Map<string, Set<string>>();
  const driverOfTrip = new Map(classified.filter(c => c.driverKey !== null).map(c => [c.trip.id, c.driverKey as string]));
  const addToDriver = (driverId: string, issueId: string) => {
    const set = issuesOfDriver.get(driverId);
    if (set) set.add(issueId);
    else issuesOfDriver.set(driverId, new Set([issueId]));
  };
  for (const issue of issues) {
    if (issue.driverId !== undefined) addToDriver(issue.driverId, issue.id);
    for (const tripId of issue.tripIds) {
      const list = issuesOfTrip.get(tripId);
      if (list) list.push(issue.id);
      else issuesOfTrip.set(tripId, [issue.id]);
      const driverId = driverOfTrip.get(tripId);
      if (driverId !== undefined) addToDriver(driverId, issue.id);
    }
  }
  const inIssueOrder = (ids: Iterable<string>) =>
    [...new Set(ids)].sort((a, b) => (issueRank.get(a) ?? 0) - (issueRank.get(b) ?? 0));

  const blocks: TripBlock[] = [];
  for (const driverId of sortedKeys(blocksByDriver)) {
    const shifts = mergedShifts.get(driverId) ?? null;
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
        metrics: timeMetrics(block.members, block.end - block.start, shifts),
        prices: blockPrices(block),
        issueIds: inIssueOrder(block.members.flatMap(m => issuesOfTrip.get(m.trip.id) ?? [])),
      });
    }
  }

  const drivers: DriverAnalysis[] = driverDrafts.map(d => ({
    ...d,
    issueIds: inIssueOrder(issuesOfDriver.get(d.driverId) ?? []),
  }));

  const trips: AnalyzedTrip[] = classified.map(c => ({
    trip: c.trip,
    blockId: blockOfTrip.get(c.trip.id) ?? null,
    excludedBecause: c.exclusions,
    outsideShiftMs: outsideOfTrip.get(c.trip.id) ?? null,
    issueIds: issuesOfTrip.get(c.trip.id) ?? [],
  }));

  // ── Tallies and counts ──
  const driverOverlap = tally();
  const vehicleOverlap = tally();
  const shiftCoverage = tally();
  const byStatus: Record<TripStatus, number> = { completed: 0, cancelled: 0, unknown: 0 };
  let analysedCount = 0;
  for (const c of classified) {
    byStatus[c.trip.status] += 1;
    if (c.trip.status !== 'cancelled' && c.driverKey !== null) {
      if (!isAnalysed(c)) count(driverOverlap, 'unverifiable');
      else count(driverOverlap, inDriverOverlap.has(c.trip.id) ? 'conflict' : 'passed');
    }
    if (!isAnalysed(c)) continue;
    analysedCount += 1;
    if (c.vehicleKey === null) count(vehicleOverlap, 'unverifiable');
    else count(vehicleOverlap, inVehicleOverlap.has(c.trip.id) ? 'conflict' : 'passed');
    const outsideMs = outsideOfTrip.get(c.trip.id);
    if (outsideMs === undefined) count(shiftCoverage, 'unverifiable');
    else count(shiftCoverage, outsideMs > 0 ? 'conflict' : 'passed');
  }
  const reviewTripIds = classified.filter(c => c.quality.length > 0).map(c => c.trip.id);
  const frozen = (t: MutableTally): CheckTally => ({ ...t });

  return {
    algorithmVersion: TRIP_ANALYSIS_ALGORITHM_VERSION,
    settings,
    travelEstimatorSource: estimator.source,
    counts: {
      rows: classified.length,
      byStatus,
      analysed: analysedCount,
      needsReview: reviewTripIds.length,
    },
    trips,
    blocks,
    drivers,
    issues,
    reviewTripIds,
    checks: {
      driverOverlap: frozen(driverOverlap),
      vehicleOverlap: frozen(vehicleOverlap),
      travelGap: frozen(travelTally),
      shiftCoverage: frozen(shiftCoverage),
      budget: frozen(budgetTally),
    },
  };
}
