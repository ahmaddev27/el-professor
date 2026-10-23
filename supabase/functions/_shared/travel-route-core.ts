/**
 * Pure logic of the travel-route function: the one door between the
 * Fahrtenanalyse and the routing container (OSRM, deploy/docker-compose.yml).
 *
 * No Deno, npm: or jsr: import, like oauth-account-core.ts: vitest runs this
 * file in Node, the edge function (supabase/functions/travel-route) runs the
 * same code, and so does the browser (src/lib/travelRouteClient.ts reads the
 * answer with parseRouteResponse). The wire contract is written down once, here.
 *
 *   POST /functions/v1/travel-route
 *   {"pairs":[{"id":"...","from":{"lat":...,"lon":...},"to":{"lat":...,"lon":...}}, ...]}   1 to 100 pairs
 *     200 {ok:true, data_version: string | null, results: RouteResult[]}
 *         one result per pair, in request order, matched by id:
 *         {id, kind:"route", durationSeconds, distanceMeters, snapMeters:[from, to]}
 *         {id, kind:"unavailable", reason: one of ROUTE_FAILURE_REASONS}
 *     4xx/5xx {ok:false, reason: one of ROUTE_REFUSAL_REASONS}
 *
 * ## What it takes and what it never takes
 *
 * COORDINATES, never addresses. OSRM routes between points on a map and has no
 * idea what "Konrad-Adenauer-Strasse 12" is; turning an address into a point is
 * somebody else's job (src/utils/travelRouting names the port, and nothing
 * implements it yet). So a passenger's address never reaches this function or
 * the container, and the function logs counts, never a coordinate.
 *
 * ## It reports facts and leaves the judgement to the browser
 *
 * A result says how long and how far the road is and how far each point had to
 * be moved onto it. Whether a point is "too far from a road" to be believed,
 * and how much confidence a free-flow driving time deserves, are decisions of
 * src/utils/travelRouting/estimate.ts, which is tested against the numbers the
 * Fahrtenanalyse already uses. The departure time is not a parameter on
 * purpose: OSRM has no traffic, so a time of day would only pretend to matter.
 *
 * ## A lookup that fails is not "no"
 *
 * Every failure becomes a reason on the pair it happened to. Nothing in this
 * file answers a duration it did not read from an Ok answer, a timeout is a
 * timeout and not a zero, and a body it cannot read is bad_answer. The caller
 * never sees an exception from here.
 */

// -- Vocabulary ---------------------------------------------------------------

export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
}

export interface RoutePair {
  /** Chosen by the caller and echoed back; an answer belongs to its request by id and only by id. */
  readonly id: string;
  readonly from: GeoPoint;
  readonly to: GeoPoint;
}

/** One call carries at most this many pairs, so a worker finishes well inside its minute. */
export const MAX_PAIRS_PER_CALL = 100;
/** Trip ids are uuids and an id here is two of them joined: 73 characters. */
const MAX_ID_LENGTH = 80;
/** A hundred pairs are about 15 KB. Anything near this is not a request from the Fahrtenanalyse. */
export const MAX_BODY_CHARS = 64 * 1024;

/**
 * The routing container, by its name on the compose network. A constant and not
 * configuration: the function must only ever call our own container, and a
 * value that can be typed wrong is a value that can be aimed at the database or
 * the gateway (partner-endpoint.ts has the longer argument). A test ties the
 * host and the port to the compose service.
 */
export const OSRM_ORIGIN = 'http://osrm:5000';

export const ROUTE_FAILURE_REASONS = [
  'no_route', // the two points are not connected for a car
  'not_on_road', // a point could not be put onto a road at all
  'request_rejected', // OSRM refused the request itself: a limit, an option; ours to fix
  'service_error', // OSRM or the proxy in front of it answered with an error
  'bad_answer', // an answer that is not the shape OSRM documents
  'unreachable', // the connection failed
  'timeout', // no answer in time
] as const;
export type RouteFailureReason = (typeof ROUTE_FAILURE_REASONS)[number];

