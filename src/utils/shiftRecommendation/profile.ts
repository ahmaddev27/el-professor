/**
 * The demand profile: what a vehicle on the road has earned, per weekday and
 * slot of the operating day, in the months the operator chose.
 *
 * ## What counts as "on the road"
 *
 * A vehicle's usable rides are chained into periods: a ride starting at most
 * `blockGapMinutes` after the period's running end joins it, a later one opens
 * the next. The period from its first start to its running end is the time the
 * vehicle was out, waits between rides included — that is the time a shift
 * pays for, so it is the denominator of every rate. A ride's revenue is spread
 * over the slots the ride itself covers, in proportion, so every cent lands in
 * a slot that also carries the vehicle's time on the road.
 *
 * ## What is left out, and said so
 *
 * Only completed rides with a vehicle, a start, an end after it but within
 * twelve hours, an unambiguous local time and a price teach the profile
 * anything. The twelve hours are not a business rule but a guard: one ride
 * whose end carries a mistyped year would otherwise be a period of decades,
 * walked slot by slot, smearing its revenue over every weekday. Every other
 * row is counted under its first reason, and the priced revenue the profile
 * could not place is reported beside the cancellation fees, so the screen can
 * say how much of the month the figures stand on. Nothing is guessed: a ride
 * without a time is not placed at a time.
 */
import { toCents } from '../money';
import { compareIds } from '../tripAnalysis/intervals';
import type { AnalysisTrip } from '../tripAnalysis/types';
import { validateProfileSettings } from './settings';
import { SlotClock, dayTypeOf } from './timeline';
import {
  MAX_RIDE_MINUTES,
  SHIFT_RECOMMENDATION_ALGORITHM_VERSION,
  type DemandCell,
  type DemandProfile,
  type DemandProfileInput,
  type DayType,
  type ProfileExclusionReason,
  type VehicleHistory,
} from './types';

const MINUTE_MS = 60_000;

const EXCLUSION_REASONS: readonly ProfileExclusionReason[] = [
  'cancelled',
  'status_unknown',
  'missing_vehicle',
  'missing_start',
  'missing_end',
  'end_before_start',
  'implausible_duration',
  'ambiguous_local_time',
  'unpriced',
];

/** Integer cents, or null for a missing price or one that is not a decimal amount. */
function centsOf(price: AnalysisTrip['price']): number | null {
  if (price === null || price === undefined) return null;
  if (typeof price === 'string' && price.trim() === '') return null;
  try {
    return toCents(price);
  } catch {
    return null;
  }
}

interface UsableRide {
  readonly id: string;
  readonly vehicle: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly cents: number;
}

/** The first reason a row cannot be learnt from, or null when it can. */
function exclusionOf(trip: AnalysisTrip, cents: number | null): ProfileExclusionReason | null {
  if (trip.status === 'cancelled') return 'cancelled';
  if (trip.status !== 'completed') return 'status_unknown';
  if (!trip.vehicle || trip.vehicle.trim() === '') return 'missing_vehicle';
  if (trip.start_ms === null || !Number.isFinite(trip.start_ms)) return 'missing_start';
  if (trip.end_ms === null || !Number.isFinite(trip.end_ms)) return 'missing_end';
  if (trip.end_ms < trip.start_ms) return 'end_before_start';
  const length = trip.end_ms - trip.start_ms;
  if (length === 0 || length > MAX_RIDE_MINUTES * MINUTE_MS) return 'implausible_duration';
  if (trip.time_ambiguity) return 'ambiguous_local_time';
  if (cents === null) return 'unpriced';
  return null;
}

/** Periods on the road of one vehicle, from its rides sorted by start. */
function periodsOf(rides: readonly UsableRide[], gapMs: number): Array<{ startMs: number; endMs: number }> {
  const periods: Array<{ startMs: number; endMs: number }> = [];
  for (const ride of rides) {
    const last = periods[periods.length - 1];
    if (last && ride.startMs - last.endMs <= gapMs) {
      last.endMs = Math.max(last.endMs, ride.endMs);
    } else {
      periods.push({ startMs: ride.startMs, endMs: ride.endMs });
    }
  }
  return periods;
}

function ratePerHour(revenueCents: number, minutes: number): number | null {
  return minutes > 0 ? Math.round((revenueCents / minutes) * 60) : null;
}

function emptyExclusions(): Record<ProfileExclusionReason, number> {
  return Object.fromEntries(EXCLUSION_REASONS.map(reason => [reason, 0])) as Record<ProfileExclusionReason, number>;
}

