/**
 * Before the engine runs: place the addresses, route the pairs, and hand the
 * engine a lookup (lookup.ts) over what came back.
 *
 *   listTravelRequests(input)   what the engine will ask, addresses and all
 *     -> AddressLocator          address -> point            (NOT IMPLEMENTED)
 *     -> TravelRouter            points  -> road time        (travel-route -> OSRM)
 *     -> estimateFromRoute       road time -> an estimate, or the reason there is none
 *
 * ## The port nobody implements yet
 *
 * OSRM routes between points on a map. The Uber sheet gives addresses, and the
 * one coordinate on a row is the vehicle's position when the order arrived,
 * which is neither pickup nor drop-off. Something has to turn
 * "Konrad-Adenauer-Strasse 12, 42651 Solingen" into a point, and this module
 * does not: it takes that something as `AddressLocator` and asks it. See
 * src/lib/addressLocator.ts for why none exists, what it would cost, and what
 * the screen does until one does (nothing: every travel check stays
 * "nicht prüfbar", exactly as before).
 *
 * ## Every request gets an answer
 *
 * A request that could not be placed, routed or believed is answered
 * `unavailable` with the reason, and one that was never asked about is
 * `not_prefetched` by the lookup. Nothing here fills a gap with a number: a
 * locator that fails, a call that is refused, a router that drops a pair, a
 * point far from any road — each is a reason on the requests it touched, and
 * only on those.
 *
 * ## Requests are not routes
 *
 * Fahrtenbuch pairs repeat the same places (stations, hotels, the same
 * street). Two requests whose two places sit on the same two points share one
 * route, keyed by the points themselves, so a month's thousand pairs cost far
 * fewer questions to the container.
 */
import {
  MAX_PAIRS_PER_CALL,
  mapWithConcurrency,
  type GeoPoint,
  type RouteBatchAnswer,
  type RoutePair,
  type RouteResult,
  type RouterFailure,
} from '../../../supabase/functions/_shared/travel-route-core';
import type { TravelEstimate, TravelEstimateRequest, TravelTimeEstimator } from '../tripAnalysis/types';
import { estimateFromRoute, osrmSourceLabel, type AddressPrecision } from './estimate';
import { createLookupEstimator, requestKey } from './lookup';

export type LocatedAddress =
  | { readonly kind: 'located'; readonly point: GeoPoint; readonly precision: AddressPrecision }
  /** `reason` says why in a word (`no_house_number`, `too_coarse`, `unreachable`); the estimate carries it as `address_<reason>`. */
  | { readonly kind: 'unlocated'; readonly reason?: string };

export interface AddressLocator {
  /** An address missing from the answer, or answered `unlocated`, is an address it could not place. */
  locate(addresses: readonly string[]): Promise<ReadonlyMap<string, LocatedAddress>>;
}

export interface TravelRouter {
  /** At most MAX_PAIRS_PER_CALL pairs. Never throws; a failure is an `ok: false` answer. */
  route(pairs: readonly RoutePair[]): Promise<RouteBatchAnswer>;
}

export interface PrefetchDeps {
  readonly locator: AddressLocator;
  readonly router: TravelRouter;
  readonly now?: () => Date;
  /** How many calls to the function may be in flight at once. */
  readonly concurrency?: number;
}

const DEFAULT_CALL_CONCURRENCY = 3;

type Plan =
  | { readonly kind: 'leg'; readonly id: string; readonly fromPrecision: AddressPrecision; readonly toPrecision: AddressPrecision }
  | { readonly kind: 'unavailable'; readonly reason: string };

const fixed = (value: number): string => value.toFixed(6);
const legId = (from: GeoPoint, to: GeoPoint): string => `${fixed(from.lat)},${fixed(from.lon)}>${fixed(to.lat)},${fixed(to.lon)}`;

function distinctAddresses(requests: readonly TravelEstimateRequest[]): string[] {
  return [...new Set(requests.flatMap((request) => [request.fromAddress, request.toAddress]))];
}