export const ROUTE_REFUSAL_REASONS = [
  'not_authenticated',
  'no_company',
  'method_not_allowed',
  'invalid_request',
  'bad_coordinate',
  'duplicate_id',
  'too_many_pairs',
  'too_large',
  'server_error',
] as const;
export type RouteRefusalReason = (typeof ROUTE_REFUSAL_REASONS)[number];

export type RouteResult =
  | {
      readonly id: string;
      readonly kind: 'route';
      readonly durationSeconds: number;
      readonly distanceMeters: number;
      /** How far each requested point was from the road it was put on, in metres. */
      readonly snapMeters: readonly [number, number];
    }
  | { readonly id: string; readonly kind: 'unavailable'; readonly reason: RouteFailureReason };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

// -- The request --------------------------------------------------------------

export type RequestProblem = Extract<
  RouteRefusalReason,
  'invalid_request' | 'bad_coordinate' | 'duplicate_id' | 'too_many_pairs' | 'too_large'
>;

export type ParsedRouteRequest =
  | { readonly ok: true; readonly pairs: readonly RoutePair[] }
  | { readonly ok: false; readonly problem: RequestProblem };

function readPoint(value: unknown): GeoPoint | RequestProblem {
  if (!isRecord(value) || !('lat' in value) || !('lon' in value)) return 'invalid_request';
  const { lat, lon } = value;
  const usable = typeof lat === 'number' && typeof lon === 'number'
    && Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return usable ? { lat: lat as number, lon: lon as number } : 'bad_coordinate';
}

function readPair(entry: unknown): RoutePair | RequestProblem {
  if (!isRecord(entry)) return 'invalid_request';
  const { id } = entry;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) return 'invalid_request';
  const from = readPoint(entry.from);
  if (typeof from === 'string') return from;
  const to = readPoint(entry.to);
  return typeof to === 'string' ? to : { id, from, to };
}

/** The body as the function reads it: strict about types, silent about fields it does not use. */
export function parseRouteRequest(body: unknown): ParsedRouteRequest {
  if (!isRecord(body) || !Array.isArray(body.pairs) || body.pairs.length === 0) {
    return { ok: false, problem: 'invalid_request' };
  }
  if (body.pairs.length > MAX_PAIRS_PER_CALL) return { ok: false, problem: 'too_many_pairs' };
  const pairs: RoutePair[] = [];
  const seen = new Set<string>();
  for (const entry of body.pairs) {
    const read = readPair(entry);
    if (typeof read === 'string') return { ok: false, problem: read };
    if (seen.has(read.id)) return { ok: false, problem: 'duplicate_id' };
    seen.add(read.id);
    pairs.push(read);
  }
  return { ok: true, pairs };
}

/** The same, from the text of the request: the size is judged before anything is parsed. */
export function parseRouteBody(text: string): ParsedRouteRequest {
  if (text.length > MAX_BODY_CHARS) return { ok: false, problem: 'too_large' };
  try {
    return parseRouteRequest(JSON.parse(text));
  } catch {
    return { ok: false, problem: 'invalid_request' };
  }
}

const REFUSAL_STATUS: Readonly<Record<RouteRefusalReason, number>> = {
  not_authenticated: 401,
  no_company: 403,
  method_not_allowed: 405,
  invalid_request: 400,
  bad_coordinate: 400,
  duplicate_id: 400,
  too_many_pairs: 413,
  too_large: 413,
  server_error: 500,
};

export const refusalStatus = (reason: RouteRefusalReason): number => REFUSAL_STATUS[reason];

// -- OSRM ---------------------------------------------------------------------

// Six decimals are about 10 cm. toFixed never writes an exponent, which a URL path could not carry.
const coordinate = (value: number): string => value.toFixed(6);
const lonLat = (point: GeoPoint): string => `${coordinate(point.lon)},${coordinate(point.lat)}`;

