/**
 * The two audited billing read models (decision D14, migration 20260924110000).
 *
 * `platform_invoices_list` and `platform_subscriptions_list` are SECURITY
 * DEFINER functions that check `billing.manage`, write exactly one audit row per
 * call, and answer
 *
 *   { ok: true,  total, limit, offset, items: [...], summary: {...} }
 *   { ok: false, reason: 'not_authorized' }
 *
 * like every other read model, with one addition: a `summary`. The billing
 * screen's six figures and its year picker were computed in the browser over
 * every invoice of every customer, which is exactly the read this decision
 * closed, so they come back with the page now.
 *
 * A refusal is a **return value**, not an exception, so the `denied` row the
 * function wrote survives. Only a broken argument contract raises (22023), and a
 * raise arrives as a Supabase error.
 *
 * ## The columns are deliberately reduced
 *
 * No account id (`paid_by`, `collected_by`), no `notes`, no customer e-mail
 * address. The company's name and postal address are carried because the
 * invoice PDF prints them. Which columns each list carries is a data protection
 * decision recorded in migration 20260924110000, pinned key by key by
 * `tests/rls/platform-readmodels.sql` and by that migration's own self-check;
 * do not widen a row type without widening the migration first.
 *
 * This module holds no I/O on purpose — the calls live in
 * `platformBillingClient.ts` — so the row shapes, the summary arithmetic and
 * the argument mapping are testable without a database.
 */
import {
  DIRECTORY_PAGE_SIZE,
  directoryOffset,
  parsePlatformReadPage,
  searchArg,
  type PlatformReadRefusal,
} from './platformReadModels';

/** The same page the directories ask for; `platform_read_limit` refuses more. */
export const BILLING_PAGE_SIZE = DIRECTORY_PAGE_SIZE;

// ─── Rows ────────────────────────────────────────────────────────────────────

/** Migration 20260924110000: no subscription_id, no payment_method, no account id. */
export interface PlatformInvoiceRow {
  id: string;
  company_id: string;
  company_name: string | null;
  company_street: string | null;
  company_house_number: string | null;
  company_postal_code: string | null;
  company_city: string | null;
  /** The plan of the subscription the invoice hangs off, or null where it is gone. */
  plan_name: string | null;
  invoice_month: number;
  invoice_year: number;
  invoice_number: string;
  amount: number;
  status: string;
  due_date: string;
  paid_at: string | null;
  cash_received_amount: number | null;
  receipt_note: string | null;
  created_at: string | null;
}

/** No ends_at, no payment_method, and no `notes`: free text that may hold anything. */
export interface PlatformSubscriptionRow {
  id: string;
  company_id: string;
  company_name: string | null;
  plan_id: string | null;
  plan_name: string | null;
  status: string;
  starts_at: string;
  billing_day: number;
  monthly_price: number;
}

// ─── The figures the screen used to compute in the browser ───────────────────

export interface PlatformInvoiceSummary {
  /** Every invoice with status 'open', not only the filtered ones. */
  openCount: number;
  /**
   * Status 'open' whose due date has passed. Status 'overdue' is **not**
   * counted: the billing screen never did, unlike `platform_companies_list`.
   */
  overdueCount: number;
  /** Status 'paid' in the current month — in Europe/Berlin since the figure moved to SQL. */
  paidThisMonthCount: number;
  /** Sum of `amount` over the filtered set. */
  filteredAmount: number;
  /** Sum over the filtered, paid set of the cash received, falling back to the amount. */
  filteredCollected: number;
  /** The invoice years that exist, newest first: the year picker's options. */
  years: number[];
}

export interface PlatformSubscriptionSummary {
  /** Every subscription with status 'active', not only the page's. */
  activeCount: number;
  /** Active subscriptions per plan id — the count each plan card prints. */
  activeByPlan: Record<string, number>;
}

