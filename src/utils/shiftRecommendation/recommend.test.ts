import { describe, expect, it } from 'vitest';
import { bestRuns, recommendShifts } from './recommend';
import { buildDemandProfile } from './profile';
import { DEFAULT_PLAN_SETTINGS, DEFAULT_PROFILE_SETTINGS } from './settings';
import type { AnalysisTrip } from '../tripAnalysis/types';
import type { DayType, DemandCell, DemandProfile, PlanSettings, RecommendInput, ShiftRecommendation } from './types';

/**
 * A profile written by hand: hourly slots, the operating day starting at
 * 04:00, so position p is the clock hour (4 + p) % 24. `rate` answers cents per
 * hour or null; `ceiling` the most vehicles the history ever had out.
 */
function handProfile(
  rate: (day: DayType, clockHour: number) => number | null,
  ceiling: (day: DayType, clockHour: number) => number = () => 4,
  activeDays = 9,
): DemandProfile {
  const cells: DemandCell[] = [];
  for (let day = 0; day < 7; day += 1) {
    for (let p = 0; p < 24; p += 1) {
      const clockHour = (4 + p) % 24;
      const r = rate(day as DayType, clockHour);
      cells.push({
        dayType: day as DayType,
        position: p,
        revenueCents: r ?? 0,
        vehicleMinutes: 60,
        activeDays,
        maxVehicles: ceiling(day as DayType, clockHour),
        revenuePerHourCents: r,
      });
    }
  }
  return {
    algorithmVersion: 'test',
    status: 'ok',
    problems: [],
    settings: { slotMinutes: 60, operatingDayStartHour: 4, blockGapMinutes: 30, minEvidenceDays: 2 },
    historyMonths: [{ year: 2026, month: 8 }],
    positions: 24,
    cells,
    vehicles: [],
    coverage: {
      rows: 0,
      usedRides: 0,
      excluded: { cancelled: 0, status_unknown: 0, missing_vehicle: 0, missing_start: 0, missing_end: 0, end_before_start: 0, implausible_duration: 0, ambiguous_local_time: 0, unpriced: 0 },
      usedRevenueCents: 0,
      unplacedRevenueCents: 0,
      cancelledRevenueCents: 0,
    },
    perMonth: { rides: 0, vehicleMinutes: 0, revenueCents: 0, revenuePerHourCents: null },
  };
}

const PLAN: PlanSettings = {
  minShiftMinutes: 180,
  maxShiftMinutes: 240,
  minBreakMinutes: 60,
  maxShiftsPerVehiclePerDay: 2,
  minRevenuePerHourCents: 2000,
};

function plan(profile: DemandProfile, overrides: Partial<RecommendInput> = {}, settings: Partial<PlanSettings> = {}): ShiftRecommendation {
  return recommendShifts({
    profile,
    target: { year: 2026, month: 11 },
    vehicles: ['A'],
    holidays: new Set(),
    settings: { ...PLAN, ...settings },
    ...overrides,
  });
}

/** Strong 07–10 and 16–19 on every day, weak otherwise. */
const commuter = handProfile((_, h) => ((h >= 7 && h < 10) || (h >= 16 && h < 19) ? 3000 : 1000));

