/**
 * Travel between consecutive trips of one driver: can the driver get from the
 * earlier trip's drop-off to the next trip's pickup in the time between them?
 *
 * The engine does not know. It asks an injected estimator and compares:
 *
 *   required = estimate + travelMarginMinutes
 *   short by = required − available          (conflict when > 0)
 *
 * No routing service exists yet, so the default estimator answers
 * "unavailable" and every travel check is 'unverifiable' — never 'passed'. A
 * missing address is 'unverifiable' without asking. Without an estimate, a gap
 * below the margin alone is kept as a weak signal (severity warning, status
 * still unverifiable): the margin is an operational buffer, not a measured
 * travel time.
 *
 * "Previous" is the trip that reached the driver's running maximum end — the
 * end the block gap is measured from — so a short trip inside a long one does
 * not hide the long one's end. Pairs that overlap are the overlap check's
 * finding and get no travel check.
 */
import { analysedByDriver, assertValidInput, classifyTrip, lowestConfidence, type ClassifiedTrip } from './classify';
import { compareIds } from './intervals';
import { msAsMinutesText, minutesText } from './text';
import type {
  Confidence,
  Issue,
  IssueSeverity,
  IssueStatus,
  TravelEstimate,
  TravelEstimateRequest,
  TravelTimeEstimator,
  TripAnalysisInput,
} from './types';

const MINUTE_MS = 60_000;

/** The default: no routing service, so nothing can be verified. */
export const noRoutingEstimator: TravelTimeEstimator = {
  source: 'none',
  estimate: () => ({ kind: 'unavailable', source: 'none', reason: 'no_routing_service' }),
};

export interface TravelPair {
  readonly from: ClassifiedTrip;
  readonly to: ClassifiedTrip;
  /** to.start − from.end, ≥ 0. */
  readonly gapMs: number;
}

/** Consecutive pairs of one driver's analysed trips, already sorted by start, then id. */
export function travelPairs(sortedTrips: readonly ClassifiedTrip[]): TravelPair[] {
  const pairs: TravelPair[] = [];
  let latest: ClassifiedTrip | null = null;
  for (const current of sortedTrips) {
    if (latest) {
      const gapMs = current.start - latest.end;
      if (gapMs >= 0) pairs.push({ from: latest, to: current, gapMs });
    }
    if (!latest || current.end > latest.end) latest = current;
  }
  return pairs;
}

function requestOf(pair: TravelPair): TravelEstimateRequest | null {
  const fromAddress = pair.from.trip.dropoff_address?.trim() ?? '';
  const toAddress = pair.to.trip.pickup_address?.trim() ?? '';
  if (fromAddress === '' || toAddress === '') return null;
  return {
    fromTripId: pair.from.trip.id,
    toTripId: pair.to.trip.id,
    fromAddress,
    toAddress,
    departureMs: pair.from.end,
  };
}

/**
 * Every request the engine would send for this input, in the order it sends
 * them. A routing service (release 2) prefetches these, then hands the engine
 * a synchronous lookup over the answers.
 */
export function listTravelRequests(input: TripAnalysisInput): TravelEstimateRequest[] {
  assertValidInput(input);
  const classified = input.trips.map((trip, position) => classifyTrip(trip, position));
  const groups = analysedByDriver(classified);
  const requests: TravelEstimateRequest[] = [];
  for (const driverId of [...groups.keys()].sort(compareIds)) {
    for (const pair of travelPairs(groups.get(driverId) ?? [])) {
      const request = requestOf(pair);
      if (request) requests.push(request);
    }
  }
  return requests;
}

function missingAddressText(pair: TravelPair): string {
  const fromMissing = !(pair.from.trip.dropoff_address?.trim());
  const toMissing = !(pair.to.trip.pickup_address?.trim());
  if (fromMissing && toMissing) return 'Zielort und Abholort fehlen';
  return fromMissing ? 'Zielort der vorherigen Fahrt fehlt' : 'Abholort der nächsten Fahrt fehlt';
}

/** The dictionary key for the same sentence. */
function missingAddressKey(pair: TravelPair): string {
  const fromMissing = !(pair.from.trip.dropoff_address?.trim());
  const toMissing = !(pair.to.trip.pickup_address?.trim());
  if (fromMissing && toMissing) return 'engine.analysis.travel.addressBothMissing';
  return fromMissing
    ? 'engine.analysis.travel.addressFromMissing'
    : 'engine.analysis.travel.addressToMissing';
}

function usableEstimate(estimate: TravelEstimate): estimate is Extract<TravelEstimate, { kind: 'estimated' }> {
  return estimate.kind === 'estimated' && Number.isFinite(estimate.minutes) && estimate.minutes >= 0;
}

