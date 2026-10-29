import { localHour } from './time';
import type { TravelModel } from './travelModel';
import type { SimRide } from './types';

/**
 * The route check of a generated month, read back from its rides (external
 * audit round 4, FB-R4-WARN-ROUTE-001).
 *
 * It is the auditor's own question, asked of our output: for two consecutive
 * completed rides of one vehicle — and, separately, of one driver — is the time
 * between the first one's end and the second one's start at least the drive
 * from the first one's Zielort to the second one's Abholort?
 *
 * ## What this proves, and what it does not
 *
 * Asked with the model the month was built with, every pair the generator
 * produced must fit, so a `route_time_warning` here is a generator defect.
 * That is a self-check and it is labelled as one: the workbook prints the
 * model's source beside every row. The independent check is a second engine
 * reading the finished file (`scripts/fleetbook-route-check.mts`), and two
 * engines disagree; a pair that fits one and not the other is a finding about
 * the engines, which is why the source is never dropped from a row.
 *
 * A pair the model has no route for is `unverifiable`, never a pass and never
 * a zero. Identical address text is `same_address`, as in the audit: it says
 * nothing about where the car really was.
 */

export type RouteCheckStatus = 'route_fits' | 'same_address' | 'route_time_warning' | 'unverifiable';

export interface RouteCheck {
  grouping: 'vehicle' | 'driver';
  /** The plate, or the driver's id (the name is not an identity). */
  groupKey: string;
  /** Human label: the plate, or the driver's name. */
  groupLabel: string;
  /** 1-based position of the earlier ride in the month's ride list (sheet A's `Nr`). */
  prevNr: number;
  nextNr: number;
  prevEndMs: number;
  nextStartMs: number;
  availableSeconds: number;
  /** The drive from the earlier Zielort to the later Abholort, no handling time; null when no route. */
  roadSeconds: number | null;
  roadKm: number | null;
  /** available − road; null when no route. */
  marginSeconds: number | null;
  status: RouteCheckStatus;
  /** German, for the workbook. */
  reason: string;
  source: string;
}

interface Indexed { ride: SimRide; nr: number }

function pairsOf(list: readonly Indexed[]): [Indexed, Indexed][] {
  const sorted = [...list].sort((a, b) => (a.ride.startMs as number) - (b.ride.startMs as number) || a.nr - b.nr);
  const out: [Indexed, Indexed][] = [];
  for (let i = 1; i < sorted.length; i++) out.push([sorted[i - 1], sorted[i]]);
  return out;
}

function check(grouping: RouteCheck['grouping'], groupKey: string, groupLabel: string, prev: Indexed, next: Indexed, model: TravelModel): RouteCheck {
  const prevEndMs = prev.ride.endMs as number;
  const nextStartMs = next.ride.startMs as number;
  const availableSeconds = Math.round((nextStartMs - prevEndMs) / 1000);
  const base = { grouping, groupKey, groupLabel, prevNr: prev.nr, nextNr: next.nr, prevEndMs, nextStartMs, availableSeconds, source: model.source };
  if (prev.ride.dropoff.label === next.ride.pickup.label) {
    return { ...base, roadSeconds: 0, roadKm: 0, marginSeconds: availableSeconds, status: 'same_address', reason: 'Gleiche Adresse - belegt keine Fahrzeugposition' };
  }
  const leg = model.drive(prev.ride.dropoff, next.ride.pickup, localHour(prevEndMs));
  if (!leg || !Number.isFinite(leg.seconds) || leg.seconds < 0) {
    return { ...base, roadSeconds: null, roadKm: null, marginSeconds: null, status: 'unverifiable', reason: 'Keine Route berechnet - nicht prüfbar' };
  }
  const marginSeconds = availableSeconds - leg.seconds;
  return marginSeconds >= 0
    ? { ...base, roadSeconds: leg.seconds, roadKm: leg.km, marginSeconds, status: 'route_fits', reason: 'Fahrzeit passt in die Lücke (Schätzung, kein Nachweis einer Fahrt)' }
    : { ...base, roadSeconds: leg.seconds, roadKm: leg.km, marginSeconds, status: 'route_time_warning', reason: 'Fahrzeit länger als die Lücke' };
}

/**
 * Every consecutive pair of completed rides, per vehicle and per driver.
 * `rides` is the month's ride list in sheet order; the `Nr` of a ride is its
 * position there.
 */
export function routeChecks(rides: readonly SimRide[], model: TravelModel): RouteCheck[] {
  const indexed = rides.map((ride, i) => ({ ride, nr: i + 1 }))
    .filter(x => x.ride.status === 'completed' && x.ride.startMs !== null && x.ride.endMs !== null);
  const out: RouteCheck[] = [];
  const byVehicle = new Map<string, Indexed[]>();
  const byDriver = new Map<string, { label: string; list: Indexed[] }>();
  for (const x of indexed) {
    byVehicle.set(x.ride.vehicle.plate, [...(byVehicle.get(x.ride.vehicle.plate) ?? []), x]);
    const key = x.ride.driver.id ?? `name:${x.ride.driver.name}`;
    const entry = byDriver.get(key) ?? { label: x.ride.driver.name, list: [] };
    entry.list.push(x);
    byDriver.set(key, entry);
  }
  for (const [plate, list] of [...byVehicle].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [prev, next] of pairsOf(list)) out.push(check('vehicle', plate, plate, prev, next, model));
  }
  for (const [key, { label, list }] of [...byDriver].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [prev, next] of pairsOf(list)) out.push(check('driver', key, label, prev, next, model));
  }
  return out;
}

export interface RouteCheckSummary {
  checks: number;
  /** Distinct (earlier ride, later ride) pairs: a vehicle pair and a driver pair of the same two rides are one. */
  uniquePairs: number;
  byStatus: Record<RouteCheckStatus, number>;
  /** Warnings counted once per pair, not once per grouping. */
  uniqueWarnings: number;
}

export function summariseRouteChecks(checks: readonly RouteCheck[]): RouteCheckSummary {
  const byStatus: Record<RouteCheckStatus, number> = { route_fits: 0, same_address: 0, route_time_warning: 0, unverifiable: 0 };
  for (const c of checks) byStatus[c.status] += 1;
  const pairKey = (c: RouteCheck) => `${c.prevNr}>${c.nextNr}`;
  return {
    checks: checks.length,
    uniquePairs: new Set(checks.map(pairKey)).size,
    byStatus,
    uniqueWarnings: new Set(checks.filter(c => c.status === 'route_time_warning').map(pairKey)).size,
  };
}
