import { describe, expect, it } from 'vitest';
import {
  computeReceiptFigures,
  salaryDueCents,
  sumPaidCents,
  type SalaryPaymentInput,
} from './salaryCashReceipt';

/**
 * The same scenario tests/rls/salary-cash.sql runs against the database, with
 * the same amounts, so the preview and the confirmation cannot drift apart
 * without one of the two failing.
 *
 * Salary S1 is due 1000,00 (amount_due, no netto). It is paid 400 and 250 in
 * cash on receipts, then 100 by bank, 50 as weekly "Bar zurück" and 20 in cash
 * by hand — leaving 180 for a third, final receipt.
 */
const S1 = { netto_salary: null, amount_due: 1000 };

const receipt = (amount: number): SalaryPaymentInput => ({
  payment_type: 'cash',
  amount,
  source_type: 'gehaltsquittung',
});

function figures(result: ReturnType<typeof computeReceiptFigures>) {
  if (!result.ok) throw new Error(`expected figures, got refusal ${result.refusal}`);
  return result.figures;
}

describe('computeReceiptFigures — the database scenario', () => {
  it('R1: a partial payment of 400', () => {
    const f = figures(computeReceiptFigures(S1, [], 40000));
    expect(f.dueCents).toBe(100000);
    expect(f.remainingBeforeCents).toBe(100000);
    expect(f.remainingAfterCents).toBe(60000);
    expect(f.isPartial).toBe(true);
  });

  it('R2: a second partial payment of 250 sees the first receipt', () => {
    const f = figures(computeReceiptFigures(S1, [receipt(400)], 25000));
    expect(f.paidCashCents.gehaltsquittung).toBe(40000);
    expect(f.remainingBeforeCents).toBe(60000);
    expect(f.remainingAfterCents).toBe(35000);
    expect(f.isPartial).toBe(true);
  });

  it('R3: bank, Bar zurück and hand-recorded cash count as paid, and the last 180 settles it', () => {
    const before: SalaryPaymentInput[] = [
      receipt(400),
      receipt(250),
      { payment_type: 'bank', amount: 100, source_type: 'manual' },
      { payment_type: 'cash', amount: 50, source_type: 'weekly_cash_difference' },
      { payment_type: 'cash', amount: 20, source_type: 'manual' },
    ];
    const f = figures(computeReceiptFigures(S1, before, 18000));
    expect(f.paidCashCents).toEqual({ manual: 2000, weeklyCashDifference: 5000, gehaltsquittung: 65000 });
    expect(f.paidBankCents).toBe(10000);
    expect(f.paidTotalCents).toBe(82000);
    expect(f.remainingBeforeCents).toBe(18000);
    expect(f.remainingAfterCents).toBe(0);
    expect(f.isPartial).toBe(false);

    const afterR3 = [...before, receipt(180)];
    expect(computeReceiptFigures(S1, afterR3, 1)).toEqual({ ok: false, refusal: 'already_paid', remainingBeforeCents: 0 });
  });

  it('a voided receipt no longer counts, so its amount can be paid again', () => {
    const withoutR2: SalaryPaymentInput[] = [
      receipt(400),
      receipt(180),
      { payment_type: 'bank', amount: 100, source_type: 'manual' },
      { payment_type: 'cash', amount: 50, source_type: 'weekly_cash_difference' },
      { payment_type: 'cash', amount: 20, source_type: 'manual' },
    ];
    const f = figures(computeReceiptFigures(S1, withoutR2, 25000));
    expect(f.remainingBeforeCents).toBe(25000);
    expect(f.isPartial).toBe(false);
  });

  it('S2: netto_salary wins over amount_due, so 800,01 is an overpayment and 800 is full', () => {
    const s2 = { netto_salary: 800, amount_due: 1200 };
    expect(computeReceiptFigures(s2, [], 80001)).toEqual({ ok: false, refusal: 'overpayment', remainingBeforeCents: 80000 });
    const f = figures(computeReceiptFigures(s2, [], 80000));
    expect(f.dueCents).toBe(80000);
    expect(f.isPartial).toBe(false);
  });
});

describe('salaryDueCents — COALESCE(netto_salary, amount_due, 0)', () => {
  it('prefers netto, including a netto of zero', () => {
    expect(salaryDueCents({ netto_salary: 800, amount_due: 1200 })).toBe(80000);
    expect(salaryDueCents({ netto_salary: 0, amount_due: 1200 })).toBe(0);
  });

  it('falls back to amount_due, then to zero', () => {
    expect(salaryDueCents({ netto_salary: null, amount_due: 1200 })).toBe(120000);
    expect(salaryDueCents({ netto_salary: null, amount_due: null })).toBe(0);
  });

  it('reads numeric strings exactly', () => {
    expect(salaryDueCents({ netto_salary: '1234.56', amount_due: null })).toBe(123456);
  });
});

describe('sumPaidCents', () => {
  it('bank is bank whatever its source; unknown cash sources count as cash by hand', () => {
    const { paidCashCents, paidBankCents } = sumPaidCents([
      { payment_type: 'bank', amount: 10, source_type: 'weekly_cash_difference' },
      { payment_type: 'cash', amount: 5, source_type: null },
      { payment_type: 'cash', amount: 3 },
      { payment_type: 'cash', amount: 2, source_type: 'something_new' },
    ]);
    expect(paidBankCents).toBe(1000);
    expect(paidCashCents).toEqual({ manual: 1000, weeklyCashDifference: 0, gehaltsquittung: 0 });
  });
});

describe('computeReceiptFigures — refusals', () => {
  it('refuses a payment that is not a positive whole number of cents, before anything else', () => {
    for (const bad of [0, -100, 12.5, Number.NaN]) {
      expect(computeReceiptFigures(S1, [], bad)).toMatchObject({ ok: false, refusal: 'invalid_amount' });
    }
    expect(computeReceiptFigures({ netto_salary: 0, amount_due: 0 }, [], 0)).toMatchObject({ refusal: 'invalid_amount' });
  });

  it('refuses any payment when nothing is due', () => {
    expect(computeReceiptFigures({ netto_salary: null, amount_due: null }, [], 1)).toEqual({
      ok: false, refusal: 'already_paid', remainingBeforeCents: 0,
    });
  });

  it('treats an existing overpayment as nothing remaining, not as a negative balance', () => {
    const overpaid: SalaryPaymentInput[] = [{ payment_type: 'bank', amount: 1200, source_type: 'manual' }];
    expect(computeReceiptFigures(S1, overpaid, 1)).toEqual({ ok: false, refusal: 'already_paid', remainingBeforeCents: 0 });
  });

  it('refuses one cent more than remaining and accepts exactly remaining', () => {
    expect(computeReceiptFigures(S1, [receipt(999.99)], 2)).toMatchObject({ refusal: 'overpayment', remainingBeforeCents: 1 });
    expect(figures(computeReceiptFigures(S1, [receipt(999.99)], 1)).remainingAfterCents).toBe(0);
  });

  it('does not refuse an exact payment that float arithmetic would call an overpayment', () => {
    // In floats 0.3 − 0.1 is 0.19999999999999998, so paying 0.20 would look like too much.
    const f = figures(computeReceiptFigures({ netto_salary: 0.3, amount_due: null }, [receipt(0.1)], 20));
    expect(f.remainingBeforeCents).toBe(20);
    expect(f.remainingAfterCents).toBe(0);
  });
});
