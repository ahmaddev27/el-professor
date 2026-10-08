/**
 * The recommendation: for every day of the target month and every vehicle, the
 * shifts worth driving.
 *
 * ## The rule, in one sentence
 *
 * A slot is worth (its expected rate − the threshold) × its length, and each
 * vehicle-day gets the set of at most `maxShiftsPerVehiclePerDay` shifts, each
 * between the minimum and maximum length and separated by the break, whose
 * worth is largest — and only shifts worth more than nothing.
 *
 * So the planner prefers fewer, stronger hours by construction: a window that
 * earns less than the threshold costs a shift, and is only kept when it bridges
 * two stronger stretches whose gain pays for it.
 *
 * ## The two ceilings, and why
 *
 *   - **No more vehicles than the history ever had out at once.** A slot's rate
 *     was measured with up to `maxVehicles` vehicles on the road; there is no
 *     evidence it holds for one more. So a slot that already holds that many
 *     planned vehicles is a **wall**: no shift of a further vehicle may cross it,
 *     not even as a bridge between two strong stretches — a bridge is still a
 *     vehicle on the road. A slot no vehicle ever drove (`maxVehicles` 0) is a
 *     wall for everyone. The count is per day: each planned vehicle uses one.
 *   - **No rate without evidence.** A slot seen on fewer days than the profile's
 *     `minEvidenceDays` has no rate and earns nothing, though a shift may bridge
 *     it while the vehicle ceiling allows.
 *
 * The vehicle order rotates by one each day, so the best windows are not always
 * handed to the same vehicle; the result stays deterministic.
 *
 * Exact arithmetic: rates are whole cents and a slot is a quarter, half or
 * whole hour, so every worth is a multiple of a quarter cent and every
 * comparison below is exact — no epsilon decides a tie. A tie between two
 * plans of equal worth goes to the one with fewer slots, then to the earlier.
 */
import { validatePlanSettings } from './settings';
import { SlotClock, dateKeyOf, dayTypeOf, daysInMonth } from './timeline';
import {
  SHIFT_RECOMMENDATION_ALGORITHM_VERSION,
  type Confidence,
  type DemandProfile,
  type RecommendInput,
  type RecommendedShift,
  type ShiftRecommendation,
  type VehiclePlanSummary,
} from './types';

/** Evidence days at or above which a shift's expectation is called high / medium confidence. */
export const CONFIDENCE_HIGH_DAYS = 8;
export const CONFIDENCE_MEDIUM_DAYS = 4;

function confidenceOf(days: number): Confidence {
  if (days >= CONFIDENCE_HIGH_DAYS) return 'high';
  if (days >= CONFIDENCE_MEDIUM_DAYS) return 'medium';
  return 'low';
}

interface Score {
  readonly worth: number;
  readonly slots: number;
}

function better(a: Score, b: Score): boolean {
  return a.worth > b.worth || (a.worth === b.worth && a.slots < b.slots);
}

/** A half-open run of positions within one operating day. */
interface Run {
  readonly start: number;
  readonly end: number;
}

/**
 * The best set of at most `maxRuns` runs over `worth`, each `minLength` to
 * `maxLength` long, starting no earlier than `earliestStart`, containing no
 * `blocked` position, at least `breakLength` apart, and each worth more than
 * nothing.
 *
 * best[k][i] is the best score with at most k runs inside positions [0, i).
 * O(maxRuns × positions × (maxLength − minLength)), a few thousand steps a day.
 */
