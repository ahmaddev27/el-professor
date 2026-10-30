import { DEFAULT_OPTIONS } from './generator';
import { pickupDriveSeconds, safetyMarginSeconds, type MarginOptions } from './repositioning';
import { localHour } from './time';
import type { TravelModel } from './travelModel';
import type { SimRide } from './types';

/**
 * The route check of a generated month, read back from its rides (external
 * audit round 4, FB-R4-WARN-ROUTE-001; statuses of round 6).
 *
 * It is the auditor's own question, asked of our output: for two consecutive
 * completed rides of one vehicle — and, separately, of one driver — is the time
 * between the first one's end and the second one's start at least the drive
 * from the first one's Zielort to the second one's Abholort, with the customer
 * found and the safety margin on top?
 *
 * ## The four statuses, and why "fits the estimate" is none of them
 *
 * - `ROUTE_VERIFIED` — a routing service measured the drive and the gap holds
 *   it with its margin.
 * - `ROUTE_CONFLICT` — a routing service measured the drive and the gap does
 *   not hold it.
 * - `UNVERIFIABLE` — a routing service was asked and has no route for the
 *   pair. Never a pass and never a zero.
 * - `ESTIMATE_ONLY` — no routing service was asked; the drive is the straight
 *   line times 1.3. Whether the estimate fits is recorded beside it
 *   (`estimateFits`), but the pair is **not** verified, and a month of these
 *   is not a month with "0 warnings". Round 6 says so in as many words: a
 *   generation without route calculation is for a quick experiment.
 *
 * Identical address text is reported as such (`sameAddress`): the car is
 * where it is, so the drive is zero, but the label says nothing about where a
 * car really was — the round-4 auditor asked for it to be named.
 *
 * Asked with the model the month was built with, every pair of one shift must
 * be verified: the generator refuses a candidate whose gap is short, so a
 * conflict here is a generator defect. The independent check is a second
 * engine reading the finished file (`scripts/fleetbook-route-check.mts`).
 */

export type RouteVerificationStatus = 'ROUTE_VERIFIED' | 'ROUTE_CONFLICT' | 'UNVERIFIABLE' | 'ESTIMATE_ONLY';

export const ROUTE_STATUSES: readonly RouteVerificationStatus[] = ['ROUTE_VERIFIED', 'ROUTE_CONFLICT', 'UNVERIFIABLE', 'ESTIMATE_ONLY'];

export interface RouteCheck {
  grouping: 'vehicle' | 'driver';
  /** The plate, or the driver's id (the name is not an identity). */
  groupKey: string;
  /** Human label: the plate, or the driver's name. */
  groupLabel: string;
  /** The rides' stable ids (`SimRide.tripId`); the 1-based position in the order list when a ride carries none. */
  prevTripId: string;
  nextTripId: string;
  /** True when the two rides belong to one shift: the gap between them is a repositioning the generator scheduled. */
  sameShift: boolean;
  prevEndMs: number;
  nextStartMs: number;
  availableSeconds: number;
  /** The drive from the earlier Zielort to the later Abholort, no handling time; null when no route. */
  roadSeconds: number | null;
  roadKm: number | null;
  /** The safety margin on that drive; null when no route. */
  safetyMarginSeconds: number | null;
  /** Road time, handling and margin: what the gap must hold. Null when no route. */
  requiredSeconds: number | null;
  /** available − required; null when no route. */
  slackSeconds: number | null;
  sameAddress: boolean;
  status: RouteVerificationStatus;
  /** For ESTIMATE_ONLY: whether the estimate fits. Null otherwise. */
  estimateFits: boolean | null;
  /** German, for the workbook. */
  reason: string;
  source: string;
}

interface Indexed { ride: SimRide; id: string }

function pairsOf(list: readonly Indexed[]): [Indexed, Indexed][] {
  const sorted = [...list].sort((a, b) => (a.ride.startMs as number) - (b.ride.startMs as number) || a.id.localeCompare(b.id));
  const out: [Indexed, Indexed][] = [];
  for (let i = 1; i < sorted.length; i++) out.push([sorted[i - 1], sorted[i]]);
  return out;
}

