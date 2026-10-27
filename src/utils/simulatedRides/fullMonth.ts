import { findBlockingNote } from '../driverNoteValidation';
import type { StructuredNote } from '../monatsplanungPhase3';
import {
  buildConstraintDecisionLog,
  summariseConstraintLog,
  type ConstraintDecision,
  type ConstraintLogSummary,
  type WerkstattCheckRow,
} from '../constraintDecisionLog';
import { DEFAULT_OPTIONS, SHIFT_LIMITS, runShift, type Context, type PlannedShift } from './generator';
import { buildPeriod, isoWeekdayOf, operatingDayIn, type PeriodDay } from './period';
import { createRng } from './rng';
import { countRevenue, revenueBasis, type RevenueBasis, type RevenueBreakdown } from './revenue';
import { applyMonthlyShare, selectMonthlyShareRate, type MonthlyShareRate, type ShareResult } from './monthlyRate';
import { resolveSettings, type SettingsProblem, type SimulationTenantSettings } from './tenantSettings';
import type { GeneratedMonth, GeneratorOptions, GeoPoint, PoolAddress, SimRide, SimShift, SimVehicle } from './types';

/**
 * A full calendar month of simulated rides (external audit round 3, section 2).
 *
 * ## How this differs from `generateFromFigures`, and why both exist
 *
 * `generateFromFigures` is **income-driven**: it reads the company's own
 * income rows and invents the rides that would explain them, driver-week by
 * driver-week. That is why the month an auditor was shown covered four
 * operating days — four driver-weeks had income figures, and the rest of the
 * month had none to explain. It is the right generator for "make the books add
 * up" and the wrong one for "show me a month".
 *
 * This one is **period-driven**: the day list is built from the calendar first
 * (`buildPeriod`), and the rides are placed into it. Every day of a 28-, 29-,
 * 30- or 31-day month is in the result, **including the days that carry no ride
 * at all**, each with the reason it is empty. Section 2 forbids shortening the
 * period to a sample, and a day list derived from the rides can only ever
 * contain days that have rides.
 *
 * ## The constraint section 2 states about itself, and it applies here
 *
 * "إذا تعذر إنتاج فترة كاملة دون اختلاق قدرة تشغيلية، أبلغ بالقيد ولا تعتبر
 * الإنجاز مكتملًا" — if a full period cannot be produced without inventing
 * operating capacity, report the constraint.
 *
 * What is **real**, read from the company's own tables: the drivers, their
 * UUIDs, their allowed weekdays and their structured notes; the vehicles,
 * their plates and their TÜV dates; the address pool (OpenStreetMap, via
 * Nominatim); the Betriebssitz.
 *
 * What is **invented**: the rides, and therefore the revenue. There is no
 * income figure for a period-driven month to match, so every fare here is the
 * generator's own draw. That is not a defect of this module and it cannot be
 * fixed inside it — a month that has not happened has no revenue to read. It
 * is why `provenance.inputSource` records `period_driven` and why the
 * workbook's own sheet says the revenue is generated. **A figure from this
 * generator is never a measurement.**
 *
 * Operating capacity is *not* invented: a day with no available driver or no
 * vehicle produces no ride and is reported as such, and no ride is ever placed
 * inside a driver's blocking note. Both are checked by reading the output back
 * (`validateFullMonth`), not only by the code that built it.
 */

/** A driver as this generator needs him: a UUID, a name, and his own rules. */
export interface FullMonthDriver {
  /** `drivers.id`. The only thing a note is matched on. */
  id: string;
  name: string;
  /** ISO weekdays he may work, Monday = 1. Null or empty means every day. */
  allowed_weekdays?: readonly number[] | null;
  /** False keeps him out of the plan entirely. */
  planning_enabled?: boolean;
  status?: 'active' | 'inactive' | null;
  /** The legacy free-text note. Read by the decision log, not by this generator. */
  notes?: string | null;
}

