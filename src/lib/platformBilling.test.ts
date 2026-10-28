import { describe, expect, it, vi } from 'vitest';
import {
  BILLING_PAGE_SIZE,
  EMPTY_INVOICE_SUMMARY,
  EMPTY_SUBSCRIPTION_SUMMARY,
  collectAllPages,
  invoiceCompanyAddress,
  invoiceRpcArgs,
  parseBillingPage,
  parseInvoiceQuotes,
  parseInvoiceRow,
  parseInvoiceSummary,
  parseSubscriptionRow,
  parseSubscriptionSummary,
  subscriptionRpcArgs,
  type PlatformInvoiceRow,
  type PlatformInvoiceSummary,
} from './platformBilling';

/** The seventeen keys migration 20260924110000 documents, and nothing else. */
const INVOICE_KEYS = [
  'id', 'company_id', 'company_name', 'company_address',
  'company_postal_code', 'company_city', 'plan_name', 'invoice_month', 'invoice_year',
  'invoice_number', 'amount', 'status', 'due_date', 'paid_at', 'cash_received_amount',
  'receipt_note', 'created_at',
];

const SUBSCRIPTION_KEYS = [
  'id', 'company_id', 'company_name', 'plan_id', 'plan_name', 'status',
  'starts_at', 'billing_day', 'monthly_price',
];

const rawInvoice = {
  id: 'i1', company_id: 'c1', company_name: 'Taxi Nord',
  company_address: 'Hauptstr. 7',
  company_postal_code: '20095', company_city: 'Hamburg',
  plan_name: 'Advanced', invoice_month: 9, invoice_year: 2026,
  invoice_number: 'INV-2026-0007', amount: 49, status: 'open',
  due_date: '2026-09-30', paid_at: null, cash_received_amount: null,
  receipt_note: null, created_at: '2026-09-01T10:00:00Z',
};

describe('parseInvoiceRow', () => {
  it('reads exactly the documented columns', () => {
    const row = parseInvoiceRow(rawInvoice);
    expect(Object.keys(row).sort()).toEqual([...INVOICE_KEYS].sort());
    expect(row.amount).toBe(49);
    expect(row.company_city).toBe('Hamburg');
  });

  it('carries no account id even when the database sends one', () => {
    // paid_by and collected_by are deliberately not in the read model. If a
    // later migration widened it, the row type must be widened on purpose.
    const row = parseInvoiceRow({ ...rawInvoice, paid_by: 'u1', collected_by: 'u2' }) as unknown as Record<string, unknown>;
    expect(row.paid_by).toBeUndefined();
    expect(row.collected_by).toBeUndefined();
  });

  it('keeps a cash amount of zero distinct from none', () => {
    expect(parseInvoiceRow({ ...rawInvoice, cash_received_amount: 0 }).cash_received_amount).toBe(0);
    expect(parseInvoiceRow(rawInvoice).cash_received_amount).toBeNull();
  });

  it('never produces NaN for a money figure', () => {
    const row = parseInvoiceRow({ ...rawInvoice, amount: 'viel' });
    expect(row.amount).toBe(0);
    expect(Number.isNaN(row.amount)).toBe(false);
  });
});

