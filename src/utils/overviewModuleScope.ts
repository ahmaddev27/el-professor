/**
 * Which of the Overview's panels a switched-off module takes away, and which of
 * its queries it stops issuing.
 *
 * ## Why this file exists
 *
 * `overview` is the one module that is `lockable: false` **and** reads other
 * modules' tables. `src/lib/moduleReadScope.test.ts` measured that and named it
 * the first of two structural blockers on closing reads at all: there is no
 * company configuration in which the Overview is absent (`path="*"` redirects
 * there, and it is the one feature `planAllows()` exempts from the subscription
 * check), so a figure it computes from a disabled module's rows is reached by
 * every customer, on the first screen they see.
 *
 * The measurement left exactly two options and no third: exempt the Overview
 * from those modules, or teach it per panel. Exempting it means a module is off
 * and its figures still show on the home screen, which is the opposite of what
 * the owner asked for on 27.10.2026 — *"بديش المستخدم يصل لأي موديول بأي طريقة
 * للموديول المقفل"*, a user must not reach a switched-off module by any means.
 * So: per panel.
 *
 * ## The rule, and why it is not "did the read return rows"
 *
 * A panel is unavailable when **any module whose rows its figures are computed
 * from is off** — decided from the module state, never from the shape of the
 * answer. Three reasons, in increasing order of how expensive the alternative
 * is:
 *
 *   1. **A zero is a claim.** The codebase's standing rule (`writeOutcome.ts`,
 *      CLAUDE.md, and the four failure states phase 5 batch 2 added) is that an
 *      empty list and a total of 0,00 € are statements about a customer's money.
 *      A panel that renders 0 because its source was closed is a false one.
 *   2. **Three of these panels are wrong rather than blank.** `profit` is
 *      `umsatz − salaries − expenses − fixedCosts`, so a missing *cost* term
 *      **overstates** it; `totalCosts` understates; `cash` understates what left
 *      the till. None of the three goes to zero, so none of them looks wrong.
 *      That is the whole reason this is decided before the arithmetic rather
 *      than after it.
 *   3. **It must not depend on whether the policy closed.** If the test were
 *      "the read came back empty", the Overview would be correct only while the
 *      database agreed with it, and the two would have to be kept in step
 *      release by release. Reading the module state is the same answer whether
 *      the read is closed, open, or closed later.
 *
 * So this is correct **ahead of** any policy change, which is the order the
 * design document requires: *"every reading screen is retaught before any
 * policy changes, not after"* (`Docs/design/per-company-modules.md`, section 5,
 * the minimum safe form).
 *
 * ## What it deliberately does not do
 *
 * It does not hide a panel. A panel whose module is off renders a stated
 * reason naming the module, because a panel that simply vanished would be the
 * same silence in a different shape: the customer cannot tell a figure that was
 * withheld from one that was never there. `ModuleOffNotice` is what it renders.
 *
 * It also does not touch a **locked** module. `user_profiles` (module `users`)
 * and the Gehaltsquittung ledger (`cash_movements`, which no module claims) are
 * read by the Overview and appear in no panel's dependency list, because no
 * operator decision can take them away.
 */
import { moduleEnabled, moduleForRoute, type CompanyModuleKey, type CompanyModules } from '../lib/companyModules';

/**
 * The tables the Overview queries **itself**, and the module whose rows each
 * one holds.
 *
 * Declared here and cross-checked twice rather than derived: the page a table's
 * policies name is a `format()` variable inside migration 20260917130000's
 * catalogue loop, so no import can recover it, and `overviewModuleScope.test.ts`
 * therefore reads that migration and `MODULE_DEFINITIONS` and fails when either
 * disagrees with a line below.
 *
 * Two of the Overview's seven queries are absent on purpose:
 *
 *   - `user_profiles` — module `users`, `lockable: false`.
 *   - `cash_movements` — the Gehaltsquittung ledger, which **no** page and so no
 *     module claims (`20260917130000` gives it SELECT and nothing else, and its
 *     three writers are the Gehaltsquittung RPCs). Its own guard is
 *     `cashLedgerInScope`, which is about a support session, not a module.
 */