export function bestRuns(
  worth: readonly number[],
  options: {
    minLength: number;
    maxLength: number;
    maxRuns: number;
    breakLength: number;
    earliestStart: number;
    /** Positions no run may contain. */
    blocked?: readonly boolean[];
  },
): Run[] {
  const n = worth.length;
  const prefix = new Float64Array(n + 1);
  /** Blocked positions in [0, i): a run [a, i) is open when the two counts agree. */
  const walls = new Int32Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    prefix[i + 1] = prefix[i] + worth[i];
    walls[i + 1] = walls[i] + (options.blocked?.[i] ? 1 : 0);
  }

  const zero: Score = { worth: 0, slots: 0 };
  const best: Score[][] = [];
  /** 0 = position i−1 holds no run end; otherwise the length of the run ending at i. */
  const choice: number[][] = [];
  for (let k = 0; k <= options.maxRuns; k += 1) {
    best.push(new Array<Score>(n + 1).fill(zero));
    choice.push(new Array<number>(n + 1).fill(0));
  }

  for (let k = 1; k <= options.maxRuns; k += 1) {
    for (let i = 1; i <= n; i += 1) {
      let top = best[k][i - 1];
      let took = 0;
      for (let length = options.minLength; length <= options.maxLength; length += 1) {
        const start = i - length;
        if (start < options.earliestStart) break;
        // A longer run from the same end contains this one's wall too.
        if (walls[i] !== walls[start]) break;
        const runWorth = prefix[i] - prefix[start];
        if (runWorth <= 0) continue;
        const before = start - options.breakLength;
        const previous = before >= 0 ? best[k - 1][before] : zero;
        const candidate: Score = { worth: previous.worth + runWorth, slots: previous.slots + length };
        if (better(candidate, top)) {
          top = candidate;
          took = length;
        }
      }
      best[k][i] = top;
      choice[k][i] = took;
    }
  }

  const runs: Run[] = [];
  let k = options.maxRuns;
  let i = n;
  while (k > 0 && i > 0) {
    const length = choice[k][i];
    if (length === 0) {
      i -= 1;
      continue;
    }
    runs.push({ start: i - length, end: i });
    i = Math.max(0, i - length - options.breakLength);
    k -= 1;
  }
  return runs.reverse();
}

function rate(cents: number, minutes: number): number | null {
  return minutes > 0 ? Math.round((cents / minutes) * 60) : null;
}

function weakHistory(profile: DemandProfile, threshold: number): ShiftRecommendation['weakHistory'] {
  let minutes = 0;
  let revenue = 0;
  for (const cell of profile.cells) {
    if (cell.vehicleMinutes <= 0) continue;
    if (cell.revenuePerHourCents !== null && cell.revenuePerHourCents >= threshold) continue;
    minutes += cell.vehicleMinutes;
    revenue += cell.revenueCents;
  }
  const months = Math.max(profile.historyMonths.length, 1);
  return {
    vehicleMinutesPerMonth: minutes / months,
    revenueCentsPerMonth: Math.round(revenue / months),
    revenuePerHourCents: rate(revenue, minutes),
  };
}

function isValidTarget(target: RecommendInput['target']): boolean {
  return (
    Number.isInteger(target.year) && target.year >= 2000 && target.year <= 2100 &&
    Number.isInteger(target.month) && target.month >= 1 && target.month <= 12
  );
}

