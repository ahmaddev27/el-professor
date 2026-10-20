import type { Rng } from './rng';
import { deadheadSeconds, interpolate, minTravelSeconds, rideSeconds, roadKm } from './geo';
import { isUniqueWallTime, localHour } from './time';
import type { GeneratedMonth, GeneratorOptions, GeoPoint, PoolAddress, SimDriver, SimRide, SimShift, SimVehicle } from './types';

export const DEFAULT_OPTIONS: GeneratorOptions = {
  minShiftMinutes: 270,
  maxShiftMinutes: 360,
  minVehicleGapMinutes: 60,
  minDriverRestMinutes: 11 * 60,
  cancellationShare: 0.02,
  tipShare: 0.12,
  appPaymentShare: 0.69,
  prebookedShare: 0.03,
};

/** The hard limits, restated for the validator: a shift is 4 to 6 hours, at most 3 per vehicle and day. */
export const SHIFT_LIMITS = { minMinutes: 240, maxMinutes: 360, maxPerVehicleDay: 3 } as const;

const MIN_RIDE_BUDGET_SECONDS = 8 * 60;
const CANCELLATION_FEES = [6, 7.2, 7.5] as const;
const TIP_AMOUNTS = [1, 1.5, 2, 3, 5] as const;

interface Segment { t0: number; t1: number; from: GeoPoint; to: GeoPoint }

export interface PlannedShift { vehicle: SimVehicle; startMs: number; plannedEndMs: number; operatingDay: string }

export interface Context {
  rng: Rng;
  opts: GeneratorOptions;
  base: GeoPoint;
  pool: readonly PoolAddress[];
  usedTransmits: Set<number>;
}

export interface ShiftOwner { shiftId: string; vehicle: SimVehicle; driver: SimDriver }

export interface ShiftRun { rides: SimRide[]; endMs: number }

const round2 = (n: number): number => Math.round(n * 100) / 100;

