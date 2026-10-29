import {
  MAX_PAIRS_PER_CALL,
  type GeoPoint as RouteGeoPoint,
  type RoutePair,
} from '../../../supabase/functions/_shared/travel-route-core';
import { MAX_SNAP_METERS, osrmSourceLabel } from '../travelRouting/estimate';
import type { TravelRouter } from '../travelRouting/prefetch';
import { driveSeconds, rideSeconds, roadKm } from './geo';
import type { GeoPoint, PoolAddress } from './types';

/**
 * Where the generator's drive times come from (external audit round 4).
 *
 * ## The defect this exists to fix, measured
 *
 * The generator used to know one model of the road: the straight line times
 * 1.3, at 21, 28 or 36 km/h by the hour (`geo.ts`). An auditor checked a
 * generated month with Nominatim and Valhalla and found 60 transitions where
 * the gap the generator left between two rides of one vehicle was shorter than
 * a routed drive from the previous Zielort to the next Abholort — 2.98 road km
 * that Valhalla needs 717 s for, in a gap of 185 s. Every one of those gaps
 * satisfied the generator's own rule; the rule was the problem. The road in
 * the Bergisches Land is longer than the line, and slower than 28 km/h, on
 * exactly the short urban hops a taxi makes.
 *
 * The owner's decision of 29.10.2026 forbids fixing that by turning the speed
 * constants down until the warnings go away. So the times now come from a
 * routing service, measured once per address pool, and the constants stay
 * what they were: the labelled fallback when no service answered.
 *
 * ## What a model answers, and what it never answers
 *
 * A leg is a measured or estimated drive between two points. `null` means no
 * route is known — the service said `no_route`, timed out, or put a point
 * hundreds of metres from any road — and the generator then does not use that
 * pair at all. It never reads a missing leg as zero: a zero is the one number
 * that makes every gap pass. The same point to itself is a real zero (a
 * passenger picked up where the last one got out), and only that.
 *
 * The routing service has no traffic (OSRM's car profile is free flow), so a
 * measured model ignores the hour. That is a floor and is recorded as such in
 * the workbook's source sheet; it is not dressed up as a rush-hour time.
 */

export interface TravelLeg {
  /** Whole seconds. */
  seconds: number;
  /** Road kilometres. */
  km: number;
}

export interface TravelModel {
  /** `osrm`, `osrm@2026-10`, `estimate:haversine-x1.3`, or a test's own label. Printed on every check. */
  readonly source: string;
  /** True only when every answer comes from a routing service. An estimate is never called a measurement. */
  readonly measured: boolean;
  /** An empty vehicle from `from` to `to`, no handling time. Null when no route is known. */
  drive(from: GeoPoint, to: GeoPoint, hour: number): TravelLeg | null;
  /** A ride with a passenger, boarding and alighting included. Null when no route is known. */
  ride(from: GeoPoint, to: GeoPoint, hour: number): TravelLeg | null;
}

export const ESTIMATE_SOURCE = 'estimate:haversine-x1.3';

/**
 * Today's model, unchanged and labelled: the straight line times 1.3 at a city
 * speed. It is the default so that every caller that passes no model gets the
 * month it got before, ride for ride; `travelModel.test.ts` pins that.
 */
export const ESTIMATE_TRAVEL_MODEL: TravelModel = {
  source: ESTIMATE_SOURCE,
  measured: false,
  drive: (from, to, hour) => {
    const km = roadKm(from, to);
    return { seconds: driveSeconds(km, hour), km };
  },
  ride: (from, to, hour) => {
    const km = roadKm(from, to);
    return { seconds: rideSeconds(km, hour), km };
  },
};

/** Boarding and alighting on top of the routed drive, the 120 s `rideSeconds` has always carried. */
export const RIDE_HANDLING_SECONDS = 120;

