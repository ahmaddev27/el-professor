import { describe, expect, it } from 'vitest';
import { formatDate, formatEuro, formatEuroCents, formatNumber, formatPercent } from './format';

const NBSP = ' ';

describe('German display formatting', () => {
  it('formats euro amounts with a decimal comma and a non-breaking space before the sign', () => {
    expect(formatEuro(48216.4)).toBe(`48.216,40${NBSP}€`);
    expect(formatEuro(0)).toBe(`0,00${NBSP}€`);
    expect(formatEuro(-1234.5)).toBe(`-1.234,50${NBSP}€`);
  });

  it('formats integer cents without going through a float', () => {
    expect(formatEuroCents(4821640)).toBe(`48.216,40${NBSP}€`);
    expect(formatEuroCents(-5)).toBe(`-0,05${NBSP}€`);
    expect(formatEuroCents(99_999_999)).toBe(`999.999,99${NBSP}€`);
  });

  it('rounds a stored amount to the cent half away from zero, like toCents', () => {
    expect(formatEuro(0.125)).toBe(`0,13${NBSP}€`);
    expect(formatEuro(-0.125)).toBe(`-0,13${NBSP}€`);
    expect(formatEuro(-0.001)).toBe(`0,00${NBSP}€`);
  });

  it('refuses a value that is not an amount instead of printing it', () => {
    expect(() => formatEuro(Number.NaN)).toThrow(RangeError);
    expect(() => formatEuroCents(12.5)).toThrow(RangeError);
  });

  it('formats plain numbers with thousands dots', () => {
    expect(formatNumber(184312)).toBe('184.312');
    expect(formatNumber(41.47, 2)).toBe('41,47');
  });

  it('formats a ratio as a German percentage', () => {
    expect(formatPercent(0.3804)).toBe(`38,0${NBSP}%`);
    expect(formatPercent(0.068, 1)).toBe(`6,8${NBSP}%`);
  });

  it('turns stored dates into DD.MM.YYYY without a timezone shift', () => {
    expect(formatDate('2026-09-14')).toBe('14.09.2026');
    expect(formatDate('2026-01-01T00:30:00Z')).toBe('01.01.2026');
    expect(formatDate('not a date')).toBe('not a date');
  });
});
