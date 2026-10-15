import { describe, expect, it } from 'vitest';
import { MAX_RANGE_DAYS, splitIntoBusinessWeeks } from '../../supabase/functions/_shared/uber-earnings-core';
import {
  MAX_SELECTABLE_WEEKS,
  defaultWeekRange,
  groupWeeksByMonth,
  isWeekSelected,
  normalizePartnerReason,
  rangeExceedsCap,
  rangeForMonth,
  rangeToDates,
  rangeWeekCount,
  recentUberMonths,
  recentUberWeeks,
  toggleWeek,
  uberDayOf,
  recentUberDays,
  groupDaysByMonthAndWeek,
  defaultDayRange,
  toggleDay,
  isDaySelected,
  rangeDayCount,
  dayRangeExceedsCap,
  dayRangeToDates,
  uberDayWindowLabel,
} from './uberPeriods';

// Wednesday 14.10.2026, noon in Berlin: the running week starts Monday 12.10.
const WED = new Date('2026-10-14T10:00:00Z');

describe('uberDayOf', () => {
  it('Monday 02:00 Berlin is still last week (Sunday), 04:00 is the new week', () => {
    expect(uberDayOf(new Date('2026-10-12T00:00:00Z'))).toBe('2026-10-11'); // 02:00 CEST
    expect(uberDayOf(new Date('2026-10-12T02:00:00Z'))).toBe('2026-10-12'); // 04:00 CEST
  });
});

describe('recentUberWeeks', () => {
  const weeks = recentUberWeeks(WED, 26);
  it('is the running week first, then 26 finished ones, newest first', () => {
    expect(weeks).toHaveLength(27);
    expect(weeks[0]!.segment.monday).toBe('2026-10-12');
    expect(weeks[0]!.running).toBe(true);
    expect(weeks.slice(1).every(w => !w.running)).toBe(true);
    expect(weeks[1]!.segment.monday).toBe('2026-10-05');
  });
  it('a week is Monday..Sunday and carries the books\' Woche N', () => {
    expect(weeks[1]!.segment).toEqual({ from: '2026-10-05', to: '2026-10-11', monday: '2026-10-05' });
    expect(weeks[1]!.weekNumber).toBe(1);
    expect(weeks[0]!.weekNumber).toBe(2);
  });
  it('a week of the year boundary belongs to December and keeps its number', () => {
    const w = recentUberWeeks(new Date('2027-01-06T10:00:00Z'), 3);
    expect(w.map(x => x.segment.monday)).toEqual(['2027-01-04', '2026-12-28', '2026-12-21', '2026-12-14']);
    expect(w[0]!).toMatchObject({ year: 2027, month: 1, weekNumber: 1 });
    expect(w[1]!).toMatchObject({ year: 2026, month: 12, weekNumber: 4 });
    expect(w[1]!.segment.to).toBe('2027-01-03');
  });
  it('groups into business months at the Monday', () => {
    const groups = groupWeeksByMonth(recentUberWeeks(new Date('2026-10-14T10:00:00Z'), 6));
    expect(groups.map(g => [g.year, g.month, g.weeks.length])).toEqual([[2026, 10, 2], [2026, 9, 4], [2026, 8, 1]]);
  });
});

