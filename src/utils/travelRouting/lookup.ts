/**
 * The synchronous estimator the engine asks. The engine stays deterministic and
 * testable (types.ts: "synchronous on purpose"), so the network happens before
 * it runs: prefetch.ts routes every pair `listTravelRequests()` names and hands
 * the engine this lookup over the answers.
 *
 * A lookup that finds nothing answers `unavailable`. It never answers a number
 * it did not receive: the pair the engine asks for and the pair that was
 * prefetched are the same trips in the same direction, or there is no answer.
 */
import type { TravelEstimate, TravelEstimateRequest, TravelTimeEstimator } from '../tripAnalysis/types';

/** The earlier trip's drop-off to the later trip's pickup; a different direction is a different question. */
export const pairKey = (fromTripId: string, toTripId: string): string => JSON.stringify([fromTripId, toTripId]);

export const requestKey = (request: Pick<TravelEstimateRequest, 'fromTripId' | 'toTripId'>): string =>
  pairKey(request.fromTripId, request.toTripId);

export function createLookupEstimator(source: string, answers: ReadonlyMap<string, TravelEstimate>): TravelTimeEstimator {
  return {
    source,
    estimate: (request) => answers.get(requestKey(request)) ?? { kind: 'unavailable', source, reason: 'not_prefetched' },
  };
}
