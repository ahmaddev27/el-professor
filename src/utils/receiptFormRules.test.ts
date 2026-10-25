import { describe, expect, it } from 'vitest';
import type { Receipt } from '../types/receipt';
import {
  EMPTY_DETAILS,
  FUEL_CATEGORY,
  RECEIPT_CATEGORIES,
  detailsFieldsFromReceipt,
  figureToInput,
  hasFuelFigures,
  parseDecimal,
  receiptDetailsProblem,
  receiptDetailsValues,
  type ReceiptDetailsFields,
} from './receiptFormRules';

const COMPLETE: ReceiptDetailsFields = {
  merchant: 'Shell Berlin',
  receiptTime: '14:32',
  postalCode: '10115',
  city: 'Berlin',
  litres: '41,47',
  pricePerLitre: '2,049',
  odometerKm: '123456',
  rangeKm: '480',
};

const fuel = (patch: Partial<ReceiptDetailsFields>): ReceiptDetailsFields => ({ ...COMPLETE, ...patch });

describe('the fuel group exists only for the refuel category', () => {
  it('is Tanken, which the Tankenquote counts', () => {
    expect(FUEL_CATEGORY).toBe('Tanken');
    expect(RECEIPT_CATEGORIES).toContain(FUEL_CATEGORY);
  });

  it('is on for Tanken and off for every other category', () => {
    expect(hasFuelFigures('Tanken')).toBe(true);
    for (const category of RECEIPT_CATEGORIES.filter(c => c !== 'Tanken')) {
      expect(hasFuelFigures(category)).toBe(false);
    }
    expect(hasFuelFigures(null)).toBe(false);
  });

  it('does not check fuel figures for a car wash, even if they are junk', () => {
    expect(receiptDetailsProblem('Autowäsche', fuel({ litres: 'abc', odometerKm: '1' }), 'create')).toBeNull();
  });

  it('checks them for Tanken', () => {
    expect(receiptDetailsProblem('Tanken', fuel({ litres: 'abc' }), 'create')).toBe('rec.err.litresInvalid');
  });

  it('drops fuel figures from the values of any other category', () => {
    const values = receiptDetailsValues('Autowäsche', COMPLETE);
    expect(values.litres).toBeUndefined();
    expect(values.pricePerLitre).toBeUndefined();
    expect(values.odometerKm).toBeUndefined();
    expect(values.rangeKm).toBeUndefined();
    expect(values.merchantName).toBe('Shell Berlin');
  });
});

describe('an absent figure is never 0', () => {
  it('stays undefined when the field is empty', () => {
    const values = receiptDetailsValues('Tanken', { ...EMPTY_DETAILS });
    expect(values).toEqual({
      merchantName: undefined, receiptTime: undefined, litres: undefined,
      pricePerLitre: undefined, odometerKm: undefined, rangeKm: undefined,
    });
  });

  it('treats whitespace as empty', () => {
    const values = receiptDetailsValues('Tanken', fuel({ odometerKm: '  ', rangeKm: ' ' }));
    expect(values.odometerKm).toBeUndefined();
    expect(values.rangeKm).toBeUndefined();
  });

  it('keeps a real zero range, which is a reading', () => {
    expect(receiptDetailsValues('Tanken', fuel({ rangeKm: '0' })).rangeKm).toBe(0);
  });

  it('reads an absent stored figure back as an empty field, not 0', () => {
    const fields = detailsFieldsFromReceipt({
      id: '1', receiptNumber: 'B', date: '2026-10-01', description: 'Tanken', driverName: 'x', expense: 10,
    });
    expect(fields.odometerKm).toBe('');
    expect(fields.litres).toBe('');
    expect(figureToInput(undefined)).toBe('');
  });
});

describe('the unit price keeps three decimals', () => {
  it('parses 2,049 as 2.049, not 2.05', () => {
    expect(parseDecimal('2,049', 3)).toBe(2.049);
    expect(receiptDetailsValues('Tanken', fuel({ pricePerLitre: '2,049' })).pricePerLitre).toBe(2.049);
  });

  it('refuses a fourth decimal rather than rounding it', () => {
    expect(receiptDetailsProblem('Tanken', fuel({ pricePerLitre: '2,0495' }), 'create')).toBe('rec.err.priceInvalid');
  });

  it('shows a stored 2.049 as 2,049', () => {
    expect(figureToInput(2.049)).toBe('2,049');
    expect(figureToInput(41.47)).toBe('41,47');
  });
});

