/**
 * The address locator the Fahrtenanalyse uses: it turns the addresses of a month
 * into points, asking as few times as it can and keeping what it learns.
 *
 *   cache (the company's own)  ->  geocode-address (our function)  ->  gateway  ->  ridy's Nominatim
 *
 * An address is looked up in the company's cache first. The ones the cache does
 * not know are checked here, from the text alone, for the two cases where there is
 * nothing to find (no house number, or not an address the function can read), and
 * only the rest are sent, in calls of at most MAX_ADDRESSES_PER_CALL, one call at a
 * time. What came back placed is written to the cache; what came back not placed is
 * not: the reason is cheap to learn again, and a data update can turn it into a
 * point.
 *
 * Why it asks so carefully. The service at the end is another product's and has no
 * limits of its own (the gateway holds ours), and every address asked of it is a
 * passenger's, in its log. The design sends each address once, ever, per company:
 * a month's 3,000 addresses are a one-off, and the steady state is a handful of new
 * ones.
 *
 * A failure is a reason and never a point. When the function cannot be reached, or
 * refuses, or most of a call came back as the service failing, the rest of the
 * addresses are answered with that reason and not asked: a service in trouble is
 * not helped by 40 more calls. Nothing here, and nothing it calls, falls back to a
 * guess.
 */
import {
  INFRASTRUCTURE_REASONS,
  MAX_ADDRESSES_PER_CALL,
  MAX_ADDRESS_CHARS,
  addressKey,
  geocoderVersionLabel,
  parseSheetAddress,
  type GeocodeBatchAnswer,
  type GeocodeQuery,
  type GeocodeResult,
  type UnlocatedReason,
} from '../../../supabase/functions/_shared/geocode-core';
import type { AddressLocator, LocatedAddress } from './prefetch';

export interface GeocodeBatchClient {
  /** Never throws; a failure is an `ok: false` answer. */
  geocode(batch: readonly GeocodeQuery[]): Promise<GeocodeBatchAnswer>;
}

export interface CachedPlace {
  readonly lat: number;
  readonly lon: number;
}

export interface CacheRow {
  readonly addressKey: string;
  readonly lat: number;
  readonly lon: number;
  readonly osm: string | null;
  readonly geocoderVersion: string;
}

export interface GeocodeCache {
  /** What the company already has for these keys; null when the cache could not be read (treated as empty). */
  read(keys: readonly string[]): Promise<ReadonlyMap<string, CachedPlace> | null>;
  /** Keeps placed addresses. Never throws: a refused or failed write is not a failure of the analysis. */
  write(rows: readonly CacheRow[]): Promise<void>;
}

export interface GeocodingLocatorDeps {
  readonly client: GeocodeBatchClient;
  readonly cache: GeocodeCache;
  readonly batchSize?: number;
}

interface Item {
  readonly key: string;
  readonly text: string;
}

const located = (lat: number, lon: number): LocatedAddress => ({ kind: 'located', point: { lat, lon }, precision: 'exact' });
const unlocated = (reason: string): LocatedAddress => ({ kind: 'unlocated', reason });

/** What the text alone says, before anything is asked: a reason, or null when it is worth sending. */
function problemOf(text: string): string | null {
  if (text.length > MAX_ADDRESS_CHARS) return 'unparseable';
  const parsed = parseSheetAddress(text);
  return typeof parsed === 'string' ? parsed : null;
}

/** One text per key: two spellings of one address are asked once. */
function textsByKey(addresses: readonly string[]): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const text of addresses) {
    const key = addressKey(text);
    if (key !== '' && !byKey.has(key)) byKey.set(key, text);
  }
  return byKey;
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

async function readCache(cache: GeocodeCache, keys: readonly string[]): Promise<ReadonlyMap<string, CachedPlace>> {
  try {
    return (await cache.read(keys)) ?? new Map();
  } catch {
    return new Map();
  }
}

async function writeCache(cache: GeocodeCache, rows: readonly CacheRow[]): Promise<void> {
  try {
    await cache.write(rows);
  } catch {
    // The port promises not to throw; if it does, the analysis still has its points.
  }
}

