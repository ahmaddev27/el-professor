import { toCents } from './money';

/**
 * The figures a Gehaltsquittung (cash salary receipt) prints, and whether the
 * payment may be confirmed at all — in integer cents.
 *
 * The database decides; this mirrors it. `confirm_salary_cash_payment`
 * (supabase/migrations/20260914140000_salary_cash_receipts.sql) re-reads the
 * salary and its payments under a row lock, recomputes every figure below, and
 * refuses on its own. This module exists so a preview shows the numbers the
 * confirmation will store. Change one, change the other: salaryCashReceipt.test.ts
 * and tests/rls/salary-cash.sql walk the same scenario with the same amounts.
 *
 * Rules:
 *
 * - Due is COALESCE(netto_salary, amount_due, 0) — the base
 *   `update_salary_payment_status` already uses for payment_status. A netto of
 *   0 is a value, not a missing one.
 * - Every salary_payments row counts as paid. Cash is split by source, so the
 *   weekly "Bar zurück" (`weekly_cash_difference`) — paid, but kept back from a
 *   weekly settlement rather than handed over from the till — shows apart from
 *   cash handed over by hand (`manual`, or no source) and on earlier receipts
 *   (`gehaltsquittung`). Bank is `payment_type = 'bank'`, whatever its source.
 * - Remaining is max(due − paid, 0). Nothing remaining refuses any payment
 *   (`already_paid`); more than remaining refuses (`overpayment`). A payment
 *   must be a positive whole number of cents (`invalid_amount`), checked first.
 * - A receipt is partial when anything remains after it.
 *
 * The database also refuses what one salary row cannot show: a request id
 * reused for a different payment, and a salary whose period overlaps another
 * salary row of the same driver.
 */

export type ReceiptRefusal = 'invalid_amount' | 'already_paid' | 'overpayment';

export interface SalaryDueInput {
  netto_salary: number | string | null;
  amount_due: number | string | null;
}

export interface SalaryPaymentInput {
  payment_type: 'cash' | 'bank';
  amount: number | string;
  source_type?: string | null;
}

export interface PaidCashCents {
  manual: number;
  /** "Bar zurück" from the weekly Abrechnung. */
  weeklyCashDifference: number;
  gehaltsquittung: number;
}

/** Where a salary stands before a new payment. */
export interface BalanceFigures {
  dueCents: number;
  paidCashCents: PaidCashCents;
  paidBankCents: number;
  paidTotalCents: number;
  remainingBeforeCents: number;
}

export interface ReceiptFigures extends BalanceFigures {
  thisPaymentCents: number;
  remainingAfterCents: number;
  isPartial: boolean;
}

export type ReceiptFiguresResult =
  | { ok: true; figures: ReceiptFigures }
  | { ok: false; refusal: ReceiptRefusal; remainingBeforeCents: number };

/** COALESCE(netto_salary, amount_due, 0), in cents. */
export function salaryDueCents(salary: SalaryDueInput): number {
  if (salary.netto_salary !== null && salary.netto_salary !== undefined) return toCents(salary.netto_salary);
  if (salary.amount_due !== null && salary.amount_due !== undefined) return toCents(salary.amount_due);
  return 0;
}

/** Everything already paid against a salary, split the way the receipt prints it. */
export function sumPaidCents(payments: readonly SalaryPaymentInput[]): {
  paidCashCents: PaidCashCents;
  paidBankCents: number;
} {
  const paidCashCents: PaidCashCents = { manual: 0, weeklyCashDifference: 0, gehaltsquittung: 0 };
  let paidBankCents = 0;

  for (const payment of payments) {
    const cents = toCents(payment.amount);
    if (payment.payment_type === 'bank') {
      paidBankCents += cents;
    } else if (payment.source_type === 'weekly_cash_difference') {
      paidCashCents.weeklyCashDifference += cents;
    } else if (payment.source_type === 'gehaltsquittung') {
      paidCashCents.gehaltsquittung += cents;
    } else {
      paidCashCents.manual += cents;
    }
  }

  return { paidCashCents, paidBankCents };
}

/**
 * Due, paid by source, and remaining for `salary`, before any new payment.
 *
 * This is the first half of computeReceiptFigures, which calls it, so a screen
 * can show the balance before an amount is typed, or beside a refusal, from the
 * same arithmetic the preview uses.
 */
export function computeBalanceFigures(
  salary: SalaryDueInput,
  existingPayments: readonly SalaryPaymentInput[],
): BalanceFigures {
  const dueCents = salaryDueCents(salary);
  const { paidCashCents, paidBankCents } = sumPaidCents(existingPayments);
  const paidTotalCents =
    paidBankCents + paidCashCents.manual + paidCashCents.weeklyCashDifference + paidCashCents.gehaltsquittung;
  const remainingBeforeCents = Math.max(dueCents - paidTotalCents, 0);
  return { dueCents, paidCashCents, paidBankCents, paidTotalCents, remainingBeforeCents };
}

/**
 * The figures for paying `thisPaymentCents` in cash against `salary`, given the
 * payments already recorded for it (not including this one).
 */
export function computeReceiptFigures(
  salary: SalaryDueInput,
  existingPayments: readonly SalaryPaymentInput[],
  thisPaymentCents: number,
): ReceiptFiguresResult {
  const balance = computeBalanceFigures(salary, existingPayments);
  const { remainingBeforeCents } = balance;

  if (!Number.isSafeInteger(thisPaymentCents) || thisPaymentCents <= 0) {
    return { ok: false, refusal: 'invalid_amount', remainingBeforeCents };
  }
  if (remainingBeforeCents === 0) {
    return { ok: false, refusal: 'already_paid', remainingBeforeCents };
  }
  if (thisPaymentCents > remainingBeforeCents) {
    return { ok: false, refusal: 'overpayment', remainingBeforeCents };
  }

  const remainingAfterCents = remainingBeforeCents - thisPaymentCents;
  return {
    ok: true,
    figures: {
      ...balance,
      thisPaymentCents,
      remainingAfterCents,
      isPartial: remainingAfterCents > 0,
    },
  };
}
