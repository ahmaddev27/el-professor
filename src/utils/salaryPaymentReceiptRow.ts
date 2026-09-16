import {
  buildReceiptDocumentText,
  receiptDocumentProblem,
  storedReceiptDocumentInput,
  type ReceiptDocumentInput,
  type ReceiptDocumentProblem,
  type ReceiptDocumentText,
  type StoredReceiptFields,
} from './salaryCashReceiptDocument';
import { receiptScope, scopeRefusal, type ReceiptActionRefusal, type ReceiptScope } from './salaryCashReceiptFlow';

/**
 * What a salary payment row offers, which receipt its Gehaltsquittung preview
 * loads, and what that preview prints.
 *
 * Kept pure and apart from SalaryDetailsModal for the reason profileLoadRetry
 * is: the modal pulls in lib/supabase, which reads window.location.origin at
 * module load, and vitest runs in `node` with no DOM. The query itself arrives
 * as a function, so the decisions around it — who may ask, what a thrown query
 * means, which answer belongs to the receipt now open — are tested here instead
 * of through the component.
 */

// ─── What one payment row offers ────────────────────────────────────────────

/** The columns of a salary_payments row the actions cell reads. */
export interface PaymentRowInput {
  payment_type: 'cash' | 'bank';
  source_type?: 'manual' | 'weekly_cash_difference' | 'gehaltsquittung' | string | null;
  source_reference?: string | null;
}

