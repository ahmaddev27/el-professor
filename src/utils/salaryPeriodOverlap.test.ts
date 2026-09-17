import { describe, expect, it } from 'vitest';
import {
  findOverlappingSalaryPeriods,
  groupSalaryPeriodsByDriver,
  salaryPeriodsOverlap,
} from './salaryPeriodOverlap';

const row = (id: string, period_start: string, period_end: string | null, driver_id = 'driver-1') => ({
  id,
  driver_id,
  period_start,
  period_end,
});

// The business month of March 2026 (a week belongs to the month containing its
// Monday) beside the calendar month of the same name: the pair the owner has to
// merge by hand, and the one unique_driver_period does not catch.
const BUSINESS_MARCH = row('business-march', '2026-03-02', '2026-03-29');
const CALENDAR_MARCH = row('calendar-march', '2026-03-01', '2026-03-31');

describe('salaryPeriodsOverlap', () => {
  it('a business month and the calendar month of the same name overlap', () => {
    expect(salaryPeriodsOverlap(BUSINESS_MARCH, CALENDAR_MARCH)).toBe(true);
    expect(salaryPeriodsOverlap(CALENDAR_MARCH, BUSINESS_MARCH)).toBe(true);
  });

  it('is symmetric for a period fully inside another', () => {
    const inner = row('inner', '2026-03-10', '2026-03-12');
    expect(salaryPeriodsOverlap(CALENDAR_MARCH, inner)).toBe(true);
    expect(salaryPeriodsOverlap(inner, CALENDAR_MARCH)).toBe(true);
  });

  it('a period overlaps itself', () => {
    expect(salaryPeriodsOverlap(CALENDAR_MARCH, CALENDAR_MARCH)).toBe(true);
  });

  // The RPC compares with <= and >=, so a single shared day is an overlap. The
  // two cases below are one day apart and answer differently; keep them together.
  it('two periods that share their boundary day overlap — one ends the day the next begins', () => {
    const first = row('first', '2026-03-01', '2026-03-31');
    const second = row('second', '2026-03-31', '2026-04-30');
    expect(salaryPeriodsOverlap(first, second)).toBe(true);
  });

  it('two consecutive periods do not overlap — the next begins the day after the first ends', () => {
    const first = row('first', '2026-03-01', '2026-03-31');
    const second = row('second', '2026-04-01', '2026-04-30');
    expect(salaryPeriodsOverlap(first, second)).toBe(false);
    expect(salaryPeriodsOverlap(second, first)).toBe(false);
  });

  it('consecutive business months do not overlap', () => {
    const march = row('march', '2026-03-02', '2026-03-29');
    const april = row('april', '2026-03-30', '2026-04-26');
    expect(salaryPeriodsOverlap(march, april)).toBe(false);
  });

  it('distant periods do not overlap', () => {
    expect(salaryPeriodsOverlap(CALENDAR_MARCH, row('june', '2026-06-01', '2026-06-30'))).toBe(false);
  });

  // salaries.period_end is NOT NULL, so this is defensive. SQL compares against
  // NULL as unknown and the RPC therefore refuses nothing, so neither does this.
  it('a row with no end date overlaps nothing, as in SQL', () => {
    const open = row('open', '2026-03-01', null);
    expect(salaryPeriodsOverlap(open, CALENDAR_MARCH)).toBe(false);
    expect(salaryPeriodsOverlap(CALENDAR_MARCH, open)).toBe(false);
    expect(salaryPeriodsOverlap(open, open)).toBe(false);
  });

  it('a row with no start date overlaps nothing', () => {
    const noStart = { period_start: '', period_end: '2026-03-31' };
    expect(salaryPeriodsOverlap(noStart, CALENDAR_MARCH)).toBe(false);
    expect(salaryPeriodsOverlap(CALENDAR_MARCH, noStart)).toBe(false);
  });

  it('compares dates as text, so a period spanning a year end is ordered correctly', () => {
    const december = row('december', '2025-12-01', '2025-12-31');
    const january = row('january', '2026-01-01', '2026-01-31');
    expect(salaryPeriodsOverlap(december, january)).toBe(false);
    expect(salaryPeriodsOverlap(december, row('turn', '2025-12-29', '2026-01-04'))).toBe(true);
  });
});

