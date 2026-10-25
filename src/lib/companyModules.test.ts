/**
 * The module registry against the three vocabularies it claims to name, and
 * against the database's copy of its keys.
 *
 * `MODULE_DEFINITIONS` declares four columns per module — `feature`, `routes`,
 * `pageKeys`, `lockable` — because `FeatureKey` (16), `page_key` (16) and the
 * sidebar paths (22) are three different lists and none of them can produce the
 * others (the registry's own header says how). Declared columns drift; that is
 * what this file is for. **Adding a module is one entry in the registry**, and
 * the failure below names whichever column was forgotten.
 *
 * The sidebar tables are read out of `Sidebar.tsx`'s source rather than
 * imported, for one reason: `NAV_ITEMS` and `ADMIN_ITEMS` are module-level
 * constants in a component file that pulls in five contexts and `lucide-react`,
 * and `/monatsplan` is in `NAV_ITEMS` only where `monthlyPlanInNav()` says so —
 * so an import would make this test's answer depend on `VITE_DEPLOY_ENV`. The
 * source carries all 22 entries whatever the environment, which is the list the
 * registry has to cover.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LOCKED_MODULE_KEYS,
  MODULE_DEFINITIONS,
  MODULE_KEYS,
  NO_MODULE_DECISIONS,
  moduleDefinition,
  moduleEnabled,
  moduleEnabledForRoute,
  moduleForRoute,
  moduleState,
  moduleVisible,
  pagesClosedByDisabling,
  parseCompanyModules,
} from './companyModules';
import { PAGE_DEFINITIONS } from '../types/role';
import { SEED_PLAN_FEATURES } from './appConfigSeed';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

// ─── the sidebar, out of its source ──────────────────────────────────────────

/** `{ path: '/x', … labelKey: 'nav.x', … }` for every entry of one table. */
const sidebarEntries = (table: 'NAV_ITEMS' | 'ADMIN_ITEMS'): { path: string; labelKey: string }[] => {
  const source = read('../components/Sidebar.tsx');
  const block = source.match(new RegExp(`const ${table}: NavItem\\[\\] = \\[([\\s\\S]*?)\\n\\];`));
  if (!block) throw new Error(`${table} not found in Sidebar.tsx`);
  // `/monatsplan` is spread in conditionally and its path and labelKey are on
  // one line like the rest, so one pattern reads both shapes.
  const entries = [...block[1].matchAll(/path:\s*(?:'([^']+)'|(FLEET_IMPORT_PATH))[\s\S]*?labelKey:\s*'([^']+)'/g)];
  return entries.map(match => ({
    // The one path that is a constant: `FLEET_IMPORT_PATH` in
    // partner/FleetImportShortcut.tsx. Resolved, not special-cased away, so a
    // change to its value fails here rather than silently un-covering a module.
    path: match[1] ?? fleetImportPath(),
    labelKey: match[3],
  }));
};

const fleetImportPath = (): string => {
  const source = read('../components/partner/FleetImportShortcut.tsx');
  const value = source.match(/export const FLEET_IMPORT_PATH = '([^']+)'/);
  if (!value) throw new Error('FLEET_IMPORT_PATH not found');
  return value[1];
};

const allSidebarEntries = () => [...sidebarEntries('NAV_ITEMS'), ...sidebarEntries('ADMIN_ITEMS')];

// ─── App.tsx's registered routes ─────────────────────────────────────────────

/**
 * Every `path=` in `App.tsx`, normalised without its leading slash. The
 * authenticated routes are nested under `/` and so are written relative
 * (`path="belege"`), while the registry declares the address a link points at
 * (`/belege`); stripping one slash from both sides is what compares them.
 */
