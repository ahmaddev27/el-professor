import { describe, expect, it } from 'vitest';
import {
  MAX_PAIRS_PER_CALL,
  type GeoPoint,
  type RouteBatchAnswer,
  type RoutePair,
  type RouteResult,
} from '../../../supabase/functions/_shared/travel-route-core';
import type { TravelEstimateRequest } from '../tripAnalysis/types';
import type { AddressPrecision } from './estimate';
import { requestKey } from './lookup';
import { prefetchTravelEstimates, type AddressLocator, type LocatedAddress, type TravelRouter } from './prefetch';

const NOW = new Date('2026-10-22T08:00:00.000Z');
const now = () => NOW;

const point = (n: number): GeoPoint => ({ lat: 51 + n / 1000, lon: 7 + n / 1000 });
const located = (n: number, precision: AddressPrecision = 'exact'): LocatedAddress => ({ kind: 'located', point: point(n), precision });
const request = (from: string, to: string, fromAddress: string, toAddress: string): TravelEstimateRequest => ({
  fromTripId: from, toTripId: to, fromAddress, toAddress, departureMs: 0,
});

function locatorOf(table: Record<string, LocatedAddress>) {
  const calls: string[][] = [];
  const locator: AddressLocator = {
    locate: async (addresses) => {
      calls.push([...addresses]);
      return new Map(Object.entries(table).filter(([address]) => addresses.includes(address)));
    },
  };
  return { locator, calls };
}

const routeFor = (pair: RoutePair, over: Partial<Extract<RouteResult, { kind: 'route' }>> = {}): RouteResult => ({
  id: pair.id, kind: 'route', durationSeconds: 600, distanceMeters: 4000, snapMeters: [5, 5], ...over,
});

function routerOf(answer: (pairs: readonly RoutePair[], call: number) => RouteBatchAnswer) {
  const calls: RoutePair[][] = [];
  const router: TravelRouter = {
    route: async (pairs) => {
      calls.push([...pairs]);
      return answer(pairs, calls.length - 1);
    },
  };
  return { router, calls };
}

const everythingRoutes = (dataVersion: string | null = '2026-10-20T23:29:32Z') =>
  routerOf((pairs) => ({ ok: true, dataVersion, results: pairs.map((pair) => routeFor(pair)) }));