/** A vehicle as this generator needs it. */
export interface FullMonthVehicle extends SimVehicle {
  /** `cars.id`. */
  id: string;
  /** `YYYY-MM-DD`, or null when not recorded. */
  tuev_gueltig_bis?: string | null;
}

export interface FullMonthInput {
  year: number;
  /** 1..12. */
  month: number;
  base: GeoPoint;
  pool: readonly PoolAddress[];
  vehicles: readonly FullMonthVehicle[];
  drivers: readonly FullMonthDriver[];
  /** Structured notes keyed by `drivers.id`. */
  driverNotesMap: Map<string, StructuredNote[]>;
  werkstattChecks?: readonly WerkstattCheckRow[];
  seed: number;
  settings?: Partial<SimulationTenantSettings>;
  options?: Partial<GeneratorOptions>;
  /** Shifts a vehicle may run on one operating day. Capped by `SHIFT_LIMITS`. */
  shiftsPerVehicleDay?: number;
}

/** Why a day, or a shift, carries no ride. One code per cause, stable. */
export type CapacityReason =
  | 'no_vehicle_in_fleet'
  | 'no_driver_in_pool'
  | 'operating_day_has_no_start_instant'
  | 'no_driver_available'
  | 'no_vehicle_free'
  | 'driver_blocked_by_note'
  | 'driver_weekday_not_allowed'
  | 'driver_resting'
  | 'shift_produced_no_ride';

/** One refusal, kept so the summary can say what was not generated and why. */
export interface CapacityRefusal {
  day: string;
  reason: CapacityReason;
  /** The vehicle's plate, where the refusal names one. */
  plate?: string;
  /** The driver's UUID, where the refusal names one. */
  driverId?: string;
  /** The note that blocked him, for `driver_blocked_by_note`. */
  noteType?: string;
}

/** One day of the month, including a day with nothing on it. */
export interface DaySummary {
  day: string;
  isoWeekday: number;
  /** 23 or 25 on a transition day, 24 otherwise. */
  hours: number;
  shifts: number;
  rides: number;
  completed: number;
  cancelled: number;
  declined: number;
  fareCents: number;
  tipCents: number;
  declinedFeeCents: number;
  km: number;
  /**
   * Drivers who actually held a ride this day. Not "could have worked": a
   * driver free all day who was never drawn is in neither this count nor the
   * refusals, and calling it availability would overstate what is measured.
   */
  driversWorked: number;
  /** Drivers kept off it, with the reason. */
  refusals: CapacityRefusal[];
  /** True when the day carries no ride. Section 2 asks for these explicitly. */
  zeroRideDay: boolean;
}

/** What built the month, so the month can be rebuilt from the record alone. */
export interface Provenance {
  generatorVersion: string;
  seed: number;
  year: number;
  month: number;
  settings: SimulationTenantSettings;
  options: GeneratorOptions;
  shiftsPerVehicleDay: number;
  /** `period_driven`: the days come from the calendar, the revenue is generated. */
  inputSource: 'period_driven';
  /** What was read from the company's tables, counted. */
  inputs: {
    drivers: number;
    vehicles: number;
    addressPool: number;
    driversWithNotes: number;
    structuredNotes: number;
    werkstattChecks: number;
  };
  /** Always true. The month is simulated and says so in its own record. */
  simulated: true;
}

/**
 * Bumped whenever the generated month would differ for the same seed. A month
 * carries it so a figure can be traced to the code that made it.
 */
export const FULL_MONTH_GENERATOR_VERSION = 'full-month/1.0.0';

export interface FullMonthResult {
  month: GeneratedMonth;
  period: PeriodDay[];
  days: DaySummary[];
  revenue: RevenueBreakdown;
  basis: RevenueBasis;
  /** Null when the tenant has the share switched off, which is the default. */
  share: { rate: MonthlyShareRate; result: ShareResult } | null;
  constraints: ConstraintDecision[];
  constraintSummary: ConstraintLogSummary;
  refusals: CapacityRefusal[];
  provenance: Provenance;
  /** Rules checked by reading the result back. Empty means every rule held. */
  violations: string[];
}

