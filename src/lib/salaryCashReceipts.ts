import { supabase } from './supabase';
import { fetchAllPaginated } from '../utils/fetchAllPaginated';
import { formatCentsForNumeric } from '../utils/money';
import type { SalaryPaymentInput } from '../utils/salaryCashReceipt';
import {
  checkSignedCopyFile,
  refusalFromRpcError,
  refusalFromStorageError,
  signedCopyPath,
  type ReceiptActionRefusal,
  type ReceiptSnapshotRow,
  type RpcErrorLike,
} from '../utils/salaryCashReceiptFlow';

/**
 * Every read and write behind the Gehaltsquittung screens, so the modal and
 * the receipt list send the same queries.
 *
 * Writes go only through the RPCs in
 * supabase/migrations/20260914140000_salary_cash_receipts.sql: the browser has
 * no INSERT, UPDATE or DELETE on the receipt tables. Reads filter on the
 * company as well as relying on RLS.
 */

export const SALARY_RECEIPTS_BUCKET = 'salary-receipts';

/** A signed copy is opened straight away, so its link only has to outlive the click. */
const SIGNED_URL_SECONDS = 60;

export type DriverGender = 'male' | 'female' | null;

export interface ReceiptDriver {
  id: string;
  name: string;
  gender: DriverGender;
  status: string | null;
}

const SALARY_COLUMNS = 'id, driver_id, period_start, period_end, amount_due, netto_salary, payment_status';

export interface ReceiptSalary {
  id: string;
  driver_id: string;
  period_start: string;
  period_end: string;
  amount_due: number | string | null;
  netto_salary: number | string | null;
  payment_status: 'unpaid' | 'partially_paid' | 'paid' | null;
}

/** A salary_cash_receipts row, as the RPCs return it. */
export interface SalaryCashReceipt extends ReceiptSnapshotRow {
  id: string;
  company_id: string;
  receipt_number: string;
  salary_id: string;
  driver_id: string;
  period_start: string;
  period_end: string;
  /** 1–12, from get_business_month(period_start); business_year is the number's GQ-YYYY. */
  business_month: number;
  business_year: number;
  payment_date: string;
  place: string;
  status: 'confirmed' | 'voided';
  signed_copy_path: string | null;
  confirmed_at: string;
  voided_at: string | null;
  void_reason: string | null;
}

/** A receipt with its driver, as the list shows it. */
export interface SalaryCashReceiptWithDriver extends SalaryCashReceipt {
  driver: { name: string; gender: DriverGender } | null;
}

// business_month and business_year are read, not derived: the receipt prints
// its Abrechnungsmonat and the GQ-YYYY in its number is business_year.
const RECEIPT_COLUMNS = [
  'id, company_id, receipt_number, salary_id, driver_id, period_start, period_end',
  'business_month, business_year, payment_date, place',
  'amount, is_partial, due_amount, paid_bank_before, paid_cash_manual_before, paid_cash_weekly_before',
  'paid_cash_receipts_before, remaining_before, remaining_after, status, signed_copy_path',
  'confirmed_at, voided_at, void_reason, driver:drivers(name, gender)',
].join(', ');

export type ReceiptWriteResult =
  | { ok: true; receipt: SalaryCashReceipt }
  | { ok: false; refusal: ReceiptActionRefusal };

function fromRpc(data: unknown, error: RpcErrorLike | null): ReceiptWriteResult {
  if (error) return { ok: false, refusal: refusalFromRpcError(error) };
  // A function returning one composite comes back as an object; anything else
  // means the call did not do what it should, and must not look like success.
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, refusal: 'unexpected' };
  return { ok: true, receipt: data as SalaryCashReceipt };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** Every driver of the company, former ones included: a salary can be owed after someone leaves. */
export async function loadReceiptDrivers(companyId: string): Promise<ReceiptDriver[]> {
  const { data, error } = await supabase
    .from('drivers')
    .select('id, name, gender, status')
    .eq('company_id', companyId)
    .order('name');
  if (error) throw new Error(error.message);
  return (data ?? []) as ReceiptDriver[];
}

