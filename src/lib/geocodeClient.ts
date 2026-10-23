/**
 * The one network seam to the geocode-address function: the browser's half of the
 * wire contract in supabase/functions/_shared/geocode-core.ts.
 *
 * It posts addresses as the Fahrtenbuch holds them, with an id of its own, and
 * nothing else about the ride (no trip id, no driver, no time, no fare): the
 * transport, with the session token, the timeout and the one refresh after a 401,
 * is edgeFunctionCall.ts. It reads the answer with the parser the function's tests
 * use and never throws: a lost connection, a refusal, an answer that is not the
 * contract are each an `ok: false` with a reason, which the locator turns into an
 * address that is not placed and says why.
 *
 * There is no fallback and there must not be one. A public geocoder would send a
 * passenger's address to a third party, which the owner ruled out, and a guessed
 * point (a street's middle, a postal area's centre) would turn "nicht prüfbar"
 * into "bestanden".
 */
import {
  parseGeocodeResponse,
  type GeocodeBatchAnswer,
  type GeocodeQuery,
} from '../../supabase/functions/_shared/geocode-core';
import { postToEdgeFunction, type EdgeCallDeps } from './edgeFunctionCall';

/** The function stops asking at 35 s by its own deadline; this is the browser's patience on top. */
export const GEOCODE_TIMEOUT_MS = 60_000;

export type GeocodeDeps = EdgeCallDeps;

export interface GeocodeClient {
  /** At most MAX_ADDRESSES_PER_CALL addresses. Never throws; a failure is an `ok: false` answer. */
  geocode(batch: readonly GeocodeQuery[]): Promise<GeocodeBatchAnswer>;
}

/** Only what the function reads: whatever else a caller's objects carry never leaves the browser. */
function requestBody(batch: readonly GeocodeQuery[]): string {
  return JSON.stringify({ addresses: batch.map(({ id, text }) => ({ id, text })) });
}

async function callFunction(batch: readonly GeocodeQuery[], deps: GeocodeDeps): Promise<GeocodeBatchAnswer> {
  const out = await postToEdgeFunction('geocode-address', requestBody(batch), deps, GEOCODE_TIMEOUT_MS);
  if (out.kind === 'no_session') return { ok: false, reason: 'not_authenticated' };
  if (out.kind === 'unreachable') return { ok: false, reason: 'function_unreachable' };
  return parseGeocodeResponse(out.status, out.body);
}

export function createGeocodeClient(deps: GeocodeDeps = {}): GeocodeClient {
  return { geocode: (batch) => callFunction(batch, deps) };
}