function nearest(pool: readonly PoolAddress[], to: GeoPoint, count: number): PoolAddress[] {
  return pool
    .map(a => ({ a, d: roadKm(to, a) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, count)
    .map(x => x.a);
}

function choosePickup(ctx: Context, from: GeoPoint): PoolAddress {
  const near = nearest(ctx.pool, from, 8);
  return ctx.rng.pick(near);
}

/** Ride length: mostly short city rides, now and then a long one. */
function targetRideKm(rng: Rng): number {
  const r = rng.next();
  if (r < 0.7) return 1.5 + rng.next() * 8;
  if (r < 0.93) return 8 + rng.next() * 12;
  return 18 + rng.next() * 22;
}

function chooseDropoff(ctx: Context, from: PoolAddress, budgetSeconds: number, hour: number): PoolAddress | null {
  const target = targetRideKm(ctx.rng);
  const ranked = ctx.pool
    .filter(a => a !== from)
    .map(a => ({ a, km: roadKm(from, a) }))
    .filter(x => x.km >= 0.6)
    .sort((x, y) => Math.abs(x.km - target) - Math.abs(y.km - target));
  const fits = (x: { km: number }) => rideSeconds(x.km, hour) <= budgetSeconds;
  const top = ranked.slice(0, 5).filter(fits);
  if (top.length > 0) return ctx.rng.pick(top).a;
  const shortest = [...ranked].sort((x, y) => x.km - y.km).find(fits);
  return shortest ? shortest.a : null;
}

function positionAt(segments: readonly Segment[], t: number, fallback: GeoPoint): GeoPoint {
  const seg = segments.find(s => t >= s.t0 && t <= s.t1);
  if (!seg) return segments.length > 0 ? segments[segments.length - 1].to : fallback;
  return interpolate(seg.from, seg.to, seg.t1 === seg.t0 ? 1 : (t - seg.t0) / (seg.t1 - seg.t0));
}

function fareFor(rng: Rng, km: number, seconds: number): number {
  const noise = 0.9 + rng.next() * 0.22;
  return round2(Math.max(7, (4 + 1.15 * km + 0.25 * (seconds / 60)) * noise));
}

/** The order time is the key of a ride in the file, so two rides never share one. */
function uniqueTransmit(ctx: Context, ms: number): number {
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
  const pickup = choosePickup(ctx, position);
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

/**
 * When the order for the next ride reaches the vehicle. The first ride of a
 * shift is ordered the moment the shift starts, from the base. Every later one
 * arrives a little before the vehicle is free, but never before the previous
 * ride began.
 */
function transmitTime(ctx: Context, plan: PlannedShift, prevStartMs: number | null, cursor: number, startMs: number): number {
  if (prevStartMs === null) return plan.startMs + ctx.rng.int(0, 999);
  const lead = (startMs - cursor) / 1000 + ctx.rng.int(30, 150);
  return Math.max(prevStartMs + 60_000, startMs - lead * 1000) + ctx.rng.int(0, 999);
}

/** One shift, rides back to back. Null when any clock reading in it is not unique. */
export function runShift(ctx: Context, plan: PlannedShift, owner: ShiftOwner): ShiftRun | null {
  const { rng, opts } = ctx;
  const rides: SimRide[] = [];
  const segments: Segment[] = [];
  let cursor = plan.startMs;
  let pos: GeoPoint = ctx.base;
  let prevStartMs: number | null = null;

  for (;;) {
    const pickup = choosePickup(ctx, pos);
    const dead = deadheadSeconds(roadKm(pos, pickup), localHour(cursor));
    const startMs: number = cursor + (dead + (prevStartMs === null ? 0 : rng.int(0, 40))) * 1000;
    const budget = (plan.plannedEndMs - startMs) / 1000;
    if (budget < MIN_RIDE_BUDGET_SECONDS) break;
    const dropoff = chooseDropoff(ctx, pickup, budget, localHour(startMs));
    if (!dropoff) break;
    const km = roadKm(pickup, dropoff);
    const endMs = startMs + rideSeconds(km, localHour(startMs)) * 1000;

    segments.push({ t0: cursor, t1: startMs, from: pos, to: pickup }, { t0: startMs, t1: endMs, from: pickup, to: dropoff });
    const transmit = transmitTime(ctx, plan, prevStartMs, cursor, startMs);
    // The first order is placed while the vehicle still stands at the base.
    const vehiclePosition = prevStartMs === null ? ctx.base : positionAt(segments, Math.min(transmit, startMs), ctx.base);

    rides.push({
      ...owner,
      status: 'completed',
      ...orderTimes(ctx, transmit, startMs),
      startMs,
      endMs,
      vehiclePosition,
      pickup,
      dropoff,
      fare: fareFor(rng, km, (endMs - startMs) / 1000),
      tip: rng.chance(opts.tipShare) ? rng.pick(TIP_AMOUNTS) : 0,
      km: round2(km),
      payment: rng.chance(opts.appPaymentShare) ? 'App' : 'Bar',
    });
    if (rng.chance(opts.cancellationShare)) {
      const at = startMs + Math.floor(rng.next() * (endMs - startMs));
      rides.push(cancelledRide(ctx, owner, at, positionAt(segments, at, ctx.base)));
    }
    prevStartMs = startMs;
    cursor = endMs;
    pos = dropoff;
  }
  if (rides.length === 0 || !rides.every(stampsAreUnique)) return null;
  return { rides, endMs: cursor };
}

// ── The rules, checked independently of how the rides were made ─────────────

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
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

function checkRideChain(rides: readonly SimRide[], base: GeoPoint): string[] {
  const out: string[] = [];
  for (const [shiftId, list] of groupBy(rides.filter(r => r.status === 'completed'), r => r.shiftId)) {
    const sorted = [...list].sort((a, b) => (a.startMs as number) - (b.startMs as number));
    if (sorted[0].vehiclePosition.lat !== base.lat || sorted[0].vehiclePosition.lon !== base.lon) {
      out.push(`${shiftId}: the first ride does not start from the base`);
    }
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const next = sorted[i];
      const gap = ((next.startMs as number) - (prev.endMs as number)) / 1000;
      if (gap < 0) { out.push(`${shiftId}: rides ${i} and ${i + 1} overlap`); continue; }
      const needed = minTravelSeconds(prev.dropoff, next.pickup, localHour(prev.endMs as number));
      if (gap < needed) out.push(`${shiftId}: gap of ${gap}s before ride ${i + 1} is shorter than the ${needed}s the distance needs`);
    }
  }
  return out;
}

/** Every rule of the brief, read back from the output. Empty means the month is physically consistent. */
export function validateRides(month: GeneratedMonth, base: GeoPoint): string[] {
  return [...checkShiftLengths(month.shifts), ...checkVehicleDays(month.shifts), ...checkRideChain(month.rides, base)];
}
