import {
  buildReceiptDocumentText,
  receiptDocumentProblem,
  storedReceiptDocumentInput,
  type ReceiptDocumentInput,
  type ReceiptDocumentProblem,
  type ReceiptDocumentText,
  type StoredReceiptFields,
} from './salaryCashReceiptDocument';
import {
  confirmationBlock,
  receiptScope,
  scopeRefusal,
  type ReceiptActionRefusal,
  type ReceiptScope,
} from './salaryCashReceiptFlow';

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
  /**
   * The live receipt issued for this payment after the fact
   * (`issue_salary_cash_receipt`, 20261004110000), or null/absent. A payment
   * written by a Gehaltsquittung names its receipt in `source_reference`
   * instead; the two never coexist.
   */
  issued_receipt_id?: string | null;
}

/** What the row's actions depend on besides the payment itself. */
export interface PaymentRowContext {
  /**
   * Not read since 03.10.2026: the owner dropped the plan from the conditions
   * for viewing a cash payment. Kept so callers and tests keep one shape.
   */
  planIncludesDokumente?: boolean;
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
  const issuedId = payment.issued_receipt_id?.trim();
  if (payment.source_type !== 'gehaltsquittung' && !issuedId) return { kind: 'editable' };
  const receiptId = payment.source_type === 'gehaltsquittung' ? payment.source_reference?.trim() : issuedId;
  if (!receiptId) return { kind: 'receipt', preview: false };
  if (scopeRefusal(context.scope) !== null) return { kind: 'receipt', preview: false };
  return { kind: 'receipt', preview: true, receiptId };
}

/**
 * Whether a payment can be issued a numbered Gehaltsquittung after the fact:
 * a cash payment that is neither "Bar zurück" nor already behind a receipt.
 * The same condition `issue_salary_cash_receipt` refuses with
 * `payment_not_issuable` and `already_issued`; the database decides, this only
 * keeps the button off rows it would refuse.
 */
export function paymentRowCanBeIssued(payment: PaymentRowInput): boolean {
  if (payment.payment_type !== 'cash') return false;
  if (payment.source_type === 'weekly_cash_difference' || payment.source_type === 'gehaltsquittung') return false;
  return !payment.issued_receipt_id?.trim();
}

/**
 * Whether a row offers the **payment view**: the read-only sheet drawn from the
 * payment itself (owner decision 03.10.2026, "each payment in the salary with
 * type cash must be able to be viewed").
 *
 * Offered for every cash payment that does not open a stored receipt:
 * a manual one, and a Gehaltsquittung row whose receipt cannot be opened (no
 * id stored, or a caller outside the owning company). **Never offered in place
 * of a stored receipt that can be opened** — a real, numbered receipt is never
 * replaced by a derived sheet.
 *
 * "Bar zurück" (`weekly_cash_difference`) is excluded: it is paid in the
 * salary's books but the till never saw it, so a sheet headed "Barzahlung" would
 * state a cash handover that did not happen.
 *
 * It reads nothing from salary_cash_receipts and writes nothing, so it needs
 * neither the plan nor the caller's own company: platform staff inside a
 * support session may view it (a view is not issuing, voiding or signing).
 */
