import type { TranslationKey } from '../i18n';

/**
 * Which salary payment is written straight into `salary_payments`, and which
 * stored row may still be changed at all.
 *
 * **Owner decision, 04.10.2026, which reverses the decision of 17.09.2026.**
 * A cash payment the user adds by hand is a plain INSERT again: the form saves
 * it and closes, with no Gehaltsquittung step in between. His words: "we do not
 * work anymore with Gehaltsquittung", and then, on the form itself, "once I
 * click continue it must be saved, so this popup must not be shown".
 *
 * THE MONEY RULE THIS PRESERVES, stated because it is the whole point of the
 * module: **the till is `cash_movements`, and only the three Gehaltsquittung
 * RPCs write it.** Nothing here writes a receipt, a movement, or anything but
 * `salary_payments`. What the reversal gives up is therefore precise and worth
 * writing down rather than discovering later: **a cash payment added here does
 * not lower the Bargeldbestand.** It asserts the driver was paid; the till is a
 * separate ledger and does not move.
 *
 * That is not a new state and it is not an accident. 34 cash payments totalling
 * 19.665,68 EUR on staging were already recorded that way before 17.09.2026 and
 * carry no movement, and `issue_salary_cash_receipt` (20261004100000) was built
 * on 04.10.2026 for exactly those rows: it issues the numbered receipt
 * afterwards and **books nothing into the till**, because booking them would
 * have dropped one company's Bargeldbestand by 19.573,32 EUR at once. So the
 * receipt is a document issued after the fact, and this is the path that
 * creates the payment it is issued for.
 *
 * Three cash paths still have to stay apart, and the rule is keyed on **where
 * the write comes from and on the stored row**, never on `payment_type = 'cash'`:
 *
 * - The weekly "Bar zurück" (`weekly_cash_difference`) is cash by type but is
 *   money the driver kept out of a weekly settlement. CLAUDE.md is explicit: it
 *   counts as paid and never moves cash. It is checked first so no later branch
 *   can reach it, and `paymentRowCanBeIssued` keeps a receipt off it too.
 * - A row written by `confirm_salary_cash_payment` (`source_type =
 *   'gehaltsquittung'`) is undone only by voiding its receipt. The trigger in
 *   20260914140000 refuses every UPDATE and DELETE of it; this names the reason
 *   a person can read instead of a database error.
 * - A row that has been **issued** a live receipt after the fact is frozen the
 *   same way, by `salary_payments_issued_receipt_guard` (20261004110000,
 *   BEFORE UPDATE OR DELETE). `paymentRowActions` already hides its pencil, so
 *   this is the second wall rather than the only one.
 *
 * An ordinary cash row with no receipt is editable like any other: no ledger
 * row stands behind it in either direction, so changing its amount moves no
 * money. The freeze that used to sit here told the user to delete the row and
 * record it again "because the new cash payment creates a Gehaltsquittung and
 * books the amount out of the cash box" — a sentence that stopped being true
 * the moment the add path stopped doing that, which is why it went with it
 * rather than being left to mislead.
 *
 * Pure, and importing nothing from `lib/supabase`: that module reads
 * `window.location.origin` at load and vitest runs in `node`. Both the form
 * (for its disabled fields and its submit) and the write itself ask these
 * functions, so what the screen promises and what it does cannot drift.
 */

/** The `salary_payments` columns this decision reads from a row already stored. */
export interface ExistingPayment {
  payment_type: 'cash' | 'bank';
  source_type?: string | null;
  /** The stored euro amount, as the `amount` numeric column comes back. */
  amount?: number | string | null;
  /**
   * The receipt issued for this payment after the fact
   * (`issue_salary_cash_receipt`), or null/absent. A payment *written* by a
   * Gehaltsquittung names its receipt in `source_reference` instead; the two
   * never coexist, which is why both are asked separately below.
   */
  issued_receipt_id?: string | null;
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
  /** The row was written by a Gehaltsquittung; the database refuses every edit and delete of it. */
  | 'receipt_payment_locked'
  /** A numbered receipt has been issued for the row; the database refuses to change it. */
  | 'issued_receipt_locked'
  /** An edit with no stored row to edit. */
  | 'payment_not_found';

export type PaymentWriteDecision =
  | { kind: 'insert' }
  | { kind: 'update' }
  | { kind: 'refused'; refusal: PaymentWriteRefusal };

export function decidePaymentWrite(request: PaymentWriteRequest): PaymentWriteDecision {
  // Bar zurück: cash by type, but nothing leaves the till. Checked first, so no
  // later branch can reach it through the payment type.
  if (request.origin === 'weekly_cash_difference') return { kind: 'insert' };

  // Owner, 04.10.2026: a cash payment added by hand is a plain row again.
  if (request.origin === 'add') return { kind: 'insert' };

  const existing = request.existing ?? null;
  // Unreachable from either call site, which only edit a row they hold. This
  // module is the single authority for the decision, so it answers for the
  // case rather than falling through to a write.
  if (existing === null) return { kind: 'refused', refusal: 'payment_not_found' };

  // Both walls stand in front of a database trigger that refuses the statement
  // anyway. paymentRowActions already hides the pencil on both kinds of row;
  // these are what the form says if one is reached another way.
  if (existing.source_type === 'gehaltsquittung') {
    return { kind: 'refused', refusal: 'receipt_payment_locked' };
  }
  if (existing.issued_receipt_id?.trim()) {
    return { kind: 'refused', refusal: 'issued_receipt_locked' };
  }

  return { kind: 'update' };
}

/**
 * Which stored payment the form must not offer to change at all, and why.
 *
 * Separate from the decision so the form can **disable** its fields rather than
 * let them be typed and refuse on submit: a field that takes a value and then
 * rejects it teaches that the change is possible and merely disallowed today.
 *
 * Every lock here freezes the whole row, because that is what both database
 * triggers do — neither refuses a column, both refuse the statement.
 */
export type PaymentFieldLock = 'none' | 'receipt' | 'issued_receipt';

export function paymentFieldLock(existing: ExistingPayment | null | undefined): PaymentFieldLock {
  if (!existing) return 'none';
  if (existing.source_type === 'gehaltsquittung') return 'receipt';
  return existing.issued_receipt_id?.trim() ? 'issued_receipt' : 'none';
}

export const PAYMENT_FIELD_LOCK_KEYS: Record<Exclude<PaymentFieldLock, 'none'>, TranslationKey> = {
  receipt: 'gq.refusal.receiptPaymentLocked',
  issued_receipt: 'sal.payment.issuedReceiptLocked',
};

export const PAYMENT_WRITE_REFUSAL_KEYS: Record<PaymentWriteRefusal, TranslationKey> = {
  receipt_payment_locked: 'gq.refusal.receiptPaymentLocked',
  issued_receipt_locked: 'sal.payment.issuedReceiptLocked',
  payment_not_found: 'sal.payment.rowNotFound',
};
