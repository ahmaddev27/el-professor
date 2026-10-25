/**
 * The estimator the Fahrtenanalyse hands the engine, once there is one.
 *
 * The engine is synchronous, so the network happens here, around it: this hook
 * asks `listTravelRequests()` what the engine will ask, prefetches the answers
 * (src/utils/travelRouting/prefetch.ts) and returns the lookup over them. Until
 * the lookup is ready, and whenever there is no locator or no setting to judge
 * a gap by, it returns `undefined` and the engine uses `noRoutingEstimator`:
 * every travel check is "nicht prüfbar", which is the truth until a number has
 * been measured.
 *
 * Three things it takes care of, because each is a way to show a wrong number:
 *
 * - **The answer belongs to its trips.** The lookup is returned only while its
 *   signature (the pairs and their addresses) is the one on screen, so a new
 *   month never gets the previous month's estimates while its own are loading.
 * - **A late answer is ignored.** Every run is numbered, and a run that was
 *   superseded or unmounted does not set state.
 * - **The same trips are not asked twice.** The effect depends on the signature
 *   of the requests and not on the identity of the arrays they came from.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createTravelRouteClient } from '../lib/travelRouteClient';
import { listTravelRequests } from '../utils/tripAnalysis';
import type { AnalysisTrip, TravelEstimateRequest, TravelTimeEstimator, TripAnalysisSettings } from '../utils/tripAnalysis/types';
import { prefetchTravelEstimates, type AddressLocator, type TravelRouter } from '../utils/travelRouting/prefetch';

export interface TravelEstimatorDeps {
  /** The locator to ask (useAppAddressLocator in the app); none, the default, switches the whole thing off. */
  readonly locator?: AddressLocator | null;
  readonly router?: TravelRouter;
}

function requestsFor(
  trips: readonly AnalysisTrip[],
  settings: TripAnalysisSettings | null,
  enabled: boolean,
): TravelEstimateRequest[] {
  if (!enabled || !settings) return [];
  try {
    return listTravelRequests({ trips, settings });
  } catch {
    // An input the engine refuses is the analysis's own failure to report, not this hook's.
    return [];
  }
}

const signatureOf = (requests: readonly TravelEstimateRequest[]): string =>
  requests.map((r) => `${r.fromTripId}|${r.toTripId}|${r.fromAddress}|${r.toAddress}`).join('\n');

export function useTravelEstimator(
  trips: readonly AnalysisTrip[],
  settings: TripAnalysisSettings | null,
  deps: TravelEstimatorDeps = {},
): TravelTimeEstimator | undefined {
  const locator = deps.locator ?? null;
  const router = useMemo(() => deps.router ?? createTravelRouteClient(), [deps.router]);
  const requests = useMemo(() => requestsFor(trips, settings, locator !== null), [trips, settings, locator]);
  const signature = useMemo(() => signatureOf(requests), [requests]);
  const latestRequests = useRef(requests);
  latestRequests.current = requests;
  const run = useRef(0);
  const [ready, setReady] = useState<{ signature: string; estimator: TravelTimeEstimator } | null>(null);

  useEffect(() => {
    run.current += 1;
    const mine = run.current;
    if (locator !== null && signature !== '') {
      void prefetchTravelEstimates(latestRequests.current, { locator, router })
        .then((estimator) => {
          if (mine === run.current) setReady({ signature, estimator });
        })
        .catch(() => undefined);
    }
    return () => {
      run.current += 1;
    };
  }, [signature, locator, router]);

  return ready !== null && signature !== '' && ready.signature === signature ? ready.estimator : undefined;
}
