import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The billing screen, rendered.
 *
 * Decision D14 (24.09.2026, migration 20260924110000) moved this page from
 * "load every invoice of every customer and filter in the browser" to two
 * audited read models that page on the server and bring their figures with them.
 * There is no design harness for the platform panel — `design-harness/` fakes
 * the tenant shell and the signed-out screens, and nothing in it renders
 * AdminLayout — so this is the check that the screen comes up at all, and it
 * renders for real the way `SuperAdminContext.test.ts` renders its provider.
 *
 * What it is for, in order of what would actually have shipped broken:
 *
 *   1. The refusal. `support` and `read_only` lose this page, and what they must
 *      see is the sentence and not an empty table: an invoice list of zero rows
 *      and a total of 0,00 € are claims about a customer.
 *   2. A read that failed. Same rule, one state further on — the figures are
 *      withheld rather than shown as zeroes.
 *   3. The figures. They come from the summary the database computes now, not
 *      from summing the rows on screen, so a row count and a figure can no
 *      longer agree by accident.
 *   4. The flat columns. The invoice table used to read
 *      `inv.companies?.name` and `inv.company_subscriptions?.subscription_plans?.name`
 *      through PostgREST's embedded selects; the read model answers
 *      `company_name` and `plan_name`. A missed one renders as an id fragment or
 *      a dash, which looks like data rather than like a defect.
 *   5. The pager, which only appears when the server says there is a next page.
 */