export type FullMonthFailure =
  | { kind: 'settings'; problem: SettingsProblem }
  | { kind: 'month_out_of_range' }
  | { kind: 'address_pool_too_small' };

interface Busy {
  start: number;
  end: number;
}

const clash = (list: readonly Busy[] | undefined, s: number, e: number, buffer: number): boolean =>
  (list ?? []).some(b => s < b.end + buffer && e > b.start - buffer);

/** The address pool `generateFromFigures` requires, for the same reason: a smaller one repeats. */
const MIN_POOL = 8;

export function generateFullMonth(
  input: FullMonthInput,
): { ok: true; result: FullMonthResult } | { ok: false; failure: FullMonthFailure } {
  if (!Number.isInteger(input.month) || input.month < 1 || input.month > 12) {
    return { ok: false, failure: { kind: 'month_out_of_range' } };
  }
  const resolved = resolveSettings(input.settings);
  if (!resolved.ok) return { ok: false, failure: { kind: 'settings', problem: resolved.problem } };
  const settings = resolved.settings;
  if (input.pool.length < MIN_POOL) return { ok: false, failure: { kind: 'address_pool_too_small' } };

  const opts: GeneratorOptions = { ...DEFAULT_OPTIONS, ...input.options };
  const shiftsPerVehicleDay = Math.max(
    1,
    Math.min(SHIFT_LIMITS.maxPerVehicleDay, input.shiftsPerVehicleDay ?? 1),
  );
  const ctx: Context = {
    rng: createRng(input.seed),
    opts,
    base: input.base,
    pool: input.pool,
    usedTransmits: new Set(),
  };

  const period = buildPeriod(input.year, input.month, settings);
  const month: GeneratedMonth = { shifts: [], rides: [], droppedShifts: 0 };
  const refusals: CapacityRefusal[] = [];
  const vehicleBusy = new Map<string, Busy[]>();
  const driverBusy = new Map<string, Busy[]>();
  const driverLastEnd = new Map<string, number>();
  let nextShift = 1;

  const pool = input.drivers.filter(d => d.planning_enabled !== false && d.status !== 'inactive');

  for (const day of period) {
    if (input.vehicles.length === 0) {
      refusals.push({ day: day.day, reason: 'no_vehicle_in_fleet' });
      continue;
    }
    if (pool.length === 0) {
      refusals.push({ day: day.day, reason: 'no_driver_in_pool' });
      continue;
    }
    if (day.startMs === null) {
      refusals.push({ day: day.day, reason: 'operating_day_has_no_start_instant' });
      continue;
    }

    const dayEndMs = day.startMs + day.hours * 3_600_000;
    for (const vehicle of input.vehicles) {
      for (let slot = 0; slot < shiftsPerVehicleDay; slot++) {
        const placed = placeShift({
          ctx,
          day,
          dayStartMs: day.startMs,
          dayEndMs,
          vehicle,
          pool,
          notes: input.driverNotesMap,
          vehicleBusy,
          driverBusy,
          driverLastEnd,
          refusals,
          shiftId: `S${nextShift}`,
          settings,
        });
        if (!placed) {
          month.droppedShifts += 1;
          continue;
        }
        nextShift += 1;
        month.shifts.push(placed.shift);
        month.rides.push(...placed.rides);
      }
    }
  }

  // After every shift, so the shared random stream and every completed ride's
  // transmission instant are exactly what they are with the feature off.
  month.rides.push(
    ...declinedOrders(month.shifts, settings, ctx.usedTransmits, input.pool, input.seed, opts.appPaymentShare),
  );
  month.rides.sort((a, b) => a.orderTransmittedMs - b.orderTransmittedMs);

  const revenue = countRevenue(month.rides, settings);
  const basis = revenueBasis(revenue, settings);
  const share = settings.monthlyRevenueShareEnabled ? computeShare(basis, input) : null;

  const constraints = buildConstraintDecisionLog({
    drivers: input.drivers,
    driverNotesMap: input.driverNotesMap,
    vehicles: input.vehicles,
    werkstattChecks: input.werkstattChecks,
    // The month's first day: the whole period is judged against one stated day
    // rather than against the clock, so the log of a month does not change
    // tomorrow.
    asOfDate: period[0]?.day,
  });

  const days = summariseDays(period, month, refusals, settings);
  const provenance: Provenance = {
    generatorVersion: FULL_MONTH_GENERATOR_VERSION,
    seed: Math.trunc(input.seed),
    year: input.year,
    month: input.month,
    settings,
    options: opts,
    shiftsPerVehicleDay,
    inputSource: 'period_driven',
    inputs: {
      drivers: input.drivers.length,
      vehicles: input.vehicles.length,
      addressPool: input.pool.length,
      driversWithNotes: [...input.driverNotesMap.values()].filter(list => list.length > 0).length,
      structuredNotes: [...input.driverNotesMap.values()].reduce((n, list) => n + list.length, 0),
      werkstattChecks: input.werkstattChecks?.length ?? 0,
    },
    simulated: true,
  };

  return {
    ok: true,
    result: {
      month,
      period,
      days,
      revenue,
      basis,
      share,
      constraints,
      constraintSummary: summariseConstraintLog(constraints),
      refusals,
      provenance,
      violations: validateFullMonth(month, period, input.driverNotesMap, settings),
    },
  };
}

