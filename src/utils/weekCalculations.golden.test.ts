/**
 * Golden-master tests for the business-week calendar.
 *
 * CLAUDE.md states the rule that every monthly aggregation in the product
 * depends on: **a week belongs to the month containing its Monday.** April 1st
 * falling on a Wednesday belongs to March.
 *
 * ## Month indexing — read this before using the module
 *
 * Every function here is **0-indexed**: January is 0 and December is 11.
 * `getBusinessMonth(new Date(2026, 3, 1))` returns `{ month: 2 }` for March, and
 * `getBusinessMonthRange(4, 2026)` returns the range of **May**, not April.
 *
 * That is easy to get wrong — the author of these tests did, first time — and
 * nothing in the codebase states it, so it is asserted here explicitly. A caller
 * passing a 1-indexed month silently reads the wrong month's data.
 *
 * FINDINGS.md M19 and M23 both trace back to this module, and the audit's
 * completeness critic flagged that this TypeScript rule and the SQL functions
 * (get_business_month, get_week_monday) have never been checked against each
 * other. These tests pin the TypeScript side so that comparison has a reference.
 */
import { describe, it, expect } from 'vitest';
import {
  getWeekMonday,
  getBusinessWeekRange,
  getBusinessMonth,
  getBusinessWeeksForMonth,
  getWeekNumberForDate,
  isDateInBusinessMonth,
  getBusinessMonthRange,
} from './weekCalculations';

/** Local-time date from a 1-indexed month, matching how a human reads a date. */
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);
const iso = (x: Date) =>
  `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;

/** 0-indexed month constants, so the tests read as intent rather than arithmetic. */
const JAN = 0, MAR = 2, APR = 3, JUN = 5, DEC = 11;

describe('month indexing — 0-indexed, asserted because nothing else states it', () => {
  it('getBusinessMonth returns 0 for January', () => {
    // 5 January 2026 is a Monday, so its week belongs to January.
    expect(getBusinessMonth(d(2026, 1, 5))).toEqual({ month: JAN, year: 2026 });
  });

  it('getBusinessMonth returns 11 for December', () => {
    expect(getBusinessMonth(d(2026, 12, 7))).toEqual({ month: DEC, year: 2026 });
  });
});

describe('the Monday rule — asserted, because the product depends on it', () => {
  it('maps every day of a week onto the same Monday', () => {
    for (let offset = 0; offset < 7; offset++) {
      const day = d(2026, 4, 6 + offset); // 6 April 2026 is a Monday
      expect(iso(getWeekMonday(day)), iso(day)).toBe('2026-04-06');
    }
  });

  it('assigns a week to the month containing its Monday', () => {
    // 1 April 2026 is a Wednesday; its Monday is 30 March, so that week is March.
    expect(iso(getWeekMonday(d(2026, 4, 1)))).toBe('2026-03-30');
    expect(getBusinessMonth(d(2026, 4, 1))).toEqual({ month: MAR, year: 2026 });
  });

  it('keeps a week whose Monday is in the new month in that new month', () => {
    expect(getBusinessMonth(d(2026, 4, 6))).toEqual({ month: APR, year: 2026 });
  });

  it('carries a week across a year boundary by its Monday', () => {
    // 1 January 2027 is a Friday; its Monday is 28 December 2026.
    expect(iso(getWeekMonday(d(2027, 1, 1)))).toBe('2026-12-28');
    expect(getBusinessMonth(d(2027, 1, 1))).toEqual({ month: DEC, year: 2026 });
  });

  it('agrees with isDateInBusinessMonth', () => {
    expect(isDateInBusinessMonth(d(2026, 4, 1), MAR, 2026)).toBe(true);
    expect(isDateInBusinessMonth(d(2026, 4, 1), APR, 2026)).toBe(false);
    expect(isDateInBusinessMonth(d(2026, 4, 6), APR, 2026)).toBe(true);
  });
});

describe('getBusinessWeekRange — current behaviour', () => {
  it('spans Monday to Sunday', () => {
    const { monday, sunday } = getBusinessWeekRange(d(2026, 4, 1));
    expect({ monday: iso(monday), sunday: iso(sunday) }).toEqual({
      monday: '2026-03-30',
      sunday: '2026-04-05',
    });
  });
});

describe('getBusinessWeeksForMonth — current behaviour', () => {
  // A month starting mid-week, one starting on a Monday, one running into the
  // next year, and one starting on a Thursday. External snapshots because
  // inline ones cannot be generated from a loop.
  const render = (month: number, year: number) =>
    getBusinessWeeksForMonth(month, year).map(w => ({
      ...w,
      ...(w.firstDay instanceof Date ? { firstDay: iso(w.firstDay) } : {}),
      ...(w.lastDay instanceof Date ? { lastDay: iso(w.lastDay) } : {}),
    }));

  for (const [label, month, year] of [
    ['April 2026', APR, 2026],
    ['June 2026', JUN, 2026],
    ['December 2026', DEC, 2026],
    ['January 2026', JAN, 2026],
  ] as Array<[string, number, number]>) {
    it(`enumerates ${label}`, () => {
      expect(render(month, year)).toMatchSnapshot();
    });
  }
});

describe('getWeekNumberForDate — current behaviour', () => {
  it('numbers the weeks around the April 2026 boundary', () => {
    const rows = [1, 6, 13, 20, 27, 30].map(day => ({
      date: iso(d(2026, 4, day)),
      week: getWeekNumberForDate(d(2026, 4, day)),
    }));
    // 1 April is the 5th week of the March business month; 6 April starts April.
    expect(rows).toEqual([
      { date: '2026-04-01', week: 5 },
      { date: '2026-04-06', week: 1 },
      { date: '2026-04-13', week: 2 },
      { date: '2026-04-20', week: 3 },
      { date: '2026-04-27', week: 4 },
      { date: '2026-04-30', week: 4 },
    ]);
  });
});

describe('getBusinessMonthRange — current behaviour', () => {
  it('bounds April 2026 (month index 3)', () => {
    const { start, end } = getBusinessMonthRange(APR, 2026);
    expect({ start: iso(start), end: iso(end) }).toMatchSnapshot();
  });

  it('bounds December 2026 (month index 11)', () => {
    const { start, end } = getBusinessMonthRange(DEC, 2026);
    expect({ start: iso(start), end: iso(end) }).toMatchSnapshot();
  });
});
