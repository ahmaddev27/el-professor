import type { StructuredNote } from '../monatsplanungPhase3';
import {
  buildConstraintDecisionLog,
  summariseConstraintLog,
  type ConstraintDecision,
  type ConstraintLogSummary,
  type WerkstattCheckRow,
} from '../constraintDecisionLog';
import { DEFAULT_OPTIONS, SHIFT_LIMITS, runShift, validateRides, type Context, type PlannedShift, type ShiftEnd } from './generator';
import { assessAgainstRange, type RangeAssessment } from '../monthlyPlan/hoursRange';
import {
  MAX_DAY_MINUTES,
  planDriverMonth,
  uberActivity,
  type DriverDayPlan,
  type DriverMonthPlan,
  type DriverPlanConfig,
} from './driverMonthPlan';
import { buildPeriod, operatingDayIn, type PeriodDay } from './period';
import { fnv1a } from './hash';
import { createRng } from './rng';
import { countRevenue, inExportScope, revenueBasis, type RevenueBasis, type RevenueBreakdown } from './revenue';
import { marginProblem } from './repositioning';
import {
  buildRepositioningLegs,
  summariseRepositioning,
  type RepositioningLeg,
  type RepositioningSummary,
} from './repositioningLegs';
import { applyMonthlyShare, selectMonthlyShareRate, type MonthlyShareRate, type ShareResult, type ShareSetting } from './monthlyRate';
import { allocateImportedTips, reconcileMonth, type FinancialReconciliation, type ReconcileUber } from './reconciliation';
import { resolveSettings, type SettingsProblem, type SimulationTenantSettings } from './tenantSettings';
import { routeChecks, summariseRouteChecks, type RouteCheck, type RouteCheckSummary } from './routeCheck';
import {
  collapseDecisions,
  noteVerdict,
  vehicleVerdict,
  type ShiftDecision,
} from './simulationConstraints';
import { ESTIMATE_TRAVEL_MODEL, type TravelModel } from './travelModel';
import type { GeneratedMonth, GeneratorOptions, GeoPoint, PoolAddress, SimRide, SimShift, SimVehicle } from './types';
import type { BaseSource } from './baseSelection';
import { unavailableDuring, type UnavailabilityWindow } from './vehicleAvailability';
import { plateKey, type RealTrip, type RealTripsRead } from './realTrips';

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
 *
 * ## The drivers lead (Round 8, version 4)
 *
 * Until version 3 the vehicles led: every vehicle drew a shift of 4½ to 6
 * hours on every day and took whichever driver was free, so every driver's
 * month came out of the dice and none of the Drivers page reached it, and a
 * shift that ended short of 240 minutes was thrown away. Now each driver's
 * month is planned first (`planDriverMonth`): his days, his window, his
 * minutes, from his salary range, his weekdays, his notes and what Uber
 * reported. A vehicle is then found for each planned driver-day, one that has
 * a valid TÜV, sits outside every `vehicle_unavailability` window and is free.
 * A driver-day no vehicle can carry is a refusal; the planned length is never
 * cut to fit a vehicle. The 360-minute ceiling and the 11 hours of rest stay;
 * the universal 240-minute floor is gone, because a driver's own range decides
 * how long his day is.
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
  /**
   * `drivers.status`. Null is the column's default, `active`; anything but
   * `active` keeps him out (the CHECK admits only `inactive` beside it).
   */
  status?: string | null;
  /** The legacy free-text note. Read by the decision log, not by this generator. */
  notes?: string | null;
  /** The Drivers page's planning columns, read into `planDriverMonth` (Round 8). */
  employment_type?: string | null;
  work_window_start?: string | null;
  work_window_end?: string | null;
  is_full_day_available?: boolean | null;
  planning_min_salary?: number | null;
  planning_max_salary?: number | null;
  planning_hourly_rate?: number | null;
  salary_ratio?: number | null;
  planning_target_salary?: number | null;
  target_monthly_hours?: number | null;
  max_monthly_hours?: number | null;
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
  /**
   * Shifts a vehicle may carry on one operating day, at most `SHIFT_LIMITS`'s
   * 3 and that by default: the drivers decide how many shifts there are.
   */
  shiftsPerVehicleDay?: number;
  /**
   * Where the drive times come from. Absent is the labelled estimate. A
   * measured model expects `pool` to be the routed points and `base` to be
   * routed too; a pair without a route is never used.
   */
  travel?: TravelModel;
  /** How the routes and the addresses were obtained, recorded as given in the provenance. */
  routing?: RoutingProvenance;
  /** The company the month is simulated for, carried onto every repositioning record. */
  tenantId?: string;
  /** How the Betriebssitz is named on a repositioning record. */
  baseLabel?: string;
  /**
   * Where `base` came from (`resolveBase`): the saved point, or the company's
   * address geocoded at house level. Absent, the month cannot say that its
   * shifts start at the company's configured base, and its verdict says so.
   */
  baseSource?: BaseSource;
  /**
   * The company requires the car back at the base when a shift ends (D8, a
   * company setting, off by default). The drive home is then routed, counted
   * as working time inside the shift and recorded as a `to_base` leg.
   */
  returnToBase?: boolean;
  /** The company's `vehicle_unavailability` rows, read as instants (`readUnavailability`). */
  vehicleUnavailability?: readonly UnavailabilityWindow[];
  /**
   * What Uber reported for the month (`readUberMonth`). Absent: no Uber figure
   * was read, and no ride carries a tip, because a tip is never drawn.
   */
  uber?: ReconcileUber;
  /**
   * The company's share setting (section 5). The share is taken of the
   * imported `umsatz` and shown, never booked. Absent: no rate is applied, and
   * the financial status says so.
   */
  shareSetting?: ShareSetting | null;
  /** Operating days that already hold real trips, by driver UUID: never simulated over. */
  realTripDays?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * The month's real trips (`readRealTrips`). Absent: nobody looked, and the
   * month cannot say it simulated over no real driver-day, so it is
   * VERIFICATION_INCOMPLETE. Present, they are carried unchanged, their
   * driver-days are not simulated, their vehicles are held while they ran, and
   * their drivers rest before and after them.
   */
  realTrips?: RealTripsRead;
}

/** What the caller measured before the month was built, printed on the source sheet. */
export interface RoutingProvenance {
  /** Points the matrix covers, the base included. */
  points: number;
  routedPairs: number;
  failedPairs: number;
  failuresByReason: Record<string, number>;
  computedAt: string | null;
  /** Pool addresses checked against the geocoder, and how many were kept. */
  addressesChecked?: number;
  addressesKept?: number;
  addressesDroppedByReason?: Record<string, number>;
  geocoderSource?: string | null;
}

