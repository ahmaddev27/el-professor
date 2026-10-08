/**
 * The checks themselves. See types.ts for what they are and, above all, what
 * they are not: a list to review, never a verdict.
 *
 * ## How a ride is placed
 *
 * The completed rides of each vehicle are put in time order. A ride's
 * "previous end" is the latest end among the vehicle's earlier rides (a running
 * maximum, as the Fahrtenanalyse's blocks use, so two overlapping rows cannot
 * make the vehicle look free while it was still driving). A ride that starts
 * more than `blockGapMinutes` after that is the start of a block.
 *
 *   - Inside a block, the order time decides first: transmitted before the
 *     previous end → `during_previous`, whatever the position. After it, the
 *     position decides: within the radius → `at_base`, outside → `away_from_base`.
 *   - At a block start there is no previous ride to follow, so only the position
 *     counts: a vehicle that has been idle that long should be at its base.
 *
 * Whatever a decision needs and the row does not carry makes the ride
 * `unverifiable` with the reason, never a guess: no base entered, no position,
 * no order time.
 */
import { compareIds } from '../tripAnalysis/intervals';
import { distanceKm } from './geo';
import {
  RETURN_CHECK_ALGORITHM_VERSION,
  type AnomalyType,
  type BaseSuggestion,
  type CheckRide,
  type LatLon,
  type OrderCheck,
  type OrderPlacement,
  type ReturnCheckResult,
  type ReturnCheckSettings,
  type RideAnomaly,
  type UnverifiableReason,
} from './types';

const MINUTE_MS = 60_000;

export const DEFAULT_RETURN_CHECK_SETTINGS: Omit<ReturnCheckSettings, 'base' | 'blockGapMinutes'> = {
  baseRadiusKm: 2,
  maxSpeedKmh: 130,
};

/** A completed ride shorter than this with 0 km is not worth a finding: a pickup cancelled at the door can look like it. */
const ZERO_DISTANCE_MIN_MINUTES = 3;
/** An order transmitted up to a minute after the start is clock skew between two systems, not a finding. */
const ORDER_AFTER_START_TOLERANCE_MS = MINUTE_MS;
/** "Within about a kilometre" for the base proposal. */
const SUGGESTION_RADIUS_KM = 1;

const PLACEMENTS: readonly OrderPlacement[] = [
  'during_previous', 'at_base', 'away_from_base', 'block_start_at_base', 'block_start_away', 'unverifiable',
];
const ANOMALIES: readonly AnomalyType[] = [
  'same_address', 'same_street', 'implausible_speed', 'zero_distance', 'position_invalid', 'order_after_start',
];

interface Timed extends CheckRide {
  readonly vehicle: string;
  readonly startMs: number;
  readonly endMs: number;
}

interface Sequenced {
  readonly ride: Timed;
  readonly previous: Timed | null;
  readonly previousEndMs: number | null;
  readonly blockStart: boolean;
}

function isTimed(ride: CheckRide): ride is Timed {
  return (
    ride.status === 'completed' &&
    ride.vehicle !== null && ride.vehicle.trim() !== '' &&
    ride.startMs !== null && ride.endMs !== null && ride.endMs >= ride.startMs
  );
}

/** The completed, timed rides of every vehicle in time order, each with what came before it. */
function sequence(rides: readonly CheckRide[], blockGapMinutes: number): Sequenced[] {
  const byVehicle = new Map<string, Timed[]>();
  for (const ride of rides) {
    if (!isTimed(ride)) continue;
    const vehicle = ride.vehicle.trim();
    const list = byVehicle.get(vehicle);
    const timed = { ...ride, vehicle };
    if (list) list.push(timed);
    else byVehicle.set(vehicle, [timed]);
  }
  const out: Sequenced[] = [];
  for (const vehicle of [...byVehicle.keys()].sort(compareIds)) {
    const list = (byVehicle.get(vehicle) as Timed[]).sort((a, b) => a.startMs - b.startMs || compareIds(a.id, b.id));
    let latest: Timed | null = null;
    for (const ride of list) {
      const previousEndMs = latest ? latest.endMs : null;
      const blockStart = previousEndMs === null || ride.startMs - previousEndMs > blockGapMinutes * MINUTE_MS;
      out.push({ ride, previous: latest, previousEndMs, blockStart });
      if (!latest || ride.endMs > latest.endMs) latest = ride;
    }
  }
  return out;
}

