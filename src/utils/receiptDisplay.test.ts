import { describe, expect, it } from 'vitest';
import type { Receipt } from '../types/receipt';
import {
  clockTime,
  numberOrUndefined,
  receiptAuthor,
  receiptFuelFigures,
  receiptFuelParts,
  receiptStationCell,
  textOrNull,
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

describe('receiptFuelFigures', () => {
  it('formats each figure alone, the price at three places', () => {
    expect(receiptFuelFigures({ ...BASE, litres: 25.87, pricePerLitre: 2.049, odometerKm: 20140, rangeKm: 793 }))
      .toEqual({ litres: '25,87', pricePerLitre: '2,049', odometerKm: '20.140', rangeKm: '793' });
  });

  it('an absent figure is null, and a real zero is kept as 0', () => {
    expect(receiptFuelFigures(BASE)).toEqual({ litres: null, pricePerLitre: null, odometerKm: null, rangeKm: null });
    expect(receiptFuelFigures({ ...BASE, rangeKm: 0 }).rangeKm).toBe('0');
  });

  it('textOrNull drops blanks', () => {
    expect(textOrNull('  ')).toBeNull();
    expect(textOrNull(undefined)).toBeNull();
    expect(textOrNull('Solingen')).toBe('Solingen');
  });
});

describe('receiptStationCell (27.10.2026)', () => {
  it('stacks the split header: brand, operator, street', () => {
    expect(receiptStationCell({
      ...BASE,
      merchantName: 'JET Tankstelle Detlev Wüstenfelder',
      stationName: 'JET Tankstelle',
      operatorName: 'Detlev Wüstenfelder',
      street: 'Eckeseyer Straße 113-115',
    })).toEqual({
      name: 'JET Tankstelle',
      operator: 'Detlev Wüstenfelder',
      street: 'Eckeseyer Straße 113-115',
    });
  });

  it('keeps an old row readable: the whole merchant name, nothing repeated', () => {
    // Rows from before the split carry the operator INSIDE merchantName; the
    // cell must not print the same person twice.
    expect(receiptStationCell({
      ...BASE,
      merchantName: 'JET Tankstelle Detlev Wüstenfelder',
      operatorName: 'Detlev Wüstenfelder',
    })).toEqual({
      name: 'JET Tankstelle Detlev Wüstenfelder',
      operator: null,
      street: null,
    });
  });

  it('is all null for a Beleg entered by hand with no merchant at all', () => {
    expect(receiptStationCell(BASE)).toEqual({ name: null, operator: null, street: null });
  });
});

describe('receiptSourceParts with a street', () => {
  it('reads merchant, street, city, time in that order', () => {
    expect(receiptSourceParts({
      ...BASE,
      merchantName: 'JET Tankstelle',
      street: 'Eckeseyer Straße 113-115',
      city: 'Hagen',
      receiptTime: '08:45:00',
    })).toEqual(['JET Tankstelle', 'Eckeseyer Straße 113-115', 'Hagen', '08:45']);
  });

  it('skips what the Beleg does not carry, as before', () => {
    expect(receiptSourceParts({ ...BASE, city: 'Hagen' })).toEqual(['Hagen']);
  });
});