/** Why a day, or a shift, carries no ride. One code per cause, stable. */
export type CapacityReason =
  | 'no_vehicle_in_fleet'
  | 'no_driver_in_pool'
  | 'operating_day_has_no_start_instant'
  | 'no_vehicle_free'
  | 'driver_blocked_by_note'
  | 'driver_weekday_not_allowed'
  | 'driver_resting'
  | 'driver_not_needed'
  | 'driver_window_too_short'
  | 'driver_window_unreadable'
  | 'driver_no_uber_activity'
  | 'driver_has_real_trips'
  | 'driver_configuration_required'
  | 'shift_produced_no_ride'
  | 'vehicle_tuev_expired'
  | 'vehicle_unavailable';

/** One refusal, kept so the summary can say what was not generated and why. */
export interface CapacityRefusal {
  day: string;
  reason: CapacityReason;
  /** The vehicle's plate, where the refusal names one. */
  plate?: string;
  /** The driver's UUID, where the refusal names one. */
  driverId?: string;
  /** The note that blocked him, for `driver_blocked_by_note`; the window's reason for `vehicle_unavailable`. */
  noteType?: string;
  /** Its id (`unavailability:<id>` for a vehicle window), so the decision row names the event itself. */
  noteId?: string;
}

/** One day of the month, including a day with nothing on it. */
export interface DaySummary {
  day: string;
  isoWeekday: number;
  /** 23 or 25 on a transition day, 24 otherwise. */
  hours: number;
  shifts: number;
  /** The day's rides in the Fahrtenbuch report: completed and cancelled. */
  rides: number;
  completed: number;
  cancelled: number;
  /** Declined orders of the day. Internal: in no figure of the report. */
  declined: number;
  fareCents: number;
  tipCents: number;
  cancelledFeeCents: number;
  /** The declined orders' fees. Internal, like `declined`. */
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
    /** `vehicle_unavailability` windows read. */
    vehicleUnavailability: number;
    /** Drivers whose month could be planned from the Drivers page. */
    driversPlanned: number;
    /** Uber rows read: per-day rows and period totals. */
    uberDays: number;
    uberPeriods: number;
  };
  /** Always true. The month is simulated and says so in its own record. */
  simulated: true;
  /** The model every drive time came from. `measured: false` is the haversine estimate. */
  travel: { source: string; measured: boolean };
  routing: RoutingProvenance | null;
  /** The company the month was simulated for, when the caller named it. */
  tenantId: string | null;
  /** The point every shift leaves from, where it came from (null: not stated) and its name. */
  base: { lat: number; lon: number; source: BaseSource | null; label: string };
  /** Whether the company requires the car back at the base when a shift ends. */
  returnToBase: boolean;
  /** The real trips read for the month; null when none were read. */
  realTrips: { trips: number; driverDays: number; unattributed: number; unreadableAmounts: number; digest: string } | null;
  /** What the tips and the share were reconciled against: the Uber figures' digest and the share setting. */
  financial: { uberDigest: string | null; shareSetting: ShareSetting | null };
  /**
   * The run's identity: a hash of everything that built the month, so the same
   * inputs give the same id and a record can be traced to its month.
   */
  runId: string;
}

/**
 * Bumped whenever the generated month would differ for the same seed. A month
 * carries it so a figure can be traced to the code that made it.
 */
/**
 * The shift lengths a calendar month is read back against: no floor, because a
 * driver's own range decides how short his day is (Round 8), and the
 * 360-minute ceiling, because a longer shift needs a break the generator does
 * not place (§4 ArbZG). The weeks generator keeps `SHIFT_LIMITS`' 240 to 360.
 */
export const CALENDAR_SHIFT_LIMITS = { minMinutes: 0, maxMinutes: MAX_DAY_MINUTES } as const;

export const FULL_MONTH_GENERATOR_VERSION = 'full-month/4.0.0';

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
  /** Every placed shift, and every refusal collapsed per day, vehicle, driver and reason. */
  decisions: ShiftDecision[];
  /** The route check of the month, read back from the rides with the model they were built with. */
  routeChecks: RouteCheck[];
  routeSummary: RouteCheckSummary;
  /** Every empty drive, as a record of its own. Never a ride row. */
  repositioning: RepositioningLeg[];
  repositioningSummary: RepositioningSummary;
  /**
   * The declined orders' money, counted apart. Internal: it is in no total of
   * the Fahrtenbuch report and in no basis of the monthly share.
   */
  internal: { declined: RevenueBreakdown };
  /** How each accepted shift was scheduled: what the ride loop refused before it stopped. */
  scheduling: SchedulingRecord[];
  /** Every driver's month as planned from the Drivers page, before any vehicle was chosen. */
  driverPlans: DriverMonthPlan[];
  /** What became of each plan: the minutes actually placed, against his range. */
  driverOutcomes: DriverMonthOutcome[];
  /** The vehicle windows the month was built around. */
  vehicleUnavailability: UnavailabilityWindow[];
  /** The month's real trips exactly as read (`IMPORTIERT`); null when none were read. */
  realTrips: RealTripsRead | null;
  /**
   * The money against Uber (section 5 and 6): the tips' allocation, the share
   * per driver-day and the financial status. Separate from the export verdict
   * (D10): an unconfigured share never blocks a valid Fahrtenbuch.
   */
  financial: FinancialReconciliation;
}

/** One driver's month as built, against what was planned for him. */
export interface DriverMonthOutcome {
  driverId: string;
  driverName: string;
  planned: boolean;
  /** Minutes the plan asked for. */
  plannedMinutes: number;
  /** Minutes of the shifts placed, each from its start to its planned end. */
  placedMinutes: number;
  placedShifts: number;
  /** Planned driver-days on which no shift could be placed, with the refusal that stopped it. */
  missedDays: { date: string; reason: CapacityReason }[];
  /** The placed minutes against his range: a shortfall is reported here, never filled in. */
  assessment: RangeAssessment;
}

/** One accepted shift's scheduling record, for the operational report. */
export interface SchedulingRecord {
  shiftId: string;
  day: string;
  plate: string;
  driverId: string | null;
  startMs: number;
  plannedEndMs: number;
  endMs: number;
  /** What the last try found when the ride loop stopped. */
  endedBy: ShiftEnd;
  /** Tries of a step that found nothing, by what they found. */
  refusedSteps: Partial<Record<ShiftEnd, number>>;
}

export type FullMonthFailure =
  | { kind: 'settings'; problem: SettingsProblem }
  | { kind: 'options'; problem: NonNullable<ReturnType<typeof marginProblem>> }
  | { kind: 'month_out_of_range' }
  | { kind: 'address_pool_too_small' };

