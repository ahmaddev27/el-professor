/**
 * Per-company sidebar modules (Docs/design/per-company-modules.md, section 3).
 *
 * A platform operator turns one sidebar module off for one company. The state
 * is `public.company_modules`, written only by `platform_company_set_module`.
 * This file is the registry: **one entry per sidebar entry**, because that is
 * the thing the owner pointed at and the thing an operator recognises.
 *
 * **Absence of a row means the module is ON.** The table stores decisions to
 * *subtract*, so no decision means no subtraction, and every reader here uses
 * `enabled !== false`. This is deliberately not `plan_features`' rule, where a
 * feature the map does not name reads as **premium** — fail-closed. Copying
 * that here would mean a company with no rows had every module switched off,
 * which is every existing customer dark on deploy day. It is `useFlag`'s logic
 * read correctly rather than copied: for a flag, absent and off are the same
 * state; for a subtraction, absent and "not subtracted" are the same state.
 *
 * **A map that could not be read at all also means ON.** Fail-open, matching
 * `UNRESOLVED_PLAN_STATE` in `planState.ts` and `AppConfigContext`, both of
 * which say why in their own headers: a restrictive placeholder would flash a
 * locked screen over every page load. It is safe for the same reason the plan
 * gate is — the browser is not the boundary. One honest caveat, which couples
 * two slices: until slice 3 puts the write term in `current_role_permits()`,
 * the browser *is* the only module wall, and a failed read hands out a module
 * until the next successful load. The plan gate has exactly that exposure today
 * and always will, so a module gate with the opposite failure mode would be the
 * odd one out.
 *
 * ── Why the four columns are declared and not derived ──────────────────────
 *
 * `FeatureKey` (16), `page_key` (16) and the sidebar paths (22) are three
 * different lists with no bijection between them:
 *
 *   - six sidebar entries share one `FeatureKey` (`dokumente`), and two more
 *     routes (`/stundennachweis`, `/fahrtenanalyse`) share it with no sidebar
 *     entry of their own;
 *   - `page_key` has two entries no sidebar entry owns (`statistics`,
 *     `accounting`);
 *   - `page_key` `documents` is the write gate of 24 tables;
 *   - `notification_settings` is gated by `is_company_admin()`, not by a page.
 *
 * So no one of them can produce the others, and `companyModules.test.ts` pins
 * each column against the thing it claims to name: `feature` against the real
 * `FeatureKey`, `routes` against the routes registered in `App.tsx`, `pageKeys`
 * against `PAGE_DEFINITIONS`, and the whole list against the real `NAV_ITEMS`
 * and `ADMIN_ITEMS`. **Adding a module is one entry here**, and the test names
 * whichever column is missing.
 *
 * The keys are also `app_private.company_module_keys()` in migration
 * 20261025120000, so the database can refuse a key the product does not have;
 * the test reads that migration and fails when the two lists differ, which is
 * `rolePageKeys.test.ts`' rule for the other list held in both places.
 *
 * **A key is not a path.** `company_modules.module_key` is checked against
 * `^[a-z][a-z0-9_]{0,59}$`, which allows no hyphen, so `/company-planner` is
 * the key `company_planner`. (The design document's section 6 lists the keys as
 * the paths; the CHECK in its own section 2 forbids that spelling.)
 */
import type { FeatureKey } from '../contexts/PlanContext';
import type { TranslationKey } from '../i18n';

/**
 * One sidebar entry the operator may switch off per company.
 *
 * `labelKey` is **the same key the sidebar renders**, so the operator and the
 * customer are looking at the same word. No `descriptionKey`: the panel row
 * draws the label, the raw key and one state line, and 22 unrendered
 * description keys in two dictionaries would be pure cost — which is the
 * reasoning `featureFlags.ts` gives for its own list, read in reverse.
 */
