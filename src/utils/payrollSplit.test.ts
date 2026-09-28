import { describe, expect, it } from 'vitest';
import { payrollRemaining, payrollSplit } from './payrollSplit';

/**
 * The payroll split: cash = total − Brutto, bank = Netto, payout = cash + bank.
 *
 * The case this module exists for is R3: a salary with the Steuerberater's Netto
 * entered and the Brutto still blank. `payrollGross = gross ?? 0` then made the
 * cash remainder the *whole* salary and added the Netto on top, so a 2.000 €
 * salary reported a 3.000 € payout — in the dialog, in the PDF and in the card
 * image sent to the driver, where it also became a 3.000 € Restgehalt.
 *
 * Measured on staging 28.09.2026: 0 of 53 rows hold a Netto without a Brutto, so
 * no document already issued changes; 7 rows hold a Brutto above the salary, and
 * those keep their negative Bargehalt and its warning.
 */

const SALARY = 2000;

describe('payrollSplit — an established split', () => {
  it('splits the salary into cash and bank', () => {
    const s = payrollSplit({ total: SALARY, gross: 1200, net: 900 });
    expect(s.entered).toBe(true);
    expect(s.established).toBe(true);
    expect(s.cash).toBe(800);
    expect(s.bank).toBe(900);
    expect(s.payout).toBe(1700);
    expect(s.problem).toBeNull();
    expect(s.grossExceedsTotal).toBe(false);
    expect(s.cashIsNegative).toBe(false);
  });

  it('a Brutto with no Netto yet is still established: the cash part is known', () => {
    const s = payrollSplit({ total: SALARY, gross: 1200, net: null });
    expect(s.established).toBe(true);
    expect(s.cash).toBe(800);
    expect(s.bank).toBe(0);
    expect(s.payout).toBe(800);
  });

  it('a Brutto of exactly zero means nothing runs through payroll', () => {
    const s = payrollSplit({ total: SALARY, gross: 0, net: null });
    expect(s.established).toBe(true);
    expect(s.cash).toBe(SALARY);
    expect(s.payout).toBe(SALARY);
  });

  it('keeps a Brutto above the salary as a flagged negative cash figure, not a refusal', () => {
    // 7 of 53 staging rows. An operator is already reading these numbers, so
    // withholding them would hide a discrepancy that is currently visible.
    const s = payrollSplit({ total: SALARY, gross: 2500, net: 1800 });
    expect(s.established).toBe(true);
    expect(s.grossExceedsTotal).toBe(true);
    expect(s.cashIsNegative).toBe(true);
    expect(s.cash).toBe(-500);
    expect(s.payout).toBe(1300);
  });
});

describe('payrollSplit — a Netto with no Brutto states no cash figure', () => {
  const s = payrollSplit({ total: SALARY, gross: null, net: 900 });

  it('is entered but not established', () => {
    expect(s.entered).toBe(true);
    expect(s.established).toBe(false);
    expect(s.problem).toBe('gross_missing');
  });

  it('states no cash and no payout', () => {
    expect(s.cash).toBeNull();
    expect(s.payout).toBeNull();
  });

  it('still carries the Netto that was entered', () => {
    expect(s.bank).toBe(900);
  });

  it('does not flag a discrepancy it cannot measure', () => {
    expect(s.grossExceedsTotal).toBe(false);
    expect(s.cashIsNegative).toBe(false);
  });

  it('negative control: the old arithmetic pays out 2.900 € of a 2.000 € salary', () => {
    // SalaryDetailsModal.tsx, before the change:
    //   payrollGross = payroll_gross_amount ?? 0
    //   cashSalary   = calculatedSalaryTotal - payrollGross
    //   totalNetPayout = cashSalary + payrollNet
    const gross: number | null = null;
    const net: number | null = 900;
    const oldCash = SALARY - (gross ?? 0);
    const oldPayout = oldCash + (net ?? 0);
    expect(oldCash).toBe(SALARY);        // the whole salary, reported as cash
    expect(oldPayout).toBe(2900);        // 900 € more than the salary itself
    expect(oldPayout).toBeGreaterThan(SALARY);
    expect(s.payout).toBeNull();
  });
});

describe('payrollSplit — nothing entered', () => {
  it('shows no section and names no problem', () => {
    const s = payrollSplit({ total: SALARY, gross: null, net: null });
    expect(s.entered).toBe(false);
    expect(s.established).toBe(false);
    expect(s.problem).toBeNull();
    expect(s.cash).toBeNull();
    expect(s.bank).toBeNull();
    expect(s.payout).toBeNull();
  });

  it('treats undefined like null, so an unread row is not a zero Brutto', () => {
    const s = payrollSplit({ total: SALARY, gross: undefined, net: undefined });
    expect(s.entered).toBe(false);
    expect(s.established).toBe(false);
  });
});

describe('payrollRemaining — the Restgehalt', () => {
  it('is the payout less what was already paid', () => {
    const s = payrollSplit({ total: SALARY, gross: 1200, net: 900 });
    expect(payrollRemaining(s, 700)).toBe(1000);
  });

  it('is negative when more was paid than the split agreed, rather than clamped', () => {
    const s = payrollSplit({ total: SALARY, gross: 1200, net: 900 });
    expect(payrollRemaining(s, 2000)).toBe(-300);
  });

  it('is null when the split states no payout', () => {
    const s = payrollSplit({ total: SALARY, gross: null, net: 900 });
    expect(payrollRemaining(s, 700)).toBeNull();
  });

  it('negative control: the card used to invent a debt from the unestablished split', () => {
    // DriverSalarySummaryCard.tsx, before the change — with the caller passing
    // the whole salary as cash, which is what `hasPayrollData ? cashSalary : null`
    // did:
    //   totalNetPayout = (nettoBank ?? 0) + (cashSalary ?? 0)
    //   restgehalt     = totalNetPayout - alreadyPaidSalary
    const nettoBank: number | null = 900;
    const cashSalary: number | null = SALARY; // what the caller used to pass
    const oldPayout = (nettoBank ?? 0) + (cashSalary ?? 0);
    expect(oldPayout - 700).toBe(2200);
    expect(payrollRemaining(payrollSplit({ total: SALARY, gross: null, net: 900 }), 700)).toBeNull();
  });
});
