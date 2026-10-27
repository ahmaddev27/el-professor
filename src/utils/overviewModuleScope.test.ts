/**
 * The Overview's per-panel module awareness: the decision as a pure function,
 * and the coverage check that the page actually asks it.
 *
 * Two halves, for the reason `App.moduleGate.test.ts` gives for itself. The
 * decision is a pure map and is unit-tested here against every state the
 * registry admits. Whether the **page** asks it cannot be unit-tested at all:
 * this project's vitest runs `environment: 'node'` with no jsdom and no
 * testing-library, and `src/**\/*.test.ts` does not even match `.tsx`, so there
 * is no renderer to mount `OverviewPage` in. The claim is also coverage over a
 * list — that no panel in the map is left unguarded at its render site — which
 * is the shape a renderer answers worst anyway. So the second half reads
 * `OverviewPage.tsx` as text, exactly as `App.moduleGate.test.ts` reads
 * `App.tsx` and `companyModules.test.ts` reads `Sidebar.tsx`.
 *
 * Being lexical, the second half says nothing about how the page *looks*. What
 * it does say is that a panel cannot be added to `OVERVIEW_PANEL_MODULES` and
 * then forgotten in the markup, and that no one of the Overview's seven reads
 * can lose its module term — which is how every defect in this feature so far
 * has got in (slice 1 gated the link and nothing else; slice 2's gate was
 * missing on seven routes).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LOCKED_MODULE_KEYS,
  MODULE_DEFINITIONS,
  NO_MODULE_DECISIONS,
  moduleDefinition,
  type CompanyModules,
} from '../lib/companyModules';
import {
  OVERVIEW_HOOK_READS,
  OVERVIEW_MODULE_KEY,
  OVERVIEW_MODULE_SURFACE,
  OVERVIEW_OWN_READS,
  OVERVIEW_PANEL_MODULES,
  overviewPanelAvailable,
  overviewPanelOffModules,
  overviewReadEnabled,
  type OverviewPanelKey,
  type OverviewReadTable,
} from './overviewModuleScope';

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replace(/\r/g, '');

const PAGE = read('../pages/OverviewPage.tsx');

const PANELS = Object.keys(OVERVIEW_PANEL_MODULES) as OverviewPanelKey[];
const ALL_READS = [
  ...Object.keys(OVERVIEW_OWN_READS),
  ...Object.keys(OVERVIEW_HOOK_READS),
] as OverviewReadTable[];

/** The module state for "these keys are off, everything else is on". */
const off = (...keys: string[]): CompanyModules =>
  Object.freeze(Object.fromEntries(keys.map(key => [key, false])));

// ─── 1. The premise this whole file rests on ─────────────────────────────────

describe('the premise: the Overview can never be switched off', () => {
  /*
    If this ever stopped being true, per-panel awareness would still be correct
    but it would no longer be *necessary* — the route gate would answer first,
    and the simpler fix (close the whole screen) would be back on the table. So
    it is asserted rather than assumed, and the day it moves this file says so.
  */
  it('`overview` is lockable: false', () => {
    expect(OVERVIEW_MODULE_KEY).toBe('overview');
    expect(LOCKED_MODULE_KEYS).toContain('overview');
  });

  it('and it is the module that owns /overview, not a string that happens to match', () => {
    const definition = moduleDefinition(OVERVIEW_MODULE_KEY);
    expect(definition).not.toBeNull();
    expect(definition!.routes).toContain('/overview');
  });
});

// ─── 2. The declared reads are the real ones ─────────────────────────────────

