/**
 * The one network seam to the travel-route function: the browser's half of the
 * wire contract in supabase/functions/_shared/travel-route-core.ts.
 *
 * It posts coordinates and ids and nothing else (the transport, with the
 * session token, the timeout and the one refresh after a 401, is
 * edgeFunctionCall.ts), and reads the answer with the same parser the tests of
 * the function use. It never throws: a lost connection, a refusal, an answer that
 * is not the contract are each an `ok: false` with a reason, and the
 * Fahrtenanalyse shows that reason where it would otherwise have shown a number.
 *
 * There is no fallback and there must not be one. The old estimate of the
 * simulated rides (haversine times 1.3 at a city speed) stays where it is, in
 * the generator that invents its own rides; it is not a stand-in for a road
 * when the container is down, because a made-up drive time would turn "nicht
 * prüfbar" into "bestanden".
 */
import {
  parseRouteResponse,
  type RouteBatchAnswer,
  type RoutePair,
} from '../../supabase/functions/_shared/travel-route-core';
import type { TravelRouter } from '../utils/travelRouting/prefetch';
import { postToEdgeFunction, type EdgeCallDeps } from './edgeFunctionCall';

/** The worker answers inside 25 s by its own deadline; this is the browser's patience on top. */
export const TRAVEL_ROUTE_TIMEOUT_MS = 45_000;

export type TravelRouteDeps = EdgeCallDeps;

/** Only what the function reads: whatever else a caller's objects carry never leaves the browser. */
function requestBody(pairs: readonly RoutePair[]): string {
  const point = (p: { lat: number; lon: number }) => ({ lat: p.lat, lon: p.lon });
  return JSON.stringify({ pairs: pairs.map((pair) => ({ id: pair.id, from: point(pair.from), to: point(pair.to) })) });
}

async function callFunction(pairs: readonly RoutePair[], deps: TravelRouteDeps): Promise<RouteBatchAnswer> {
  const out = await postToEdgeFunction('travel-route', requestBody(pairs), deps, TRAVEL_ROUTE_TIMEOUT_MS);
  if (out.kind === 'no_session') return { ok: false, reason: 'not_authenticated' };
  if (out.kind === 'unreachable') return { ok: false, reason: 'function_unreachable' };
  return parseRouteResponse(out.status, out.body);
}

export function createTravelRouteClient(deps: TravelRouteDeps = {}): TravelRouter {
  return { route: (pairs) => callFunction(pairs, deps) };
}
