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

/** The parts of Web Crypto a request id needs. */
export interface RandomSource {
  randomUUID?: () => string;
  getRandomValues(array: Uint8Array): Uint8Array;
}

/**
 * A v4 UUID for a request id. crypto.randomUUID exists only in secure contexts
 * and newer browsers (older Safari has none); getRandomValues exists wherever
 * the app runs, so it builds the id when randomUUID is missing.
 */
export function createRequestId(source: RandomSource = globalThis.crypto): string {
  if (typeof source.randomUUID === 'function') return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
 * company_mismatch  platform staff are viewing another company, and the RPCs act
 *                   on the caller's own (get_user_company_id()).
 * no_company        the account belongs to no company at all.
 * stale_figures     the balance changed between the preview and the confirmation.
 * not_sent          something failed before the request left, so nothing was booked.
 * no_response       the request failed before an answer arrived.
 * unexpected        an error that names no reason, such as an expired session.
 * file_*            a signed copy the bucket would refuse.
 * upload_failed     storage refused the upload for another reason.
 */
export type ReceiptActionRefusal =
  | DatabaseRefusal
  | 'company_mismatch'
  | 'no_company'
  | 'stale_figures'
  | 'not_sent'
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
  no_company: 'gq.refusal.noCompany',
  stale_figures: 'gq.refusal.staleFigures',
  not_sent: 'gq.refusal.notSent',
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

// ─── Whose receipts ─────────────────────────────────────────────────────────

export type ReceiptScope = 'own_company' | 'other_company' | 'no_company';

/**
 * Whether the screens may act on receipts. The RPCs and the SELECT policies
 * use the caller's own company (get_user_company_id()), so platform staff
 * viewing a customer and an account with no company are both outside, for
 * different reasons that get different messages.
 */
export function receiptScope({
  companyId,
  effectiveCompanyId,
  isViewingAsCompany,
}: {
  companyId: string | null;
  effectiveCompanyId: string | null;
  isViewingAsCompany: boolean;
}): ReceiptScope {
  if (isViewingAsCompany && effectiveCompanyId !== companyId) return 'other_company';
  if (!companyId) return 'no_company';
  return effectiveCompanyId === companyId ? 'own_company' : 'other_company';
}

/** The refusal a scope outside the own company shows; null inside it. */
export function scopeRefusal(scope: ReceiptScope): ReceiptActionRefusal | null {
  if (scope === 'other_company') return 'company_mismatch';
  if (scope === 'no_company') return 'no_company';
  return null;
}

/**
 * Whether the cash ledger's third term — the Gehaltsquittungen and their
 * Stornos in `cash_movements` — is readable, and so whether the Bargeldbestand
 * and the Overview's cash panel may present a till at all.
 *
 * Before `20260917130000` both ledger tables were SELECT-policied on the
 * caller's own company with no platform branch, unlike `income` and
 * `receipts`. Platform staff inside a customer therefore read that customer's
 * real Bargeld and Belege and *no* movements, and an empty set there is
 * indistinguishable from "no payouts" — the screen would have printed a
 * confident and false `0,00 €` under "Gehaltsauszahlungen (bar)".
 *
 * Slice 3.3 did not lift that guard; it narrowed it. Both tables now carry the
 * SELECT shape every business table carries,
 * `company_id = get_active_company_id() OR platform_reads_company_data()`, so
 * the ledger is readable exactly where Bargeld and Belege are. But
 * `platform_reads_company_data()` is `platform_can('business.read')`, held by
 * `owner`, `support` and `read_only` and **not** by `billing`. A billing
 * account still reads no movements, so it still must not be shown a balance
 * that looks complete. The read is granted by capability, not by staff status.
 *
 * `platformReadsCompanyData` is that one database seam and nothing else, and
 * slice 3.4 (20260917140000) has now moved it: `platform_reads_company_data()`
 * is a constant false, and what a platform account may read is the company its
 * open support session names, answered by `get_active_company_id()`. So the
 * capability alone is no longer the seam — held by itself it reads *nothing*,
 * and passing it here would have turned this guard into a rubber stamp: it
 * would pass, the query would return an empty set, and the screen would print
 * the confident `0,00 €` this function exists to prevent.
 *
 * Its mirror is `platformReadsCompanyData` from SuperAdminContext, which is
 * `business.read` **and** a context open on the very company being read. A
 * company user is unaffected: it reads its own ledger through its own
 * membership, and this flag is false and means nothing for it.
 *
 * "Own company" is not a free pass either. `get_active_company_id()` answers a
 * member's company only while that company is approved, active or in trial and
 * subscribed, and the member's account is not blocked. For a company user
 * App.tsx refuses every one of those states before this screen renders. A
 * platform account skips those gates, yet the database still applies them to
 * the platform account's own company — so a staff member whose company is
 * pending or unsubscribed would be shown a till of 0,00 €.
 * `ownCompanyReadable` is the database's own answer for that account, from
 * SuperAdminContext, and is true for every company user.
 */
export function cashLedgerInScope({
  companyId,
  effectiveCompanyId,
  isViewingAsCompany,
  platformReadsCompanyData,
  ownCompanyReadable,
}: {
  companyId: string | null;
  effectiveCompanyId: string | null;
  isViewingAsCompany: boolean;
  platformReadsCompanyData: boolean;
  ownCompanyReadable: boolean;
}): boolean {
  const scope = receiptScope({ companyId, effectiveCompanyId, isViewingAsCompany });
  return (scope === 'own_company' && ownCompanyReadable) || platformReadsCompanyData;
}

// ─── A confirmation without an answer ───────────────────────────────────────

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * A confirmation that went out and got no definitive answer. It is kept in
 * the dialog and in the tab's sessionStorage from the moment it is sent until
 * the database answers, so closing the dialog or reloading the tab cannot
 * start the same payment again under a new request id.
 */
export interface PendingReceiptAttempt {
  companyId: string;
  requestId: string;
  input: PaymentAttemptInput;
  driver: { id: string; name: string; gender: 'male' | 'female' | null };
  period: { start: string; end: string };
  /** What the preview showed when it was sent; the retry shows the same. */
  shown: ReceiptSnapshot;
}

export const pendingAttemptKey = (companyId: string) => `el-professor:gehaltsquittung:pending:${companyId}`;

/** The tab's sessionStorage, or null where it cannot be reached: no window, private mode, blocked site data. */
export function browserSessionStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** False when it could not be written; the attempt held in the dialog still guards that session. */
export function savePendingAttempt(storage: StorageLike | null, record: PendingReceiptAttempt): boolean {
  if (!storage) return false;
  try {
    storage.setItem(pendingAttemptKey(record.companyId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function clearPendingAttempt(storage: StorageLike | null, companyId: string): void {
  if (!storage) return;
  try {
    storage.removeItem(pendingAttemptKey(companyId));
  } catch {
    // Storage that cannot be written holds nothing to clear.
  }
}

const SNAPSHOT_CENT_KEYS = [
  'dueCents',
  'paidBankCents',
  'paidCashManualCents',
  'paidCashWeeklyCents',
  'paidCashReceiptsCents',
  'remainingBeforeCents',
  'amountCents',
  'remainingAfterCents',
] as const;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const isText = (value: unknown): value is string => typeof value === 'string';
const isCents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

function isPendingAttempt(value: unknown): value is PendingReceiptAttempt {
  const record = asRecord(value);
  const input = asRecord(record?.input);
  const driver = asRecord(record?.driver);
  const period = asRecord(record?.period);
  const shown = asRecord(record?.shown);
  if (!record || !input || !driver || !period || !shown) return false;
  return (
    isText(record.companyId) &&
    isText(record.requestId) &&
    record.requestId !== '' &&
    isText(input.salaryId) &&
    isCents(input.amountCents) &&
    input.amountCents > 0 &&
    isText(input.paymentDate) &&
    isText(input.place) &&
    isText(driver.id) &&
    isText(driver.name) &&
    (driver.gender === 'male' || driver.gender === 'female' || driver.gender === null) &&
    isText(period.start) &&
    isText(period.end) &&
    SNAPSHOT_CENT_KEYS.every(key => isCents(shown[key])) &&
    typeof shown.isPartial === 'boolean'
  );
}

/** The company's pending attempt; null when there is none, or the stored record cannot be trusted. */
export function readPendingAttempt(storage: StorageLike | null, companyId: string): PendingReceiptAttempt | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(pendingAttemptKey(companyId));
    if (!raw) return null;
    const record: unknown = JSON.parse(raw);
    return isPendingAttempt(record) && record.companyId === companyId ? record : null;
  } catch {
    return null;
  }
}
