/**
 * Pure logic of the geocode-address function: the one door between the
 * Fahrtenanalyse and the Nominatim ridy runs on this host, through the
 * geocoder gateway (deploy/geocoder-gateway.conf).
 *
 * No Deno, npm: or jsr: import, like travel-route-core.ts: vitest runs this file
 * in Node, the edge function (supabase/functions/geocode-address) runs the same
 * code, and so does the browser (src/lib/geocodeClient.ts reads the answer with
 * parseGeocodeResponse, and src/utils/travelRouting uses parseSheetAddress and
 * addressKey). The wire contract is written down once, here.
 *
 *   POST /functions/v1/geocode-address
 *   {"addresses":[{"id":"...","text":"Hauptstraße 12, 42651 Solingen, Deutschland"}, ...]}   1 to 50
 *     200 {ok:true, data_updated: string | null, results: GeocodeResult[]}
 *         one result per address, in request order, matched by id:
 *         {id, kind:"located", lat, lon, precision:"exact", osm: "node/123" | null}
 *         {id, kind:"unlocated", reason: one of UNLOCATED_REASONS}
 *     4xx/5xx {ok:false, reason: one of GEOCODE_REFUSAL_REASONS}
 *
 * ## An address is placed or it is not, and "not" always has a reason
 *
 * A point leaves this file only when the geocoder answered at HOUSE level
 * (place_rank 30), for the house number that was asked for, in the postal code
 * that was asked for, and when every house-level answer lies in one place. A street
 * (rank 26), a square, a hamlet, a postal area, a house with another number, two
 * houses a street apart: each is a reason and never a coordinate. This is the
 * guess the Fahrtenanalyse exists not to make: two addresses on one street, or in
 * one postal area, are zero minutes apart, and a travel check would pass on it.
 *
 * ## What it asks, and what it never asks
 *
 * Only addresses with a house number are sent. "Hauptbahnhof Wuppertal, 42103
 * Wuppertal" and "Königstraße, 42651 Solingen" have no point to find, and asking
 * would only put a passenger's address in somebody else's log for nothing; they are
 * answered `no_house_number` here, before any request. The request is the three
 * facts of the address (street with number, postal code, city); what else the
 * search is asked is fixed in the gateway, not here.
 *
 * ## A lookup that fails is not "no"
 *
 * A timeout is a timeout, a refusal is a refusal, a body that is not what
 * Nominatim documents is bad_answer. Nothing in this file answers a coordinate it
 * did not read from a house-level answer, and the caller never sees an exception.
 * Three failures in a row (the service is down or struggling) end the asking: the
 * rest of the call is answered with the last reason without a single request.
 */

import { mapWithConcurrency } from './travel-route-core.ts';

// -- Vocabulary ---------------------------------------------------------------

export interface GeocodeQuery {
  /** Chosen by the caller and echoed back; an answer belongs to its request by id and only by id. */
  readonly id: string;
  readonly text: string;
}

/** One call carries at most this many addresses; at the gateway's 5 a second that is ten seconds. */
export const MAX_ADDRESSES_PER_CALL = 50;
/** The longest address text taken: far above any Fahrtenbuch cell, far below a request that is not one. */
export const MAX_ADDRESS_CHARS = 200;
const MAX_ID_LENGTH = 80;
export const MAX_GEOCODE_BODY_CHARS = 32 * 1024;

/**
 * The gateway, by its name on this stack's network. A constant and not
 * configuration, for the reason OSRM_ORIGIN is one: the function must only ever
 * call this one container, and a value that can be typed wrong can be aimed at the
 * database or at ridy's own service. A test ties the host and the port to the
 * compose service.
 */
export const GEOCODER_ORIGIN = 'http://geocoder-gateway:8080';

export const UNLOCATED_REASONS = [
  // decided from the text, nothing was asked
  'unparseable', // no postal code part, or nothing before it
  'no_house_number', // a street or a place name: there is no single point to find
  // the geocoder answered and the answer is not a point
  'not_found', // no result at all
  'too_coarse', // results, none at house level for this number (street, square, postal area, another number)
  'postcode_mismatch', // a house with this number, in another postal code
  'ambiguous', // house-level answers more than SAME_PLACE_METERS apart
  // the geocoder did not answer
  'rate_limited', // the gateway's budget, or the service's own refusal
  'service_error', // an error from the service
  'bad_answer', // an answer that is not the shape Nominatim documents
  'unreachable', // the gateway or the service could not be reached
  'timeout', // no answer in time
  'rejected', // the gateway refused the request itself: ours to fix
] as const;
export type UnlocatedReason = (typeof UNLOCATED_REASONS)[number];

