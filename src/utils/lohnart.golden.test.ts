/**
 * Golden-master tests for computeLohnartSeconds — the live premium calculation
 * in the historical Arbeitsstunden pipeline.
 *
 * These record CURRENT behaviour. Several findings say this function is wrong
 * (FINDINGS.md H16/H17: night hours receive a surcharge but no base wage;
 * H19: Sunday and holiday premiums cumulate; H20: the night window boundary
 * disagrees with the monthly pipeline). None of that is asserted as correct
 * here. The point is that when Phase 3 corrects it against §3b EStG, every
 * changed number surfaces as a failing snapshot to be reviewed on purpose.
 *
 * The shift shapes below are the ones the findings say matter: crossing
 * midnight, running Sunday into Monday, falling on a holiday that is also a
 * Sunday, and sitting entirely inside the night window.
 */
import { describe, it, expect } from 'vitest';
import { computeLohnartSeconds, getGermanNationalHolidays } from './historicalWorkingHoursCleanEngine';

/** Local-time constructor, matching how the engine reads dates. */
const at = (y: number, m: number, d: number, hh: number, mm = 0) =>
  new Date(y, m - 1, d, hh, mm, 0, 0).getTime();

const hours = (sec: number) => Math.round((sec / 3600) * 100) / 100;

/** Render a result in hours so a diff is readable by a human reviewer. */
const asHours = (r: ReturnType<typeof computeLohnartSeconds>) => ({
  base: hours(r.baseSec),
  night25: hours(r.night25Sec),
  night40: hours(r.night40Sec),
  sunday: hours(r.sundaySec),
  holiday: hours(r.holidaySec),
  total: hours(r.totalSec),
});

const NO_HOLIDAYS = new Set<string>();

describe('computeLohnartSeconds — degenerate input', () => {
  it('returns all zeros when the shift ends before it starts', () => {
    const r = computeLohnartSeconds(at(2026, 3, 10, 12), at(2026, 3, 10, 8), NO_HOLIDAYS);
    expect(asHours(r)).toEqual({ base: 0, night25: 0, night40: 0, sunday: 0, holiday: 0, total: 0 });
  });

  it('returns all zeros for a zero-length shift', () => {
    const r = computeLohnartSeconds(at(2026, 3, 10, 8), at(2026, 3, 10, 8), NO_HOLIDAYS);
    expect(asHours(r)).toEqual({ base: 0, night25: 0, night40: 0, sunday: 0, holiday: 0, total: 0 });
  });
});

describe('computeLohnartSeconds — a plain weekday shift', () => {
  it('classifies 08:00–16:00 on a Tuesday', () => {
    // 10 March 2026 is a Tuesday.
    const r = computeLohnartSeconds(at(2026, 3, 10, 8), at(2026, 3, 10, 16), NO_HOLIDAYS);
    expect(asHours(r)).toMatchInlineSnapshot(`
      {
        "base": 8,
        "holiday": 0,
        "night25": 0,
        "night40": 0,
        "sunday": 0,
        "total": 8,
      }
    `);
  });

  it('classifies an evening shift running into the night window', () => {
    const r = computeLohnartSeconds(at(2026, 3, 10, 18), at(2026, 3, 10, 23, 30), NO_HOLIDAYS);
    expect(asHours(r)).toMatchInlineSnapshot(`
      {
        "base": 2,
        "holiday": 0,
        "night25": 3.5,
        "night40": 0,
        "sunday": 0,
        "total": 5.5,
      }
    `);
  });
});

describe('computeLohnartSeconds — crossing midnight', () => {
  it('splits a Tuesday 22:00 -> Wednesday 06:00 shift', () => {
    const r = computeLohnartSeconds(at(2026, 3, 10, 22), at(2026, 3, 11, 6), NO_HOLIDAYS);
    expect(asHours(r)).toMatchInlineSnapshot(`
      {
        "base": 0,
        "holiday": 0,
        "night25": 4,
        "night40": 4,
        "sunday": 0,
        "total": 8,
      }
    `);
  });

  it('handles a pure night shift entirely inside 00:00–04:00', () => {
    const r = computeLohnartSeconds(at(2026, 3, 11, 0), at(2026, 3, 11, 4), NO_HOLIDAYS);
    expect(asHours(r)).toMatchInlineSnapshot(`
      {
        "base": 0,
        "holiday": 0,
        "night25": 0,
        "night40": 4,
        "sunday": 0,
        "total": 4,
      }
    `);
  });
});

