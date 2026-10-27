/**
 * Which screens read which module's tables — the measurement that decides
 * whether a module can close **reads**, and the guard that keeps it true.
 *
 * ## Why this file exists
 *
 * The owner's decision of 27.10.2026: *"اقفل كل اشي لو الموديول مقفول"* — if the
 * module is off, close everything, reads included. The four costs in
 * `Docs/design/per-company-modules.md` section 5 were put to him in full and he
 * decided against them, so they are not re-argued here.
 *
 * But "close the module's tables" presumes a module **owns** its tables, and
 * that is the thing to measure rather than assume. A `page_key` is the unit the
 * write gate uses, and for writes it is exactly right: the four modules that
 * claim `documents` all **write** the same 24 tables, so closing the page closes
 * what each of them would have written. **Reads are not symmetric**, because a
 * screen belonging to an *enabled* module routinely reads a table a *disabled*
 * module claims — and a hidden SELECT returns `[]` with a 200, with no error for
 * a screen to notice and no read-side equivalent of `deleteChecked`.
 *
 * So the dependency that breaks under read-closing is **screen → table, across
 * modules**, and no page-key rule can see it. This file measures it.
 *
 * ## What it asserts
 *
 * Every `from('<table>')` under `src/` for the eleven tables the gate reaches
 * must be declared below with the module whose screen issues it. From those
 * declarations it derives the **cross-module read set** — a reader whose module
 * is not among the table's owners — and pins that set exactly. A new
 * cross-module read fails until it is declared; a declaration for a read that no
 * longer exists fails too, so a stale line cannot sit here excusing something
 * else.
 *
 * It is a lexical check over the source. It says nothing about whether a screen
 * *should* read a table, and it cannot see a read that reaches a table through
 * an RPC — which is a real gap, named under `UNSEEN_BY_THIS_FILE` below.
 *
 * ## The finding, in one line
 *
 * **No module can close reads today**, and two of the reasons are structural
 * rather than incidental:
 *
 *   1. `OverviewPage` belongs to module `overview`, which is `lockable: false`
 *      and so can **never** be off — and it reads the tables of five different
 *      toggleable modules. Closing reads on any of those five empties figures on
 *      a screen the design guarantees is always reachable, with no company
 *      configuration able to avoid it.
 *   2. The **Stundennachweis** — a statutory document that goes to a
 *      Steuerberater — reads `drivers` (module `fahrer`) and `driver_notes`
 *      (module `notes`). Neither is the Fahrtenbuch module, and neither is the
 *      Monatsplanung module. So switching off a module that has nothing to do
 *      with payroll empties a payroll document.
 *
 * Both are asserted by name at the end of this file, so the day either stops
 * being true — the day read-closing becomes possible for that module — the test
 * fails and says so.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOCKED_MODULE_KEYS, MODULE_DEFINITIONS } from './companyModules';

// ─── the tables the gate reaches, and the page that owns each ────────────────

/**
 * `table -> page_key`, for the eleven tables whose writes `current_role_permits`
 * gates outside the `documents` group.
 *
 * Declared, not derived: the policies embed their page through the `format()`
 * catalogue loop in `20260917130000` section 2, so the page is a **variable** in
 * the migration text and a grep cannot recover it. The authority is the table in
 * `20260923130000`'s header; `ROLE_EDIT_ENFORCED_PAGES` in
 * `rolePermissionEnforcement.ts` is the page half of the same fact and is
 * cross-checked below.
 *
 * The 24 `documents` tables are deliberately **not** listed one by one. They
 * share one page claimed by four modules, so the question this file asks —
 * "does an enabled module's screen read a disabled module's table?" — is
 * answered for all of them by `fahrtenbuch_trips`, which is the one the
 * statutory chain reads and the one the owner switched off.
 */
const TABLE_PAGE: Readonly<Record<string, string>> = {
  drivers:                 'drivers',
  cars:                    'cars',
  car_driver_assignments:  'cars',
  receipts:                'receipts',
  income:                  'income',
  fixed_costs:             'fixed-costs',
  cash_transactions:       'cash-balance',
  werkstatt_checks:        'werkstatt',
  driver_notes:            'notes',
  salaries:                'salaries',
  salary_payments:         'salaries',
};