async function askClient(client: GeocodeBatchClient, queries: readonly GeocodeQuery[]): Promise<GeocodeBatchAnswer> {
  try {
    return await client.geocode(queries);
  } catch {
    return { ok: false, reason: 'function_unreachable' };
  }
}

interface BatchOutcome {
  readonly rows: readonly CacheRow[];
  /** How many of the batch the service itself failed to answer, and with what. */
  readonly infrastructureFailures: number;
  readonly lastFailure: string | null;
}

/** Files one answered batch under its keys. A result the function did not send for an id is bad_answer. */
function applyBatch(batch: readonly Item[], answer: Extract<GeocodeBatchAnswer, { ok: true }>, answers: Map<string, LocatedAddress>): BatchOutcome {
  const byId = new Map<string, GeocodeResult>(answer.results.map((result) => [result.id, result]));
  const version = geocoderVersionLabel(answer.dataUpdated);
  const rows: CacheRow[] = [];
  let infrastructureFailures = 0;
  let lastFailure: string | null = null;
  batch.forEach((item, index) => {
    const result = byId.get(`a${index}`);
    if (result?.kind === 'located') {
      answers.set(item.key, located(result.lat, result.lon));
      rows.push({ addressKey: item.key, lat: result.lat, lon: result.lon, osm: result.osm, geocoderVersion: version });
      return;
    }
    const reason: UnlocatedReason = result?.kind === 'unlocated' ? result.reason : 'bad_answer';
    answers.set(item.key, unlocated(reason));
    if (INFRASTRUCTURE_REASONS.has(reason)) {
      infrastructureFailures += 1;
      lastFailure = reason;
    }
  });
  return { rows, infrastructureFailures, lastFailure };
}

/** The service itself failed for at least three addresses and for half of the batch: it is in trouble, so ask no more. */
const serviceIsInTrouble = (batchSize: number, failures: number): boolean => failures >= 3 && failures * 2 >= batchSize;

/** Asks batch after batch, one at a time. Returns the rows to keep. */
async function askInBatches(todo: readonly Item[], deps: GeocodingLocatorDeps, answers: Map<string, LocatedAddress>): Promise<CacheRow[]> {
  const rows: CacheRow[] = [];
  let stoppedBy: string | null = null;
  for (const batch of chunked(todo, deps.batchSize ?? MAX_ADDRESSES_PER_CALL)) {
    if (stoppedBy !== null) {
      for (const item of batch) answers.set(item.key, unlocated(stoppedBy));
      continue;
    }
    const queries = batch.map((item, index) => ({ id: `a${index}`, text: item.text }));
    const answer = await askClient(deps.client, queries);
    if (!answer.ok) {
      stoppedBy = answer.reason;
      for (const item of batch) answers.set(item.key, unlocated(answer.reason));
      continue;
    }
    const outcome = applyBatch(batch, answer, answers);
    rows.push(...outcome.rows);
    if (serviceIsInTrouble(batch.length, outcome.infrastructureFailures)) stoppedBy = outcome.lastFailure;
  }
  return rows;
}

async function locateAll(addresses: readonly string[], deps: GeocodingLocatorDeps): Promise<ReadonlyMap<string, LocatedAddress>> {
  const texts = textsByKey(addresses);
  const cached = await readCache(deps.cache, [...texts.keys()]);
  const answers = new Map<string, LocatedAddress>();
  const todo: Item[] = [];
  for (const [key, text] of texts) {
    const place = cached.get(key);
    const problem = place ? null : problemOf(text);
    if (place) answers.set(key, located(place.lat, place.lon));
    else if (problem !== null) answers.set(key, unlocated(problem));
    else todo.push({ key, text });
  }
  const rows = await askInBatches(todo, deps, answers);
  if (rows.length > 0) await writeCache(deps.cache, rows);
  return new Map(addresses.map((address) => [address, answers.get(addressKey(address)) ?? unlocated('unparseable')]));
}

export function createGeocodingLocator(deps: GeocodingLocatorDeps): AddressLocator {
  return { locate: (addresses) => locateAll(addresses, deps) };
}