describe('bestRuns', () => {
  const base = { minLength: 2, maxLength: 3, maxRuns: 2, breakLength: 1, earliestStart: 0 };

  it('takes the strong runs and leaves the weak positions out', () => {
    expect(bestRuns([-1, 5, 5, -1, 5, 5, -1], base)).toEqual([{ start: 1, end: 3 }, { start: 4, end: 6 }]);
  });

  it('keeps the earlier of two equal runs when only one is allowed', () => {
    expect(bestRuns([-1, 5, 5, -1, 5, 5, -1], { ...base, maxRuns: 1 })).toEqual([{ start: 1, end: 3 }]);
  });

  it('keeps two runs at least the break apart, moving one rather than closing the gap', () => {
    // [1,3) and [4,6) are one apart; [0,2) (worth 4) and [4,6) (worth 10) are two.
    expect(bestRuns([-1, 5, 5, -1, 5, 5, -1], { ...base, breakLength: 2 })).toEqual([{ start: 0, end: 2 }, { start: 4, end: 6 }]);
    expect(bestRuns([-1, 5, 5, -1, 5, 5, -1], { ...base, breakLength: 3 })).toEqual([{ start: 1, end: 3 }]);
  });

  it('bridges one weak position when the two sides pay for it', () => {
    expect(bestRuns([6, -1, 6], { ...base, minLength: 3, maxLength: 3 })).toEqual([{ start: 0, end: 3 }]);
  });

  it('never recommends a run that is worth nothing or less', () => {
    expect(bestRuns([-1, -2, -1, -3], base)).toEqual([]);
    expect(bestRuns([0, 0, 0, 0], base)).toEqual([]);
  });

  it('starts no run before the earliest start', () => {
    expect(bestRuns([-1, 5, 5, -1, 5, 5, -1], { ...base, earliestStart: 2 })).toEqual([{ start: 4, end: 6 }]);
  });

  it('never lets a run contain a blocked position, not even as a bridge', () => {
    const blocked = [false, false, true, false, false, false, false];
    expect(bestRuns([5, 5, 5, 5, 5, -1, -1], { ...base, maxRuns: 1, maxLength: 5 })).toEqual([{ start: 0, end: 5 }]);
    expect(bestRuns([5, 5, 5, 5, 5, -1, -1], { ...base, maxRuns: 1, maxLength: 5, blocked })).toEqual([{ start: 0, end: 2 }]);
    expect(bestRuns([6, -1, 6], { ...base, minLength: 3, maxLength: 3, blocked: [false, true, false] })).toEqual([]);
  });

  it('prefers the shorter of two runs of equal worth', () => {
    expect(bestRuns([5, 5, 0, -1], { ...base, maxRuns: 1 })).toEqual([{ start: 0, end: 2 }]);
  });
});

describe('recommendShifts — the shape of a shift', () => {
  it('recommends the strong windows and nothing in the weak ones', () => {
    const result = plan(commuter);
    expect(result.status).toBe('ok');
    const first = result.shifts.filter(s => s.operatingDate === '2026-11-02');
    expect(first.map(s => `${s.start.time}-${s.end.time}`)).toEqual(['07:00-10:00', '16:00-19:00']);
    expect(first[0]).toMatchObject({ minutes: 180, expectedRevenueCents: 9000, expectedRevenuePerHourCents: 3000 });
  });

  it('keeps every shift between the minimum and maximum, and under five hours with the defaults', () => {
    const everywhere = handProfile(() => 3000);
    const result = recommendShifts({
      profile: buildProfileFrom15MinuteHistory(),
      target: { year: 2026, month: 11 },
      vehicles: ['A', 'B'],
      holidays: new Set(),
      settings: { ...DEFAULT_PLAN_SETTINGS, minRevenuePerHourCents: 0 },
    });
    for (const shift of result.shifts) {
      expect(shift.minutes).toBeGreaterThanOrEqual(DEFAULT_PLAN_SETTINGS.minShiftMinutes);
      expect(shift.minutes).toBeLessThanOrEqual(DEFAULT_PLAN_SETTINGS.maxShiftMinutes);
      expect(shift.minutes).toBeLessThan(300);
    }
    for (const shift of plan(everywhere).shifts) {
      expect(shift.minutes).toBeGreaterThanOrEqual(180);
      expect(shift.minutes).toBeLessThanOrEqual(240);
    }
  });

  it('recommends nothing when no window beats the threshold', () => {
    expect(plan(commuter, {}, { minRevenuePerHourCents: 3000 }).shifts).toEqual([]);
    expect(plan(commuter, {}, { minRevenuePerHourCents: 2999 }).shifts.length).toBeGreaterThan(0);
  });

  it('names a night shift by the day it starts and ends', () => {
    const friday = handProfile((day, h) => (day === 4 && (h >= 22 || h < 2) ? 4000 : null));
    const shift = plan(friday).shifts.find(s => s.operatingDate === '2026-11-06');
    expect(shift).toMatchObject({
      dayType: 4,
      start: { date: '2026-11-06', time: '22:00' },
      end: { date: '2026-11-07', time: '02:00' },
      minutes: 240,
    });
  });

  it('plans a holiday as a Sunday', () => {
    const sundayOnly = handProfile((day, h) => (day === 6 && h >= 12 && h < 15 ? 5000 : null));
    // 01.11.2026 is a Sunday, 02.11.2026 a Monday declared a holiday here.
    const result = plan(sundayOnly, { holidays: new Set(['2026-11-02']) });
    const monday = result.shifts.filter(s => s.operatingDate === '2026-11-02');
    expect(monday).toHaveLength(1);
    expect(monday[0]).toMatchObject({ isHoliday: true, dayType: 6 });
    expect(result.shifts.filter(s => s.operatingDate === '2026-11-03')).toEqual([]);
  });

  it('carries only the fields of a shift — never anything shaped like a ride', () => {
    const shift = plan(commuter).shifts[0];
    expect(Object.keys(shift).sort()).toEqual(
      [
        'confidence', 'dayType', 'end', 'endPosition', 'evidenceDays', 'expectedRevenueCents',
        'expectedRevenuePerHourCents', 'id', 'isHoliday', 'minutes', 'operatingDate', 'start',
        'startPosition', 'vehicle',
      ].sort(),
    );
  });
});