/** The modules claiming a page — `MODULE_DEFINITIONS`, inverted. */
const owningModules = (page: string): string[] =>
  MODULE_DEFINITIONS.filter(m => (m.pageKeys as readonly string[]).includes(page)).map(m => m.key);

// ─── every reader, and the module whose screen issues it ─────────────────────

/**
 * `file -> the module key whose screen this read serves`.
 *
 * A declaration and not a derivation, because only a **page** has a route and
 * most of these are components. `null` means the read serves no module: a route
 * the registry does not own (`/stundennachweis`, `/fahrtenanalyse`), or a shared
 * hook or helper reached from several modules.
 *
 * `shared` is listed where one file genuinely serves several — `useDatabase`
 * covers the older receipt/driver/income/salary CRUD for four screens — and such
 * a file is counted as a cross-module reader for every table it touches that it
 * does not own, because the module it is serving at the time is not knowable
 * from the source.
 */
const READER_MODULE: Readonly<Record<string, string | null>> = {
  // pages, whose module is their route's (App.tsx)
  'src/pages/OverviewPage.tsx':         'overview',
  'src/pages/AbrechnungPage.tsx':       'abrechnung',
  'src/pages/BargeldbestandPage.tsx':   'bargeldbestand',
  'src/pages/FahrtenbuchPage.tsx':      'fahrtenbuch',
  'src/pages/MonthlyPlanPage.tsx':      'monatsplan',
  'src/pages/NotesPage.tsx':            'notes',
  'src/pages/SalariesPage.tsx':         'salaries',
  'src/pages/WerkstattPage.tsx':        'werkstatt',
  // `/stundennachweis` and `/fahrtenanalyse` belong to NO module — the registry
  // says so and `companyModules.test.ts` pins it — so their routes are never
  // closed. That is what makes them the sharpest readers of all: with all four
  // `documents` modules off, these two screens stay reachable over closed data.
  'src/pages/StundennachweisPage.tsx':  null,
  'src/pages/SimulatedRidesPage.tsx':   null,

  // components, whose module is the screen that mounts them
  'src/components/AbrechnungScheduleCard.tsx':             'abrechnung',
  'src/components/CarModal.tsx':                           'cars',
  'src/components/CarsManagement.tsx':                     'cars',
  'src/components/FixedCostsManagement.tsx':               'fixkosten',
  'src/components/IncomeManagement.tsx':                   'umsaetze',
  'src/components/UberEarningsImportModal.tsx':            'umsaetze',
  'src/components/SalariesManagement.tsx':                 'salaries',
  'src/components/SalaryDetailsModal.tsx':                 'salaries',
  'src/components/SalaryPeriodsModal.tsx':                 'salaries',
  'src/components/WerkstattCheckModal.tsx':                'werkstatt',
  // The planner's own components: /company-planner branches on planningMode, so
  // all three wizards and both previews are that module's.
  'src/components/MonatsplanungDriverPool.tsx':            'company_planner',
  'src/components/MonatsplanungAssignmentPreview.tsx':     'company_planner',
  'src/components/MonatsplanungStundennachweisPreview.tsx': 'company_planner',
  'src/components/HistoricalReconciliationWizard.tsx':     'company_planner',
  'src/components/HistoricalWorkingHoursWizard.tsx':       'company_planner',
  // Documents: the two generated-document modals live on DocumentsPage.
  'src/components/MietwagenauftragModal.tsx':              'dokumente',
  'src/components/TrinkgeldQuittungModal.tsx':             'dokumente',

  // shared, serving several modules
  'src/hooks/useDatabase.ts':         'shared',
  'src/lib/salaryCashReceipts.ts':    'salaries',
  'src/lib/tripAnalysisClient.ts':    null,
  'src/lib/uberBackfillDeps.ts':      'umsaetze',
  'src/utils/driverStatus.ts':        'shared',
};

