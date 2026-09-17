import type { TranslationKey } from '../i18n';
import { toCents } from './money';

/**
 * Which salary payment becomes a Gehaltsquittung, which is written straight
 * into `salary_payments`, and which stored row may still be changed at all.
 *
 * Owner decision, 17.09.2026: every cash salary payment a user *adds by hand*
 * goes through `confirm_salary_cash_payment`, so the receipt, the payment row
 * and the outgoing `cash_movements` row commit together. Before this, an added
 * cash payment was a plain INSERT: the money left the till and the
 * Bargeldbestand never moved, because the three Gehaltsquittung RPCs are the
 * only writers of that ledger.
 *
 * The rule is keyed on **where the write comes from**, never on
 * `payment_type = 'cash'` alone. Three cash paths must stay apart:
 *
 * - The weekly "Bar zurück" (`weekly_cash_difference`) is stored with
 *   `payment_type: 'cash'` but is money the driver kept out of a weekly
 *   settlement. CLAUDE.md is explicit: it counts as paid and never moves cash.
 *   A receipt for it would book a payout from the till that never happened, and
 *   `20260914140000`'s own header says the same. It stays an INSERT.
 * - A payment the user adds becomes a receipt.
 * - **An existing cash row is frozen in the two fields that assert how much
 *   cash left the till.** `confirm_salary_cash_payment` writes its own
 *   `salary_payments` row and cannot adopt one, so no stored row can be turned
 *   into a receipt — and a row that is *already* cash cannot have its amount or
 *   its type edited either. A legacy 100,00 € edited to 5.000,00 € would assert
 *   4.900,00 € more paid in cash with no ledger row anywhere, which is exactly
 *   the defect this module exists to close, reached through the pencil instead
 *   of the add button. The way to correct such a row is to delete it and record
 *   it again, which now creates the receipt and moves the till. Date and
 *   description carry no cash claim and stay editable.
 *
 * Nothing is backfilled: rows recorded before 17.09.2026 keep asserting cash
 * that never moved through `cash_movements`, and no migration corrects them.
 *
 * Pure, and importing nothing from `lib/supabase`: that module reads
 * `window.location.origin` at load and vitest runs in `node`. Both the form
 * (for its notice, its disabled fields and its submit label) and the write
 * itself ask these functions, so what the screen promises and what it does
 * cannot drift.
 */

/** The `salary_payments` columns this decision reads from a row already stored. */
export interface ExistingPayment {
  payment_type: 'cash' | 'bank';
  source_type?: string | null;
  /** The stored euro amount, as the `amount` numeric column comes back. */
  amount?: number | string | null;
}

/**
 * Where the write comes from:
 *
 * `add`                     the user filled in "Zahlung hinzufügen" and submitted it.
 * `edit`                    the user opened an existing row's pencil.
 * `weekly_cash_difference`  "Letzte Woche als Barzahlung" — the Bar zurück import.
 */
export type PaymentWriteOrigin = 'add' | 'edit' | 'weekly_cash_difference';

export interface PaymentWriteRequest {
  origin: PaymentWriteOrigin;
  /** The type the form holds now. Ignored for `weekly_cash_difference`, which is always cash. */
  paymentType?: 'cash' | 'bank';
  /** The amount the form holds now, for `edit`: euros, as typed or as stored. */
  amount?: number | string | null;
  /** The stored row, for `edit`. */
  existing?: ExistingPayment | null;
}

export type PaymentWriteRefusal =
  /** The row belongs to a Gehaltsquittung; the database refuses every edit and delete of it. */
  | 'receipt_payment_locked'
  /** An existing payment cannot be turned into a cash payout: delete it and add a new one. */
  | 'cash_needs_receipt'
  /** A stored cash row's amount and type are frozen; the till cannot be corrected after the fact. */
  | 'cash_row_locked'
  /** An edit with no stored row to edit. */
  | 'payment_not_found';

