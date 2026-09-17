import type { TranslationKey } from '../i18n';

/**
 * Which salary payment becomes a Gehaltsquittung, and which is written straight
 * into `salary_payments`.
 *
 * Owner decision, 17.09.2026: every cash salary payment a user *adds by hand*
 * goes through `confirm_salary_cash_payment`, so the receipt, the payment row
 * and the outgoing `cash_movements` row commit together. Before this, an added
 * cash payment was a plain INSERT: the money left the till and the
 * Bargeldbestand never moved, because the three Gehaltsquittung RPCs are the
 * only writers of that ledger.
 *
 * The rule is keyed on **where the write comes from**, never on
 * `payment_type = 'cash'` alone. Two cash paths must stay apart:
 *
 * - The weekly "Bar zurück" (`weekly_cash_difference`) is stored with
 *   `payment_type: 'cash'` but is money the driver kept out of a weekly
 *   settlement. CLAUDE.md is explicit: it counts as paid and never moves cash.
 *   A receipt for it would book a payout from the till that never happened, and
 *   `20260914140000`'s own header says the same. It stays an INSERT.
 * - An existing payment is not a new one. Nothing is backfilled: manual cash
 *   payments recorded before this change keep their row, their edit button and
 *   their delete button. `confirm_salary_cash_payment` writes its own
 *   `salary_payments` row and cannot adopt one, so an existing row cannot be
 *   turned into a receipt either — switching one to cash is refused by name
 *   rather than quietly written as the untracked cash payment this change
 *   exists to stop.
 *
 * Pure, and importing nothing from `lib/supabase`: that module reads
 * `window.location.origin` at load and vitest runs in `node`. Both the form
 * (for its notice and its submit label) and the write itself ask this function,
 * so what the screen promises and what it does cannot drift.
 */

/** The `salary_payments` columns this decision reads from a row already stored. */
export interface ExistingPayment {
  payment_type: 'cash' | 'bank';
  source_type?: string | null;
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
  /** The stored row, for `edit`. */
  existing?: ExistingPayment | null;
}

export type PaymentWriteRefusal =
  /** The row belongs to a Gehaltsquittung; the database refuses every edit and delete of it. */
  | 'receipt_payment_locked'
  /** An existing payment cannot be turned into a cash payout: delete it and add a new one. */
  | 'cash_needs_receipt';

/**
 * `gehaltsquittung` books nothing here — the Gehaltsquittung flow does, in one
 * transaction with the receipt and the cash movement.
 */
export type PaymentWriteDecision =
  | { kind: 'gehaltsquittung' }
  | { kind: 'insert' }
  | { kind: 'update' }
  | { kind: 'refused'; refusal: PaymentWriteRefusal };

export function decidePaymentWrite(request: PaymentWriteRequest): PaymentWriteDecision {
  // Bar zurück: cash by type, but nothing leaves the till. Checked first, so no
  // later branch can reach it through the payment type.
  if (request.origin === 'weekly_cash_difference') return { kind: 'insert' };

  if (request.origin === 'add') {
    return request.paymentType === 'cash' ? { kind: 'gehaltsquittung' } : { kind: 'insert' };
  }

  const existing = request.existing ?? null;
  // The second wall behind paymentRowActions, which already hides the pencil on
  // these rows: the trigger in 20260914140000 refuses the UPDATE anyway, and a
  // refusal a person can read beats a database error.
  if (existing?.source_type === 'gehaltsquittung') {
    return { kind: 'refused', refusal: 'receipt_payment_locked' };
  }
  if (request.paymentType === 'cash' && existing !== null && existing.payment_type !== 'cash') {
    return { kind: 'refused', refusal: 'cash_needs_receipt' };
  }
  return { kind: 'update' };
}

export const PAYMENT_WRITE_REFUSAL_KEYS: Record<PaymentWriteRefusal, TranslationKey> = {
  receipt_payment_locked: 'gq.refusal.receiptPaymentLocked',
  cash_needs_receipt: 'sal.payment.cashNeedsReceipt',
};
