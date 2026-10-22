/**
 * The company's own memory of the addresses it has placed: `public.geocode_cache`,
 * one row per company and address, written by the browser of an administrator and
 * readable by every member of the company (migration 20261023100000).
 *
 * The cache is why the Nominatim of another product is asked once for an address
 * and never again: a month of 3,000 distinct addresses is a one-off, and the
 * steady state is the handful that are new. It holds only points that were placed
 * at house level, with the OpenStreetMap object and the data version they came
 * from; an address that was not placed leaves no row.
 *
 * Reads and writes both go through the company's own session, so row level
 * security is the boundary: another company's rows are not visible, a role that
 * may not write is refused (and that is not an error of the analysis), and
 * `refuse_read_only_context_write` stops a view context. `canWrite` is the
 * browser's copy of those rules, and it is false for a platform account inside a
 * company's context on purpose: a support session's writes are recorded row by row
 * in the platform audit log, values included, and a passenger's coordinates have
 * no business there. The same account still reads the cache.
 */
import type { CacheRow, CachedPlace, GeocodeCache } from '../utils/travelRouting/geocodingLocator';

/** The part of the Supabase client the cache uses, so it can be tested without one. */
export interface GeocodeCacheDb {
  from(table: 'geocode_cache'): {
    select(columns: string): {
      eq(column: string, value: string): {
        in(column: string, values: string[]): PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
    upsert(rows: object[], options: { onConflict: string }): PromiseLike<{ error: unknown }>;
  };
}

export interface GeocodeCacheOptions {
  readonly db: GeocodeCacheDb;
  readonly companyId: string;
  /** Whether to try writing at all: an administrator of the company, and not a platform account inside it. */
  readonly canWrite: boolean;
  readonly now?: () => Date;
}

/** Keys per read: the filter travels in the URL, and a key is an address of up to 200 characters. */
export const READ_CHUNK = 40;
export const WRITE_CHUNK = 200;
/** The column's own limit (a check in the migration). */
export const MAX_KEY_CHARS = 300;

const BACKSLASH = String.fromCharCode(92);

/** A key with a quote or a backslash cannot be put in a filter, so it is neither read nor written. */
export const cacheable = (key: string): boolean =>
  key.length > 0 && key.length <= MAX_KEY_CHARS && !key.includes('"') && !key.includes(BACKSLASH);

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

function placeOf(row: unknown): [string, CachedPlace] | null {
  if (typeof row !== 'object' || row === null) return null;
  const { address_key: key, lat, lon } = row as Record<string, unknown>;
  const usable = typeof key === 'string' && typeof lat === 'number' && typeof lon === 'number'
    && Number.isFinite(lat) && Number.isFinite(lon);
  return usable ? [key, { lat, lon }] : null;
}

export function createGeocodeCache(options: GeocodeCacheOptions): GeocodeCache {
  const { db, companyId, canWrite } = options;
  const now = options.now ?? (() => new Date());

  async function read(keys: readonly string[]): Promise<ReadonlyMap<string, CachedPlace> | null> {
    const found = new Map<string, CachedPlace>();
    for (const chunk of chunked(keys.filter(cacheable), READ_CHUNK)) {
      const { data, error } = await db.from('geocode_cache').select('address_key, lat, lon').eq('company_id', companyId).in('address_key', chunk);
      if (error) return found.size > 0 ? found : null;
      for (const row of Array.isArray(data) ? data : []) {
        const place = placeOf(row);
        if (place) found.set(place[0], place[1]);
      }
    }
    return found;
  }

  async function write(rows: readonly CacheRow[]): Promise<void> {
    if (!canWrite) return;
    const stamp = now().toISOString();
    const payload = rows.filter((row) => cacheable(row.addressKey)).map((row) => ({
      company_id: companyId,
      address_key: row.addressKey,
      lat: row.lat,
      lon: row.lon,
      osm_ref: row.osm,
      geocoder_version: row.geocoderVersion,
      geocoded_at: stamp,
    }));
    for (const chunk of chunked(payload, WRITE_CHUNK)) {
      const { error } = await db.from('geocode_cache').upsert(chunk, { onConflict: 'company_id,address_key' });
      if (error) return; // refused or failed: the analysis has its points either way
    }
  }

  return { read, write };
}