describe('recentUberMonths', () => {
  const months = recentUberMonths(WED, 6);
  it('lists the current month first, then back', () => {
    expect(months.map(m => `${m.year}-${m.month}`)).toEqual([
      '2026-10', '2026-9', '2026-8', '2026-7', '2026-6', '2026-5', '2026-4',
    ]);
  });
  it('October 2026 has four weeks, of which two have started and one is over', () => {
    expect(months[0]!.weeks.map(w => w.segment.monday)).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
    expect(months[0]!.startedCount).toBe(2);
    expect(months[0]!.completeCount).toBe(1);
  });
  it('a 4-week and a 5-week finished month', () => {
    expect(months[1]!.weeks).toHaveLength(4); // September 2026
    expect(months[2]!.weeks).toHaveLength(5); // August 2026: 3, 10, 17, 24, 31
    expect(months[2]!.completeCount).toBe(5);
    expect(months[2]!.startedCount).toBe(5);
  });
  it('picking a finished month selects all of it, a running one only what has started', () => {
    expect(rangeForMonth(months[2]!)).toEqual({ first: '2026-08-03', last: '2026-08-31' });
    expect(rangeForMonth(months[0]!)).toEqual({ first: '2026-10-05', last: '2026-10-12' });
  });
  it('a month boundary: the week of Monday 31.08. is August\'s, ending in September', () => {
    const w = months[2]!.weeks[4]!;
    expect(w.segment).toEqual({ from: '2026-08-31', to: '2026-09-06', monday: '2026-08-31' });
    expect(months[1]!.weeks[0]!.segment.monday).toBe('2026-09-07');
  });
  it('crosses a year boundary', () => {
    const m = recentUberMonths(new Date('2027-01-06T10:00:00Z'), 2);
    expect(m.map(x => `${x.year}-${x.month}`)).toEqual(['2027-1', '2026-12', '2026-11']);
    expect(m[1]!.weeks.map(w => w.segment.monday)).toEqual(['2026-12-07', '2026-12-14', '2026-12-21', '2026-12-28']);
  });
  it('a month whose first Monday has not come is not offered while the old one runs', () => {
    // Thursday 01.10.2026: the running week began Monday 28.09., so September is current.
    const early = recentUberMonths(new Date('2026-10-01T10:00:00Z'), 1);
    expect(early[0]!).toMatchObject({ year: 2026, month: 9, startedCount: 5 - 1, completeCount: 3 });
  });
});

describe('selection', () => {
  const m = (d: string) => d;
  it('opens on the most recent finished week', () => {
    expect(defaultWeekRange(WED)).toEqual({ first: '2026-10-05', last: '2026-10-05' });
  });
  it('extends over a gap, shrinks at an end, starts over inside', () => {
    let r = toggleWeek(null, m('2026-09-14'));
    expect(r).toEqual({ first: '2026-09-14', last: '2026-09-14' });
    r = toggleWeek(r, m('2026-09-28'));
    expect(r).toEqual({ first: '2026-09-14', last: '2026-09-28' });
    expect(isWeekSelected(r, '2026-09-21')).toBe(true);
    expect(toggleWeek(r, '2026-09-28')).toEqual({ first: '2026-09-14', last: '2026-09-21' });
    expect(toggleWeek(r, '2026-09-14')).toEqual({ first: '2026-09-21', last: '2026-09-28' });
    expect(toggleWeek(r, '2026-09-21')).toEqual({ first: '2026-09-21', last: '2026-09-21' });
    expect(toggleWeek({ first: '2026-09-14', last: '2026-09-14' }, '2026-09-14')).toBeNull();
  });
  it('resolves to the from/to the flow uses, and splits into exactly those weeks', () => {
    const r = { first: '2026-12-28', last: '2027-01-04' };
    expect(rangeToDates(r)).toEqual({ from: '2026-12-28', to: '2027-01-10' });
    const split = splitIntoBusinessWeeks('2026-12-28', '2027-01-10');
    expect(split.ok && split.value.map(s => s.monday)).toEqual(['2026-12-28', '2027-01-04']);
    expect(rangeWeekCount(r)).toBe(2);
  });
  it('a 5-week month fits the cap and 6 weeks do not', () => {
    expect(MAX_SELECTABLE_WEEKS).toBe(5);
    const august = rangeForMonth(recentUberMonths(WED, 6)[2]!)!;
    expect(rangeExceedsCap(august)).toBe(false);
    const { from, to } = rangeToDates(august);
    expect(splitIntoBusinessWeeks(from, to).ok).toBe(true);
    const six = { first: '2026-08-03', last: '2026-09-07' };
    expect(rangeWeekCount(six)).toBe(6);
    expect(rangeExceedsCap(six)).toBe(true);
    const d = rangeToDates(six);
    expect(splitIntoBusinessWeeks(d.from, d.to)).toEqual({ ok: false, problem: 'range_too_long' });
  });
  it('the longest business month spans fewer days than the cap', () => {
    expect(35).toBeLessThanOrEqual(MAX_RANGE_DAYS);
  });
});

describe('normalizePartnerReason', () => {
  it('reads Reidey\'s length refusal whatever number it names', () => {
    expect(normalizePartnerReason('range_exceeds_31_days')).toBe('range_too_long');
    expect(normalizePartnerReason('range_exceeds_38_days')).toBe('range_too_long');
    expect(normalizePartnerReason('range_too_long')).toBe('range_too_long');
    expect(normalizePartnerReason('no_proxy')).toBe('no_proxy');
    expect(normalizePartnerReason('range_exceeds_days')).toBe('range_exceeds_days');
  });
});