export function paymentRowOffersView(payment: PaymentRowInput, actions: PaymentRowActions): boolean {
  if (payment.payment_type !== 'cash') return false;
  if (payment.source_type === 'weekly_cash_difference') return false;
  return !(actions.kind === 'receipt' && actions.preview);
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

// ─── Voiding one payment row's receipt ──────────────────────────────────────

/**
 * THE RULE THESE THREE FUNCTIONS PRESERVE, stated before the code because it is
 * a money rule: **a payment written by confirm_salary_cash_payment is undone
 * only by voiding its receipt, never by deleting the row.**
 * `void_salary_cash_receipt` does four things in one transaction
 * (20260914140000:560) — it marks the receipt `voided` with its reason and
 * actor, deletes the `salary_payments` row, books the amount back into the till
 * as an incoming `cash_movements` row dated the day of the void, and points the
 * receipt at that movement. A bare delete of the payment would do the second of
 * those only: the salary would show the money unpaid, the till would still be
 * short, the receipt would still read `confirmed`, and nothing would record
 * why. So nothing here deletes, recomputes or rounds anything — these functions
 * only decide whether that one RPC may be offered, and the screen calls it
 * through the same `voidReceipt` helper the Gehaltsquittung list uses.
 *
 * Why the operation is offered on the payment row at all: the row is where
 * someone who wants the payment gone looks for it, and the only thing there
 * today is a lock. The lock stays — `paymentRowActions` still answers
 * `{ kind: 'receipt' }`, and the row is still not editable.
 */

/** What the Storno needs to know besides the payment row itself. */
export interface PaymentRowStornoContext {
  /** Whose receipts this screen may act on, from receiptScope(). */
  scope: ReceiptScope;
  /** can('salaries', 'edit'): the right the RPC checks as current_role_permits('salaries', true). */
  mayEditSalaries: boolean;
}

/**
 * `hidden` on a row that is not a Gehaltsquittung — such a row has a real
 * delete button and needs no Storno. `blocked` carries the sentence the row
 * shows instead of the button, so the reason sits where the action would be
 * rather than inside a dialog that opens only to refuse.
 */
export type PaymentRowStorno =
  | { kind: 'hidden' }
  | { kind: 'blocked'; refusal: ReceiptActionRefusal }
  | { kind: 'offered'; receiptId: string };

/**
 * Whether the row may offer the Storno, and the reason when it may not.
 *
 * The two conditions are the RPC's own. `void_salary_cash_receipt` opens with
 * `v_caller IS NULL OR v_company IS NULL OR NOT current_role_permits('salaries',
 * true)` — the identical block `confirm_salary_cash_payment` opens with, which
 * is why `confirmationBlock` answers for both and nothing is copied here.
 * (20260921110010 spliced its platform-context refusal in front of that one
 * anchor in all three Gehaltsquittung functions, which is what proves the block
 * is identical in each.)
 *
 * Ahead of it stands that refusal, `platform_session_not_allowed`, and
 * `receiptScope` is this screen's first wall for it: **a platform support
 * session issues, voids and signs nothing here, permanently** (owner's
 * decision, 18.09.2026, reasoned on `receiptScope` itself — attestation, not
 * traceability). `scopeRefusal` answers it with `company_mismatch`, which maps
 * to the same sentence as the database's own reason.
 *
 * **The plan is deliberately not a condition.** Issuing is gated on the
 * `dokumente` feature, because a company that cannot open a receipt should not
 * create one; voiding is the *undo*, and `plan_features` is writable, so gating
 * it would leave a company whose tier changed holding a cash payment it can
 * neither edit, nor delete, nor void — the very state the gate on issuing
 * exists to prevent. The RPC asks for no feature either.
 *
 * A Gehaltsquittung row whose `source_reference` holds no receipt id is
 * `receipt_not_found`: the trigger refuses to change or delete it and there is
 * no receipt to void, so the row says so rather than offering a button with
 * nothing to act on. `confirm_salary_cash_payment` always writes the id
 * (20260914140000:528, `v_receipt.id::text`), so that is the shape of a row
 * written some other way.
 */
export function paymentRowStorno(payment: PaymentRowInput, context: PaymentRowStornoContext): PaymentRowStorno {
  const issuedId = payment.issued_receipt_id?.trim();
  if (payment.source_type !== 'gehaltsquittung' && !issuedId) return { kind: 'hidden' };
  const receiptId = payment.source_type === 'gehaltsquittung' ? payment.source_reference?.trim() : issuedId;
  if (!receiptId) return { kind: 'blocked', refusal: 'receipt_not_found' };
  const blocked = confirmationBlock(context.scope, context.mayEditSalaries);
  if (blocked) return { kind: 'blocked', refusal: blocked };
  return { kind: 'offered', receiptId };
}

/**
 * What the Storno dialog shows while and after it loads the receipt it is about
 * to void.
 *
 * `voided` is a state of its own rather than a refusal, because it is not an
 * error: the receipt was voided elsewhere since this payment list loaded, the
 * row on screen no longer exists, and the dialog says so and offers nothing.
 * The RPC would answer a second call by returning the voided receipt unchanged
 * (20260914140000:611) instead of raising, so without this the Storno would
 * report success, write nothing, book no cash back, and drop the reason the
 * user typed.
 */
export type StornoStep =
  | { kind: 'loading' }
  | { kind: 'refusal'; refusal: ReceiptActionRefusal }
  | { kind: 'voided' }
  | { kind: 'ready' };

/**
 * The dialog's step for the receipt it is open on. Give it currentLoadState's
 * answer, never the raw state, so an answer held for the receipt opened before
 * cannot make this dialog offer a Storno of that one — voiding the wrong
 * receipt moves cash and consumes the wrong document.
 */
export function stornoStep(state: ReceiptLoadState): StornoStep {
  const view = receiptPreviewView(state);
  if (view.kind === 'loading') return { kind: 'loading' };
  if (view.kind === 'refusal') return { kind: 'refusal', refusal: view.refusal };
  return view.voided ? { kind: 'voided' } : { kind: 'ready' };
}

/**
 * Why the typed reason cannot be sent; null when it can.
 *
 * `void_salary_cash_receipt` refuses a NULL or blank reason with
 * `invalid_reason` and stores `btrim(p_reason)`, so the same trim decides here
 * and the user is told before a request goes out. A length is not checked: the
 * column is `text` and the RPC sets no bound, so the field caps its own input
 * instead of this naming a refusal the database would never make.
 */
export function voidReasonProblem(reason: string): ReceiptActionRefusal | null {
  return reason.trim() ? null : 'invalid_reason';
}
