import { describe, expect, it } from 'vitest';
import type { RouteBatchAnswer } from '../../supabase/functions/_shared/travel-route-core';
import { haversineKm } from '../utils/simulatedRides/geo';
import { pointKey } from '../utils/simulatedRides/travelModel';
import type { PoolAddress } from '../utils/simulatedRides/types';
import type { TravelRouter } from '../utils/travelRouting/prefetch';
import type { GeocodeClient } from './geocodeClient';
import {
  MIN_ROUTED_POINTS,
  matrixCacheKey,
  prepareRouting,
  verificationCacheKey,
  type RoutingDeps,
  type RoutingProgress,
} from './simulationRouting';

/**
 * The seam between the simulator and the two services (external audit round 4),
 * run against fakes: invented addresses, a geocoder that finds each one where
 * the pool says it is, a router that is the line times 1.4 at 30 km/h.
 */
const BASE = { lat: 51.12, lon: 7.05 };
const POOL: PoolAddress[] = Array.from({ length: 80 }, (_, i) => ({
  label: `Teststraße ${i + 1}, 40210 Demostadt, Deutschland`,
  lat: 51.1 + Math.floor(i / 10) * 0.006,
  lon: 7.02 + (i % 10) * 0.007,
}));

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    keys: () => [...data.keys()],
    data,
  };
}

function setup(options: { locatable?: (a: PoolAddress) => boolean; routable?: (from: string, to: string) => boolean; geocodeDown?: boolean } = {}) {
  const counts = { geocode: 0, route: 0 };
  const byText = new Map(POOL.map(a => [a.label, a]));
  const geocoder: GeocodeClient = {
    geocode: async batch => {
      counts.geocode += 1;
      if (options.geocodeDown) return { ok: false, reason: 'function_unreachable' };
      return {
        ok: true,
        dataUpdated: '2026-10-01',
        results: batch.map(q => {
          const a = byText.get(q.text)!;
          return options.locatable && !options.locatable(a)
            ? { id: q.id, kind: 'unlocated' as const, reason: 'not_found' as const }
            : { id: q.id, kind: 'located' as const, lat: a.lat, lon: a.lon, precision: 'exact' as const, osm: null };
        }),
      };
    },
  };
  const router: TravelRouter = {
    route: async (pairs): Promise<RouteBatchAnswer> => {
      counts.route += 1;
      return {
        ok: true,
        dataVersion: null,
        results: pairs.map(p => {
          if (options.routable && !options.routable(pointKey(p.from), pointKey(p.to))) {
            return { id: p.id, kind: 'unavailable' as const, reason: 'no_route' as const };
          }
          const km = haversineKm(p.from, p.to) * 1.4;
          return { id: p.id, kind: 'route' as const, durationSeconds: (km / 30) * 3600 + 15, distanceMeters: km * 1000, snapMeters: [3, 3] as const };
        }),
      };
    },
  };
  const storage = memoryStorage();
  const deps = (): RoutingDeps => ({ geocoder, router, storage, sleep: async () => {}, now: () => new Date('2026-10-29T10:00:00Z'), pauseMs: 0 });
  return { counts, storage, deps };
}

