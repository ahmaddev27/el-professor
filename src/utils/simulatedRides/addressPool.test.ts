import { describe, expect, it } from 'vitest';
import {
  POOL_MAX_AGE_DAYS, POOL_QUERIES, PoolError, addressLabel, buildAddressPool, isFresh, readCachedPool, writeCachedPool,
  type AddressPool, type FetchLike,
} from './addressPool';

const place = (i: number) => ({
  lat: String(51.1 + i * 0.001), lon: String(7.0 + i * 0.001),
  address: { road: `Straße ${i}`, house_number: String(i), postcode: '42651', city: 'Solingen' },
});

function server(perQuery: number): { fetchFn: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchFn: FetchLike = async url => {
    urls.push(url);
    const isCity = !url.includes('bounded=1');
    const body = isCity
      ? [{ lat: '51.17', lon: '7.08', boundingbox: ['51.1', '51.25', '6.95', '7.2'] }]
      : Array.from({ length: perQuery }, (_, i) => place(urls.length * 100 + i));
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchFn, urls };
}

describe('buildAddressPool', () => {
  it('costs one request for the city and one per query, a second apart, and builds real labels', async () => {
    const { fetchFn, urls } = server(10);
    const sleeps: number[] = [];
    const pool = await buildAddressPool('Solingen', { fetchFn, sleep: async ms => { sleeps.push(ms); } });
    expect(urls.length).toBe(POOL_QUERIES.length + 1);
    expect(pool.requests).toBe(POOL_QUERIES.length + 1);
    expect(sleeps).toHaveLength(POOL_QUERIES.length);
    expect(sleeps.every(ms => ms >= 1000)).toBe(true);
    expect(pool.addresses[0].label).toMatch(/^Straße \d+ \d+, 42651 Solingen, Deutschland$|^Straße \d+ \d+, 42651 Solingen, Deutschland/);
    expect(urls[1]).toContain('viewbox=6.95%2C51.25%2C7.2%2C51.1');
  });

  it('refuses a city Nominatim does not know and a pool that is too small to vary', async () => {
    await expect(buildAddressPool('Nirgendwo', { fetchFn: async () => ({ ok: true, status: 200, json: async () => [] }), sleep: async () => {} }))
      .rejects.toMatchObject({ reason: 'city_not_found' });
    await expect(buildAddressPool('Solingen', { ...server(1), sleep: async () => {} }))
      .rejects.toMatchObject({ reason: 'too_few_addresses' });
  });

  it('turns a blocked request (429) into a named failure instead of a half pool', async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 429, json: async () => [] });
    await expect(buildAddressPool('Solingen', { fetchFn, sleep: async () => {} })).rejects.toBeInstanceOf(PoolError);
  });

  it('drops places with no house number or postcode', () => {
    expect(addressLabel({ road: 'A', postcode: '1', city: 'B' })).toBeNull();
    expect(addressLabel({ road: 'A', house_number: '2', city: 'B' })).toBeNull();
    expect(addressLabel({ road: 'A', house_number: '2', postcode: '1', town: 'B' })).toBe('A 2, 1 B, Deutschland');
  });
});

describe('the cache', () => {
  const pool: AddressPool = {
    city: 'Solingen', center: { lat: 1, lon: 1 }, requests: 15, fetchedAt: '2026-10-01T00:00:00.000Z',
    addresses: Array.from({ length: 80 }, (_, i) => ({ label: `L${i}`, lat: 1, lon: 1 })),
  };
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };

  it('returns a fresh pool and forgets one older than 90 days', () => {
    const store = memory();
    writeCachedPool(pool, store);
    expect(readCachedPool('solingen ', store, new Date('2026-10-20'))?.addresses).toHaveLength(80);
    expect(isFresh(pool, new Date(new Date(pool.fetchedAt).getTime() + (POOL_MAX_AGE_DAYS + 1) * 86_400_000))).toBe(false);
    expect(readCachedPool('Solingen', store, new Date('2027-03-01'))).toBeNull();
  });

  it('survives storage that is missing or throws', () => {
    expect(readCachedPool('Solingen', null)).toBeNull();
    expect(() => writeCachedPool(pool, { setItem: () => { throw new Error('full'); } })).not.toThrow();
    expect(readCachedPool('Solingen', { getItem: () => '{not json' })).toBeNull();
  });
});
