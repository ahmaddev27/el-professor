import { describe, expect, it } from 'vitest';
import {
  findSalaryDeletionBlock,
  formatSalaryDue,
  formatStoredDate,
  formatStoredPeriod,
  salaryRowWriteRefusal,
} from './salaryRowEdit';

describe('salaryRowWriteRefusal', () => {
  it('lets an editor of their own company through', () => {
    expect(salaryRowWriteRefusal('own_company', true)).toBeNull();
  });

  it('refuses a viewer of their own company — current_role_permits is the gate', () => {
    expect(salaryRowWriteRefusal('own_company', false)).toBe('not_authorized');
  });

  // AuthContext.can() returns true for every platform account, so the role flag
  // alone would offer a button that get_active_company_id() throws away. The
  // scope has to be checked first, and it has to win.
  it('refuses platform staff inside a customer even when the role flag says yes', () => {
    expect(salaryRowWriteRefusal('other_company', true)).toBe('company_mismatch');
  });

  it('refuses an account with no company, and says which of the two it is', () => {
    expect(salaryRowWriteRefusal('no_company', true)).toBe('no_company');
    expect(salaryRowWriteRefusal('no_company', false)).toBe('no_company');
  });
});

describe('findSalaryDeletionBlock', () => {
  it('allows a row with no payments and no receipts', () => {
    expect(findSalaryDeletionBlock({ receipts: [], payments: [] })).toBeNull();
  });

  // salary_payments.salary_id is ON DELETE CASCADE: the database would take
  // these with the salary without a word, so this is the only thing refusing.
  it('refuses a row with ordinary payments, and counts them', () => {
    expect(findSalaryDeletionBlock({
      receipts: [],
      payments: [{ source_type: 'manual' }, { source_type: 'weekly_cash_difference' }],
    })).toEqual({ reason: 'payments', payments: 2 });
  });

  it('refuses a row with a confirmed Gehaltsquittung', () => {
    expect(findSalaryDeletionBlock({
      receipts: [{ status: 'confirmed' }],
      payments: [{ source_type: 'gehaltsquittung' }],
    })).toEqual({ reason: 'gehaltsquittung', receipts: 1, confirmed: 1, voided: 0 });
  });

  // void_salary_cash_receipt deletes the payment and keeps the receipt, so the
  // ON DELETE RESTRICT foreign key still points at the salary. Reading payments
  // alone would call this row deletable and earn a bare 23503 from the database.
  it('refuses a row whose only receipt was voided — the payment is gone, the row is not', () => {
    expect(findSalaryDeletionBlock({
      receipts: [{ status: 'voided' }],
      payments: [],
    })).toEqual({ reason: 'gehaltsquittung', receipts: 1, confirmed: 0, voided: 1 });
  });

  it('counts a confirmed and a voided receipt apart', () => {
    expect(findSalaryDeletionBlock({
      receipts: [{ status: 'voided' }, { status: 'confirmed' }, { status: 'voided' }],
      payments: [{ source_type: 'gehaltsquittung' }],
    })).toEqual({ reason: 'gehaltsquittung', receipts: 3, confirmed: 1, voided: 2 });
  });

  it('reports the receipt rather than the payments when the row has both', () => {
    expect(findSalaryDeletionBlock({
      receipts: [{ status: 'confirmed' }],
      payments: [{ source_type: 'gehaltsquittung' }, { source_type: 'manual' }],
    })).toMatchObject({ reason: 'gehaltsquittung' });
  });

  // Defensive: the receipt guard makes this state impossible, but a receipts
  // read that came back short must never downgrade the refusal to the milder
  // one that tells the owner to delete the payment by hand.
  it('treats a gehaltsquittung payment as a receipt even with no receipt row read', () => {
    expect(findSalaryDeletionBlock({
      receipts: [],
      payments: [{ source_type: 'gehaltsquittung' }],
    })).toEqual({ reason: 'gehaltsquittung', receipts: 0, confirmed: 0, voided: 0 });
  });

  it('treats a payment with no source_type as an ordinary one', () => {
    expect(findSalaryDeletionBlock({ receipts: [], payments: [{}, { source_type: null }] }))
      .toEqual({ reason: 'payments', payments: 2 });
  });
});

describe('formatStoredDate', () => {
  it('turns a stored date into the German order without constructing a Date', () => {
    expect(formatStoredDate('2026-03-01')).toBe('01.03.2026');
  });

  it('hands back anything it cannot split, rather than inventing a date', () => {
    expect(formatStoredDate('')).toBe('');
    expect(formatStoredDate('2026-03')).toBe('2026-03');
  });
});

describe('formatStoredPeriod', () => {
  it('prints both ends', () => {
    expect(formatStoredPeriod({ period_start: '2026-03-02', period_end: '2026-03-29' }))
      .toBe('02.03.2026 – 29.03.2026');
  });

  it('survives a missing end rather than throwing in a confirmation dialog', () => {
    expect(formatStoredPeriod({ period_start: '2026-03-02', period_end: null }))
      .toBe('02.03.2026 – ');
  });
});

describe('formatSalaryDue', () => {
  // The figure confirm_salary_cash_payment settles: COALESCE(netto_salary, amount_due).
  it('prefers netto_salary over amount_due, as the RPC does', () => {
    expect(formatSalaryDue({ netto_salary: 1234.5, amount_due: 999 })).toBe('1.234,50');
  });

  it('falls back to amount_due, and to zero when neither is set', () => {
    expect(formatSalaryDue({ amount_due: 300 })).toBe('300,00');
    expect(formatSalaryDue({ netto_salary: null, amount_due: null })).toBe('0,00');
    expect(formatSalaryDue({})).toBe('0,00');
  });

  // A decimal comma and a thousands dot: a figure on this screen maps onto a
  // German document, so it must never render as 1,234.50.
  it('uses the German decimal comma', () => {
    expect(formatSalaryDue({ amount_due: 0.5 })).toBe('0,50');
    expect(formatSalaryDue({ amount_due: 1000 })).toBe('1.000,00');
  });
});
