/**
 * A Beleg whose printed time is before 04:00 counts on the previous calendar
 * day (owner, 09.11.2026). The SQL twin is public.receipt_business_date(); the
 * last test reads the newest migration that defines it and fails when its cut
 * differs from RECEIPT_DAY_START.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RECEIPT_DAY_START, receiptBusinessDate, receiptCountsOn } from './receiptBusinessDate';
import { getBusinessMonth, getBusinessWeekRange } from './weekCalculations';

describe('receiptBusinessDate: the 04:00 cut', () => {
  it('moves 03:59 and 03:59:59 to the day before', () => {
    expect(receiptBusinessDate('2026-11-10', '03:59')).toBe('2026-11-09');
    expect(receiptBusinessDate('2026-11-10', '03:59:59')).toBe('2026-11-09');
  });

  it('keeps 04:00 and 04:00:00 on the printed date', () => {
    expect(receiptBusinessDate('2026-11-10', '04:00')).toBe('2026-11-10');
    expect(receiptBusinessDate('2026-11-10', '04:00:00')).toBe('2026-11-10');
    expect(receiptBusinessDate('2026-11-10', '04:00:01')).toBe('2026-11-10');
  });

  it('moves midnight, 00:00 and 00:05', () => {
    expect(receiptBusinessDate('2026-11-10', '00:00')).toBe('2026-11-09');
    expect(receiptBusinessDate('2026-11-10', '00:00:00')).toBe('2026-11-09');
    expect(receiptBusinessDate('2026-11-09', '00:05:00')).toBe('2026-11-08');
  });

  it('keeps the date when there is no time', () => {
    expect(receiptBusinessDate('2026-11-10', null)).toBe('2026-11-10');
    expect(receiptBusinessDate('2026-11-10', undefined)).toBe('2026-11-10');
    expect(receiptBusinessDate('2026-11-10', '')).toBe('2026-11-10');
    expect(receiptBusinessDate('2026-11-10')).toBe('2026-11-10');
  });

  it('does not touch an evening or midday time', () => {
    expect(receiptBusinessDate('2026-11-10', '12:30:00')).toBe('2026-11-10');
    expect(receiptBusinessDate('2026-11-10', '23:59:59')).toBe('2026-11-10');
  });

  it('crosses a month end: the 1st becomes the last day of the month before', () => {
    expect(receiptBusinessDate('2026-12-01', '01:00')).toBe('2026-11-30');
    expect(receiptBusinessDate('2026-03-01', '02:00')).toBe('2026-02-28');
    expect(receiptBusinessDate('2028-03-01', '02:00')).toBe('2028-02-29');
  });

  it('crosses a year end: 01.01 becomes 31.12', () => {
    expect(receiptBusinessDate('2027-01-01', '00:30')).toBe('2026-12-31');
  });

  it('accepts a timestamp-shaped date and returns the day only', () => {
    expect(receiptBusinessDate('2026-11-10T00:00:00', '01:00')).toBe('2026-11-09');
  });
});

describe('receiptCountsOn', () => {
  it('prefers the stored column and falls back to the rule', () => {
    expect(receiptCountsOn({ date: '2026-11-09', receiptTime: '00:05:00', businessDate: '2026-11-08' })).toBe('2026-11-08');
    expect(receiptCountsOn({ date: '2026-11-09', receiptTime: '00:05:00' })).toBe('2026-11-08');
    expect(receiptCountsOn({ date: '2026-11-09' })).toBe('2026-11-09');
  });
});

describe('the weekly consequence: Monday 00:05 is last week (months are 0-indexed)', () => {
  const week = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    const day = new Date(y, m - 1, d);
    const { monday } = getBusinessWeekRange(day);
    return { monday: monday.getDate(), month: getBusinessMonth(day).month };
  };

  it('09.11.2026 00:05 counts in the week of Monday 02.11, not the week of 09.11', () => {
    expect(week('2026-11-09').monday).toBe(9);
    const counted = receiptBusinessDate('2026-11-09', '00:05:00');
    expect(counted).toBe('2026-11-08');
    expect(week(counted).monday).toBe(2);
  });

  it('Monday 01.06.2026 02:00 moves into May (month index 4)', () => {
    expect(getBusinessMonth(new Date(2026, 5, 1)).month).toBe(5);
    const counted = receiptBusinessDate('2026-06-01', '02:00');
    expect(counted).toBe('2026-05-31');
    expect(week(counted).month).toBe(4);
  });
});

describe('the SQL twin', () => {
  it('cuts at the same time as the newest migration that defines it', () => {
    const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
    const defining = readdirSync(dir)
      .filter(file => file.endsWith('.sql'))
      .sort()
      .map(file => readFileSync(dir + file, 'utf8'))
      .filter(sql => /FUNCTION public\.receipt_business_date\(/.test(sql));
    if (defining.length === 0) throw new Error('no migration defines receipt_business_date()');

    const body = defining[defining.length - 1];
    const cut = /p_time\s*<\s*time\s*'(\d\d:\d\d(?::\d\d)?)'/.exec(body);
    expect(cut, 'the cut literal').not.toBeNull();
    expect(cut![1]).toBe(RECEIPT_DAY_START);
  });
});