export const OVERVIEW_OWN_READS = {
  cars:             'cars',
  fixed_costs:      'fixkosten',
  income:           'umsaetze',
  salaries:         'salaries',
  werkstatt_checks: 'werkstatt',
} as const satisfies Readonly<Record<string, CompanyModuleKey>>;

export type OverviewOwnReadTable = keyof typeof OVERVIEW_OWN_READS;

/**
 * The two tables the Overview's figures also come from, fetched through
 * `useDatabase` rather than by a query the Overview writes itself.
 *
 * They are a separate map because the **hook** is shared — `useDatabase` serves
 * four screens and falls back to local storage — so nothing may be changed
 * inside it on the Overview's behalf. What the Overview can do, and does, is
 * not *call* the getter: the call site is its own, so skipping it issues no
 * request and leaves the other three screens untouched.
 *
 * They belong in a panel's dependency list for the same reason as the five
 * above: a dependency is about **where a figure comes from**, not about who
 * fetched it. `profit` subtracts receipt expenses either way.
 */
export const OVERVIEW_HOOK_READS = {
  drivers:  'fahrer',
  receipts: 'belege',
} as const satisfies Readonly<Record<string, CompanyModuleKey>>;

export type OverviewHookReadTable = keyof typeof OVERVIEW_HOOK_READS;

/** Every table the Overview's figures are computed from, however it is fetched. */
export type OverviewReadTable = OverviewOwnReadTable | OverviewHookReadTable;

/**
 * One panel of the Overview, named by what it claims rather than by where it
 * sits, so moving a card does not rename a dependency.
 *
 * The list is exhaustive over every panel that renders a **figure, a list or a
 * chart**. `quickActions` and the header are absent because they render links
 * and a month picker and compute nothing.
 */
export type OverviewPanelKey =
  | 'insights'
  | 'kpiUmsatz'
  | 'kpiBargeld'
  | 'kpiSalaries'
  | 'kpiTotalCosts'
  | 'kpiProfit'
  | 'kpiMargin'
  | 'alertsSalaries'
  | 'alertsFleet'
  | 'alertsTuev'
  | 'trend'
  | 'revenueMix'
  | 'profitBreakdown'
  | 'cash'
  | 'driverChart'
  | 'driverRanking'
  | 'topExpenses'
  | 'fleet'
  | 'unpaidSalaries'
  | 'recentReceipts';

/**
 * `panel -> the modules whose rows its figures are computed from`.
 *
 * Read against `overviewHelpers.ts`, which is where the arithmetic is:
 *
 *   - `calcPeriodMetrics(incomes, salaries, receipts, fixedCosts, …)` is the
 *     source of every KPI, the profit breakdown and the cost total. Its four
 *     inputs are four modules, which is why `kpiProfit`, `kpiMargin`,
 *     `profitBreakdown` and `trend` name all four: **profit subtracts three of
 *     them**, so any one missing moves the figure without emptying it.
 *   - `calcCashSummary(incomes, receipts, …, movements)` is the till: Bargeld in,
 *     Belege out. `cash_movements` adds no module (see `OVERVIEW_OWN_READS`).
 *   - `calcDriverPerformance(drivers, incomes, salaries, receipts, …)` and
 *     `calcSalaryAlerts(salaries, drivers)` are the two driver panels.
 *   - `getTopExpenses(receipts, fixedCosts, …)` is the cost list, and its footer
 *     prints `currentMetrics.totalCosts`.
 *   - `generateInsights(current, prev, driverPerformance, salaryAlerts,
 *     werkstattChecks)` reads **everything**, which is why `insights` names six
 *     modules and is the panel most often withheld. That is the honest answer:
 *     an insight is a sentence about a comparison, and a comparison over a term
 *     that was not read is a sentence that is simply untrue.
 *
 * `alertsTuev` is `cars` alone: it reads `tuev_gueltig_bis` off the vehicle and
 * no money.
 */