describe('each declared read names the module that really owns that table', () => {
  /*
    Cross-checked against the migration rather than trusted, because this is the
    pair that drifts: the page a table's write policies name is a `format()`
    variable inside 20260917130000's catalogue loop, so no import can recover it
    and a grep over the policy text finds a variable. `rolePageKeys.test.ts`'
    idiom — read the migration that defines the fact.
  */
  const catalogue = read('../../supabase/migrations/20260917130000_unified_tenant_policies.sql');

  /** `table -> page_key`, parsed out of the catalogue's VALUES rows. */
  const tablePage = (): Record<string, string> => {
    const map: Record<string, string> = {};
    for (const [, table, , page] of catalogue.matchAll(
      /\n\s*\('([a-z_]+)',\s*'([SIUD]+)',\s*(?:'([a-z-]+)'|NULL)/g,
    )) {
      if (page) map[table] = page;
    }
    return map;
  };

  it('the parse found the catalogue at all', () => {
    // A regex that silently matched nothing would make every assertion below
    // pass vacuously, which is this repository's most expensive recurring bug.
    expect(Object.keys(tablePage()).length).toBeGreaterThanOrEqual(10);
    expect(tablePage()['fixed_costs']).toBe('fixed-costs');
  });

  for (const table of ALL_READS) {
    it(`${table} belongs to a module that claims its page`, () => {
      const declared = table in OVERVIEW_OWN_READS
        ? OVERVIEW_OWN_READS[table as keyof typeof OVERVIEW_OWN_READS]
        : OVERVIEW_HOOK_READS[table as keyof typeof OVERVIEW_HOOK_READS];
      const page = tablePage()[table];
      expect(page, `${table} is not in the catalogue`).toBeDefined();
      const definition = moduleDefinition(declared);
      expect(definition, `${declared} is not a module`).not.toBeNull();
      expect(definition!.pageKeys as readonly string[]).toContain(page);
    });
  }

  it('every declared module is toggleable, or the declaration is pointless', () => {
    for (const key of Object.values({ ...OVERVIEW_OWN_READS, ...OVERVIEW_HOOK_READS })) {
      expect(LOCKED_MODULE_KEYS, `${key} can never be off`).not.toContain(key);
    }
  });

  it('the Overview reads nothing gated that is not declared', () => {
    /*
      Derived from the page's own source. The two reads deliberately absent are
      `user_profiles` (module `users`, locked) and `cash_movements` (claimed by
      no page and so by no module); both are asserted by name so that "absent"
      cannot quietly come to mean "forgotten".
    */
    const fetched = [...PAGE.matchAll(/\.from\('([a-z_]+)'\)/g)].map(m => m[1]).sort();
    expect([...new Set(fetched)]).toEqual([
      'cars', 'cash_movements', 'fixed_costs', 'income', 'salaries', 'user_profiles', 'werkstatt_checks',
    ]);
    const undeclared = [...new Set(fetched)].filter(
      table => !(table in OVERVIEW_OWN_READS) && !['user_profiles', 'cash_movements'].includes(table),
    );
    expect(undeclared, 'declare these in OVERVIEW_OWN_READS').toEqual([]);
  });
});

// ─── 3. Absence means ON, on a read as it does on a write ────────────────────

describe('absence means on', () => {
  /*
    The rule `company_modules` is built on and the one a copy of `plan_features`'
    fail-closed logic would have broken: the table stores decisions to subtract,
    so no decision is no subtraction. Slice 3 proved it in the database (self-
    checks 7 and 8 of 20261027120000); this is the browser half, on the read
    side, for the whole product surface rather than one example.
  */
  it('a company with no decisions reads everything and sees every panel', () => {
    for (const table of ALL_READS) {
      expect(overviewReadEnabled(NO_MODULE_DECISIONS, table), table).toBe(true);
    }
    for (const panel of PANELS) {
      expect(overviewPanelOffModules(NO_MODULE_DECISIONS, panel), panel).toEqual([]);
      expect(overviewPanelAvailable(NO_MODULE_DECISIONS, panel), panel).toBe(true);
    }
  });

  it('a decision of `true` is the same as no decision', () => {
    const allOn = Object.fromEntries(MODULE_DEFINITIONS.map(m => [m.key, true]));
    for (const panel of PANELS) expect(overviewPanelAvailable(allOn, panel), panel).toBe(true);
  });

  it('a key this build does not know changes nothing', () => {
    // The registry is the newer half of the pair in a rolled-back release, so a
    // gate that closed on an unknown key would close a screen because its own
    // definition was missing.
    const unknown = { module_nobody_has_heard_of: false };
    for (const panel of PANELS) expect(overviewPanelAvailable(unknown, panel), panel).toBe(true);
  });

  it('a module the Overview does not read changes nothing', () => {
    for (const panel of PANELS) {
      expect(overviewPanelAvailable(off('fahrtenbuch', 'notes', 'abrechnung'), panel), panel).toBe(true);
    }
  });
});

// ─── 4. What each module takes away ──────────────────────────────────────────

describe('what one module off takes away', () => {
  /*
    Pinned per module rather than spot-checked, because the whole value of this
    slice is that the list is **complete**: a panel left out of one of these is
    a figure a disabled module still reaches, which is exactly the owner's
    requirement of 27.10.2026.
  */
  const blocked = (key: string): OverviewPanelKey[] =>
    PANELS.filter(panel => !overviewPanelAvailable(off(key), panel)).sort();

  it('fixkosten', () => {
    expect(blocked('fixkosten')).toEqual([
      'insights', 'kpiMargin', 'kpiProfit', 'kpiTotalCosts', 'profitBreakdown', 'topExpenses', 'trend',
    ]);
  });

  it('salaries', () => {
    expect(blocked('salaries')).toEqual([
      'alertsSalaries', 'driverChart', 'driverRanking', 'insights', 'kpiMargin', 'kpiProfit',
      'kpiSalaries', 'profitBreakdown', 'trend', 'unpaidSalaries',
    ]);
  });

  it('werkstatt — the one module that takes away no money figure', () => {
    // Which is why it is the cheapest of the five to teach, and why `fleet` and
    // `alertsFleet` are the whole of its reach.
    expect(blocked('werkstatt')).toEqual(['alertsFleet', 'fleet', 'insights']);
  });

  it('cars — the TÜV alert and nothing else', () => {
    expect(blocked('cars')).toEqual(['alertsTuev']);
  });

  it('umsaetze — the widest, because revenue is in every ratio', () => {
    expect(blocked('umsaetze')).toEqual([
      'cash', 'driverChart', 'driverRanking', 'insights', 'kpiBargeld', 'kpiMargin',
      'kpiProfit', 'kpiUmsatz', 'profitBreakdown', 'revenueMix', 'trend',
    ]);
  });

  it('belege and fahrer, which reach the Overview through useDatabase', () => {
    expect(blocked('belege')).toEqual([
      'cash', 'driverChart', 'driverRanking', 'insights', 'kpiMargin', 'kpiProfit',
      'kpiTotalCosts', 'profitBreakdown', 'recentReceipts', 'topExpenses', 'trend',
    ]);
    expect(blocked('fahrer')).toEqual([
      'alertsSalaries', 'driverChart', 'driverRanking', 'insights', 'unpaidSalaries',
    ]);
  });

  it('the three panels that are WRONG rather than empty all carry four modules', () => {
    /*
      The reason this is decided before the arithmetic rather than after it.
      `profit = umsatz − salaries − expenses − fixedCosts`, so a missing cost
      term **overstates** profit; `totalCosts` understates; the till understates
      what left it. None of the three reaches zero, so none of them looks wrong
      — and that is what makes "the read came back empty" an unusable test.
    */
    expect([...OVERVIEW_PANEL_MODULES.kpiProfit]).toEqual(['belege', 'fixkosten', 'salaries', 'umsaetze']);
    expect([...OVERVIEW_PANEL_MODULES.profitBreakdown]).toEqual(['belege', 'fixkosten', 'salaries', 'umsaetze']);
    expect([...OVERVIEW_PANEL_MODULES.kpiTotalCosts]).toEqual(['belege', 'fixkosten']);
    expect([...OVERVIEW_PANEL_MODULES.cash]).toEqual(['belege', 'umsaetze']);
  });

  it('several off at once names all of them, in the map\'s order', () => {
    // The notice builds a sentence from this list, so the order has to be the
    // map's and not the state object's iteration order.
    expect(overviewPanelOffModules(off('umsaetze', 'fixkosten'), 'kpiProfit'))
      .toEqual(['fixkosten', 'umsaetze']);
    expect(overviewPanelOffModules(off('salaries', 'belege', 'umsaetze', 'fixkosten'), 'trend'))
      .toEqual(['belege', 'fixkosten', 'salaries', 'umsaetze']);
  });
});

// ─── 5. The map and the reads are two halves of one fact ─────────────────────

describe('the panel map and the read list cannot drift apart', () => {
  it('every module a panel needs is a module the Overview actually reads', () => {
    for (const [panel, keys] of Object.entries(OVERVIEW_PANEL_MODULES)) {
      for (const key of keys) {
        expect(OVERVIEW_MODULE_SURFACE, `${panel} needs ${key}, which nothing reads`).toContain(key);
      }
    }
  });

  it('every module the Overview reads is needed by at least one panel', () => {
    // A read with no panel is a request for rows nothing uses — which is the
    // state the Overview would be left in if a panel were deleted and its read
    // left behind.
    for (const key of OVERVIEW_MODULE_SURFACE) {
      const panels = PANELS.filter(panel => (OVERVIEW_PANEL_MODULES[panel] as readonly string[]).includes(key));
      expect(panels.length, `nothing uses ${key}`).toBeGreaterThan(0);
    }
  });

  it('the surface is exactly the seven modules, sorted', () => {
    expect([...OVERVIEW_MODULE_SURFACE]).toEqual([
      'belege', 'cars', 'fahrer', 'fixkosten', 'salaries', 'umsaetze', 'werkstatt',
    ]);
  });

  it('every module named anywhere here has a definition, so the notice has a label', () => {
    // `ModuleOffNotice` looks the label up through `moduleDefinition`. A key
    // with no definition would render as the raw key.
    for (const key of OVERVIEW_MODULE_SURFACE) {
      expect(moduleDefinition(key), key).not.toBeNull();
    }
  });
});

// ─── 6. The page asks, for every panel and every read ────────────────────────

describe('OverviewPage.tsx asks the question it is given', () => {
  /*
    Lexical, and it has to be — see the file header. What it catches is the
    class of defect this feature has already shipped twice: a gate that exists
    and is not called.
  */
  it('every one of the five own reads carries its module term', () => {
    for (const table of Object.keys(OVERVIEW_OWN_READS)) {
      expect(PAGE, `${table} is fetched without a module term`)
        .toContain(`overviewReadEnabled(companyModules, '${table}')`);
    }
  });

  it('both shared-hook reads carry one too, at the Overview\'s own call site', () => {
    for (const table of Object.keys(OVERVIEW_HOOK_READS)) {
      expect(PAGE, `${table} is fetched without a module term`)
        .toContain(`overviewReadEnabled(companyModules, '${table}')`);
    }
    // Not inside the hook: `useDatabase` serves four screens and must not be
    // taught one screen's rules.
    expect(read('../hooks/useDatabase.ts')).not.toContain('overviewReadEnabled');
    expect(read('../hooks/useDatabase.ts')).not.toContain('moduleEnabled');
  });

  it('the load waits for the module map before it issues anything', () => {
    /*
      Without this the slice does nothing: `PlanContext` starts at
      `NO_MODULE_DECISIONS` — every module on — and only replaces it once the
      `company_modules` read answers, so a load that ran first would fetch all
      seven tables on the old terms and leave a disabled module's rows on screen.
    */
    expect(PAGE).toContain('if (!dbLoading && !planLoading) loadData();');
    expect(PAGE).toContain('}, [dbLoading, planLoading, companyModules]);');
  });

  it('every panel in the map is guarded at its render site', () => {
    for (const panel of PANELS) {
      const guarded = PAGE.includes(`panelOn('${panel}')`) || PAGE.includes(`offSub('${panel}')`);
      expect(guarded, `panel ${panel} is in the map but nothing in the page asks about it`).toBe(true);
    }
  });

  it('a withheld KPI shows a dash and no delta, never a zero', () => {
    /*
      The six KPI cards are the only panels that keep rendering when withheld,
      so they are the only ones where a figure could survive. Each one must take
      `WITHHELD` for its value and drop its delta — a percentage change against
      a month whose term was not read is the same false statement one level down.
    */
    for (const panel of ['kpiUmsatz', 'kpiBargeld', 'kpiSalaries', 'kpiTotalCosts', 'kpiProfit', 'kpiMargin']) {
      expect(PAGE, `${panel} renders a figure when withheld`)
        .toContain(`offSub('${panel}') ? WITHHELD :`);
    }
    for (const panel of ['kpiUmsatz', 'kpiBargeld', 'kpiSalaries', 'kpiTotalCosts', 'kpiProfit']) {
      expect(PAGE, `${panel} keeps its delta when withheld`)
        .toContain(`delta={offSub('${panel}') ? undefined :`);
    }
    // `kpiMargin` has no delta prop at all, so there is nothing to drop.
    expect(PAGE).not.toContain("delta={offSub('kpiMargin')");
    expect(PAGE).toContain("const WITHHELD = '—';");
  });

  it('and the two cards that colour by sign read neutral when withheld', () => {
    /*
      A red icon beside a dash is a claim one step quieter than a figure: it
      says the company made a loss, off a profit computed without its Fixkosten.
      Both booleans are true when the panel is withheld, so the positive palette
      renders — and they are booleans rather than a second colour literal at the
      call site because the style ratchet counts occurrences, and a duplicated
      `rgba(...)` would raise its baseline.
    */
    expect(PAGE).toContain("const profitReadsPositive = offSub('kpiProfit') !== null || currentMetrics.profit >= 0;");
    expect(PAGE).toContain("const marginReadsPositive = offSub('kpiMargin') !== null || currentMetrics.profitMargin >= 0;");
    expect(PAGE).not.toContain('iconColor={currentMetrics.profit >= 0');
    expect(PAGE).not.toContain('iconColor={currentMetrics.profitMargin >= 0');
  });

  it('the four helpers that compute over a set are emptied, not merely unrendered', () => {
    // `generateInsights` is the sharp one: it compares two months and would
    // write a confident sentence about a collapse that is only a closed read.
    expect(PAGE).toContain("panelOn('insights')");
    expect(PAGE).toContain("panelOn('driverChart')\n    ? calcDriverPerformance");
    expect(PAGE).toContain("panelOn('alertsSalaries') ? calcSalaryAlerts");
    expect(PAGE).toContain("panelOn('topExpenses')");
  });

  it('a withheld panel states the reason and is never simply hidden', () => {
    /*
      The notice is rendered, not an empty fragment. A missing card on a
      dashboard is the same silence in a different shape — the customer cannot
      tell a figure that was withheld from one that was never there.
    */
    const notices = [...PAGE.matchAll(/<ModuleOffNotice moduleKeys=\{panelOff\('(\w+)'\)\}/g)].map(m => m[1]).sort();
    expect(notices).toEqual([
      'cash', 'driverChart', 'driverRanking', 'fleet', 'profitBreakdown',
      'recentReceipts', 'revenueMix', 'topExpenses', 'trend',
    ]);
  });

  it('the three panels that stay silent are the three whose absence claims nothing', () => {
    /*
      `insights`, `alertsSalaries`/`alertsFleet`/`alertsTuev` and
      `unpaidSalaries` all render **only when they have something to report**,
      so withholding a row claims nothing — and for each of them a KPI card
      above already shows `—` with the module named. Asserted so that the
      distinction stays a decision: a panel moved out of this list and into the
      notices list, or the other way, has to come past here.
    */
    const silent: OverviewPanelKey[] = ['insights', 'alertsSalaries', 'alertsFleet', 'alertsTuev', 'unpaidSalaries'];
    const notices = [...PAGE.matchAll(/<ModuleOffNotice moduleKeys=\{panelOff\('(\w+)'\)\}/g)].map(m => m[1]);
    for (const panel of silent) expect(notices, panel).not.toContain(panel);
    // Each silent panel's figure is still named somewhere: the KPI cards cover
    // salaries, and the fleet panel's own notice covers alertsFleet's module.
    expect(PAGE).toContain("offSub('kpiSalaries')");
    expect(PAGE).toContain("<ModuleOffNotice moduleKeys={panelOff('fleet')}");
  });
});