describe('prepareRouting', () => {
  it('verifies, routes and reports its provenance, with progress for both phases', async () => {
    const s = setup();
    const seen: RoutingProgress[] = [];
    const out = await prepareRouting({ pool: POOL, base: BASE, deps: s.deps(), onProgress: p => seen.push(p) });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.points.length).toBeGreaterThanOrEqual(MIN_ROUTED_POINTS);
    expect(out.model.measured).toBe(true);
    expect(out.provenance).toMatchObject({ points: 65, addressesChecked: 80, addressesKept: 80, failedPairs: 0, geocoderSource: '2026-10-01' });
    expect(out.provenance.routedPairs).toBe(65 * 64);
    expect(out.cached).toEqual({ verification: false, matrix: false });
    expect(new Set(seen.map(p => p.phase))).toEqual(new Set(['verify', 'route']));
    expect(seen[seen.length - 1]).toMatchObject({ phase: 'route', done: 65 * 64, total: 65 * 64 });
    expect(s.counts.geocode).toBe(2);
  });

  it('a cache hit asks neither service again', async () => {
    const s = setup();
    await prepareRouting({ pool: POOL, base: BASE, deps: s.deps() });
    const asked = { ...s.counts };
    const again = await prepareRouting({ pool: POOL, base: BASE, deps: s.deps() });
    expect(again.ok && again.cached).toEqual({ verification: true, matrix: true });
    expect(s.counts).toEqual(asked);
  });

  it('a corrupt cache entry is ignored and the services are asked', async () => {
    const s = setup();
    await prepareRouting({ pool: POOL, base: BASE, deps: s.deps() });
    for (const key of s.storage.keys()) s.storage.setItem(key, '{ not json');
    const before = { ...s.counts };
    const again = await prepareRouting({ pool: POOL, base: BASE, deps: s.deps() });
    expect(again.ok && again.cached).toEqual({ verification: false, matrix: false });
    expect(s.counts.geocode).toBeGreaterThan(before.geocode);
    expect(s.counts.route).toBeGreaterThan(before.route);
  });

  it('a cache entry older than 90 days is not used', async () => {
    const s = setup();
    await prepareRouting({ pool: POOL, base: BASE, deps: s.deps() });
    const later = { ...s.deps(), now: () => new Date('2027-02-01T10:00:00Z') };
    const again = await prepareRouting({ pool: POOL, base: BASE, deps: later });
    expect(again.ok && again.cached).toEqual({ verification: false, matrix: false });
  });

  it('refuses when fewer than 8 addresses survive the check, and lists why the others went', async () => {
    const s = setup({ locatable: a => POOL.indexOf(a) < 5 });
    const out = await prepareRouting({ pool: POOL, base: BASE, deps: s.deps() });
    expect(out).toMatchObject({ ok: false, reason: 'too_few_addresses', detail: '5' });
    if (out.ok) return;
    expect(out.dropped).toHaveLength(75);
    expect(s.counts.route).toBe(0);
  });

  it('refuses when the geocoder is away, and does not shrink the pool by what the outage covered', async () => {
    const s = setup({ geocodeDown: true });
    const out = await prepareRouting({ pool: POOL, base: BASE, deps: s.deps() });
    expect(out).toMatchObject({ ok: false, reason: 'verification_failed', detail: 'function_unreachable', dropped: [] });
    expect(s.storage.keys()).toEqual([]);
  });

  it('refuses when no route is measured at all, and keeps nothing of that answer', async () => {
    const s = setup({ routable: () => false });
    const out = await prepareRouting({ pool: POOL, base: BASE, deps: s.deps() });
    expect(out).toMatchObject({ ok: false, reason: 'routing_failed', detail: 'no_route' });
    expect(s.storage.keys().filter(k => k.includes('matrix'))).toEqual([]);
  });

  it('refuses when the base has no route out, even if the rest is fine', async () => {
    const baseKey = pointKey(BASE);
    const s = setup({ routable: (from) => from !== baseKey });
    const out = await prepareRouting({ pool: POOL, base: BASE, deps: s.deps() });
    expect(out).toMatchObject({ ok: false, reason: 'base_unroutable' });
  });

  it('refuses when fewer than 8 points have a route in and out', async () => {
    const keep = new Set(POOL.slice(0, 4).map(pointKey));
    const baseKey = pointKey(BASE);
    // Only four pool points (plus the base) can reach each other.
    const s = setup({ routable: (a, b) => (keep.has(a) || a === baseKey) && (keep.has(b) || b === baseKey) });
    const out = await prepareRouting({ pool: POOL, base: BASE, deps: s.deps() });
    expect(out.ok).toBe(false);
  });
});

describe('the cache keys', () => {
  it('the matrix key follows the routed points, not their order', () => {
    const points = POOL.slice(0, 5);
    expect(matrixCacheKey(points)).toBe(matrixCacheKey([...points].reverse()));
  });

  it('moving one routed point changes the matrix key', () => {
    const points = POOL.slice(0, 5);
    const moved = points.map((p, i) => (i === 2 ? { ...p, lat: p.lat + 0.0001 } : p));
    expect(matrixCacheKey(moved)).not.toBe(matrixCacheKey(points));
  });

  it('adding or dropping a routed point changes the matrix key', () => {
    const points = POOL.slice(0, 5);
    expect(matrixCacheKey(points.slice(0, 4))).not.toBe(matrixCacheKey(points));
  });

  it('the verification key follows the text as well as the point', () => {
    const renamed = POOL.map((a, i) => (i === 0 ? { ...a, label: 'Teststraße 99, 40210 Demostadt, Deutschland' } : a));
    expect(verificationCacheKey(renamed)).not.toBe(verificationCacheKey(POOL));
  });
});