function computeShare(basis: RevenueBasis, input: FullMonthInput): { rate: MonthlyShareRate; result: ShareResult } | null {
  const rate = selectMonthlyShareRate(input.seed, input.year, input.month);
  const applied = applyMonthlyShare(basis.basisCents, rate.rateBasisPoints);
  return applied.ok ? { rate, result: applied.result } : null;
}

interface PlaceArgs {
  ctx: Context;
  day: PeriodDay;
  dayStartMs: number;
  dayEndMs: number;
  vehicle: FullMonthVehicle;
  pool: readonly FullMonthDriver[];
  notes: Map<string, StructuredNote[]>;
  vehicleBusy: Map<string, Busy[]>;
  driverBusy: Map<string, Busy[]>;
  driverLastEnd: Map<string, number>;
  refusals: CapacityRefusal[];
  shiftId: string;
  settings: SimulationTenantSettings;
}

/**
 * One shift of one vehicle on one day, or null with the reason recorded.
 *
 * The driver is chosen **after** the window is drawn, because availability is a
 * property of a driver *and* a window: a note that blocks the morning leaves
 * the same driver free in the evening. `findBlockingNote` is the planner's own
 * function, so "unavailable" means here exactly what it means to
 * `monatsplanungPhase3` — a second copy of that rule would let the generator
 * place a ride the planner would refuse.
 */