interface Busy {
  start: number;
  end: number;
}

const clash = (list: readonly Busy[] | undefined, s: number, e: number, buffer: number): boolean =>
  (list ?? []).some(b => s < b.end + buffer && e > b.start - buffer);

/**
 * The instants real trips occupy, by plate key and by driver. A trip without
 * both instants holds nothing here; its driver-day is still excluded by day.
 */
function realTripWindows(trips: readonly RealTrip[]): { byPlate: Map<string, Busy[]>; byDriver: Map<string, Busy[]> } {
  const byPlate = new Map<string, Busy[]>();
  const byDriver = new Map<string, Busy[]>();
  for (const t of trips) {
    if (t.startMs === null || t.endMs === null || t.endMs < t.startMs) continue;
    const held = { start: t.startMs, end: t.endMs };
    if (t.plate) byPlate.set(plateKey(t.plate), [...(byPlate.get(plateKey(t.plate)) ?? []), held]);
    if (t.driverId) byDriver.set(t.driverId, [...(byDriver.get(t.driverId) ?? []), held]);
  }
  return { byPlate, byDriver };
}

/**
 * The read-back for §4: a simulated shift never lies on a real driver-day,
 * never takes a vehicle while a real trip ran in it (with the vehicle gap),
 * never cuts the driver's rest before or after a real trip, and no simulated
 * ride carries a real trip's id. Returns one line per broken rule.
 */