export function buildDemandProfile(input: DemandProfileInput): DemandProfile {
  const { settings } = input;
  const excluded = emptyExclusions();
  const usable: UsableRide[] = [];
  let usedRevenueCents = 0;
  let unplacedRevenueCents = 0;
  let cancelledRevenueCents = 0;

  for (const trip of input.trips) {
    const cents = centsOf(trip.price);
    const reason = exclusionOf(trip, cents);
    if (reason) {
      excluded[reason] += 1;
      if (cents !== null) {
        if (reason === 'cancelled') cancelledRevenueCents += cents;
        else unplacedRevenueCents += cents;
      }
      continue;
    }
    usedRevenueCents += cents as number;
    usable.push({
      id: trip.id,
      vehicle: (trip.vehicle as string).trim(),
      startMs: trip.start_ms as number,
      endMs: trip.end_ms as number,
      cents: cents as number,
    });
  }

  const problems = validateProfileSettings(settings);
  const months = input.historyMonths.length;
  const base = {
    algorithmVersion: SHIFT_RECOMMENDATION_ALGORITHM_VERSION,
    problems,
    settings,
    historyMonths: input.historyMonths,
    coverage: {
      rows: input.trips.length,
      usedRides: usable.length,
      excluded,
      usedRevenueCents,
      unplacedRevenueCents,
      cancelledRevenueCents,
    },
  };
  const empty = {
    positions: problems.length === 0 ? 1440 / settings.slotMinutes : 0,
    cells: [],
    vehicles: [],
    perMonth: { rides: 0, vehicleMinutes: 0, revenueCents: 0, revenuePerHourCents: null },
  };
  if (problems.length > 0) return { ...base, ...empty, status: 'invalid_settings' };
  if (usable.length === 0 || months === 0) return { ...base, ...empty, status: 'no_history' };

  const clock = new SlotClock(settings.slotMinutes, settings.operatingDayStartHour);
  const cellCount = 7 * clock.positions;
  const revenue = new Float64Array(cellCount);
  const minutes = new Float64Array(cellCount);
  const activeDays: Array<Set<string>> = Array.from({ length: cellCount }, () => new Set<string>());
  const maxVehicles = new Int32Array(cellCount);
  /** Slot start → the vehicles on the road in it, for the simultaneous-vehicle ceiling. */
  const vehiclesInSlot = new Map<number, Set<string>>();
  /** Slot start → its cell and operating day: a slot is placed once, however many rides cross it. */
  const placed = new Map<number, { cell: number; operatingDate: string }>();

  const placeOf = (slotStartMs: number): { cell: number; operatingDate: string } => {
    const known = placed.get(slotStartMs);
    if (known) return known;
    const place = clock.place(slotStartMs);
    const day: DayType = dayTypeOf(place.operatingDate, input.holidays);
    const value = { cell: day * clock.positions + place.position, operatingDate: place.operatingDate };
    placed.set(slotStartMs, value);
    return value;
  };
  const cellOf = (slotStartMs: number): number => placeOf(slotStartMs).cell;

  // Rides grouped by vehicle, in time order, so the periods chain correctly.
  const byVehicle = new Map<string, UsableRide[]>();
  for (const ride of usable) {
    const list = byVehicle.get(ride.vehicle);
    if (list) list.push(ride);
    else byVehicle.set(ride.vehicle, [ride]);
  }
  const vehicleNames = [...byVehicle.keys()].sort(compareIds);
  const gapMs = settings.blockGapMinutes * MINUTE_MS;

  const vehicles: VehicleHistory[] = [];
  let fleetMinutes = 0;
  for (const vehicle of vehicleNames) {
    const rides = (byVehicle.get(vehicle) as UsableRide[]).sort(
      (a, b) => a.startMs - b.startMs || compareIds(a.id, b.id),
    );
    let vehicleMinutes = 0;
    let vehicleRevenue = 0;

    for (const period of periodsOf(rides, gapMs)) {
      vehicleMinutes += (period.endMs - period.startMs) / MINUTE_MS;
      for (let slot = clock.slotStart(period.startMs); slot < period.endMs; slot += clock.slotMs) {
        const overlap = Math.min(period.endMs, slot + clock.slotMs) - Math.max(period.startMs, slot);
        if (overlap <= 0) continue;
        const { cell, operatingDate } = placeOf(slot);
        minutes[cell] += overlap / MINUTE_MS;
        activeDays[cell].add(operatingDate);
        const inSlot = vehiclesInSlot.get(slot);
        if (inSlot) inSlot.add(vehicle);
        else vehiclesInSlot.set(slot, new Set([vehicle]));
      }
    }

    for (const ride of rides) {
      vehicleRevenue += ride.cents;
      const length = ride.endMs - ride.startMs;
      for (let slot = clock.slotStart(ride.startMs); slot < ride.endMs; slot += clock.slotMs) {
        const overlap = Math.min(ride.endMs, slot + clock.slotMs) - Math.max(ride.startMs, slot);
        if (overlap > 0) revenue[cellOf(slot)] += (ride.cents * overlap) / length;
      }
    }

    fleetMinutes += vehicleMinutes;
    vehicles.push({
      vehicle,
      rides: rides.length,
      vehicleMinutesPerMonth: vehicleMinutes / months,
      revenueCentsPerMonth: Math.round(vehicleRevenue / months),
      revenuePerHourCents: ratePerHour(vehicleRevenue, vehicleMinutes),
    });
  }

  for (const [slot, onRoad] of vehiclesInSlot) {
    const cell = cellOf(slot);
    if (onRoad.size > maxVehicles[cell]) maxVehicles[cell] = onRoad.size;
  }

  const cells: DemandCell[] = [];
  for (let cell = 0; cell < cellCount; cell += 1) {
    const days = activeDays[cell].size;
    cells.push({
      dayType: Math.floor(cell / clock.positions) as DayType,
      position: cell % clock.positions,
      revenueCents: revenue[cell],
      vehicleMinutes: minutes[cell],
      activeDays: days,
      maxVehicles: maxVehicles[cell],
      revenuePerHourCents: days >= settings.minEvidenceDays ? ratePerHour(revenue[cell], minutes[cell]) : null,
    });
  }

  return {
    ...base,
    status: 'ok',
    positions: clock.positions,
    cells,
    vehicles,
    perMonth: {
      rides: usable.length / months,
      vehicleMinutes: fleetMinutes / months,
      revenueCents: Math.round(usedRevenueCents / months),
      revenuePerHourCents: ratePerHour(usedRevenueCents, fleetMinutes),
    },
  };
}
