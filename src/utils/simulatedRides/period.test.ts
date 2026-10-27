import { describe, expect, it } from 'vitest';
import { SOURCE_TIME_ZONE, wallTimeToInstant } from '../fahrtenbuchImportParser';
import {
  buildPeriod,
  calendarDaysOfMonth,
  isoWeekdayOf,
  operatingDayIn,
  operatingDayStartIn,
  previousCivilDay,
} from './period';
import { operatingDayOf } from './time';
import { DEFAULT_SIMULATION_TENANT_SETTINGS } from './tenantSettings';

const at = (y: number, m: number, d: number, hour: number, minute: number, zone = SOURCE_TIME_ZONE): number => {
  const r = wallTimeToInstant({ year: y, month: m, day: d, hour, minute, second: 0 }, zone);
  if (r.kind !== 'ok') throw new Error(`reading is ${r.kind}`);
  return r.ms;
};

describe('day counts', () => {
  it.each([
    [2026, 1, 31],
    [2026, 4, 30],
    [2024, 2, 29],
    [2026, 2, 28],
  ])('%i-%i has %i days, first to last', (y, m, n) => {
    const days = calendarDaysOfMonth(y, m);
    const mm = String(m).padStart(2, '0');
    expect(days).toHaveLength(n);
    expect(days[0]).toBe(`${y}-${mm}-01`);
    expect(days[n - 1]).toBe(`${y}-${mm}-${n}`);
    const p = buildPeriod(y, m, DEFAULT_SIMULATION_TENANT_SETTINGS);
    expect(p).toHaveLength(n);
    expect(p[0].day).toBe(`${y}-${mm}-01`);
    expect(p[n - 1].day).toBe(`${y}-${mm}-${n}`);
  });
});

describe('operatingDayIn across the DST changes (TZ pinned to Berlin)', () => {
  it('dates 04:30 on the spring-forward day to that day, not the day before', () => {
    expect(operatingDayIn(at(2026, 3, 29, 4, 30), SOURCE_TIME_ZONE, 4)).toBe('2026-03-29');
  });
  it('dates 03:30 on that day to the previous day', () => {
    expect(operatingDayIn(at(2026, 3, 29, 3, 30), SOURCE_TIME_ZONE, 4)).toBe('2026-03-28');
  });
  it('behaves on the autumn change too', () => {
    expect(operatingDayIn(at(2026, 10, 25, 4, 30), SOURCE_TIME_ZONE, 4)).toBe('2026-10-25');
    expect(operatingDayIn(at(2026, 10, 25, 3, 30), SOURCE_TIME_ZONE, 4)).toBe('2026-10-24');
  });
  it('time.ts operatingDayOf delegates, so the regression stays fixed', () => {
    expect(operatingDayOf(at(2026, 3, 29, 4, 30))).toBe('2026-03-29');
    expect(operatingDayOf(at(2026, 3, 29, 3, 30))).toBe('2026-03-28');
  });
});

describe('operatingDayStartIn reports, never guesses', () => {
  // Berlin skips 02:00-03:00 on 2026-03-29 and repeats it on 2026-10-25.
  it('flags the skipped hour', () => {
    expect(operatingDayStartIn('2026-03-29', SOURCE_TIME_ZONE, 2)).toEqual({ kind: 'skipped' });
  });
  it('flags the repeated hour', () => {
    expect(operatingDayStartIn('2026-10-25', SOURCE_TIME_ZONE, 2)).toEqual({ kind: 'ambiguous' });
  });
  it('gives an instant on an ordinary reading', () => {
    expect(operatingDayStartIn('2026-06-15', SOURCE_TIME_ZONE, 4)).toEqual({ kind: 'ok', ms: at(2026, 6, 15, 4, 0) });
  });
  it('treats a malformed day as having no start', () => {
    expect(operatingDayStartIn('15.06.2026', SOURCE_TIME_ZONE, 4)).toEqual({ kind: 'skipped' });
  });
  it('buildPeriod carries the problem on that day', () => {
    const s = { ...DEFAULT_SIMULATION_TENANT_SETTINGS, operatingDayStartHour: 2 };
    const march = buildPeriod(2026, 3, s).find(d => d.day === '2026-03-29')!;
    expect(march.startMs).toBeNull();
    expect(march.startProblem).toBe('skipped');
    const oct = buildPeriod(2026, 10, s).find(d => d.day === '2026-10-25')!;
    expect(oct.startProblem).toBe('ambiguous');
  });
});

describe('transition days hold 23 and 25 hours', () => {
  // With a 04:00 cutoff the operating day that CONTAINS the change is the one
  // that starts the calendar day before it (28.03. 04:00 -> 29.03. 04:00).
  it('March: only 2026-03-28 is 23 h', () => {
    const p = buildPeriod(2026, 3, DEFAULT_SIMULATION_TENANT_SETTINGS);
    expect(p.filter(d => d.hours !== 24).map(d => [d.day, d.hours])).toEqual([['2026-03-28', 23]]);
  });
  it('October: only 2026-10-24 is 25 h', () => {
    const p = buildPeriod(2026, 10, DEFAULT_SIMULATION_TENANT_SETTINGS);
    expect(p.filter(d => d.hours !== 24).map(d => [d.day, d.hours])).toEqual([['2026-10-24', 25]]);
  });
});

describe('zone-free calendar helpers', () => {
  it('previousCivilDay crosses month, leap-day and year boundaries', () => {
    expect(previousCivilDay({ year: 2026, month: 3, day: 1 })).toEqual({ year: 2026, month: 2, day: 28 });
    expect(previousCivilDay({ year: 2024, month: 3, day: 1 })).toEqual({ year: 2024, month: 2, day: 29 });
    expect(previousCivilDay({ year: 2026, month: 1, day: 1 })).toEqual({ year: 2025, month: 12, day: 31 });
  });
  it('isoWeekdayOf is Monday=1 .. Sunday=7', () => {
    expect(isoWeekdayOf('2026-10-26')).toBe(1);
    expect(isoWeekdayOf('2026-10-25')).toBe(7);
    expect(isoWeekdayOf('2026-10-31')).toBe(6);
    expect(isoWeekdayOf('nonsense')).toBe(0);
  });
});

describe('the zone is a parameter', () => {
  it('UTC and UTC+14 date the same instant differently from Berlin', () => {
    const ms = at(2026, 6, 15, 5, 0); // 03:00Z, 17:00 in Kiritimati
    expect(operatingDayIn(ms, 'Europe/Berlin', 4)).toBe('2026-06-15');
    expect(operatingDayIn(ms, 'UTC', 4)).toBe('2026-06-14');
    expect(operatingDayIn(ms, 'Pacific/Kiritimati', 4)).toBe('2026-06-15');
  });
});
