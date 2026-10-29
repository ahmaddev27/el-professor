import { describe, expect, it } from 'vitest';
import type { RouteBatchAnswer, RoutePair } from '../../../supabase/functions/_shared/travel-route-core';
import type { TravelRouter } from '../travelRouting/prefetch';
import { driveSeconds, haversineKm, rideSeconds, roadKm } from './geo';
import {
  ESTIMATE_SOURCE,
  ESTIMATE_TRAVEL_MODEL,
  RIDE_HANDLING_SECONDS,
  buildRoutedMatrix,
  matrixCoverage,
  matrixTravelModel,
  pointKey,
  selectRoutingPoints,
  type RoutedMatrix,
} from './travelModel';
import type { GeoPoint, PoolAddress } from './types';

const A: GeoPoint = { lat: 51.1, lon: 7.0 };
const B: GeoPoint = { lat: 51.12, lon: 7.03 };
const C: GeoPoint = { lat: 51.14, lon: 7.01 };

const key = (a: GeoPoint, b: GeoPoint) => `${pointKey(a)}>${pointKey(b)}`;

/** A router that answers every pair from the straight line at 15 km/h, and records what it was asked. */
function slowRouter(options: { refuse?: (p: RoutePair) => string | null; snap?: (p: RoutePair) => number; batchFailure?: number[] } = {}) {
  const calls: RoutePair[][] = [];
  const router: TravelRouter = {
    route: async (pairs): Promise<RouteBatchAnswer> => {
      calls.push([...pairs]);
      if (options.batchFailure?.includes(calls.length)) return { ok: false, reason: 'function_unreachable' };
      return {
        ok: true,
        dataVersion: '2026-10-02T00:00:00Z',
        results: pairs.map(p => {
          const refused = options.refuse?.(p) ?? null;
          if (refused) return { id: p.id, kind: 'unavailable' as const, reason: refused as 'no_route' };
          const km = haversineKm(p.from, p.to) * 1.4;
          return { id: p.id, kind: 'route' as const, durationSeconds: (km / 15) * 3600, distanceMeters: km * 1000, snapMeters: [3, options.snap?.(p) ?? 4] as const };
        }),
      };
    },
  };
  return { router, calls };
}

describe('the estimate model', () => {
  it('is today\'s geo.ts model, labelled as an estimate', () => {
    for (const hour of [3, 8, 13, 17, 23]) {
      expect(ESTIMATE_TRAVEL_MODEL.drive(A, B, hour)).toEqual({ seconds: driveSeconds(roadKm(A, B), hour), km: roadKm(A, B) });
      expect(ESTIMATE_TRAVEL_MODEL.ride(A, B, hour)).toEqual({ seconds: rideSeconds(roadKm(A, B), hour), km: roadKm(A, B) });
    }
    expect(ESTIMATE_TRAVEL_MODEL.source).toBe(ESTIMATE_SOURCE);
    expect(ESTIMATE_TRAVEL_MODEL.measured).toBe(false);
  });
});

describe('a measured matrix', () => {
  const matrix: RoutedMatrix = {
    source: 'osrm@2026-10',
    computedAt: '2026-10-29T10:00:00.000Z',
    points: [A, B, C],
    legs: { [key(A, B)]: { seconds: 412.4, km: 3.1 }, [key(B, A)]: { seconds: 0, km: 0.2 } },
    failures: { [key(A, C)]: 'no_route' },
  };
  const model = matrixTravelModel(matrix);

  it('answers a measured leg in whole seconds, and a ride with its boarding time', () => {
    expect(model.drive(A, B, 8)).toEqual({ seconds: 413, km: 3.1 });
    expect(model.ride(A, B, 8)).toEqual({ seconds: 413 + RIDE_HANDLING_SECONDS, km: 3.1 });
    expect(model.measured).toBe(true);
    expect(model.source).toBe('osrm@2026-10');
  });

  it('answers no route for a failed pair and for a pair it never asked, never zero', () => {
    expect(model.drive(A, C, 8)).toBeNull();
    expect(model.drive(C, A, 8)).toBeNull();
    expect(model.ride(A, C, 8)).toBeNull();
  });

  it('reads a zero-second route between two distinct points as no route', () => {
    expect(model.drive(B, A, 8)).toBeNull();
  });

  it('is zero only for the same point, and has no ride from a point to itself', () => {
    expect(model.drive(A, { lat: 51.1, lon: 7.0 }, 8)).toEqual({ seconds: 0, km: 0 });
    expect(model.ride(A, A, 8)).toBeNull();
  });
});

