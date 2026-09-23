import { describe, expect, it } from 'vitest';
import { intervalText, minutesText } from './text';

describe('German figures in findings', () => {
  it('writes whole minutes without a decimal, otherwise one, with a comma', () => {
    expect(minutesText(20)).toBe('20');
    expect(minutesText(4.5)).toBe('4,5');
    expect(minutesText(19.9999)).toBe('20');
    expect(minutesText(3300)).toBe('3.300');
  });

  it('writes an interval with one date, or both across midnight', () => {
    const start = new Date('2026-08-03T23:50:00').getTime();
    expect(intervalText(start - 60 * 60_000, start)).toBe('03.08.2026 22:50–23:50');
    expect(intervalText(start, start + 20 * 60_000)).toBe('03.08.2026 23:50→04.08.2026 00:10');
  });
});