export const EMPTY_INVOICE_SUMMARY: PlatformInvoiceSummary = Object.freeze({
  openCount: 0,
  overdueCount: 0,
  paidThisMonthCount: 0,
  filteredAmount: 0,
  filteredCollected: 0,
  years: Object.freeze([]) as unknown as number[],
});

export const EMPTY_SUBSCRIPTION_SUMMARY: PlatformSubscriptionSummary = Object.freeze({
  activeCount: 0,
  activeByPlan: Object.freeze({}) as Record<string, number>,
});

// ─── Parsing ─────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableStr = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * A money or count value. Numeric comes back from PostgREST as a JSON number;
 * anything else is the fallback rather than NaN, because a NaN would be summed
 * and then printed as a price.
 */
const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const nullableNum = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function parseInvoiceRow(raw: Record<string, unknown>): PlatformInvoiceRow {
  return {
    id: str(raw.id),
    company_id: str(raw.company_id),
    company_name: nullableStr(raw.company_name),
    company_street: nullableStr(raw.company_street),
    company_house_number: nullableStr(raw.company_house_number),
    company_postal_code: nullableStr(raw.company_postal_code),
    company_city: nullableStr(raw.company_city),
    plan_name: nullableStr(raw.plan_name),
    invoice_month: num(raw.invoice_month, 0),
    invoice_year: num(raw.invoice_year, 0),
    invoice_number: str(raw.invoice_number),
    amount: num(raw.amount, 0),
    status: str(raw.status),
    due_date: str(raw.due_date),
    paid_at: nullableStr(raw.paid_at),
    // Null and "no cash counted" are the same thing to the reader, and both
    // must stay distinguishable from 0,00 €, which the ledger treats as absent.
    cash_received_amount: nullableNum(raw.cash_received_amount),
    receipt_note: nullableStr(raw.receipt_note),
    created_at: nullableStr(raw.created_at),
  };
}

export function parseSubscriptionRow(raw: Record<string, unknown>): PlatformSubscriptionRow {
  return {
    id: str(raw.id),
    company_id: str(raw.company_id),
    company_name: nullableStr(raw.company_name),
    plan_id: nullableStr(raw.plan_id),
    plan_name: nullableStr(raw.plan_name),
    status: str(raw.status),
    starts_at: str(raw.starts_at),
    billing_day: num(raw.billing_day, 1),
    monthly_price: num(raw.monthly_price, 0),
  };
}

export function parseInvoiceSummary(raw: unknown): PlatformInvoiceSummary {
  if (!isRecord(raw)) return EMPTY_INVOICE_SUMMARY;
  const years = Array.isArray(raw.years)
    ? raw.years.filter((y): y is number => typeof y === 'number' && Number.isFinite(y))
    : [];
  return {
    openCount: num(raw.open_count, 0),
    overdueCount: num(raw.overdue_count, 0),
    paidThisMonthCount: num(raw.paid_this_month_count, 0),
    filteredAmount: num(raw.filtered_amount, 0),
    filteredCollected: num(raw.filtered_collected, 0),
    // The database aggregates a set, so the order is not promised; the picker
    // shows the newest year first.
    years: [...years].sort((a, b) => b - a),
  };
}

export function parseSubscriptionSummary(raw: unknown): PlatformSubscriptionSummary {
  if (!isRecord(raw)) return EMPTY_SUBSCRIPTION_SUMMARY;
  const byPlan: Record<string, number> = {};
  if (isRecord(raw.active_by_plan)) {
    for (const [planId, count] of Object.entries(raw.active_by_plan)) {
      const parsed = num(count, -1);
      if (parsed >= 0) byPlan[planId] = parsed;
    }
  }
  return { activeCount: num(raw.active_count, 0), activeByPlan: byPlan };
}

// ─── One page, with its summary ──────────────────────────────────────────────

export interface PlatformBillingPage<T, S> {
  ok: true;
  total: number;
  limit: number;
  offset: number;
  items: T[];
  summary: S;
}

