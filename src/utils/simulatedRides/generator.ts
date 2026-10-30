import type { Rng } from './rng';
import { PICKUP_HANDLING_SECONDS, interpolate, roadKm } from './geo';
import { isUniqueWallTime, localHour } from './time';
import { emptyDriveSeconds, isPreferredLeg, pickupDriveSeconds, type MarginOptions } from './repositioning';
import { ESTIMATE_TRAVEL_MODEL, type TravelLeg, type TravelModel } from './travelModel';
import type { GeneratedMonth, GeneratorOptions, GeoPoint, PoolAddress, SimDriver, SimRide, SimShift, SimVehicle } from './types';

/**
 * The time between two rides of one vehicle, and why it is never a row.
 *
 * A ride row is not the whole journey. Per ride the car does three things:
 *
 *   A  where it stood when the order arrived (column "Standort des Fahrzeugs
 *      bei Auftragsuebermittlung")
 *      |  the approach to the pickup: NOT a row, NOT billed, NOT in Kilometer
 *   B  Abholort, the passenger gets in
 *      |  the ride: this is Kilometer and Fahrpreis
 *   C  Zielort
 *
 * The rule that keeps the file physically possible is a constraint on TIME:
 *
 *   gap between two rides >= travel( previous Zielort -> new Standort -> new Abholort )
 *
 * Two legs. The first version honoured at most one and put the Standort on
 * the way, so 49 % of a month's transitions implied more than 120 km/h against
 * 6 % in a real export. The gap now also holds the wait for the order, which a
 * real car spends parked or cruising: the real median gap is 12.6 minutes, the
 * generator's used to be 2. An order that reaches the car while it still
 * carries the previous passenger (a third of the real ones, lawful under
 * Paragraph 49 Abs. 4 PBefG) has its Standort on that ride's route, and then
 * only the drive from the Zielort to the Abholort remains.
 *
 * The approach is deliberately NOT stored as a ride row. A row would put a
 * journey that carried no passenger into the Fahrtenbuch, whose 18 columns
 * describe passenger rides, and it would enter the counts without a fare and
 * break the cent-exact match of the fares to umsatz, bargeld and trinkgeld.
 * The approach's distance shows up only as the gap, exactly as in the real
 * file. Do not "fix" a short gap by adding rows.
 *
 * Not zero impossible transitions either: the real export has 6 % over
 * 120 km/h (its maximum is 31021 km/h, real files contain nonsense), and a
 * generator without any would be a tell. The spread of the waits aims at that
 * rate, no lower; `approachLeg.test.ts` measures it.
 */
export const DEFAULT_OPTIONS: GeneratorOptions = {
  minShiftMinutes: 270,
  maxShiftMinutes: 360,
  minVehicleGapMinutes: 60,
  minDriverRestMinutes: 11 * 60,
  cancellationShare: 0.02,
  tipShare: 0.12,
  appPaymentShare: 0.69,
  prebookedShare: 0.03,
  repositioningMarginSeconds: 60,
  repositioningMarginPercent: 15,
};

/** The hard limits, restated for the validator: a shift is 4 to 6 hours, at most 3 per vehicle and day. */
export const SHIFT_LIMITS = { minMinutes: 240, maxMinutes: 360, maxPerVehicleDay: 3 } as const;

const MIN_RIDE_BUDGET_SECONDS = 8 * 60;
const CANCELLATION_FEES = [6, 7.2, 7.5] as const;
const TIP_AMOUNTS = [1, 1.5, 2, 3, 5] as const;

export interface PlannedShift { vehicle: SimVehicle; startMs: number; plannedEndMs: number; operatingDay: string }

export interface Context {
  rng: Rng;
  opts: GeneratorOptions;
  base: GeoPoint;
  pool: readonly PoolAddress[];
  usedTransmits: Set<number>;
  /**
   * Where every drive time comes from (`travelModel.ts`). Absent means the
   * labelled estimate, which is today's model unchanged. With a measured
   * model the pool must be the routed points, and a pair without a route is
   * never used.
   */
  travel?: TravelModel;
}