const registeredRoutes = (): Set<string> => {
  const paths = [...read('../App.tsx').matchAll(/<Route\s+path="([^"]+)"/g)].map(m => m[1]);
  return new Set(paths.map(path => path.replace(/^\//, '')));
};

// ─── the database's copy of the keys ────────────────────────────────────────

const KEYS_IN_ARRAY = /FUNCTION app_private\.company_module_keys\(\)[\s\S]*?SELECT ARRAY\[([\s\S]*?)\]/;

/**
 * The keys in the newest migration that defines the function — the live one,
 * found by name order the way the migration chain itself resolves, rather than
 * named here. `rolePageKeys.test.ts`' idiom.
 */
const keysInMigration = (): string[] => {
  const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
  const defining = readdirSync(dir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => readFileSync(dir + file, 'utf8'))
    .filter(sql => KEYS_IN_ARRAY.test(sql));
  if (defining.length === 0) throw new Error('no migration defines app_private.company_module_keys()');
  const body = defining[defining.length - 1].match(KEYS_IN_ARRAY)!;
  return [...body[1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map(match => match[1]);
};

const LOCKED_IN_ARRAY = /FUNCTION app_private\.company_module_locked_keys\(\)[\s\S]*?SELECT ARRAY\[([\s\S]*?)\]/;

const lockedInMigration = (): string[] => {
  const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
  const defining = readdirSync(dir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => readFileSync(dir + file, 'utf8'))
    .filter(sql => LOCKED_IN_ARRAY.test(sql));
  if (defining.length === 0) throw new Error('no migration defines app_private.company_module_locked_keys()');
  const body = defining[defining.length - 1].match(LOCKED_IN_ARRAY)!;
  return [...body[1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map(match => match[1]);
};

// ─── 1. the registry covers the sidebar, exactly once each ───────────────────

describe('the registry names every sidebar entry and nothing else', () => {
  it('every entry of NAV_ITEMS and ADMIN_ITEMS is one module', () => {
    const paths = allSidebarEntries().map(entry => entry.path).sort();
    expect(MODULE_DEFINITIONS.map(m => m.routes[0]).sort()).toEqual(paths);
  });

  it('there are 22 of them, which is what the migration self-checks', () => {
    // Self-check 8 of 20261025120000 fails a release where this is not 22.
    expect(allSidebarEntries()).toHaveLength(22);
    expect(MODULE_DEFINITIONS).toHaveLength(22);
  });

  it('no module and no sidebar path appears twice', () => {
    expect(new Set(MODULE_KEYS).size).toBe(MODULE_KEYS.length);
    const navPaths = MODULE_DEFINITIONS.map(m => m.routes[0]);
    expect(new Set(navPaths).size).toBe(navPaths.length);
  });

  it('each module renders the same label the sidebar does', () => {
    // The operator and the customer must be looking at the same word, so this
    // is the sidebar's own key and not a second one written for the panel.
    const bySidebarPath = new Map(allSidebarEntries().map(entry => [entry.path, entry.labelKey]));
    for (const definition of MODULE_DEFINITIONS) {
      expect(definition.labelKey, `labelKey of ${definition.key}`)
        .toBe(bySidebarPath.get(definition.routes[0]));
    }
  });

  it('every key satisfies company_modules.module_key\'s CHECK — no hyphen', () => {
    // `/company-planner` is the key `company_planner`. A hyphenated key would
    // be refused by the column at the moment an operator first used it.
    for (const key of MODULE_KEYS) expect(key, key).toMatch(/^[a-z][a-z0-9_]{0,59}$/);
  });
});

// ─── 2. the three vocabularies ───────────────────────────────────────────────

describe('the declared columns name things that exist', () => {
  it('every feature is a FeatureKey the plan map can answer for', () => {
    /*
      `SEED_PLAN_FEATURES` is `Record<FeatureKey, Plan>` — complete by
      construction, which is what makes it the list. `FEATURE_LABEL_KEYS` in
      App.tsx is **not**: it is a `Partial` with nine entries, and the design
      document's checklist step 4 reads as if it were complete. A feature
      missing from it falls back to printing the raw key on LockedFeaturePage,
      which is a cosmetic gap and not a gate.

      The type already pins `feature: FeatureKey` through the `satisfies` clause
      on MODULE_DEFINITIONS. What this adds is that the feature is also named in
      the seeded plan map, because `minPlanForFeature()` answers **premium** for
      a feature the stored map does not name — so a module pointing at an
      unseeded feature would be locked for everyone with nothing on screen to
      say why.
    */
    const features = new Set(Object.keys(SEED_PLAN_FEATURES));
    expect(features.size).toBe(16);
    for (const definition of MODULE_DEFINITIONS) {
      expect(features.has(definition.feature), `feature of ${definition.key}`).toBe(true);
    }
  });

  it('every declared route is registered in App.tsx', () => {
    const routes = registeredRoutes();
    for (const definition of MODULE_DEFINITIONS) {
      for (const route of definition.routes) {
        expect(routes.has(route.replace(/^\//, '')), `${route} (module ${definition.key})`).toBe(true);
      }
    }
  });

  it('every declared pageKey is in PAGE_DEFINITIONS', () => {
    const pages = new Set(PAGE_DEFINITIONS.map(page => page.key));
    for (const definition of MODULE_DEFINITIONS) {
      for (const page of definition.pageKeys) {
        expect(pages.has(page), `${page} (module ${definition.key})`).toBe(true);
      }
    }
  });

  it('the modules with no pageKey are the four whose tables no page owns', () => {
    // Named, so adding a fifth is a decision rather than an omission:
    // `benachrichtigungen` (notification_settings asks is_company_admin()),
    // `billing` and `datensicherung` (nothing of theirs is page-gated), and
    // `datenimport`, whose partner tables wait on slice 3's own survey.
    expect(MODULE_DEFINITIONS.filter(m => m.pageKeys.length === 0).map(m => m.key))
      .toEqual(['benachrichtigungen', 'datenimport', 'datensicherung', 'billing']);
  });
});

// ─── 3. the database's copy ──────────────────────────────────────────────────

describe('the keys the database accepts are the keys this build knows', () => {
  it('company_module_keys() names exactly MODULE_DEFINITIONS, in order', () => {
    expect(keysInMigration()).toEqual([...MODULE_KEYS]);
  });

  it('company_module_locked_keys() names exactly the lockable: false modules', () => {
    // Order is the design's section 6 (the two deadlocks first), not the
    // registry's, so the sets are compared rather than the sequences.
    expect([...lockedInMigration()].sort()).toEqual([...LOCKED_MODULE_KEYS].sort());
  });

  it('there are six locked modules, and they are the design\'s six', () => {
    expect([...LOCKED_MODULE_KEYS].sort())
      .toEqual(['billing', 'datensicherung', 'overview', 'roles', 'settings', 'users']);
  });

  it('every locked key is a module key — a wall around nothing would be worse', () => {
    for (const key of lockedInMigration()) expect(MODULE_KEYS).toContain(key);
  });
});

// ─── 4. the two deadlocks are still deadlocks ───────────────────────────────

describe('the two locked modules that are deadlocks, read out of App.tsx', () => {
  it('/billing is one of the only paths an inactive subscription may reach', () => {
    // Switch it off and the forced destination is itself closed: the company
    // cannot pay, so it can never leave the state. If this line ever stops
    // matching, the lock's reason has changed and has to be re-argued.
    const allowed = read('../App.tsx').match(/const SUBSCRIPTION_ALLOWED_PATHS = \[([^\]]*)\]/);
    expect(allowed).not.toBeNull();
    expect(allowed![1]).toContain("'/billing'");
    expect(moduleDefinition('billing')!.lockable).toBe(false);
  });

  it('/overview is where every unknown path is redirected', () => {
    expect(read('../App.tsx')).toContain('<Route path="*" element={<Navigate to="/overview" replace />} />');
    expect(moduleDefinition('overview')!.lockable).toBe(false);
  });
});

// ─── 5. absence means on ─────────────────────────────────────────────────────

describe('a module with no stored decision is on', () => {
  it('an empty map leaves every module on', () => {
    for (const key of MODULE_KEYS) expect(moduleEnabled(NO_MODULE_DECISIONS, key)).toBe(true);
  });

  it('only an explicit false switches one off', () => {
    const modules = parseCompanyModules([
      { module_key: 'werkstatt', enabled: false },
      { module_key: 'belege', enabled: true },
    ]);
    expect(moduleEnabled(modules, 'werkstatt')).toBe(false);
    expect(moduleEnabled(modules, 'belege')).toBe(true);
    expect(moduleEnabled(modules, 'notes')).toBe(true);
  });

  it('an unreadable answer leaves every module on, not off', () => {
    // Fail-open, for UNRESOLVED_PLAN_STATE's reason. Fail-closed here would put
    // every existing customer in the dark on deploy day, because no company has
    // a row at all.
    for (const answer of [null, undefined, 'nonsense' as unknown as never]) {
      expect(parseCompanyModules(answer as never)).toEqual({});
    }
    expect(moduleEnabled(parseCompanyModules(null), 'werkstatt')).toBe(true);
  });

  it('a malformed row is dropped and the others survive', () => {
    const modules = parseCompanyModules([
      { module_key: 'werkstatt', enabled: 'no' as unknown as boolean },
      { module_key: 42 as unknown as string, enabled: false },
      { module_key: 'notes', enabled: false },
    ]);
    expect(modules).toEqual({ notes: false });
  });

  it('a key this build does not know is kept, so a rollback does not lose it', () => {
    expect(parseCompanyModules([{ module_key: 'something_newer', enabled: false }]))
      .toEqual({ something_newer: false });
  });
});

// ─── 6. route lookup ─────────────────────────────────────────────────────────

describe('the sidebar and the route gate ask by path', () => {
  it('a module path answers its module', () => {
    expect(moduleForRoute('/werkstatt')!.key).toBe('werkstatt');
    expect(moduleForRoute('/company-planner')!.key).toBe('company_planner');
    expect(moduleForRoute('/dokumente/:id')!.key).toBe('dokumente');
  });

  it('a path no module owns is on, never off', () => {
    // `/stundennachweis`, `/fahrtenanalyse` and `/mein-konto` belong to no
    // module; a gate that read an unowned path as off would close them all.
    for (const path of ['/stundennachweis', '/fahrtenanalyse', '/mein-konto', '/nonsense']) {
      expect(moduleForRoute(path)).toBeNull();
      expect(moduleEnabledForRoute({ werkstatt: false }, path)).toBe(true);
    }
  });

  it('a switched-off module hides every one of its routes', () => {
    const off = { dokumente: false };
    for (const route of moduleDefinition('dokumente')!.routes) {
      expect(moduleEnabledForRoute(off, route)).toBe(false);
    }
    // …and not another module's, although they share a FeatureKey and a page.
    expect(moduleEnabledForRoute(off, '/fahrtenbuch')).toBe(true);
  });
});

// ─── 7. the four gates, and Decision A ──────────────────────────────────────

describe('the four gates compose as a plain AND', () => {
  const allYes = {
    environmentShows: true, planAllows: true, moduleEnabled: true, roleCanView: true,
  };

  it('every gate must say yes', () => {
    expect(moduleVisible(allYes)).toBe(true);
    for (const gate of Object.keys(allYes) as (keyof typeof allYes)[]) {
      expect(moduleVisible({ ...allYes, [gate]: false }), gate).toBe(false);
    }
  });

  it('the toggle narrows and never widens — the plan still decides', () => {
    // Decision A, as a table. The third row is the whole point: a module the
    // plan forbids stays off however the toggle is set, so `plan_features`
    // never becomes advisory.
    expect(moduleState({ lockable: true, planAllows: true,  enabled: true  })).toBe('active');
    expect(moduleState({ lockable: true, planAllows: true,  enabled: false })).toBe('operator_off');
    expect(moduleState({ lockable: true, planAllows: false, enabled: true  })).toBe('plan_inert');
    expect(moduleState({ lockable: true, planAllows: false, enabled: false })).toBe('plan_off');

    expect(moduleVisible({ ...allYes, planAllows: false })).toBe(false);
  });

  it('a locked module reports its lock before anything else', () => {
    for (const planAllows of [true, false]) {
      for (const enabled of [true, false]) {
        expect(moduleState({ lockable: false, planAllows, enabled })).toBe('locked');
      }
    }
  });
});

// ─── 8. which modules close data ────────────────────────────────────────────

describe('what switching a module off would close', () => {
  it('a module whose page no other module claims closes that page', () => {
    expect(pagesClosedByDisabling(NO_MODULE_DECISIONS, 'belege')).toEqual(['receipts']);
    expect(pagesClosedByDisabling(NO_MODULE_DECISIONS, 'werkstatt')).toEqual(['werkstatt']);
  });

  it('a module with no page key closes nothing', () => {
    for (const key of ['benachrichtigungen', 'datenimport', 'datensicherung', 'billing']) {
      expect(pagesClosedByDisabling(NO_MODULE_DECISIONS, key), key).toEqual([]);
    }
  });

  it('one of the four documents modules closes nothing; the last of them closes the page', () => {
    // The place where an operator's expectation and the mechanism diverge, and
    // the reason the panel row says "schließt Daten" on some rows only.
    expect(pagesClosedByDisabling(NO_MODULE_DECISIONS, 'monatsplan')).toEqual([]);
    const threeOff = { dokumente: false, fahrtenbuch: false, company_planner: false };
    expect(pagesClosedByDisabling(threeOff, 'monatsplan')).toEqual(['documents']);
  });

  it('no page claimed by a locked module can ever be closed', () => {
    /*
      A locked module can never be off — the database refuses it with
      `module_locked` — so its pages are always claimed by something enabled.
      The worst reachable state is therefore every *lockable* module off, and
      that is the state probed here; switching a locked one off as well is not a
      state the system can be in, and probing it would measure nothing.

      This is the property the design document stated as "no pageKey belongs to
      a locked module", which is not true of this registry and should not be:
      `users`, `roles` and `settings` do own their pages. Had they declared
      none, slice 3 would have had to treat a page claimed by no module as
      never-closed, or it would have closed those three permanently for every
      company. Declaring them and asserting the consequence is the honest form.
    */
    const worstReachable = Object.fromEntries(
      MODULE_DEFINITIONS.filter(m => m.lockable).map(m => [m.key, false]),
    );
    const lockedPages = MODULE_DEFINITIONS.filter(m => !m.lockable).flatMap(m => m.pageKeys);
    expect(lockedPages.sort()).toEqual(['overview', 'roles', 'settings', 'users']);
    // Only a lockable module can be the one being switched off, for the same
    // reason: asking what disabling `overview` would close is asking about a
    // state the database refuses to create.
    for (const definition of MODULE_DEFINITIONS.filter(m => m.lockable)) {
      for (const page of pagesClosedByDisabling(worstReachable, definition.key)) {
        expect(lockedPages, `${page} via ${definition.key}`).not.toContain(page);
      }
    }
  });
});