describe('daily periods', () => {
  const days = recentUberDays(WED, 42);

  it('lists the running Uber day first, then 42 finished ones, newest first', () => {
    expect(days).toHaveLength(43);
    expect(days[0]!.date).toBe('2026-10-14');
    expect(days[0]!.running).toBe(true);
    expect(days.slice(1).every(d => !d.running)).toBe(true);
    expect(days[1]!.date).toBe('2026-10-13');
  });

  it('the day before 04:00 is still yesterday\'s operating day', () => {
    expect(recentUberDays(new Date('2026-10-14T00:30:00Z'), 0)[0]!.date).toBe('2026-10-13'); // 02:30 CEST
  });

  it('a day carries its week\'s Monday, number and business month', () => {
    expect(days[0]!).toMatchObject({ monday: '2026-10-12', weekNumber: 2, year: 2026, month: 10 });
    // Sunday 11.10. belongs to the week of Monday 05.10.
    const sunday = days.find(d => d.date === '2026-10-11')!;
    expect(sunday).toMatchObject({ monday: '2026-10-05', weekNumber: 1 });
    // 01.-04.10. lie in the week of Monday 28.09., which is September's.
    const thursday = days.find(d => d.date === '2026-10-01')!;
    expect(thursday).toMatchObject({ monday: '2026-09-28', year: 2026, month: 9 });
  });

  it('groups under business months and weeks by the Monday, not the calendar month', () => {
    const groups = groupDaysByMonthAndWeek(days);
    const october = groups[0]!;
    expect([october.year, october.month]).toEqual([2026, 10]);
    expect(october.weeks.map(w => [w.monday, w.days.length])).toEqual([['2026-10-12', 3], ['2026-10-05', 7]]);
    const september = groups[1]!;
    expect(september.weeks[0]!.monday).toBe('2026-09-28');
    expect(september.weeks[0]!.days.map(d => d.date)).toContain('2026-10-01');
    expect(groups.reduce((n, m) => n + m.weeks.reduce((k, w) => k + w.days.length, 0), 0)).toBe(days.length);
  });

  it('opens on the last finished day', () => {
    expect(defaultDayRange(WED)).toEqual({ first: '2026-10-13', last: '2026-10-13' });
  });

  it('toggles like the weekly tab: contiguous, gap included', () => {
    let r = toggleDay(null, '2026-10-10');
    expect(r).toEqual({ first: '2026-10-10', last: '2026-10-10' });
    r = toggleDay(r, '2026-10-13');
    expect(r).toEqual({ first: '2026-10-10', last: '2026-10-13' });
    expect(toggleDay(r, '2026-10-13')).toEqual({ first: '2026-10-10', last: '2026-10-12' });
    expect(toggleDay(r, '2026-10-11')).toEqual({ first: '2026-10-11', last: '2026-10-11' });
    expect(toggleDay({ first: '2026-10-10', last: '2026-10-10' }, '2026-10-10')).toBeNull();
    expect(isDaySelected(r, '2026-10-12')).toBe(true);
    expect(isDaySelected(r, '2026-10-14')).toBe(false);
  });

  it('counts days and applies the pull\'s own cap of MAX_RANGE_DAYS', () => {
    const edge = { first: '2026-09-01', last: '2026-10-08' }; // 38 days
    expect(rangeDayCount(edge)).toBe(MAX_RANGE_DAYS);
    expect(dayRangeExceedsCap(edge)).toBe(false);
    expect(dayRangeExceedsCap({ first: '2026-09-01', last: '2026-10-09' })).toBe(true);
    expect(dayRangeExceedsCap(null)).toBe(false);
  });

  it('a daily range is sent as the days themselves and the pull cuts it at weeks', () => {
    const { from, to } = dayRangeToDates({ first: '2026-10-09', last: '2026-10-13' });
    expect([from, to]).toEqual(['2026-10-09', '2026-10-13']);
    const split = splitIntoBusinessWeeks(from, to);
    expect(split.ok && split.value.map(s => [s.from, s.to, s.monday])).toEqual([
      ['2026-10-09', '2026-10-11', '2026-10-05'],
      ['2026-10-12', '2026-10-13', '2026-10-12'],
    ]);
  });

  it('prints the day\'s window in the weeks\' bracket style', () => {
    expect(uberDayWindowLabel(days[1]!)).toBe('[13.10.2026 04:00 – 14.10.2026 04:00]');
  });
});
