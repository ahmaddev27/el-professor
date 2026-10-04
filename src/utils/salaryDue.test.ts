import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SALARY_RATIO,
  calcSalaryFromIncome,
  derivePaymentStatus,
  remainingDue,
  salaryBase,
  salaryDueState,
  type PaymentStatus,
} from './salaryDue';
import { calcSalaryAlerts, type DriverRecord, type SalaryRecord } from './overviewHelpers';

/**
 * The salary base, what is owed against it, and the status that follows.
 *
 * Each block below carries its negative control: the expression that shipped,
 * re-implemented inline, asserted to give the answer this module now refuses.
 * A regression therefore fails a test rather than being reasoned about.
 *
 * The production figures these assertions stand for, measured on staging
 * 28.09.2026 (53 salary rows across 24 companies): 28 rows carry a stored
 * `amount_due` the screen's live recomputation no longer agrees with —
 * 25.201,26 € in absolute difference — and **5 of them carry a stored
 * `payment_status` of `paid` while money is still owed against the live base**.
 */

describe('salaryBase — COALESCE(netto_salary, amount_due)', () => {
  it('prefers a manual netto adjustment over the calculated amount', () => {
    expect(salaryBase({ amount_due: 1200, netto_salary: 1000 })).toBe(1000);
  });

  it('falls back to the calculated amount when no adjustment was made', () => {
    expect(salaryBase({ amount_due: 1200, netto_salary: null })).toBe(1200);
    expect(salaryBase({ amount_due: 1200 })).toBe(1200);
  });

  it('reads PostgREST numeric strings', () => {
    expect(salaryBase({ amount_due: '1200.50' })).toBe(1200.5);
    expect(salaryBase({ amount_due: '1200.50', netto_salary: '999.99' })).toBe(999.99);
  });

  it('is 0 when neither column is readable, rather than NaN', () => {
    expect(salaryBase({})).toBe(0);
    expect(salaryBase({ amount_due: null, netto_salary: undefined })).toBe(0);
    expect(salaryBase({ amount_due: 'n/a' })).toBe(0);
  });

  it('honours an adjustment to exactly zero', () => {
    expect(salaryBase({ amount_due: 1200, netto_salary: 0 })).toBe(0);
  });

  it('negative control: the old `netto_salary || amount_due` discards a zero adjustment', () => {
    // The spelling that shipped in SalariesManagement.tsx and in three JSX cells.
    const oldBase = (row: { amount_due: number; netto_salary?: number }) =>
      Number(row.netto_salary || row.amount_due);
    expect(oldBase({ amount_due: 1200, netto_salary: 0 })).toBe(1200);
    expect(salaryBase({ amount_due: 1200, netto_salary: 0 })).toBe(0);
  });
});

describe('derivePaymentStatus', () => {
  it('is unpaid with nothing paid', () => {
    expect(derivePaymentStatus(1200, 0)).toBe('unpaid');
  });

  it('is partially_paid below the base', () => {
    expect(derivePaymentStatus(1200, 500)).toBe('partially_paid');
  });

  it('is paid at the base and above it', () => {
    expect(derivePaymentStatus(1200, 1200)).toBe('paid');
    expect(derivePaymentStatus(1200, 1500)).toBe('paid');
  });

  it('a base of zero with nothing paid is unpaid, not paid', () => {
    // The pair the Gehälter screen shows for a driver with no income in the
    // period: nothing is owed, but nothing was handed over either.
    expect(derivePaymentStatus(0, 0)).toBe('unpaid');
  });

  it('three payments that sum a hair below the base are paid, not partially_paid', () => {
    // 400,13 € three times sums to 1200.3899999999999 in binary floating point.
    const paid = 400.13 + 400.13 + 400.13;
    expect(paid).toBeLessThan(1200.39);
    expect(derivePaymentStatus(1200.39, paid)).toBe('paid');
    expect(remainingDue(1200.39, paid)).toBe(0);
  });

  it('negative control: exact `>=` calls that same row partially paid and owes 10^-13 €', () => {
    const paid = 400.13 + 400.13 + 400.13;
    const oldStatus = (total: number, p: number) =>
      p === 0 ? 'unpaid' : p >= total ? 'paid' : 'partially_paid';
    expect(oldStatus(1200.39, paid)).toBe('partially_paid');
    expect(Math.max(0, 1200.39 - paid)).toBeGreaterThan(0);
  });
});

describe('remainingDue', () => {
  it('is the shortfall', () => {
    expect(remainingDue(1200, 500)).toBe(700);
  });

  it('never goes negative, so an overpayment reads as nothing owed', () => {
    expect(remainingDue(1200, 1500)).toBe(0);
  });
});

