/**
 * The billing read models, called (decision D14, migration 20260924110000).
 *
 * One `supabase.rpc` each — a POST, because both are VOLATILE and record their
 * own read — handed straight to the pure parsers in `platformBilling.ts`. A
 * transport or privilege failure throws; a refusal the function decided
 * (`not_authorized`, for a role without `billing.manage`) comes back as a value,
 * so the `denied` audit row it wrote is kept and the screen can say why.
 */
import { supabase } from './supabase';
import {
  collectAllPages,
  invoiceRpcArgs,
  parseBillingPage,
  parseInvoiceQuotes,
  parseInvoiceRow,
  parseInvoiceSummary,
  parseSubscriptionRow,
  parseSubscriptionSummary,
  subscriptionRpcArgs,
  type InvoiceQuery,
  type PlatformBillingResult,
  type PlatformInvoiceQuote,
  type PlatformInvoiceRow,
  type PlatformInvoiceSummary,
  type PlatformSubscriptionRow,
  type PlatformSubscriptionSummary,
  type SubscriptionQuery,
} from './platformBilling';

export type InvoicePage = PlatformBillingResult<PlatformInvoiceRow, PlatformInvoiceSummary>;
export type SubscriptionPage = PlatformBillingResult<PlatformSubscriptionRow, PlatformSubscriptionSummary>;

export async function fetchInvoices(query: InvoiceQuery): Promise<InvoicePage> {
  const { data, error } = await supabase.rpc('platform_invoices_list', invoiceRpcArgs(query));
  if (error) throw new Error(error.message);
  return parseBillingPage(data, parseInvoiceRow, parseInvoiceSummary);
}

export async function fetchSubscriptions(query: SubscriptionQuery): Promise<SubscriptionPage> {
  const { data, error } = await supabase.rpc('platform_subscriptions_list', subscriptionRpcArgs(query));
  if (error) throw new Error(error.message);
  return parseBillingPage(data, parseSubscriptionRow, parseSubscriptionSummary);
}

/**
 * What each active subscription's invoice for one period costs, and whether it
 * is the company's first (migration 20261015160000). One call, one audited read
 * row. Null means the answer could not be read — a refusal, a transport failure
 * or a shape this build does not know — and then nothing is generated: an
 * invoice with a guessed amount is worse than none.
 */
export async function fetchInvoiceQuotes(month: number, year: number): Promise<Map<string, PlatformInvoiceQuote> | null> {
  const { data, error } = await supabase.rpc('platform_invoice_quotes', { p_month: month, p_year: year });
  if (error) return null;
  return parseInvoiceQuotes(data);
}

/**
 * Every active subscription, for the month's invoice generation. A page would
 * not do: generating from the first 100 would skip customers silently, which is
 * the defect 3.13b fixed in `manage-users/list`. Null means the list could not
 * be read whole, and the caller must not generate from a partial one.
 */
export function fetchAllActiveSubscriptions(): Promise<PlatformSubscriptionRow[] | null> {
  return collectAllPages<PlatformSubscriptionRow, PlatformSubscriptionSummary>(pageIndex =>
    fetchSubscriptions({ companyId: null, status: 'active', pageIndex }));
}

/**
 * The companies that already have an invoice for one period, so generation can
 * skip them. Null means the check could not be read — the caller then proceeds
 * and lets the UNIQUE (company_id, invoice_month, invoice_year) decide, which is
 * what the direct query did when it failed: it returned nothing and the insert
 * was refused with 23505.
 */
export async function fetchInvoicedCompanyIds(month: number, year: number): Promise<Set<string> | null> {
  const rows = await collectAllPages<PlatformInvoiceRow, PlatformInvoiceSummary>(pageIndex =>
    fetchInvoices({ companyId: null, month, year, status: 'all', search: '', pageIndex }))
    .catch(() => null);
  return rows === null ? null : new Set(rows.map(row => row.company_id));
}