export const OVERVIEW_PANEL_MODULES = {
  insights:        ['belege', 'fahrer', 'fixkosten', 'salaries', 'umsaetze', 'werkstatt'],
  kpiUmsatz:       ['umsaetze'],
  kpiBargeld:      ['umsaetze'],
  kpiSalaries:     ['salaries'],
  kpiTotalCosts:   ['belege', 'fixkosten'],
  kpiProfit:       ['belege', 'fixkosten', 'salaries', 'umsaetze'],
  kpiMargin:       ['belege', 'fixkosten', 'salaries', 'umsaetze'],
  alertsSalaries:  ['fahrer', 'salaries'],
  alertsFleet:     ['werkstatt'],
  alertsTuev:      ['cars'],
  trend:           ['belege', 'fixkosten', 'salaries', 'umsaetze'],
  revenueMix:      ['umsaetze'],
  profitBreakdown: ['belege', 'fixkosten', 'salaries', 'umsaetze'],
  cash:            ['belege', 'umsaetze'],
  driverChart:     ['belege', 'fahrer', 'salaries', 'umsaetze'],
  driverRanking:   ['belege', 'fahrer', 'salaries', 'umsaetze'],
  topExpenses:     ['belege', 'fixkosten'],
  fleet:           ['werkstatt'],
  unpaidSalaries:  ['fahrer', 'salaries'],
  recentReceipts:  ['belege'],
} as const satisfies Readonly<Record<OverviewPanelKey, readonly CompanyModuleKey[]>>;

/**
 * The modules this panel needs that are off for this company, in the order
 * `OVERVIEW_PANEL_MODULES` lists them — which is alphabetical, so the sentence
 * the notice builds is stable rather than dependent on the map's iteration.
 *
 * Empty means the panel renders its figures. `moduleEnabled` is the registry's
 * one reader of the state and carries both fail-open rules: a module with no
 * stored decision is on, and so is a key this build does not know.
 */
export function overviewPanelOffModules(
  modules: CompanyModules,
  panel: OverviewPanelKey,
): readonly CompanyModuleKey[] {
  return OVERVIEW_PANEL_MODULES[panel].filter(key => !moduleEnabled(modules, key));
}

/** Whether this panel may render its figures at all. */
export function overviewPanelAvailable(modules: CompanyModules, panel: OverviewPanelKey): boolean {
  return overviewPanelOffModules(modules, panel).length === 0;
}

/**
 * Whether the Overview should fetch `table` at all.
 *
 * False is **not** an optimisation and must not be read as one: it is what
 * stops the Overview holding rows of a module the customer does not have. The
 * panels are withheld by `overviewPanelOffModules` either way, so skipping the
 * fetch changes no figure — what it changes is that the rows never arrive, so a
 * panel added later cannot quietly start computing from them, and the request
 * is not made.
 *
 * One function over both maps, because the page asks the same question of all
 * seven reads and a second nearly identical function is how the two halves
 * start to disagree.
 */
export function overviewReadEnabled(modules: CompanyModules, table: OverviewReadTable): boolean {
  const key = table in OVERVIEW_OWN_READS
    ? OVERVIEW_OWN_READS[table as OverviewOwnReadTable]
    : OVERVIEW_HOOK_READS[table as OverviewHookReadTable];
  return moduleEnabled(modules, key);
}

/**
 * The Overview's whole module surface: every module it reads rows from, own
 * queries and hook alike, sorted.
 *
 * This is the set `moduleReadScope.test.ts` pins as the Overview's crossings, so
 * the two halves of the same fact cannot drift: a module added to a panel above
 * but to no read, or to a read but to no panel, fails there.
 */
export const OVERVIEW_MODULE_SURFACE: readonly CompanyModuleKey[] = [
  ...new Set<CompanyModuleKey>([
    ...Object.values(OVERVIEW_OWN_READS),
    ...Object.values(OVERVIEW_HOOK_READS),
  ]),
].sort();

/**
 * `overview` itself, as the registry spells it — used by the test to assert the
 * premise this whole file rests on (that the module can never be off).
 *
 * Taken through `moduleForRoute` rather than written as a string, so a release
 * that moves the Overview's path has to come past here.
 */
export const OVERVIEW_MODULE_KEY: string = moduleForRoute('/overview')?.key ?? 'overview';