describe('prefetchTravelEstimates', () => {
  it('locates each distinct address once, routes the located pairs and answers each request with its own minutes', async () => {
    const locating = locatorOf({ A: located(1), B: located(2), C: located(3) });
    const routing = everythingRoutes();
    const estimator = await prefetchTravelEstimates(
      [request('t1', 't2', 'A', 'B'), request('t2', 't3', 'B', 'C')],
      { locator: locating.locator, router: routing.router, now },
    );
    expect(locating.calls).toHaveLength(1);
    expect([...locating.calls[0]].sort()).toEqual(['A', 'B', 'C']);
    expect(estimator.source).toBe('osrm@2026-10');
    expect(estimator.estimate(request('t1', 't2', 'A', 'B'))).toEqual({
      kind: 'estimated', minutes: 10, source: 'osrm@2026-10', confidence: 'medium', computedAt: NOW.toISOString(),
    });
    expect(estimator.estimate(request('t2', 't3', 'B', 'C')).kind).toBe('estimated');
  });

  it('names no month when the map data does not say one', async () => {
    const estimator = await prefetchTravelEstimates(
      [request('t1', 't2', 'A', 'B')],
      { locator: locatorOf({ A: located(1), B: located(2) }).locator, router: everythingRoutes(null).router, now },
    );
    expect(estimator.source).toBe('osrm');
  });

  it('asks about the same two places once, however many pairs of trips share them', async () => {
    const routing = everythingRoutes();
    const requests = [request('t1', 't2', 'A', 'B'), request('t3', 't4', 'A', 'B'), request('t5', 't6', 'B', 'A')];
    const estimator = await prefetchTravelEstimates(requests, {
      locator: locatorOf({ A: located(1), B: located(2) }).locator, router: routing.router, now,
    });
    expect(routing.calls.flat()).toHaveLength(2);
    expect(estimator.estimate(requests[0]).kind).toBe('estimated');
    expect(estimator.estimate(requests[1])).toEqual(estimator.estimate(requests[0]));
    expect(estimator.estimate(requests[2]).kind).toBe('estimated');
  });

  it('splits what it asks into calls the function accepts, and answers every request', async () => {
    const table: Record<string, LocatedAddress> = {};
    const requests: TravelEstimateRequest[] = [];
    for (let i = 0; i < 250; i += 1) {
      table[`from${i}`] = located(i);
      table[`to${i}`] = located(i + 1000);
      requests.push(request(`a${i}`, `b${i}`, `from${i}`, `to${i}`));
    }
    const routing = everythingRoutes();
    const estimator = await prefetchTravelEstimates(requests, { locator: locatorOf(table).locator, router: routing.router, now });
    expect(routing.calls.map((call) => call.length).sort((a, b) => b - a)).toEqual([MAX_PAIRS_PER_CALL, MAX_PAIRS_PER_CALL, 50]);
    expect(requests.every((r) => estimator.estimate(r).kind === 'estimated')).toBe(true);
  });

  it('leaves a pair with an address nobody could place unavailable, and does not ask the router about it', async () => {
    const routing = everythingRoutes();
    const requests = [request('t1', 't2', 'A', 'B'), request('t2', 't3', 'B', 'Nowhere 1')];
    const estimator = await prefetchTravelEstimates(requests, {
      locator: locatorOf({ A: located(1), B: located(2) }).locator, router: routing.router, now,
    });
    expect(estimator.estimate(requests[0]).kind).toBe('estimated');
    expect(estimator.estimate(requests[1])).toEqual({ kind: 'unavailable', source: 'osrm@2026-10', reason: 'address_not_located' });
    expect(routing.calls.flat()).toHaveLength(1);
  });

  it('carries the reason the locator gave for an address it could not place into the estimate, from the first end that failed', async () => {
    const routing = everythingRoutes();
    const requests = [request('t1', 't2', 'A', 'Street'), request('t2', 't3', 'Street', 'Square'), request('t3', 't4', 'A', 'B')];
    const table: Record<string, LocatedAddress> = {
      A: located(1),
      B: located(2),
      Street: { kind: 'unlocated', reason: 'no_house_number' },
      Square: { kind: 'unlocated', reason: 'too_coarse' },
    };
    const estimator = await prefetchTravelEstimates(requests, { locator: locatorOf(table).locator, router: routing.router, now });
    expect(estimator.estimate(requests[0])).toMatchObject({ kind: 'unavailable', reason: 'address_no_house_number' });
    expect(estimator.estimate(requests[1])).toMatchObject({ kind: 'unavailable', reason: 'address_no_house_number' });
    expect(estimator.estimate(requests[2]).kind).toBe('estimated');
    expect(routing.calls.flat()).toHaveLength(1);
  });

  it('answers locator_failed for everything, and asks no router, when the locator itself fails', async () => {
    const routing = everythingRoutes();
    const locator: AddressLocator = { locate: async () => { throw new Error('geocoder down'); } };
    const requests = [request('t1', 't2', 'A', 'B')];
    const estimator = await prefetchTravelEstimates(requests, { locator, router: routing.router, now });
    expect(estimator.estimate(requests[0])).toEqual({ kind: 'unavailable', source: 'osrm', reason: 'locator_failed' });
    expect(routing.calls).toHaveLength(0);
  });
});