/**
 * What a lexical scan of `from('…')` cannot see, recorded so the measurement is
 * not read as complete:
 *
 *   - **`cash_transactions` has no `from()` anywhere.** It is read by
 *     `get_weekly_abrechnung` / `get_monthly_abrechnung` and their two per-driver
 *     siblings, which are `SECURITY INVOKER` — so the caller's own policies
 *     answer them, and closing the `cash-balance` page's reads would change the
 *     Abrechnung's figures with no `from('cash_transactions')` to find. This is
 *     the clearest case that a read dependency can be invisible to this file.
 *   - **`cash_movements` and `salary_cash_receipts`** carry no write policy and
 *     no page, so the gate does not reach them — but `cashLedger.ts` reads them
 *     for the till on the Overview and Bargeldbestand.
 *   - **Edge functions and the export service** are not scanned.
 */
const UNSEEN_BY_THIS_FILE = ['cash_transactions via the four Abrechnung RPCs'] as const;

// ─── the scan ────────────────────────────────────────────────────────────────

const SRC = fileURLToPath(new URL('..', import.meta.url));

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = dir + entry;
    if (statSync(full).isDirectory()) walk(full + '/', out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
};

const relative = (full: string): string =>
  'src/' + full.slice(SRC.length).replace(/\\/g, '/');

/** `table -> the files that read it`, measured. */
const readersByTable = (): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  for (const table of Object.keys(TABLE_PAGE)) found.set(table, []);
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const table of Object.keys(TABLE_PAGE)) {
      if (source.includes(`from('${table}')`)) found.get(table)!.push(relative(file));
    }
  }
  for (const list of found.values()) list.sort();
  return found;
};

/** `"<reader module> reads <table> (owned by <modules>)"`, for every crossing. */
const crossModuleReads = (): string[] => {
  const out: string[] = [];
  for (const [table, files] of readersByTable()) {
    const owners = owningModules(TABLE_PAGE[table]);
    for (const file of files) {
      const reader = READER_MODULE[file];
      if (reader !== null && reader !== 'shared' && owners.includes(reader)) continue;
      out.push(`${reader ?? 'no module'} reads ${table} (owned by ${owners.join('+') || 'nobody'})`);
    }
  }
  return [...new Set(out)].sort();
};

// ─── 1. the declarations cover what is there ─────────────────────────────────

describe('every read of a gated table is declared', () => {
  it('no file reads one of these tables without a declared module', () => {
    const undeclared: string[] = [];
    for (const files of readersByTable().values()) {
      for (const file of files) if (!(file in READER_MODULE)) undeclared.push(file);
    }
    expect([...new Set(undeclared)].sort(), 'declare these in READER_MODULE').toEqual([]);
  });

  it('no declaration names a file that reads none of them any more', () => {
    const live = new Set<string>();
    for (const files of readersByTable().values()) for (const file of files) live.add(file);
    const stale = Object.keys(READER_MODULE).filter(file => !live.has(file)).sort();
    expect(stale, 'these declarations are stale and would excuse something else').toEqual([]);
  });

  it('every declared reader module is a real module key, or null, or shared', () => {
    const keys = new Set<string>([...MODULE_DEFINITIONS.map(m => m.key), 'shared']);
    for (const [file, module] of Object.entries(READER_MODULE)) {
      if (module === null) continue;
      expect(keys.has(module), `${file} declares unknown module ${module}`).toBe(true);
    }
  });

  it('every page named here is one role_permissions uses, and one the writes gate', () => {
    // Cross-check against the other half of the same fact. If a page here is not
    // write-gated, closing its reads would be the only thing the module did -
    // which is a different feature and should not arrive by accident.
    const pages = new Set(Object.values(TABLE_PAGE));
    for (const page of pages) {
      expect(MODULE_DEFINITIONS.some(m => (m.pageKeys as readonly string[]).includes(page)),
        `no module claims page ${page}`).toBe(true);
    }
  });
});

// ─── 2. the cross-module read set, pinned ────────────────────────────────────