/** The reasons that say the geocoder itself could not answer, as opposed to saying no. */
export const INFRASTRUCTURE_REASONS: ReadonlySet<UnlocatedReason> = new Set<UnlocatedReason>([
  'rate_limited', 'service_error', 'bad_answer', 'unreachable', 'timeout', 'rejected',
]);

export const GEOCODE_REFUSAL_REASONS = [
  'not_authenticated',
  'no_company',
  'method_not_allowed',
  'invalid_request',
  'duplicate_id',
  'too_many_addresses',
  'too_large',
  'server_error',
] as const;
export type GeocodeRefusalReason = (typeof GEOCODE_REFUSAL_REASONS)[number];

export type GeocodeResult =
  | {
      readonly id: string;
      readonly kind: 'located';
      readonly lat: number;
      readonly lon: number;
      /** Only house level is ever returned; the field is there so a coarser level is a new value and not a new meaning. */
      readonly precision: 'exact';
      /** The OpenStreetMap object the point belongs to, "node/123", or null. */
      readonly osm: string | null;
    }
  | { readonly id: string; readonly kind: 'unlocated'; readonly reason: UnlocatedReason };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// -- The request --------------------------------------------------------------

export type GeocodeRequestProblem = Extract<
  GeocodeRefusalReason,
  'invalid_request' | 'duplicate_id' | 'too_many_addresses' | 'too_large'
>;

export type ParsedGeocodeRequest =
  | { readonly ok: true; readonly queries: readonly GeocodeQuery[] }
  | { readonly ok: false; readonly problem: GeocodeRequestProblem };

function readQuery(entry: unknown): GeocodeQuery | null {
  if (!isRecord(entry)) return null;
  const { id, text } = entry;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) return null;
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_ADDRESS_CHARS) return null;
  return { id, text };
}

/** The body as the function reads it: strict about types, silent about fields it does not use. */
export function parseGeocodeRequest(body: unknown): ParsedGeocodeRequest {
  if (!isRecord(body) || !Array.isArray(body.addresses) || body.addresses.length === 0) {
    return { ok: false, problem: 'invalid_request' };
  }
  if (body.addresses.length > MAX_ADDRESSES_PER_CALL) return { ok: false, problem: 'too_many_addresses' };
  const queries: GeocodeQuery[] = [];
  const seen = new Set<string>();
  for (const entry of body.addresses) {
    const query = readQuery(entry);
    if (query === null) return { ok: false, problem: 'invalid_request' };
    if (seen.has(query.id)) return { ok: false, problem: 'duplicate_id' };
    seen.add(query.id);
    queries.push(query);
  }
  return { ok: true, queries };
}

/** The same, from the text of the request: the size is judged before anything is parsed. */
export function parseGeocodeBody(text: string): ParsedGeocodeRequest {
  if (text.length > MAX_GEOCODE_BODY_CHARS) return { ok: false, problem: 'too_large' };
  try {
    return parseGeocodeRequest(JSON.parse(text));
  } catch {
    return { ok: false, problem: 'invalid_request' };
  }
}

const REFUSAL_STATUS: Readonly<Record<GeocodeRefusalReason, number>> = {
  not_authenticated: 401,
  no_company: 403,
  method_not_allowed: 405,
  invalid_request: 400,
  duplicate_id: 400,
  too_many_addresses: 413,
  too_large: 413,
  server_error: 500,
};

export const geocodeRefusalStatus = (reason: GeocodeRefusalReason): number => REFUSAL_STATUS[reason];

// -- The address as the Fahrtenbuch writes it ---------------------------------

export interface ParsedAddress {
  /** The street without its number. */
  readonly street: string;
  /** The first number asked for, as written, without spaces inside: "12", "127B", "12-14". */
  readonly houseNumber: string;
  /**
   * Every number the cell lists ("25;27", "30, 32"), normalized, the first one first;
   * `[houseNumber]` for a single number. A building with several numbers is tagged
   * with the list in OpenStreetMap, so any of them identifies it.
   */
  readonly houseNumbers: readonly string[];
  readonly postcode: string;
  readonly city: string;
}