describe('salaryDueState — item 2, the drift that reads as "bezahlt"', () => {
  /**
   * The shape of the 5 staging rows: a stored status of `paid` written when the
   * base was 900 €, beside a live base of 1.400 € the screen recomputed from the
   * period's income rows. 900 € was handed over; 500 € is owed.
   */
  // Typed as the column is, so the `||` below is a genuine fallback rather than
  // an expression the compiler can fold away.
  const STORED_STATUS: PaymentStatus | null = 'paid';
  const row = { netto_salary: null, amount_due: 1400 };

  it('derives the status from the live base, so the row reads partially paid', () => {
    const due = salaryDueState(row, 900);
    expect(due.base).toBe(1400);
    expect(due.totalPaid).toBe(900);
    expect(due.remaining).toBe(500);
    expect(due.paymentStatus).toBe('partially_paid');
  });

  it('negative control: `stored || derived` returns the stored word and hides the 500 €', () => {
    // SalariesManagement.tsx's own line, before the change:
    //   payment_status: existingSalary?.payment_status || calculatedPaymentStatus
    // `payment_status` is set on all 53 staging rows, so the right-hand side
    // never ran.
    const derived = salaryDueState(row, 900).paymentStatus;
    expect(STORED_STATUS || derived).toBe('paid');
    expect(derived).toBe('partially_paid');
  });

  it('an adjustment still outranks the live amount', () => {
    const due = salaryDueState({ netto_salary: 800, amount_due: 1400 }, 800);
    expect(due.base).toBe(800);
    expect(due.paymentStatus).toBe('paid');
    expect(due.remaining).toBe(0);
  });

  it('treats a missing total_paid as nothing paid', () => {
    expect(salaryDueState({ amount_due: 1400 }, null).paymentStatus).toBe('unpaid');
    expect(salaryDueState({ amount_due: 1400 }, undefined).totalPaid).toBe(0);
  });
});

describe('calcSalaryFromIncome — (Umsatz + Aktionen) × ratio + Trinkgeld × 100%', () => {
  it('scales the revenue by the ratio and adds the tips whole', () => {
    const r = calcSalaryFromIncome({ revenue: 900, tips: 120, salaryRatio: 0.45 });
    expect(r.salaryRatio).toBe(0.45);
    expect(r.revenueShare).toBe(405);
    expect(r.amountDue).toBe(525);
  });

  it('defaults a driver with no ratio to 0,5', () => {
    expect(calcSalaryFromIncome({ revenue: 1000, tips: 0 }).salaryRatio).toBe(DEFAULT_SALARY_RATIO);
    expect(calcSalaryFromIncome({ revenue: 1000, tips: 0, salaryRatio: null }).amountDue).toBe(500);
  });

  it('honours a ratio of exactly zero rather than defaulting it', () => {
    const r = calcSalaryFromIncome({ revenue: 1000, tips: 50, salaryRatio: 0 });
    expect(r.salaryRatio).toBe(0);
    expect(r.amountDue).toBe(50);
  });

  it('negative control: scaling the tips too underpays the driver', () => {
    // Trinkgeld is pass-through and belongs wholly to the driver. The plausible
    // refactor — one multiplication over the summed income — takes 66 € off this
    // month's salary.
    const wrong = (900 + 120) * 0.45;
    expect(wrong).toBeCloseTo(459, 10);
    expect(calcSalaryFromIncome({ revenue: 900, tips: 120, salaryRatio: 0.45 }).amountDue).toBe(525);
  });
});

/**
 * The Overview's salary alerts, asserted here rather than in
 * `overviewHelpers.test.ts`: that file belongs to another group's change set in
 * this round, and these assertions are about `salaryDueState` seen through its
 * one consumer that makes a claim about money owed. Move them next to the rest
 * of `calcSalaryAlerts` when the two changes meet.
 */
describe('calcSalaryAlerts reads the figures, not the stored word', () => {
  const DRIVERS: DriverRecord[] = [{ id: 'd1', name: 'Ali' }];
  const row = (over: Partial<SalaryRecord>): SalaryRecord => ({
    id: 's1',
    driver_id: 'd1',
    period_start: '2026-08-01',
    period_end: '2026-08-31',
    amount_due: 1400,
    status: 'unpaid',
    ...over,
  });

  it('lists a row whose stored status says paid while money is owed', () => {
    const alerts = calcSalaryAlerts([row({ payment_status: 'paid', total_paid: 900 })], DRIVERS);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].status).toBe('partially_paid');
    expect(alerts[0].remaining).toBe(500);
  });

  it('drops a row whose stored status says unpaid but which is settled', () => {
    const alerts = calcSalaryAlerts([row({ payment_status: 'unpaid', total_paid: 1400 })], DRIVERS);
    expect(alerts).toHaveLength(0);
  });

  it('alerts a manually adjusted salary at the adjustment, not the calculated amount', () => {
    // 1 staging row, wrong by 558,80 € before this change.
    const alerts = calcSalaryAlerts(
      [row({ amount_due: 1400, netto_salary: 1958.8, payment_status: 'unpaid', total_paid: 0 })],
      DRIVERS,
    );
    expect(alerts[0].amountDue).toBe(1958.8);
    expect(alerts[0].remaining).toBe(1958.8);
  });

  it('negative control: the three expressions that shipped', () => {
    const stale = row({ payment_status: 'paid', total_paid: 900 });
    // 1. the filter trusted the stored word, so this row was never listed.
    expect(['unpaid', 'partially_paid'].includes(stale.payment_status as string)).toBe(false);
    // 2. amountDue ignored netto_salary altogether.
    const adjusted = row({ amount_due: 1400, netto_salary: 1958.8 });
    expect(Number(adjusted.amount_due)).toBe(1400);
    expect(calcSalaryAlerts([{ ...adjusted, payment_status: 'unpaid' }], DRIVERS)[0].amountDue).toBe(1958.8);
    // 3. `remaining_balance || amount_due` fell through to the whole salary on a
    //    stored remainder of exactly 0.
    const settled = row({ payment_status: 'unpaid', total_paid: 1400, remaining_balance: 0 });
    expect(Number(settled.remaining_balance || settled.amount_due)).toBe(1400);
    expect(calcSalaryAlerts([settled], DRIVERS)).toHaveLength(0);
  });
});
