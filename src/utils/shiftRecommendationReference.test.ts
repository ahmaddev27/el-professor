import { describe, expect, it } from 'vitest';
import { referenceStats, type ReferenceTripRow } from './shiftRecommendationReference';

const ride = (cash: number, online: number, tip = 0): ReferenceTripRow => ({
  is_canceled: false, price_amount: cash + online, cash_amount: cash, online_amount: online, tip_amount: tip,
});
const cancelled: ReferenceTripRow = { is_canceled: true, price_amount: 5, cash_amount: 0, online_amount: 0, tip_amount: 0 };

describe('referenceStats', () => {
  it('counts rows per month and in total', () => {
    const stats = referenceStats([
      { year: 2026, month: 8, rows: [ride(10, 0), cancelled] },
      { year: 2026, month: 9, rows: [ride(0, 20), ride(0, 20), ride(5, 5)] },
    ]);
    expect(stats.months).toEqual([{ year: 2026, month: 8, rows: 2 }, { year: 2026, month: 9, rows: 3 }]);
    expect(stats.rows).toBe(5);
    expect(stats.completedRows).toBe(4);
    expect(stats.cancelledRows).toBe(1);
  });

  it('splits the payment between cash and online in cents, cancelled rides excluded', () => {
    const stats = referenceStats([{ year: 2026, month: 9, rows: [ride(30, 0), ride(0, 70), cancelled] }]);
    expect(stats.cashCents).toBe(3000);
    expect(stats.onlineCents).toBe(7000);
    expect(stats.cashShare).toBeCloseTo(0.3, 10);
    expect(stats.onlineShare).toBeCloseTo(0.7, 10);
  });

  it('takes the tip as a share of the fare revenue', () => {
    const stats = referenceStats([{ year: 2026, month: 9, rows: [ride(0, 100, 5), ride(0, 100, 5)] }]);
    expect(stats.fareCents).toBe(20000);
    expect(stats.tipCents).toBe(1000);
    expect(stats.tipShare).toBeCloseTo(0.05, 10);
  });

  it('takes the cancellation share of all rows', () => {
    const stats = referenceStats([{ year: 2026, month: 9, rows: [ride(10, 0), cancelled, cancelled, ride(10, 0)] }]);
    expect(stats.cancellationShare).toBe(0.5);
  });

  it('reads decimal strings as the database returns them', () => {
    const row: ReferenceTripRow = { is_canceled: false, price_amount: '12.50', cash_amount: '12.50', online_amount: '0.00', tip_amount: '1.20' };
    const stats = referenceStats([{ year: 2026, month: 9, rows: [row] }]);
    expect(stats.fareCents).toBe(1250);
    expect(stats.tipCents).toBe(120);
  });

  it('sets aside a row whose money cannot be read instead of counting it as zero', () => {
    const broken: ReferenceTripRow = { is_canceled: false, price_amount: 'abc', cash_amount: 0, online_amount: 0, tip_amount: 0 };
    const stats = referenceStats([{ year: 2026, month: 9, rows: [broken, ride(10, 0)] }]);
    expect(stats.unreadableRows).toBe(1);
    expect(stats.completedRows).toBe(1);
    expect(stats.fareCents).toBe(1000);
  });

  it('answers null, not zero, where there is nothing to divide', () => {
    const stats = referenceStats([]);
    expect(stats.cashShare).toBeNull();
    expect(stats.tipShare).toBeNull();
    expect(stats.cancellationShare).toBeNull();
  });
});
