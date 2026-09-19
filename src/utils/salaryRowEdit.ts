/**
 * Removing a salary row — the way a driver's overlapping salary rows are merged.
 *
 * The owner decided on 17.09.2026 that he merges overlapping salary rows
 * himself, so the product has to let him. `unique_driver_period` is only
 * `UNIQUE (driver_id, period_start)`, so one driver can hold a business month
 * beside the calendar month of the same name (CLAUDE.md, *Domain rules that are
 * easy to break*), and `confirm_salary_cash_payment` refuses a cash payment on
 * either of them as `overlapping_salary` until one is gone.
 *
 * **The merge is a delete, and deliberately nothing more.** Deleting the
 * hand-entered calendar row and leaving the business-month row untouched is the
 * whole operation, and it is the one path the rest of the screen already
 * understands. An earlier draft of this module also let the surviving row's
 * period be widened over both, which reads like the obvious other half and is
 * in fact a trap — the review of PR #73 found four ways it bites, and they are
 * recorded here so the widen is not added back by someone who sees only the
 * gap:
 *
 * - **The screen would lose the row.** `SalariesManagement` matches a driver's
 *   stored row to the selected period by *exact equality of both ends*, so a
 *   row widened to `01.03.–31.03.` no longer matches the computed business
 *   range `02.03.–29.03.`; `calc.salary_id` goes undefined, the table falls
 *   back to a recomputed `amount_due`, and the stored `netto_salary`,
 *   `total_paid`, `paid_at` and `status` disappear — a part-paid driver is
 *   redrawn as unpaid with 0,00 paid. The overlap badge then *stays*, because
 *   the widened row overlaps the computed range with no id to exclude, and the
 *   next click on *Zahlungen verwalten* runs `ensureSalaryExists` and inserts a
 *   **third** row. The merge would undo itself and leave a fresh overlap.
 * - **It would re-file issued Gehaltsquittungen.** `business_month` comes from
 *   `get_business_month(period_start)`, and a week belongs to the month
 *   containing its Monday — `01.03.2026`'s Monday is `23.02.` So moving a start
 *   across a week boundary puts the row in business February while the Overview
 *   still filters it by calendar March.
 * - **It would invalidate a signed document.** The due figure is read off the
 *   row (`COALESCE(netto_salary, amount_due)`) and never recomputed, and a
 *   receipt copies the period verbatim and prints "für den Zeitraum … den
 *   Betrag von …". After a widen the paper the driver signs states a period the
 *   amount was never computed for, and it goes to the Steuerberater.
 * - **Nothing would stop it storing a new overlap.** There is no CHECK and no
 *   exclusion constraint on the table, and the browser's list of rows can be
 *   stale.
 *
 * So the rule this module keeps is only: which rows may be removed. The
 * database is the boundary, not this file.
 *
 * - `salaries_delete` (20260917130000) is
 *   `company_id = get_active_company_id() AND current_role_permits('salaries', true)`.
 *   `tests/rls/matrix.sql:1210` pins the editor, supervisor and company
 *   administrator at `Y` and the viewer, anon and a platform account at `.`.
 * - `salary_cash_receipts.salary_id` is `ON DELETE RESTRICT`, so a salary that
 *   produced a Gehaltsquittung cannot be deleted at all — pinned as SQLSTATE
 *   23503 by `tests/rls/salary-cash.sql:361` ("a salary with a receipt cannot
 *   be deleted on its own").
 * - `salary_payments.salary_id` is `ON DELETE CASCADE`, so the database deletes
 *   a row's payments **silently** with it. Nothing in the database refuses
 *   that, which is exactly why `findSalaryDeletionBlock` has to.
 *
 * Dates are `YYYY-MM-DD` text and are compared and formatted as text, so no
 * `Date` is constructed and the browser's timezone cannot shift a period by a
 * day. That is the convention `salaryPeriodOverlap` already uses.
 */

import type { SalaryPeriod } from './salaryPeriodOverlap';
import type { ReceiptScope } from './salaryCashReceiptFlow';

// ─── Who may write a salary row ─────────────────────────────────────────────

export type SalaryRowWriteRefusal = 'company_mismatch' | 'no_company' | 'not_authorized';

/**
 * Why this caller may not delete a salary row at all, before anything is
 * clicked; null when they may.
 *
 * The two terms are the two the policy carries. The scope stands for
 * `get_active_company_id()`: platform staff viewing a customer hold no
 * membership in it, so the helper answers NULL for them and every write is
 * refused however the browser's `can()` answers — `AuthContext.can` returns
 * true for any platform account, so asking it alone would offer a button the
 * database throws away. `mayEditSalaries` stands for
 * `current_role_permits('salaries', true)`, which is what refuses a viewer.
 *
 * This is the same pair `confirmationBlock` applies before a Gehaltsquittung,
 * for the same reason — `confirm_salary_cash_payment` is gated on the same two
 * terms — but the refusals are worded for a deletion, not for a receipt.
 */
export function salaryRowWriteRefusal(
  scope: ReceiptScope,
  mayEditSalaries: boolean,
): SalaryRowWriteRefusal | null {
  if (scope === 'other_company') return 'company_mismatch';
  if (scope === 'no_company') return 'no_company';
  return mayEditSalaries ? null : 'not_authorized';
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
   * be deleted — the other row of the pair is the one to remove.
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
// dialog that removes the rows too. They live here rather than in either
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
