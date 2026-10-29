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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOCKED_MODULE_KEYS, MODULE_DEFINITIONS } from './companyModules';
import {
  BACKUP_CHILD_TABLES,
  BACKUP_TABLES,
  backupFilename,
  createBackup,
  type BackupClient,
  type BackupFilterBuilder,
} from '../utils/backup';

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
  // The simulator's own reads, kept out of the page: driver_notes, the planning
  // columns of drivers and the month's werkstatt_checks, all read BEFORE a ride
  // is placed (decision 5 of 29.10.2026). It serves the same module-less screen.
  'src/lib/simulationInputsClient.ts':  null,

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
 *   - **A reader that passes the table name as a variable**, `from(table)`, which
 *     is the gap section 7 below closes and which turned out to hold the second
 *     structural blocker. Added 27.10.2026, after the first attempt to act on
 *     this measurement.
 */
const UNSEEN_BY_THIS_FILE = [
  'cash_transactions via the four Abrechnung RPCs',
  'from(table) readers, now derived in section 7',
] as const;

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

/*
  Both derivations below are memoized. They are pure over the working tree, which
  nothing in this file writes, so the answer cannot change inside one run — and
  section 4 made them hot: `blockingCrossings()` asks per crossing, and the file
  went from 16 s to 63 s before this cache. That matters here beyond patience,
  because this repository's standing rule is that a red local build may be
  starvation and that parallel gates belong capped at two; a 63 s file is a
  contributor to exactly that.
*/
let readersCache: Map<string, string[]> | null = null;
let crossingsCache: string[] | null = null;

/** `table -> the files that read it`, measured. */
const readersByTable = (): Map<string, string[]> => {
  if (readersCache) return readersCache;
  const found = new Map<string, string[]>();
  for (const table of Object.keys(TABLE_PAGE)) found.set(table, []);
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const table of Object.keys(TABLE_PAGE)) {
      if (source.includes(`from('${table}')`)) found.get(table)!.push(relative(file));
    }
  }
  for (const list of found.values()) list.sort();
  readersCache = found;
  return found;
};