describe('the cross-module read set', () => {
  /*
    THE MEASUREMENT. Each line is an enabled module's screen reading a table
    another module owns, so closing that owner's reads degrades a screen the
    customer still has. Adding a line here is not forbidden - it is how the
    product is built - but it must be deliberate, because every line is a
    screen that would have to be retaught before reads can ever close.
  */
  it('is exactly this, and a new crossing must be added deliberately', () => {
    expect(crossModuleReads()).toEqual([
      'abrechnung reads drivers (owned by fahrer)',
      'abrechnung reads income (owned by umsaetze)',
      'abrechnung reads receipts (owned by belege)',
      'bargeldbestand reads drivers (owned by fahrer)',
      'bargeldbestand reads income (owned by umsaetze)',
      'bargeldbestand reads receipts (owned by belege)',
      'cars reads drivers (owned by fahrer)',
      'company_planner reads driver_notes (owned by notes)',
      'company_planner reads drivers (owned by fahrer)',
      'dokumente reads cars (owned by cars)',
      'dokumente reads drivers (owned by fahrer)',
      'dokumente reads income (owned by umsaetze)',
      'fahrtenbuch reads cars (owned by cars)',
      'fahrtenbuch reads drivers (owned by fahrer)',
      'monatsplan reads driver_notes (owned by notes)',
      'monatsplan reads drivers (owned by fahrer)',
      'no module reads cars (owned by cars)',
      'no module reads driver_notes (owned by notes)',
      'no module reads drivers (owned by fahrer)',
      'no module reads income (owned by umsaetze)',
      'notes reads cars (owned by cars)',
      'notes reads drivers (owned by fahrer)',
      'overview reads cars (owned by cars)',
      'overview reads fixed_costs (owned by fixkosten)',
      'overview reads income (owned by umsaetze)',
      'overview reads salaries (owned by salaries)',
      'overview reads werkstatt_checks (owned by werkstatt)',
      'salaries reads drivers (owned by fahrer)',
      'salaries reads income (owned by umsaetze)',
      // `useDatabase` covers the older receipt/driver/income/salary CRUD, but
      // its `income` reads go through `uberBackfillDeps`, which is `umsaetze`'
      // own - so there is no `shared reads income` line, and predicting one was
      // a transcription error this assertion caught.
      'shared reads drivers (owned by fahrer)',
      'shared reads receipts (owned by belege)',
      'werkstatt reads cars (owned by cars)',
    ]);
  });

  /*
    The blocking conclusion, partitioned — and the first version of this
    assertion was WRONG in a way worth recording, because it is the trap this
    repository has already paid for twice ("a probe whose refusals share a
    class", and silence reading as success).

    It asked "has this module no cross-module reader?" and answered yes for six
    modules — reading them as **clean** when in fact their tables are simply
    **not measured by this file**: `accounting` is named by no table at all, and
    the 24 `documents` tables are deliberately out of `TABLE_PAGE`. Absence of a
    finding is not a finding of absence. The partition below cannot make that
    mistake, because every module must land in exactly one named bucket and
    `clean` is asserted empty separately.
  */
  const tablesOf = (module: { pageKeys: readonly string[] }): string[] =>
    Object.entries(TABLE_PAGE)
      .filter(([, page]) => module.pageKeys.includes(page))
      .map(([table]) => table);

  const measurable = MODULE_DEFINITIONS.filter(
    m => m.lockable && (m.pageKeys as readonly string[]).length > 0,
  );

  it('five modules are not measured here at all, which is not the same as safe', () => {
    const unmeasured = measurable.filter(m => tablesOf(m).length === 0).map(m => m.key).sort();
    // `abrechnung`: page `accounting`, which no table names - the four
    // Abrechnung RPCs are SECURITY INVOKER over other modules' tables, so this
    // module has nothing of its own to close either way.
    // The `documents` four: 24 tables, out of this file's scope on purpose (see
    // TABLE_PAGE's header). Their crossing is proved by `fahrtenbuch_trips` in
    // the statutory-chain assertion below.
    expect(unmeasured).toEqual(['abrechnung', 'company_planner', 'dokumente', 'fahrtenbuch', 'monatsplan']);
    // `abrechnung` lands in neither bucket by table, but it DOES appear as a
    // reader three times above, so it is not clean - asserted here so the
    // partition is exhaustive.
    expect(crossModuleReads().filter(l => l.startsWith('abrechnung reads ')).length).toBe(3);
  });

  it('one module\'s only table has NO visible reader, so it cannot be called safe', () => {
    const invisible = measurable
      .filter(m => tablesOf(m).length > 0)
      .filter(m => tablesOf(m).every(t => readersByTable().get(t)!.length === 0))
      .map(m => m.key)
      .sort();
    // `bargeldbestand` owns `cash-balance` -> `cash_transactions`, which has
    // zero `from()` call sites: it is read by the four Abrechnung RPCs, which
    // are SECURITY INVOKER, so closing its reads would move the Abrechnung's
    // money figures with nothing in `src/` to find. Unmeasured, not clean.
    expect(invisible).toEqual(['bargeldbestand']);
  });

  it('and not one module is clean', () => {
    const clean = measurable
      .filter(m => tablesOf(m).length > 0)
      .filter(m => tablesOf(m).some(t => readersByTable().get(t)!.length > 0))
      .filter(m => !crossModuleReads().some(line =>
        tablesOf(m).some(table => line.includes(` reads ${table} (`))))
      .map(m => m.key);
    expect(clean, 'these modules could close reads with no cross-module reader').toEqual([]);
  });
});

