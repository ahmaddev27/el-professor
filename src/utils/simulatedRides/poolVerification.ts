import {
  INFRASTRUCTURE_REASONS,
  MAX_ADDRESSES_PER_CALL,
  SAME_PLACE_METERS,
  distanceMeters,
  type GeocodeFailure,
  type GeocodeResult,
  type UnlocatedReason,
} from '../../../supabase/functions/_shared/geocode-core';
import type { GeocodeClient } from '../../lib/geocodeClient';
import type { PoolAddress } from './types';

/**
 * Which pool addresses are real, checked against the geocoder (external audit
 * round 4).
 *
 * The pool is OpenStreetMap data fetched once per city. It holds house numbers
 * like "25;27" and points that sit on a building's corner, and the audit's 244
 * "unverifiable" checks were exactly the addresses a second geocoder could not
 * place. So before any pool address is routed or used, our own geocoder is asked
 * about it, and it is kept only when
 *
 *   - the answer is a point at house level (the function never returns less), and
 *   - that point lies within `SAME_PLACE_METERS` of the pool's own point.
 *
 * The second rule is the one that matters: an address the geocoder finds
 * somewhere else is a different place with the same text, and routing the pool's
 * point under that label would put a ride at an address nobody can verify.
 *
 * A kept address carries the GEOCODER'S point, not the pool's. Measured on the
 * first real month (29.10.2026, DEMO on staging): one transition was warned by
 * the independent re-check because the generator had routed from the pool's
 * point and the re-check from the geocoded house, 7.155 km / 640 s against
 * 7.316 km / 716 s for the same two addresses, both within the 100 m rule. A
 * check that places an address again must find the point the month was built
 * from, so the pool takes the point the product's own locator answers.
 *
 * Every dropped address keeps its reason, because "we threw some away" is not a
 * finding an operator can act on.
 *
 * ## What is not a reason to drop
 *
 * The geocoder being away. A rate limit, a timeout, an unreachable gateway say
 * nothing about the address, so the first such answer ends the asking and is
 * reported as a failure of the check. Converting it into "dropped: timeout"
 * would shrink the pool by whatever the outage happened to cover and carry on
 * as though the rest had been judged.
 *
 * The caller owns the pacing: one call at a time (the gateway admits two in
 * flight and five a second), `pauseMs` between calls.
 */

export const MOVED_REASON = 'moved';

export type DropReason = Exclude<UnlocatedReason, 'rate_limited' | 'service_error' | 'bad_answer' | 'unreachable' | 'timeout' | 'rejected'>
  | typeof MOVED_REASON;

export interface DroppedAddress {
  label: string;
  reason: DropReason;
  /** For `moved`: how far the geocoder's point is from the pool's, in whole metres. */
  distanceMeters?: number;
}

export interface PoolVerification {
  kept: PoolAddress[];
  dropped: DroppedAddress[];
  checked: number;
  /** The geocoder data's own date, when it said one. */
  dataUpdated: string | null;
}

export type VerificationFailure = GeocodeFailure | UnlocatedReason | 'not_answered';

export type VerificationOutcome =
  | ({ ok: true } & PoolVerification)
  | { ok: false; reason: VerificationFailure; checked: number };

export interface VerifyOptions {
  batchSize?: number;
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** The whole-number count by reason, for the screen and the source sheet. */
export function countDropped(dropped: readonly DroppedAddress[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of dropped) out[d.reason] = (out[d.reason] ?? 0) + 1;
  return out;
}

function judge(address: PoolAddress, result: GeocodeResult | undefined): { kept: true; at: PoolAddress } | { kept: false; drop: DroppedAddress } | { failure: VerificationFailure } {
  if (!result) return { failure: 'not_answered' };
  if (result.kind === 'unlocated') {
    if (INFRASTRUCTURE_REASONS.has(result.reason)) return { failure: result.reason };
    return { kept: false, drop: { label: address.label, reason: result.reason as DropReason } };
  }
  const away = distanceMeters(address, result);
  if (away > SAME_PLACE_METERS) {
    return { kept: false, drop: { label: address.label, reason: MOVED_REASON, distanceMeters: Math.round(away) } };
  }
  return { kept: true, at: { label: address.label, lat: result.lat, lon: result.lon } };
}

export async function verifyPool(
  pool: readonly PoolAddress[],
  client: GeocodeClient,
  options: VerifyOptions = {},
): Promise<VerificationOutcome> {
  const size = Math.max(1, Math.min(MAX_ADDRESSES_PER_CALL, options.batchSize ?? MAX_ADDRESSES_PER_CALL));
  const sleep = options.sleep ?? defaultSleep;
  const kept: PoolAddress[] = [];
  const dropped: DroppedAddress[] = [];
  let dataUpdated: string | null = null;
  let checked = 0;

  for (let from = 0; from < pool.length; from += size) {
    if (from > 0 && options.pauseMs) await sleep(options.pauseMs);
    const batch = pool.slice(from, from + size);
    // Ids are positions in this batch: the answer belongs to its request by id only.
    const answer = await client.geocode(batch.map((a, n) => ({ id: String(n), text: a.label })));
    if (!answer.ok) return { ok: false, reason: answer.reason, checked };
    dataUpdated = dataUpdated ?? answer.dataUpdated;
    const byId = new Map(answer.results.map(r => [r.id, r]));
    for (let n = 0; n < batch.length; n++) {
      const verdict = judge(batch[n], byId.get(String(n)));
      if ('failure' in verdict) return { ok: false, reason: verdict.failure, checked };
      if (verdict.kept) kept.push(verdict.at);
      else dropped.push(verdict.drop);
    }
    checked += batch.length;
    options.onProgress?.(checked, pool.length);
  }
  return { ok: true, kept, dropped, checked, dataUpdated };
}