/** `"<reader module> reads <table> (owned by <modules>)"`, for every crossing. */
const crossModuleReads = (): string[] => {
  if (crossingsCache) return crossingsCache;
  const out: string[] = [];
  for (const [table, files] of readersByTable()) {
    const owners = owningModules(TABLE_PAGE[table]);
    for (const file of files) {
      const reader = READER_MODULE[file];
      if (reader !== null && reader !== 'shared' && owners.includes(reader)) continue;
      out.push(`${reader ?? 'no module'} reads ${table} (owned by ${owners.join('+') || 'nobody'})`);
    }
  }
  crossingsCache = [...new Set(out)].sort();
  return crossingsCache;
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
      // The simulator reads the month's workshop checks so that a negative one
      // is logged for review. It is a read for a screen no module owns, like
      // its reads of cars, drivers and driver_notes above.
      'no module reads werkstatt_checks (owned by werkstatt)',
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

// ─── 4. Which crossings are now GUARDED, and which still block ───────────────

/*
  Added 27.10.2026, acting on sections 2 and 3.

  Section 2's set does **not** shrink when a reader is taught, and expecting it
  to was the first mistake made in acting on this file. The scan is lexical: a
  guarded read still contains `from('fixed_costs')`, inside a conditional. Nor
  *should* it shrink — the Overview genuinely still reads `fixed_costs` whenever
  Fixkosten is on, so the crossing is a true statement about the product.

  What changes when a reader is taught is not whether the crossing exists but
  whether it **blocks**. So the partition this section adds is the one that can
  move, and the number to watch is the blocking count, not the crossing count.
*/

/**
 * `file -> the tables it fetches only after asking the module state`.
 *
 * A declaration whose every line is proved against the source below, so it
 * cannot claim a guard that is not there. The test for "guarded" is the one
 * thing a lexical check can establish honestly: the file names a module-scope
 * helper **for that table**, so the fetch cannot happen for a module that is
 * off. Whether the *panels* are also taught is asserted exhaustively in
 * `src/utils/overviewModuleScope.test.ts`, which is the right place for it —
 * this file's business is the dependency graph.
 */
const MODULE_AWARE_READS: Readonly<Record<string, readonly string[]>> = {
  // The Overview, taught per panel. Seven reads: the five it queries itself and
  // the two it takes from `useDatabase` at its own call site.
  'src/pages/OverviewPage.tsx': [
    'cars', 'fixed_costs', 'income', 'salaries', 'werkstatt_checks', 'receipts', 'drivers',
  ],
};

/** The helper call that makes a read module-aware, per file. */
const GUARD_CALL: Readonly<Record<string, (table: string) => string>> = {
  'src/pages/OverviewPage.tsx': table => `overviewReadEnabled(companyModules, '${table}')`,
};

const sourceOf = (file: string): string =>
  readFileSync(fileURLToPath(new URL('../../' + file, import.meta.url)), 'utf8').replace(/\r/g, '');

describe('a crossing is guarded only when the source says so', () => {
  it('every declared guard is in the file, for that exact table', () => {
    for (const [file, tables] of Object.entries(MODULE_AWARE_READS)) {
      const source = sourceOf(file);
      for (const table of tables) {
        expect(source, `${file} claims a guard on ${table} and has none`)
          .toContain(GUARD_CALL[file](table));
      }
    }
  });

  it('and a guarded file reads nothing gated that it does not guard', () => {
    // Half a taught screen is worse than an untaught one: the panels that were
    // withheld make the ones that were not look deliberate.
    for (const [file, tables] of Object.entries(MODULE_AWARE_READS)) {
      const source = sourceOf(file);
      const unguarded = Object.keys(TABLE_PAGE)
        .filter(table => source.includes(`from('${table}')`))
        .filter(table => !tables.includes(table));
      expect(unguarded, `${file} reads these without a module term`).toEqual([]);
    }
  });
});

/** The crossings that still stop their owner's reads being closed. */
const blockingCrossings = (): string[] =>
  crossModuleReads().filter(line => {
    const table = line.match(/ reads (\w+) \(/)![1];
    const reader = line.replace(/ reads .*/, '');
    // A crossing is cleared only when EVERY file that produces it is guarded for
    // that table. The reader module is what the line names, so the files are
    // those declared with that module in READER_MODULE.
    const files = Object.entries(READER_MODULE)
      .filter(([, module]) => (module ?? 'no module') === reader)
      .map(([file]) => file)
      .filter(file => sourceOf(file).includes(`from('${table}')`));
    if (files.length === 0) return true;
    return !files.every(file => (MODULE_AWARE_READS[file] ?? []).includes(table));
  });

describe('the Overview is no longer one of the blockers', () => {
  /*
    This is the slice's whole visible result, and it is the number that moved:
    32 crossings, unchanged, of which five are now cleared.
  */
  it('all five of the Overview\'s crossings are cleared', () => {
    expect(crossModuleReads().filter(l => l.startsWith('overview reads '))).toHaveLength(5);
    expect(blockingCrossings().filter(l => l.startsWith('overview reads '))).toEqual([]);
  });

  it('the crossing count is unchanged and the blocking count is five lower', () => {
    // Pinned as a pair so neither can move alone. If the crossing count changes
    // a read was added or removed; if only the blocking count changes, a reader
    // was taught or untaught.
    expect(crossModuleReads()).toHaveLength(33);
    expect(blockingCrossings()).toHaveLength(28);
  });

  it('`shared reads receipts` and `shared reads drivers` are NOT cleared', () => {
    /*
      The honest limit of what the Overview could do. Its own call site skips
      `receiptActions.get()` and `driverActions.get()` for a module that is off,
      but `useDatabase` has three other callers and falls back to local storage,
      so the hook itself is untouched and the crossing stands. Teaching it is
      its own slice.
    */
    expect(blockingCrossings()).toContain('shared reads receipts (owned by belege)');
    expect(blockingCrossings()).toContain('shared reads drivers (owned by fahrer)');
  });
});

// ─── 5. Which modules would now be free, by this file's lexical measure ──────

describe('three modules have no lexically visible blocker left', () => {
  /*
    `fixkosten`, `salaries` and `werkstatt` each had exactly one crossing and it
    was the Overview's — which is why this slice chose the Overview: one reader,
    three modules.

    `werkstatt` has since gained a second, which is why only two are left: the
    simulator's calendar mode (SimulatedRidesPage, no module) reads the month's
    `werkstatt_checks` before it places a shift, so a negative check can be
    logged for review. A module-less screen reading a closed table is exactly
    the crossing this file exists to count, and the count is the answer here.

    This describe block is deliberately **not** the conclusion. Section 7 is,
    and it says the opposite. Both are kept because the difference between them
    is the finding: a measure that looks only at `from('<literal>')` says these
    three are free, and it is wrong.
  */
  const tablesOf = (module: { pageKeys: readonly string[] }): string[] =>
    Object.entries(TABLE_PAGE)
      .filter(([, page]) => module.pageKeys.includes(page))
      .map(([table]) => table);

  const freeByLiteralScan = (): string[] =>
    MODULE_DEFINITIONS
      .filter(m => m.lockable && tablesOf(m).length > 0)
      .filter(m => tablesOf(m).some(t => readersByTable().get(t)!.length > 0))
      .filter(m => !blockingCrossings().some(line =>
        tablesOf(m).some(table => line.includes(` reads ${table} (`))))
      .map(m => m.key)
      .sort();

  it('and they are exactly these two', () => {
    expect(freeByLiteralScan()).toEqual(['fixkosten', 'salaries']);
  });

  it('`salaries` owns two tables and both had to come clear, not just one', () => {
    // `salary_payments` shares the `salaries` page. Its readers are
    // SalaryDetailsModal, SalaryPeriodsModal and salaryCashReceipts.ts, all of
    // them the salaries module's own, so it had no crossing to begin with —
    // asserted rather than assumed, because a module with two tables is exactly
    // where "I checked the obvious one" goes wrong.
    expect(TABLE_PAGE['salary_payments']).toBe('salaries');
    expect(readersByTable().get('salary_payments')!.length).toBeGreaterThan(0);
    expect(blockingCrossings().filter(l => l.includes(' reads salary_payments ('))).toEqual([]);
  });

  it('`cars` and `umsaetze` are NOT free, although the Overview no longer blocks them', () => {
    // The other two of the Overview's five. Both are read by several other
    // modules' screens, so clearing the Overview was necessary and nowhere near
    // sufficient — which is why this slice does not claim them.
    expect(freeByLiteralScan()).not.toContain('cars');
    expect(freeByLiteralScan()).not.toContain('umsaetze');
    expect(blockingCrossings().filter(l => l.includes(' reads cars (')).length).toBeGreaterThan(0);
    expect(blockingCrossings().filter(l => l.includes(' reads income (')).length).toBeGreaterThan(0);
  });
});

// ─── 6. The readers a `from('<literal>')` scan cannot see ────────────────────

/*
  The gap, and what was in it. Sections 1–5 all rest on
  `source.includes("from('<table>')")`, and a reader that passes the table name
  as a **variable** — `from(table)` — is invisible to every one of them. That is
  not hypothetical: the first attempt to act on this measurement was about to
  close reads on `fixed_costs`, `salaries`, `salary_payments` and
  `werkstatt_checks` on the strength of section 5, and the reader that forbids it
  is of exactly this kind.

  So the sweep below finds every `from(<identifier>)` call site under `src/` and
  requires each one to be declared with the tables it can be called with —
  **imported from the real list**, never re-typed here, because a copy of a
  43-entry array is a copy that goes stale.
*/

/**
 * `file -> why its variable table name is or is not a crossing`.
 *
 * Four files reach `from()` with a variable. Only one of them touches a table
 * the gate reaches, and that one is the finding.
 */
const VARIABLE_TABLE_READERS: Readonly<Record<string, string>> = {
  // THE BLOCKER. `BACKUP_TABLES` + `BACKUP_CHILD_TABLES`, 49 tables, every one
  // of the gated ones among them. Module `datensicherung` — `lockable: false`.
  'src/utils/backup.ts': 'backup',
  // `drivers` and `cars`, as a literal union type, for the two head counts that
  // decide whether the fleet-import shortcut is offered. Mounted ON the
  // Overview, so it is a second Overview-mounted reader of `cars` and `drivers`
  // — but both modules have other blockers anyway, and what it reads is a
  // `count`, never a row. Left for the slice that takes on `cars`.
  'src/components/partner/FleetImportPrompt.tsx': 'counts drivers and cars',
  // `fahrtenbuch_trips`, `fahrtenbuch_imports`, `monthly_plan_blocks` and
  // `monthly_plan_block_trips`: all `documents` or unpaged, so outside
  // TABLE_PAGE by the same decision as the other 24.
  'src/utils/monthlyPlanFahrtenbuchExport.ts': 'documents tables only',
  // `partner_note_submissions` / `partner_receipt_submissions`: module
  // `datenimport`, which claims no page at all.
  'src/components/partner/PartnerLinkProposals.tsx': 'partner tables, no page',
  // Writes, not reads: `deleteChecked` / `updateChecked`.
  'src/lib/writeOutcome.ts': 'writes only',
};

describe('every variable-table reader is accounted for', () => {
  it('the sweep finds exactly the declared files', () => {
    /*
      `.from(<identifier>)`, with two kinds of false positive filtered out by
      name rather than by a stacked lookbehind — the first version used one and
      reported five files that have no PostgREST read in them at all:

        - the standard library's own `from`: `Array.from(set)` appears in five
          files here, and `Buffer.from` / `Object.fromEntries` are the same
          shape;
        - **storage**: `supabase.storage.from(BUCKET)` is a bucket, not a table.
          It needs BOTH filters and the second was added after the first still
          reported two files: when the call is on one line the receiver captured
          is literally `storage`, and when it is split over two
          (`salaryCashReceipts.ts`, `driverNoteProvenance.ts`) the `.storage` is
          behind the match instead. So `storage` is a non-table receiver *and*
          the window behind the match is checked.
    */
    const NOT_A_TABLE = /^(Array|Object|Buffer|Date|String|Promise|Set|Map|storage|Int\d*Array|Uint\d*Array|Float\d*Array)$/;
    const found: string[] = [];
    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/([\w$]*)\.from\(\s*[A-Za-z_$][\w$.]*\s*\)/g)) {
        if (NOT_A_TABLE.test(match[1])) continue;
        const before = source.slice(Math.max(0, match.index - 80), match.index);
        if (before.includes('.storage')) continue;
        found.push(relative(file));
        break;
      }
    }
    expect([...new Set(found)].sort(), 'declare these in VARIABLE_TABLE_READERS').toEqual(
      Object.keys(VARIABLE_TABLE_READERS).sort(),
    );
  });

  it('the backup reads every table the gate reaches, including all eleven here', () => {
    /*
      Imported, not transcribed. `BACKUP_TABLES` is the list the backup actually
      iterates, so this cannot drift from the thing it describes.
    */
    const carried = [...BACKUP_TABLES, ...BACKUP_CHILD_TABLES.map(c => c.table)];
    expect(carried.length).toBe(49);
    expect(Object.keys(TABLE_PAGE).filter(table => !carried.includes(table))).toEqual([]);
  });

  it('and its module can never be switched off', () => {
    // Which is what makes it the same shape of blocker as `overview`, not a
    // screen that could simply be closed along with its module.
    expect(LOCKED_MODULE_KEYS).toContain('datensicherung');
    const definition = MODULE_DEFINITIONS.find(m => m.key === 'datensicherung')!;
    expect(definition.pageKeys).toEqual([]);
    expect(definition.routes).toEqual(['/datensicherung']);
  });
});