export function checkRealTrips(month: GeneratedMonth, real: RealTripsRead | null, opts: GeneratorOptions): string[] {
  if (!real || real.trips.length === 0) return [];
  const out: string[] = [];
  const held = realTripWindows(real.trips);
  const gapMs = opts.minVehicleGapMinutes * 60_000;
  const restMs = opts.minDriverRestMinutes * 60_000;
  for (const s of month.shifts) {
    const end = s.plannedEndMs ?? s.endMs;
    const driverId = s.driver.id;
    // Never produced in calendar mode; if it were, the rules below could not be checked, so it is reported, not passed.
    if (driverId === undefined) out.push(`${s.id}: the shift names no driver id, so it cannot be checked against the real trips`);
    else if (real.days.get(driverId)?.has(s.operatingDay)) {
      out.push(`${s.id}: driver ${driverId} has real trips on ${s.operatingDay} and was simulated over`);
    }
    if (clash(held.byPlate.get(plateKey(s.vehicle.plate)), s.startMs, end, gapMs)) {
      out.push(`${s.id}: vehicle ${s.vehicle.plate} is held by a real trip during the shift`);
    }
    if (driverId !== undefined && clash(held.byDriver.get(driverId), s.startMs, end, restMs)) {
      out.push(`${s.id}: driver ${driverId} has a real trip within the rest before or after the shift`);
    }
  }
  const realIds = new Set(real.trips.map(t => t.tripId));
  for (const r of month.rides) {
    if (r.tripId && realIds.has(r.tripId)) out.push(`${r.tripId}: a simulated ride carries a real trip's id`);
  }
  return out;
}

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
  const optionsProblem = marginProblem(opts);
  if (optionsProblem) return { ok: false, failure: { kind: 'options', problem: optionsProblem } };
  const shiftsPerVehicleDay = Math.max(
    1,
    Math.min(SHIFT_LIMITS.maxPerVehicleDay, input.shiftsPerVehicleDay ?? SHIFT_LIMITS.maxPerVehicleDay),
  );
  const ctx: Context = {
    rng: createRng(input.seed),
    opts,
    base: input.base,
    pool: input.pool,
    usedTransmits: new Set(),
    travel: input.travel,
    returnToBase: input.returnToBase === true,
  };
  const travel = input.travel ?? ESTIMATE_TRAVEL_MODEL;
  const baseLabel = input.baseLabel ?? 'Betriebssitz';

  const period = buildPeriod(input.year, input.month, settings);
  const accepted: ShiftDecision[] = [];
  const scheduling: SchedulingRecord[] = [];
  const month: GeneratedMonth = { shifts: [], rides: [], droppedShifts: 0 };
  const refusals: CapacityRefusal[] = [];
  const vehicleBusy = new Map<string, Busy[]>();
  const driverLastEnd = new Map<string, number>();
  let nextShift = 1;
  // A real trip holds its vehicle while it ran and is part of its driver's
  // working time: a simulated shift keeps the vehicle gap and the driver's rest
  // from both, exactly as from a simulated shift.
  const realHeld = realTripWindows(input.realTrips?.trips ?? []);
  for (const v of input.vehicles) {
    const held = realHeld.byPlate.get(plateKey(v.plate));
    if (held) vehicleBusy.set(v.plate, [...held]);
  }

  const pool = input.drivers.filter(d => d.planning_enabled !== false && isActiveDriver(d));
  // A negative workshop check is reported, not confirmed, and names no window:
  // the shift on that vehicle that day runs and is marked for a person to review.
  const workshopOn = new Map<string, WerkstattCheckRow>();
  for (const check of input.werkstattChecks ?? []) {
    if (check.status === 'negative') workshopOn.set(`${check.car_id}|${check.check_date}`, check);
  }

  // Every driver's month is planned before any vehicle is looked at.
  const uber = input.uber
    ? uberActivity(input.uber)
    : { activeDays: new Map<string, Set<string>>(), weeklyOnly: new Set<string>() };
  const driverPlans = input.drivers.map(d => planDriverMonth(planConfigOf(d), {
    year: input.year,
    month: input.month,
    settings,
    notes: input.driverNotesMap,
    uberActiveDays: uber.activeDays,
    uberWeeklyOnly: uber.weeklyOnly,
    realTripDays: input.realTrips?.days ?? input.realTripDays,
  }));
  const planByDriver = new Map(driverPlans.map(p => [p.driverId, p]));
  const dayPlanOf = new Map(driverPlans.flatMap(p => p.days.map(d => [`${p.driverId}|${d.date}`, d] as const)));
  const unavailability = input.vehicleUnavailability ?? [];
  const missed = new Map<string, { date: string; reason: CapacityReason }[]>();

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

    // The vehicles' own state for the day, recorded once per vehicle. An
    // expired TÜV keeps a vehicle off the road all day; an unavailability
    // window only for the shifts it overlaps, which `placeDriverShift` asks.
    const usable: FullMonthVehicle[] = [];
    const tuevOf = new Map<string, ReturnType<typeof vehicleVerdict>>();
    for (const vehicle of input.vehicles) {
      const verdict = vehicleVerdict(vehicle, day.day);
      if (verdict.kind === 'blocked') {
        refusals.push({ day: day.day, reason: 'vehicle_tuev_expired', plate: vehicle.plate });
        continue;
      }
      const window = unavailableDuring(unavailability, vehicle.id, day.startMs, dayEndMs);
      if (window) {
        refusals.push({
          day: day.day, reason: 'vehicle_unavailable', plate: vehicle.plate, noteType: window.reason, noteId: `unavailability:${window.id}`,
        });
      }
      tuevOf.set(vehicle.plate, verdict);
      usable.push(vehicle);
    }

    // The day's planned drivers, in an order drawn per day, so the first
    // driver of the list is not always the first to choose a vehicle.
    const planned: { driver: FullMonthDriver; plan: DriverDayPlan }[] = [];
    for (const driver of pool) {
      const dayPlan = dayPlanOf.get(`${driver.id}|${day.day}`);
      if (!dayPlan) continue;
      if (dayPlan.status === 'planned' && dayPlan.plannedMinutes > 0) {
        planned.push({ driver, plan: dayPlan });
        continue;
      }
      const refusal = dayRefusal(day.day, driver.id, dayPlan, planByDriver.get(driver.id));
      if (refusal) refusals.push(refusal);
    }
    shuffleInPlace(planned, ctx.rng);

    const shiftsOn = new Map<string, number>();
    for (const { driver, plan } of planned) {
      const placed = placeDriverShift({
        ctx,
        day,
        driver,
        plan,
        vehicles: usable,
        unavailability,
        shiftsPerVehicleDay,
        shiftsOn,
        notes: input.driverNotesMap,
        vehicleBusy,
        driverLastEnd,
        driverReal: realHeld.byDriver,
        refusals,
        shiftId: `S${nextShift}`,
      });
      if (!placed.ok) {
        month.droppedShifts += 1;
        missed.set(driver.id, [...(missed.get(driver.id) ?? []), { date: day.day, reason: placed.reason }]);
        continue;
      }
      const vehicle = placed.vehicle;
      nextShift += 1;
      month.shifts.push(placed.shift);
      month.rides.push(...placed.rides);
      scheduling.push({
        shiftId: placed.shift.id,
        day: day.day,
        plate: vehicle.plate,
        driverId: driver.id,
        startMs: placed.shift.startMs,
        plannedEndMs: placed.plannedEndMs,
        endMs: placed.shift.endMs,
        endedBy: placed.endedBy,
        refusedSteps: placed.refusedSteps,
      });
      const verdict = tuevOf.get(vehicle.plate) ?? vehicleVerdict(vehicle, day.day);
      const workshop = workshopOn.get(`${vehicle.id}|${day.day}`) ?? null;
      const reviews = [
        ...placed.review.map(n => `Notiz ${n.note_type} ohne bestätigten Zeitraum - nicht sperrend, bitte prüfen`),
        ...(verdict.kind === 'review' ? [verdict.reason] : []),
        ...(workshop ? [`Werkstatt-Prüfung negativ am ${workshop.check_date} - kein Ausfallzeitraum erfasst, nicht sperrend, bitte prüfen`] : []),
      ];
      const review = reviewOf(placed.review, verdict, workshop);
      accepted.push({
        day: day.day,
        plate: vehicle.plate,
        vehicleId: vehicle.id,
        driverId: driver.id,
        outcome: reviews.length > 0 ? 'accepted_with_review' : 'accepted',
        code: review?.code ?? 'accepted',
        reason: reviews.length > 0 ? reviews.join('; ') : 'Keine bestätigte Einschränkung im Zeitraum',
        eventRef: review?.eventRef ?? null,
        certainty: review?.certainty ?? null,
        startMs: placed.shift.startMs,
        endMs: placed.shift.endMs,
        count: 1,
      });
    }
  }
  const driverOutcomes = driverPlans.map(plan => outcomeOf(plan, month.shifts, missed.get(plan.driverId) ?? []));

  // A cancellation earns nothing unless the tenant says so (decision 3 of
  // 29.10.2026), and that fee is `declineFeeOf`'s, a field of its own. The
  // generator's own draw from CANCELLATION_FEES stays drawn, so the random
  // stream and every later ride are what they were; only the cell is zero.
  for (const ride of month.rides) if (ride.status === 'cancelled') ride.fare = 0;

  // After every shift, so the shared random stream and every completed ride's
  // transmission instant are exactly what they are with the feature off.
  month.rides.push(
    ...declinedOrders(month.shifts, month.rides, settings, ctx.usedTransmits, input.pool, input.seed, opts.appPaymentShare),
  );
  month.rides.sort((a, b) => a.orderTransmittedMs - b.orderTransmittedMs);
  // The month's ride list is final here, so every order gets its identity now,
  // in transmission order. The report's rides and the declined orders count
  // in two series (F, AB): a ride's id is the same whether declined orders
  // were generated or not, and no id in the Fahrtenbuch report has a gap
  // where an order it does not hold would be.
  let rideNo = 0;
  let declinedNo = 0;
  for (const ride of month.rides) {
    ride.tripId = inExportScope(ride)
      ? `F${String(++rideNo).padStart(5, '0')}`
      : `AB${String(++declinedNo).padStart(5, '0')}`;
  }

  // Section 6: no tip is drawn. The generator's draw stays drawn, so the
  // shared random stream and every ride are what they were; every tip is then
  // discarded and the imported Trinkgeld is spread over the driver's own
  // completed rides of its day (or week), exactly, to the cent.
  const tipAllocations = allocateImportedTips({ uber: input.uber ?? null, rides: month.rides, shifts: month.shifts, seed: input.seed });
  const financial = reconcileMonth({
    uber: input.uber ?? null,
    rides: month.rides,
    shifts: month.shifts,
    allocations: tipAllocations,
    shareSetting: input.shareSetting ?? null,
  });

  // The Fahrtenbuch report's money is counted over its own rides only. A
  // declined order's fee is counted apart and reaches none of it.
  const revenue = countRevenue(month.rides.filter(inExportScope), settings);
  const declined = countRevenue(month.rides.filter(r => !inExportScope(r)), settings);
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
      vehicleUnavailability: unavailability.length,
      driversPlanned: driverPlans.filter(p => p.planned).length,
      uberDays: input.uber?.days.length ?? 0,
      uberPeriods: input.uber?.periods.length ?? 0,
    },
    simulated: true,
    travel: { source: travel.source, measured: travel.measured },
    routing: input.routing ?? null,
    tenantId: input.tenantId ?? null,
    base: { lat: input.base.lat, lon: input.base.lon, source: input.baseSource ?? null, label: baseLabel },
    returnToBase: ctx.returnToBase === true,
    realTrips: input.realTrips ? {
      trips: input.realTrips.trips.length,
      driverDays: [...input.realTrips.days.values()].reduce((n, days) => n + days.size, 0),
      unattributed: input.realTrips.unattributed.length,
      unreadableAmounts: input.realTrips.unreadableAmounts.length,
      digest: fnv1a(input.realTrips.trips.map(t => `${t.tripId}|${t.operatingDay}|${t.driverId ?? ''}|${t.plate ?? ''}|${t.startMs ?? ''}|${t.endMs ?? ''}`).join('\n')),
    } : null,
    financial: { uberDigest: uberDigestOf(input.uber), shareSetting: input.shareSetting ?? null },
    runId: '',
  };
  provenance.runId = runIdOf(provenance);

  const checks = routeChecks(month.rides, travel, opts);
  const repositioning = buildRepositioningLegs(month.shifts, month.rides, {
    base: input.base,
    baseLabel,
    travel,
    margins: opts,
    tenantId: provenance.tenantId,
    vehicleIdByPlate: new Map(input.vehicles.map(v => [v.plate, v.id])),
    seed: provenance.seed,
    runId: provenance.runId,
    returnToBase: provenance.returnToBase,
  });
  const decisions = [...accepted, ...collapseDecisions(refusals.map(refusalDecision(input.vehicles)))];

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
      violations: [
        ...validateFullMonth(month, period, input.driverNotesMap, settings, input.vehicles),
        ...checkDriverShifts(month.shifts, driverPlans, unavailability, opts.minDriverRestMinutes),
        ...validateRides(month, input.base, travel, opts, CALENDAR_SHIFT_LIMITS, provenance.returnToBase),
        ...checkRealTrips(month, input.realTrips ?? null, opts),
        ...financial.violations,
      ],
      decisions,
      routeChecks: checks,
      routeSummary: summariseRouteChecks(checks),
      repositioning,
      repositioningSummary: summariseRepositioning(repositioning),
      internal: { declined },
      scheduling,
      driverPlans,
      driverOutcomes,
      vehicleUnavailability: [...unavailability],
      realTrips: input.realTrips ?? null,
      financial,
    },
  };
}