export type AddressProblem = 'unparseable' | 'no_house_number';

const COUNTRY_PARTS: ReadonlySet<string> = new Set(['deutschland', 'germany']);
const POSTCODE_PART = /^(\d{5})\s+(\S.*)$/u;
/** One house number: "12", "12a", "12 a", "12-14", "12/1". */
const NUMBER = String.raw`\d+\s?[A-Za-z]?(?:\s?[-/]\s?\d+\s?[A-Za-z]?)?`;
const LIST_SEPARATOR = String.raw`\s*[;,]\s*`;
/** The street part ends in a number, or in a list of them: "12", "25;27", "3; 5". */
const TRAILING_NUMBER = new RegExp(String.raw`^(.+?)\s+(${NUMBER}(?:${LIST_SEPARATOR}${NUMBER})*)$`, 'u');
/** A part that is nothing but numbers: what the comma split off "Straße 30, 32". */
const NUMBERS_ONLY = new RegExp(`^${NUMBER}(?:${LIST_SEPARATOR}${NUMBER})*$`, 'u');

function addressParts(text: string): string[] {
  const parts = text
    .normalize('NFC')
    .split(',')
    .map((part) => part.replace(/\s+/gu, ' ').trim())
    .filter((part) => part !== '');
  if (parts.length > 0 && COUNTRY_PARTS.has(parts[parts.length - 1].toLowerCase())) parts.pop();
  return parts;
}

function lastPostcodePart(parts: readonly string[]): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (POSTCODE_PART.test(parts[index])) return index;
  }
  return -1;
}

/**
 * "Straße 12, 42651 Solingen, Deutschland" is the shape of the Uber sheet, and
 * "Name, Straße 12, 42651 Solingen, Deutschland" is the same address with a
 * name in front (the name is dropped: the street and number are what is found).
 * The street part is the one just before the postal code part.
 */
export function parseSheetAddress(text: string): ParsedAddress | AddressProblem {
  const parts = addressParts(text);
  const at = lastPostcodePart(parts);
  if (at < 1) return 'unparseable';
  const place = POSTCODE_PART.exec(parts[at]);
  if (place === null) return 'unparseable';
  const streetPart = joinNumberParts(parts, at);
  const numbered = streetPart === null ? null : TRAILING_NUMBER.exec(streetPart);
  if (numbered === null) return 'no_house_number';
  const listed = numbered[2].split(new RegExp(LIST_SEPARATOR, 'u')).map((number) => number.replace(/\s+/gu, ''));
  return {
    street: numbered[1],
    houseNumber: listed[0],
    houseNumbers: listed.map(normalizeHouseNumber),
    postcode: place[1],
    city: place[2],
  };
}

/**
 * The street part before the postal code, with the numbers the comma split off it
 * put back: "Straße 30", "32" is "Straße 30;32". Only a part that is nothing but
 * house numbers is merged; a part with a word in it ("Hinterhaus") is a name and
 * stays out. Null when nothing but numbers lies before the postal code.
 */
function joinNumberParts(parts: readonly string[], postcodeAt: number): string | null {
  let first = postcodeAt - 1;
  while (first > 0 && NUMBERS_ONLY.test(parts[first])) first -= 1;
  if (first === postcodeAt - 1) return parts[first];
  if (NUMBERS_ONLY.test(parts[first])) return null;
  return [parts[first], ...parts.slice(first + 1, postcodeAt)].join(';');
}

/**
 * What identifies an address in the company's cache: the text, lower-cased,
 * with the spaces and the country at the end tidied, so that the same place
 * written twice is one key. Not a hash: the Fahrtenbuch already stores the text
 * verbatim, and a hash of an address is as good as the address to anyone who can
 * list the addresses of a city.
 */
export function addressKey(text: string): string {
  const parts = addressParts(text).map((part) => part.toLocaleLowerCase('de-DE'));
  return parts.join(', ');
}

const encode = (value: string): string => encodeURIComponent(value);

/** The request to the gateway: three facts and nothing else, the rest of the search is fixed there. */
export function searchPath(address: ParsedAddress): string {
  return `/search?street=${encode(`${address.houseNumber} ${address.street}`)}`
    + `&postalcode=${encode(address.postcode)}&city=${encode(address.city)}`;
}