/** Six decimals: about 11 cm, finer than any address point, coarse enough to survive a JSON round trip. */
export function pointKey(p: GeoPoint): string {
  return `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
}

const legKey = (from: GeoPoint, to: GeoPoint): string => `${pointKey(from)}>${pointKey(to)}`;

/** A routed matrix over a set of points, as it is kept and as it is printed. */
export interface RoutedMatrix {
  source: string;
  /** ISO 8601, when the routes were asked. */
  computedAt: string;
  points: GeoPoint[];
  /** Ordered pairs that have a measured route. `seconds` as the service answered it. */
  legs: Record<string, TravelLeg>;
  /** Ordered pairs that do not, with the reason. A pair is in exactly one of the two. */
  failures: Record<string, string>;
}

/**
 * A model over a measured matrix. A pair outside the matrix has no route —
 * there is no fallback to the estimate inside a measured model, because a
 * month built from two models at once could not say which of its gaps were
 * measured.
 */
export function matrixTravelModel(matrix: RoutedMatrix): TravelModel {
  const look = (from: GeoPoint, to: GeoPoint): TravelLeg | null => {
    if (pointKey(from) === pointKey(to)) return { seconds: 0, km: 0 };
    const leg = matrix.legs[legKey(from, to)];
    if (!leg || !Number.isFinite(leg.seconds) || !Number.isFinite(leg.km) || leg.seconds < 0 || leg.km < 0) return null;
    // A measured route between two distinct points that takes no time is not
    // a route; it is the zero this module exists to keep out.
    if (leg.seconds === 0) return null;
    return { seconds: Math.ceil(leg.seconds), km: leg.km };
  };
  return {
    source: matrix.source,
    measured: true,
    drive: (from, to) => look(from, to),
    ride: (from, to) => {
      if (pointKey(from) === pointKey(to)) return null;
      const leg = look(from, to);
      return leg ? { seconds: leg.seconds + RIDE_HANDLING_SECONDS, km: leg.km } : null;
    },
  };
}

/** FNV-1a over a label: stable across runs and machines, independent of any seed. */
function labelHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The addresses that get routed: `max` of the pool, chosen by a hash of their
 * label.
 *
 * Every ordered pair is one request to a routing service that runs on another
 * product's server behind a 40-a-second gateway, so the matrix cannot cover a
 * pool of three hundred (ninety thousand requests). A hash keeps the choice
 * stable for a pool — the matrix is computed once and reused for every seed —
 * and keeps the pool's own density: points sit where the city's addresses sit,
 * which a "farthest point first" choice would not.
 */
export function selectRoutingPoints(pool: readonly PoolAddress[], max: number): PoolAddress[] {
  const unique = new Map<string, PoolAddress>();
  for (const a of pool) if (!unique.has(pointKey(a))) unique.set(pointKey(a), a);
  return [...unique.values()]
    .map(a => ({ a, h: labelHash(a.label) }))
    .sort((x, y) => x.h - y.h || x.a.label.localeCompare(y.a.label))
    .slice(0, Math.max(0, max))
    .map(x => x.a);
}

/** Reasons that say the service was busy or away, not that the pair has no road. Worth one more try. */
const RETRYABLE = new Set(['timeout', 'unreachable', 'service_error', 'rate_limited', 'function_unreachable', 'server_error', 'bad_answer']);

export interface MatrixOptions {
  now?: () => Date;
  /** Between two calls, so the gateway's budget is not spent at its ceiling. */
  pauseMs?: number;
  /** Before the one retry of the pairs that failed for a retryable reason. */
  retryDelayMs?: number;
  onProgress?: (done: number, total: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Every ordered pair of `points`, routed through `router`, one call at a time.
 *
 * A pair the service answers is a leg; one it refuses, cannot route, or snaps
 * further than `MAX_SNAP_METERS` from a road is a failure with its reason —
 * the same bound the Fahrtanalyse applies, so a point the analysis would not
 * believe is not believed here either. Retryable failures get exactly one
 * more call; what still fails stays a failure and the generator will not use
 * that pair.
 */
export async function buildRoutedMatrix(
  points: readonly GeoPoint[],
  router: TravelRouter,
  options: MatrixOptions = {},
): Promise<RoutedMatrix> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());
  const pairs: { id: string; from: GeoPoint; to: GeoPoint }[] = [];
  points.forEach((from, i) => points.forEach((to, j) => {
    if (i !== j && pointKey(from) !== pointKey(to)) pairs.push({ id: legKey(from, to), from, to });
  }));

  const legs: Record<string, TravelLeg> = {};
  const failures: Record<string, string> = {};
  let dataVersion: string | null = null;
  let done = 0;
  const total = pairs.length;

  const ask = async (batch: typeof pairs): Promise<void> => {
    const routePairs: RoutePair[] = batch.map((p, n) => ({ id: String(n), from: asRoutePoint(p.from), to: asRoutePoint(p.to) }));
    const answer = await router.route(routePairs);
    if (!answer.ok) {
      for (const p of batch) failures[p.id] = answer.reason;
      return;
    }
    dataVersion = dataVersion ?? answer.dataVersion;
    const byId = new Map(answer.results.map(r => [r.id, r]));
    batch.forEach((p, n) => {
      const result = byId.get(String(n));
      delete failures[p.id];
      if (!result) { failures[p.id] = 'not_answered'; return; }
      if (result.kind === 'unavailable') { failures[p.id] = result.reason; return; }
      if (result.snapMeters.some(snap => snap > MAX_SNAP_METERS)) { failures[p.id] = 'too_far_from_road'; return; }
      if (!(result.durationSeconds > 0) || !Number.isFinite(result.distanceMeters)) { failures[p.id] = 'bad_answer'; return; }
      legs[p.id] = { seconds: result.durationSeconds, km: result.distanceMeters / 1000 };
    });
  };

  for (let i = 0; i < pairs.length; i += MAX_PAIRS_PER_CALL) {
    if (i > 0 && options.pauseMs) await sleep(options.pauseMs);
    const batch = pairs.slice(i, i + MAX_PAIRS_PER_CALL);
    await ask(batch);
    done += batch.length;
    options.onProgress?.(done, total);
  }

  const retry = pairs.filter(p => RETRYABLE.has(failures[p.id] ?? ''));
  if (retry.length > 0) {
    await sleep(options.retryDelayMs ?? 5000);
    for (let i = 0; i < retry.length; i += MAX_PAIRS_PER_CALL) {
      if (i > 0 && options.pauseMs) await sleep(options.pauseMs);
      await ask(retry.slice(i, i + MAX_PAIRS_PER_CALL));
    }
  }

  return {
    source: osrmSourceLabel(dataVersion),
    computedAt: now().toISOString(),
    points: points.map(p => ({ lat: p.lat, lon: p.lon })),
    legs,
    failures,
  };
}

function asRoutePoint(p: GeoPoint): RouteGeoPoint {
  return { lat: Number(p.lat.toFixed(6)), lon: Number(p.lon.toFixed(6)) };
}

/** How much of a matrix was measured, for the source sheet and the screen. */
export function matrixCoverage(matrix: RoutedMatrix): { pairs: number; routed: number; failed: number; byReason: Record<string, number> } {
  const byReason: Record<string, number> = {};
  for (const reason of Object.values(matrix.failures)) byReason[reason] = (byReason[reason] ?? 0) + 1;
  const routed = Object.keys(matrix.legs).length;
  const failed = Object.keys(matrix.failures).length;
  return { pairs: routed + failed, routed, failed, byReason };
}