function placeShift(args: PlaceArgs): { shift: SimShift; rides: SimRide[] } | null {
  const { ctx, day, dayStartMs, dayEndMs, vehicle, pool, notes, refusals, settings } = args;
  const { rng, opts } = ctx;
  const vehicleGap = opts.minVehicleGapMinutes * 60_000;
  const restMs = opts.minDriverRestMinutes * 60_000;

  for (let attempt = 0; attempt < 12; attempt++) {
    const lengthMinutes = rng.int(opts.minShiftMinutes / 15, opts.maxShiftMinutes / 15) * 15;
    const lengthMs = lengthMinutes * 60_000;
    const latestStart = dayEndMs - lengthMs;
    if (latestStart <= dayStartMs) continue;
    const slots = Math.floor((latestStart - dayStartMs) / (15 * 60_000));
    const startMs = dayStartMs + rng.int(0, Math.max(0, slots)) * 15 * 60_000;
    const endMs = startMs + lengthMs;

    if (clash(args.vehicleBusy.get(vehicle.plate), startMs, endMs, vehicleGap)) continue;

    const candidates: FullMonthDriver[] = [];
    for (const driver of pool) {
      const allowed = driver.allowed_weekdays;
      if (allowed && allowed.length > 0 && !allowed.includes(isoWeekdayOf(day.day))) {
        refusals.push({ day: day.day, reason: 'driver_weekday_not_allowed', driverId: driver.id, plate: vehicle.plate });
        continue;
      }
      if (startMs < (args.driverLastEnd.get(driver.id) ?? -Infinity) + restMs) {
        refusals.push({ day: day.day, reason: 'driver_resting', driverId: driver.id, plate: vehicle.plate });
        continue;
      }
      if (clash(args.driverBusy.get(driver.id), startMs, endMs, 0)) {
        refusals.push({ day: day.day, reason: 'driver_resting', driverId: driver.id, plate: vehicle.plate });
        continue;
      }
      const blocking = findBlockingNote(driver.id, startMs, endMs, notes);
      if (blocking) {
        refusals.push({
          day: day.day,
          reason: 'driver_blocked_by_note',
          driverId: driver.id,
          plate: vehicle.plate,
          noteType: blocking.note_type,
        });
        continue;
      }
      candidates.push(driver);
    }
    if (candidates.length === 0) {
      refusals.push({ day: day.day, reason: 'no_driver_available', plate: vehicle.plate });
      continue;
    }

    const driver = rng.pick(candidates);
    const plan: PlannedShift = { vehicle, startMs, plannedEndMs: endMs, operatingDay: day.day };
    const run = runShift(ctx, plan, { shiftId: args.shiftId, vehicle, driver });
    if (!run) {
      refusals.push({ day: day.day, reason: 'shift_produced_no_ride', plate: vehicle.plate, driverId: driver.id });
      continue;
    }

    const rides = run.rides;
    args.vehicleBusy.set(vehicle.plate, [...(args.vehicleBusy.get(vehicle.plate) ?? []), { start: startMs, end: run.endMs }]);
    args.driverBusy.set(driver.id, [...(args.driverBusy.get(driver.id) ?? []), { start: startMs, end: run.endMs }]);
    args.driverLastEnd.set(driver.id, run.endMs);
    return {
      shift: { id: args.shiftId, vehicle, driver, operatingDay: day.day, startMs, endMs: run.endMs },
      rides,
    };
  }
  refusals.push({ day: day.day, reason: 'no_vehicle_free', plate: vehicle.plate });
  return null;
}

/**
 * The declined orders of the month (section 3), built after every shift is
 * built, from a **random stream of their own**.
 *
 * ## Why this is a second pass, and the measurement that forced it
 *
 * The first version drew inside `placeShift`, from the generator's shared
 * `ctx.rng`. Every draw it made consumed a number the next shift's own draws
 * would have taken, so switching the feature on moved **every later shift** —
 * measured at one seed as **778 completed rides with it off against 749 with it
 * on**. The comment here claimed a declined order "moves no other ride", and
 * that claim was false.
 *
 * Run afterwards, from a stream seeded off the month's seed, the completed
 * rides are what they are with the feature off, ride for ride: this pass
 * touches the shared stream not at all. `monthlyRate.ts` separates its stream
 * for exactly the same reason, and for the same reason it is not optional.
 *
 * **The one coupling that remains, stated rather than glossed over.** A
 * transmission instant has to be unique across the month, because it feeds
 * `source_row_key` and a repeat would hash two rides to one key. So a
 * collision steps forward by a millisecond. Because this pass runs **last**,
 * every completed ride has already claimed its instant and none can be pushed
 * — a collision can only ever move a declined order. Were the order reversed,
 * a declined order could nudge a real ride's clock by a millisecond.
 *
 * A declined order keeps no clock times, no fare, no tip and no kilometre,
 * exactly as a cancelled ride does, so it consumes none of the shift's time.
 */
