import type { TranslationKey } from '../i18n';
import { MAX_AMOUNT_IN_WORDS_CENTS } from './germanAmountInWords';
import { parseGermanAmountToCents, toCents } from './money';
import type { ReceiptFigures } from './salaryCashReceipt';

/**
 * The browser side of a Gehaltsquittung: which request id a confirmation
 * sends, what a refusal means, where a signed copy is stored.
 *
 * Pure, so the rules that keep a payment from being booked twice are tested
 * without a database. The RPCs in
 * supabase/migrations/20260914140000_salary_cash_receipts.sql decide every one
 * of these again; nothing here allows what they refuse.
 */

// ─── Request ids ────────────────────────────────────────────────────────────

/** The fields confirm_salary_cash_payment compares when a request id comes back. */
export interface PaymentAttemptInput {
  salaryId: string;
  amountCents: number;
  /** YYYY-MM-DD */
  paymentDate: string;
  place: string;
}

/**
 * not_sent   nothing has gone out with this id.
 * uncertain  it went out and no answer came back, or an answer that names no
 *            reason: the payment may be booked.
 * refused    the database refused it; its transaction rolled back.
 */
export type AttemptState = 'not_sent' | 'uncertain' | 'refused';

export interface PaymentAttempt {
  requestId: string;
  input: PaymentAttemptInput;
  state: AttemptState;
}

/** The RPC trims the place before comparing, so outer spaces do not make a second payment. */
export function samePaymentInput(a: PaymentAttemptInput, b: PaymentAttemptInput): boolean {
  return (
    a.salaryId === b.salaryId &&
    a.amountCents === b.amountCents &&
    a.paymentDate === b.paymentDate &&
    a.place.trim() === b.place.trim()
  );
}

/**
 * The attempt to send for `input`, given the one before it.
 *
 * - The same payment keeps its request id. A double click, or a retry after a
 *   lost response, reaches the database as the same request, and it hands back
 *   the receipt the first one stored instead of booking a second.
 * - While an earlier send is unanswered its id is kept even if the fields
 *   changed. Had that send been booked, the database refuses the new fields as
 *   request_id_conflict; a fresh id would book the payment twice.
 * - A refusal stored nothing, so a changed payment after it takes a new id.
 *
 * After a confirmation succeeds the caller drops the attempt; the next payment
 * starts from null.
 */
export function nextAttempt(
  previous: PaymentAttempt | null,
  input: PaymentAttemptInput,
  newRequestId: () => string,
): PaymentAttempt {
  if (previous && (previous.state === 'uncertain' || samePaymentInput(previous.input, input))) {
    return { requestId: previous.requestId, input, state: previous.state };
  }
  return { requestId: newRequestId(), input, state: 'not_sent' };
}

// ─── Refusals ───────────────────────────────────────────────────────────────

/** Every reason the Gehaltsquittung RPCs and the payment guard put in HINT. */
const DATABASE_REFUSALS = [
  'not_authorized',
  'invalid_request',
  'invalid_amount',
  'invalid_payment_date',
  'invalid_place',
  'salary_not_found',
  'request_id_conflict',
  'overlapping_salary',
  'already_paid',
  'overpayment',
  'invalid_reason',
  'receipt_not_found',
  'invalid_path',
  'receipt_voided',
  'receipt_payment_locked',
] as const;

export type DatabaseRefusal = (typeof DATABASE_REFUSALS)[number];

/**
 * A database refusal, or one the browser reaches itself:
 *
 * company_mismatch  a super admin is viewing another company, and the RPCs act
 *                   on the caller's own (get_user_company_id()).
 * stale_figures     the balance changed between the preview and the confirmation.
 * no_response       the request failed before an answer arrived.
 * unexpected        an error that names no reason, such as an expired session.
 * file_*            a signed copy the bucket would refuse.
 * upload_failed     storage refused the upload for another reason.
 */
export type ReceiptActionRefusal =
  | DatabaseRefusal
  | 'company_mismatch'
  | 'stale_figures'
  | 'no_response'
  | 'unexpected'
  | 'file_type'
  | 'file_too_large'
  | 'file_empty'
  | 'upload_failed';

export interface RpcErrorLike {
  code?: string | null;
  hint?: string | null;
  message?: string | null;
}

function isDatabaseRefusal(value: string): value is DatabaseRefusal {
  return (DATABASE_REFUSALS as readonly string[]).includes(value);
}

/**
 * The refusal behind an RPC error. The stable reason is the HINT; the German
 * MESSAGE is only the database's fallback and is never shown or matched.
 */
export function refusalFromRpcError(error: RpcErrorLike): ReceiptActionRefusal {
  const hint = error.hint ?? '';
  if (isDatabaseRefusal(hint)) return hint;
  // postgrest-js reports a request that got no answer with an empty code and
  // status 0; a gateway's non-JSON error body carries no code either.
  if (!error.code) return 'no_response';
  // Postgres gives a plain permission error a prose hint, not a reason.
  if (error.code === '42501') return 'not_authorized';
  return 'unexpected';
}