describe('recommendShifts — the ceilings and the breaks', () => {
  it('never puts out more vehicles in a slot than the history ever had', () => {
    const oneAtATime = handProfile((_, h) => (h >= 7 && h < 10 ? 3000 : null), () => 1);
    const result = plan(oneAtATime, { vehicles: ['A', 'B', 'C'] });
    const perSlot = new Map<string, number>();
    for (const s of result.shifts) {
      for (let p = s.startPosition; p < s.endPosition; p += 1) {
        const key = `${s.operatingDate}#${p}`;
        perSlot.set(key, (perSlot.get(key) ?? 0) + 1);
      }
    }
    expect(Math.max(...perSlot.values())).toBe(1);
    // One shift a day, 30 days of November.
    expect(result.shifts).toHaveLength(30);
  });

  it('never bridges a further vehicle through a slot that is already at the ceiling', () => {
    // Strong 07–12 everywhere, but 09:00 was only ever driven by one vehicle at a time.
    const narrow = handProfile(
      (_, h) => (h >= 7 && h < 12 ? 3000 : null),
      (_, h) => (h === 9 ? 1 : 3),
    );
    const result = plan(narrow, { vehicles: ['A', 'B'] }, { minShiftMinutes: 60, maxShiftMinutes: 240, maxShiftsPerVehiclePerDay: 2 });
    const ceiling = (position: number) => ((4 + position) % 24 === 9 ? 1 : 3);
    const perSlot = new Map<string, number>();
    for (const s of result.shifts) {
      for (let p = s.startPosition; p < s.endPosition; p += 1) {
        const key = `${s.operatingDate}#${p}`;
        const count = (perSlot.get(key) ?? 0) + 1;
        perSlot.set(key, count);
        expect(count).toBeLessThanOrEqual(ceiling(p));
      }
    }
    // On 02.11 the rotation plans B first (07–11), so A works around 09:00 rather than through it.
    expect(result.shifts.filter(s => s.operatingDate === '2026-11-02' && s.vehicle === 'B').map(s => `${s.start.time}-${s.end.time}`)).toEqual(['07:00-11:00']);
    const second = result.shifts.filter(s => s.operatingDate === '2026-11-02' && s.vehicle === 'A');
    expect(second.map(s => `${s.start.time}-${s.end.time}`)).toEqual(['07:00-09:00', '10:00-12:00']);
  });

  it('rotates which vehicle gets the one strong window, day by day', () => {
    const oneAtATime = handProfile((_, h) => (h >= 7 && h < 10 ? 3000 : null), () => 1);
    const result = plan(oneAtATime, { vehicles: ['A', 'B'] });
    expect(result.shifts.slice(0, 4).map(s => s.vehicle)).toEqual(['A', 'B', 'A', 'B']);
    expect(result.perVehicle.map(v => v.shifts)).toEqual([15, 15]);
  });

  it('keeps the break between two shifts of one vehicle, across operating days too', () => {
    // Strong 00:00–08:00: the end of one operating day (20–24) and the start of the next (0–4).
    const aroundDayStart = handProfile((_, h) => (h < 8 ? 3000 : null));
    const result = plan(aroundDayStart, { vehicles: ['A', 'B'] });
    for (const vehicle of ['A', 'B']) {
      const own = result.shifts
        .filter(s => s.vehicle === vehicle)
        .map(s => {
          const day = Number(s.operatingDate.slice(8)) - 1;
          return { start: day * 24 + s.startPosition, end: day * 24 + s.endPosition };
        })
        .sort((a, b) => a.start - b.start);
      for (let i = 1; i < own.length; i += 1) expect(own[i].start - own[i - 1].end).toBeGreaterThanOrEqual(1);
    }
    // Day one opens at 04:00; every later day waits an hour for the night before.
    const ownA = result.shifts.filter(s => s.vehicle === 'A');
    expect(ownA.slice(0, 4).map(s => [s.operatingDate, s.startPosition, s.endPosition])).toEqual([
      ['2026-11-01', 0, 4],
      ['2026-11-01', 20, 24],
      ['2026-11-02', 1, 4],
      ['2026-11-02', 20, 24],
    ]);
  });
});

