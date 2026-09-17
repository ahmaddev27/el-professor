import { describe, expect, it } from 'vitest';
import {
  findSalaryDeletionBlock,
  findSalaryPeriodProblem,
  rowCoveringPeriod,
  salaryPeriodChanged,
  salaryRowWriteRefusal,
} from './salaryRowEdit';

const row = (id: string, period_start: string, period_end: string | null, driver_id = 'driver-1') => ({
  id,
  driver_id,
  period_start,
  period_end,
});

// The pair the owner has to merge: the business month of March 2026 (a week
// belongs to the month containing its Monday) beside the calendar month of the
// same name. unique_driver_period does not catch it, and the RPC refuses a cash
// payment on either until one is gone.
const BUSINESS_MARCH = row('business-march', '2026-03-02', '2026-03-29');
const CALENDAR_MARCH = row('calendar-march', '2026-03-01', '2026-03-31');

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

describe('findSalaryPeriodProblem', () => {
  it('accepts a period that overlaps nothing', () => {
    expect(findSalaryPeriodProblem({ period_start: '2026-04-01', period_end: '2026-04-30' }, [CALENDAR_MARCH]))
      .toBeNull();
  });

  it('accepts a period of a single day', () => {
    expect(findSalaryPeriodProblem({ period_start: '2026-05-04', period_end: '2026-05-04' }, []))
      .toBeNull();
  });

  it('refuses a period whose end comes before its start', () => {
    expect(findSalaryPeriodProblem({ period_start: '2026-03-31', period_end: '2026-03-01' }, []))
      .toEqual({ reason: 'reversed' });
  });

  it('refuses a period with a date missing, before it compares anything', () => {
    expect(findSalaryPeriodProblem({ period_start: '', period_end: '2026-03-31' }, [])).toEqual({ reason: 'incomplete' });
    expect(findSalaryPeriodProblem({ period_start: '2026-03-01', period_end: null }, [])).toEqual({ reason: 'incomplete' });
    expect(findSalaryPeriodProblem({ period_start: undefined, period_end: undefined }, [])).toEqual({ reason: 'incomplete' });
  });

  // "Incomplete" is reported rather than "reversed" for a half-filled form: the
  // owner is still typing, and the comparison has nothing to say yet.
  it('reports incomplete rather than reversed when only one date is filled in', () => {
    expect(findSalaryPeriodProblem({ period_start: '2026-03-31', period_end: '' }, []))
      .toEqual({ reason: 'incomplete' });
  });

  it('names the row in the way, so the screen can say which one to remove first', () => {
    const problem = findSalaryPeriodProblem(
      { period_start: '2026-03-01', period_end: '2026-03-31' },
      [BUSINESS_MARCH, CALENDAR_MARCH],
      CALENDAR_MARCH.id,
    );
    expect(problem).toEqual({ reason: 'overlap', conflicts: [BUSINESS_MARCH] });
  });

  it('does not report the row being edited against itself', () => {
    expect(findSalaryPeriodProblem(CALENDAR_MARCH, [CALENDAR_MARCH], CALENDAR_MARCH.id)).toBeNull();
  });

  // The merge's order, stated as a test: while both rows exist, widening the
  // survivor over the other one is refused, because that is exactly the overlap
  // confirm_salary_cash_payment refuses. Delete first, then widen.
  it('refuses widening the survivor while the row it would swallow still exists', () => {
    const widened = { period_start: '2026-03-01', period_end: '2026-03-31' };
    const problem = findSalaryPeriodProblem(widened, [BUSINESS_MARCH, CALENDAR_MARCH], BUSINESS_MARCH.id);
    expect(problem).toEqual({ reason: 'overlap', conflicts: [CALENDAR_MARCH] });
  });

  it('allows the same widening once the other row is gone', () => {
    const widened = { period_start: '2026-03-01', period_end: '2026-03-31' };
    expect(findSalaryPeriodProblem(widened, [BUSINESS_MARCH], BUSINESS_MARCH.id)).toBeNull();
  });

  // The other way out of an overlap: shorten instead of delete. A period that
  // ends the day before the next begins is consecutive, not overlapping.
  it('allows shortening a row until it is merely consecutive with the other', () => {
    expect(findSalaryPeriodProblem(
      { period_start: '2026-02-01', period_end: '2026-03-01' },
      [BUSINESS_MARCH],
      'calendar-march',
    )).toBeNull();
  });

  it('refuses a period sharing a single boundary day, as the RPC does', () => {
    const problem = findSalaryPeriodProblem(
      { period_start: '2026-02-01', period_end: '2026-03-02' },
      [BUSINESS_MARCH],
      'calendar-march',
    );
    expect(problem).toEqual({ reason: 'overlap', conflicts: [BUSINESS_MARCH] });
  });

  it('reports every conflicting row, earliest period first', () => {
    const a = row('a', '2026-03-01', '2026-03-10');
    const b = row('b', '2026-03-20', '2026-03-31');
    const problem = findSalaryPeriodProblem({ period_start: '2026-03-05', period_end: '2026-03-25' }, [b, a], 'new');
    expect(problem).toEqual({ reason: 'overlap', conflicts: [a, b] });
  });
});

describe('salaryPeriodChanged', () => {
  it('is false when neither date moved, so no UPDATE is sent', () => {
    expect(salaryPeriodChanged(CALENDAR_MARCH, { period_start: '2026-03-01', period_end: '2026-03-31' })).toBe(false);
  });

  it('is true when either date moved', () => {
    expect(salaryPeriodChanged(CALENDAR_MARCH, { period_start: '2026-03-02', period_end: '2026-03-31' })).toBe(true);
    expect(salaryPeriodChanged(CALENDAR_MARCH, { period_start: '2026-03-01', period_end: '2026-03-29' })).toBe(true);
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

describe('rowCoveringPeriod', () => {
  it('finds the widened survivor that already covers the row being deleted', () => {
    expect(rowCoveringPeriod(BUSINESS_MARCH, [CALENDAR_MARCH, BUSINESS_MARCH], BUSINESS_MARCH.id))
      .toEqual(CALENDAR_MARCH);
  });

  it('counts an exactly equal period as covering', () => {
    const twin = row('twin', '2026-03-01', '2026-03-31');
    expect(rowCoveringPeriod(CALENDAR_MARCH, [twin], CALENDAR_MARCH.id)).toEqual(twin);
  });

  it('answers null when nothing covers the whole period — days would stop being accounted for', () => {
    expect(rowCoveringPeriod(CALENDAR_MARCH, [BUSINESS_MARCH], CALENDAR_MARCH.id)).toBeNull();
  });

  it('never answers with the row being deleted', () => {
    expect(rowCoveringPeriod(CALENDAR_MARCH, [CALENDAR_MARCH], CALENDAR_MARCH.id)).toBeNull();
  });

  it('ignores a row missing either date, and a period missing either date', () => {
    expect(rowCoveringPeriod(BUSINESS_MARCH, [row('open', '2026-01-01', null)], BUSINESS_MARCH.id)).toBeNull();
    expect(rowCoveringPeriod({ period_start: '2026-03-02', period_end: null }, [CALENDAR_MARCH])).toBeNull();
  });

  it('compares dates as text, so a period spanning a year end is ordered correctly', () => {
    const wide = row('wide', '2025-12-01', '2026-01-31');
    expect(rowCoveringPeriod(row('turn', '2025-12-29', '2026-01-04'), [wide], 'turn')).toEqual(wide);
    expect(rowCoveringPeriod(row('turn', '2025-11-29', '2026-01-04'), [wide], 'turn')).toBeNull();
  });
});