/** What the row's actions depend on besides the payment itself. */
export interface PaymentRowContext {
  /** usePlan().can('dokumente'): the feature the Gehaltsquittung belongs to. */
  planIncludesDokumente: boolean;
  /** Whose receipts this screen may act on, from receiptScope(). */
  scope: ReceiptScope;
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
 * The preview needs three things: a receipt to load, the `dokumente` feature —
 * the same gate the row's link to the Documents page already applied, the
 * Gehaltsquittung being part of that feature — and a caller inside the
 * company that owns the receipt. The last one is why the scope is passed in:
 * SalaryDetailsModal reads the *effective* company, so platform staff who have
 * entered a customer see that customer's payment rows, while the receipt's
 * SELECT policy and every Gehaltsquittung RPC read the caller's own company
 * (get_user_company_id()). Such a caller is refused by name the moment the
 * dialog opens, so the row keeps its lock and its badge but is not offered a
 * button that can only end in company_mismatch.
 */
export function paymentRowActions(payment: PaymentRowInput, context: PaymentRowContext): PaymentRowActions {
  if (payment.source_type !== 'gehaltsquittung') return { kind: 'editable' };
  const receiptId = payment.source_reference?.trim();
  if (!receiptId) return { kind: 'receipt', preview: false };
  if (!context.planIncludesDokumente) return { kind: 'receipt', preview: false };
  if (scopeRefusal(context.scope) !== null) return { kind: 'receipt', preview: false };
  return { kind: 'receipt', preview: true, receiptId };
}

// ─── Loading the receipt behind one row ─────────────────────────────────────

/** The part of a stored receipt this decision reads. The dialog holds the whole row. */
export interface ReceiptStatusOnly {
  status: 'confirmed' | 'voided';
}

/**
 * Where the preview's load stands, and which receipt it stands for.
 *
 * The id belongs in the state because the dialog outlives any one receipt:
 * React commits and paints the newly opened `receiptId` a frame before the
 * effect that starts its load runs, so a state without an id would paint the
 * receipt shown before — its number, its amount, its period — under a dialog
 * opened from another row. Carrying the id also settles a slow answer for one
 * receipt that arrives after another was opened.
 *
 * `loaded` with a null receipt means the query answered and found none.
 */
export type ReceiptLoadState<Receipt extends ReceiptStatusOnly = ReceiptStatusOnly> =
  | { status: 'loading'; receiptId: string | null }
  | { status: 'failed'; receiptId: string | null; refusal: ReceiptActionRefusal }
  | { status: 'loaded'; receiptId: string | null; receipt: Receipt | null };

/**
 * The state as it applies to the receipt the dialog shows now. Anything held
 * for another receipt counts as still loading: printing one receipt's figures
 * under another receipt's dialog is the wrong statutory document on screen,
 * even for a single frame.
 */
export function currentLoadState<Receipt extends ReceiptStatusOnly>(
  state: ReceiptLoadState<Receipt>,
  receiptId: string | null,
): ReceiptLoadState<Receipt> {
  return state.receiptId === receiptId ? state : { status: 'loading', receiptId };
}

/** Who is asking, and for which receipt. */
export interface ReceiptPreviewRequest {
  receiptId: string;
  /** The caller's own company, from AuthContext. */
  companyId: string | null;
  /** The company whose data the screen is showing, from SuperAdminContext. */
  effectiveCompanyId: string | null;
  isViewingAsCompany: boolean;
}

/** The query the preview runs, passed in so this module never reaches lib/supabase. */
export type ReceiptLoader<Receipt extends ReceiptStatusOnly> = (
  companyId: string,
  receiptId: string,
) => Promise<Receipt | null>;

/**
 * Loads the receipt behind one payment row, or names why it will not.
 *
 * The scope is settled before any query goes out. The table's SELECT policy
 * reads the caller's own company, so a platform account viewing a customer
 * would get an empty answer that reads exactly like a deleted receipt; it is
 * refused by name instead, and nothing is asked of the database.
 *
 * Never rejects. A query that throws — an expired session, a gateway that
 * answers with no reason — becomes `unexpected`, because an unhandled rejection
 * here would surface as an empty sheet or reach the salary screen.
 */
export async function loadReceiptForPreview<Receipt extends ReceiptStatusOnly>(
  request: ReceiptPreviewRequest,
  load: ReceiptLoader<Receipt>,
): Promise<ReceiptLoadState<Receipt>> {
  const { receiptId, companyId, effectiveCompanyId, isViewingAsCompany } = request;
  const refusal = scopeRefusal(receiptScope({ companyId, effectiveCompanyId, isViewingAsCompany }));
  if (refusal || !companyId) return { status: 'failed', receiptId, refusal: refusal ?? 'no_company' };
  try {
    return { status: 'loaded', receiptId, receipt: await load(companyId, receiptId) };
  } catch {
    return { status: 'failed', receiptId, refusal: 'unexpected' };
  }
}

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
 * The preview's state as the dialog renders it. Give it currentLoadState's
 * answer, never the raw state, or a state held for an earlier receipt renders
 * as that receipt's document.
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

// ─── What the preview prints ────────────────────────────────────────────────

/** The sheet the dialog renders, and whose text its PDF exports. */
export type ReceiptSheet =
  | { kind: 'text'; text: ReceiptDocumentText }
  | { kind: 'problem'; problem: ReceiptDocumentProblem }
  | { kind: 'broken' };

/**
 * The document one stored receipt prints as.
 *
 * Every figure comes out of the row the database stored, through
 * storedReceiptDocumentInput; nothing is recomputed from the payment. The
 * dialog renders this one `text` and hands the same object to the PDF export,
 * so the sheet on screen and the sheet in the file cannot differ.
 *
 * Nothing here throws, and the whole build is inside the guard rather than the
 * last call alone: toCents refuses by design anything that is not a finite
 * decimal, and a voided receipt's berlinToday(new Date(voided_at)) refuses an
 * unreadable timestamp — both from inside storedReceiptDocumentInput, before
 * the builder is reached. The salary screen sits under no error boundary, so a
 * throw during render would unmount the application; a stored row that cannot
 * be read becomes `broken` and the dialog says so instead.
 */
export function receiptSheet(
  receipt: StoredReceiptFields,
  driver: ReceiptDocumentInput['driver'],
  company: ReceiptDocumentInput['company'],
): ReceiptSheet {
  try {
    const input = storedReceiptDocumentInput(receipt, driver, company);
    const problem = receiptDocumentProblem(input);
    if (problem) return { kind: 'problem', problem };
    return { kind: 'text', text: buildReceiptDocumentText(input) };
  } catch {
    return { kind: 'broken' };
  }
}
