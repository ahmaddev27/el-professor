import { describe, expect, it } from 'vitest';
import type { GeocodeBatchAnswer, GeocodeQuery, GeocodeResult } from '../../../supabase/functions/_shared/geocode-core';
import type { GeocodeClient } from '../../lib/geocodeClient';
import { MOVED_REASON, countDropped, verifyPool } from './poolVerification';
import type { PoolAddress } from './types';

/**
 * The pool check (external audit round 4). Invented addresses only.
 *
 * A fake geocoder answers from a table keyed by the address text, so each test
 * says exactly which address the "service" finds where.
 */
const pool = (n: number): PoolAddress[] => Array.from({ length: n }, (_, i) => ({
  label: `Teststraße ${i + 1}, 40210 Demostadt, Deutschland`,
  lat: 51.1 + i * 0.0005,
  lon: 7.0 + i * 0.0005,
}));

type Rule = (address: PoolAddress, index: number) => GeocodeResult | 'default';

function fakeClient(addresses: PoolAddress[], rule: Rule = () => 'default') {
  const calls: GeocodeQuery[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const client: GeocodeClient = {
    geocode: async (batch): Promise<GeocodeBatchAnswer> => {
      calls.push([...batch]);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      const results = batch.map((q): GeocodeResult => {
        const index = addresses.findIndex(a => a.label === q.text);
        const asked = addresses[index];
        const custom = rule(asked, index);
        if (custom !== 'default') return { ...custom, id: q.id };
        return { id: q.id, kind: 'located', lat: asked.lat, lon: asked.lon, precision: 'exact', osm: null };
      });
      return { ok: true, dataUpdated: '2026-10-01', results };
    },
  };
  return { client, calls, maxInFlight: () => maxInFlight };
}

const noSleep = async () => {};

describe('verifyPool', () => {
  it('keeps an address located at the pool\'s own point', async () => {
    const addresses = pool(3);
    const { client } = fakeClient(addresses);
    const out = await verifyPool(addresses, client, { sleep: noSleep });
    expect(out.ok && out.kept).toEqual(addresses);
    expect(out.ok && out.dropped).toEqual([]);
    expect(out.ok && out.dataUpdated).toBe('2026-10-01');
  });

  it('drops an unlocated address with the geocoder\'s own reason', async () => {
    const addresses = pool(3);
    const { client } = fakeClient(addresses, (_, i) => (i === 1 ? { id: '', kind: 'unlocated', reason: 'not_found' } : 'default'));
    const out = await verifyPool(addresses, client, { sleep: noSleep });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.kept).toHaveLength(2);
    expect(out.dropped).toEqual([{ label: addresses[1].label, reason: 'not_found' }]);
    expect(countDropped(out.dropped)).toEqual({ not_found: 1 });
  });

  it('drops an address the geocoder finds more than 100 m from the pool\'s point, and says how far', async () => {
    const addresses = pool(2);
    // 0.0015 degrees of latitude is about 167 m.
    const { client } = fakeClient(addresses, (a, i) => (i === 0
      ? { id: '', kind: 'located', lat: a.lat + 0.0015, lon: a.lon, precision: 'exact', osm: null }
      : 'default'));
    const out = await verifyPool(addresses, client, { sleep: noSleep });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.kept).toEqual([addresses[1]]);
    expect(out.dropped[0]).toMatchObject({ label: addresses[0].label, reason: MOVED_REASON });
    expect(out.dropped[0].distanceMeters).toBeGreaterThan(100);
  });

  it('keeps an address located 60 m away: within the bound is the same place', async () => {
    const addresses = pool(1);
    const { client } = fakeClient(addresses, a => ({ id: '', kind: 'located', lat: a.lat + 0.00054, lon: a.lon, precision: 'exact', osm: null }));
    const out = await verifyPool(addresses, client, { sleep: noSleep });
    expect(out.ok && out.kept).toHaveLength(1);
  });

  it('asks at most 50 addresses per call, one call at a time, pausing between calls', async () => {
    const addresses = pool(120);
    const fake = fakeClient(addresses);
    const pauses: number[] = [];
    const out = await verifyPool(addresses, fake.client, { pauseMs: 300, sleep: async ms => { pauses.push(ms); } });
    expect(fake.calls.map(c => c.length)).toEqual([50, 50, 20]);
    expect(fake.maxInFlight()).toBe(1);
    expect(pauses).toEqual([300, 300]);
    expect(out.ok && out.checked).toBe(120);
  });

  it('reports progress per call', async () => {
    const addresses = pool(60);
    const seen: Array<[number, number]> = [];
    await verifyPool(addresses, fakeClient(addresses).client, { sleep: noSleep, onProgress: (d, t) => seen.push([d, t]) });
    expect(seen).toEqual([[50, 60], [60, 60]]);
  });

  it('an infrastructure answer ends the asking and is a failure, not a dropped address', async () => {
    const addresses = pool(120);
    const fake = fakeClient(addresses, (_, i) => (i === 60 ? { id: '', kind: 'unlocated', reason: 'timeout' } : 'default'));
    const out = await verifyPool(addresses, fake.client, { sleep: noSleep });
    expect(out).toEqual({ ok: false, reason: 'timeout', checked: 50 });
    expect(fake.calls).toHaveLength(2);
  });

  it('a refused call ends the asking with its reason', async () => {
    const client: GeocodeClient = { geocode: async () => ({ ok: false, reason: 'function_unreachable' }) };
    const out = await verifyPool(pool(5), client, { sleep: noSleep });
    expect(out).toEqual({ ok: false, reason: 'function_unreachable', checked: 0 });
  });

  it('an address with no answer at all is a failure: silence is not a verdict', async () => {
    const addresses = pool(3);
    const client: GeocodeClient = {
      geocode: async batch => ({ ok: true, dataUpdated: null, results: batch.slice(1).map(q => ({ id: q.id, kind: 'located' as const, lat: 51.1, lon: 7.0, precision: 'exact' as const, osm: null })) }),
    };
    const out = await verifyPool(addresses, client, { sleep: noSleep });
    expect(out).toEqual({ ok: false, reason: 'not_answered', checked: 0 });
  });
});