/** The imported figures a run reconciled against, as one hash; null when none were read. */
function uberDigestOf(uber: ReconcileUber | undefined): string | null {
  if (!uber) return null;
  const f = (x: { umsatzCents: number; aktionenCents: number; trinkgeldCents: number; bargeldCents: number }) =>
    `${x.umsatzCents}|${x.aktionenCents}|${x.trinkgeldCents}|${x.bargeldCents}`;
  return fnv1a([
    ...uber.days.map(d => `D|${d.driverId}|${d.date}|${f(d.figures)}|${d.overlapsPeriod}`),
    ...uber.periods.map(p => `P|${p.driverId}|${p.periodStart}|${p.periodEnd}|${p.placement}|${f(p.figures)}|${p.overlappingDailyDates.join(',')}`),
    `H|${uber.handRows?.length ?? 0}|I|${uber.issues?.length ?? 0}`,
  ].join('\n'));
}

/** The review a shift is accepted with, most specific first: a note, the TÜV, a workshop check. */
function reviewOf(
  notes: readonly StructuredNote[],
  verdict: ReturnType<typeof vehicleVerdict>,
  workshop: WerkstattCheckRow | null,
): Pick<ShiftDecision, 'code' | 'eventRef' | 'certainty'> | null {
  if (notes.length > 0) return { code: 'unconfirmed_note', eventRef: notes[0].id ?? null, certainty: 'assumed_from_notice_date' };
  if (verdict.kind === 'review') return { code: verdict.code, eventRef: 'tuev', certainty: 'reported' };
  if (workshop) return { code: 'werkstatt_negative', eventRef: `werkstatt:${workshop.check_date}`, certainty: 'reported' };
  return null;
}

/** The run's id: the period, the seed and a hash of everything else that built it. */
function runIdOf(p: Provenance): string {
  const mm = String(p.month).padStart(2, '0');
  const basis = JSON.stringify([p.generatorVersion, p.tenantId, p.seed, p.year, p.month, p.settings, p.options,
    p.shiftsPerVehicleDay, p.inputs, p.travel, p.routing?.computedAt ?? null, p.base, p.returnToBase, p.realTrips, p.financial]);
  return `SIM-${p.year}-${mm}-${p.seed}-${fnv1a(basis)}`;
}

const REFUSAL_TEXT: Record<CapacityReason, string> = {
  no_vehicle_in_fleet: 'Kein Fahrzeug im Bestand',
  no_driver_in_pool: 'Kein Fahrer im Pool',
  operating_day_has_no_start_instant: 'Betriebstag hat keinen eindeutigen Startzeitpunkt (Zeitumstellung)',
  no_vehicle_free: 'Kein Fahrzeug im Fenster des Fahrers frei',
  driver_blocked_by_note: 'Bestätigte sperrende Notiz im Zeitfenster',
  driver_weekday_not_allowed: 'Wochentag für den Fahrer nicht erlaubt',
  driver_resting: 'Ruhezeit nach der letzten Schicht lässt im Fenster keinen Platz',
  driver_not_needed: 'Fahrer an diesem Tag nicht eingeplant - Monatsziel mit weniger Tagen erreicht',
  driver_window_too_short: 'Arbeitsfenster des Fahrers an diesem Tag zu kurz',
  driver_window_unreadable: 'Arbeitsfenster fällt in die Zeitumstellung und ist nicht eindeutig',
  driver_no_uber_activity: 'Uber meldet für den Fahrer an diesem Tag keine Fahrt',
  driver_has_real_trips: 'Fahrer hat an diesem Tag echte Fahrten - nicht simuliert',
  driver_configuration_required: 'Stundenrahmen oder Arbeitsfenster des Fahrers fehlt (CONFIGURATION_REQUIRED)',
  shift_produced_no_ride: 'Schicht ergab keine Fahrt (keine berechnete Route oder keine Zeit)',
  vehicle_tuev_expired: 'TÜV abgelaufen - Fahrzeug nicht eingesetzt',
  vehicle_unavailable: 'Fahrzeug laut Ausfallzeitraum nicht verfügbar',
};

/** Refusals that rest on a recorded event with its own window, not on a drawn moment. */
const CONFIRMED_REFUSALS: ReadonlySet<CapacityReason> = new Set(['driver_blocked_by_note', 'vehicle_tuev_expired', 'vehicle_unavailable']);

