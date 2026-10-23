import { describe, expect, it } from 'vitest';
import {
  MAX_ADDRESSES_PER_CALL,
  type GeocodeBatchAnswer,
  type GeocodeQuery,
  type GeocodeResult,
} from '../../../supabase/functions/_shared/geocode-core';
import {
  createGeocodingLocator,
  type CacheRow,
  type CachedPlace,
  type GeocodeBatchClient,
  type GeocodeCache,
} from './geocodingLocator';

const A = 'Hauptstraße 12, 42651 Solingen, Deutschland';
const B = 'Kölner Straße 5, 40211 Düsseldorf, Deutschland';
const STREET_ONLY = 'Königstraße, 42651 Solingen, Deutschland';
const UPDATED = '2026-08-21T17:21:05+00:00';

const placed = (id: string, lat = 51.17, lon = 7.08): GeocodeResult => ({ id, kind: 'located', lat, lon, precision: 'exact', osm: `node/${id}` });
const refused = (id: string, reason: Extract<GeocodeResult, { kind: 'unlocated' }>['reason']): GeocodeResult => ({ id, kind: 'unlocated', reason });

/** A client that records every batch and answers with `answer`, defaulting to every address placed. */
function clientOf(answer: (queries: readonly GeocodeQuery[], call: number) => GeocodeBatchAnswer | Promise<GeocodeBatchAnswer> = (queries) => ({
  ok: true, dataUpdated: UPDATED, results: queries.map((q) => placed(q.id)),
})) {
  const calls: GeocodeQuery[][] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const client: GeocodeBatchClient = {
    geocode: async (queries) => {
      calls.push([...queries]);
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      try {
        await Promise.resolve();
        return await answer(queries, calls.length - 1);
      } finally {
        inFlight -= 1;
      }
    },
  };
  return { client, calls, mostInFlight: () => mostInFlight };
}

function cacheOf(known: Record<string, CachedPlace> = {}, over: Partial<GeocodeCache> = {}) {
  const reads: string[][] = [];
  const writes: CacheRow[][] = [];
  const cache: GeocodeCache = {
    read: async (keys) => {
      reads.push([...keys]);
      return new Map(Object.entries(known).filter(([key]) => keys.includes(key)));
    },
    write: async (rows) => {
      writes.push([...rows]);
    },
    ...over,
  };
  return { cache, reads, writes };
}