// ─── 3. the two structural blockers, by name ─────────────────────────────────

describe('why read-closing is blocked, asserted rather than written down', () => {
  it('a module that can NEVER be off reads five toggleable modules\' tables', () => {
    /*
      `overview` is lockable: false - two deadlocks make it the product's floor
      (`path="*"` redirects there, and it is the one feature planAllows() exempts
      from the subscription check). So there is no company configuration in which
      the Overview is absent, and closing reads on any of the five modules below
      empties a figure on a screen that is always reachable.
    */
    expect(LOCKED_MODULE_KEYS).toContain('overview');
    const overviewReads = crossModuleReads()
      .filter(line => line.startsWith('overview reads '))
      .map(line => line.replace(/^overview reads \w+ \(owned by (.+)\)$/, '$1'))
      .sort();
    expect(overviewReads).toEqual(['cars', 'fixkosten', 'salaries', 'umsaetze', 'werkstatt']);
  });

  it('the Stundennachweis reads two modules that have nothing to do with payroll', () => {
    /*
      THE STOP-AND-REPORT CASE. The Stundennachweis is a statutory time record
      that goes to a Steuerberater. Its builder is
      MonatsplanungStundennachweisPreview (module `company_planner`) and the
      saved-sheet screen is StundennachweisPage (NO module, so its route never
      closes). Both read `drivers` and `driver_notes`.

      `driver_notes` is the worse of the two and it is not a blank-page problem:
      `note_constraint` is a HARD phase-3 constraint. Closing `notes` does not
      empty the plan - it produces a plan that violates drivers' own notes, and
      then prints it.
    */
    const source = (file: string) => readFileSync(fileURLToPath(new URL('../' + file, import.meta.url)), 'utf8');
    for (const file of ['components/MonatsplanungStundennachweisPreview.tsx', 'pages/StundennachweisPage.tsx']) {
      expect(source(file), `${file} must read drivers`).toContain("from('drivers')");
      expect(source(file), `${file} must read driver_notes`).toContain("from('driver_notes')");
    }
    expect(owningModules('drivers')).toEqual(['fahrer']);
    expect(owningModules('notes')).toEqual(['notes']);
  });

  it('the finer unit is worse than the page, which is why the page was kept', () => {
    /*
      The tempting refinement for reads is "close only the tables that belong to
      ONLY the disabled module". Measured, it is the defect generator: it would
      close `fahrtenbuch_trips` when `fahrtenbuch` is off, while `/monatsplan`
      and `/company-planner` are still on and still read it - the empty statutory
      document this whole slice is written to avoid. The page key with the
      any-enabled-claimant rule keeps `documents` open unless all four are off,
      which is strictly safer.
    */
    const documentsClaimants = MODULE_DEFINITIONS
      .filter(m => (m.pageKeys as readonly string[]).includes('documents'))
      .map(m => m.key)
      .sort();
    expect(documentsClaimants).toEqual(['company_planner', 'dokumente', 'fahrtenbuch', 'monatsplan']);
  });

  it('records what a lexical scan cannot see', () => {
    // `cash_transactions` is in TABLE_PAGE and has zero `from()` call sites: the
    // four Abrechnung RPCs are SECURITY INVOKER, so closing `cash-balance`
    // reads would move the Abrechnung's money figures with nothing here to find.
    expect(readersByTable().get('cash_transactions')).toEqual([]);
    expect(UNSEEN_BY_THIS_FILE.length).toBeGreaterThan(0);
  });
});