function declinedOrders(
  shifts: readonly SimShift[],
  settings: SimulationTenantSettings,
  usedTransmits: Set<number>,
  pool: readonly PoolAddress[],
  seed: number,
  appPaymentShare: number,
): SimRide[] {
  if (!settings.declinedRidesEnabled || settings.declinedShare <= 0) return [];
  const rng = createRng(declinedStreamSeed(seed));
  const out: SimRide[] = [];
  for (const shift of shifts) {
    if (shift.endMs <= shift.startMs) continue;
    // One draw per hour of the shift, so the share reads as "a share of orders"
    // at any shift length rather than as a flat count per shift.
    const hours = Math.max(1, Math.round((shift.endMs - shift.startMs) / 3_600_000));
    for (let i = 0; i < hours; i++) {
      if (!rng.chance(settings.declinedShare)) continue;
      const at = shift.startMs + rng.int(0, Math.max(0, shift.endMs - shift.startMs - 1));
      let orderTransmittedMs = at;
      while (usedTransmits.has(orderTransmittedMs)) orderTransmittedMs += 1;
      usedTransmits.add(orderTransmittedMs);
      const pickup = rng.pick(pool);
      const dropoff = rng.pick(pool);
      out.push({
        shiftId: shift.id,
        vehicle: shift.vehicle,
        driver: shift.driver,
        status: 'declined',
        declinedFeeCents: settings.declinedFeeCents,
        orderReceivedMs: Math.floor(orderTransmittedMs / 1000) * 1000,
        orderTransmittedMs,
        plannedPickupMs: null,
        startMs: null,
        endMs: null,
        vehiclePosition: pickup,
        pickup,
        dropoff,
        fare: 0,
        tip: 0,
        km: 0,
        payment: rng.chance(appPaymentShare) ? 'App' : 'Bar',
        prebooked: false,
      });
    }
  }
  return out;
}

/**
 * The sub-seed of the declined orders' stream. A plain mix, like
 * `shareStreamSeed`: it only has to be stable, and not to be the generator's
 * own seed, so that the same month reproduces and the shared stream is left
 * exactly as it was.
 */
export function declinedStreamSeed(seed: number): number {
  return ((Math.trunc(seed) ^ 0x2545_f491) + 0x9e37_79b9) >>> 0;
}

/** Every day of the period with its figures, zero-ride days included. */
function summariseDays(
  period: readonly PeriodDay[],
  month: GeneratedMonth,
  refusals: readonly CapacityRefusal[],
  settings: SimulationTenantSettings,
): DaySummary[] {
  const dayOf = (ride: SimRide): string =>
    operatingDayIn(ride.startMs ?? ride.orderTransmittedMs, settings.timeZone, settings.operatingDayStartHour);

  const ridesByDay = new Map<string, SimRide[]>();
  for (const ride of month.rides) {
    const key = dayOf(ride);
    ridesByDay.set(key, [...(ridesByDay.get(key) ?? []), ride]);
  }
  const shiftsByDay = new Map<string, number>();
  for (const shift of month.shifts) shiftsByDay.set(shift.operatingDay, (shiftsByDay.get(shift.operatingDay) ?? 0) + 1);

  return period.map(day => {
    const rides = ridesByDay.get(day.day) ?? [];
    const breakdown = countRevenue(rides, settings);
    const dayRefusals = refusals.filter(r => r.day === day.day);
    const workedDrivers = new Set(rides.map(r => r.driver.name));
    return {
      day: day.day,
      isoWeekday: day.isoWeekday,
      hours: day.hours,
      shifts: shiftsByDay.get(day.day) ?? 0,
      rides: rides.length,
      completed: breakdown.counts.completed,
      cancelled: breakdown.counts.cancelled,
      declined: breakdown.counts.declined,
      fareCents: breakdown.fareCents,
      tipCents: breakdown.tipCents,
      declinedFeeCents: breakdown.declinedFeeCents,
      km: breakdown.km,
      driversWorked: workedDrivers.size,
      refusals: dayRefusals,
      zeroRideDay: rides.length === 0,
    };
  });
}