export const STATUS_PATH = '/status';

// -- What Nominatim answered ---------------------------------------------------

/** Nominatim's place_rank for a house, an address node or an interpolated number. A street is 26. */
export const HOUSE_RANK = 30;
/**
 * House-level answers closer together than this are one place: the same address
 * is often several objects (a building and its entrance, a node for each door), and
 * the probe of 22.10.2026 found them 9 to 43 m apart. Answers further apart are
 * different places with the same number, and none of them is chosen.
 */
export const SAME_PLACE_METERS = 100;

// Germany with a margin. A point outside it for a search restricted to Germany is
// not an answer to this question.
const LAT_RANGE: readonly [number, number] = [47, 56];
const LON_RANGE: readonly [number, number] = [5, 16];

interface Candidate {
  readonly lat: number;
  readonly lon: number;
  readonly rank: number;
  readonly houseNumbers: readonly string[];
  readonly postcodes: readonly string[];
  readonly osm: string | null;
}

export type Interpretation =
  | { readonly kind: 'located'; readonly lat: number; readonly lon: number; readonly osm: string | null }
  | { readonly kind: 'unlocated'; readonly reason: UnlocatedReason };

const unlocated = (reason: UnlocatedReason): Interpretation => ({ kind: 'unlocated', reason });

function toNumber(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

const within = (value: number, [low, high]: readonly [number, number]): boolean => value >= low && value <= high;

/** "12a", "12 A", "12;14" and "12, 14" as the tokens a number can be compared by. */
function numberTokens(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(/[;,]/u)
    .map((token) => normalizeHouseNumber(token))
    .filter((token) => token !== '');
}

export function normalizeHouseNumber(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(/[‐-―]/gu, '-').replace(/\s+/gu, '');
}

function osmReference(entry: Record<string, unknown>): string | null {
  const { osm_type: type, osm_id: id } = entry;
  const usable = typeof type === 'string' && /^[a-z]+$/u.test(type) && (typeof id === 'number' || typeof id === 'string');
  return usable ? `${type}/${id}` : null;
}

function readCandidate(entry: unknown): Candidate | null {
  if (!isRecord(entry)) return null;
  const lat = toNumber(entry.lat);
  const lon = toNumber(entry.lon);
  const rank = toNumber(entry.place_rank);
  if (lat === null || lon === null || rank === null || !within(lat, LAT_RANGE) || !within(lon, LON_RANGE)) return null;
  const address = isRecord(entry.address) ? entry.address : {};
  return {
    lat,
    lon,
    rank,
    houseNumbers: numberTokens(address.house_number),
    postcodes: numberTokens(address.postcode),
    osm: osmReference(entry),
  };
}

/** Metres between two points, on a sphere: far more exact than the 100 m it is compared with. */
export function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** What the gateway's or the service's HTTP status says before any body is read; null for a 200. */
function reasonForStatus(status: number): UnlocatedReason | null {
  if (status === 200) return null;
  if (status === 429) return 'rate_limited';
  if (status === 502) return 'unreachable';
  if (status === 504) return 'timeout';
  if (status === 400 || status === 404 || status === 405) return 'rejected';
  return status >= 500 ? 'service_error' : 'bad_answer';
}

function decide(candidates: readonly Candidate[], expected: ParsedAddress): Interpretation {
  // Any listed number identifies the building: OSM tags "25;27" on one object.
  const wanted = expected.houseNumbers.map(normalizeHouseNumber);
  const houses = candidates.filter((c) => c.rank >= HOUSE_RANK && c.houseNumbers.some((n) => wanted.includes(n)));
  if (houses.length === 0) return unlocated('too_coarse');
  // A house that says which postal code it is in must say the one that was asked for.
  const inside = houses.filter((c) => c.postcodes.length === 0 || c.postcodes.includes(expected.postcode));
  if (inside.length === 0) return unlocated('postcode_mismatch');
  const first = inside[0];
  if (inside.some((c) => distanceMeters(first, c) > SAME_PLACE_METERS)) return unlocated('ambiguous');
  return { kind: 'located', lat: first.lat, lon: first.lon, osm: first.osm };
}

/**
 * What one search answer means for the address it was asked about. The HTTP
 * status is read first (the gateway answers 429 over its budget, 502 and 504 when
 * their service is down or slow, 400 and 404 to a request it will not pass on),
 * then the body, which must be a list of results in the shape Nominatim documents:
 * a list with one malformed entry is bad_answer, never half-used.
 */
export function interpretNominatimAnswer(status: number, body: unknown, expected: ParsedAddress): Interpretation {
  const refused = reasonForStatus(status);
  if (refused !== null) return unlocated(refused);
  if (!Array.isArray(body)) return unlocated('bad_answer');
  if (body.length === 0) return unlocated('not_found');
  const candidates = body.map(readCandidate);
  if (candidates.some((candidate) => candidate === null)) return unlocated('bad_answer');
  return decide(candidates as Candidate[], expected);
}

export type ServiceStatus =
  | { readonly up: true; readonly dataUpdated: string | null }
  | { readonly up: false; readonly reason: UnlocatedReason };

/**
 * Whether their service is answering, and how old its data is. `data_updated`
 * is the timestamp of the newest OpenStreetMap change it has applied. On
 * 22.10.2026 it said 2026-08-21 although the instance has a replication URL: it
 * does not keep itself current, and the age is worth knowing next to any answer.
 */
export function readServiceStatus(status: number, body: unknown): ServiceStatus {
  const refused = reasonForStatus(status);
  if (refused !== null) return { up: false, reason: refused };
  if (!isRecord(body) || body.status !== 0) return { up: false, reason: 'service_error' };
  const updated = body.data_updated;
  return { up: true, dataUpdated: typeof updated === 'string' && updated !== '' ? updated : null };
}

/** `nominatim@2026-08-21` from data_updated; plain `nominatim` when it does not say. */
export function geocoderVersionLabel(dataUpdated: string | null | undefined): string {
  const match = /^(\d{4}-\d{2}-\d{2})/u.exec(dataUpdated ?? '');
  return match ? `nominatim@${match[1]}` : 'nominatim';
}

// -- Asking -------------------------------------------------------------------

export interface GeocodeOptions {
  readonly fetchFn: typeof fetch;
  readonly baseUrl: string;
  /** For one request, answer included. */
  readonly timeoutMs: number;
  /** How many requests are in flight at once. The gateway allows two for the whole stack. */
  readonly concurrency: number;
  /** After this the remaining addresses are not asked for at all. */
  readonly deadlineMs: number;
  readonly now: () => number;
  /** This many failures of the service itself in a row end the asking. */
  readonly maxConsecutiveFailures: number;
}

export interface GeocodeOutcome {
  readonly results: readonly GeocodeResult[];
  /** Their service's own stamp of the data, from /status; null when it did not say or did not answer. */
  readonly dataUpdated: string | null;
}

type Asked =
  | { readonly kind: 'answered'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'failed'; readonly reason: 'timeout' | 'unreachable' };

const isAbort = (error: unknown): boolean => isRecord(error) && error.name === 'AbortError';

async function ask(path: string, options: GeocodeOptions): Promise<Asked> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchFn(`${options.baseUrl}${path}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const text = await response.text(); // an abort lands here as AbortError and is the timeout
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { kind: 'answered', status: response.status, body };
  } catch (error) {
    return { kind: 'failed', reason: isAbort(error) ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

const interpretAsked = (asked: Asked, expected: ParsedAddress): Interpretation =>
  asked.kind === 'failed' ? unlocated(asked.reason) : interpretNominatimAnswer(asked.status, asked.body, expected);

function toResult(id: string, found: Interpretation): GeocodeResult {
  if (found.kind === 'unlocated') return { id, kind: 'unlocated', reason: found.reason };
  return { id, kind: 'located', lat: found.lat, lon: found.lon, precision: 'exact', osm: found.osm };
}

interface Plan {
  readonly query: GeocodeQuery;
  readonly address: ParsedAddress | null;
  readonly problem: AddressProblem | null;
}

function planFor(query: GeocodeQuery): Plan {
  const parsed = parseSheetAddress(query.text);
  return typeof parsed === 'string'
    ? { query, address: null, problem: parsed }
    : { query, address: parsed, problem: null };
}

async function readStatus(options: GeocodeOptions): Promise<ServiceStatus> {
  const asked = await ask(STATUS_PATH, options);
  return asked.kind === 'failed' ? { up: false, reason: asked.reason } : readServiceStatus(asked.status, asked.body);
}

/**
 * Places the addresses, a few at a time. Never throws; an address that could not
 * be placed says why and the others go on, until the service itself fails
 * `maxConsecutiveFailures` times in a row, when the rest is answered with that
 * reason and not asked. Whether it is up at all is asked first, once: a service
 * that is down is found out with one request and not with fifty.
 */
export async function geocodeAddresses(queries: readonly GeocodeQuery[], options: GeocodeOptions): Promise<GeocodeOutcome> {
  const plans = queries.map(planFor);
  const startedAt = options.now();
  let dataUpdated: string | null = null;
  let stoppedBy: UnlocatedReason | null = null;
  if (plans.some((plan) => plan.address !== null)) {
    const service = await readStatus(options);
    if (service.up) dataUpdated = service.dataUpdated;
    else stoppedBy = service.reason;
  }
  let failuresInARow = 0;
  const results = await mapWithConcurrency(plans, options.concurrency, async (plan): Promise<GeocodeResult> => {
    const { id } = plan.query;
    if (plan.address === null) return toResult(id, unlocated(plan.problem ?? 'unparseable'));
    if (stoppedBy !== null) return toResult(id, unlocated(stoppedBy));
    if (options.now() - startedAt > options.deadlineMs) return toResult(id, unlocated('timeout'));
    const found = interpretAsked(await ask(searchPath(plan.address), options), plan.address);
    const failed = found.kind === 'unlocated' && INFRASTRUCTURE_REASONS.has(found.reason);
    failuresInARow = failed ? failuresInARow + 1 : 0;
    if (found.kind === 'unlocated' && failuresInARow >= options.maxConsecutiveFailures) stoppedBy = found.reason;
    return toResult(id, found);
  });
  return { results, dataUpdated };
}

// -- The answer, as the browser reads it --------------------------------------

export type GeocodeFailure = GeocodeRefusalReason | 'function_unreachable' | 'bad_answer';

export type GeocodeBatchAnswer =
  | { readonly ok: true; readonly dataUpdated: string | null; readonly results: readonly GeocodeResult[] }
  | { readonly ok: false; readonly reason: GeocodeFailure };

function readResult(value: unknown): GeocodeResult | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  if (value.kind === 'unlocated') {
    const known = (UNLOCATED_REASONS as readonly unknown[]).includes(value.reason);
    return known ? { id: value.id, kind: 'unlocated', reason: value.reason as UnlocatedReason } : null;
  }
  const { lat, lon, osm } = value;
  const point = typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)
    && within(lat, LAT_RANGE) && within(lon, LON_RANGE);
  const reference = osm === null || typeof osm === 'string';
  if (value.kind !== 'located' || value.precision !== 'exact' || !point || !reference) return null;
  return { id: value.id, kind: 'located', lat, lon, precision: 'exact', osm: osm as string | null };
}

function readSuccess(body: Record<string, unknown>): GeocodeBatchAnswer {
  const updated = body.data_updated;
  const updatedOk = updated === undefined || updated === null || typeof updated === 'string';
  if (!updatedOk || !Array.isArray(body.results)) return { ok: false, reason: 'bad_answer' };
  const results = body.results.map(readResult);
  if (results.some((result) => result === null)) return { ok: false, reason: 'bad_answer' };
  return { ok: true, dataUpdated: typeof updated === 'string' ? updated : null, results: results as GeocodeResult[] };
}

function failureForStatus(status: number): GeocodeFailure {
  if (status === 401) return 'not_authenticated';
  if (status === 403) return 'no_company';
  if (status === 405) return 'method_not_allowed';
  if (status === 413) return 'too_large';
  if (status === 400) return 'invalid_request';
  return status >= 500 ? 'server_error' : 'bad_answer';
}

/** Reads the function's answer. A body that is not exactly the contract is bad_answer, never half-used. */
export function parseGeocodeResponse(status: number, body: unknown): GeocodeBatchAnswer {
  if (isRecord(body) && body.ok === true) return readSuccess(body);
  const reason = isRecord(body) ? body.reason : undefined;
  if ((GEOCODE_REFUSAL_REASONS as readonly unknown[]).includes(reason)) {
    return { ok: false, reason: reason as GeocodeRefusalReason };
  }
  return { ok: false, reason: failureForStatus(status) };
}