describe('findOverlappingSalaryPeriods', () => {
  it('names the other row of the same driver', () => {
    const found = findOverlappingSalaryPeriods(BUSINESS_MARCH, [BUSINESS_MARCH, CALENDAR_MARCH], BUSINESS_MARCH.id);
    expect(found.map(candidate => candidate.id)).toEqual(['calendar-march']);
  });

  it('excludes the row the period came from, and only that row', () => {
    const twin = row('twin', '2026-03-02', '2026-03-29');
    const found = findOverlappingSalaryPeriods(BUSINESS_MARCH, [BUSINESS_MARCH, twin], BUSINESS_MARCH.id);
    expect(found.map(candidate => candidate.id)).toEqual(['twin']);
  });

  it('without an id to exclude, a period not yet stored is checked against every row', () => {
    const wouldBe = { period_start: '2026-03-02', period_end: '2026-03-29' };
    const found = findOverlappingSalaryPeriods(wouldBe, [CALENDAR_MARCH]);
    expect(found.map(candidate => candidate.id)).toEqual(['calendar-march']);
  });

  it('three rows overlapping pairwise each name the other two, earliest period first', () => {
    const a = row('a', '2026-03-01', '2026-03-20');
    const b = row('b', '2026-03-10', '2026-03-25');
    const c = row('c', '2026-03-15', '2026-03-31');
    const all = [c, a, b];

    expect(findOverlappingSalaryPeriods(a, all, a.id).map(found => found.id)).toEqual(['b', 'c']);
    expect(findOverlappingSalaryPeriods(b, all, b.id).map(found => found.id)).toEqual(['a', 'c']);
    expect(findOverlappingSalaryPeriods(c, all, c.id).map(found => found.id)).toEqual(['a', 'b']);
  });

  it('a chain where the ends do not meet reports only the true overlaps', () => {
    const a = row('a', '2026-03-01', '2026-03-10');
    const b = row('b', '2026-03-05', '2026-03-20');
    const c = row('c', '2026-03-15', '2026-03-31');
    const all = [a, b, c];

    expect(findOverlappingSalaryPeriods(a, all, a.id).map(found => found.id)).toEqual(['b']);
    expect(findOverlappingSalaryPeriods(b, all, b.id).map(found => found.id)).toEqual(['a', 'c']);
    expect(findOverlappingSalaryPeriods(c, all, c.id).map(found => found.id)).toEqual(['b']);
  });

  it('returns nothing for a driver whose periods are all consecutive', () => {
    const months = [
      row('m1', '2026-01-05', '2026-02-01'),
      row('m2', '2026-02-02', '2026-03-01'),
      row('m3', '2026-03-02', '2026-03-29'),
    ];
    for (const month of months) {
      expect(findOverlappingSalaryPeriods(month, months, month.id)).toEqual([]);
    }
  });

  it('does not sort the caller’s array', () => {
    const a = row('a', '2026-03-15', '2026-03-31');
    const b = row('b', '2026-03-01', '2026-03-20');
    const rows = [a, b];
    findOverlappingSalaryPeriods(a, rows, a.id);
    expect(rows.map(entry => entry.id)).toEqual(['a', 'b']);
  });
});

describe('groupSalaryPeriodsByDriver', () => {
  it('keeps each driver’s rows apart, so one driver’s months never mark another’s', () => {
    const mine = row('mine', '2026-03-01', '2026-03-31', 'driver-1');
    const yours = row('yours', '2026-03-02', '2026-03-29', 'driver-2');
    const byDriver = groupSalaryPeriodsByDriver([mine, yours]);

    expect(byDriver.get('driver-1')?.map(entry => entry.id)).toEqual(['mine']);
    expect(byDriver.get('driver-2')?.map(entry => entry.id)).toEqual(['yours']);
    expect(findOverlappingSalaryPeriods(mine, byDriver.get('driver-1') ?? [], mine.id)).toEqual([]);
  });

  it('preserves input order within a driver and answers nothing for an unknown driver', () => {
    const byDriver = groupSalaryPeriodsByDriver([
      row('second', '2026-04-01', '2026-04-30'),
      row('first', '2026-03-01', '2026-03-31'),
    ]);
    expect(byDriver.get('driver-1')?.map(entry => entry.id)).toEqual(['second', 'first']);
    expect(byDriver.get('driver-9')).toBeUndefined();
  });
});
