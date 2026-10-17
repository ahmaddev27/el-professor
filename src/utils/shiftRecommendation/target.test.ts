import { describe, expect, it } from 'vitest';
import { recommendShifts } from './recommend';
import { planForTarget, swapToAlternative, type TargetPlanInput, type TargetPlanSettings } from './target';
import type { DayType, DemandCell, DemandProfile } from './types';

/** Hourly slots, the operating day starting at 04:00 (position p = clock hour (4 + p) % 24). */
function handProfile(
  rate: (day: DayType, clockHour: number) => number | null,
  ceiling: (day: DayType, clockHour: number) => number = () => 4,
): DemandProfile {
  const cells: DemandCell[] = [];
  for (let day = 0; day < 7; day += 1) {
    for (let p = 0; p < 24; p += 1) {
      const clockHour = (4 + p) % 24;
      const r = rate(day as DayType, clockHour);
      cells.push({
        dayType: day as DayType, position: p, revenueCents: r ?? 0, vehicleMinutes: 60,
        activeDays: 9, maxVehicles: ceiling(day as DayType, clockHour), revenuePerHourCents: r,
      });
    }
  }
  return {
    algorithmVersion: 'test', status: 'ok', problems: [],
    settings: { slotMinutes: 60, operatingDayStartHour: 4, blockGapMinutes: 30, minEvidenceDays: 2 },
    historyMonths: [{ year: 2026, month: 8 }], positions: 24, cells, vehicles: [],
    coverage: {
      rows: 0, usedRides: 0,
      excluded: { cancelled: 0, status_unknown: 0, missing_vehicle: 0, missing_start: 0, missing_end: 0, end_before_start: 0, implausible_duration: 0, ambiguous_local_time: 0, unpriced: 0 },
      usedRevenueCents: 0, unplacedRevenueCents: 0, cancelledRevenueCents: 0,
    },
    perMonth: { rides: 0, vehicleMinutes: 0, revenueCents: 0, revenuePerHourCents: null },
  };
}

const SETTINGS: TargetPlanSettings = {
  minShiftMinutes: 180, maxShiftMinutes: 240, minBreakMinutes: 60, maxShiftsPerVehiclePerDay: 2,
};

/** Strong 07–10 and 16–19, weak otherwise: the threshold decides how much of the day is driven. */
const commuter = handProfile((_, h) => ((h >= 7 && h < 10) || (h >= 16 && h < 19) ? 3000 : 1000));

function input(targetRevenueCents: number, overrides: Partial<TargetPlanInput> = {}): TargetPlanInput {
  return {
    profile: commuter, target: { year: 2026, month: 11 }, vehicles: ['A'], holidays: new Set(),
    settings: SETTINGS, targetRevenueCents, ...overrides,
  };
}

function direct(threshold: number, overrides: Partial<TargetPlanInput> = {}) {
  const base = input(0, overrides);
  return recommendShifts({
    profile: base.profile, target: base.target, vehicles: base.vehicles, holidays: base.holidays,
    settings: { ...base.settings, minRevenuePerHourCents: threshold },
  });
}