export interface ModuleDefinition {
  /** Stored in `company_modules.module_key`. No hyphen; see the header. */
  readonly key: string;
  /** The `labelKey` of this module's entry in `NAV_ITEMS` / `ADMIN_ITEMS`. */
  readonly labelKey: TranslationKey;
  /** The `FeatureKey` the plan gate asks. Several modules may share one. */
  readonly feature: FeatureKey;
  /**
   * The routes slice 2 will close. `routes[0]` is this module's sidebar path,
   * which is how a nav entry is matched to its module.
   */
  readonly routes: readonly string[];
  /**
   * The `role_permissions.page_key`s slice 3 will close. Empty where no page
   * owns the module's tables — `benachrichtigungen` (`notification_settings`
   * asks `is_company_admin()`), `billing`, `datensicherung`, and `datenimport`,
   * whose partner tables wait on slice 3's own survey.
   */
  readonly pageKeys: readonly string[];
  /** False: no checkbox, and the database refuses the write (`module_locked`). */
  readonly lockable: boolean;
}

/**
 * The 22 sidebar entries, in the order `Sidebar.tsx` draws them: `NAV_ITEMS`
 * first, then `ADMIN_ITEMS`.
 *
 * The six with `lockable: false` are the design's section 6. Two of them are
 * **deadlocks** rather than policy preferences, verified in `App.tsx` on this
 * branch: `billing`, because `SUBSCRIPTION_ALLOWED_PATHS` forces an inactive
 * company onto exactly `/abo-aktivieren`, `/aktivierung` and `/billing`, so
 * closing it leaves the company unable to pay and therefore unable to leave the
 * state; and `overview`, because `path="*"` navigates there and it is the one
 * feature `planAllows()` exempts from the subscription check. The other four
 * are the company's own levers over access (`users`, `roles`), its statutory
 * master data (`settings` holds the Bundesland, which selects the holiday table
 * the premium computation depends on) and its way to get its own data out
 * (`datensicherung`).
 */
export const MODULE_DEFINITIONS = [
  // ── NAV_ITEMS ──────────────────────────────────────────────────────────────
  { key: 'overview',           labelKey: 'nav.overview',       feature: 'overview',            routes: ['/overview'],           pageKeys: ['overview'],      lockable: false },
  { key: 'belege',             labelKey: 'nav.belege',         feature: 'belege',              routes: ['/belege'],             pageKeys: ['receipts'],      lockable: true },
  { key: 'fahrer',             labelKey: 'nav.fahrer',         feature: 'fahrer',              routes: ['/fahrer'],             pageKeys: ['drivers'],       lockable: true },
  { key: 'cars',               labelKey: 'nav.cars',           feature: 'fahrzeuge',           routes: ['/cars'],               pageKeys: ['cars'],          lockable: true },
  { key: 'umsaetze',           labelKey: 'nav.umsaetze',       feature: 'umsaetze',            routes: ['/umsaetze'],           pageKeys: ['income'],        lockable: true },
  { key: 'fixkosten',          labelKey: 'nav.fixkosten',      feature: 'fixkosten',           routes: ['/fixkosten'],          pageKeys: ['fixed-costs'],   lockable: true },
  { key: 'bargeldbestand',     labelKey: 'nav.bargeldbestand', feature: 'bargeldbestand',      routes: ['/bargeldbestand'],     pageKeys: ['cash-balance'],  lockable: true },
  { key: 'werkstatt',          labelKey: 'nav.werkstatt',      feature: 'werkstatt',           routes: ['/werkstatt'],          pageKeys: ['werkstatt'],     lockable: true },
  // `accounting` names no table: the Abrechnung RPCs are SECURITY INVOKER over
  // income / receipts / cash_transactions, so this module is link + route only.
  { key: 'abrechnung',         labelKey: 'nav.abrechnung',     feature: 'abrechnung',          routes: ['/abrechnung'],         pageKeys: ['accounting'],    lockable: true },
  { key: 'notes',              labelKey: 'nav.notes',          feature: 'notizen',             routes: ['/notes'],              pageKeys: ['notes'],         lockable: true },
  // notification_settings' writes ask is_company_admin(), which is not
  // page-keyed, so no page closes with this module.
  { key: 'benachrichtigungen', labelKey: 'nav.notifications',  feature: 'benachrichtigungen',  routes: ['/benachrichtigungen'], pageKeys: [],                lockable: true },
  { key: 'salaries',           labelKey: 'nav.salaries',       feature: 'gehaelter',           routes: ['/salaries'],           pageKeys: ['salaries'],      lockable: true },
  // The four `documents` modules share one page key, which gates 24 tables.
  // The link and the route are per entry; the tables are not — so switching one
  // off hides a screen and switching all four off is what closes the tables.
  // `pagesClosedByDisabling` is what the panel row says that with.
  { key: 'dokumente',          labelKey: 'nav.documents',      feature: 'dokumente',           routes: ['/dokumente', '/dokumente/:id', '/dokumente/:id/bearbeiten'], pageKeys: ['documents'], lockable: true },
  { key: 'fahrtenbuch',        labelKey: 'doc.fahrtenbuch',    feature: 'dokumente',           routes: ['/fahrtenbuch'],        pageKeys: ['documents'],     lockable: true },
  { key: 'company_planner',    labelKey: 'nav.planner',        feature: 'dokumente',           routes: ['/company-planner'],    pageKeys: ['documents'],     lockable: true },
  { key: 'monatsplan',         labelKey: 'nav.monthlyPlan',    feature: 'dokumente',           routes: ['/monatsplan'],         pageKeys: ['documents'],     lockable: true },

  // ── ADMIN_ITEMS ────────────────────────────────────────────────────────────
  { key: 'users',              labelKey: 'nav.users',          feature: 'rollen_nutzer',       routes: ['/users'],              pageKeys: ['users'],         lockable: false },
  { key: 'roles',              labelKey: 'nav.roles',          feature: 'rollen_nutzer',       routes: ['/roles'],              pageKeys: ['roles'],         lockable: false },
  // The partner import tables' gate is slice 3's own survey; declaring a page
  // key here that slice 3 then contradicts would be worse than declaring none.
  { key: 'datenimport',        labelKey: 'import.title',       feature: 'overview',            routes: ['/datenimport'],        pageKeys: [],                lockable: true },
  { key: 'datensicherung',     labelKey: 'bill.backup.title',  feature: 'overview',            routes: ['/datensicherung'],     pageKeys: [],                lockable: false },
  { key: 'billing',            labelKey: 'nav.billing',        feature: 'overview',            routes: ['/billing'],            pageKeys: [],                lockable: false },
  { key: 'settings',           labelKey: 'nav.settings',       feature: 'overview',            routes: ['/settings'],           pageKeys: ['settings'],      lockable: false },
] as const satisfies readonly ModuleDefinition[];