/**
 * `gehaltsquittung` books nothing here — the Gehaltsquittung flow does, in one
 * transaction with the receipt and the cash movement.
 */
export type PaymentWriteDecision =
  | { kind: 'gehaltsquittung' }
  | { kind: 'insert' }
  | { kind: 'update' }
  | { kind: 'refused'; refusal: PaymentWriteRefusal };

/**
 * Whether two euro amounts are the same money.
 *
 * Compared in integer cents, because the stored value arrives as a number and
 * the form's as text, and 100.5 === Number("100.50") only by luck of float
 * printing. An amount that cannot be read at all counts as **different**: the
 * field it came from is disabled wherever this matters, so an unreadable value
 * means something is wrong, and refusing is the fail-closed answer.
 */
function sameAmount(a: number | string | null | undefined, b: number | string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  try {
    return toCents(a) === toCents(b);
  } catch {
    return false;
  }
}

export function decidePaymentWrite(request: PaymentWriteRequest): PaymentWriteDecision {
  // Bar zurück: cash by type, but nothing leaves the till. Checked first, so no
  // later branch can reach it through the payment type.
  if (request.origin === 'weekly_cash_difference') return { kind: 'insert' };

  if (request.origin === 'add') {
    return request.paymentType === 'cash' ? { kind: 'gehaltsquittung' } : { kind: 'insert' };
  }

  const existing = request.existing ?? null;
  // Unreachable from either call site, which only edit a row they hold. This
  // module is the single authority for the decision, so it answers for the
  // case rather than falling through to a write.
  if (existing === null) return { kind: 'refused', refusal: 'payment_not_found' };

  // The second wall behind paymentRowActions, which already hides the pencil on
  // these rows: the trigger in 20260914140000 refuses the UPDATE anyway, and a
  // refusal a person can read beats a database error.
  if (existing.source_type === 'gehaltsquittung') {
    return { kind: 'refused', refusal: 'receipt_payment_locked' };
  }

  if (existing.payment_type === 'cash') {
    // Both fields assert how much cash left the till, and no ledger row backs
    // either one on a stored cash payment. Frozen in both directions.
    if (request.paymentType !== 'cash') return { kind: 'refused', refusal: 'cash_row_locked' };
    if (!sameAmount(request.amount, existing.amount)) return { kind: 'refused', refusal: 'cash_row_locked' };
    return { kind: 'update' };
  }

  if (request.paymentType === 'cash') return { kind: 'refused', refusal: 'cash_needs_receipt' };
  return { kind: 'update' };
}

/**
 * Which fields of a stored payment the form must not offer, and why.
 *
 * Separate from the decision so the form can **disable** the amount and the
 * type rather than let them be typed and refuse on submit. Refusing after the
 * fact still protects the ledger, but it teaches the wrong thing: that the
 * change is possible and merely disallowed today.
 */
export type PaymentFieldLock = 'none' | 'legacy_cash' | 'receipt';

export function paymentFieldLock(existing: ExistingPayment | null | undefined): PaymentFieldLock {
  if (!existing) return 'none';
  if (existing.source_type === 'gehaltsquittung') return 'receipt';
  return existing.payment_type === 'cash' ? 'legacy_cash' : 'none';
}

export const PAYMENT_FIELD_LOCK_KEYS: Record<Exclude<PaymentFieldLock, 'none'>, TranslationKey> = {
  legacy_cash: 'sal.payment.cashRowLocked',
  receipt: 'gq.refusal.receiptPaymentLocked',
};

export const PAYMENT_WRITE_REFUSAL_KEYS: Record<PaymentWriteRefusal, TranslationKey> = {
  receipt_payment_locked: 'gq.refusal.receiptPaymentLocked',
  cash_needs_receipt: 'sal.payment.cashNeedsReceipt',
  cash_row_locked: 'sal.payment.cashRowLocked',
  payment_not_found: 'sal.payment.rowNotFound',
};