function refusalDecision(vehicles: readonly FullMonthVehicle[]) {
  const idByPlate = new Map(vehicles.map(v => [v.plate, v.id]));
  return (r: CapacityRefusal): ShiftDecision => ({
    day: r.day,
    plate: r.plate ?? '',
    vehicleId: r.plate ? idByPlate.get(r.plate) ?? null : null,
    driverId: r.driverId ?? null,
    outcome: 'excluded',
    code: r.reason,
    reason: r.noteType ? `${REFUSAL_TEXT[r.reason]} (${r.noteType})` : REFUSAL_TEXT[r.reason],
    eventRef: r.noteId ?? (r.reason === 'vehicle_tuev_expired' ? 'tuev' : null),
    certainty: CONFIRMED_REFUSALS.has(r.reason) ? 'confirmed' : null,
    startMs: null,
    endMs: null,
    count: 1,
  });
}

function computeShare(basis: RevenueBasis, input: FullMonthInput): { rate: MonthlyShareRate; result: ShareResult } | null {
  const rate = selectMonthlyShareRate(input.seed, input.year, input.month);
  const applied = applyMonthlyShare(basis.basisCents, rate.rateBasisPoints);
  return applied.ok ? { rate, result: applied.result } : null;
}

const isActiveDriver = (d: FullMonthDriver): boolean => d.status == null || d.status === 'active';

/** A driver as `planDriverMonth` reads him. A null status is the column's default, `active`. */
function planConfigOf(d: FullMonthDriver): DriverPlanConfig {
  return {
    id: d.id,
    name: d.name,
    status: isActiveDriver(d) ? 'active' : 'inactive',
    employmentType: d.employment_type ?? null,
    planningEnabled: d.planning_enabled ?? null,
    allowedWeekdays: d.allowed_weekdays ?? null,
    workWindowStart: d.work_window_start ?? null,
    workWindowEnd: d.work_window_end ?? null,
    isFullDayAvailable: d.is_full_day_available ?? null,
    minSalary: d.planning_min_salary ?? null,
    maxSalary: d.planning_max_salary ?? null,
    hourlyRate: d.planning_hourly_rate ?? null,
    salaryRatio: d.salary_ratio ?? null,
    targetSalary: d.planning_target_salary ?? null,
    targetMonthlyHours: d.target_monthly_hours ?? null,
    maxMonthlyHours: d.max_monthly_hours ?? null,
  };
}

/** Why a driver has no shift on a day his plan did not give him, or null when nothing needs saying. */
function dayRefusal(day: string, driverId: string, d: DriverDayPlan, plan: DriverMonthPlan | undefined): CapacityRefusal | null {
  const note = d.blockingNote ? { noteType: d.blockingNote.type, noteId: d.blockingNote.id } : {};
  switch (d.status) {
    case 'weekday_not_allowed': return { day, reason: 'driver_weekday_not_allowed', driverId };
    case 'absent': return { day, reason: 'driver_blocked_by_note', driverId, ...note };
    case 'window_too_short': return { day, reason: 'driver_window_too_short', driverId, ...note };
    case 'clock_unreadable': return { day, reason: 'driver_window_unreadable', driverId };
    case 'no_uber_activity': return { day, reason: 'driver_no_uber_activity', driverId };
    case 'real_trips': return { day, reason: 'driver_has_real_trips', driverId };
    case 'not_needed': return { day, reason: 'driver_not_needed', driverId };
    case 'driver_not_planned':
      return plan?.notPlannedReason === 'configuration_required' ? { day, reason: 'driver_configuration_required', driverId } : null;
    default: return null;
  }
}

/** Fisher–Yates on the month's own stream, so the order is the seed's. */
function shuffleInPlace<T>(items: T[], rng: Context['rng']): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [items[i], items[j]] = [items[j], items[i]];
  }
}

const QUARTER_MS = 15 * 60_000;

interface DriverShiftArgs {
  ctx: Context;
  day: PeriodDay;
  driver: FullMonthDriver;
  plan: DriverDayPlan;
  /** The day's vehicles with a valid TÜV. */
  vehicles: readonly FullMonthVehicle[];
  unavailability: readonly UnavailabilityWindow[];
  shiftsPerVehicleDay: number;
  /** Shifts already placed today, by plate. */
  shiftsOn: Map<string, number>;
  notes: Map<string, StructuredNote[]>;
  vehicleBusy: Map<string, Busy[]>;
  driverLastEnd: Map<string, number>;
  /** The driver's real trips, as instants: rest is kept from them as from a shift. */
  driverReal: ReadonlyMap<string, readonly Busy[]>;
  refusals: CapacityRefusal[];
  shiftId: string;
}

type DriverShift =
  | {
      ok: true;
      shift: SimShift;
      vehicle: FullMonthVehicle;
      rides: SimRide[];
      review: StructuredNote[];
      plannedEndMs: number;
      endedBy: ShiftEnd;
      refusedSteps: Partial<Record<ShiftEnd, number>>;
    }
  | { ok: false; reason: CapacityReason };

/**
 * The planned driver-day's shift, or the reason there is none.
 *
 * The length is the plan's, exactly; only the start is drawn, on a quarter-hour
 * grid inside the driver's window and after his rest. The vehicle is chosen
 * for that window: a valid TÜV (the caller passes only those), outside every
 * unavailability window, free with the gap between two shifts, and under the
 * day's shift cap. The vehicle is held, and the driver's rest counts, to the
 * planned end — he is on duty until then whether or not an order came.
 */