/** A driver's salary rows, newest period first. */
export async function loadDriverSalaries(companyId: string, driverId: string): Promise<ReceiptSalary[]> {
  const { data, error } = await supabase
    .from('salaries')
    .select(SALARY_COLUMNS)
    .eq('company_id', companyId)
    .eq('driver_id', driverId)
    .order('period_start', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as ReceiptSalary[];
}

/** A salary and every payment against it: what computeReceiptFigures needs. Null when the salary is gone. */
export async function loadSalaryBalanceInputs(
  companyId: string,
  salaryId: string,
): Promise<{ salary: ReceiptSalary; payments: SalaryPaymentInput[] } | null> {
  const [salaryResult, payments] = await Promise.all([
    supabase.from('salaries').select(SALARY_COLUMNS).eq('company_id', companyId).eq('id', salaryId).maybeSingle(),
    fetchAllPaginated<SalaryPaymentInput>(
      (from, to) =>
        supabase
          .from('salary_payments')
          .select('payment_type, amount, source_type')
          .eq('salary_id', salaryId)
          .order('id')
          .range(from, to),
      { label: 'Gehaltszahlungen' },
    ),
  ]);
  if (salaryResult.error) throw new Error(salaryResult.error.message);
  if (!salaryResult.data) return null;
  return { salary: salaryResult.data as ReceiptSalary, payments };
}

/** The company's receipts, newest first. */
export async function loadReceipts(companyId: string): Promise<SalaryCashReceiptWithDriver[]> {
  return fetchAllPaginated<SalaryCashReceiptWithDriver>(
    (from, to) =>
      supabase
        .from('salary_cash_receipts')
        .select(RECEIPT_COLUMNS)
        .eq('company_id', companyId)
        .order('confirmed_at', { ascending: false })
        .order('id')
        .range(from, to) as unknown as PromiseLike<{
        data: SalaryCashReceiptWithDriver[] | null;
        error: { message: string } | null;
      }>,
    { label: 'Gehaltsquittungen' },
  );
}

/**
 * One receipt of the company by id, or null when there is none to show.
 *
 * Filtered on the company as well as relying on RLS, like every other read
 * here: the SELECT policy reads the caller's own company, so a receipt of
 * another company answers as no row rather than as an error.
 */
export async function loadReceiptById(companyId: string, receiptId: string): Promise<SalaryCashReceiptWithDriver | null> {
  const { data, error } = await supabase
    .from('salary_cash_receipts')
    .select(RECEIPT_COLUMNS)
    .eq('company_id', companyId)
    .eq('id', receiptId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as SalaryCashReceiptWithDriver | null) ?? null;
}

/** A short-lived link to a signed copy; null when storage refuses it. */
export async function signedCopyUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(SALARY_RECEIPTS_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  return error ? null : data?.signedUrl ?? null;
}

/**
 * Opens a signed copy in a new tab. The tab is opened before the link is
 * fetched, because a tab opened after an await counts as a pop-up and is
 * blocked. False when no link could be made.
 */
export async function openSignedCopy(path: string): Promise<boolean> {
  const tab = window.open('', '_blank');
  const url = await signedCopyUrl(path);
  if (!url) {
    tab?.close();
    return false;
  }
  if (tab) {
    tab.opener = null;
    tab.location.replace(url);
    return true;
  }
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.click();
  return true;
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export interface ConfirmCashPaymentRequest {
  requestId: string;
  salaryId: string;
  amountCents: number;
  /** YYYY-MM-DD */
  paymentDate: string;
  place: string;
}

/** Books the payment, its receipt and the cash movement in one transaction, or refuses all three. */
export async function confirmCashPayment(request: ConfirmCashPaymentRequest): Promise<ReceiptWriteResult> {
  const { data, error } = await supabase.rpc('confirm_salary_cash_payment', {
    p_request_id: request.requestId,
    p_salary_id: request.salaryId,
    p_amount: formatCentsForNumeric(request.amountCents),
    p_payment_date: request.paymentDate,
    p_place: request.place,
  });
  return fromRpc(data, error);
}

export async function voidReceipt(receiptId: string, reason: string): Promise<ReceiptWriteResult> {
  const { data, error } = await supabase.rpc('void_salary_cash_receipt', { p_receipt_id: receiptId, p_reason: reason });
  return fromRpc(data, error);
}

function storageErrorFields(error: unknown): { status: number | string | null; statusCode: number | string | null } {
  const fields = (error ?? {}) as { status?: unknown; statusCode?: unknown };
  const pick = (value: unknown) => (typeof value === 'number' || typeof value === 'string' ? value : null);
  return { status: pick(fields.status), statusCode: pick(fields.statusCode) };
}

/**
 * Uploads a signed copy under a name of its own and points the receipt at it.
 *
 * If the upload lands and attaching fails, the file stays in storage without a
 * receipt pointing at it: the bucket has no DELETE policy. Trying again uploads
 * under a new name.
 */
export async function uploadSignedCopy(
  companyId: string,
  receipt: Pick<SalaryCashReceipt, 'id' | 'receipt_number' | 'payment_date'>,
  file: File,
): Promise<ReceiptWriteResult> {
  const problem = checkSignedCopyFile(file);
  if (problem) return { ok: false, refusal: problem };

  const path = signedCopyPath(companyId, receipt, file.type, new Date());
  const upload = await supabase.storage
    .from(SALARY_RECEIPTS_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (upload.error) return { ok: false, refusal: refusalFromStorageError(storageErrorFields(upload.error)) };

  const { data, error } = await supabase.rpc('attach_salary_cash_receipt_signed_copy', {
    p_receipt_id: receipt.id,
    p_path: path,
  });
  return fromRpc(data, error);
}