export type PlatformBillingResult<T, S> = PlatformBillingPage<T, S> | PlatformReadRefusal;

/**
 * The shared read-model parser plus this slice's summary. A refusal keeps its
 * reason, so the screen can tell "this role may not read the money"
 * (`not_authorized`) from an answer it did not understand.
 */
export function parseBillingPage<T, S>(
  data: unknown,
  parseItem: (raw: Record<string, unknown>) => T,
  parseSummary: (raw: unknown) => S,
): PlatformBillingResult<T, S> {
  const page = parsePlatformReadPage(data, parseItem, BILLING_PAGE_SIZE);
  if (!page.ok) return page;
  return { ...page, summary: parseSummary(isRecord(data) ? data.summary : null) };
}

// ─── What the screen asks for ────────────────────────────────────────────────

export interface InvoiceQuery {
  companyId: string | null;
  /** 1..12, or 0 for "every month" — the picker's own value. */
  month: number;
  year: number;
  /** 'all' or one of the invoice statuses. */
  status: string;
  search: string;
  pageIndex: number;
}

/**
 * One invoice call's arguments.
 *
 * The database refuses a month outside 1..12 and a year outside 2020..2100 with
 * 22023 before it reads anything, so "every month" must be sent as NULL rather
 * than as the 0 the picker carries, and 'all' as NULL rather than as a status
 * no row has.
 */
export function invoiceRpcArgs(query: InvoiceQuery): Record<string, unknown> {
  return {
    p_company_id: query.companyId || null,
    p_month: query.month >= 1 && query.month <= 12 ? query.month : null,
    p_year: Number.isFinite(query.year) && query.year > 0 ? Math.trunc(query.year) : null,
    p_status: query.status && query.status !== 'all' ? query.status : null,
    p_search: searchArg(query.search),
    p_limit: BILLING_PAGE_SIZE,
    p_offset: directoryOffset(query.pageIndex, BILLING_PAGE_SIZE),
  };
}

export interface SubscriptionQuery {
  companyId: string | null;
  status: string | null;
  pageIndex: number;
}

export function subscriptionRpcArgs(query: SubscriptionQuery): Record<string, unknown> {
  return {
    p_company_id: query.companyId || null,
    p_status: query.status && query.status !== 'all' ? query.status : null,
    p_limit: BILLING_PAGE_SIZE,
    p_offset: directoryOffset(query.pageIndex, BILLING_PAGE_SIZE),
  };
}

// ─── Reading a whole list, page by page ──────────────────────────────────────

/**
 * Every page of a list, or null.
 *
 * Two callers need a complete list rather than a page: generating a month's
 * invoices, which must consider every active subscription, and the duplicate
 * check that goes with it. Reading only the first page is the defect slice
 * 3.13b fixed in `manage-users/list` — a short answer with a 200 and no warning
 * — so this pages until the total is covered and answers null when it cannot
 * finish, rather than returning a partial list that looks whole.
 *
 * Every page is one audited read, so this is for a deliberate action (a dialog
 * opening, a generation run) and never for a timer.
 *
 * `fetchPage` is injected so the paging is testable without a database.
 */
export async function collectAllPages<T, S>(
  fetchPage: (pageIndex: number) => Promise<PlatformBillingResult<T, S>>,
): Promise<T[] | null> {
  const rows: T[] = [];
  for (let pageIndex = 0; ; pageIndex += 1) {
    let page: PlatformBillingResult<T, S>;
    try {
      page = await fetchPage(pageIndex);
    } catch {
      return null;
    }
    if (!page.ok) return null;

    rows.push(...page.items);
    if (rows.length >= page.total) return rows;
    // A page that came back empty while the total promises more means the table
    // changed under the read, or the offset ceiling was reached; either way what
    // was collected is not the whole list.
    if (page.items.length === 0) return null;
  }
}