export interface StorageErrorLike {
  status?: number | string | null;
  statusCode?: number | string | null;
}

/** The refusal behind a storage upload error. The bucket's policies answer 403, its limits 413 and 415. */
export function refusalFromStorageError(error: StorageErrorLike): ReceiptActionRefusal {
  const status = String(error.statusCode ?? error.status ?? '');
  if (status === '401' || status === '403') return 'not_authorized';
  if (status === '413') return 'file_too_large';
  if (status === '415') return 'file_type';
  return 'upload_failed';
}

/** Whether the action may have been stored although it reported an error. */
export function outcomeIsUnknown(refusal: ReceiptActionRefusal): boolean {
  return refusal === 'no_response' || refusal === 'unexpected';
}

/** Refusals that mean the balance on screen is no longer the database's; reload it before showing them. */
export function balanceMayHaveChanged(refusal: ReceiptActionRefusal): boolean {
  return refusal === 'overpayment' || refusal === 'already_paid' || refusal === 'stale_figures';
}

export const REFUSAL_MESSAGE_KEYS: Record<ReceiptActionRefusal, TranslationKey> = {
  not_authorized: 'gq.refusal.notAuthorized',
  invalid_request: 'gq.refusal.invalidRequest',
  invalid_amount: 'gq.refusal.invalidAmount',
  invalid_payment_date: 'gq.refusal.invalidPaymentDate',
  invalid_place: 'gq.refusal.invalidPlace',
  salary_not_found: 'gq.refusal.salaryNotFound',
  request_id_conflict: 'gq.refusal.requestIdConflict',
  overlapping_salary: 'gq.refusal.overlappingSalary',
  already_paid: 'gq.refusal.alreadyPaid',
  overpayment: 'gq.refusal.overpayment',
  invalid_reason: 'gq.refusal.invalidReason',
  receipt_not_found: 'gq.refusal.receiptNotFound',
  invalid_path: 'gq.refusal.invalidPath',
  receipt_voided: 'gq.refusal.receiptVoided',
  receipt_payment_locked: 'gq.refusal.receiptPaymentLocked',
  company_mismatch: 'gq.refusal.companyMismatch',
  stale_figures: 'gq.refusal.staleFigures',
  no_response: 'gq.refusal.noResponse',
  unexpected: 'gq.refusal.unexpected',
  file_type: 'gq.refusal.fileType',
  file_too_large: 'gq.refusal.fileTooLarge',
  file_empty: 'gq.refusal.fileEmpty',
  upload_failed: 'gq.refusal.uploadFailed',
};

// ─── Salary periods ─────────────────────────────────────────────────────────

export interface SalaryPeriodRow {
  id: string;
  /** YYYY-MM-DD */
  period_start: string;
  /** YYYY-MM-DD */
  period_end: string;
}

/**
 * Another salary row of the same driver whose period overlaps this one: the
 * condition confirm_salary_cash_payment refuses as overlapping_salary. The
 * dates are YYYY-MM-DD text, so text order is date order.
 *
 * Found before an amount is typed, so the refusal does not wait for the last
 * step. Which row is the salary of record is the owner's decision; this only
 * names the other row.
 */
export function findOverlappingSalary<Row extends SalaryPeriodRow>(
  salary: SalaryPeriodRow,
  driverSalaries: readonly Row[],
): Row | null {
  return (
    driverSalaries.find(
      other =>
        other.id !== salary.id && other.period_start <= salary.period_end && other.period_end >= salary.period_start,
    ) ?? null
  );
}

// ─── Amount field ───────────────────────────────────────────────────────────

export type AmountFieldProblem = 'invalid' | 'too_large';

/**
 * The typed cash amount in cents, or why it cannot be printed: unreadable, or
 * too large to write out in words. Zero reads as 0; computeReceiptFigures
 * refuses it as invalid_amount, together with the balance checks.
 */
export function readAmountField(text: string): { cents: number; problem: null } | { cents: null; problem: AmountFieldProblem } {
  const cents = parseGermanAmountToCents(text);
  if (cents === null) return { cents: null, problem: 'invalid' };
  if (cents > MAX_AMOUNT_IN_WORDS_CENTS) return { cents: null, problem: 'too_large' };
  return { cents, problem: null };
}

// ─── Payment date ───────────────────────────────────────────────────────────

/** Today in Europe/Berlin as YYYY-MM-DD, the day the RPC compares a payment date with. */
export function berlinToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(candidate => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export type PaymentDateProblem = 'missing' | 'future';

/** The RPC refuses a missing or future date. It sets no earliest date, and neither does this. */
export function checkPaymentDate(value: string, today: string): PaymentDateProblem | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'missing';
  return value > today ? 'future' : null;
}

