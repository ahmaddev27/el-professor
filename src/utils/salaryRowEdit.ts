/**
 * Editing a salary row's period, and removing a salary row.
 *
 * The owner decided on 17.09.2026 that he merges overlapping salary rows
 * himself, so the product has to let him. `unique_driver_period` is only
 * `UNIQUE (driver_id, period_start)`, so one driver can hold a business month
 * beside the calendar month of the same name (CLAUDE.md, *Domain rules that are
 * easy to break*), and `confirm_salary_cash_payment` refuses a cash payment on
 * either of them as `overlapping_salary` until one is gone. Merging means:
 * widen the row that stays, delete the one that goes.
 *
 * **The order is delete first, then widen.** While both rows exist they overlap
 * by definition, so every period the survivor could be widened to still
 * overlaps the other row and is refused here — the same condition the RPC
 * applies. That is not an obstacle to the merge, it is the merge's order, and
 * `findSalaryPeriodProblem` names the row in the way so the screen can say so.
 *
 * Everything here is a pure decision taken before a write. The database is the
 * boundary, not this file:
 *
 * - `salaries_update` and `salaries_delete` (20260917130000) are both
 *   `company_id = get_active_company_id() AND current_role_permits('salaries', true)`,
 *   as USING and — for UPDATE — as WITH CHECK. `tests/rls/matrix.sql` pins the
 *   editor, supervisor and company administrator at `Y` on both and the viewer,
 *   anon and a platform account at `.` (rows 'salaries' U and D).
 * - `salary_cash_receipts.salary_id` is `ON DELETE RESTRICT`, so a salary that
 *   produced a Gehaltsquittung cannot be deleted at all — pinned as SQLSTATE
 *   23503 by `tests/rls/salary-cash.sql` ("a salary with a receipt cannot be
 *   deleted on its own").
 * - `salary_payments.salary_id` is `ON DELETE CASCADE`, so the database deletes
 *   a row's payments **silently** with it. Nothing in the database refuses
 *   that, which is exactly why `findSalaryDeletionBlock` has to.
 *
 * Dates are `YYYY-MM-DD` text and are compared as text, so text order is date
 * order, no `Date` is constructed and the browser's timezone cannot shift a
 * period by a day. That is the convention `salaryPeriodOverlap` already uses.
 */

import {
  findOverlappingSalaryPeriods,
  type IdentifiedSalaryPeriod,
  type SalaryPeriod,
} from './salaryPeriodOverlap';
import type { ReceiptScope } from './salaryCashReceiptFlow';

// ─── Who may write a salary row ─────────────────────────────────────────────

export type SalaryRowWriteRefusal = 'company_mismatch' | 'no_company' | 'not_authorized';

/**
 * Why this caller may not edit or delete a salary row at all, before anything
 * is typed; null when they may.
 *
 * The two terms are the two the policies carry. The scope stands for
 * `get_active_company_id()`: platform staff viewing a customer hold no
 * membership in it, so the helper answers NULL for them and every write is
 * refused however the browser's `can()` answers — `AuthContext.can` returns
 * true for any platform account, so asking it alone would offer a button the
 * database throws away. `mayEditSalaries` stands for
 * `current_role_permits('salaries', true)`, which is what refuses a viewer.
 *
 * This is the same pair `confirmationBlock` applies before a Gehaltsquittung,
 * for the same reason — `confirm_salary_cash_payment` is gated on the same two
 * terms — but the refusals are worded for an edit, not for a receipt.
 */
export function salaryRowWriteRefusal(
  scope: ReceiptScope,
  mayEditSalaries: boolean,
): SalaryRowWriteRefusal | null {
  if (scope === 'other_company') return 'company_mismatch';
  if (scope === 'no_company') return 'no_company';
  return mayEditSalaries ? null : 'not_authorized';
}

// ─── Editing the period ─────────────────────────────────────────────────────

export type SalaryPeriodProblem<Row extends IdentifiedSalaryPeriod = IdentifiedSalaryPeriod> =
  /** One of the two dates is missing. */
  | { reason: 'incomplete' }
  /** `period_start` is after `period_end`. */
  | { reason: 'reversed' }
  /** The period would overlap these rows of the same driver, earliest first. */
  | { reason: 'overlap'; conflicts: Row[] };

/**
 * Why this period may not be stored, or null when it may.
 *
 * `driverRows` must already be one driver's rows, and `excludeId` the row being
 * edited — the same contract as `findOverlappingSalaryPeriods`, whose condition
 * is the browser's single mirror of the RPC's. No second spelling of the
 * overlap rule is written here.
 *
 * A period of one day (start equal to end) is allowed: the rule is only that
 * the end may not come before the start.
 */
export function findSalaryPeriodProblem<Row extends IdentifiedSalaryPeriod>(
  period: SalaryPeriod,
  driverRows: readonly Row[],
  excludeId?: string | null,
): SalaryPeriodProblem<Row> | null {
  if (!period.period_start || !period.period_end) return { reason: 'incomplete' };
  if (period.period_start > period.period_end) return { reason: 'reversed' };

  const conflicts = findOverlappingSalaryPeriods(period, driverRows, excludeId);
  return conflicts.length > 0 ? { reason: 'overlap', conflicts } : null;
}

