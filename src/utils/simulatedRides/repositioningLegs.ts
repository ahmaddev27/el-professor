import { PICKUP_HANDLING_SECONDS } from './geo';
import {
  emptyDriveSeconds,
  isPreferredLeg,
  pickupDriveSeconds,
  safetyMarginSeconds,
  type MarginOptions,
} from './repositioning';
import type { RouteVerificationStatus } from './routeCheck';
import { localHour } from './time';
import { pointKey, type TravelModel } from './travelModel';
import type { GeoPoint, PoolAddress, SimRide, SimShift } from './types';

/**
 * The empty drives of a generated month, as records of their own (external
 * audit round 6: "store B to C internally as REPOSITIONING / LEERFAHRT").
 *
 * A record is derived from the finished rides and the travel model that built
 * them, so it states the drive the generator honoured — not a second guess.
 * It is never a ride: it carries no fare, no passenger and no Fahrtenbuch row,
 * and the passenger sheet never shows it. It lives in the operational report.
 *
 * Per shift:
 *
 * - `from_base`: the Betriebssitz to the first Abholort, leaving when the shift
 *   starts.
 * - `to_pickup`: the previous Zielort to the next Abholort, when the order
 *   reached the car during the previous ride.
 * - `to_waiting_position` then `to_pickup`: when the order came after the
 *   previous ride ended, the car first drove to where it waited (the column
 *   "Standort des Fahrzeugs bei Auftragsuebermittlung"), then on to the
 *   Abholort once the order came. A car that waited where it had dropped its
 *   passenger drove nowhere, so that first leg is left out rather than
 *   recorded as a drive of zero.
 *
 * The status is the route check's vocabulary: a leg the model has no route for
 * is UNVERIFIABLE, never zero and never a pass; a leg of the straight-line
 * estimate is ESTIMATE_ONLY whatever its numbers say.
 */

export type RepositioningPurpose = 'from_base' | 'to_waiting_position' | 'to_pickup';

export interface LegPlace { label: string; lat: number; lon: number }

export interface RepositioningLeg {
  legId: string;
  kind: 'REPOSITIONING';
  label: 'LEERFAHRT';
  purpose: RepositioningPurpose;
  tenantId: string | null;
  /** The vehicle's UUID, when the input carried one. */
  vehicleId: string | null;
  plate: string;
  /** The driver's UUID. The assignment is the simulation's own, never a confirmed real one. */
  driverId: string | null;
  driverName: string;
  driverAssignment: 'simulated';
  shiftId: string;
  /** Null for the drive out of the base. */
  previousTripId: string | null;
  nextTripId: string;
  from: LegPlace;
  to: LegPlace;
  departMs: number;
  /** Departure plus road time; null when there is no route. */
  arriveMs: number | null;
  /** The time between departure and the moment the leg must be done by: the order (waiting position) or the ride's start (pickup). */
  availableSeconds: number;
  roadSeconds: number | null;
  roadKm: number | null;
  /** 45 s to find and seat the customer, on a leg that ends at a pickup; 0 otherwise. */
  handlingSeconds: number;
  safetyMarginSeconds: number | null;
  /** Road time, handling and margin. Null when there is no route. */
  requiredSeconds: number | null;
  slackSeconds: number | null;
  /** Whether the road time lies in the preferred two-to-five-minute window. Null when there is no route. */
  preferredWindow: boolean | null;
  routingSource: string;
  verificationStatus: RouteVerificationStatus;
  dataKind: 'SIMULATED';
  seed: number;
  runId: string;
}

export interface LegContext {
  base: GeoPoint;
  baseLabel: string;
  travel: TravelModel;
  margins: MarginOptions;
  tenantId: string | null;
  vehicleIdByPlate: ReadonlyMap<string, string>;
  seed: number;
  runId: string;
}

const placeOf = (p: GeoPoint, fallback: string): LegPlace => ({
  label: (p as Partial<PoolAddress>).label ?? fallback,
  lat: p.lat,
  lon: p.lon,
});

function statusOf(travel: TravelModel, slack: number | null): RouteVerificationStatus {
  if (!travel.measured) return 'ESTIMATE_ONLY';
  if (slack === null) return 'UNVERIFIABLE';
  return slack >= 0 ? 'ROUTE_VERIFIED' : 'ROUTE_CONFLICT';
}

interface LegSpec {
  purpose: RepositioningPurpose;
  shift: SimShift;
  previous: SimRide | null;
  next: SimRide;
  from: LegPlace;
  to: LegPlace;
  departMs: number;
  /** The moment the leg must be done by, handling included. */
  dueMs: number;
  /** The instant whose hour the drive is asked at: the generator asks both legs after a ride at that ride's end. */
  hourMs: number;
}

