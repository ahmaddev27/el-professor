import { describe, expect, it } from 'vitest';
import { formatCentsDe, formatCentsForInput, parseGermanAmountToCents, toCents } from './money';

describe('toCents', () => {
  it('converts database numbers without float drift', () => {
    expect(toCents(0)).toBe(0);
    expect(toCents(0.1)).toBe(10);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(1234.56)).toBe(123456);
    expect(toCents(99999999.99)).toBe(9999999999);
    expect(toCents(-12.5)).toBe(-1250);
  });

  it('converts numeric strings exactly, rounding half away from zero', () => {
    expect(toCents('1234.56')).toBe(123456);
    expect(toCents('1234')).toBe(123400);
    expect(toCents('0.5')).toBe(50);
    expect(toCents('1.005')).toBe(101);
    expect(toCents('1.0049')).toBe(100);
    expect(toCents('-1.005')).toBe(-101);
    expect(toCents(' 7.10 ')).toBe(710);
  });

  it('refuses what is not an amount instead of reading it as zero', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'abc', '1,50', '', '1.2.3']) {
      expect(() => toCents(bad)).toThrow(RangeError);
    }
  });
});

describe('formatCentsDe', () => {
  it('writes German notation with thousands separators', () => {
    expect(formatCentsDe(0)).toBe('0,00');
    expect(formatCentsDe(5)).toBe('0,05');
    expect(formatCentsDe(99999)).toBe('999,99');
    expect(formatCentsDe(100000)).toBe('1.000,00');
    expect(formatCentsDe(123456)).toBe('1.234,56');
    expect(formatCentsDe(99999999)).toBe('999.999,99');
    expect(formatCentsDe(123456789)).toBe('1.234.567,89');
    expect(formatCentsDe(-123456)).toBe('-1.234,56');
  });

  it('matches what the Quittung printed through toLocaleString("de-DE")', () => {
    for (const cents of [0, 1, 1999, 100000, 123456, 99999999]) {
      const viaIntl = (cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      expect(formatCentsDe(cents)).toBe(viaIntl);
    }
  });

  it('refuses fractional cents', () => {
    expect(() => formatCentsDe(1.5)).toThrow(RangeError);
  });
});

describe('parseGermanAmountToCents', () => {
  it('reads German amounts', () => {
    expect(parseGermanAmountToCents('1.234,56')).toBe(123456);
    expect(parseGermanAmountToCents('1234,56')).toBe(123456);
    expect(parseGermanAmountToCents('1234,5')).toBe(123450);
    expect(parseGermanAmountToCents('12,')).toBe(1200);
    expect(parseGermanAmountToCents('0,01')).toBe(1);
    expect(parseGermanAmountToCents('1.000.000,00')).toBe(100000000);
    expect(parseGermanAmountToCents(' 1.234,56 € ')).toBe(123456);
    expect(parseGermanAmountToCents('250 EUR')).toBe(25000);
  });

  it('reads what toLocaleString("de-DE") prints as currency, no-break space included', () => {
    const printed = (1234.56).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
    expect(printed).toMatch(/\u00a0€$/);
    expect(parseGermanAmountToCents(printed)).toBe(123456);
  });

  it('reads dots in groups of three as thousands, a single short fraction as decimals', () => {
    expect(parseGermanAmountToCents('1.234')).toBe(123400);
    expect(parseGermanAmountToCents('12.345')).toBe(1234500);
    expect(parseGermanAmountToCents('1234.56')).toBe(123456);
    expect(parseGermanAmountToCents('12.5')).toBe(1250);
    expect(parseGermanAmountToCents('1234')).toBe(123400);
  });

  it('refuses what it cannot read without guessing', () => {
    for (const bad of ['', 'abc', '12abc', '-5', '1,234.56', '1,2,3', '12,345', '1.2345', ',50', '1.23.45', '0.500', '0.500,00']) {
      expect(parseGermanAmountToCents(bad)).toBeNull();
    }
  });
});

describe('formatCentsForInput', () => {
  it('writes a decimal comma and no thousands separator', () => {
    expect(formatCentsForInput(0)).toBe('0,00');
    expect(formatCentsForInput(5)).toBe('0,05');
    expect(formatCentsForInput(123456)).toBe('1234,56');
    expect(formatCentsForInput(-123456)).toBe('-1234,56');
  });

  it('round-trips through parseGermanAmountToCents', () => {
    for (const cents of [0, 1, 99999, 100000, 100001, 123456, 1000000, 99999999]) {
      expect(parseGermanAmountToCents(formatCentsForInput(cents))).toBe(cents);
    }
  });
});