describe('recommendShifts — totals and refusals', () => {
  it('adds up: every total is the sum of its shifts', () => {
    const result = plan(commuter, { vehicles: ['A', 'B', 'C'] });
    const sum = (f: (s: (typeof result.shifts)[number]) => number) => result.shifts.reduce((t, s) => t + f(s), 0);
    expect(result.totals.shifts).toBe(result.shifts.length);
    expect(result.totals.minutes).toBe(sum(s => s.minutes));
    expect(result.totals.expectedRevenueCents).toBe(sum(s => s.expectedRevenueCents));
    expect(result.perVehicle.reduce((t, v) => t + v.expectedRevenueCents, 0)).toBe(result.totals.expectedRevenueCents);
    expect(result.totals.daysWithSecondShift).toBe(3 * 30);
    expect(result.totals.vehiclesUsed).toBe(3);
  });

  it('reports the history’s weak hours: the time the recommendation leaves out', () => {
    // 18 weak hours a day at 10,00 €, 7 days, one history month.
    const result = plan(commuter);
    expect(result.weakHistory).toEqual({
      vehicleMinutesPerMonth: 18 * 60 * 7,
      revenueCentsPerMonth: 18 * 1000 * 7,
      revenuePerHourCents: 1000,
    });
  });

  it('is deterministic', () => {
    expect(plan(commuter, { vehicles: ['A', 'B'] })).toEqual(plan(commuter, { vehicles: ['A', 'B'] }));
  });

  it('refuses what it cannot plan, each with its own status', () => {
    expect(plan(commuter, {}, { maxShiftMinutes: 420 }).problems).toContain('max_shift_above_limit');
    expect(plan(commuter, {}, { minShiftMinutes: 90 }).problems).toContain('shift_not_slot_multiple');
    expect(plan(commuter, {}, { minShiftMinutes: 300, maxShiftMinutes: 240 }).problems).toContain('min_shift_above_max');
    expect(plan(commuter, { vehicles: [' ', ''] }).status).toBe('no_vehicles');
    expect(plan(commuter, { target: { year: 2026, month: 13 } }).status).toBe('invalid_target');
    expect(plan({ ...commuter, status: 'no_history' }).status).toBe('profile_unusable');
  });
});

/** A month of history at 15-minute slots: every day, rides 06:00–14:00, two vehicles. */
function buildProfileFrom15MinuteHistory(): DemandProfile {
  const trips: AnalysisTrip[] = [];
  for (let day = 1; day <= 31; day += 1) {
    for (const vehicle of ['A', 'B']) {
      for (let h = 6; h < 14; h += 1) {
        const date = `2026-08-${String(day).padStart(2, '0')}`;
        trips.push({
          id: `${vehicle}-${day}-${h}`,
          driver_id: 'd',
          driver_name: 'd',
          vehicle,
          start_ms: new Date(`${date}T${String(h).padStart(2, '0')}:05`).getTime(),
          end_ms: new Date(`${date}T${String(h).padStart(2, '0')}:50`).getTime(),
          status: 'completed',
          price: '25.00',
          currency: 'EUR',
          source_row: null,
        });
      }
    }
  }
  return buildDemandProfile({
    trips,
    historyMonths: [{ year: 2026, month: 8 }],
    holidays: new Set(),
    settings: DEFAULT_PROFILE_SETTINGS,
  });
}
