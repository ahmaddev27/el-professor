import type { ReceiptActionRefusal } from './salaryCashReceiptFlow';

/**
 * What a salary payment row offers, and what its Gehaltsquittung preview shows.
 *
 * Kept pure and apart from SalaryDetailsModal for the reason profileLoadRetry
 * is: the modal pulls in lib/supabase, which reads window.location.origin at
 * module load, and vitest runs in `node` with no DOM. The decisions that matter
 * are tested here instead of through the component.
 */

/** The columns of a salary_payments row the actions cell reads. */
export interface PaymentRowInput {
  payment_type: 'cash' | 'bank';
  source_type?: 'manual' | 'weekly_cash_difference' | 'gehaltsquittung' | string | null;
  source_reference?: string | null;
}

/**
 * `editable` keeps the edit and delete buttons. `receipt` is a row written by
 * confirm_salary_cash_payment: locked, and shown with its badge and lock icon.
 * Only `preview: true` carries a receipt id, so a preview cannot be opened
 * without one.
 */
export type PaymentRowActions =
  | { kind: 'editable' }
  | { kind: 'receipt'; preview: false }
  | { kind: 'receipt'; preview: true; receiptId: string };

/**
 * What the actions cell of one payment row renders.
 *
 * The lock is keyed on `source_type` alone, never on `payment_type`, because
 * that is what the database keys it on: the trigger in
 * 20260914140000_salary_cash_receipts.sql refuses every edit and delete of a
 * `gehaltsquittung` row whatever its payment type. Reading the type here would
 * put edit and delete buttons on a row the database will not let anyone change.
 *
 * The preview needs a receipt to load and the `dokumente` feature, the same
 * gate the row's link to the Documents page already applied — the
 * Gehaltsquittung is part of that feature, and the preview shows the same
 * document the Documents page would.
 */
export function paymentRowActions(payment: PaymentRowInput, planIncludesDokumente: boolean): PaymentRowActions {
  if (payment.source_type !== 'gehaltsquittung') return { kind: 'editable' };
  const receiptId = payment.source_reference?.trim();
  if (!receiptId || !planIncludesDokumente) return { kind: 'receipt', preview: false };
  return { kind: 'receipt', preview: true, receiptId };
}

/** The part of a stored receipt this decision reads. The dialog holds the whole row. */
export interface ReceiptStatusOnly {
  status: 'confirmed' | 'voided';
}

/** Where the preview's load stands. `loaded` with a null receipt means the query answered and found none. */
export type ReceiptLoadState<Receipt extends ReceiptStatusOnly = ReceiptStatusOnly> =
  | { status: 'loading' }
  | { status: 'failed'; refusal: ReceiptActionRefusal }
  | { status: 'loaded'; receipt: Receipt | null };

/**
 * What the preview shows. `voided` is carried out of the stored row rather than
 * inferred: voiding deletes the payment, so a row whose receipt is already
 * voided is a list fetched before someone else voided it, and it must say so
 * instead of printing as a valid receipt.
 */
export type ReceiptPreviewView =
  | { kind: 'loading' }
  | { kind: 'refusal'; refusal: ReceiptActionRefusal }
  | { kind: 'document'; voided: boolean };

/**
 * The preview's state as the dialog renders it.
 *
 * A query that answered with no row is `receipt_not_found`: the receipt is
 * gone, or it belongs to another company and the SELECT policy hid it. Either
 * way the preview says so rather than showing an empty sheet.
 */
export function receiptPreviewView(state: ReceiptLoadState): ReceiptPreviewView {
  if (state.status === 'loading') return { kind: 'loading' };
  if (state.status === 'failed') return { kind: 'refusal', refusal: state.refusal };
  if (!state.receipt) return { kind: 'refusal', refusal: 'receipt_not_found' };
  return { kind: 'document', voided: state.receipt.status === 'voided' };
}
