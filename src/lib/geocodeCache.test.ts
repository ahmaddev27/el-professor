import { describe, expect, it } from 'vitest';
import { READ_CHUNK, WRITE_CHUNK, cacheable, createGeocodeCache, type GeocodeCacheDb } from './geocodeCache';

interface Seen {
  reads: Array<{ columns: string; company: string; keys: string[] }>;
  writes: Array<{ rows: Array<Record<string, unknown>>; onConflict: string }>;
}

/** Stores rows by key and answers a read from them, recording every request the cache makes. */
function fakeDb(stored: Record<string, { lat: number; lon: number }> = {}, failing: { read?: number; write?: number } = {}) {
  const seen: Seen = { reads: [], writes: [] };
  let readCalls = 0;
  let writeCalls = 0;
  const db: GeocodeCacheDb = {
    from: () => ({
      select: (columns) => ({
        eq: (_column, company) => ({
          in: async (_col, keys) => {
            readCalls += 1;
            seen.reads.push({ columns, company, keys });
            if (failing.read === readCalls) return { data: null, error: { message: 'permission denied' } };
            const data = keys.filter((k) => k in stored).map((k) => ({ address_key: k, ...stored[k] }));
            return { data, error: null };
          },
        }),
      }),
      upsert: async (rows, options) => {
        writeCalls += 1;
        seen.writes.push({ rows: rows as Array<Record<string, unknown>>, onConflict: options.onConflict });
        return { error: failing.write === writeCalls ? { code: '42501' } : null };
      },
    }),
  };
  return { db, seen };
}

const row = (key: string) => ({ addressKey: key, lat: 51.17, lon: 7.08, osm: 'node/1', geocoderVersion: 'nominatim@2026-08-21' });
const NOW = () => new Date('2026-10-23T08:00:00.000Z');

describe('createGeocodeCache.read', () => {
  it('reads the company\'s rows for the keys, and nobody else\'s', async () => {
    const { db, seen } = fakeDb({ 'a, 42651 solingen': { lat: 51.1, lon: 7.0 } });
    const cache = createGeocodeCache({ db, companyId: 'co-1', canWrite: true });
    const found = await cache.read(['a, 42651 solingen', 'b, 42651 solingen']);
    expect([...(found ?? new Map()).entries()]).toEqual([['a, 42651 solingen', { lat: 51.1, lon: 7.0 }]]);
    expect(seen.reads).toEqual([{ columns: 'address_key, lat, lon', company: 'co-1', keys: ['a, 42651 solingen', 'b, 42651 solingen'] }]);
  });

  it(`reads at most ${READ_CHUNK} keys per request, since they travel in the URL`, async () => {
    const { db, seen } = fakeDb();
    const keys = Array.from({ length: 100 }, (_, i) => `k${i}`);
    await createGeocodeCache({ db, companyId: 'co-1', canWrite: false }).read(keys);
    expect(seen.reads.map((r) => r.keys.length)).toEqual([40, 40, 20]);
  });

  it('does not ask for a key the filter cannot carry', async () => {
    const { db, seen } = fakeDb();
    await createGeocodeCache({ db, companyId: 'co-1', canWrite: false }).read(['ok, 42651 solingen', 'say "x", 42651 solingen', 'back' + String.fromCharCode(92) + 'slash', 'x'.repeat(301)]);
    expect(seen.reads.flatMap((r) => r.keys)).toEqual(['ok, 42651 solingen']);
  });

  it('answers null for a cache it cannot read, and what it has when a later request fails', async () => {
    const keys = Array.from({ length: 80 }, (_, i) => `k${i}`);
    const stored = Object.fromEntries(keys.map((k) => [k, { lat: 51, lon: 7 }]));
    const first = fakeDb(stored, { read: 1 });
    expect(await createGeocodeCache({ db: first.db, companyId: 'co-1', canWrite: false }).read(keys)).toBeNull();
    const second = fakeDb(stored, { read: 2 });
    const partial = await createGeocodeCache({ db: second.db, companyId: 'co-1', canWrite: false }).read(keys);
    expect(partial?.size).toBe(40);
  });

  it('ignores a row that is not a key and a point', async () => {
    const db: GeocodeCacheDb = {
      from: () => ({
        select: () => ({ eq: () => ({ in: async () => ({ data: [{ address_key: 'a', lat: 51, lon: 7 }, { address_key: 'b', lat: 'x', lon: 7 }, null, { lat: 1, lon: 2 }], error: null }) }) }),
        upsert: async () => ({ error: null }),
      }),
    };
    const found = await createGeocodeCache({ db, companyId: 'co-1', canWrite: false }).read(['a', 'b']);
    expect([...(found ?? new Map()).keys()]).toEqual(['a']);
  });
});

describe('createGeocodeCache.write', () => {
  it('upserts the company\'s rows by company and address, stamped, and nothing else about the ride', async () => {
    const { db, seen } = fakeDb();
    await createGeocodeCache({ db, companyId: 'co-1', canWrite: true, now: NOW }).write([row('a, 42651 solingen')]);
    expect(seen.writes).toEqual([{
      onConflict: 'company_id,address_key',
      rows: [{
        company_id: 'co-1', address_key: 'a, 42651 solingen', lat: 51.17, lon: 7.08, osm_ref: 'node/1',
        geocoder_version: 'nominatim@2026-08-21', geocoded_at: '2026-10-23T08:00:00.000Z',
      }],
    }]);
  });

  it('does not even try when the caller may not write: an editor, a viewer, a platform account in a company', async () => {
    const { db, seen } = fakeDb();
    await createGeocodeCache({ db, companyId: 'co-1', canWrite: false }).write([row('a, 42651 solingen')]);
    expect(seen.writes).toHaveLength(0);
  });

  it(`writes at most ${WRITE_CHUNK} rows per request`, async () => {
    const { db, seen } = fakeDb();
    const rows = Array.from({ length: 450 }, (_, i) => row(`k${i}`));
    await createGeocodeCache({ db, companyId: 'co-1', canWrite: true }).write(rows);
    expect(seen.writes.map((w) => w.rows.length)).toEqual([200, 200, 50]);
  });

  it('stops at the first refusal and does not throw', async () => {
    const { db, seen } = fakeDb({}, { write: 1 });
    await expect(createGeocodeCache({ db, companyId: 'co-1', canWrite: true }).write(Array.from({ length: 450 }, (_, i) => row(`k${i}`)))).resolves.toBeUndefined();
    expect(seen.writes).toHaveLength(1);
  });

  it('keeps out of the table the keys it could not read back', async () => {
    const { db, seen } = fakeDb();
    await createGeocodeCache({ db, companyId: 'co-1', canWrite: true }).write([row('ok, 42651 solingen'), row('say "x", 42651 solingen')]);
    expect(seen.writes.flatMap((w) => w.rows.map((r) => r.address_key))).toEqual(['ok, 42651 solingen']);
  });
});

describe('cacheable', () => {
  it('holds a normal key and refuses an empty one, a long one, one with a quote and one with a backslash', () => {
    expect(cacheable('hauptstraße 12, 42651 solingen')).toBe(true);
    expect(cacheable('')).toBe(false);
    expect(cacheable('x'.repeat(300))).toBe(true);
    expect(cacheable('x'.repeat(301))).toBe(false);
    expect(cacheable('a"b')).toBe(false);
    expect(cacheable('a' + String.fromCharCode(92) + 'b')).toBe(false);
  });
});
