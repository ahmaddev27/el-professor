import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
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
   * `platform_plans_list`, the plan catalogue the Tarife tab reads since
   * 20261026120000. A function so one case can make it refuse: the page's own
   * job is invoices, and a catalogue it cannot read must cost it the Tarife
   * tab and nothing else.
   */
  plansRpc: vi.fn(),
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
    // Dispatched by name so the catalogue can be made to refuse without
    // changing what every other direct rpc call on this page answers.
    rpc: async (name: string) =>
      (name === 'platform_plans_list' ? world.plansRpc() : { data: null, error: null }),
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

/**
 * Inside a router, because the page always is.
 *
 * It is registered under `AdminLayout` inside `BrowserRouter` (App.tsx), and
 * since 20261026120000 its Tarife tab carries a `<Link>` to the plan screen —
 * `react-router`'s `useHref` raises outside a `Router`, which killed the whole
 * tree and made all nine cases here fail against an empty string, including
 * the three that have nothing to do with plans.
 *
 * Wrapping is the honest fix rather than dropping the `<Link>`: a bare `<a>`
 * would reload the SPA and throw away the operator's session state, and a test
 * that renders this page outside a router measures an environment the product
 * never has. What wrapping must NOT be allowed to hide is a failing read, so
 * `platform_plans_list` is stubbed below and the catalogue's own containment is
 * asserted by a case of its own rather than left to the absence of a crash.
 */
async function render(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(MemoryRouter, null, createElement(SubscriptionBillingPage)));
  });
  // The two loads and the company picker settle in their own microtasks.
  await act(async () => { await Promise.resolve(); });
  return tree;
}

/**
 * Clicks the Tarife tab. The three tab panels are mounted one at a time, so the
 * catalogue's own states — the failure sentence and the plan cards — are not in
 * the tree until the tab is selected, and an assertion made without this would
 * pass for the wrong reason whatever the catalogue did.
 *
 * `t` answers its key here, so the button is found by the label key itself.
 */
async function selectPlansTab(tree: ReactTestRenderer): Promise<void> {
  // The strings under a node, never JSON.stringify of its props: React's
  // children carry a provider whose `_context.Provider` closes a circle, and
  // stringifying them throws "Converting circular structure to JSON".
  const strings = (node: unknown): string[] => {
    const out: string[] = [];
    const walk = (n: unknown): void => {
      if (typeof n === 'string') { out.push(n); return; }
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n && typeof n === 'object' && 'children' in (n as object)) {
        walk((n as { children: unknown }).children);
      }
    };
    walk(node);
    return out;
  };

  const button = tree.root.findAll(node => node.type === 'button')
    .find(node => strings(node.children).some(s => s.includes('sa.subs.tab.plans')));
  if (!button) throw new Error('the Tarife tab button is not on the page');
  await act(async () => { (button.props as { onClick: () => void }).onClick(); });
}

const okInvoices = (items: unknown[], total = items.length, over = {}) =>
  ({ ok: true as const, total, limit: 100, offset: 0, items, summary: summary(over) });
/** The three seeded plans, in the shape `platform_plans_list` answers. */
const okCatalogue = () => ({
  ok: true as const,
  version: 1,
  fixed_slugs: ['advanced', 'basic', 'premium'],
  feature_keys: ['abrechnung', 'bargeldbestand', 'belege', 'benachrichtigungen', 'dokumente',
    'fahrer', 'fahrzeuge', 'fixkosten', 'gehaelter', 'notizen', 'overview', 'rollen_nutzer',
    'stundennachweis', 'trinkgeld_quittung', 'umsaetze', 'werkstatt'],
  plans: [
    { slug: 'basic', name: 'Basic', rank: 0, price_per_car_cents: 2000, is_active: true,
      features: ['bargeldbestand', 'belege', 'fahrer', 'fahrzeuge', 'fixkosten', 'overview', 'umsaetze'] },
    { slug: 'advanced', name: 'Advanced', rank: 1, price_per_car_cents: 4000, is_active: true,
      features: ['abrechnung', 'bargeldbestand', 'belege', 'benachrichtigungen', 'fahrer', 'fahrzeuge',
        'fixkosten', 'notizen', 'overview', 'rollen_nutzer', 'umsaetze', 'werkstatt'] },
    { slug: 'premium', name: 'Premium', rank: 2, price_per_car_cents: 7000, is_active: true,
      features: ['abrechnung', 'bargeldbestand', 'belege', 'benachrichtigungen', 'dokumente', 'fahrer',
        'fahrzeuge', 'fixkosten', 'gehaelter', 'notizen', 'overview', 'rollen_nutzer',
        'stundennachweis', 'trinkgeld_quittung', 'umsaetze', 'werkstatt'] },
  ],
});

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
  world.plansRpc.mockReset().mockResolvedValue({ data: okCatalogue(), error: null });
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

  /*
    20261026120000. The Tarife tab reads the plan catalogue, which is a
    different read from the two this page exists for. Its failure must cost the
    Tarife tab and nothing else.

    Both directions are asserted, because only the pair is a containment claim:
    a refused catalogue must leave every invoice figure on screen, AND it must
    not be shown as an empty catalogue — `parseCatalogue` throws rather than
    answering `[]` precisely because "no plan exists" is a claim, and the page
    turns that throw into its own `catalogueFailed` state.

    Mutation control, MEASURED rather than assumed — and the first version of
    this comment was wrong about it, which is why it is spelled out. Deleting
    the `.catch` on `listPlans()` in SubscriptionBillingPage does NOT blank the
    page: `.then(setCatalogue)` with no catch leaves a rejected promise and the
    render goes on. What it does is leak an unhandled rejection, so the mutant
    is killed twice over — by `selectPlansTab` below finding no failure
    sentence (the state is never set), and by the run exiting 1 with
    "Vitest caught 2 unhandled errors during the test run /
    Error: platform_plans_list refused: unreadable at parseCatalogue".

    So the real hazard the page had was never the read. It was a `<Link>`
    rendered outside a `Router`, which DID blank it — see `render` above.
  */
  it('keeps every invoice figure when the plan catalogue cannot be read, and says so on its own tab', async () => {
    world.plansRpc.mockResolvedValue({ data: { ok: false, reason: 'unreadable' }, error: null });
    const tree = await render();

    // The page this screen exists for is untouched.
    expect(text(tree)).toContain('INV-2026-0007');
    expect(text(tree)).toContain('Taxi Nord GmbH');

    // And the Tarife tab states the failure instead of showing an empty
    // catalogue, which would read as "this platform sells no plans".
    await selectPlansTab(tree);
    expect(text(tree)).toContain('admin.read.failed');
    expect(text(tree)).not.toContain('Premium');
  });

  it('shows the three plans on its own tab when the catalogue reads', async () => {
    const tree = await render();
    await selectPlansTab(tree);
    const shown = text(tree);
    expect(shown).toContain('Basic');
    expect(shown).toContain('Advanced');
    expect(shown).toContain('Premium');
    expect(shown).not.toContain('admin.read.failed');
  });

  it('reads the catalogue through platform_plans_list, once, and survives a transport error', async () => {
    await render();
    expect(world.plansRpc).toHaveBeenCalledTimes(1);

    world.plansRpc.mockRejectedValue(new Error('network'));
    const shown = text(await render());
    expect(shown).toContain('INV-2026-0007');
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
