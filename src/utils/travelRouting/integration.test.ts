import { describe, expect, it } from 'vitest';
import type { RouteBatchAnswer, RoutePair } from '../../../supabase/functions/_shared/travel-route-core';
import { analyzeTrips, listTravelRequests } from '../tripAnalysis';
import type { AnalysisTrip, Issue, TripAnalysisInput } from '../tripAnalysis/types';
import { prefetchTravelEstimates, type AddressLocator, type TravelRouter } from './prefetch';

/**
 * The point of the whole slice: with an estimate present, the rule travel.ts
 * already has (required = estimate + margin, short by > 0 is a conflict) moves
 * a check from "nicht prüfbar" to passed or conflict, and nothing else moves.
 */
const MIN = 60_000;
const BASE = new Date('2026-08-03T06:00:00').getTime();

function trip(id: string, startMin: number, endMin: number, pickup: string | null, dropoff: string | null): AnalysisTrip {
  return {
    id, driver_id: 'd1', driver_name: 'Fahrer Eins', vehicle: 'SG-XX 1',
    start_ms: BASE + startMin * MIN, end_ms: BASE + endMin * MIN,
    status: 'completed', price: null, currency: null, source_row: null,
    pickup_address: pickup, dropoff_address: dropoff,
  };
}

const INPUT: TripAnalysisInput = {
  trips: [
    trip('t1', 0, 30, 'P1', 'D1'),
    trip('t2', 40, 70, 'P2', 'D2'), // 10 minutes after t1
    trip('t3', 100, 130, 'P3', 'D3'), // 30 minutes after t2
    trip('t4', 140, 170, null, 'D4'), // no pickup address
  ],
  settings: { blockGapMinutes: 30, travelMarginMinutes: 5 },
};

const places = new Map([
  ['D1', 1], ['P2', 2], ['D2', 3], ['P3', 4],
].map(([address, n]) => [address as string, { kind: 'located' as const, point: { lat: 51 + (n as number) / 100, lon: 7 }, precision: 'exact' as const }]));

const locator: AddressLocator = { locate: async () => places };
const route = (seconds: number, snap: [number, number] = [5, 5]): TravelRouter => ({
  route: async (pairs: readonly RoutePair[]): Promise<RouteBatchAnswer> => ({
    ok: true,
    dataVersion: '2026-10-20T23:29:32Z',
    results: pairs.map((pair) => ({ id: pair.id, kind: 'route', durationSeconds: seconds, distanceMeters: 5000, snapMeters: snap })),
  }),
});

const travel = (issues: readonly Issue[]) =>
  Object.fromEntries(issues.filter((i) => i.type === 'travel_gap').map((i) => [i.id.replace('travel_gap:', ''), i]));

describe('the travel check with an OSRM estimate', () => {
  it('without any estimator every pair is unverifiable, which is what the screen shows today', () => {
    const result = analyzeTrips(INPUT);
    expect(result.travelEstimatorSource).toBe('none');
    expect(Object.values(travel(result.issues)).map((i) => i.status)).toEqual(['unverifiable', 'unverifiable', 'unverifiable']);
  });

  it('moves the pairs that can be checked to conflict or passed by the existing rule, and the pair without an address stays unverifiable', async () => {
    const estimator = await prefetchTravelEstimates(listTravelRequests(INPUT), { locator, router: route(612) });
    const result = analyzeTrips({ ...INPUT, travelEstimator: estimator });
    const issues = travel(result.issues);
    expect(result.travelEstimatorSource).toBe('osrm@2026-10');
    expect(issues['t1>t2']).toMatchObject({ status: 'conflict', severity: 'warning' });
    expect(issues['t1>t2'].values).toMatchObject({ estimateMinutes: 612 / 60, requiredMinutes: 612 / 60 + 5, availableMinutes: 10, estimateSource: 'osrm@2026-10' });
    expect(issues['t1>t2'].values.shortByMinutes).toBeCloseTo(612 / 60 + 5 - 10, 9);
    expect(issues['t2>t3']).toMatchObject({ status: 'passed', severity: 'info' });
    expect(issues['t3>t4']).toMatchObject({ status: 'unverifiable' });
    expect(issues['t3>t4'].values).toMatchObject({ reason: 'address_missing' });
  });

  it('keeps the margin where it was: a bigger buffer turns the same drive into a conflict', async () => {
    const estimator = await prefetchTravelEstimates(listTravelRequests(INPUT), { locator, router: route(612) });
    const wide = analyzeTrips({ ...INPUT, settings: { blockGapMinutes: 30, travelMarginMinutes: 25 }, travelEstimator: estimator });
    expect(travel(wide.issues)['t2>t3']).toMatchObject({ status: 'conflict' });
  });

  it('is medium in confidence at best, because a drive time without traffic is a model', async () => {
    const estimator = await prefetchTravelEstimates(listTravelRequests(INPUT), { locator, router: route(612) });
    const issues = travel(analyzeTrips({ ...INPUT, travelEstimator: estimator }).issues);
    expect(issues['t1>t2'].confidence).toBe('medium');
    expect(issues['t2>t3'].confidence).toBe('medium');
  });

  it('never turns a failed lookup into a pass or a conflict', async () => {
    const failing: TravelRouter = { route: async () => ({ ok: false, reason: 'function_unreachable' }) };
    const estimator = await prefetchTravelEstimates(listTravelRequests(INPUT), { locator, router: failing });
    const issues = Object.values(travel(analyzeTrips({ ...INPUT, travelEstimator: estimator }).issues));
    expect(issues.map((i) => i.status)).toEqual(['unverifiable', 'unverifiable', 'unverifiable']);
    expect(issues[0].values).toMatchObject({ reason: 'function_unreachable', estimateMinutes: null, requiredMinutes: null });
  });

  it('never turns a point far from any road into a verdict', async () => {
    const estimator = await prefetchTravelEstimates(listTravelRequests(INPUT), { locator, router: route(612, [5, 4000]) });
    const issues = travel(analyzeTrips({ ...INPUT, travelEstimator: estimator }).issues);
    expect(issues['t1>t2']).toMatchObject({ status: 'unverifiable' });
    expect(issues['t1>t2'].values).toMatchObject({ reason: 'too_far_from_road' });
  });

  it('leaves every non-travel finding exactly as it was', async () => {
    const estimator = await prefetchTravelEstimates(listTravelRequests(INPUT), { locator, router: route(612) });
    const without = analyzeTrips(INPUT);
    const withIt = analyzeTrips({ ...INPUT, travelEstimator: estimator });
    const others = (issues: readonly Issue[]) => issues.filter((i) => i.type !== 'travel_gap');
    expect(others(withIt.issues)).toEqual(others(without.issues));
    expect(withIt.blocks).toEqual(without.blocks);
    expect(withIt.drivers.map((d) => d.driverId)).toEqual(without.drivers.map((d) => d.driverId));
  });
});