function placeDriverShift(args: DriverShiftArgs): DriverShift {
  const { ctx, day, driver, plan, refusals } = args;
  const { rng, opts } = ctx;
  const refuse = (reason: CapacityReason, extra: Partial<CapacityRefusal> = {}): DriverShift => {
    refusals.push({ day: day.day, reason, driverId: driver.id, ...extra });
    return { ok: false, reason };
  };
  if (plan.windowStartMs === null || plan.windowEndMs === null) return refuse('driver_window_unreadable');
  const lengthMs = plan.plannedMinutes * 60_000;
  const restMs = opts.minDriverRestMinutes * 60_000;
  const { windowStartMs, windowEndMs } = plan;
  const real = args.driverReal.get(driver.id) ?? [];
  const earliest = Math.max(windowStartMs, (args.driverLastEnd.get(driver.id) ?? -Infinity) + restMs,
    ...real.filter(b => b.end <= windowEndMs).map(b => b.end + restMs));
  const latestEnd = Math.min(windowEndMs, ...real.filter(b => b.start >= windowStartMs).map(b => b.start - restMs));
  const latestStart = latestEnd - lengthMs;
  if (earliest > latestStart) return refuse('driver_resting');
  const slots = Math.floor((latestStart - earliest) / QUARTER_MS);
  const vehicleGap = opts.minVehicleGapMinutes * 60_000;

  let lastProblem: CapacityReason = 'no_vehicle_free';
  for (let attempt = 0; attempt < 12; attempt++) {
    const startMs = earliest + rng.int(0, slots) * QUARTER_MS;
    const endMs = startMs + lengthMs;
    // The plan cut the window around every confirmed note already; asked again
    // so a note the plan missed blocks here rather than in the read-back.
    const verdict = noteVerdict(driver.id, startMs, endMs, args.notes);
    if (verdict.blocking) {
      refusals.push({
        day: day.day, reason: 'driver_blocked_by_note', driverId: driver.id, noteType: verdict.blocking.note_type, noteId: verdict.blocking.id,
      });
      lastProblem = 'driver_blocked_by_note';
      continue;
    }
    const free = args.vehicles.filter(v => (args.shiftsOn.get(v.plate) ?? 0) < args.shiftsPerVehicleDay
      && !clash(args.vehicleBusy.get(v.plate), startMs, endMs, vehicleGap)
      && !unavailableDuring(args.unavailability, v.id, startMs, endMs));
    if (free.length === 0) {
      lastProblem = 'no_vehicle_free';
      continue;
    }
    const vehicle = rng.pick(free);
    const planned: PlannedShift = { vehicle, startMs, plannedEndMs: endMs, operatingDay: day.day };
    const run = runShift(ctx, planned, { shiftId: args.shiftId, vehicle, driver });
    if (!run) {
      refusals.push({ day: day.day, reason: 'shift_produced_no_ride', plate: vehicle.plate, driverId: driver.id });
      lastProblem = 'shift_produced_no_ride';
      continue;
    }
    args.vehicleBusy.set(vehicle.plate, [...(args.vehicleBusy.get(vehicle.plate) ?? []), { start: startMs, end: endMs }]);
    args.shiftsOn.set(vehicle.plate, (args.shiftsOn.get(vehicle.plate) ?? 0) + 1);
    args.driverLastEnd.set(driver.id, endMs);
    return {
      ok: true,
      shift: { id: args.shiftId, vehicle, driver, operatingDay: day.day, startMs, endMs: run.endMs, plannedEndMs: endMs },
      vehicle,
      rides: run.rides,
      review: verdict.review,
      plannedEndMs: endMs,
      endedBy: run.endedBy,
      refusedSteps: run.refusedSteps,
    };
  }
  return lastProblem === 'no_vehicle_free' ? refuse('no_vehicle_free') : { ok: false, reason: lastProblem };
}

/** The minutes of a shift the driver is on duty: start to planned end. */
const dutyMinutes = (s: SimShift): number => ((s.plannedEndMs ?? s.endMs) - s.startMs) / 60_000;

function outcomeOf(plan: DriverMonthPlan, shifts: readonly SimShift[], missed: { date: string; reason: CapacityReason }[]): DriverMonthOutcome {
  const own = shifts.filter(s => s.driver.id === plan.driverId);
  const placedMinutes = own.reduce((n, s) => n + dutyMinutes(s), 0);
  return {
    driverId: plan.driverId,
    driverName: plan.driverName,
    planned: plan.planned,
    plannedMinutes: plan.plannedMinutes,
    placedMinutes,
    placedShifts: own.length,
    missedDays: missed,
    assessment: assessAgainstRange(placedMinutes, plan.range, plan.isOwner),
  };
}

/**
 * The driver-led rules, read back from the shifts (Round 8). Each shift names
 * its driver by UUID, lies on a day his plan gave him and inside that day's
 * window, is at most 360 minutes from start to planned end, ends its last
 * ride by the planned end and does not touch its vehicle's unavailability
 * window. Per driver: one shift per operating day, the rest between two
 * shifts, and (but for the owner) no more minutes than his range's maximum.
 */