export function recommendShifts(input: RecommendInput): ShiftRecommendation {
  const { profile, settings, target } = input;
  const vehicles = [...new Set(input.vehicles.map(v => v.trim()).filter(Boolean))];
  const empty = {
    algorithmVersion: SHIFT_RECOMMENDATION_ALGORITHM_VERSION,
    settings,
    target,
    shifts: [],
    perVehicle: [],
    totals: { shifts: 0, minutes: 0, expectedRevenueCents: 0, expectedRevenuePerHourCents: null, daysWithSecondShift: 0, vehiclesUsed: 0 },
    weakHistory: { vehicleMinutesPerMonth: 0, revenueCentsPerMonth: 0, revenuePerHourCents: null },
  };
  if (profile.status !== 'ok') return { ...empty, status: 'profile_unusable', problems: [] };
  const slotMinutes = profile.settings.slotMinutes;
  const problems = validatePlanSettings(settings, slotMinutes);
  if (problems.length > 0) return { ...empty, status: 'invalid_settings', problems };
  if (!isValidTarget(target)) return { ...empty, status: 'invalid_target', problems: [] };
  if (vehicles.length === 0) return { ...empty, status: 'no_vehicles', problems: [] };

  const clock = new SlotClock(slotMinutes, profile.settings.operatingDayStartHour);
  const positions = clock.positions;
  const slotHours = slotMinutes / 60;
  const threshold = settings.minRevenuePerHourCents;
  const options = {
    minLength: settings.minShiftMinutes / slotMinutes,
    maxLength: settings.maxShiftMinutes / slotMinutes,
    maxRuns: settings.maxShiftsPerVehiclePerDay,
    breakLength: settings.minBreakMinutes / slotMinutes,
  };

  const shifts: RecommendedShift[] = [];
  /** Per vehicle: the end of its last shift, in positions counted from the month's first operating day. */
  const lastEnd = new Map<string, number>();
  const dayCount = daysInMonth(target.year, target.month);

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const operatingDate = dateKeyOf(target.year, target.month, dayIndex + 1);
    const isHoliday = input.holidays.has(operatingDate);
    const dayType = dayTypeOf(operatingDate, input.holidays);
    const cells = profile.cells.slice(dayType * positions, (dayType + 1) * positions);
    const onRoad = new Int32Array(positions);
    const order = vehicles.map((_, i) => vehicles[(i + dayIndex) % vehicles.length]);
    const dayShifts: RecommendedShift[] = [];

    for (const vehicle of order) {
      const blocked = cells.map((cell, p) => onRoad[p] >= cell.maxVehicles);
      const gain = cells.map((cell, p) =>
        cell.revenuePerHourCents !== null && !blocked[p] ? cell.revenuePerHourCents * slotHours : 0,
      );
      const worth = gain.map(g => g - threshold * slotHours);
      const previousEnd = lastEnd.get(vehicle);
      const earliestStart =
        previousEnd === undefined ? 0 : Math.max(0, previousEnd + options.breakLength - dayIndex * positions);

      const runs = bestRuns(worth, { ...options, earliestStart, blocked });
      runs.forEach((run, index) => {
        let expected = 0;
        let evidence = Number.POSITIVE_INFINITY;
        for (let p = run.start; p < run.end; p += 1) {
          onRoad[p] += 1;
          expected += gain[p];
          if (gain[p] > 0) evidence = Math.min(evidence, cells[p].activeDays);
        }
        const minutes = (run.end - run.start) * slotMinutes;
        const evidenceDays = Number.isFinite(evidence) ? evidence : 0;
        dayShifts.push({
          id: `${vehicle}|${operatingDate}|${index}`,
          vehicle,
          operatingDate,
          dayType,
          isHoliday,
          startPosition: run.start,
          endPosition: run.end,
          start: clock.moment(operatingDate, run.start),
          end: clock.moment(operatingDate, run.end),
          minutes,
          expectedRevenueCents: Math.round(expected),
          expectedRevenuePerHourCents: rate(expected, minutes) ?? 0,
          evidenceDays,
          confidence: confidenceOf(evidenceDays),
        });
      });
      const lastRun = runs[runs.length - 1];
      if (lastRun) lastEnd.set(vehicle, dayIndex * positions + lastRun.end);
    }

    dayShifts.sort(
      (a, b) => vehicles.indexOf(a.vehicle) - vehicles.indexOf(b.vehicle) || a.startPosition - b.startPosition,
    );
    shifts.push(...dayShifts);
  }

  const perVehicle: VehiclePlanSummary[] = vehicles.map(vehicle => {
    const own = shifts.filter(s => s.vehicle === vehicle);
    const minutes = own.reduce((sum, s) => sum + s.minutes, 0);
    const expected = own.reduce((sum, s) => sum + s.expectedRevenueCents, 0);
    const perDay = new Map<string, number>();
    for (const s of own) perDay.set(s.operatingDate, (perDay.get(s.operatingDate) ?? 0) + 1);
    return {
      vehicle,
      shifts: own.length,
      minutes,
      expectedRevenueCents: expected,
      expectedRevenuePerHourCents: rate(expected, minutes),
      daysWithSecondShift: [...perDay.values()].filter(count => count >= 2).length,
    };
  });

  const minutes = perVehicle.reduce((sum, v) => sum + v.minutes, 0);
  const expected = perVehicle.reduce((sum, v) => sum + v.expectedRevenueCents, 0);
  return {
    ...empty,
    status: 'ok',
    problems: [],
    shifts,
    perVehicle,
    totals: {
      shifts: shifts.length,
      minutes,
      expectedRevenueCents: expected,
      expectedRevenuePerHourCents: rate(expected, minutes),
      daysWithSecondShift: perVehicle.reduce((sum, v) => sum + v.daysWithSecondShift, 0),
      vehiclesUsed: perVehicle.filter(v => v.shifts > 0).length,
    },
    weakHistory: weakHistory(profile, threshold),
  };
}