describe('createGeocodingLocator', () => {
  it('asks the cache first and does not ask the function about an address the company already has', async () => {
    const { client, calls } = clientOf();
    const { cache, writes } = cacheOf({ 'hauptstraße 12, 42651 solingen': { lat: 51.1, lon: 7.0 } });
    const found = await createGeocodingLocator({ client, cache }).locate([A]);
    expect(found.get(A)).toEqual({ kind: 'located', point: { lat: 51.1, lon: 7.0 }, precision: 'exact' });
    expect(calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('sends what the cache does not know, answers every address it was given, and keeps the placed ones with the data version', async () => {
    const { client, calls } = clientOf((queries) => ({
      ok: true, dataUpdated: UPDATED, results: [placed(queries[0].id, 51.2, 6.8), refused(queries[1].id, 'too_coarse')],
    }));
    const { cache, writes } = cacheOf({ 'hauptstraße 12, 42651 solingen': { lat: 51.1, lon: 7.0 } });
    const C = 'Marktplatz 3, 42103 Wuppertal, Deutschland';
    const found = await createGeocodingLocator({ client, cache }).locate([A, B, C]);
    expect(calls).toEqual([[{ id: 'a0', text: B }, { id: 'a1', text: C }]]);
    expect(found.get(A)).toMatchObject({ kind: 'located', point: { lat: 51.1, lon: 7.0 } });
    expect(found.get(B)).toEqual({ kind: 'located', point: { lat: 51.2, lon: 6.8 }, precision: 'exact' });
    expect(found.get(C)).toEqual({ kind: 'unlocated', reason: 'too_coarse' });
    expect(writes).toEqual([[{ addressKey: 'kölner straße 5, 40211 düsseldorf', lat: 51.2, lon: 6.8, osm: 'node/a0', geocoderVersion: 'nominatim@2026-08-21' }]]);
  });

  it('never keeps an address that was not placed: only a point is worth keeping', async () => {
    const { client } = clientOf((queries) => ({ ok: true, dataUpdated: UPDATED, results: queries.map((q) => refused(q.id, 'not_found')) }));
    const { cache, writes } = cacheOf();
    await createGeocodingLocator({ client, cache }).locate([A, B]);
    expect(writes).toHaveLength(0);
  });

  it('answers a street and a name from the text alone and sends neither: there is no point to find', async () => {
    const { client, calls } = clientOf();
    const { cache } = cacheOf();
    const found = await createGeocodingLocator({ client, cache }).locate([STREET_ONLY, 'irgendwo', 'x'.repeat(300), A]);
    expect(found.get(STREET_ONLY)).toEqual({ kind: 'unlocated', reason: 'no_house_number' });
    expect(found.get('irgendwo')).toEqual({ kind: 'unlocated', reason: 'unparseable' });
    expect(found.get('x'.repeat(300))).toEqual({ kind: 'unlocated', reason: 'unparseable' });
    expect(calls.flat().map((q) => q.text)).toEqual([A]);
  });

  it('asks once for two spellings of one address and answers both', async () => {
    const { client, calls } = clientOf();
    const { cache } = cacheOf();
    const spaced = '  hauptstraße   12 , 42651 SOLINGEN ';
    const found = await createGeocodingLocator({ client, cache }).locate([A, spaced]);
    expect(calls.flat()).toHaveLength(1);
    expect(found.get(A)).toEqual(found.get(spaced));
    expect(found.get(A)?.kind).toBe('located');
  });

  it(`sends at most ${MAX_ADDRESSES_PER_CALL} addresses at a time, one call after the other`, async () => {
    const { client, calls, mostInFlight } = clientOf();
    const { cache, writes } = cacheOf();
    const many = Array.from({ length: 120 }, (_, i) => `Aweg ${i + 1}, 42651 Solingen, Deutschland`);
    const found = await createGeocodingLocator({ client, cache }).locate(many);
    expect(calls.map((c) => c.length)).toEqual([50, 50, 20]);
    expect(mostInFlight()).toBe(1);
    expect(found.size).toBe(120);
    expect(writes.flat()).toHaveLength(120);
  });

  it('reads the whole month from the cache in one request when it holds the whole month', async () => {
    const { client, calls } = clientOf();
    const known = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`aweg ${i + 1}, 42651 solingen`, { lat: 51, lon: 7 }]));
    const { cache, reads } = cacheOf(known);
    const month = Array.from({ length: 30 }, (_, i) => `Aweg ${i + 1}, 42651 Solingen, Deutschland`);
    const found = await createGeocodingLocator({ client, cache }).locate(month);
    expect(reads).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect([...found.values()].every((v) => v.kind === 'located')).toBe(true);
  });
});

