import { describe, expect, it } from 'vitest';
import type { Receipt } from '../types/receipt';
import {
  clockTime,
  numberOrUndefined,
  receiptAuthor,
  receiptFuelParts,
  receiptSourceParts,
} from './receiptDisplay';

const BASE: Receipt = {
  id: 'r1',
  receiptNumber: 'BEL-1-1',
  date: '2026-10-07',
  description: 'Tanken',
  driverName: 'Omar Khalil',
  expense: 41.47,
};

const LABELS = { odometer: 'Kilometerstand', rangeLeft: 'Restreichweite' };

describe('receiptFuelParts', () => {
  it('prints the unit price at THREE places, because 1,789 and 1,79 are different prices', () => {
    const parts = receiptFuelParts({ ...BASE, pricePerLitre: 1.789 }, LABELS);
    expect(parts).toEqual(['1,789 €/l']);
  });

  it('uses the decimal comma, thousands dot and a unit on every figure', () => {
    const parts = receiptFuelParts(
      { ...BASE, litres: 41.47, pricePerLitre: 1.789, odometerKm: 25382, rangeKm: 277 },
      LABELS,
    );
    expect(parts).toEqual([
      '41,47 l',
      '1,789 €/l',
      'Kilometerstand 25.382 km',
      'Restreichweite 277 km',
    ]);
  });

  it('shows a range of zero, which is a reading, and omits an absent figure', () => {
    expect(receiptFuelParts({ ...BASE, rangeKm: 0 }, LABELS)).toEqual(['Restreichweite 0 km']);
    expect(receiptFuelParts(BASE, LABELS)).toEqual([]);
  });
});

describe('receiptSourceParts', () => {
  it('is merchant, city and the printed time without its seconds', () => {
    const parts = receiptSourceParts({
      ...BASE, merchantName: 'ARAL Tankstelle', city: 'Berlin', receiptTime: '14:32:00',
    });
    expect(parts).toEqual(['ARAL Tankstelle', 'Berlin', '14:32']);
  });

  it('skips what the Beleg does not carry, blanks included', () => {
    expect(receiptSourceParts({ ...BASE, city: 'Berlin', merchantName: '  ' })).toEqual(['Berlin']);
    expect(receiptSourceParts(BASE)).toEqual([]);
  });
});

describe('clockTime', () => {
  it('trims seconds and refuses what is not a time', () => {
    expect(clockTime('09:05:00')).toBe('09:05');
    expect(clockTime('nonsense')).toBeNull();
    expect(clockTime(undefined)).toBeNull();
  });
});

describe('numberOrUndefined', () => {
  it('keeps a zero, drops null and blank, and never yields NaN', () => {
    expect(numberOrUndefined(0)).toBe(0);
    expect(numberOrUndefined('1.789')).toBe(1.789);
    expect(numberOrUndefined(null)).toBeUndefined();
    expect(numberOrUndefined('')).toBeUndefined();
    expect(numberOrUndefined('abc')).toBeUndefined();
  });
});

describe('receiptAuthor', () => {
  const names = new Map([['u1', 'Y&A Mobility Verwaltung']]);

  it('names the DRIVER for a Beleg from the app, not the administrator', () => {
    const fromApp: Receipt = { ...BASE, createdBy: 'u1', submittedByName: 'Omar Khalil' };
    expect(receiptAuthor(fromApp, names, 'unbekannt')).toBe('Omar Khalil');
  });

  it('resolves a user for a Beleg someone entered, and is unknown when nobody can be found', () => {
    expect(receiptAuthor({ ...BASE, createdBy: 'u1' }, names, 'unbekannt')).toBe('Y&A Mobility Verwaltung');
    expect(receiptAuthor({ ...BASE, createdBy: 'ghost' }, names, 'unbekannt')).toBe('unbekannt');
    expect(receiptAuthor(BASE, names, 'unbekannt')).toBe('unbekannt');
  });

  it('does not treat a blank driver name as an author', () => {
    expect(receiptAuthor({ ...BASE, createdBy: 'u1', submittedByName: '   ' }, names, 'x'))
      .toBe('Y&A Mobility Verwaltung');
  });
});