describe('computeLohnartSeconds — Sunday attribution', () => {
  it('classifies a full Sunday shift', () => {
    // 8 March 2026 is a Sunday.
    const r = computeLohnartSeconds(at(2026, 3, 8, 8), at(2026, 3, 8, 16), NO_HOLIDAYS);
    expect(asHours(r)).toMatchInlineSnapshot(`
      {
        "base": 8,
        "holiday": 0,
        "night25": 0,
        "night40": 0,
        "sunday": 8,
        "total": 8,
      }
    `);
  });

  it('splits a Sunday 20:00 -> Monday 04:00 shift across the day boundary', () => {
    const r = computeLohnartSeconds(at(2026, 3, 8, 20), at(2026, 3, 9, 4), NO_HOLIDAYS);
    expect(asHours(r)).toMatchInlineSnapshot(`
      {
        "base": 0,
        "holiday": 0,
        "night25": 4,
        "night40": 4,
        "sunday": 4,
        "total": 8,
      }
    `);
  });
});

describe('computeLohnartSeconds — holidays', () => {
  const holidays2026 = getGermanNationalHolidays(2026);

  it('classifies a shift on 1 May (a Friday in 2026)', () => {
    const r = computeLohnartSeconds(at(2026, 5, 1, 8), at(2026, 5, 1, 16), holidays2026);
    expect(asHours(r)).toMatchInlineSnapshot(`
      {
        "base": 8,
        "holiday": 8,
        "night25": 0,
        "night40": 0,
        "sunday": 0,
        "total": 8,
      }
    `);
  });

  it('classifies a holiday that also falls on a Sunday', () => {
    // H19 says Sunday and Feiertag premiums cumulate here. Recorded, not endorsed.
    // 4 October 2026 is a Sunday; pin a synthetic holiday on it to isolate the rule.
    const holidaySunday = new Set(['2026-10-04']);
    const r = computeLohnartSeconds(at(2026, 10, 4, 8), at(2026, 10, 4, 16), holidaySunday);
    expect(asHours(r)).toMatchInlineSnapshot(`
      {
        "base": 8,
        "holiday": 8,
        "night25": 0,
        "night40": 0,
        "sunday": 8,
        "total": 8,
      }
    `);
  });

  it('splits a shift running from a holiday into a normal day', () => {
    const r = computeLohnartSeconds(at(2026, 12, 26, 20), at(2026, 12, 27, 4), holidays2026);
    expect(asHours(r)).toMatchInlineSnapshot(`
      {
        "base": 0,
        "holiday": 4,
        "night25": 4,
        "night40": 4,
        "sunday": 4,
        "total": 8,
      }
    `);
  });
});

describe('computeLohnartSeconds — invariants that must survive any Phase 3 change', () => {
  const cases: Array<[string, number, number, Set<string>]> = [
    ['weekday day',        at(2026, 3, 10, 8),  at(2026, 3, 10, 16), NO_HOLIDAYS],
    ['weekday night',      at(2026, 3, 10, 22), at(2026, 3, 11, 6),  NO_HOLIDAYS],
    ['pure night',         at(2026, 3, 11, 0),  at(2026, 3, 11, 4),  NO_HOLIDAYS],
    ['sunday into monday', at(2026, 3, 8, 20),  at(2026, 3, 9, 4),   NO_HOLIDAYS],
    ['long shift',         at(2026, 3, 10, 6),  at(2026, 3, 11, 2),  NO_HOLIDAYS],
  ];

  it.each(cases)('totalSec equals the elapsed wall-clock time (%s)', (_label, start, end, holidaySet) => {
    const r = computeLohnartSeconds(start, end, holidaySet);
    expect(r.totalSec).toBe((end - start) / 1000);
  });

  it.each(cases)('the 25%% and 40%% night buckets never overlap (%s)', (_label, start, end, holidaySet) => {
    const r = computeLohnartSeconds(start, end, holidaySet);
    // CLAUDE.md: 1500 and 1501 are mutually exclusive. Their sum can never
    // exceed the shift, whatever the split between them turns out to be.
    expect(r.night25Sec + r.night40Sec).toBeLessThanOrEqual(r.totalSec);
  });

  it.each(cases)('no bucket is negative (%s)', (_label, start, end, holidaySet) => {
    const r = computeLohnartSeconds(start, end, holidaySet);
    for (const [name, value] of Object.entries(r)) {
      expect(value, name).toBeGreaterThanOrEqual(0);
    }
  });
});
