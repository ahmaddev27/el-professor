import { describe, expect, it } from 'vitest';
import {
  CROSS_CHECK_MATERIAL_SHARE,
  apportion,
  averageFareCents,
  dailyVehicleTable,
  expectedRidesFor,
  parseShareText,
  parseTripCountText,
  ridesFactor,
  shareToText,
  tripCrossCheck,
  type Scenario,
} from './shiftRecommendationScenario';
import { shiftRows } from './shiftRecommendationScreens';
import { DEFAULT_PLAN_SETTINGS, recommendShifts, type DayType, type DemandCell, type DemandProfile } from './shiftRecommendation';
import type { ReferenceStats } from './shiftRecommendationReference';

/** Hourly slots, operating day from 04:00, a rate that differs by weekday so shifts differ in revenue. */
function profile(): DemandProfile {
  const cells: DemandCell[] = [];
  for (let day = 0; day < 7; day += 1) {
    for (let p = 0; p < 24; p += 1) {
      const rate = 1500 + day * 130 + ((4 + p) % 24) * 17;
      cells.push({
        dayType: day as DayType, position: p, revenueCents: rate, vehicleMinutes: 60,
        activeDays: 9, maxVehicles: 4, revenuePerHourCents: rate,
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

const PLAN = recommendShifts({
  profile: profile(),
  target: { year: 2026, month: 9 },
  vehicles: ['B-AA 1', 'B-AA 2', 'B-AA 3'],
  holidays: new Set<string>(),
  settings: { ...DEFAULT_PLAN_SETTINGS, maxShiftMinutes: 240, minBreakMinutes: 60, minRevenuePerHourCents: 0 },
});

const SCENARIO: Scenario = {
  averageFareCents: 1850,
  measuredCancellationShare: 0.1,
  cancellationShare: 0.1,
  tipShare: 0.08,
  cashShare: 0.35,
  targetTrips: null,
};

describe('the daily table totals exactly what the shift view totals', () => {
  const table = dailyVehicleTable(PLAN, SCENARIO);
  const shiftView = shiftRows(PLAN.shifts);

  it('is built from a real plan with several shifts', () => {
    expect(PLAN.status).toBe('ok');
    expect(PLAN.shifts.length).toBeGreaterThan(20);
    expect(table.rows.length).toBeLessThan(PLAN.shifts.length);
  });

  it('agrees on shifts, minutes and revenue with the shift table and the plan totals', () => {
    expect(table.totals.shifts).toBe(shiftView.length);
    expect(table.totals.shifts).toBe(PLAN.totals.shifts);
    expect(table.totals.minutes).toBe(shiftView.reduce((sum, r) => sum + r.minutes, 0));
    expect(table.totals.minutes).toBe(PLAN.totals.minutes);
    expect(table.totals.expectedRevenueCents).toBe(shiftView.reduce((sum, r) => sum + r.expectedRevenueCents, 0));
    expect(table.totals.expectedRevenueCents).toBe(PLAN.totals.expectedRevenueCents);
  });

  it('its rows add up to its totals, on every column', () => {
    const sum = (pick: (r: (typeof table.rows)[number]) => number | null) => table.rows.reduce((s, r) => s + (pick(r) ?? 0), 0);
    expect(sum(r => r.shifts)).toBe(table.totals.shifts);
    expect(sum(r => r.minutes)).toBe(table.totals.minutes);
    expect(sum(r => r.expectedRevenueCents)).toBe(table.totals.expectedRevenueCents);
    expect(sum(r => r.expectedRides)).toBe(table.totals.expectedRides);
    expect(sum(r => r.expectedTipCents)).toBe(table.totals.expectedTipCents);
    expect(sum(r => r.expectedCashCents)).toBe(table.totals.expectedCashCents);
  });

  it('has one row per vehicle and operating day, ordered by date then vehicle', () => {
    const keys = table.rows.map(r => `${r.date}|${r.vehicle}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('what each input does to the figures', () => {
  const revenue = PLAN.totals.expectedRevenueCents;

  it('a cancellation share other than the measured one moves the rides and never the revenue', () => {
    const base = dailyVehicleTable(PLAN, SCENARIO);
    const more = dailyVehicleTable(PLAN, { ...SCENARIO, cancellationShare: 0.4 });
    expect(more.totals.expectedRevenueCents).toBe(base.totals.expectedRevenueCents);
    expect(more.totals.expectedRides!).toBeLessThan(base.totals.expectedRides!);
    expect(more.totals.expectedTipCents).toBe(base.totals.expectedTipCents);
  });

  it('at the measured cancellation share the rides are revenue over the mean fare, with no second deduction', () => {
    expect(ridesFactor(SCENARIO)).toBe(1);
    expect(expectedRidesFor(revenue, SCENARIO)).toBe(Math.round(revenue / 1850));
  });

  it('the tip is its own figure: the share of the revenue, and the revenue does not contain it', () => {
    const t = dailyVehicleTable(PLAN, SCENARIO).totals;
    expect(t.expectedTipCents).toBe(Math.round(revenue * 0.08));
    expect(t.expectedRevenueCents).toBe(revenue);
    expect(dailyVehicleTable(PLAN, { ...SCENARIO, tipShare: 0.5 }).totals.expectedRevenueCents).toBe(revenue);
  });

  it('the cash share is a share of the revenue and changes nothing else', () => {
    const base = dailyVehicleTable(PLAN, SCENARIO).totals;
    const other = dailyVehicleTable(PLAN, { ...SCENARIO, cashShare: 0.9 }).totals;
    expect(base.expectedCashCents).toBe(Math.round(revenue * 0.35));
    expect(other.expectedCashCents).toBe(Math.round(revenue * 0.9));
    expect({ ...other, expectedCashCents: 0 }).toEqual({ ...base, expectedCashCents: 0 });
  });

  it('a figure without its input is absent, not zero', () => {
    const t = dailyVehicleTable(PLAN, { ...SCENARIO, averageFareCents: null, tipShare: null, cashShare: null }).totals;
    expect(t.expectedRides).toBeNull();
    expect(t.expectedTipCents).toBeNull();
    expect(t.expectedCashCents).toBeNull();
  });
});

describe('the trip-count cross-check', () => {
  it('compares trips times the mean fare with the revenue, in euros and percent', () => {
    const check = tripCrossCheck({ ...SCENARIO, targetTrips: 1000 }, 1_665_000)!;
    expect(check.impliedRevenueCents).toBe(1_850_000);
    expect(check.differenceCents).toBe(185_000);
    expect(check.differenceShare).toBeCloseTo(0.1111, 3);
    expect(check.material).toBe(true);
  });

  it('calls a small disagreement agreement, and a negative one negative', () => {
    expect(tripCrossCheck({ ...SCENARIO, targetTrips: 1000 }, 1_840_000)!.material).toBe(false);
    expect(tripCrossCheck({ ...SCENARIO, targetTrips: 500 }, 1_850_000)!.differenceCents).toBeLessThan(0);
    expect(CROSS_CHECK_MATERIAL_SHARE).toBe(0.1);
  });

  it('is absent without a trip count or without a measured fare', () => {
    expect(tripCrossCheck(SCENARIO, 1_000_000)).toBeNull();
    expect(tripCrossCheck({ ...SCENARIO, targetTrips: 10, averageFareCents: null }, 1_000_000)).toBeNull();
  });
});

describe('reading the inputs', () => {
  it('reads a percentage with a German comma, and refuses the rest', () => {
    expect(parseShareText('12,5')).toBe(0.125);
    expect(parseShareText(' 8 % ')).toBe(0.08);
    expect(parseShareText('100')).toBe(1);
    expect(parseShareText('100,5')).toBeNull();
    expect(parseShareText('abc')).toBeNull();
    expect(parseShareText('')).toBeNull();
  });

  it('reads a whole trip count', () => {
    expect(parseTripCountText('1090')).toBe(1090);
    expect(parseTripCountText('0')).toBeNull();
    expect(parseTripCountText('10,5')).toBeNull();
    expect(parseTripCountText('')).toBeNull();
  });

  it('writes a measured share back as the text a field starts with', () => {
    expect(shareToText(0.1234)).toBe('12,3');
    expect(shareToText(null)).toBe('');
  });

  it('measures the mean fare from completed rides only', () => {
    const stats = { completedRows: 4, fareCents: 7400 } as ReferenceStats;
    expect(averageFareCents(stats)).toBe(1850);
    expect(averageFareCents({ ...stats, completedRows: 0 })).toBeNull();
    expect(averageFareCents(null)).toBeNull();
  });
});

describe('apportion', () => {
  it('adds up to the total exactly, whatever the weights', () => {
    for (const weights of [[1, 1, 1], [3, 5, 7, 11], [0, 4, 0, 9], [1]]) {
      expect(apportion(101, weights).reduce((a, b) => a + b, 0)).toBe(101);
    }
  });
  it('gives nothing to anyone when there is nothing to split', () => {
    expect(apportion(0, [1, 2])).toEqual([0, 0]);
    expect(apportion(5, [0, 0])).toEqual([0, 0]);
    expect(apportion(5, [])).toEqual([]);
  });
});
