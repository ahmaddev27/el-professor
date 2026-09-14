import { describe, expect, it } from 'vitest';
import { MAX_AMOUNT_IN_WORDS_CENTS } from './germanAmountInWords';
import { formatCentsForInput } from './money';
import { parseQuittungAmountCents } from './quittungAmount';

/**
 * The TrinkgeldQuittungModal amount field corrupted every amount of 1000 € or more.
 *
 * It prefilled the field with `fmtAmount(total).replace('.', ',')`. fmtAmount
 * already formats German — 1234.56 becomes "1.234,56" — so the replace turned
 * the thousands dot into a second comma: "1,234,56". The export then read it
 * back with `parseFloat(amount.replace(',', '.'))`, i.e. parseFloat("1.234,56"),
 * which stops at the second separator: 1.234, printed as 1,23 €. A user typing
 * "1.500" got 1,50 €.
 *
 * The modal now prefills with formatCentsForInput and reads with
 * parseQuittungAmountCents; these tests are that round trip.
 */
describe('Trinkgeld-Quittung amount field — 1000 € and more', () => {
  it('reproduces the old corruption, so the test is about the real bug', () => {
    const oldFmt = (v: number) => v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const oldPrefill = oldFmt(1234.56).replace('.', ',');
    expect(oldPrefill).toBe('1,234,56');
    expect(oldFmt(parseFloat(oldPrefill.replace(',', '.')))).toBe('1,23');
  });

  it('reads back exactly what it prefilled, across the thousands boundary', () => {
    for (const cents of [0, 1, 99_999, 100_000, 100_001, 123_456, 1_000_000, 12_345_678, MAX_AMOUNT_IN_WORDS_CENTS]) {
      expect(parseQuittungAmountCents(formatCentsForInput(cents))).toBe(cents);
    }
  });

  it('prefills without a thousands separator that could be misread', () => {
    expect(formatCentsForInput(123_456)).toBe('1234,56');
    expect(formatCentsForInput(100_000)).toBe('1000,00');
    expect(formatCentsForInput(5)).toBe('0,05');
  });

  it('reads an amount typed with a thousands dot as thousands', () => {
    expect(parseQuittungAmountCents('1.500')).toBe(150_000);
    expect(parseQuittungAmountCents('1.234,56')).toBe(123_456);
    expect(parseQuittungAmountCents('1234,56 €')).toBe(123_456);
  });

  it('refuses the corrupted prefill instead of printing 1,23 €', () => {
    expect(parseQuittungAmountCents('1,234,56')).toBeNull();
  });

  it('refuses what cannot be read or written out in words', () => {
    for (const bad of ['', 'abc', '-5', '12,345', '1.000.000,00']) {
      expect(parseQuittungAmountCents(bad)).toBeNull();
    }
  });
});