export type CompanyModuleKey = (typeof MODULE_DEFINITIONS)[number]['key'];

/** The keys this build knows, in the order the panel shows them. */
export const MODULE_KEYS: readonly string[] = MODULE_DEFINITIONS.map(m => m.key);

/** The six the database refuses to switch off (`module_locked`). */
export const LOCKED_MODULE_KEYS: readonly string[] = MODULE_DEFINITIONS
  .filter(m => !m.lockable)
  .map(m => m.key);

/** The definition of a module this build knows, or null. */
export function moduleDefinition(key: string): ModuleDefinition | null {
  return MODULE_DEFINITIONS.find(m => m.key === key) ?? null;
}

/** The module whose sidebar path or route is `path`, or null. */
export function moduleForRoute(path: string): ModuleDefinition | null {
  // `some` and not `routes.includes(path)`: the `as const` makes each entry's
  // routes a tuple of literals, so across the union `includes` narrows its
  // parameter to `never` and rejects a plain string.
  return MODULE_DEFINITIONS.find(m => m.routes.some(route => route === path)) ?? null;
}

// ─── The stored decisions ────────────────────────────────────────────────────

/**
 * The decisions stored for one company: `module_key -> enabled`. A key that is
 * absent carries no decision, which reads as on.
 */
export type CompanyModules = Readonly<Record<string, boolean>>;

/** No decision for any module — every module on. The fail-open value. */
export const NO_MODULE_DECISIONS: CompanyModules = Object.freeze({});

/** One row of `public.company_modules`, as the browser reads it. */
export interface CompanyModuleRow {
  module_key?: unknown;
  enabled?: unknown;
  note?: unknown;
  set_by?: unknown;
  set_at?: unknown;
}

/**
 * The decisions a query answered. A row whose key or flag is not what the
 * column says it is gets dropped rather than failing the whole map, for
 * `parseFeatureFlags`' reason: one bad row must not change the others.
 *
 * A key this build does not know is kept, not dropped. It cannot hide a module
 * (nothing reads it) and keeping it is what lets a newer release's row survive
 * a rollback — the failure `company_role_save` already pays for is a wholesale
 * save that *drops* what it did not recognise.
 */