function legOf(spec: LegSpec, ctx: LegContext, n: number): RepositioningLeg {
  const endsAtPickup = spec.purpose !== 'to_waiting_position';
  const same = pointKey(spec.from) === pointKey(spec.to);
  const road = same ? { seconds: 0, km: 0 } : ctx.travel.drive(spec.from, spec.to, localHour(spec.hourMs));
  const usable = road !== null && Number.isFinite(road.seconds) && road.seconds >= 0 && Number.isFinite(road.km) && road.km >= 0;
  const availableSeconds = Math.round((spec.dueMs - spec.departMs) / 1000);
  const required = usable
    ? (endsAtPickup ? pickupDriveSeconds(road.seconds, ctx.margins) : emptyDriveSeconds(road.seconds, ctx.margins))
    : null;
  const slack = required === null ? null : availableSeconds - required;
  return {
    legId: `${ctx.runId}-L${String(n).padStart(5, '0')}`,
    kind: 'REPOSITIONING',
    label: 'LEERFAHRT',
    purpose: spec.purpose,
    tenantId: ctx.tenantId,
    vehicleId: ctx.vehicleIdByPlate.get(spec.shift.vehicle.plate) ?? null,
    plate: spec.shift.vehicle.plate,
    driverId: spec.shift.driver.id ?? null,
    driverName: spec.shift.driver.name,
    driverAssignment: 'simulated',
    shiftId: spec.shift.id,
    previousTripId: spec.previous?.tripId ?? null,
    nextTripId: spec.next.tripId ?? '',
    from: spec.from,
    to: spec.to,
    departMs: spec.departMs,
    arriveMs: usable ? spec.departMs + road.seconds * 1000 : null,
    availableSeconds,
    roadSeconds: usable ? road.seconds : null,
    roadKm: usable ? road.km : null,
    handlingSeconds: endsAtPickup ? PICKUP_HANDLING_SECONDS : 0,
    safetyMarginSeconds: usable ? safetyMarginSeconds(road.seconds, ctx.margins) : null,
    requiredSeconds: required,
    slackSeconds: slack,
    preferredWindow: usable ? isPreferredLeg(road.seconds) : null,
    routingSource: ctx.travel.source,
    verificationStatus: statusOf(ctx.travel, slack),
    dataKind: 'SIMULATED',
    seed: ctx.seed,
    runId: ctx.runId,
  };
}

/** Every empty drive of the month, shift by shift in start order. */
export function buildRepositioningLegs(
  shifts: readonly SimShift[],
  rides: readonly SimRide[],
  ctx: LegContext,
): RepositioningLeg[] {
  const byShift = new Map<string, SimRide[]>();
  for (const r of rides) {
    if (r.status !== 'completed' || r.startMs === null || r.endMs === null) continue;
    byShift.set(r.shiftId, [...(byShift.get(r.shiftId) ?? []), r]);
  }
  const specs: LegSpec[] = [];
  for (const shift of [...shifts].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))) {
    const list = (byShift.get(shift.id) ?? []).sort((a, b) => (a.startMs as number) - (b.startMs as number));
    if (list.length === 0) continue;
    specs.push({
      purpose: 'from_base', shift, previous: null, next: list[0],
      from: placeOf(ctx.base, ctx.baseLabel), to: placeOf(list[0].pickup, 'Abholort'),
      departMs: shift.startMs, dueMs: list[0].startMs as number, hourMs: shift.startMs,
    });
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const next = list[i];
      const prevEnd = prev.endMs as number;
      const dropoff = placeOf(prev.dropoff, 'Zielort');
      const pickup = placeOf(next.pickup, 'Abholort');
      if (next.orderTransmittedMs < prevEnd) {
        specs.push({ purpose: 'to_pickup', shift, previous: prev, next, from: dropoff, to: pickup, departMs: prevEnd, dueMs: next.startMs as number, hourMs: prevEnd });
        continue;
      }
      const waiting = placeOf(next.vehiclePosition, 'Standort bei Auftragsuebermittlung');
      if (pointKey(waiting) !== pointKey(dropoff)) {
        specs.push({ purpose: 'to_waiting_position', shift, previous: prev, next, from: dropoff, to: waiting, departMs: prevEnd, dueMs: next.orderTransmittedMs, hourMs: prevEnd });
      }
      specs.push({ purpose: 'to_pickup', shift, previous: prev, next, from: waiting, to: pickup, departMs: next.orderTransmittedMs, dueMs: next.startMs as number, hourMs: prevEnd });
    }
  }
  return specs.map((spec, i) => legOf(spec, ctx, i + 1));
}

export interface RepositioningSummary {
  legs: number;
  byStatus: Record<RouteVerificationStatus, number>;
  byPurpose: Record<RepositioningPurpose, number>;
  /** Legs with a road time inside the preferred two-to-five-minute window. */
  preferredWindow: number;
  /** Legs with a road time, all of them: the denominator of the share above. */
  withRoute: number;
  roadKm: number;
  roadSeconds: number;
  /** The longest road time of any leg, seconds; null when none has a route. */
  longestSeconds: number | null;
}

export function summariseRepositioning(legs: readonly RepositioningLeg[]): RepositioningSummary {
  const byStatus: Record<RouteVerificationStatus, number> = { ROUTE_VERIFIED: 0, ROUTE_CONFLICT: 0, UNVERIFIABLE: 0, ESTIMATE_ONLY: 0 };
  const byPurpose: Record<RepositioningPurpose, number> = { from_base: 0, to_waiting_position: 0, to_pickup: 0 };
  let preferredWindow = 0;
  let withRoute = 0;
  let metres = 0;
  let roadSeconds = 0;
  let longestSeconds: number | null = null;
  for (const leg of legs) {
    byStatus[leg.verificationStatus] += 1;
    byPurpose[leg.purpose] += 1;
    if (leg.roadSeconds === null) continue;
    withRoute += 1;
    if (leg.preferredWindow) preferredWindow += 1;
    metres += Math.round((leg.roadKm ?? 0) * 1000);
    roadSeconds += leg.roadSeconds;
    longestSeconds = Math.max(longestSeconds ?? 0, leg.roadSeconds);
  }
  return { legs: legs.length, byStatus, byPurpose, preferredWindow, withRoute, roadKm: metres / 1000, roadSeconds, longestSeconds };
}