/** null when the locator itself failed: that is a different reason from an address it could not place. */
async function locateAll(locator: AddressLocator, addresses: readonly string[]): Promise<ReadonlyMap<string, LocatedAddress> | null> {
  if (addresses.length === 0) return new Map();
  try {
    return await locator.locate(addresses);
  } catch {
    return null;
  }
}

/** Why a pair has no points: the reason of the first end the locator could not place, or the plain one. */
function unplacedReason(from: LocatedAddress | undefined, to: LocatedAddress | undefined): string {
  const unplaced = from?.kind === 'located' ? to : from;
  return unplaced?.kind === 'unlocated' && unplaced.reason ? `address_${unplaced.reason}` : 'address_not_located';
}

function planFor(request: TravelEstimateRequest, places: ReadonlyMap<string, LocatedAddress> | null, legs: Map<string, RoutePair>): Plan {
  if (places === null) return { kind: 'unavailable', reason: 'locator_failed' };
  const from = places.get(request.fromAddress);
  const to = places.get(request.toAddress);
  if (from?.kind !== 'located' || to?.kind !== 'located') return { kind: 'unavailable', reason: unplacedReason(from, to) };
  const id = legId(from.point, to.point);
  if (!legs.has(id)) legs.set(id, { id, from: from.point, to: to.point });
  return { kind: 'leg', id, fromPrecision: from.precision, toPrecision: to.precision };
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

async function askRouter(router: TravelRouter, pairs: readonly RoutePair[]): Promise<RouteBatchAnswer> {
  try {
    return await router.route(pairs);
  } catch {
    return { ok: false, reason: 'function_unreachable' };
  }
}

interface Routed {
  readonly results: ReadonlyMap<string, RouteResult>;
  readonly failures: ReadonlyMap<string, RouterFailure>;
  readonly dataVersion: string | null;
}

async function routeLegs(legs: readonly RoutePair[], deps: PrefetchDeps): Promise<Routed> {
  const calls = chunked(legs, MAX_PAIRS_PER_CALL);
  const answers = await mapWithConcurrency(calls, deps.concurrency ?? DEFAULT_CALL_CONCURRENCY, (pairs) => askRouter(deps.router, pairs));
  const results = new Map<string, RouteResult>();
  const failures = new Map<string, RouterFailure>();
  let dataVersion: string | null = null;
  calls.forEach((pairs, index) => {
    const answer = answers[index];
    if (!answer.ok) {
      for (const pair of pairs) failures.set(pair.id, answer.reason);
      return;
    }
    dataVersion ??= answer.dataVersion;
    const asked = new Set(pairs.map((pair) => pair.id));
    for (const result of answer.results) if (asked.has(result.id)) results.set(result.id, result);
  });
  return { results, failures, dataVersion };
}

interface Frame {
  readonly source: string;
  readonly computedAt: string;
}

function answerFor(plan: Plan, routed: Routed, frame: Frame): TravelEstimate {
  const unavailable = (reason: string): TravelEstimate => ({ kind: 'unavailable', source: frame.source, reason });
  if (plan.kind === 'unavailable') return unavailable(plan.reason);
  const failure = routed.failures.get(plan.id);
  if (failure) return unavailable(failure);
  const result = routed.results.get(plan.id);
  if (!result) return unavailable('bad_answer');
  return estimateFromRoute(result, { ...frame, fromPrecision: plan.fromPrecision, toPrecision: plan.toPrecision });
}

/** Never rejects. The estimator it returns answers every request it was given. */
export async function prefetchTravelEstimates(
  requests: readonly TravelEstimateRequest[],
  deps: PrefetchDeps,
): Promise<TravelTimeEstimator> {
  const computedAt = (deps.now ?? (() => new Date()))().toISOString();
  const places = await locateAll(deps.locator, distinctAddresses(requests));
  const legs = new Map<string, RoutePair>();
  const plans = requests.map((request) => planFor(request, places, legs));
  const routed = await routeLegs([...legs.values()], deps);
  const frame: Frame = { source: osrmSourceLabel(routed.dataVersion), computedAt };
  const answers = new Map<string, TravelEstimate>();
  requests.forEach((request, index) => answers.set(requestKey(request), answerFor(plans[index], routed, frame)));
  return createLookupEstimator(frame.source, answers);
}