export const travelOf = (ctx: Context): TravelModel => ctx.travel ?? ESTIMATE_TRAVEL_MODEL;

/** An empty drive with the customer found at the end: the one definition of "time to the pickup". */
export function approachSeconds(leg: TravelLeg): number {
  return leg.seconds + PICKUP_HANDLING_SECONDS;
}

export interface ShiftOwner { shiftId: string; vehicle: SimVehicle; driver: SimDriver }

/** Why the ride loop of a shift stopped: the window ran out, or a choice found nothing. */
export type ShiftEnd = 'no_approach' | 'no_budget' | 'no_dropoff';

export interface ShiftRun {
  rides: SimRide[];
  endMs: number;
  /** What the last try found when the shift stopped. */
  endedBy: ShiftEnd;
  /** Every try of a step that found nothing, by what it found: the shift's own rejection log. */
  refusedSteps: Partial<Record<ShiftEnd, number>>;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function nearest(pool: readonly PoolAddress[], to: GeoPoint, count: number): PoolAddress[] {
  return pool
    .map(a => ({ a, d: roadKm(to, a) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, count)
    .map(x => x.a);
}

/** How far afield a pickup is looked for: the nearest few, and a wider ring for the preferred window. */
const NEAR_PICKUPS = 8;
const PREFERRED_SEARCH = 16;

/**
 * A pickup near `from` that the model can drive to, with the drive. Null when
 * none of the near addresses has a route: the caller then draws again or ends
 * the shift rather than invent a drive.
 *
 * Round 6 asks for repositioning legs of two to five minutes where the pool
 * allows them. That is a preference over real candidates: among the nearest
 * sixteen with a route, those whose drive falls inside the window are drawn
 * from; when none does, the nearest eight are, as before. No point is moved
 * and no drive is shortened to land in the window.
 */
function choosePickup(ctx: Context, from: GeoPoint, hour: number): { pickup: PoolAddress; leg: TravelLeg } | null {
  const travel = travelOf(ctx);
  const ring = nearest(ctx.pool, from, PREFERRED_SEARCH)
    .map(pickup => ({ pickup, leg: travel.drive(from, pickup, hour) }))
    .filter((x): x is { pickup: PoolAddress; leg: TravelLeg } => x.leg !== null);
  const preferred = ring.filter(x => isPreferredLeg(x.leg.seconds));
  if (preferred.length > 0) return ctx.rng.pick(preferred);
  const near = ring.slice(0, NEAR_PICKUPS);
  return near.length === 0 ? null : ctx.rng.pick(near);
}

/** A label for a cancelled order, which keeps no clock time and so needs no route. */
function nearbyAddress(ctx: Context, from: GeoPoint): PoolAddress {
  return ctx.rng.pick(nearest(ctx.pool, from, 8));
}

function gaussian(rng: Rng): number {
  const u = Math.max(rng.next(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

const logNormal = (rng: Rng, median: number, sigma: number): number => median * Math.exp(sigma * gaussian(rng));

/** The longest ride of the real export is 95.19 km. */
export const MAX_RIDE_KM = 95;

/**
 * Ride length, log-normal and fitted to the real export's quantiles (median
 * 6.1, p25 3.4, p75 11.0, p95 28.9, mean 9.3 km): the middle is the city, the
 * tail is the airport and the neighbouring town.
 */
export function targetRideKm(rng: Rng): number {
  return Math.min(MAX_RIDE_KM, Math.max(0.8, logNormal(rng, 6.1, 0.873)));
}

const TARGET_TRIES = 8;

/**
 * A drop-off near a wanted length that still fits the time left. A length the
 * pool cannot reach, or the shift cannot hold, is drawn again rather than piled
 * onto the pool's edge or onto the shortest ride; only when every draw fails
 * does the shortest ride that fits close the shift.
 */
function chooseDropoff(
  ctx: Context,
  from: PoolAddress,
  budgetSeconds: number,
  hour: number,
): { dropoff: PoolAddress; leg: TravelLeg } | null {
  const travel = travelOf(ctx);
  const all: { a: PoolAddress; leg: TravelLeg; km: number }[] = [];
  for (const a of ctx.pool) {
    if (a === from) continue;
    const leg = travel.ride(from, a, hour);
    if (leg && leg.km >= 0.6 && leg.km <= MAX_RIDE_KM && leg.seconds <= budgetSeconds) all.push({ a, leg, km: leg.km });
  }
  const picked = (x: (typeof all)[number]) => ({ dropoff: x.a, leg: x.leg });
  for (let i = 0; i < TARGET_TRIES; i++) {
    const target = targetRideKm(ctx.rng);
    const tolerance = Math.max(0.8, target * 0.2);
    const near = all.filter(x => Math.abs(x.km - target) <= tolerance);
    if (near.length === 0) continue;
    return picked(ctx.rng.pick(near.sort((x, y) => Math.abs(x.km - target) - Math.abs(y.km - target)).slice(0, 5)));
  }
  return all.length === 0 ? null : picked(all.reduce((best, x) => (x.km < best.km ? x : best)));
}

interface PrevRide { pickup: PoolAddress; dropoff: PoolAddress; startMs: number; endMs: number }

/** Where a vehicle driving from the pickup to the drop-off is at an instant of its ride. */
function positionDuring(ride: PrevRide, ms: number): GeoPoint {
  const span = ride.endMs - ride.startMs;
  return interpolate(ride.pickup, ride.dropoff, span <= 0 ? 1 : (ms - ride.startMs) / span);
}

function fareFor(rng: Rng, km: number, seconds: number): number {
  const noise = 0.9 + rng.next() * 0.22;
  return round2(Math.max(7, (4 + 1.15 * km + 0.25 * (seconds / 60)) * noise));
}

/** The order time is the key of a ride in the file, so two rides never share one. */
/**
 * A transmission instant no other ride of the month holds.
 *
 * Exported for `fullMonth.ts`, which adds declined orders to a shift and needs
 * the same uniqueness: the instant is part of `source_row_key`, so two rides
 * sharing one would hash to one key and the second would be refused as a
 * duplicate on import.
 */
export function uniqueTransmit(ctx: Context, ms: number): number {
  let t = ms;
  while (ctx.usedTransmits.has(t)) t += 1;
  ctx.usedTransmits.add(t);
  return t;
}

type OrderTimes = Pick<SimRide, 'orderReceivedMs' | 'orderTransmittedMs' | 'plannedPickupMs' | 'prebooked'>;

function orderTimes(ctx: Context, transmitMs: number, startMs: number): OrderTimes {
  const orderTransmittedMs = uniqueTransmit(ctx, transmitMs);
  const prebooked = ctx.rng.chance(ctx.opts.prebookedShare);
  if (!prebooked) {
    return { orderTransmittedMs, orderReceivedMs: Math.floor(orderTransmittedMs / 1000) * 1000, plannedPickupMs: null, prebooked };
  }
  const aheadMs = ctx.rng.int(3 * 3600, 30 * 3600) * 1000;
  return {
    orderTransmittedMs,
    orderReceivedMs: Math.floor((orderTransmittedMs - aheadMs) / 1000) * 1000,
    plannedPickupMs: Math.ceil(startMs / 300_000) * 300_000,
    prebooked,
  };
}

function cancelledRide(ctx: Context, owner: ShiftOwner, at: number, position: GeoPoint): SimRide {
  const pickup = nearbyAddress(ctx, position);
  const dropoff = ctx.rng.pick(ctx.pool);
  const orderTransmittedMs = uniqueTransmit(ctx, at);
  return {
    ...owner,
    status: 'cancelled',
    orderReceivedMs: Math.floor(orderTransmittedMs / 1000) * 1000,
    orderTransmittedMs,
    plannedPickupMs: null,
    startMs: null,
    endMs: null,
    vehiclePosition: position,
    pickup,
    dropoff,
    fare: ctx.rng.pick(CANCELLATION_FEES),
    tip: 0,
    km: 0,
    payment: ctx.rng.chance(ctx.opts.appPaymentShare) ? 'App' : 'Bar',
    prebooked: false,
  };
}

function stampsAreUnique(r: SimRide): boolean {
  return [r.orderReceivedMs, r.orderTransmittedMs, r.plannedPickupMs, r.startMs, r.endMs]
    .every(ms => ms === null || isUniqueWallTime(ms));
}

// ── The time between two rides ──────────────────────────────────────────────

/** A third of the real orders reach the car before its previous passenger is out. */
const DURING_RIDE_SHARE = 0.34;
/** The wait for an order after a ride: median 10 minutes, a long tail, none beyond 100. */
const WAIT_MEDIAN_SECONDS = 540;
const WAIT_SIGMA = 1.5;
const WAIT_MAX_SECONDS = 100 * 60;
/** Slack on top of the drive when the order came during the previous ride. */
const SLACK_MEDIAN_SECONDS = 50;
const SLACK_SIGMA = 1.3;
const SLACK_MAX_SECONDS = 12 * 60;
/** How long before the previous ride's end such an order arrives: median 4.4 minutes. */
const EARLY_MEDIAN_SECONDS = 264;
const EARLY_SIGMA = 0.9;
const STOP_CHOICES = 6;
/** Room kept for the 0 to 40 s of hand-over jitter, so the last ride still gets its full minimum budget. */
const JITTER_MARGIN_MS = 41_000;

/** Where the car stands, when the order arrives, and when the passenger gets in. */
interface Approach { orderPos: GeoPoint; transmitMs: number; pickup: PoolAddress; startMs: number }

const clampSeconds = (value: number, max: number): number => Math.min(max, Math.max(0, Math.round(value)));

/** The first order of a shift is placed the moment it starts, with the car at the base. */
function firstApproach(ctx: Context, plan: PlannedShift): Approach | null {
  const chosen = choosePickup(ctx, ctx.base, localHour(plan.startMs));
  if (!chosen) return null;
  const drive = pickupDriveSeconds(chosen.leg.seconds, ctx.opts);
  return { orderPos: ctx.base, transmitMs: plan.startMs + ctx.rng.int(0, 999), pickup: chosen.pickup, startMs: plan.startMs + drive * 1000 };
}

/** The order arrives on the previous ride's route; what is left is the drive from its Zielort to the Abholort. */
function approachDuringRide(ctx: Context, prev: PrevRide, latestStartMs: number): Approach | null {
  const { rng } = ctx;
  const chosen = choosePickup(ctx, prev.dropoff, localHour(prev.endMs));
  if (!chosen) return null;
  const { pickup } = chosen;
  const drive = pickupDriveSeconds(chosen.leg.seconds, ctx.opts);
  const room = Math.max(0, (latestStartMs - JITTER_MARGIN_MS - prev.endMs) / 1000 - drive);
  const slack = Math.min(clampSeconds(logNormal(rng, SLACK_MEDIAN_SECONDS, SLACK_SIGMA), SLACK_MAX_SECONDS), Math.floor(room)) + rng.int(0, 40);
  // Whole milliseconds. This is the one place a ride instant was ever drawn
  // from a continuous distribution, and it was the whole of FB-HIGH-001: a
  // fractional `early` left `orderTransmittedMs` fractional, and the export
  // wrote `25.441.665771484375` for it. Rounded here, where the value is made,
  // rather than only where it is printed — the printer is the second wall.
  const early = Math.round(logNormal(rng, EARLY_MEDIAN_SECONDS, EARLY_SIGMA) * 1000);
  const transmitMs = Math.max(prev.startMs + 60_000, prev.endMs - early) + rng.int(0, 999);
  return { orderPos: positionDuring(prev, transmitMs), transmitMs, pickup, startMs: prev.endMs + (drive + slack) * 1000 };
}

/**
 * The order arrives after the previous ride ended. The car drives from the
 * Zielort to where it waits (leg one), the order comes, it drives to the
 * Abholort (leg two). The wait is shortened, never the legs, when the shift
 * would otherwise run out.
 *
 * The gap must also hold the direct drive from the Zielort to the Abholort,
 * which is what a route check of the finished file asks: a measured matrix
 * need not obey the triangle inequality, and a pair the model has no direct
 * route for would be unverifiable afterwards, so such a candidate is refused
 * here rather than reported there.
 */
function approachAfterRide(ctx: Context, prev: PrevRide, latestStartMs: number): Approach | null {
  const { rng } = ctx;
  const travel = travelOf(ctx);
  const hour = localHour(prev.endMs);
  const stops = nearest(ctx.pool, prev.dropoff, STOP_CHOICES)
    .map(stop => ({ stop, leg: travel.drive(prev.dropoff, stop, hour) }))
    .filter((x): x is { stop: PoolAddress; leg: TravelLeg } => x.leg !== null);
  if (stops.length === 0) return null;
  const { stop, leg: toStop } = rng.pick(stops);
  const chosen = choosePickup(ctx, stop, hour);
  if (!chosen) return null;
  const { pickup } = chosen;
  const direct = pickup === prev.dropoff ? { seconds: 0, km: 0 } : travel.drive(prev.dropoff, pickup, hour);
  if (!direct) return null;
  const legOne = emptyDriveSeconds(toStop.seconds, ctx.opts);
  const legTwo = pickupDriveSeconds(chosen.leg.seconds, ctx.opts);
  const earliestStart = prev.endMs + Math.max(legOne + legTwo, pickupDriveSeconds(direct.seconds, ctx.opts)) * 1000;
  if (earliestStart + JITTER_MARGIN_MS > latestStartMs) return null;
  const wait = clampSeconds(logNormal(rng, WAIT_MEDIAN_SECONDS, WAIT_SIGMA), WAIT_MAX_SECONDS);
  const waitMs = Math.min(wait * 1000, latestStartMs - JITTER_MARGIN_MS - earliestStart);
  const transmitMs = prev.endMs + legOne * 1000 + waitMs + rng.int(0, 999);
  // The drive to the Abholort starts when the order comes, so it is measured
  // from the transmission, whose sub-second jitter would otherwise eat into it.
  // Rounded up to the second: a ride's start is printed to the second, and a
  // start the sheet truncates would show a gap a second shorter than it was.
  const fromOrder = Math.ceil((transmitMs + legTwo * 1000) / 1000) * 1000;
  const startMs = Math.max(earliestStart + waitMs, fromOrder) + rng.int(0, 40) * 1000;
  return { orderPos: stop, transmitMs, pickup, startMs };
}

function nextApproach(ctx: Context, plan: PlannedShift, prev: PrevRide | null): Approach | null {
  if (prev === null) return firstApproach(ctx, plan);
  const latestStartMs = plan.plannedEndMs - MIN_RIDE_BUDGET_SECONDS * 1000;
  if (ctx.rng.chance(DURING_RIDE_SHARE)) return approachDuringRide(ctx, prev, latestStartMs);
  return approachAfterRide(ctx, prev, latestStartMs);
}

/**
 * How often one step of a shift is drawn again before the shift ends.
 *
 * A step is an approach, a wait and a ride. Until round 6 the first draw that
 * found nothing ended the shift: a long wait clamped to the latest start left
 * a budget no ride from the chosen pickup fitted, and the shift closed with an
 * hour or more of its window unused — and shorter than the 240-minute minimum,
 * which only the read-back noticed (the audit's "S38"). A fresh draw has a
 * fresh wait and a fresh pickup, so the window is used. Bounded, so a window
 * that genuinely holds no further ride ends the shift after a few tries.
 */
export const STEP_TRIES = 6;

/** What one try of a step found, when it found nothing. */
type StepRefusal = ShiftEnd;

/** One shift, rides back to back. Null when any clock reading in it is not unique. */
export function runShift(ctx: Context, plan: PlannedShift, owner: ShiftOwner): ShiftRun | null {
  const { rng, opts } = ctx;
  const rides: SimRide[] = [];
  let prev: PrevRide | null = null;
  let endedBy: ShiftEnd = 'no_approach';
  const refusedSteps: Partial<Record<StepRefusal, number>> = {};

  for (;;) {
    let step: { approach: Approach; chosen: { dropoff: PoolAddress; leg: TravelLeg } } | null = null;
    for (let attempt = 0; attempt < STEP_TRIES && step === null; attempt++) {
      const approach = nextApproach(ctx, plan, prev);
      let refusal: StepRefusal | null = null;
      if (!approach) refusal = 'no_approach';
      else {
        const budget = (plan.plannedEndMs - approach.startMs) / 1000;
        if (budget < MIN_RIDE_BUDGET_SECONDS) refusal = 'no_budget';
        else {
          const chosen = chooseDropoff(ctx, approach.pickup, budget, localHour(approach.startMs));
          if (!chosen) refusal = 'no_dropoff';
          else step = { approach, chosen };
        }
      }
      if (refusal) {
        endedBy = refusal;
        refusedSteps[refusal] = (refusedSteps[refusal] ?? 0) + 1;
      }
    }
    if (step === null) break;
    const { pickup, startMs, orderPos, transmitMs } = step.approach;
    const { dropoff } = step.chosen;
    const km = step.chosen.leg.km;
    const endMs = startMs + step.chosen.leg.seconds * 1000;

    rides.push({
      ...owner,
      status: 'completed',
      ...orderTimes(ctx, transmitMs, startMs),
      startMs,
      endMs,
      vehiclePosition: orderPos,
      pickup,
      dropoff,
      fare: fareFor(rng, km, (endMs - startMs) / 1000),
      tip: rng.chance(opts.tipShare) ? rng.pick(TIP_AMOUNTS) : 0,
      km: round2(km),
      payment: rng.chance(opts.appPaymentShare) ? 'App' : 'Bar',
    });
    const ride: PrevRide = { pickup, dropoff, startMs, endMs };
    if (rng.chance(opts.cancellationShare)) {
      const at = startMs + Math.floor(rng.next() * (endMs - startMs));
      rides.push(cancelledRide(ctx, owner, at, positionDuring(ride, at)));
    }
    prev = ride;
  }
  if (rides.length === 0 || !rides.every(stampsAreUnique)) return null;
  return { rides, endMs: prev ? prev.endMs : plan.startMs, endedBy, refusedSteps };
}

// ── The rules, checked independently of how the rides were made ─────────────

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

/** The five instants of a ride row, in the order the sheet writes them. */
const RIDE_INSTANT_FIELDS = ['orderReceivedMs', 'orderTransmittedMs', 'plannedPickupMs', 'startMs', 'endMs'] as const;

/**
 * Every instant of every ride is a whole number of milliseconds.
 *
 * The rule is checked here, read back from the output, and not only kept by
 * the one line that draws a sub-millisecond value, because a rule enforced at
 * a single site is lost by the next writer without a sound: a fractional
 * instant printed `18:49:25.441.665771484375`, a timestamp with two decimal
 * points that nothing can parse, and no test and no screen said a word
 * (FB-HIGH-001). SimulatedRidesPage builds no file while this reports
 * anything, so a future producer of a fractional instant fails loudly.
 */
function checkWholeMilliseconds(rides: readonly SimRide[]): string[] {
  return rides.flatMap(ride => RIDE_INSTANT_FIELDS.flatMap(field => {
    const ms = ride[field];
    return ms === null || Number.isInteger(ms)
      ? []
      : [`${ride.shiftId}: ${field} is ${ms}, not a whole number of milliseconds`];
  }));
}

function checkShiftLengths(shifts: readonly SimShift[]): string[] {
  return shifts.flatMap(s => {
    const minutes = (s.endMs - s.startMs) / 60_000;
    return minutes < SHIFT_LIMITS.minMinutes || minutes > SHIFT_LIMITS.maxMinutes
      ? [`${s.id}: shift of ${Math.round(minutes)} minutes is outside ${SHIFT_LIMITS.minMinutes}-${SHIFT_LIMITS.maxMinutes}`]
      : [];
  });
}

function overlaps(key: string, list: readonly SimShift[]): string[] {
  const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
  return sorted.flatMap((s, i) => (i > 0 && s.startMs < sorted[i - 1].endMs ? [`${key}: ${sorted[i - 1].id} and ${s.id} overlap`] : []));
}

function checkVehicleDays(shifts: readonly SimShift[]): string[] {
  const out: string[] = [];
  for (const [key, list] of groupBy(shifts, s => `${s.vehicle.plate}|${s.operatingDay}`)) {
    if (list.length > SHIFT_LIMITS.maxPerVehicleDay) out.push(`${key}: ${list.length} shifts in one operating day`);
  }
  for (const [key, list] of groupBy(shifts, s => s.vehicle.plate)) out.push(...overlaps(key, list));
  for (const [key, list] of groupBy(shifts, s => s.driver.name)) out.push(...overlaps(key, list));
  return out;
}

/**
 * The gap between two rides must hold the drive and its safety margin. An
 * order that reached the car after the previous ride ended needs both legs,
 * Zielort to Standort and Standort to Abholort, and cannot have arrived before
 * the first leg was driven; one that came during the previous ride needs
 * Zielort to Abholort. Either way the gap must also hold the direct drive,
 * which is the one a route check of the file asks about.
 */
function checkApproachLegs(travel: TravelModel, margins: MarginOptions, shiftId: string, nth: number, prev: SimRide, next: SimRide, gap: number): string[] {
  const hour = localHour(prev.endMs as number);
  const unrouted = `${shiftId}: no ${travel.source} route for the approach before ride ${nth}`;
  const sameAddress = prev.dropoff.label === next.pickup.label;
  const direct = sameAddress ? { seconds: 0, km: 0 } : travel.drive(prev.dropoff, next.pickup, hour);
  if (!direct) return [unrouted];
  const out: string[] = [];
  const neededDirect = pickupDriveSeconds(direct.seconds, margins);
  if (gap < neededDirect) out.push(`${shiftId}: gap of ${gap}s before ride ${nth} is shorter than the ${neededDirect}s the distance and its margin need`);
  if (next.orderTransmittedMs < (prev.endMs as number)) return out;
  const toStop = travel.drive(prev.dropoff, next.vehiclePosition, hour);
  const toPickup = travel.drive(next.vehiclePosition, next.pickup, hour);
  if (!toStop || !toPickup) return [...out, unrouted];
  const legOne = emptyDriveSeconds(toStop.seconds, margins);
  const legTwo = pickupDriveSeconds(toPickup.seconds, margins);
  if (gap < legOne + legTwo) out.push(`${shiftId}: gap of ${gap}s before ride ${nth} is shorter than the ${legOne + legTwo}s its two legs and their margins need`);
  const arrived = (next.orderTransmittedMs - (prev.endMs as number)) / 1000;
  if (arrived < legOne) out.push(`${shiftId}: the order for ride ${nth} reached the car ${arrived}s after the last ride, before the ${legOne}s drive to its position`);
  const afterOrder = ((next.startMs as number) - next.orderTransmittedMs) / 1000;
  if (afterOrder < legTwo) out.push(`${shiftId}: ride ${nth} starts ${afterOrder}s after its order, short of the ${legTwo}s drive to the Abholort and its margin`);
  return out;
}

/** The first ride of a shift is driven to from the base, and the shift's start must hold that drive. */
function checkOpeningLegs(shifts: readonly SimShift[], rides: readonly SimRide[], base: GeoPoint, travel: TravelModel, margins: MarginOptions): string[] {
  const first = new Map<string, SimRide>();
  for (const r of rides) {
    if (r.status !== 'completed' || r.startMs === null) continue;
    const seen = first.get(r.shiftId);
    if (!seen || (seen.startMs as number) > r.startMs) first.set(r.shiftId, r);
  }
  return shifts.flatMap(s => {
    const ride = first.get(s.id);
    if (!ride) return [];
    const leg = travel.drive(base, ride.pickup, localHour(s.startMs));
    if (!leg) return [`${s.id}: no ${travel.source} route from the base to the first pickup`];
    const gap = ((ride.startMs as number) - s.startMs) / 1000;
    const needed = pickupDriveSeconds(leg.seconds, margins);
    return gap < needed ? [`${s.id}: the first ride starts ${gap}s after the shift, short of the ${needed}s the drive from the base and its margin need`] : [];
  });
}

function checkRideChain(rides: readonly SimRide[], base: GeoPoint, travel: TravelModel, margins: MarginOptions): string[] {
  const out: string[] = [];
  for (const [shiftId, list] of groupBy(rides.filter(r => r.status === 'completed'), r => r.shiftId)) {
    const sorted = [...list].sort((a, b) => (a.startMs as number) - (b.startMs as number));
    if (sorted[0].vehiclePosition.lat !== base.lat || sorted[0].vehiclePosition.lon !== base.lon) {
      out.push(`${shiftId}: the first ride does not start from the base`);
    }
    for (const ride of sorted) {
      // A ride shorter than its own road is the same lie as a gap shorter than the drive.
      const leg = travel.ride(ride.pickup, ride.dropoff, localHour(ride.startMs as number));
      if (!leg) { out.push(`${shiftId}: no ${travel.source} route for a ride`); continue; }
      const seconds = ((ride.endMs as number) - (ride.startMs as number)) / 1000;
      if (seconds < leg.seconds) out.push(`${shiftId}: a ride of ${seconds}s is shorter than the ${leg.seconds}s its route needs`);
    }
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const next = sorted[i];
      const gap = ((next.startMs as number) - (prev.endMs as number)) / 1000;
      if (gap < 0) { out.push(`${shiftId}: rides ${i} and ${i + 1} overlap`); continue; }
      out.push(...checkApproachLegs(travel, margins, shiftId, i + 1, prev, next, gap));
    }
  }
  return out;
}

/**
 * Every rule of the brief, read back from the output. Empty means the month is
 * physically consistent under `travel` — the model it was built with. Checked
 * against another model it can fail, and that is a finding about the two
 * models, not about the month: `routeCheck.ts` reports it as such.
 */
export function validateRides(
  month: GeneratedMonth,
  base: GeoPoint,
  travel: TravelModel = ESTIMATE_TRAVEL_MODEL,
  margins: MarginOptions = DEFAULT_OPTIONS,
): string[] {
  return [
    ...checkWholeMilliseconds(month.rides),
    ...checkShiftLengths(month.shifts),
    ...checkVehicleDays(month.shifts),
    ...checkOpeningLegs(month.shifts, month.rides, base, travel, margins),
    ...checkRideChain(month.rides, base, travel, margins),
  ];
}