function validLatLon(p: LatLon | null): boolean {
  return p === null || (Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
}

function settingsValid(s: ReturnCheckSettings): boolean {
  return (
    validLatLon(s.base) &&
    Number.isFinite(s.baseRadiusKm) && s.baseRadiusKm > 0 &&
    Number.isFinite(s.blockGapMinutes) && s.blockGapMinutes >= 0 &&
    Number.isFinite(s.maxSpeedKmh) && s.maxSpeedKmh > 0
  );
}

function place(entry: Sequenced, settings: ReturnCheckSettings): { placement: OrderPlacement; reason: UnverifiableReason | null } {
  const { ride, previousEndMs, blockStart } = entry;
  const near = (): boolean | UnverifiableReason => {
    if (!settings.base) return 'no_base';
    if (!ride.position || ride.positionProblem) return 'no_position';
    return distanceKm(ride.position, settings.base) <= settings.baseRadiusKm;
  };
  if (blockStart) {
    const atBase = near();
    if (typeof atBase === 'string') return { placement: 'unverifiable', reason: atBase };
    return { placement: atBase ? 'block_start_at_base' : 'block_start_away', reason: null };
  }
  if (ride.orderMs === null) return { placement: 'unverifiable', reason: 'no_order_time' };
  if (ride.orderMs <= (previousEndMs as number)) return { placement: 'during_previous', reason: null };
  const atBase = near();
  if (typeof atBase === 'string') return { placement: 'unverifiable', reason: atBase };
  return { placement: atBase ? 'at_base' : 'away_from_base', reason: null };
}

function anomaliesOf(ride: CheckRide, settings: ReturnCheckSettings): RideAnomaly[] {
  if (ride.status !== 'completed') return [];
  const found: RideAnomaly[] = [];
  const add = (type: AnomalyType, values: RideAnomaly['values'] = {}) => found.push({ rideId: ride.id, type, values });

  const { pickup, dropoff } = ride;
  const sameStreetAndNumber =
    pickup?.street != null && pickup.houseNumber !== null && pickup.postalCode !== null &&
    pickup.street === dropoff?.street && pickup.houseNumber === dropoff.houseNumber && pickup.postalCode === dropoff.postalCode;
  // A place name in front ("Hbf, Bahnhofstr. 1, …") must not hide that both ends are one address.
  if (pickup && dropoff && ((pickup.normalized !== '' && pickup.normalized === dropoff.normalized) || sameStreetAndNumber)) {
    add('same_address');
  } else if (
    pickup?.street && dropoff?.street && pickup.street === dropoff.street &&
    pickup.houseNumber && dropoff.houseNumber && pickup.houseNumber !== dropoff.houseNumber &&
    pickup.postalCode !== null && pickup.postalCode === dropoff.postalCode
  ) {
    add('same_street', { from: pickup.houseNumber, to: dropoff.houseNumber });
  }

  const minutes = ride.startMs !== null && ride.endMs !== null && ride.endMs >= ride.startMs
    ? (ride.endMs - ride.startMs) / MINUTE_MS
    : null;
  if (ride.km !== null && minutes !== null) {
    if (ride.km > 0 && minutes > 0) {
      const speed = ride.km / (minutes / 60);
      if (speed > settings.maxSpeedKmh) add('implausible_speed', { km: ride.km, minutes, speedKmh: Math.round(speed) });
    } else if (ride.km > 0 && minutes === 0) {
      add('implausible_speed', { km: ride.km, minutes, speedKmh: null });
    } else if (ride.km === 0 && minutes >= ZERO_DISTANCE_MIN_MINUTES) {
      add('zero_distance', { minutes });
    }
  }

  if (ride.positionProblem) add('position_invalid', { problem: ride.positionProblem });

  if (ride.orderMs !== null && ride.startMs !== null && ride.orderMs > ride.startMs + ORDER_AFTER_START_TOLERANCE_MS) {
    add('order_after_start', { minutes: Math.round((ride.orderMs - ride.startMs) / MINUTE_MS) });
  }
  return found;
}

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map(key => [key, 0])) as Record<K, number>;
}