/** OSRM reads longitude first. The route only: no geometry, no steps, no alternatives. */
export function routeUrl(baseUrl: string, pair: RoutePair): string {
  const query = 'overview=false&alternatives=false&steps=false';
  return `${baseUrl}/route/v1/driving/${lonLat(pair.from)};${lonLat(pair.to)}?${query}`;
}

export type OsrmInterpretation =
  | {
      readonly kind: 'route';
      readonly durationSeconds: number;
      readonly distanceMeters: number;
      readonly snapMeters: readonly [number, number];
      readonly dataVersion: string | null;
    }
  | { readonly kind: 'unavailable'; readonly reason: RouteFailureReason };

const unavailable = (reason: RouteFailureReason): OsrmInterpretation => ({ kind: 'unavailable', reason });

/** Codes that say OSRM did not like the request, as opposed to the data not having an answer. */
const REJECTED_CODES: ReadonlySet<string> = new Set([
  'InvalidQuery', 'InvalidValue', 'InvalidOptions', 'InvalidUrl', 'InvalidService', 'InvalidVersion', 'TooBig', 'NotImplemented',
]);

function failureForCode(code: string): RouteFailureReason {
  if (code === 'NoRoute') return 'no_route';
  if (code === 'NoSegment') return 'not_on_road';
  return REJECTED_CODES.has(code) ? 'request_rejected' : 'service_error';
}

function readRoute(body: Record<string, unknown>): OsrmInterpretation {
  const route: unknown = Array.isArray(body.routes) ? body.routes[0] : undefined;
  const waypoints: unknown = body.waypoints;
  if (!isRecord(route) || !isNonNegative(route.duration) || !isNonNegative(route.distance)) return unavailable('bad_answer');
  if (!Array.isArray(waypoints) || waypoints.length !== 2) return unavailable('bad_answer');
  const [from, to] = waypoints.map((waypoint) => (isRecord(waypoint) ? waypoint.distance : undefined));
  if (!isNonNegative(from) || !isNonNegative(to)) return unavailable('bad_answer');
  const version = body.data_version;
  return {
    kind: 'route',
    durationSeconds: route.duration,
    distanceMeters: route.distance,
    snapMeters: [from, to],
    dataVersion: typeof version === 'string' && version !== '' ? version : null,
  };
}

/**
 * What one OSRM answer means. The OSRM `code` decides, not the HTTP status:
 * NoRoute and NoSegment arrive as 400, and a proxy can put any status in front
 * of any body. Only a 200 is believed to carry a route.
 */
export function interpretOsrmAnswer(status: number, body: unknown): OsrmInterpretation {
  if (!isRecord(body) || typeof body.code !== 'string') return unavailable(status >= 500 ? 'service_error' : 'bad_answer');
  if (body.code !== 'Ok') return unavailable(failureForCode(body.code));
  return status === 200 ? readRoute(body) : unavailable('bad_answer');
}

// -- Asking -------------------------------------------------------------------

/** `work` must not throw; whatever it answers lands at its item's position. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await work(items[index], index);
    }
  };
  const workers = Math.min(Math.max(1, Math.floor(limit)), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

export interface RoutePairsOptions {
  readonly fetchFn: typeof fetch;
  readonly baseUrl: string;
  /** For one request, answer included. */
  readonly timeoutMs: number;
  readonly concurrency: number;
  /** After this the remaining pairs are not asked for at all: a hung container must not use up the worker's minute. */
  readonly deadlineMs: number;
  readonly now: () => number;
}

export interface RoutePairsOutcome {
  readonly results: readonly RouteResult[];
  /** OSRM's own stamp of the map data (the OSM timestamp of the extract), from the first answer that has one. */
  readonly dataVersion: string | null;
}

const isAbort = (error: unknown): boolean => isRecord(error) && error.name === 'AbortError';

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text(); // an abort lands here as AbortError and is the caller's timeout
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function askOsrm(url: string, options: RoutePairsOptions): Promise<OsrmInterpretation> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchFn(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    return interpretOsrmAnswer(response.status, await readJson(response));
  } catch (error) {
    return unavailable(isAbort(error) ? 'timeout' : 'unreachable');
  } finally {
    clearTimeout(timer);
  }
}

