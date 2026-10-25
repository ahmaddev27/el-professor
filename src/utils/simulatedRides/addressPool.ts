import type { GeoPoint, PoolAddress } from './types';

/**
 * Real addresses for the simulated rides, from OpenStreetMap through Nominatim.
 *
 * Nominatim's usage policy is about one request a second and an application that
 * identifies itself. A month of rides needs thousands of addresses, so this never
 * geocodes per ride: it asks for one pool per city (a handful of requests,
 * `POOL_QUERIES.length + 1`), keeps it for `POOL_MAX_AGE_DAYS`, and the generator
 * composes every ride from the pool. A browser cannot set `User-Agent`; it sends
 * the app's origin as the Referer, which is what the policy accepts for a web app.
 */
export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
export const REQUEST_SPACING_MS = 1100;
export const POOL_MAX_AGE_DAYS = 90;
export const MIN_POOL_SIZE = 60;

/** Things that stand on a street with a house number almost everywhere in Germany. */
export const POOL_QUERIES: readonly string[] = [
  'Supermarkt', 'Restaurant', 'Apotheke', 'Hotel', 'Bahnhof', 'Krankenhaus', 'Schule',
  'Arzt', 'Bank', 'Tankstelle', 'Café', 'Bäckerei', 'Friseur', 'Kino',
];

export interface AddressPool {
  city: string;
  center: GeoPoint;
  addresses: PoolAddress[];
  fetchedAt: string;
  /** How many Nominatim requests building it took. */
  requests: number;
}

interface NominatimAddress {
  road?: string;
  house_number?: string;
  postcode?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
}

interface NominatimPlace {
  lat: string;
  lon: string;
  boundingbox?: [string, string, string, string];
  address?: NominatimAddress;
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class PoolError extends Error {
  readonly reason: 'city_not_found' | 'too_few_addresses' | 'request_failed';
  constructor(reason: PoolError['reason'], message: string) {
    super(message);
    this.name = 'PoolError';
    this.reason = reason;
  }
}

/** "Straße 5, 42651 Solingen, Deutschland" — the shape of the export's Abholort. */
export function addressLabel(a: NominatimAddress): string | null {
  const place = a.city ?? a.town ?? a.village ?? a.municipality;
  if (!a.road || !a.house_number || !a.postcode || !place) return null;
  return `${a.road} ${a.house_number}, ${a.postcode} ${place}, Deutschland`;
}

export function placeToAddress(p: NominatimPlace): PoolAddress | null {
  const label = p.address ? addressLabel(p.address) : null;
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  return label && Number.isFinite(lat) && Number.isFinite(lon) ? { label, lat, lon } : null;
}

function searchUrl(params: Record<string, string>): string {
  const query = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', countrycodes: 'de', 'accept-language': 'de', ...params });
  return `${NOMINATIM_URL}?${query.toString()}`;
}

async function getJson(fetchFn: FetchLike, url: string): Promise<NominatimPlace[]> {
  let response;
  try {
    response = await fetchFn(url);
  } catch (err) {
    throw new PoolError('request_failed', err instanceof Error ? err.message : String(err));
  }
  if (!response.ok) throw new PoolError('request_failed', `Nominatim answered ${response.status}`);
  return (await response.json()) as NominatimPlace[];
}

export interface BuildPoolOptions {
  fetchFn: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
  now?: () => Date;
}

const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** One request for the city, then one per query inside the city's box, a second apart. */
export async function buildAddressPool(city: string, options: BuildPoolOptions): Promise<AddressPool> {
  const sleep = options.sleep ?? realSleep;
  const total = POOL_QUERIES.length + 1;
  const found = await getJson(options.fetchFn, searchUrl({ q: city, limit: '1' }));
  options.onProgress?.(1, total);
  const home = found[0];
  if (!home?.boundingbox) throw new PoolError('city_not_found', city);
  const [south, north, west, east] = home.boundingbox;
  const center = { lat: Number(home.lat), lon: Number(home.lon) };

  const seen = new Map<string, PoolAddress>();
  for (const [i, word] of POOL_QUERIES.entries()) {
    await sleep(REQUEST_SPACING_MS);
    const places = await getJson(options.fetchFn, searchUrl({
      q: word, limit: '40', bounded: '1', viewbox: `${west},${north},${east},${south}`,
    }));
    for (const place of places) {
      const address = placeToAddress(place);
      if (address && !seen.has(address.label)) seen.set(address.label, address);
    }
    options.onProgress?.(i + 2, total);
  }
  const addresses = [...seen.values()];
  if (addresses.length < MIN_POOL_SIZE) {
    throw new PoolError('too_few_addresses', `${addresses.length} addresses found for ${city}, ${MIN_POOL_SIZE} needed`);
  }
  return { city, center, addresses, fetchedAt: (options.now?.() ?? new Date()).toISOString(), requests: total };
}

// ── The cache: one pool per city in this browser, for 90 days ───────────────

const CACHE_PREFIX = 'simulatedRides.pool.v1:';

export const poolCacheKey = (city: string): string => `${CACHE_PREFIX}${city.trim().toLowerCase()}`;

export function isFresh(pool: AddressPool, now: Date = new Date()): boolean {
  const age = now.getTime() - new Date(pool.fetchedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < POOL_MAX_AGE_DAYS * 86_400_000;
}

export function readCachedPool(city: string, storage: Pick<Storage, 'getItem'> | null, now: Date = new Date()): AddressPool | null {
  try {
    const raw = storage?.getItem(poolCacheKey(city));
    if (!raw) return null;
    const pool = JSON.parse(raw) as AddressPool;
    return Array.isArray(pool.addresses) && pool.addresses.length >= MIN_POOL_SIZE && isFresh(pool, now) ? pool : null;
  } catch {
    return null;
  }
}

export function writeCachedPool(pool: AddressPool, storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(poolCacheKey(pool.city), JSON.stringify(pool));
  } catch {
    // Storage may be full or refused; the pool is just fetched again next time.
  }
}
