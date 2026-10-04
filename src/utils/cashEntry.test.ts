import { describe, expect, it } from 'vitest';
import { cashEntryRefusal, formatGermanDate, parseGermanDate, validateCashEntry } from './cashEntry';

describe('parseGermanDate', () => {
  it('reads DD.MM.YYYY as an ISO day', () => {
    expect(parseGermanDate('03.10.2026')).toBe('2026-10-03');
    expect(parseGermanDate('3.1.2026')).toBe('2026-01-03');
  });
  it('refuses a day the calendar does not have, US order and a two-digit year', () => {
    expect(parseGermanDate('31.02.2026')).toBeNull();
    expect(parseGermanDate('10/03/2026')).toBeNull();
    expect(parseGermanDate('03.10.26')).toBeNull();
    expect(parseGermanDate('01.01.1999')).toBeNull();
  });
  it('round-trips through formatGermanDate', () => {
    expect(formatGermanDate('2026-10-03')).toBe('03.10.2026');
  });
});

describe('validateCashEntry', () => {
  const today = '2026-10-03';
  it('accepts a German amount and returns cents', () => {
    const result = validateCashEntry({ amountText: '1.234,50', dateText: '03.10.2026', purpose: ' Einlage ' }, today);
    expect(result).toEqual({ ok: true, entry: { amountCents: 123450, date: '2026-10-03', purpose: 'Einlage' } });
  });
  it('flags every bad field at once', () => {
    const result = validateCashEntry({ amountText: '0', dateText: '04.10.2026', purpose: '  ' }, today);
    expect(result).toEqual({ ok: false, errors: { amount: true, dateFuture: true, purpose: true } });
  });
  it('refuses an amount with three decimals rather than rounding it', () => {
    const result = validateCashEntry({ amountText: '1,234', dateText: '03.10.2026', purpose: 'x' }, today);
    expect(result.ok).toBe(false);
  });
});

describe('cashEntryRefusal', () => {
  it('takes the stable reason from the hint', () => {
    expect(cashEntryRefusal({ code: '42501', hint: 'platform_session_not_allowed' })).toBe('platform_session_not_allowed');
  });
  it('treats a bare permission error as not_authorized and a silent one as unknown outcome', () => {
    expect(cashEntryRefusal({ code: '42501', hint: 'Grant it' })).toBe('not_authorized');
    expect(cashEntryRefusal({ code: '', hint: null })).toBe('no_response');
    expect(cashEntryRefusal({ code: '500', hint: null })).toBe('unexpected');
  });
});