describe('invoiceCompanyAddress', () => {
  /**
   * The read model carries `companies.address`, `postal_code` and `city`. The
   * screen it replaced asked PostgREST for `street` and `house_number`, which
   * are columns of `company_settings`: the query was answered 42703 and the
   * invoice list was always empty. Migration 20260924110000's header records it.
   */
  const NEWLINE = String.fromCharCode(10);

  it('prints the street line above the postal code and the town', () => {
    expect(invoiceCompanyAddress(parseInvoiceRow(rawInvoice)))
      .toBe(`Hauptstr. 7${NEWLINE}20095 Hamburg`);
  });

  it('leaves out a line the company has not filled in', () => {
    expect(invoiceCompanyAddress({
      company_address: 'Hauptstr. 7', company_postal_code: null, company_city: null,
    })).toBe('Hauptstr. 7');
    expect(invoiceCompanyAddress({
      company_address: null, company_postal_code: '20095', company_city: 'Hamburg',
    })).toBe('20095 Hamburg');
    expect(invoiceCompanyAddress({
      company_address: null, company_postal_code: null, company_city: 'Hamburg',
    })).toBe('Hamburg');
  });

  it('is null when the company has no address at all, so nothing is printed', () => {
    // The PDF's companyAddress is nullable for exactly this: an empty line
    // under the recipient's name reads as a missing address, not as none.
    expect(invoiceCompanyAddress({
      company_address: null, company_postal_code: null, company_city: null,
    })).toBeNull();
    expect(invoiceCompanyAddress({
      company_address: '  ', company_postal_code: '', company_city: '   ',
    })).toBeNull();
  });
});

describe('parseSubscriptionRow', () => {
  it('reads exactly the documented columns and no notes', () => {
    const row = parseSubscriptionRow({
      id: 's1', company_id: 'c1', company_name: 'Taxi Nord', plan_id: 'p1',
      plan_name: 'Advanced', status: 'active', starts_at: '2026-01-01',
      billing_day: 5, monthly_price: 49, notes: 'zahlt bar, Chef ist krank',
    }) as unknown as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([...SUBSCRIPTION_KEYS].sort());
    expect(row.notes).toBeUndefined();
  });
});

describe('parseInvoiceSummary', () => {
  it('reads the six figures and sorts the years newest first', () => {
    const summary = parseInvoiceSummary({
      open_count: 4, overdue_count: 2, paid_this_month_count: 1,
      filtered_amount: 196, filtered_collected: 98, years: [2024, 2026, 2025],
    });
    expect(summary).toEqual({
      openCount: 4, overdueCount: 2, paidThisMonthCount: 1,
      filteredAmount: 196, filteredCollected: 98, years: [2026, 2025, 2024],
    });
  });

  it('is all zeroes for an answer it cannot read', () => {
    expect(parseInvoiceSummary(null)).toEqual(EMPTY_INVOICE_SUMMARY);
    expect(parseInvoiceSummary('kaputt')).toEqual(EMPTY_INVOICE_SUMMARY);
    expect(parseInvoiceSummary({ years: 'nein' }).years).toEqual([]);
  });
});

describe('parseSubscriptionSummary', () => {
  it('reads the active count and the per-plan counts', () => {
    expect(parseSubscriptionSummary({ active_count: 3, active_by_plan: { p1: 2, p2: 1 } }))
      .toEqual({ activeCount: 3, activeByPlan: { p1: 2, p2: 1 } });
  });

  it('drops a per-plan entry it cannot read rather than showing it as zero', () => {
    const summary = parseSubscriptionSummary({ active_count: 1, active_by_plan: { p1: 'zwei' } });
    expect(summary.activeByPlan).toEqual({});
  });

  it('is empty for an answer it cannot read', () => {
    expect(parseSubscriptionSummary(undefined)).toEqual(EMPTY_SUBSCRIPTION_SUMMARY);
  });
});

describe('parseBillingPage', () => {
  it('reads a page and its summary', () => {
    const page = parseBillingPage(
      { ok: true, total: 1, limit: 100, offset: 0, items: [rawInvoice], summary: { open_count: 1 } },
      parseInvoiceRow, parseInvoiceSummary);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.items).toHaveLength(1);
    expect(page.summary.openCount).toBe(1);
  });

  it('keeps a refusal as a value, with its reason', () => {
    // The function wrote a `denied` audit row and returned; an exception here
    // would lose the distinction between "may not" and "did not work".
    const page = parseBillingPage({ ok: false, reason: 'not_authorized' }, parseInvoiceRow, parseInvoiceSummary);
    expect(page).toEqual({ ok: false, reason: 'not_authorized' });
  });

  it('treats an answer it does not recognise as a refusal, never as an empty list', () => {
    expect(parseBillingPage('nope', parseInvoiceRow, parseInvoiceSummary)).toEqual({ ok: false, reason: 'malformed' });
    expect(parseBillingPage({ ok: true, total: 0 }, parseInvoiceRow, parseInvoiceSummary))
      .toEqual({ ok: false, reason: 'malformed' });
  });

  it('answers an empty summary when the page carries none', () => {
    const page = parseBillingPage({ ok: true, total: 0, items: [] }, parseInvoiceRow, parseInvoiceSummary);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.summary).toEqual(EMPTY_INVOICE_SUMMARY);
  });
});