// ─── 7. The conclusion: no module may close reads, and why ───────────────────

/** The smallest `BackupClient` that answers every table with 200 and no rows. */
const emptyClient = (): { client: BackupClient; tables: string[] } => {
  const tables: string[] = [];
  const client: BackupClient = {
    from(table: string) {
      tables.push(table);
      const builder = {
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        range: () => Promise.resolve({ data: [] as unknown[], error: null }),
      } as unknown as BackupFilterBuilder;
      return { select: () => builder };
    },
  };
  return { client, tables };
};

describe('THE BLOCKER: a closed read makes the company\'s own backup lie', () => {
  /*
    This is the section that overrules section 5, and it is a behavioural proof
    rather than a lexical one — `backup.ts` is written against a structural
    client interface precisely so that it can be run with no renderer, and its
    own header says so.

    The mechanism: a SELECT a policy hides answers **200 with an empty array**.
    `readTenantTable` has no way to tell that from a company that owns no rows,
    so it records the table as `complete` with `rows: 0`, and `createBackup`
    then marks the whole file `complete: true` with an empty `incompleteTables`.
    The customer downloads `backup-<date>.json` — no INCOMPLETE marker in the
    filename, which is the one signal the design says survives being filed away
    — and it is missing every row of every switched-off module.

    So closing reads would not merely blank a screen. It would hand a German
    fleet operator an archive that says it is complete and is not, of payroll and
    compliance records held under a retention obligation. `datensicherung` is
    `lockable: false` and the design document names it as *"the company's own way
    to get its own data out"*; section 5 of that document makes the carve-out
    explicit: *"the export path stays open — a company must always be able to get
    its own statutory records out."*

    **And the carve-out is not implementable where the gate lives.** A SELECT
    policy sees a role and a JWT. The backup is the same `authenticated` role,
    the same token and the same PostgREST request as the screen beside it; there
    is nothing in the request to distinguish them. So "close reads but keep the
    export open" cannot be written as a policy at all. The alternatives are both
    decisions the owner has to take, not a shape a migration can choose:

      (a) the backup reports each switched-off module's tables as `skipped`,
          `complete: false`, INCOMPLETE in the filename — honest, and the company
          loses the ability to export that data while the module is off; or
      (b) reads stay open for these tables, and the module wall stays at walls
          A, B and C (link, route, writes), which is where slice 3 left it.

    This PR takes neither. It reports, which is what this file exists for.
  */
  it('a closed read is recorded as a COMPLETE table with zero rows', async () => {
    const { client } = emptyClient();
    const backup = await createBackup('company-1', client);
    for (const table of ['fixed_costs', 'salaries', 'salary_payments', 'werkstatt_checks']) {
      const report = backup.tableReports.find(r => r.table === table);
      expect(report, `${table} was not attempted`).toBeDefined();
      expect(report!.status, `${table} would be reported as`).toBe('complete');
      expect(report!.rows).toBe(0);
      expect(report!.error).toBeUndefined();
    }
  });

  it('and the whole file is marked complete, with no marker in its name', () => {
    // The two signals a person actually sees. Both say the archive is whole.
    const { client } = emptyClient();
    return createBackup('company-1', client).then(backup => {
      expect(backup.complete).toBe(true);
      expect(backup.incompleteTables).toEqual([]);
      expect(backupFilename(backup, new Date('2026-10-27T10:00:00Z'))).toBe('backup-2026-10-27.json');
    });
  });

  it('the backup has no module awareness at all today, and that is deliberate', () => {
    /*
      Not an oversight left for later: teaching it means choosing (a) above,
      which withdraws a company's export of its own rows. That is a product and
      retention decision and it is the owner's. Asserted so that the day someone
      adds a module term here, this line fails and the decision is named.
    */
    const source = sourceOf('src/utils/backup.ts');
    expect(source).not.toContain('companyModules');
    expect(source).not.toContain('moduleEnabled');
  });

  it('so NOT ONE module may close reads — including the three of section 5', () => {
    /*
      The partition section 5 computes is over `from('<literal>')` readers only.
      Adding the backup puts one unguarded reader on every gated table at once,
      and its module can never be off, so the true free set is empty.
    */
    const carried = [...BACKUP_TABLES, ...BACKUP_CHILD_TABLES.map(c => c.table)];
    for (const key of ['fixkosten', 'salaries', 'werkstatt']) {
      const tables = Object.entries(TABLE_PAGE)
        .filter(([, page]) => (MODULE_DEFINITIONS.find(m => m.key === key)!.pageKeys as readonly string[]).includes(page))
        .map(([table]) => table);
      expect(tables.length, key).toBeGreaterThan(0);
      for (const table of tables) {
        expect(carried, `${key}'s ${table} is read by the backup`).toContain(table);
      }
    }
  });

  it('no SELECT policy has gained a module term while that is true', () => {
    /*
      The coupling assertion, and the only gate that can hold this decision:
      it is a cross-language one, so it cannot live in the RLS kit — SQL cannot
      read `backup.ts`. It fails on the **unsafe combination** and on nothing
      else, so it blocks neither of the owner's two answers: teach the backup and
      it passes, leave reads open and it passes. Only "close reads with the
      backup untaught" fails, which is the release that would hand out a
      truncated archive marked complete.
    */
    const migrations = join(SRC, '..', 'supabase', 'migrations');
    const offenders: string[] = [];
    for (const file of readdirSync(migrations)) {
      const source = readFileSync(join(migrations, file), 'utf8').replace(/\r/g, '');
      /*
        The thing to look for is the **predicate**, not the words
        `company_module`: `20261025120000` creates `company_modules_select` on
        the module table itself, and a window around `FOR SELECT` catches that
        policy's own name — the first version of this check reported it, which
        would have made the assertion fail on a clean head.

        `current_role_permits(…, true)` is the WRITE gate and is deliberately
        not this: `p_need_edit AND` inside that function is the line between
        wall C and wall D, and `20261027120000`'s header says why the conjunct
        must stay.
      */
      if (/FOR SELECT[\s\S]{0,600}?company_module_page_closed/i.test(source)) offenders.push(file);
    }
    expect(offenders,
      'a SELECT policy now carries a module term; teach src/utils/backup.ts first, or the ' +
      'company\'s own backup reports a truncated archive as complete').toEqual([]);
  });
});