describe('decimals', () => {
  it('accept comma and dot, refuse thousands separators and junk', () => {
    expect(parseDecimal('41,47', 2)).toBe(41.47);
    expect(parseDecimal('41.47', 2)).toBe(41.47);
    expect(parseDecimal('1.234,5', 2)).toBeNull();
    expect(parseDecimal('-3', 2)).toBeNull();
    expect(parseDecimal('', 2)).toBeNull();
    expect(parseDecimal('41,475', 2)).toBeNull();
  });

  it('refuse values the column would refuse', () => {
    expect(receiptDetailsProblem('Tanken', fuel({ litres: '0' }), 'create')).toBe('rec.err.litresInvalid');
    expect(receiptDetailsProblem('Tanken', fuel({ litres: '2001' }), 'create')).toBe('rec.err.litresInvalid');
    expect(receiptDetailsProblem('Tanken', fuel({ pricePerLitre: '21' }), 'create')).toBe('rec.err.priceInvalid');
  });
});

describe('a new Beleg is held to the driver apps rules', () => {
  it('accepts a complete refuel', () => {
    expect(receiptDetailsProblem('Tanken', COMPLETE, 'create')).toBeNull();
  });

  it.each([
    ['merchant', { merchant: ' ' }, 'rec.err.merchantRequired'],
    ['city', { city: '' }, 'rec.err.cityRequired'],
    ['time empty', { receiptTime: '' }, 'rec.err.timeInvalid'],
    ['time hour 25', { receiptTime: '25:00' }, 'rec.err.timeInvalid'],
    ['time minute 60', { receiptTime: '12:60' }, 'rec.err.timeInvalid'],
    ['time without colon', { receiptTime: '1432' }, 'rec.err.timeInvalid'],
    ['postal code short', { postalCode: '1011' }, 'rec.err.plzInvalid'],
    ['litres missing', { litres: '' }, 'rec.err.litresInvalid'],
    ['price missing', { pricePerLitre: '' }, 'rec.err.priceInvalid'],
    ['odometer missing', { odometerKm: '' }, 'rec.err.odometerInvalid'],
    ['odometer 3 digits', { odometerKm: '999' }, 'rec.err.odometerInvalid'],
    ['odometer 8 digits', { odometerKm: '12345678' }, 'rec.err.odometerInvalid'],
    ['range above the column bound', { rangeKm: '2001' }, 'rec.err.rangeInvalid'],
    ['range with a decimal', { rangeKm: '48,5' }, 'rec.err.rangeInvalid'],
  ] as const)('refuses %s', (_name, patch, key) => {
    expect(receiptDetailsProblem('Tanken', fuel(patch), 'create')).toBe(key);
  });

  it('does not require a postal code or the range', () => {
    expect(receiptDetailsProblem('Tanken', fuel({ postalCode: '', rangeKm: '' }), 'create')).toBeNull();
  });

  it('asks nothing of fuel for a car wash', () => {
    const wash = { ...EMPTY_DETAILS, merchant: 'Waschpark', city: 'Berlin', receiptTime: '09:05' };
    expect(receiptDetailsProblem('Autowäsche', wash, 'create')).toBeNull();
  });
});

describe('editing an older Beleg', () => {
  it('lets empty fields stay empty', () => {
    expect(receiptDetailsProblem('Tanken', EMPTY_DETAILS, 'edit')).toBeNull();
  });

  it('still refuses a filled field that is wrong', () => {
    expect(receiptDetailsProblem('Tanken', { ...EMPTY_DETAILS, receiptTime: '25:00' }, 'edit')).toBe('rec.err.timeInvalid');
    expect(receiptDetailsProblem('Tanken', { ...EMPTY_DETAILS, litres: 'x' }, 'edit')).toBe('rec.err.litresInvalid');
    expect(receiptDetailsProblem('Tanken', { ...EMPTY_DETAILS, odometerKm: '12' }, 'edit')).toBe('rec.err.odometerInvalid');
  });
});

describe('a stored Beleg round-trips through the form', () => {
  const stored: Receipt = {
    id: '1', receiptNumber: 'BEL-1', date: '2026-10-01', description: 'Tanken', driverName: 'Ali', expense: 85,
    postalCode: '10115', city: 'Berlin', merchantName: 'Shell', receiptTime: '14:32:00',
    litres: 41.47, pricePerLitre: 2.049, odometerKm: 123456, rangeKm: 480,
  };

  it('shows the time without seconds and the price with three decimals', () => {
    const fields = detailsFieldsFromReceipt(stored);
    expect(fields.receiptTime).toBe('14:32');
    expect(fields.pricePerLitre).toBe('2,049');
    expect(fields.litres).toBe('41,47');
  });

  it('saves the same figures it was given', () => {
    const values = receiptDetailsValues('Tanken', detailsFieldsFromReceipt(stored));
    expect(values).toEqual({
      merchantName: 'Shell', receiptTime: '14:32', litres: 41.47, pricePerLitre: 2.049, odometerKm: 123456, rangeKm: 480,
    });
  });
});