export function runReturnCheck(rides: readonly CheckRide[], settings: ReturnCheckSettings): ReturnCheckResult {
  const base = {
    algorithmVersion: RETURN_CHECK_ALGORITHM_VERSION,
    settings,
    rides: rides.length,
  };
  if (!settingsValid(settings)) {
    return {
      ...base,
      status: 'invalid_settings',
      checkedRides: 0,
      orders: [],
      anomalies: [],
      counts: { byPlacement: zeroCounts(PLACEMENTS), byAnomaly: zeroCounts(ANOMALIES) },
    };
  }

  const byPlacement = zeroCounts(PLACEMENTS);
  const orders: OrderCheck[] = sequence(rides, settings.blockGapMinutes).map(entry => {
    const { ride, previous, previousEndMs } = entry;
    const { placement, reason } = place(entry, settings);
    byPlacement[placement] += 1;
    const previousCode = previous?.dropoff?.postalCode ?? null;
    const pickupCode = ride.pickup?.postalCode ?? null;
    return {
      rideId: ride.id,
      vehicle: ride.vehicle,
      previousRideId: previous?.id ?? null,
      placement,
      reason,
      waitMinutes:
        ride.orderMs !== null && previousEndMs !== null ? Math.round((ride.orderMs - previousEndMs) / MINUTE_MS) : null,
      distanceKm:
        settings.base && ride.position && !ride.positionProblem
          ? Math.round(distanceKm(ride.position, settings.base) * 10) / 10
          : null,
      prebooked: ride.prebooked,
      samePostalCodeAsPreviousDestination:
        previousCode !== null && pickupCode !== null ? previousCode === pickupCode : null,
      orderMs: ride.orderMs,
      previousEndMs,
    };
  });

  /*
   * A completed ride the sequence cannot hold — no vehicle, no start or end, or
   * an end before its start — is still a ride the operator should know was not
   * checked. Leaving it out of `orders` made it vanish from every count.
   */
  for (const ride of rides) {
    if (ride.status !== 'completed' || isTimed(ride)) continue;
    byPlacement.unverifiable += 1;
    orders.push({
      rideId: ride.id,
      vehicle: ride.vehicle?.trim() ?? '',
      previousRideId: null,
      placement: 'unverifiable',
      reason: 'no_ride_times',
      waitMinutes: null,
      distanceKm: null,
      prebooked: ride.prebooked,
      samePostalCodeAsPreviousDestination: null,
      orderMs: ride.orderMs,
      previousEndMs: null,
    });
  }

  const byAnomaly = zeroCounts(ANOMALIES);
  const anomalies: RideAnomaly[] = [];
  for (const ride of rides) {
    for (const anomaly of anomaliesOf(ride, settings)) {
      byAnomaly[anomaly.type] += 1;
      anomalies.push(anomaly);
    }
  }

  return {
    ...base,
    status: 'ok',
    checkedRides: orders.length,
    orders,
    anomalies,
    counts: { byPlacement, byAnomaly },
  };
}

/**
 * Where the vehicles usually were when a block began — a proposal for the
 * Betriebssitz, to be confirmed by a person, never used as a fact. Positions
 * are grouped into cells of about a kilometre; the fullest cell wins (ties to
 * the smaller cell key, so the answer is deterministic), and the proposal is
 * the mean of the starts within a kilometre of that cell's centre.
 */
export function suggestBase(rides: readonly CheckRide[], blockGapMinutes: number): BaseSuggestion | null {
  const starts = sequence(rides, blockGapMinutes)
    .filter(entry => entry.blockStart && entry.ride.position && !entry.ride.positionProblem)
    .map(entry => entry.ride.position as LatLon);
  if (starts.length === 0) return null;

  const cells = new Map<string, LatLon[]>();
  for (const p of starts) {
    const key = `${Math.floor(p.lat / 0.01)}|${Math.floor(p.lon / 0.015)}`;
    const list = cells.get(key);
    if (list) list.push(p);
    else cells.set(key, [p]);
  }
  const [, fullest] = [...cells.entries()].sort((a, b) => b[1].length - a[1].length || compareIds(a[0], b[0]))[0];
  const centre = mean(fullest);
  const near = starts.filter(p => distanceKm(p, centre) <= SUGGESTION_RADIUS_KM);
  // The cell's own points are within its diagonal of the centre; this only guards the mean against an empty set.
  const counted = near.length > 0 ? near : fullest;
  return { position: mean(counted), blockStarts: counted.length, ofBlockStarts: starts.length };
}

function mean(points: readonly LatLon[]): LatLon {
  const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const lon = points.reduce((sum, p) => sum + p.lon, 0) / points.length;
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}
