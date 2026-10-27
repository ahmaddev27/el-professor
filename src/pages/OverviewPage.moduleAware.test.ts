/**
 * The Overview, rendered, with a module switched off.
 *
 * **Why this file exists in the shape it does.** The first version of the
 * coverage check beside it (`src/utils/overviewModuleScope.test.ts`) claimed in
 * its own header that this was impossible — *"there is no renderer to mount
 * `OverviewPage` in"* — on the strength of `vitest.config.ts` saying
 * `environment: 'node'` and no `@testing-library/react` in the manifest. **That
 * was wrong.** Nine screens already render with `react-test-renderer` and
 * `src/test-utils/tree.ts` (`*.writeRefusal.test.ts`), which needs no DOM. The
 * claim was made from the absence of one library rather than from a search for
 * the pattern, and it is corrected here rather than in a comment, because the
 * answer to "can this be rendered" is a test that renders it.
 *
 * So the two files split this way, and it is the split the project already uses:
 *
 *   - **here**: what the user sees and what the network sees, behaviourally —
 *     no request is issued, the reason appears in words, and **no zero** appears
 *     in a withheld figure's place;
 *   - **`overviewModuleScope.test.ts`**: coverage over the panel list, which a
 *     renderer answers badly — "no panel in the map is unguarded" is a claim
 *     about 20 declarations, not about one render.
 *
 * `fmt()` renders a euro figure with a decimal comma (`0,00`), so "no zero
 * appears" is checkable as text and is the assertion that matters most: it is
 * the difference between a withheld figure and a false statement about a
 * customer's money.
 */
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settle, textOf } from '../test-utils/tree';
import type { FakeCall } from '../test-utils/fakeSupabase';

