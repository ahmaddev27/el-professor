import { describe, expect, it } from 'vitest';
import { EMPTY_CELL, deCount, deDate, deDateTime, shortId } from './platformFormat';

// vitest.config.ts pins TZ=Europe/Berlin, the zone the product runs in.
describe('deDate', () => {
  it('writes the German order, never the US one', () => {
    expect(deDate('2026-09-16T10:30:00Z')).toBe('16.09.2026');
    expect(deDate('2026-01-05T12:00:00Z')).toBe('05.01.2026');
  });

  it('reads a bare date column as that day', () => {
    expect(deDate('2027-03-31')).toBe('31.03.2027');
  });

  it('is an em dash for a missing or unreadable value', () => {
    expect(deDate(null)).toBe(EMPTY_CELL);
    expect(deDate(undefined)).toBe(EMPTY_CELL);
    expect(deDate('')).toBe(EMPTY_CELL);
    expect(deDate('not a date')).toBe(EMPTY_CELL);
  });
});

describe('deDateTime', () => {
  it('carries the second, which is what orders two audit rows', () => {
    expect(deDateTime('2026-09-16T10:30:07Z')).toBe('16.09.2026 12:30:07');
  });

  it('is an em dash for a missing value', () => {
    expect(deDateTime(null)).toBe(EMPTY_CELL);
  });
});

describe('deCount', () => {
  it('groups thousands with a dot', () => {
    expect(deCount(0)).toBe('0');
    expect(deCount(999)).toBe('999');
    expect(deCount(1234)).toBe('1.234');
    expect(deCount(1234567)).toBe('1.234.567');
  });
});

describe('shortId', () => {
  it('shows the head of a uuid', () => {
    expect(shortId('11111111-1111-4111-8111-111111111111')).toBe('11111111…');
    expect(shortId('abc')).toBe('abc');
    expect(shortId(null)).toBe(EMPTY_CELL);
  });
});