describe('createGeocodingLocator when something fails', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `Aweg ${i + 1}, 42651 Solingen, Deutschland`);

  it('answers the reason for the batch and for every batch after it, and asks no more, when the function cannot be reached', async () => {
    const { client, calls } = clientOf(() => ({ ok: false, reason: 'function_unreachable' }));
    const { cache, writes } = cacheOf();
    const found = await createGeocodingLocator({ client, cache }).locate(many(120));
    expect(calls).toHaveLength(1);
    expect([...found.values()].every((v) => v.kind === 'unlocated' && v.reason === 'function_unreachable')).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it.each(['not_authenticated', 'no_company', 'server_error', 'bad_answer'] as const)('carries the function\'s refusal %s as the reason', async (reason) => {
    const { client } = clientOf(() => ({ ok: false, reason }));
    const found = await createGeocodingLocator({ client, cache: cacheOf().cache }).locate([A]);
    expect(found.get(A)).toEqual({ kind: 'unlocated', reason });
  });

  it('turns a client that throws into function_unreachable', async () => {
    const client: GeocodeBatchClient = { geocode: async () => { throw new Error('boom'); } };
    const found = await createGeocodingLocator({ client, cache: cacheOf().cache }).locate([A]);
    expect(found.get(A)).toEqual({ kind: 'unlocated', reason: 'function_unreachable' });
  });

  it('stops after a batch in which the service itself failed for most addresses, keeps the points of that batch, and asks no further', async () => {
    const { client, calls } = clientOf((queries, call) => ({
      ok: true,
      dataUpdated: UPDATED,
      results: queries.map((q, i) => (call === 0 && i < 2 ? placed(q.id) : refused(q.id, 'unreachable'))),
    }));
    const { cache, writes } = cacheOf();
    const found = await createGeocodingLocator({ client, cache }).locate(many(120));
    expect(calls).toHaveLength(1);
    expect(writes.flat()).toHaveLength(2);
    const reasons = [...found.values()].map((v) => (v.kind === 'located' ? 'located' : v.reason));
    expect(reasons.filter((r) => r === 'located')).toHaveLength(2);
    expect(reasons.filter((r) => r === 'unreachable')).toHaveLength(118);
  });

  it('goes on after a batch in which a few addresses were not found: not finding is not the service failing', async () => {
    const { client, calls } = clientOf((queries) => ({
      ok: true, dataUpdated: UPDATED, results: queries.map((q, i) => (i % 2 === 0 ? refused(q.id, 'not_found') : placed(q.id))),
    }));
    await createGeocodingLocator({ client, cache: cacheOf().cache }).locate(many(120));
    expect(calls).toHaveLength(3);
  });

  it('goes on after one or two service failures in a batch of fifty', async () => {
    const { client, calls } = clientOf((queries) => ({
      ok: true, dataUpdated: UPDATED, results: queries.map((q, i) => (i < 2 ? refused(q.id, 'timeout') : placed(q.id))),
    }));
    await createGeocodingLocator({ client, cache: cacheOf().cache }).locate(many(120));
    expect(calls).toHaveLength(3);
  });

  it('answers bad_answer for an address the function sent no result for', async () => {
    const { client } = clientOf((queries) => ({ ok: true, dataUpdated: UPDATED, results: [placed(queries[0].id)] }));
    const found = await createGeocodingLocator({ client, cache: cacheOf().cache }).locate([A, B]);
    expect(found.get(A)?.kind).toBe('located');
    expect(found.get(B)).toEqual({ kind: 'unlocated', reason: 'bad_answer' });
  });

  it('carries on without a cache that cannot be read, and without one that cannot be written', async () => {
    const { client, calls } = clientOf();
    const unreadable = cacheOf({}, { read: async () => { throw new Error('rls'); }, write: async () => { throw new Error('refused'); } });
    const found = await createGeocodingLocator({ client, cache: unreadable.cache }).locate([A]);
    expect(found.get(A)?.kind).toBe('located');
    expect(calls).toHaveLength(1);
    const nothing = cacheOf({}, { read: async () => null });
    const again = await createGeocodingLocator({ client, cache: nothing.cache }).locate([A]);
    expect(again.get(A)?.kind).toBe('located');
  });

  it('is never asked for nothing: an empty month asks nobody', async () => {
    const { client, calls } = clientOf();
    const { cache, reads } = cacheOf();
    expect((await createGeocodingLocator({ client, cache }).locate([])).size).toBe(0);
    expect(calls).toHaveLength(0);
    expect(reads.flat()).toHaveLength(0);
  });
});