describe('planForTarget — reaching a target by the threshold', () => {
  it('lands exactly on a target the plans can hit', () => {
    const attainable = direct(2000).totals.expectedRevenueCents;
    expect(attainable).toBeGreaterThan(0);
    const result = planForTarget(input(attainable));
    expect(result.status).toBe('ok');
    expect(result.outcome).toBe('reached');
    expect(result.achievedCents).toBe(attainable);
    expect(result.gapCents).toBe(0);
    expect(result.shortfall).toBeNull();
  });

  it('lands below a target between two plans, and reports the gap', () => {
    const attainable = direct(2000).totals.expectedRevenueCents;
    const result = planForTarget(input(attainable + 1));
    expect(result.outcome).toBe('below_target');
    expect(result.achievedCents).toBeLessThanOrEqual(attainable + 1);
    expect(result.gapCents).toBe(attainable + 1 - result.achievedCents);
    expect(result.gapCents).toBeGreaterThan(0);
    // Minimal: one cent per hour lower would have gone over the target.
    expect(direct(result.thresholdCents - 1).totals.expectedRevenueCents).toBeGreaterThan(attainable + 1);
  });

  it('never exceeds the target, whatever it is', () => {
    for (const target of [1, 999, 10_000, 123_456, 400_000, 800_000, 5_000_000]) {
      const result = planForTarget(input(target, { vehicles: ['A', 'B', 'C'] }));
      expect(result.achievedCents, `target ${target}`).toBeLessThanOrEqual(target);
      expect(result.gapCents).toBe(target - result.achievedCents);
    }
  });

  it('plans nothing for a target of zero, and calls that reached', () => {
    const result = planForTarget(input(0));
    expect(result.outcome).toBe('reached');
    expect(result.achievedCents).toBe(0);
    expect(result.recommendation.shifts).toEqual([]);
  });

  it('returns exactly what recommendShifts gives at the chosen threshold', () => {
    for (const target of [0, 250_000, 600_000, 99_000_000]) {
      const result = planForTarget(input(target));
      expect(result.recommendation).toEqual(direct(result.thresholdCents));
      expect(JSON.stringify(result.recommendation.shifts)).toBe(JSON.stringify(direct(result.thresholdCents).shifts));
    }
  });

  it('is deterministic', () => {
    const first = planForTarget(input(300_000, { vehicles: ['A', 'B'] }));
    const second = planForTarget(input(300_000, { vehicles: ['A', 'B'] }));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('keeps the figures the history measured: no shift is worth anything but its rate times its slots', () => {
    const result = planForTarget(input(300_000));
    for (const shift of result.recommendation.shifts) {
      const slots = shift.minutes / 60;
      expect(shift.expectedRevenueCents).toBeLessThanOrEqual(3000 * slots);
      expect(shift.expectedRevenueCents).toBeGreaterThanOrEqual(1000 * slots);
    }
  });
});

describe('planForTarget — a target the plan cannot reach', () => {
  it('says so, returns the maximum, and names the history as the bound when no fleet could earn it', () => {
    const result = planForTarget(input(1_000_000_000));
    expect(result.outcome).toBe('unreachable');
    expect(result.thresholdCents).toBe(0);
    expect(result.achievedCents).toBe(direct(0).totals.expectedRevenueCents);
    expect(result.gapCents).toBe(1_000_000_000 - result.achievedCents);
    expect(result.shortfall?.binding).toBe('history_ceiling');
  });

  it('names the fleet when more vehicles would reach it', () => {
    const probe = planForTarget(input(1_000_000_000)).shortfall!;
    expect(probe.ceilingByFleetCents).toBeLessThan(probe.ceilingByHistoryCents);
    const result = planForTarget(input(probe.ceilingByFleetCents + 1));
    expect(result.outcome).toBe('unreachable');
    expect(result.shortfall?.binding).toBe('fleet_size');
  });

  it('names the shift rules when the fleet could earn it but the rules keep it off the road', () => {
    const probe = planForTarget(input(1_000_000_000)).shortfall!;
    const maximum = direct(0).totals.expectedRevenueCents;
    expect(maximum + 100).toBeLessThanOrEqual(probe.ceilingByFleetCents);
    const result = planForTarget(input(maximum + 100));
    expect(result.outcome).toBe('unreachable');
    expect(result.shortfall?.binding).toBe('shift_rules');
    const perDay = result.shortfall?.levers.find(l => l.lever === 'shifts_per_day');
    expect(perDay?.gainCents).toBeGreaterThan(0);
  });

  it('never offers to widen the six-hour ceiling beyond 360 minutes', () => {
    const result = planForTarget(input(1_000_000_000));
    const lever = result.shortfall?.levers.find(l => l.lever === 'max_shift');
    expect(lever).toBeDefined();
    const sixHours = recommendShifts({
      profile: commuter, target: { year: 2026, month: 11 }, vehicles: ['A'], holidays: new Set(),
      settings: { ...SETTINGS, maxShiftMinutes: 360, minRevenuePerHourCents: 0 },
    });
    expect(lever?.revenueCents).toBe(sixHours.totals.expectedRevenueCents);
  });

  it('counts the slots it cannot price instead of guessing them', () => {
    const sparse = handProfile(
      (_, h) => (h >= 8 && h < 12 ? 3000 : null),
      (_, h) => (h >= 8 && h < 14 ? 2 : 0),
    );
    const result = planForTarget(input(1_000_000_000, { profile: sparse }));
    // 8 to 12 rated, 12 to 14 seen but unrated, the rest never driven; 30 days of 60-minute slots.
    expect(result.shortfall?.unratedSlotMinutes).toBe(30 * 2 * 60);
    expect(result.shortfall?.neverDrivenSlotMinutes).toBe(30 * 18 * 60);
  });

  it('respects the wall rule: a slot never holds more vehicles than the history ever had', () => {
    const oneAtATime = handProfile((_, h) => (h >= 7 && h < 10 ? 3000 : null), () => 1);
    const result = planForTarget(input(1_000_000_000, { profile: oneAtATime, vehicles: ['A', 'B', 'C'] }));
    expect(result.recommendation.shifts).toHaveLength(30);
    expect(result.shortfall?.ceilingByHistoryCents).toBe(30 * 3 * 3000);
  });
});

describe('planForTarget — what it refuses', () => {
  it('refuses a target that is not whole non-negative cents', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      const result = planForTarget(input(bad));
      expect(result.status).toBe('invalid_target_amount');
      expect(result.outcome).toBeNull();
    }
  });

  it('passes the engine’s own refusal through, naming it', () => {
    const result = planForTarget(input(100_000, { settings: { ...SETTINGS, maxShiftMinutes: 420 } }));
    expect(result.status).toBe('recommendation_failed');
    expect(result.recommendation.problems).toContain('max_shift_above_limit');
  });
});