/**
 * Whether the period actually moved, so the screen can close without a write
 * rather than sending an UPDATE that changes nothing and bumps `updated_at`.
 */
export function salaryPeriodChanged(before: SalaryPeriod, after: SalaryPeriod): boolean {
  return before.period_start !== after.period_start || before.period_end !== after.period_end;
}

// ─── Deleting a row ─────────────────────────────────────────────────────────

/** What a salary row carries that decides whether it may be deleted. */
export interface SalaryDeletionFacts {
  /**
   * The row's `salary_cash_receipts`, **whatever their status**. A voided
   * receipt keeps its row and its foreign key, so it blocks the delete exactly
   * as a confirmed one does — and a void has already deleted its payment, so
   * looking at payments alone would miss it and offer a delete the database
   * then refuses with a bare 23503.
   */
  receipts: readonly { status?: string | null }[];
  /** The row's `salary_payments`. */
  payments: readonly { source_type?: string | null }[];
}

export type SalaryDeletionBlock =
  /**
   * A Gehaltsquittung was issued for this row. It is a ledger document and its
   * number is gapless per company and year, so the salary it settles can never
   * be deleted — merge the other way round.
   */
  | { reason: 'gehaltsquittung'; receipts: number; confirmed: number; voided: number }
  /**
   * Ordinary payments hang off this row. The database would cascade them away
   * without a word; they have to be removed deliberately first.
   */
  | { reason: 'payments'; payments: number };

const isGehaltsquittungPayment = (payment: { source_type?: string | null }): boolean =>
  payment.source_type === 'gehaltsquittung';

/**
 * Why this salary row may not be deleted, or null when it may.
 *
 * The receipt reason is reported first and on its own, because it is the one
 * that can never be worked around: a confirmed receipt always has a payment
 * too, and naming the payments instead would send the owner to delete a row the
 * `salary_payments_receipt_guard` trigger refuses anyway.
 *
 * A `gehaltsquittung` payment with no receipt row cannot occur — the trigger
 * refuses such an insert — but it is treated as a receipt if it ever appears,
 * so a failed or partial read of the receipts never downgrades the refusal to
 * the milder one.
 */
export function findSalaryDeletionBlock(facts: SalaryDeletionFacts): SalaryDeletionBlock | null {
  const receiptPayments = facts.payments.filter(isGehaltsquittungPayment).length;

  if (facts.receipts.length > 0 || receiptPayments > 0) {
    return {
      reason: 'gehaltsquittung',
      receipts: facts.receipts.length,
      confirmed: facts.receipts.filter(receipt => receipt.status === 'confirmed').length,
      voided: facts.receipts.filter(receipt => receipt.status === 'voided').length,
    };
  }

  if (facts.payments.length > 0) {
    return { reason: 'payments', payments: facts.payments.length };
  }

  return null;
}

// ─── Display ────────────────────────────────────────────────────────────────
//
// Both formatters were local to SalariesManagement.tsx and are needed by the
// dialog that edits the periods too. They live here rather than in either
// component so the table and the dialog can never print the same row two ways.

/** `YYYY-MM-DD` as `DD.MM.YYYY`, without a Date the browser's zone could shift by a day. */
export function formatStoredDate(value: string): string {
  const [year, month, day] = value.split('-');
  return year && month && day ? `${day}.${month}.${year}` : value;
}

/** A stored period as `DD.MM.YYYY – DD.MM.YYYY`. */
export function formatStoredPeriod(period: SalaryPeriod): string {
  return `${formatStoredDate(period.period_start ?? '')} – ${formatStoredDate(period.period_end ?? '')}`;
}

/** The figure a Gehaltsquittung settles, the way the RPC reads it: COALESCE(netto_salary, amount_due). */
export function formatSalaryDue(row: { netto_salary?: number | null; amount_due?: number | null }): string {
  return Number(row.netto_salary ?? row.amount_due ?? 0).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * A different row of the same driver that already covers every day of
 * `period`, or null — the merge's last step, seen from the row about to go.
 *
 * When the survivor has been widened over the whole of the row being deleted,
 * nothing is lost by deleting it and the confirmation can say so. When nothing
 * covers it, some days stop being accounted for anywhere, and the confirmation
 * has to say that instead. Containment is a text comparison of two dates, so
 * it needs no date arithmetic and no notion of adjacent days.
 */
export function rowCoveringPeriod<Row extends IdentifiedSalaryPeriod>(
  period: SalaryPeriod,
  driverRows: readonly Row[],
  excludeId?: string | null,
): Row | null {
  if (!period.period_start || !period.period_end) return null;

  return (
    driverRows.find(
      row =>
        row.id !== excludeId &&
        !!row.period_start &&
        !!row.period_end &&
        row.period_start <= period.period_start! &&
        row.period_end >= period.period_end!,
    ) ?? null
  );
}
