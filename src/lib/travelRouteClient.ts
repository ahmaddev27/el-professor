/**
 * The one network seam to the travel-route function: the browser's half of the
 * wire contract in supabase/functions/_shared/travel-route-core.ts.
 *
 * It sends the signed-in user's access token (the function asks GoTrue who that
 * is, and refuses the anon key, which ships in this bundle and proves nothing),
 * posts coordinates and ids and nothing else, and reads the answer with the
 * same parser the tests of the function use. It never throws: a lost
 * connection, a refusal, an answer that is not the contract are each an
 * `ok: false` with a reason, and the Fahrtenanalyse shows that reason where it
 * would otherwise have shown a number.
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

/** The worker answers inside 25 s by its own deadline; this is the browser's patience on top. */
export const TRAVEL_ROUTE_TIMEOUT_MS = 45_000;

export interface TravelRouteDeps {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** The caller's access token, or null when there is no session. */
  getAccessToken?: () => Promise<string | null>;
  /** Asks for a fresh session after a 401; true when there is one. */
  refreshSession?: () => Promise<boolean>;
}

// Imported on use: supabase.ts reads `window` as it loads, and the seam must be testable without a browser.
async function currentAccessToken(): Promise<string | null> {
  const { supabase } = await import('./supabase');
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function refreshedSession(): Promise<boolean> {
  const { supabase } = await import('./supabase');
  const { data, error } = await supabase.auth.refreshSession();
  return !error && !!data.session;
}

function endpoint(baseUrl?: string): string {
  const base = (baseUrl ?? String(import.meta.env.VITE_SUPABASE_URL ?? '')).replace(/\/+$/, '');
  return `${base}/functions/v1/travel-route`;
}

/** Only what the function reads: whatever else a caller's objects carry never leaves the browser. */
function requestBody(pairs: readonly RoutePair[]): string {
  const point = (p: { lat: number; lon: number }) => ({ lat: p.lat, lon: p.lon });
  return JSON.stringify({ pairs: pairs.map((pair) => ({ id: pair.id, from: point(pair.from), to: point(pair.to) })) });
}

interface Exchange {
  readonly status: number;
  readonly body: unknown;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text(); // an abort lands here and is the timeout
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** null when the request never produced an answer: no connection, or no answer in time. */
async function exchange(payload: string, token: string, deps: TravelRouteDeps): Promise<Exchange | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? TRAVEL_ROUTE_TIMEOUT_MS);
  try {
    const response = await (deps.fetchImpl ?? fetch)(endpoint(deps.baseUrl), {
      method: 'POST',
      headers: {
        apikey: String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: payload,
      signal: controller.signal,
    });
    return { status: response.status, body: await readJson(response) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function tokenOrNull(deps: TravelRouteDeps): Promise<string | null> {
  try {
    return await (deps.getAccessToken ?? currentAccessToken)();
  } catch {
    return null;
  }
}

async function refreshed(deps: TravelRouteDeps): Promise<boolean> {
  try {
    return await (deps.refreshSession ?? refreshedSession)();
  } catch {
    return false;
  }
}

async function callFunction(pairs: readonly RoutePair[], deps: TravelRouteDeps): Promise<RouteBatchAnswer> {
  let token = await tokenOrNull(deps);
  if (!token) return { ok: false, reason: 'not_authenticated' };
  const payload = requestBody(pairs);
  let answer = await exchange(payload, token, deps);
  if (answer?.status === 401 && (await refreshed(deps))) {
    token = await tokenOrNull(deps);
    if (token) answer = await exchange(payload, token, deps);
  }
  return answer ? parseRouteResponse(answer.status, answer.body) : { ok: false, reason: 'function_unreachable' };
}

export function createTravelRouteClient(deps: TravelRouteDeps = {}): TravelRouter {
  return { route: (pairs) => callFunction(pairs, deps) };
}