interface PairAnswer {
  readonly result: RouteResult;
  readonly dataVersion: string | null;
}

function answerFor(id: string, found: OsrmInterpretation): PairAnswer {
  if (found.kind === 'unavailable') return { result: { id, kind: 'unavailable', reason: found.reason }, dataVersion: null };
  const { durationSeconds, distanceMeters, snapMeters, dataVersion } = found;
  return { result: { id, kind: 'route', durationSeconds, distanceMeters, snapMeters }, dataVersion };
}

/** Routes the pairs, a few at a time. Never throws; a pair that failed says why and the others go on. */
export async function routePairs(pairs: readonly RoutePair[], options: RoutePairsOptions): Promise<RoutePairsOutcome> {
  const startedAt = options.now();
  const answers = await mapWithConcurrency(pairs, options.concurrency, async (pair) => {
    const late = options.now() - startedAt > options.deadlineMs;
    return answerFor(pair.id, late ? unavailable('timeout') : await askOsrm(routeUrl(options.baseUrl, pair), options));
  });
  const dataVersion = answers.find((answer) => answer.dataVersion !== null)?.dataVersion ?? null;
  return { results: answers.map((answer) => answer.result), dataVersion };
}

// -- The answer, as the browser reads it --------------------------------------

export type RouterFailure = RouteRefusalReason | 'function_unreachable' | 'bad_answer';

export type RouteBatchAnswer =
  | { readonly ok: true; readonly dataVersion: string | null; readonly results: readonly RouteResult[] }
  | { readonly ok: false; readonly reason: RouterFailure };

function readResult(value: unknown): RouteResult | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  if (value.kind === 'unavailable') {
    const known = (ROUTE_FAILURE_REASONS as readonly unknown[]).includes(value.reason);
    return known ? { id: value.id, kind: 'unavailable', reason: value.reason as RouteFailureReason } : null;
  }
  const snap = value.snapMeters;
  const snapped = Array.isArray(snap) && snap.length === 2 && isNonNegative(snap[0]) && isNonNegative(snap[1]);
  if (value.kind !== 'route' || !snapped || !isNonNegative(value.durationSeconds) || !isNonNegative(value.distanceMeters)) return null;
  return {
    id: value.id,
    kind: 'route',
    durationSeconds: value.durationSeconds,
    distanceMeters: value.distanceMeters,
    snapMeters: [snap[0] as number, snap[1] as number],
  };
}

function readSuccess(body: Record<string, unknown>): RouteBatchAnswer {
  const version = body.data_version;
  const versionOk = version === undefined || version === null || typeof version === 'string';
  if (!versionOk || !Array.isArray(body.results)) return { ok: false, reason: 'bad_answer' };
  const results = body.results.map(readResult);
  if (results.some((result) => result === null)) return { ok: false, reason: 'bad_answer' };
  return { ok: true, dataVersion: typeof version === 'string' ? version : null, results: results as RouteResult[] };
}

function reasonForStatus(status: number): RouterFailure {
  if (status === 401) return 'not_authenticated';
  if (status === 403) return 'no_company';
  if (status === 405) return 'method_not_allowed';
  if (status === 413) return 'too_large';
  if (status === 400) return 'invalid_request';
  return status >= 500 ? 'server_error' : 'bad_answer';
}

/** Reads the function's answer. A body that is not exactly the contract is bad_answer, never half-used. */
export function parseRouteResponse(status: number, body: unknown): RouteBatchAnswer {
  if (isRecord(body) && body.ok === true) return readSuccess(body);
  const reason = isRecord(body) ? body.reason : undefined;
  if ((ROUTE_REFUSAL_REASONS as readonly unknown[]).includes(reason)) {
    return { ok: false, reason: reason as RouteRefusalReason };
  }
  return { ok: false, reason: reasonForStatus(status) };
}