export function parseCompanyModules(rows: readonly CompanyModuleRow[] | null | undefined): CompanyModules {
  if (!Array.isArray(rows)) return NO_MODULE_DECISIONS;
  const modules: Record<string, boolean> = {};
  for (const row of rows) {
    if (typeof row?.module_key !== 'string' || typeof row?.enabled !== 'boolean') continue;
    modules[row.module_key] = row.enabled;
  }
  return modules;
}

/** Whether a module is on for this company. Absent, or unknown: on. */
export function moduleEnabled(modules: CompanyModules, key: string): boolean {
  return modules[key] !== false;
}

/**
 * The sidebar's and the route gate's one term: whether the module that owns
 * `path` is on. A path no module owns is on — `/stundennachweis`,
 * `/fahrtenanalyse` and `/mein-konto` belong to no module, and a gate that read
 * an unowned path as off would close them all.
 */
export function moduleEnabledForRoute(modules: CompanyModules, path: string): boolean {
  const definition = moduleForRoute(path);
  return definition === null || moduleEnabled(modules, definition.key);
}

/**
 * The four gates of the design's section 0, composed. There is no precedence
 * and no override: any one saying no hides the module, which is Decision A.
 *
 * It takes the gates' **answers** rather than the state they are computed from.
 * The design document's signature was `(env, plan, modules, role, module)`,
 * which would mean a second copy of `planAllows()` and of the role answer
 * inside this file — the drift this codebase has already paid for twice. The
 * callers hold those answers already: `monthlyPlanInNav()`, `usePlan().can()`
 * and `useCompanyScope().can()`.
 */
export function moduleVisible(gates: {
  environmentShows: boolean;
  planAllows: boolean;
  moduleEnabled: boolean;
  roleCanView: boolean;
}): boolean {
  return gates.environmentShows && gates.planAllows && gates.moduleEnabled && gates.roleCanView;
}

// ─── What the panel row says ─────────────────────────────────────────────────

/**
 * The state of one module for one company — Decision A made visible.
 *
 * `plan_inert` is the whole of what remains of the warning the owner originally
 * asked for. It does not ask "are you sure" and offers no override, because
 * there is none: it says the toggle has no effect, and the panel names the plan
 * the company is on and the plan that would include the module. Such a toggle
 * is still **saved**, deliberately, so an operator can arm a module ahead of an
 * upgrade and it takes effect the moment the plan moves.
 */
export type ModuleState = 'locked' | 'active' | 'operator_off' | 'plan_inert' | 'plan_off';

export function moduleState(args: {
  lockable: boolean;
  planAllows: boolean;
  enabled: boolean;
}): ModuleState {
  if (!args.lockable) return 'locked';
  if (args.planAllows) return args.enabled ? 'active' : 'operator_off';
  return args.enabled ? 'plan_inert' : 'plan_off';
}

/**
 * The page keys that would stop being claimed by any enabled module if `key`
 * were switched off — what the panel row shows as "schließt Daten" rather than
 * "nur Ansicht".
 *
 * This **describes** slice 3's wall, it does not implement it. The wall is
 * `page is closed for a company ⟺ no enabled module maps to that page`, so a
 * page claimed by several modules closes only when all of them are off. That is
 * why switching off `/monatsplan` alone closes no table while switching off all
 * four `documents` entries closes 24 — correct, because `/dokumente` still
 * needs those same tables.
 *
 * A page claimed by a locked module can never appear here, because a locked
 * module can never be off; `companyModules.test.ts` asserts that.
 */
export function pagesClosedByDisabling(modules: CompanyModules, key: string): string[] {
  const target = moduleDefinition(key);
  if (!target || target.pageKeys.length === 0) return [];
  const stillClaimed = new Set<string>();
  for (const definition of MODULE_DEFINITIONS) {
    if (definition.key === key) continue;
    if (!moduleEnabled(modules, definition.key)) continue;
    for (const page of definition.pageKeys) stillClaimed.add(page);
  }
  return target.pageKeys.filter(page => !stillClaimed.has(page));
}