/** One finding per pair: passed, conflict, or unverifiable. */
export function travelFinding(pair: TravelPair, estimator: TravelTimeEstimator, marginMinutes: number): Issue {
  const availableMinutes = pair.gapMs / MINUTE_MS;
  const belowMargin = availableMinutes < marginMinutes;
  const vehicleChange = pair.from.vehicleKey !== pair.to.vehicleKey;
  const timeConfidence = lowestConfidence(pair.from.confidence, pair.to.confidence);
  const base = {
    id: `travel_gap:${pair.from.trip.id}>${pair.to.trip.id}`,
    type: 'travel_gap' as const,
    driverId: pair.from.driverKey ?? undefined,
    tripIds: [pair.from.trip.id, pair.to.trip.id].sort(),
  };
  const commonValues = {
    fromTripId: pair.from.trip.id,
    toTripId: pair.to.trip.id,
    availableMinutes,
    marginMinutes,
    belowMargin,
    vehicleChange,
  };

  const request = requestOf(pair);
  const estimate: TravelEstimate = request
    ? estimator.estimate(request)
    : { kind: 'unavailable', source: estimator.source, reason: 'address_missing' };

  if (!usableEstimate(estimate)) {
    const reason = estimate.kind === 'unavailable' ? estimate.reason : 'invalid_estimate';
    const cause = request ? `keine Routenberechnung verfügbar (${reason})` : missingAddressText(pair);
    // `cause` is a key when the address is missing; engineText() resolves it.
    // With a request there is no address problem, so the slot goes unused.
    const causeVar = request ? cause : missingAddressKey(pair);
    const weakSignal = belowMargin
      ? ` Die verfügbare Zeit von ${minutesText(availableMinutes)} Min. liegt unter dem Puffer von ${minutesText(marginMinutes)} Min. – schwacher Hinweis.`
      : '';
    return {
      ...base,
      severity: belowMargin ? 'warning' : 'info',
      status: 'unverifiable',
      values: {
        ...commonValues,
        estimateMinutes: null,
        requiredMinutes: null,
        shortByMinutes: null,
        estimateSource: estimate.source,
        estimateConfidence: null,
        estimateComputedAt: null,
        reason,
      },
      explanation: `Wechsel nicht prüfbar: ${cause}.${weakSignal}`,
      // Four keys rather than one sentence with a `{cause}` slot: the routing
      // cause carries a machine reason of its own, and a key cannot hold
      // another key's slots.
      explanationKey: request
        ? (belowMargin
            ? 'engine.analysis.travel.unverifiable.noRouting.belowMargin'
            : 'engine.analysis.travel.unverifiable.noRouting')
        : (belowMargin
            ? 'engine.analysis.travel.unverifiable.address.belowMargin'
            : 'engine.analysis.travel.unverifiable.address'),
      explanationVars: {
        cause: causeVar,
        reason,
        availableMinutes: minutesText(availableMinutes),
        marginMinutes: minutesText(marginMinutes),
      },
      confidence: 'low',
    };
  }

  const requiredMinutes = estimate.minutes + marginMinutes;
  const shortByMinutes = requiredMinutes - availableMinutes;
  const status: IssueStatus = shortByMinutes > 0 ? 'conflict' : 'passed';
  const severity: IssueSeverity = status === 'conflict' ? 'warning' : 'info';
  const marginText = marginMinutes > 0 ? ` + ${minutesText(marginMinutes)} Min. Puffer` : '';
  const explanation =
    status === 'conflict'
      ? `Verfügbar ${msAsMinutesText(pair.gapMs)} Min., geschätzt ${minutesText(estimate.minutes)} Min.${marginText}, es fehlen ${minutesText(shortByMinutes)} Min. (Quelle: ${estimate.source}).`
      : `Verfügbar ${msAsMinutesText(pair.gapMs)} Min., benötigt ${minutesText(requiredMinutes)} Min. (geschätzt ${minutesText(estimate.minutes)} Min.${marginText}, Quelle: ${estimate.source}).`;
  const explanationKey = status === 'conflict'
    ? (marginMinutes > 0 ? 'engine.analysis.travel.shortWithMargin' : 'engine.analysis.travel.short')
    : (marginMinutes > 0 ? 'engine.analysis.travel.okWithMargin' : 'engine.analysis.travel.ok');
  const explanationVars = {
    availableMinutes: msAsMinutesText(pair.gapMs),
    estimateMinutes: minutesText(estimate.minutes),
    requiredMinutes: minutesText(requiredMinutes),
    shortByMinutes: minutesText(shortByMinutes),
    marginMinutes: minutesText(marginMinutes),
    source: estimate.source,
  };
  const confidence: Confidence = lowestConfidence(estimate.confidence, timeConfidence);

  return {
    ...base,
    severity,
    status,
    values: {
      ...commonValues,
      estimateMinutes: estimate.minutes,
      requiredMinutes,
      shortByMinutes: Math.max(0, shortByMinutes),
      estimateSource: estimate.source,
      estimateConfidence: estimate.confidence,
      estimateComputedAt: estimate.computedAt ?? null,
      reason: null,
    },
    explanation,
    explanationKey,
    explanationVars,
    confidence,
  };
}