/**
 * Revenue moves in steps: a window is either worth a shift or not, and a whole
 * shift goes with it. One window of 3 × 3000 against a threshold of 2000 gives
 * a plan of 30 shifts; at 3001 it gives none. No threshold lands in between.
 */
describe('planForTarget — a target between two steps', () => {
  const oneWindow = handProfile((_, h) => (h >= 7 && h < 10 ? 3000 : null), () => 1);
  const stepInput = (target: number) => input(target, { profile: oneWindow });

  it('returns the plan under the target and keeps the plan over it, neither adjusted', () => {
    const full = direct(0, { profile: oneWindow }).totals.expectedRevenueCents;
    expect(full).toBe(30 * 9000);
    const result = planForTarget(stepInput(full - 1));
    expect(result.outcome).toBe('below_target');
    expect(result.achievedCents).toBe(0);
    expect(result.gapCents).toBe(full - 1);
    expect(result.recommendation.shifts).toEqual([]);
    expect(result.alternative?.achievedCents).toBe(full);
    expect(result.alternative?.distanceCents).toBe(1);
    expect(result.alternative?.recommendation).toEqual(direct(result.alternative!.thresholdCents, { profile: oneWindow }));
  });

  it('swaps to the plan over the target and back, recomputing nothing', () => {
    const full = 30 * 9000;
    const below = planForTarget(stepInput(full - 1));
    const over = swapToAlternative(below);
    expect(over.outcome).toBe('over_target');
    expect(over.achievedCents).toBe(full);
    expect(over.gapCents).toBe(0);
    expect(over.recommendation).toBe(below.alternative!.recommendation);
    const back = swapToAlternative(over);
    expect(back.outcome).toBe('below_target');
    expect(back.achievedCents).toBe(0);
    expect(back.recommendation).toBe(below.recommendation);
  });

  it('offers no alternative when the target is hit or cannot be reached', () => {
    expect(planForTarget(stepInput(30 * 9000)).alternative).toBeNull();
    expect(planForTarget(stepInput(30 * 9000 + 1)).alternative).toBeNull();
    const reached = planForTarget(stepInput(30 * 9000));
    expect(swapToAlternative(reached)).toBe(reached);
  });
});