describe('invoiceRpcArgs', () => {
  it('sends "every month" and "every status" as NULL, not as 0 and "all"', () => {
    // app_private.platform_read_token refuses '' and platform_invoices_list
    // raises 22023 for a month outside 1..12, both before anything is read.
    expect(invoiceRpcArgs({ companyId: null, month: 0, year: 2026, status: 'all', search: '', pageIndex: 0 }))
      .toEqual({
        p_company_id: null, p_month: null, p_year: 2026, p_status: null,
        p_search: null, p_limit: BILLING_PAGE_SIZE, p_offset: 0,
      });
  });

  it('passes a real filter through and caps the offset', () => {
    expect(invoiceRpcArgs({ companyId: 'c1', month: 9, year: 2026, status: 'paid', search: ' Nord ', pageIndex: 2 }))
      .toEqual({
        p_company_id: 'c1', p_month: 9, p_year: 2026, p_status: 'paid',
        p_search: 'Nord', p_limit: BILLING_PAGE_SIZE, p_offset: 200,
      });
    expect(invoiceRpcArgs({ companyId: null, month: 0, year: 2026, status: 'all', search: '', pageIndex: 5000 }).p_offset)
      .toBe(10_000);
  });

  it('sends no year when the picker has none', () => {
    expect(invoiceRpcArgs({ companyId: null, month: 0, year: 0, status: 'all', search: '', pageIndex: 0 }).p_year)
      .toBeNull();
  });
});

describe('subscriptionRpcArgs', () => {
  it('maps the status filter and the page', () => {
    expect(subscriptionRpcArgs({ companyId: null, status: 'active', pageIndex: 1 }))
      .toEqual({ p_company_id: null, p_status: 'active', p_limit: BILLING_PAGE_SIZE, p_offset: 100 });
    expect(subscriptionRpcArgs({ companyId: null, status: 'all', pageIndex: 0 }).p_status).toBeNull();
  });
});