/**
 * The rules, checked by reading the finished month back.
 *
 * The same discipline as `validateRides`: a rule the builder keeps is a rule
 * only until someone edits the builder, so the rules section 2 states are
 * re-derived from the output. A violation is a string, so the workbook's
 * validation sheet can print it.
 */
export function validateFullMonth(
  month: GeneratedMonth,
  period: readonly PeriodDay[],
  notes: Map<string, StructuredNote[]>,
  settings: SimulationTenantSettings,
): string[] {
  const out: string[] = [];
  const driverIdByName = new Map<string, string>();

  // 1. Every ride falls inside the period. A ride dated outside the month it
  //    claims to be is the one error a day-by-day summary cannot show.
  const days = new Set(period.map(d => d.day));
  for (const ride of month.rides) {
    const day = operatingDayIn(
      ride.startMs ?? ride.orderTransmittedMs,
      settings.timeZone,
      settings.operatingDayStartHour,
    );
    if (!days.has(day)) out.push(`ride of shift ${ride.shiftId} falls on ${day}, outside the generated period`);
  }

  // 2. No driver holds two overlapping rides, and no vehicle does. Section 5
  //    asks for both, and the check is on absolute instants.
  out.push(...overlaps(month.rides, r => r.driver.name, 'driver'));
  out.push(...overlaps(month.rides, r => r.vehicle.plate, 'vehicle'));

  // 3. No ride sits inside a driver's blocking note. Asked of the planner's own
  //    function, so this cannot pass while the planner would refuse the shift.
  for (const shift of month.shifts) {
    const id = driverIdByName.get(shift.driver.name) ?? findDriverId(notes, shift);
    if (id === null) continue;
    const blocking = findBlockingNote(id, shift.startMs, shift.endMs, notes);
    if (blocking) out.push(`shift ${shift.id} runs inside a ${blocking.note_type} note of its driver`);
  }

  // 4. A declined ride carries a fee and no fare, a completed one the reverse.
  for (const ride of month.rides) {
    if (ride.status === 'declined' && (ride.fare !== 0 || ride.tip !== 0 || ride.km !== 0)) {
      out.push(`declined ride of shift ${ride.shiftId} carries a fare, a tip or a distance`);
    }
    if (ride.status === 'completed' && ride.declinedFeeCents !== undefined) {
      out.push(`completed ride of shift ${ride.shiftId} carries a decline fee`);
    }
  }

  return out;
}

/**
 * The driver's UUID behind a shift, or null.
 *
 * It returns null rather than matching on the name, which section 5 forbids —
 * so a null means "not checked", never "checked and clean".
 * `generateFullMonth` always passes drivers that carry their id, so for a month
 * this generator built the answer is never null.
 */
function findDriverId(notes: Map<string, StructuredNote[]>, shift: SimShift): string | null {
  const id = shift.driver.id;
  return typeof id === 'string' && notes.has(id) ? id : null;
}

function overlaps(rides: readonly SimRide[], key: (r: SimRide) => string, what: string): string[] {
  const out: string[] = [];
  const groups = new Map<string, SimRide[]>();
  for (const ride of rides) {
    if (ride.startMs === null || ride.endMs === null) continue;
    groups.set(key(ride), [...(groups.get(key(ride)) ?? []), ride]);
  }
  for (const [name, list] of groups) {
    const sorted = [...list].sort((a, b) => (a.startMs as number) - (b.startMs as number));
    for (let i = 1; i < sorted.length; i++) {
      if ((sorted[i].startMs as number) < (sorted[i - 1].endMs as number)) {
        out.push(`${what} ${name} holds two overlapping rides`);
      }
    }
  }
  return out;
}