/** `module_key -> enabled`, rewritten per test before the mount. */
const world = vi.hoisted(() => ({
  modules: {} as Record<string, boolean>,
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
  /** Keys come back as themselves, so an assertion names the key it means. */
  translation: {
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}(${JSON.stringify(vars)})` : key),
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  },
}));

/*
  One income row, one salary, one fixed cost, one receipt, one check, one car —
  enough that every panel has a real figure to print when its module is on, so
  "no figure appears" means withheld rather than empty.
*/
const INCOME = { id: 'i1', date: '2026-10-05', type: 'umsatz', amount: 1000, driver_id: 'd1' };
/*
  A cash row as well, and it is load-bearing for the "no zero" assertions
  rather than decoration. Without it the Bargeld KPI legitimately prints
  `0,00 EUR` - the company really took no cash - and a blanket scan for that
  string then fails on a figure that is **correct**. Which is the measurement
  lesson in miniature: a zero is only a claim when its source was withheld, so
  the fixture has to leave no honest zero for the scan to trip over.
*/
const CASH_INCOME = { id: 'i2', date: '2026-10-05', type: 'bargeld', amount: 300, driver_id: 'd1' };
const SALARY = {
  id: 's1', driver_id: 'd1', period_start: '2026-10-01', period_end: '2026-10-31',
  amount_due: 400, amount_paid: 0, status: 'unpaid', netto_salary: null,
};
const FIXED_COST = { id: 'f1', description: 'Miete', amount: 250, period_month: null, created_at: '2026-10-01' };
const CHECK = { id: 'w1', car_id: 'c1', status: 'negative', check_date: '2026-10-05', notes: 'Bremsen', car: { kennzeichen: 'HH-AB-1' } };
const CAR = { id: 'c1', kennzeichen: 'HH-AB-1', tuev_gueltig_bis: '2026-11-01' };
const RECEIPT = { id: 'r1', date: '2026-10-05', expense: 60, description: 'Tanken', driverName: 'D', receiptNumber: 'BEL-1' };
const DRIVER = { id: 'd1', name: 'D', salary_ratio: 0.4, status: 'active' };

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    const rows: Record<string, unknown[]> = {
      income: [INCOME, CASH_INCOME],
      salaries: [SALARY],
      fixed_costs: [FIXED_COST],
      werkstatt_checks: [CHECK],
      cars: [CAR],
      user_profiles: [],
      cash_movements: [],
    };
    return { data: rows[call.table] ?? [], error: null };
  });
  return { supabase: world.fake.client };
});

vi.mock('../contexts/PlanContext', () => ({
  usePlan: () => ({
    planState: { plan: 'premium', status: 'active', isActive: true, carLimit: 10, billingCycle: 'monthly' },
    loading: false,
    effectivePlan: 'premium',
    companyModules: world.modules,
    can: () => true,
    minPlanFor: () => 'basic',
  }),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' }, profile: null, isSuperAdmin: false, companyId: 'company-1' }),
}));
vi.mock('../contexts/SuperAdminContext', () => ({
  useSuperAdmin: () => ({
    effectiveCompanyId: 'company-1',
    isSuperAdmin: false,
    platformReadsCompanyData: false,
    ownCompanyReadable: true,
  }),
}));
vi.mock('../contexts/LanguageContext', () => ({ useTranslation: () => world.translation }));
vi.mock('../hooks/useDatabase', () => ({
  useDatabase: () => ({
    isLoading: false,
    isConnected: true,
    receipts: { get: async () => [RECEIPT] },
    drivers: { get: async () => [DRIVER] },
  }),
}));
// The import prompt asks for its own two counts and renders a Link; neither is
// this slice's business and both need a router.
vi.mock('../components/partner/FleetImportPrompt', () => ({ FleetImportPrompt: () => null }));
// `Link` only has to render; nothing here presses one.
vi.mock('react-router-dom', () => ({
  Link: ({ children }: { children?: unknown }) => children ?? null,
}));
/*
  Recharts measures its container, which `react-test-renderer` has no layout
  for, so every chart would render an empty box and print nothing either way.
  Stubbed to render its children so the surrounding panel — which is what this
  file reads — is unaffected, and so a chart cannot be mistaken for the reason
  a figure is missing.
*/
vi.mock('recharts', () => {
  const pass = ({ children }: { children?: unknown }) => children ?? null;
  const none = () => null;
  return {
    ResponsiveContainer: pass, AreaChart: pass, Area: none, BarChart: pass, Bar: none,
    PieChart: pass, Pie: none, Cell: none, XAxis: none, YAxis: none,
    CartesianGrid: none, Tooltip: none, Legend: none,
  };
});

const eventTarget = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
Object.assign(globalThis, { window: eventTarget(), document: { ...eventTarget(), visibilityState: 'visible' } });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: OverviewPage } = await import('./OverviewPage');

async function mount(): Promise<ReactTestRenderer> {
  vi.setSystemTime(new Date(2026, 9, 13));
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(createElement(OverviewPage)); });
  await settle(10);
  return tree;
}

/**
 * Every rendered text node on its own, which `textOf` joins with ` | `.
 *
 * Needed because a **substring** scan for `0,00 €` is a broken instrument:
 * `1.000,00 €` ends with it, so the first version of the "no zero" assertions
 * failed on a page whose figures were entirely correct. The claim is "no cell
 * **is** 0,00 €", not "the string appears nowhere", and only the split can say
 * that.
 */
const cells = (tree: ReactTestRenderer): string[] => textOf(tree).split(' | ').map(c => c.trim());

/** The tables the render actually asked PostgREST for. */
const tablesRead = (): string[] =>
  [...new Set((world.fake?.calls ?? []).map(c => c.table))].sort();

beforeEach(() => {
  world.modules = {};
  world.fake?.calls.splice(0);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

describe('every module on: the baseline this is measured against', () => {
  it('reads all five of its own tables and prints real figures', async () => {
    const tree = await mount();
    expect(tablesRead()).toEqual([
      'cars', 'cash_movements', 'fixed_costs', 'income', 'salaries', 'user_profiles', 'werkstatt_checks',
    ]);
    const text = textOf(tree);
    // The figures the next tests must NOT see: revenue, the salary, the costs.
    expect(text).toContain('1.000,00 €');
    expect(text).toContain('400,00 €');
    // And no module-off wording anywhere.
    expect(text).not.toContain('overview.moduleOff');
  });
});

describe('Fixkosten off', () => {
  /*
    The cheapest module to reason about and the one that proves the point: it
    contributes **only a cost**, so with it off every naive implementation keeps
    rendering a profit — a larger one. Nothing here may show a figure for it.
  */
  beforeEach(() => { world.modules = { fixkosten: false }; });

  it('issues no request for fixed_costs, and still reads the other four', async () => {
    await mount();
    expect(tablesRead()).not.toContain('fixed_costs');
    expect(tablesRead()).toEqual([
      'cars', 'cash_movements', 'income', 'salaries', 'user_profiles', 'werkstatt_checks',
    ]);
  });

  it('withholds the cost and profit figures and says which module', async () => {
    const text = textOf(await mount());
    // The reason, naming the module through the same label the sidebar uses.
    expect(text).toContain('overview.moduleOff.short');
    expect(text).toContain('nav.fixkosten');
    // The profit breakdown and the cost list are replaced, not emptied.
    expect(text).toContain('overview.moduleOff.one');
  });

  it('prints NO zero and NO wrong total where the withheld figures were', async () => {
    /*
      The assertion this whole slice exists for. With Fixkosten off the real
      profit of this fixture is 1000 − 400 − 60 = 540 and the cost total 60 —
      both arithmetically fine and both **wrong**, because the 250 € of rent was
      never read. Neither may appear, and neither may a 0,00 €.
    */
    const tree = await mount();
    const text = textOf(tree);
    expect(text).not.toContain('540,00 €');
    expect(text).not.toContain('250,00 €');
    expect(cells(tree)).not.toContain('0,00 €');
    // The em dash is what stands in its place on the KPI cards.
    expect(cells(tree)).toContain('—');
  });

  it('keeps the panels that owe Fixkosten nothing', async () => {
    // Umsatz is income alone, so it still prints. A slice that withheld the
    // whole screen would pass every assertion above and fail this one.
    expect(textOf(await mount())).toContain('1.000,00 €');
  });
});

describe('Gehälter off', () => {
  beforeEach(() => { world.modules = { salaries: false }; });

  it('issues no request for salaries', async () => {
    await mount();
    expect(tablesRead()).not.toContain('salaries');
  });

  it('shows no salary figure, no open-salary table and no zero', async () => {
    const tree = await mount();
    const text = textOf(tree);
    expect(text).not.toContain('400,00 €');
    // `calcSalaryAlerts` is emptied, so the unpaid table cannot be built from a
    // partial set — and its own "nothing open" reading never appears either.
    expect(text).not.toContain('overview.salaries.totalOpen');
    expect(cells(tree)).not.toContain('0,00 €');
    expect(text).toContain('nav.salaries');
  });
});

describe('Werkstatt off', () => {
  beforeEach(() => { world.modules = { werkstatt: false }; });

  it('issues no request for werkstatt_checks', async () => {
    await mount();
    expect(tablesRead()).not.toContain('werkstatt_checks');
  });

  it('shows no fleet counts, because three zeros read as a clean fleet', async () => {
    const text = textOf(await mount());
    expect(text).toContain('nav.werkstatt');
    // The negative check's own wording is gone with the panel, and so is the
    // "no negative checks this month" reassurance, which would be a claim about
    // roadworthiness.
    expect(text).not.toContain('overview.fleet.noNegative');
    expect(text).not.toContain('Bremsen');
  });
});

describe('Belege off: the module the Overview reads through a shared hook', () => {
  /*
    `receipts` comes from `useDatabase`, which four screens share. The Overview
    cannot change the hook, so what it does is not **call** the getter — proved
    here on the mock, which is the only place that call is visible.
  */
  beforeEach(() => { world.modules = { belege: false }; });

  it('does not call the shared hook\'s receipt getter', async () => {
    const getter = vi.fn(async () => [RECEIPT]);
    const { useDatabase } = await import('../hooks/useDatabase');
    const original = useDatabase() as { receipts: { get: unknown } };
    original.receipts.get = getter;
    await mount();
    expect(getter).not.toHaveBeenCalled();
  });

  it('shows no receipt and no till balance', async () => {
    const text = textOf(await mount());
    expect(text).not.toContain('BEL-1');
    expect(text).not.toContain('overview.receipts.none');
    expect(text).toContain('nav.belege');
  });
});

describe('two modules off at once', () => {
  beforeEach(() => { world.modules = { fixkosten: false, umsaetze: false }; });

  it('names both, in one sentence, and reads neither table', async () => {
    const text = textOf(await mount());
    expect(tablesRead()).not.toContain('fixed_costs');
    expect(tablesRead()).not.toContain('income');
    // The plural key, not the singular one repeated: German puts the verb last
    // and "Fixkosten und Umsätze ist nicht aktiviert" is wrong agreement.
    expect(text).toContain('overview.moduleOff.many');
    expect(text).toContain('nav.fixkosten');
    expect(text).toContain('nav.umsaetze');
  });
});

describe('a module the Overview does not read, and an unknown key', () => {
  it('Fahrtenbuch off changes nothing at all', async () => {
    world.modules = { fahrtenbuch: false };
    const text = textOf(await mount());
    expect(tablesRead()).toContain('fixed_costs');
    expect(text).not.toContain('overview.moduleOff');
  });

  it('a key this build does not know is ON, never off', async () => {
    // The registry's fail-open rule: a rolled-back release must not close a
    // screen because its own definition is missing.
    world.modules = { something_from_a_newer_release: false };
    const text = textOf(await mount());
    expect(tablesRead()).toContain('fixed_costs');
    expect(text).not.toContain('overview.moduleOff');
  });
});