describe('collectAllPages', () => {
  const page = (items: PlatformInvoiceRow[], total: number) =>
    ({ ok: true as const, total, limit: 2, offset: 0, items, summary: EMPTY_INVOICE_SUMMARY });
  const row = (id: string) => parseInvoiceRow({ ...rawInvoice, id });

  it('reads every page, not only the first', async () => {
    // The defect 3.13b fixed in manage-users/list: one page, a 200, and a short
    // answer that looks like the whole list.
    const fetchPage = vi.fn(async (i: number) =>
      i === 0 ? page([row('a'), row('b')], 3) : page([row('c')], 3));
    const rows = await collectAllPages<PlatformInvoiceRow, PlatformInvoiceSummary>(fetchPage);
    expect(rows?.map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('stops after one page when the total is covered', async () => {
    const fetchPage = vi.fn(async () => page([row('a')], 1));
    await collectAllPages<PlatformInvoiceRow, PlatformInvoiceSummary>(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('answers null on a refusal rather than a partial list', async () => {
    expect(await collectAllPages(async () => ({ ok: false as const, reason: 'not_authorized' }))).toBeNull();
  });

  it('answers null when a page throws', async () => {
    expect(await collectAllPages(async () => { throw new Error('offline'); })).toBeNull();
  });

  it('answers null when a page comes back empty while more is promised', async () => {
    const fetchPage = vi.fn(async (i: number) =>
      i === 0 ? page([row('a')], 9) : page([], 9));
    expect(await collectAllPages<PlatformInvoiceRow, PlatformInvoiceSummary>(fetchPage)).toBeNull();
  });
});

describe('parseInvoiceQuotes', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    subscription_id: 's1', company_id: 'c1', company_name: 'Taxi Nord', plan: 'premium',
    // `car_limit` is still in the answer and is still the stored allowance;
    // `active_cars` is the quantity the amount is computed from since
    // 20261026110000. The figures are the one production company's where the
    // two agree — a stored allowance of 5 against a fleet of 5 — which is why
    // the fixture carries them. (`company_name` is inert here: the parser
    // never reads it, so the value is a placeholder like the rest of the file's.)
    car_limit: 5, active_cars: 5, billing_cycle: 'monthly', first_invoice: true,
    amount_cents: 20000, ...over,
  });

  it('reads each item by subscription id, in integer cents', () => {
    const quotes = parseInvoiceQuotes({ ok: true, items: [item(), item({ subscription_id: 's2', company_id: 'c2', first_invoice: false, amount_cents: 35000 })] });
    expect(quotes?.get('s1')).toEqual({ subscriptionId: 's1', companyId: 'c1', firstInvoice: true, amountCents: 20000, activeCars: 5 });
    expect(quotes?.get('s2')).toEqual({ subscriptionId: 's2', companyId: 'c2', firstInvoice: false, amountCents: 35000, activeCars: 5 });
  });

  it('carries the fleet the amount was priced on, and a count of none as 0', () => {
    expect(parseInvoiceQuotes({ ok: true, items: [item({ active_cars: 0, amount_cents: 7000 })] })?.get('s1')?.activeCars).toBe(0);
    expect(parseInvoiceQuotes({ ok: true, items: [item({ active_cars: 2, amount_cents: 8000 })] })?.get('s1')?.activeCars).toBe(2);
  });

  /*
    The fleet count is informational and the amount beside it is already
    validated, so an answer without a usable count still bills. Refusing here
    would return null, which the caller reads as "nothing to raise" — a
    generation run that creates nothing and says nothing. That trade is wrong
    for a field no invoice is computed from in the browser, and this is the
    assertion that keeps it wrong-proof: `null` means unknown, never 0.
  */
  it('an absent or unusable fleet count is unknown, and never refuses the batch', () => {
    for (const active_cars of [undefined, null, -1, 2.5, '2', {}]) {
      const quotes = parseInvoiceQuotes({ ok: true, items: [item({ active_cars })] });
      expect([active_cars, quotes?.size]).toEqual([active_cars, 1]);
      expect([active_cars, quotes?.get('s1')?.activeCars]).toEqual([active_cars, null]);
      expect([active_cars, quotes?.get('s1')?.amountCents]).toEqual([active_cars, 20000]);
    }
  });

  it('is null, never an empty map, for a refusal or a shape it does not know', () => {
    expect(parseInvoiceQuotes({ ok: false, reason: 'not_authorized' })).toBeNull();
    expect(parseInvoiceQuotes({ ok: true })).toBeNull();
    expect(parseInvoiceQuotes(null)).toBeNull();
  });

  it('refuses the whole answer when one amount could not become an invoice', () => {
    for (const amount_cents of [350.5, -1, '35000', null, undefined]) {
      expect(parseInvoiceQuotes({ ok: true, items: [item(), item({ subscription_id: 's2', amount_cents })] })).toBeNull();
    }
    expect(parseInvoiceQuotes({ ok: true, items: [item({ first_invoice: 'yes' })] })).toBeNull();
  });

  it('an empty list of items is a valid, empty answer', () => {
    expect(parseInvoiceQuotes({ ok: true, items: [] })?.size).toBe(0);
  });
});