function check(
  grouping: RouteCheck['grouping'],
  groupKey: string,
  groupLabel: string,
  prev: Indexed,
  next: Indexed,
  model: TravelModel,
  margins: MarginOptions,
): RouteCheck {
  const prevEndMs = prev.ride.endMs as number;
  const nextStartMs = next.ride.startMs as number;
  const availableSeconds = Math.round((nextStartMs - prevEndMs) / 1000);
  const sameAddress = prev.ride.dropoff.label === next.ride.pickup.label;
  const base = {
    grouping, groupKey, groupLabel, prevTripId: prev.id, nextTripId: next.id,
    sameShift: prev.ride.shiftId === next.ride.shiftId, prevEndMs, nextStartMs, availableSeconds, sameAddress,
    source: model.source,
  };
  const leg = sameAddress ? { seconds: 0, km: 0 } : model.drive(prev.ride.dropoff, next.ride.pickup, localHour(prevEndMs));
  if (!leg || !Number.isFinite(leg.seconds) || leg.seconds < 0 || !Number.isFinite(leg.km) || leg.km < 0) {
    return {
      ...base, roadSeconds: null, roadKm: null, safetyMarginSeconds: null, requiredSeconds: null, slackSeconds: null,
      status: model.measured ? 'UNVERIFIABLE' : 'ESTIMATE_ONLY', estimateFits: model.measured ? null : false,
      reason: 'Keine Route berechnet - nicht pruefbar',
    };
  }
  const margin = safetyMarginSeconds(leg.seconds, margins);
  const requiredSeconds = pickupDriveSeconds(leg.seconds, margins);
  const slackSeconds = availableSeconds - requiredSeconds;
  const fits = slackSeconds >= 0;
  const values = { roadSeconds: leg.seconds, roadKm: leg.km, safetyMarginSeconds: margin, requiredSeconds, slackSeconds };
  const where = sameAddress ? 'Gleiche Adresse; ' : '';
  if (!model.measured) {
    return {
      ...base, ...values, status: 'ESTIMATE_ONLY', estimateFits: fits,
      reason: `${where}nur Schaetzung (Luftlinie x 1,3), keine Routenberechnung - nicht verifiziert`
        + (fits ? '' : '; selbst die Schaetzung passt nicht in die Luecke'),
    };
  }
  return fits
    ? { ...base, ...values, status: 'ROUTE_VERIFIED', estimateFits: null, reason: `${where}Fahrzeit mit Reserve passt in die Luecke (berechnete Route, kein Nachweis einer Fahrt)` }
    : { ...base, ...values, status: 'ROUTE_CONFLICT', estimateFits: null, reason: `${where}Fahrzeit mit Reserve laenger als die Luecke` };
}

/**
 * Every consecutive pair of completed rides, per vehicle and per driver.
 * `rides` is the month's ride list; a ride without a `tripId` is named by its
 * 1-based position in it.
 */
export function routeChecks(rides: readonly SimRide[], model: TravelModel, margins: MarginOptions = DEFAULT_OPTIONS): RouteCheck[] {
  const indexed = rides.map((ride, i) => ({ ride, id: ride.tripId ?? String(i + 1) }))
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
    for (const [prev, next] of pairsOf(list)) out.push(check('vehicle', plate, plate, prev, next, model, margins));
  }
  for (const [key, { label, list }] of [...byDriver].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [prev, next] of pairsOf(list)) out.push(check('driver', key, label, prev, next, model, margins));
  }
  return out;
}

export interface RouteCheckSummary {
  checks: number;
  /** Distinct (earlier ride, later ride) pairs: a vehicle pair and a driver pair of the same two rides are one. */
  uniquePairs: number;
  byStatus: Record<RouteVerificationStatus, number>;
  /** Conflicts counted once per pair, not once per grouping. */
  uniqueConflicts: number;
  /** Unverifiable pairs counted once per pair. */
  uniqueUnverifiable: number;
  /** Pairs labelled with the same address on both ends. */
  sameAddress: number;
  /** For an estimate-only month: pairs where even the estimate does not fit. */
  estimateMisfits: number;
}

export function summariseRouteChecks(checks: readonly RouteCheck[]): RouteCheckSummary {
  const byStatus: Record<RouteVerificationStatus, number> = { ROUTE_VERIFIED: 0, ROUTE_CONFLICT: 0, UNVERIFIABLE: 0, ESTIMATE_ONLY: 0 };
  for (const c of checks) byStatus[c.status] += 1;
  const pairKey = (c: RouteCheck) => `${c.prevTripId}>${c.nextTripId}`;
  const unique = (status: RouteVerificationStatus) => new Set(checks.filter(c => c.status === status).map(pairKey)).size;
  return {
    checks: checks.length,
    uniquePairs: new Set(checks.map(pairKey)).size,
    byStatus,
    uniqueConflicts: unique('ROUTE_CONFLICT'),
    uniqueUnverifiable: unique('UNVERIFIABLE'),
    sameAddress: checks.filter(c => c.sameAddress).length,
    estimateMisfits: checks.filter(c => c.estimateFits === false).length,
  };
}