// ─── What the receipt prints ────────────────────────────────────────────────

/** The balance a Gehaltsquittung prints, in cents. */
export interface ReceiptSnapshot {
  dueCents: number;
  paidBankCents: number;
  paidCashManualCents: number;
  paidCashWeeklyCents: number;
  paidCashReceiptsCents: number;
  remainingBeforeCents: number;
  amountCents: number;
  remainingAfterCents: number;
  isPartial: boolean;
}

/** The preview's snapshot, from computeReceiptFigures. */
export function snapshotFromFigures(figures: ReceiptFigures): ReceiptSnapshot {
  return {
    dueCents: figures.dueCents,
    paidBankCents: figures.paidBankCents,
    paidCashManualCents: figures.paidCashCents.manual,
    paidCashWeeklyCents: figures.paidCashCents.weeklyCashDifference,
    paidCashReceiptsCents: figures.paidCashCents.gehaltsquittung,
    remainingBeforeCents: figures.remainingBeforeCents,
    amountCents: figures.thisPaymentCents,
    remainingAfterCents: figures.remainingAfterCents,
    isPartial: figures.isPartial,
  };
}

/** The salary_cash_receipts columns that hold what the receipt printed at confirmation. */
export interface ReceiptSnapshotRow {
  due_amount: number | string;
  paid_bank_before: number | string;
  paid_cash_manual_before: number | string;
  paid_cash_weekly_before: number | string;
  paid_cash_receipts_before: number | string;
  remaining_before: number | string;
  amount: number | string;
  remaining_after: number | string;
  is_partial: boolean;
}

/** A stored receipt's snapshot. After confirmation this, not the preview, is what prints. */
export function snapshotFromReceiptRow(row: ReceiptSnapshotRow): ReceiptSnapshot {
  return {
    dueCents: toCents(row.due_amount),
    paidBankCents: toCents(row.paid_bank_before),
    paidCashManualCents: toCents(row.paid_cash_manual_before),
    paidCashWeeklyCents: toCents(row.paid_cash_weekly_before),
    paidCashReceiptsCents: toCents(row.paid_cash_receipts_before),
    remainingBeforeCents: toCents(row.remaining_before),
    amountCents: toCents(row.amount),
    remainingAfterCents: toCents(row.remaining_after),
    isPartial: row.is_partial,
  };
}

export function sameSnapshot(a: ReceiptSnapshot, b: ReceiptSnapshot): boolean {
  return (Object.keys(a) as (keyof ReceiptSnapshot)[]).every(key => a[key] === b[key]);
}

// ─── Signed copies ──────────────────────────────────────────────────────────

/** The salary-receipts bucket's file_size_limit. */
export const SIGNED_COPY_MAX_BYTES = 10 * 1024 * 1024;

/** The bucket's allowed_mime_types, with the extension each is stored under. */
const SIGNED_COPY_EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/** For a file input's `accept`. */
export const SIGNED_COPY_ACCEPT = Object.keys(SIGNED_COPY_EXTENSIONS).join(',');

function signedCopyExtension(mimeType: string): string | null {
  return Object.prototype.hasOwnProperty.call(SIGNED_COPY_EXTENSIONS, mimeType) ? SIGNED_COPY_EXTENSIONS[mimeType] : null;
}

/** Checked before uploading, so a file the bucket would refuse is named before it is sent. */
export function checkSignedCopyFile(file: { type: string; size: number }): 'file_type' | 'file_too_large' | 'file_empty' | null {
  if (!signedCopyExtension(file.type)) return 'file_type';
  if (file.size === 0) return 'file_empty';
  return file.size > SIGNED_COPY_MAX_BYTES ? 'file_too_large' : null;
}

/**
 * Where a signed copy is stored: {company}/{payment year}/{receipt number}_{upload time}.{ext}
 *
 * attach_salary_cash_receipt_signed_copy accepts only a path inside the
 * caller's company folder built of [A-Za-z0-9._-] segments, and the bucket has
 * no DELETE policy. Each upload gets a name of its own, so replacing a copy
 * moves the receipt's pointer and leaves the earlier file in storage rather
 * than overwriting it.
 */
export function signedCopyPath(
  companyId: string,
  receipt: { receipt_number: string; payment_date: string },
  mimeType: string,
  uploadedAt: Date,
): string {
  const extension = signedCopyExtension(mimeType);
  if (!extension) {
    throw new RangeError(`signedCopyPath: ${mimeType} is not a type the salary-receipts bucket accepts`);
  }
  const stamp = uploadedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${companyId}/${receipt.payment_date.slice(0, 4)}/${receipt.receipt_number}_${stamp}.${extension}`;
}