const world = vi.hoisted(() => ({
  platformCan: vi.fn((_capability: string) => true),
  fetchInvoices: vi.fn(),
  fetchSubscriptions: vi.fn(),
  fetchCompanies: vi.fn(),
  showToast: vi.fn(),
  /**
   * One `t`, not a new one per render, and that is not a convenience: the page's
   * `loadData` is a useCallback over `[query, subscriptionPage, showToast, t]`,
   * and the effect that calls it depends on `loadData`. A `t` with a fresh
   * identity each render makes that effect fire on every render, which loads,
   * which renders — the first version of this file hung for that reason. The
   * real `LanguageContext` memoises its value, so this mock matches it.
   */
  translation: {
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}(${JSON.stringify(vars)})` : key),
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  },
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ order: async () => ({ data: [{ id: 'p1', name: 'Advanced', monthly_price: 49, included_cars: 5, max_cars: null, features: [], is_active: true }] }) }) }),
    rpc: async () => ({ data: null, error: null }),
  },
}));
vi.mock('../lib/platformRpc', () => ({ callPlatformRpc: vi.fn(), PlatformRpcError: class extends Error {} }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ isSuperAdmin: true, user: { id: 'staff-1' }, profile: null }) }));
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ platformCan: world.platformCan }) }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: world.showToast }) }));
// `t` returns its key, so an assertion can name the sentence the screen shows.
vi.mock('../contexts/LanguageContext', () => ({ useTranslation: () => world.translation }));
vi.mock('../lib/platformBillingClient', () => ({
  fetchInvoices: world.fetchInvoices,
  fetchSubscriptions: world.fetchSubscriptions,
  fetchAllActiveSubscriptions: async () => [],
  fetchInvoicedCompanyIds: async () => new Set<string>(),
}));
vi.mock('../lib/platformDirectoryClient', () => ({ fetchCompanies: world.fetchCompanies }));
vi.mock('../lib/platformSettingsClient', () => ({ getInvoiceSeller: async () => null }));
// jspdf never has to load for the screen to be rendered.
vi.mock('../utils/subscriptionPdf', () => ({ generateSubscriptionPdf: vi.fn() }));

const eventTarget = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
Object.assign(globalThis, { window: eventTarget(), document: { ...eventTarget(), visibilityState: 'visible' } });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: SubscriptionBillingPage } = await import('./SubscriptionBillingPage');

const invoiceRow = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  company_id: 'cafe0000-0000-4000-8000-000000000001',
  company_name: 'Taxi Nord GmbH',
  company_address: 'Hauptstr. 7',
  company_postal_code: '20095',
  company_city: 'Hamburg',
  plan_name: 'Advanced',
  invoice_month: 9,
  invoice_year: 2026,
  invoice_number: 'INV-2026-0007',
  amount: 49,
  status: 'open',
  due_date: '2026-09-30',
  paid_at: null,
  cash_received_amount: null,
  receipt_note: null,
  created_at: '2026-09-01T10:00:00Z',
  ...over,
});

const summary = (over: Record<string, unknown> = {}) => ({
  openCount: 4,
  overdueCount: 2,
  paidThisMonthCount: 1,
  filteredAmount: 196,
  filteredCollected: 98,
  years: [2026, 2025],
  ...over,
});

/** Every string the rendered tree prints, flattened. */
function text(tree: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
  };
  walk(tree.toJSON());
  return out.join(' | ');
}

async function render(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(createElement(SubscriptionBillingPage)); });
  // The two loads and the company picker settle in their own microtasks.
  await act(async () => { await Promise.resolve(); });
  return tree;
}

const okInvoices = (items: unknown[], total = items.length, over = {}) =>
  ({ ok: true as const, total, limit: 100, offset: 0, items, summary: summary(over) });
const okSubscriptions = (items: unknown[], total = items.length) =>
  ({ ok: true as const, total, limit: 100, offset: 0, items, summary: { activeCount: 3, activeByPlan: { p1: 2 } } });

beforeEach(() => {
  world.platformCan.mockReset().mockImplementation(() => true);
  world.fetchInvoices.mockReset().mockResolvedValue(okInvoices([invoiceRow()]));
  world.fetchSubscriptions.mockReset().mockResolvedValue(okSubscriptions([{
    id: 's1', company_id: 'c1', company_name: 'Taxi Nord GmbH', plan_id: 'p1',
    plan_name: 'Advanced', status: 'active', starts_at: '2026-01-01', billing_day: 5, monthly_price: 49,
  }]));
  world.fetchCompanies.mockReset().mockResolvedValue({ ok: true, total: 1, limit: 100, offset: 0, items: [{ id: 'c1', name: 'Taxi Nord GmbH' }] });
  world.showToast.mockReset();
});

describe('SubscriptionBillingPage', () => {
  it('shows a role without billing.manage why, and reads nothing', async () => {
    world.platformCan.mockImplementation((capability: string) => capability !== 'billing.manage');
    const tree = await render();

    expect(text(tree)).toContain('admin.read.denied');
    expect(text(tree)).toContain('sa.subs.noAccessBody');
    // An empty invoice table would be a claim about every customer.
    expect(text(tree)).not.toContain('sa.subs.noInvoices');
    expect(world.fetchInvoices).not.toHaveBeenCalled();
    expect(world.fetchSubscriptions).not.toHaveBeenCalled();
    // The company picker is an audited read too, and it is not made either.
    expect(world.fetchCompanies).not.toHaveBeenCalled();
  });

  it('renders the invoice table from the read model’s flat columns', async () => {
    const tree = await render();
    const shown = text(tree);

    expect(shown).toContain('Taxi Nord GmbH');
    // plan_name, not company_subscriptions.subscription_plans.name
    expect(shown).toContain('Advanced');
    expect(shown).toContain('INV-2026-0007');
    // An id fragment is the fallback for a row whose company_name is null; a
    // missed rename would print it for every row.
    expect(shown).not.toContain('cafe0000');
    expect(shown).not.toContain('sa.subs.noInvoices');
  });

  it('prints the six figures the database computed, not a sum of the page', async () => {
    // One row on screen, four open invoices in the set: the two can only differ
    // if the figures come from the summary.
    world.fetchInvoices.mockResolvedValue(okInvoices([invoiceRow()], 137));
    const shown = text(await render());

    expect(shown).toContain('sa.subs.kpi.openInvoices');
    expect(shown).toContain('4');
    expect(shown).toContain('2');
    expect(shown).toContain('196,00 €');
    expect(shown).toContain('98,00 €');
    // activeCount comes from the subscriptions summary, not from the page.
    expect(shown).toContain('3');
  });

  it('withholds every figure when the read was refused, and says so', async () => {
    world.fetchInvoices.mockResolvedValue({ ok: false, reason: 'not_authorized' });
    const shown = text(await render());

    expect(shown).toContain('admin.read.denied');
    // No KPI label is rendered at all: a zero beside "Offene Rechnungen" would
    // claim the customer owes nothing.
    expect(shown).not.toContain('sa.subs.kpi.openInvoices');
    expect(shown).not.toContain('196,00 €');
  });

  it('withholds them for a failure it does not recognise too', async () => {
    world.fetchSubscriptions.mockResolvedValue({ ok: false, reason: 'malformed' });
    const shown = text(await render());

    expect(shown).toContain('admin.read.failed');
    expect(shown).not.toContain('sa.subs.kpi.openInvoices');
  });

  it('reports a thrown read as a failure rather than as an empty screen', async () => {
    world.fetchInvoices.mockRejectedValue(new Error('offline'));
    const shown = text(await render());

    expect(shown).toContain('admin.read.failed');
    expect(world.showToast).toHaveBeenCalledWith('error', 'sa.subs.errorLoad');
  });

  it('offers a pager only when the server has a next page', async () => {
    const one = text(await render());
    expect(one).not.toContain('admin.common.next');

    world.fetchInvoices.mockResolvedValue(okInvoices([invoiceRow()], 250));
    const many = text(await render());
    expect(many).toContain('admin.common.prev');
    expect(many).toContain('admin.common.next');
    // 250 rows at 100 a page: three pages, and the label says so.
    expect(many).toContain('admin.common.pageOf({"page":1,"pages":3})');
  });

  it('asks the invoice list for the picker’s month and year, and page one', async () => {
    await render();
    const args = world.fetchInvoices.mock.calls[0][0];
    expect(args.pageIndex).toBe(0);
    expect(args.status).toBe('all');
    expect(args.companyId).toBeNull();
    expect(args.month).toBeGreaterThanOrEqual(1);
    expect(args.month).toBeLessThanOrEqual(12);
  });
});
