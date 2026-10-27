import { describe, expect, it } from 'vitest';
import { SOURCE_TIME_ZONE, wallTimeToInstant } from '../fahrtenbuchImportParser';
import { operatingDayIn } from './period';
import { operatingDayOf } from './time';

/**
 * The operating-day rule across a daylight-saving change.
 *
 * This file began as a `console.log` probe, which is how the defect below was
 * found on 27.10.2026, and is kept as assertions because the measurement is
 * the evidence: the old rule subtracted four hours of **absolute** time and
 * read the calendar day of the result, and four absolute hours are not four
 * clock hours on a day the offset moves.
 *
 * Measured, with `TZ=Europe/Berlin` as `vitest.config.ts` pins it:
 *
 * | reading (local)                   | old answer     | correct    |
 * |-----------------------------------|----------------|------------|
 * | 2026-03-29 04:30 (spring forward) | **2026-03-28** | 2026-03-29 |
 * | 2026-06-15 04:30 (plain day)      | 2026-06-15     | 2026-06-15 |
 *
 * So a ride that began at half past four in the morning was written into
 * `Datum der Fahrt` as the day before, on one day a year, and as the same day
 * on every other day of the year. These assertions are the regression guard.
 */

const at = (y: number, m: number, d: number, hour: number, minute: number): number => {
  const result = wallTimeToInstant({ year: y, month: m, day: d, hour, minute, second: 0 }, SOURCE_TIME_ZONE);
  if (result.kind !== 'ok') throw new Error(`${y}-${m}-${d} ${hour}:${minute} is not a unique reading: ${result.kind}`);
  return result.ms;
};

const CUTOFF = 4;

describe('the operating day is read off the clock, not by subtracting hours', () => {
  it.each([
    // The defect: 04:30 is at or past the 04:00 cutoff, so it is its own day.
    ['2026-03-29 04:30, the spring-forward day', at(2026, 3, 29, 4, 30), '2026-03-29'],
    // Before the cutoff on the same day: still the day before.
    ['2026-03-29 03:30, the spring-forward day', at(2026, 3, 29, 3, 30), '2026-03-28'],
    ['2026-03-29 05:30, the spring-forward day', at(2026, 3, 29, 5, 30), '2026-03-29'],
    // The autumn change, where an hour repeats.
    ['2026-10-25 04:30, the fall-back day', at(2026, 10, 25, 4, 30), '2026-10-25'],
    ['2026-10-25 03:30, the fall-back day', at(2026, 10, 25, 3, 30), '2026-10-24'],
    // A plain day, as the control: the same two readings must answer the same
    // way, or the test would pass for a rule that is simply shifted by a day.
    ['2026-06-15 04:30, a plain day', at(2026, 6, 15, 4, 30), '2026-06-15'],
    ['2026-06-15 03:30, a plain day', at(2026, 6, 15, 3, 30), '2026-06-14'],
  ])('%s', (_label, ms, expected) => {
    expect(operatingDayIn(ms, SOURCE_TIME_ZONE, CUTOFF)).toBe(expected);
  });

  it('operatingDayOf carries the fix, because it delegates to the same rule', () => {
    // The shipped caller. It is what writes `Datum der Fahrt`, so this is the
    // assertion that the generated sheet no longer mis-dates the ride.
    expect(operatingDayOf(at(2026, 3, 29, 4, 30))).toBe('2026-03-29');
    expect(operatingDayOf(at(2026, 3, 29, 3, 30))).toBe('2026-03-28');
    expect(operatingDayOf(at(2026, 6, 15, 4, 30))).toBe('2026-06-15');
  });

  it('the old rule really did disagree, computed here so the table above is checked', () => {
    // The rule as it was, restated locally: this is not production code, it is
    // the measurement. If it ever stops disagreeing, the zone or the DST dates
    // have moved and the rows above need re-measuring rather than re-asserting.
    const oldRule = (ms: number): string => operatingDayIn(ms - CUTOFF * 3_600_000, SOURCE_TIME_ZONE, 0);
    expect(oldRule(at(2026, 3, 29, 4, 30))).toBe('2026-03-28');
    expect(operatingDayIn(at(2026, 3, 29, 4, 30), SOURCE_TIME_ZONE, CUTOFF)).toBe('2026-03-29');
    // And agreed on a plain day, which is why nobody noticed.
    expect(oldRule(at(2026, 6, 15, 4, 30))).toBe(operatingDayIn(at(2026, 6, 15, 4, 30), SOURCE_TIME_ZONE, CUTOFF));
  });
});