export function checkDriverShifts(
  shifts: readonly SimShift[],
  plans: readonly DriverMonthPlan[],
  unavailability: readonly UnavailabilityWindow[],
  restMinutes: number,
): string[] {
  const out: string[] = [];
  const dayPlan = new Map(plans.flatMap(p => p.days.map(d => [`${p.driverId}|${d.date}`, d] as const)));
  const planOf = new Map(plans.map(p => [p.driverId, p]));
  const byDriver = new Map<string, SimShift[]>();

  for (const s of shifts) {
    const id = s.driver.id;
    if (typeof id !== 'string' || id === '') {
      out.push(`${s.id}: the shift names no driver id`);
      continue;
    }
    byDriver.set(id, [...(byDriver.get(id) ?? []), s]);
    const end = s.plannedEndMs ?? s.endMs;
    const minutes = (end - s.startMs) / 60_000;
    if (minutes > MAX_DAY_MINUTES) out.push(`${s.id}: a shift of ${minutes} minutes is longer than ${MAX_DAY_MINUTES}`);
    if (s.endMs > end) out.push(`${s.id}: the last ride ends after the shift's planned end`);
    const d = dayPlan.get(`${id}|${s.operatingDay}`);
    if (!d || d.status !== 'planned') {
      out.push(`${s.id}: driver ${id} is not planned on ${s.operatingDay}`);
    } else if (d.windowStartMs === null || d.windowEndMs === null || s.startMs < d.windowStartMs || end > d.windowEndMs) {
      out.push(`${s.id}: the shift lies outside driver ${id}'s window on ${s.operatingDay}`);
    }
    if (!s.vehicle.id) out.push(`${s.id}: the shift names no vehicle id`);
    const window = s.vehicle.id ? unavailableDuring(unavailability, s.vehicle.id, s.startMs, end) : null;
    if (window) out.push(`${s.id}: runs on ${s.vehicle.plate} inside its unavailability window ${window.id} (${window.reason})`);
  }

  for (const [id, list] of byDriver) {
    const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
    const days = new Set<string>();
    for (const [i, s] of sorted.entries()) {
      if (days.has(s.operatingDay)) out.push(`driver ${id}: two shifts on ${s.operatingDay}`);
      days.add(s.operatingDay);
      const prev = sorted[i - 1];
      if (prev && s.startMs < (prev.plannedEndMs ?? prev.endMs) + restMinutes * 60_000) {
        out.push(`driver ${id}: ${prev.id} and ${s.id} leave less than ${restMinutes} minutes of rest`);
      }
    }
    const plan = planOf.get(id);
    const total = sorted.reduce((n, s) => n + dutyMinutes(s), 0);
    const max = plan && !plan.isOwner ? plan.range.effectiveMaxHours : null;
    if (max !== null && total > max * 60 + 1e-6) {
      out.push(`driver ${id}: ${total} minutes in the month exceed the maximum of ${Math.floor(max * 60)}`);
    }
  }
  return out;
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
  rides: readonly SimRide[],
  settings: SimulationTenantSettings,
  usedTransmits: Set<number>,
  pool: readonly PoolAddress[],
  seed: number,
  appPaymentShare: number,
): SimRide[] {
  if (!settings.declinedRidesEnabled || settings.declinedShare <= 0) return [];
  const rng = createRng(declinedStreamSeed(seed));
  const out: SimRide[] = [];
  const busyByShift = new Map<string, Busy[]>();
  for (const r of rides) {
    if (r.status !== 'completed' || r.startMs === null || r.endMs === null) continue;
    busyByShift.set(r.shiftId, [...(busyByShift.get(r.shiftId) ?? []), { start: r.startMs, end: r.endMs }]);
  }
  for (const shift of shifts) {
    if (shift.endMs <= shift.startMs) continue;
    const idle = idleSegments(shift, busyByShift.get(shift.id) ?? []);
    const idleMs = idle.reduce((n, seg) => n + (seg.end - seg.start), 0);
    if (idleMs <= 0) continue;
    // One draw per hour of the shift, so the share reads as "a share of orders"
    // at any shift length rather than as a flat count per shift.
    const hours = Math.max(1, Math.round((shift.endMs - shift.startMs) / 3_600_000));
    for (let i = 0; i < hours; i++) {
      if (!rng.chance(settings.declinedShare)) continue;
      const at = instantInIdle(idle, rng.int(0, idleMs - 1));
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
        declineRule: DECLINE_RULE_IDLE_IN_SHIFT,
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
 * The eligibility rule of a decline fee in the simulation: the order reached
 * the driver while the shift was running and no passenger was in the car. An
 * order offered mid-ride is not one a driver could take, and charging for
 * refusing it would invent a fee; the generator therefore only ever places a
 * declined order in idle time, and every declined ride names this rule.
 */
export const DECLINE_RULE_IDLE_IN_SHIFT = 'idle_in_shift';

/** The parts of a shift no completed ride occupies. */
function idleSegments(shift: SimShift, busy: readonly Busy[]): Busy[] {
  const sorted = [...busy].sort((a, b) => a.start - b.start);
  const out: Busy[] = [];
  let cursor = shift.startMs;
  for (const b of sorted) {
    if (b.start > cursor) out.push({ start: cursor, end: Math.min(b.start, shift.endMs) });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < shift.endMs) out.push({ start: cursor, end: shift.endMs });
  return out.filter(seg => seg.end > seg.start);
}

/** The instant `offsetMs` into the concatenated idle segments. */
function instantInIdle(idle: readonly Busy[], offsetMs: number): number {
  let left = offsetMs;
  for (const seg of idle) {
    const length = seg.end - seg.start;
    if (left < length) return seg.start + left;
    left -= length;
  }
  return idle[idle.length - 1].end - 1;
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
    const all = ridesByDay.get(day.day) ?? [];
    // The day's figures are the Fahrtenbuch report's: its own rides only. The
    // declined orders are counted beside them, for the internal report.
    const rides = all.filter(inExportScope);
    const breakdown = countRevenue(rides, settings);
    const declined = countRevenue(all.filter(r => !inExportScope(r)), settings);
    const dayRefusals = refusals.filter(r => r.day === day.day);
    const workedDrivers = new Set(rides.map(r => r.driver.id ?? `name:${r.driver.name}`));
    return {
      day: day.day,
      isoWeekday: day.isoWeekday,
      hours: day.hours,
      shifts: shiftsByDay.get(day.day) ?? 0,
      rides: rides.length,
      completed: breakdown.counts.completed,
      cancelled: breakdown.counts.cancelled,
      declined: declined.counts.declined,
      fareCents: breakdown.fareCents,
      tipCents: breakdown.tipCents,
      cancelledFeeCents: breakdown.cancelledFeeCents,
      declinedFeeCents: declined.declinedFeeCents,
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
  vehicles: readonly FullMonthVehicle[] = [],
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
  out.push(...overlaps(month.rides, r => r.driver.id ?? `name:${r.driver.name}`, 'driver'));
  out.push(...overlaps(month.rides, r => r.vehicle.plate, 'vehicle'));

  // 3. No shift sits inside a CONFIRMED blocking note of its driver. The same
  //    rule the generator applies (`noteVerdict`), read back from the output.
  for (const shift of month.shifts) {
    const id = driverIdByName.get(shift.driver.name) ?? findDriverId(notes, shift);
    if (id === null) continue;
    const blocking = noteVerdict(id, shift.startMs, shift.endMs, notes).blocking;
    if (blocking) out.push(`shift ${shift.id} runs inside a confirmed ${blocking.note_type} note of its driver`);
  }

  // 3b. No shift on a vehicle whose TÜV had expired before the operating day.
  const vehicleByPlate = new Map(vehicles.map(v => [v.plate, v]));
  for (const shift of month.shifts) {
    const vehicle = vehicleByPlate.get(shift.vehicle.plate);
    if (vehicle && vehicleVerdict(vehicle, shift.operatingDay).kind === 'blocked') {
      out.push(`shift ${shift.id} runs on ${shift.vehicle.plate} after its TÜV expired`);
    }
  }

  // 4. A declined ride carries a fee and no fare, a completed one the reverse.
  for (const ride of month.rides) {
    if (ride.status === 'declined' && (ride.fare !== 0 || ride.tip !== 0 || ride.km !== 0)) {
      out.push(`declined ride of shift ${ride.shiftId} carries a fare, a tip or a distance`);
    }
    if (ride.status === 'completed' && ride.declinedFeeCents !== undefined) {
      out.push(`completed ride of shift ${ride.shiftId} carries a decline fee`);
    }
    if (ride.status === 'cancelled' && ride.fare !== 0) {
      out.push(`cancelled ride of shift ${ride.shiftId} carries a fare`);
    }
  }

  // 5. A declined order fell in idle time: no completed ride of the same
  //    vehicle was carrying a passenger at that instant.
  const carrying = new Map<string, { start: number; end: number }[]>();
  for (const ride of month.rides) {
    if (ride.status !== 'completed' || ride.startMs === null || ride.endMs === null) continue;
    carrying.set(ride.vehicle.plate, [...(carrying.get(ride.vehicle.plate) ?? []), { start: ride.startMs, end: ride.endMs }]);
  }
  for (const ride of month.rides) {
    if (ride.status !== 'declined') continue;
    const t = ride.orderTransmittedMs;
    if ((carrying.get(ride.vehicle.plate) ?? []).some(b => t >= b.start && t < b.end)) {
      out.push(`declined order of shift ${ride.shiftId} reached the car while it carried a passenger`);
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