describe('prefetchTravelEstimates when routing fails', () => {
  const requests = [request('t1', 't2', 'A', 'B'), request('t3', 't4', 'C', 'D')];
  const table = { A: located(1), B: located(2), C: located(3), D: located(4) };
  const locator = () => locatorOf(table).locator;

  it('turns a refused or lost call into the reason on every pair it carried', async () => {
    const routing = routerOf(() => ({ ok: false, reason: 'function_unreachable' }));
    const estimator = await prefetchTravelEstimates(requests, { locator: locator(), router: routing.router, now });
    for (const r of requests) {
      expect(estimator.estimate(r)).toEqual({ kind: 'unavailable', source: 'osrm', reason: 'function_unreachable' });
    }
  });

  it('turns a router that throws into function_unreachable instead of throwing', async () => {
    const router: TravelRouter = { route: async () => { throw new Error('boom'); } };
    const estimator = await prefetchTravelEstimates(requests, { locator: locator(), router, now });
    expect(estimator.estimate(requests[0])).toMatchObject({ kind: 'unavailable', reason: 'function_unreachable' });
  });

  it('keeps the pairs of the calls that worked when another call failed', async () => {
    const many: TravelEstimateRequest[] = [];
    const wide: Record<string, LocatedAddress> = {};
    for (let i = 0; i < 150; i += 1) {
      wide[`f${i}`] = located(i);
      wide[`g${i}`] = located(i + 500);
      many.push(request(`a${i}`, `b${i}`, `f${i}`, `g${i}`));
    }
    const routing = routerOf((pairs, call) => (call === 0
      ? { ok: false, reason: 'server_error' }
      : { ok: true, dataVersion: null, results: pairs.map((pair) => routeFor(pair)) }));
    const estimator = await prefetchTravelEstimates(many, { locator: locatorOf(wide).locator, router: routing.router, now, concurrency: 1 });
    const kinds = many.map((r) => estimator.estimate(r).kind);
    expect(kinds.filter((kind) => kind === 'estimated')).toHaveLength(50);
    expect(kinds.filter((kind) => kind === 'unavailable')).toHaveLength(100);
  });

  it('carries a failure of one pair to that pair only', async () => {
    const routing = routerOf((pairs) => ({
      ok: true,
      dataVersion: null,
      results: pairs.map((pair, i) => (i === 0 ? { id: pair.id, kind: 'unavailable', reason: 'no_route' } as RouteResult : routeFor(pair))),
    }));
    const estimator = await prefetchTravelEstimates(requests, { locator: locator(), router: routing.router, now });
    expect(estimator.estimate(requests[0])).toMatchObject({ kind: 'unavailable', reason: 'no_route' });
    expect(estimator.estimate(requests[1]).kind).toBe('estimated');
  });

  it('answers bad_answer for a pair the router left out, and ignores an answer nobody asked for', async () => {
    const routing = routerOf((pairs) => ({
      ok: true,
      dataVersion: null,
      results: [routeFor(pairs[0]), routeFor({ id: 'nobody asked', from: point(9), to: point(8) })],
    }));
    const estimator = await prefetchTravelEstimates(requests, { locator: locator(), router: routing.router, now });
    expect(estimator.estimate(requests[0]).kind).toBe('estimated');
    expect(estimator.estimate(requests[1])).toMatchObject({ kind: 'unavailable', reason: 'bad_answer' });
  });

  it('does not believe a point that had to be moved far onto a road', async () => {
    const routing = routerOf((pairs) => ({
      ok: true, dataVersion: null, results: pairs.map((pair) => routeFor(pair, { snapMeters: [3, 900] })),
    }));
    const estimator = await prefetchTravelEstimates(requests, { locator: locator(), router: routing.router, now });
    expect(estimator.estimate(requests[0])).toMatchObject({ kind: 'unavailable', reason: 'too_far_from_road' });
  });

  it('is low in confidence when the locator was unsure of either address', async () => {
    const vague = locatorOf({ A: located(1, 'approximate'), B: located(2), C: located(3), D: located(4) }).locator;
    const estimator = await prefetchTravelEstimates(requests, { locator: vague, router: everythingRoutes().router, now });
    expect(estimator.estimate(requests[0])).toMatchObject({ kind: 'estimated', confidence: 'low' });
    expect(estimator.estimate(requests[1])).toMatchObject({ kind: 'estimated', confidence: 'medium' });
  });

  it('with nothing to route asks nobody and answers nothing', async () => {
    const routing = everythingRoutes();
    const locating = locatorOf({});
    const estimator = await prefetchTravelEstimates([], { locator: locating.locator, router: routing.router, now });
    expect(locating.calls).toHaveLength(0);
    expect(routing.calls).toHaveLength(0);
    expect(estimator.source).toBe('osrm');
    expect(estimator.estimate(request('x', 'y', 'A', 'B'))).toMatchObject({ kind: 'unavailable', reason: 'not_prefetched' });
  });

  it('keys its answers by the trips, the way the engine asks', async () => {
    const estimator = await prefetchTravelEstimates(requests, { locator: locator(), router: everythingRoutes().router, now });
    expect(requestKey(requests[0])).toBe(JSON.stringify(['t1', 't2']));
    expect(estimator.estimate({ ...requests[0], departureMs: 123 }).kind).toBe('estimated');
  });
});