describe('building the matrix', () => {
  const points: GeoPoint[] = Array.from({ length: 12 }, (_, i) => ({ lat: 51.1 + i * 0.004, lon: 7.0 + (i % 4) * 0.01 }));
  const noSleep = { sleep: async () => {}, now: () => new Date('2026-10-29T10:00:00Z') };

  it('asks every ordered pair once, at most 100 per call, and labels the source from the data version', async () => {
    const { router, calls } = slowRouter();
    const matrix = await buildRoutedMatrix(points, router, noSleep);
    expect(calls.every(c => c.length <= 100)).toBe(true);
    expect(calls.flat().length).toBe(12 * 11);
    expect(Object.keys(matrix.legs).length).toBe(132);
    expect(matrixCoverage(matrix)).toEqual({ pairs: 132, routed: 132, failed: 0, byReason: {} });
    expect(matrix.source).toBe('osrm@2026-10');
  });

  it('keeps the reason of every pair it could not route, and never a leg for it', async () => {
    const far = points[3];
    const { router } = slowRouter({
      refuse: p => (p.from.lat === Number(far.lat.toFixed(6)) && p.from.lon === Number(far.lon.toFixed(6)) ? 'no_route' : null),
      snap: p => (p.to.lat === Number(points[5].lat.toFixed(6)) && p.to.lon === Number(points[5].lon.toFixed(6)) ? 251 : 4),
    });
    const matrix = await buildRoutedMatrix(points, router, noSleep);
    const model = matrixTravelModel(matrix);
    expect(matrix.failures[key(far, points[0])]).toBe('no_route');
    expect(matrix.failures[key(points[0], points[5])]).toBe('too_far_from_road');
    expect(model.drive(far, points[0], 8)).toBeNull();
    expect(model.drive(points[0], points[5], 8)).toBeNull();
    for (const k of Object.keys(matrix.failures)) expect(matrix.legs[k]).toBeUndefined();
  });

  it('retries a call that failed for an infrastructure reason exactly once', async () => {
    const { router, calls } = slowRouter({ batchFailure: [1] });
    const matrix = await buildRoutedMatrix(points, router, noSleep);
    expect(calls.length).toBe(3); // 132 pairs: calls 1 (failed) and 2, then one retry of the 100 failed
    expect(Object.keys(matrix.failures)).toEqual([]);
  });

  it('leaves a pair failed when the retry fails too', async () => {
    const { router } = slowRouter({ batchFailure: [1, 3] });
    const matrix = await buildRoutedMatrix(points, router, noSleep);
    expect(matrixCoverage(matrix).byReason).toEqual({ function_unreachable: 100 });
  });
});

describe('choosing the routed points', () => {
  const pool: PoolAddress[] = Array.from({ length: 40 }, (_, i) => ({ label: `Teststraße ${i + 1}, 40210 Demostadt, Deutschland`, lat: 51.1 + i * 0.001, lon: 7.0 }));

  it('is stable for a pool whatever its order, and takes at most max', () => {
    const one = selectRoutingPoints(pool, 16);
    const two = selectRoutingPoints([...pool].reverse(), 16);
    expect(one).toHaveLength(16);
    expect(one.map(a => a.label)).toEqual(two.map(a => a.label));
  });

  it('never routes one point twice', () => {
    const doubled = [...pool, ...pool.map(a => ({ ...a, label: `${a.label} (dup)` }))];
    const picked = selectRoutingPoints(doubled, 80);
    expect(new Set(picked.map(pointKey)).size).toBe(picked.length);
  });
});
