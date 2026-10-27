/**
 * The route half of the module gate, read out of `App.tsx`'s own source.
 *
 * The defect this file exists to stop recurring, measured on production on
 * 27.10.2026: the owner switched **Fahrtenbuch** off for his own company in the
 * platform panel and then typed `/fahrtenbuch` into the address bar. The page
 * rendered, fully working — the imports list, the Import button, every row.
 * `Sidebar.renderNavItem` was the only caller of `moduleEnabledForRoute` in the
 * whole tree, so switching a module off removed its **link** and nothing else.
 *
 * Why the source and not a render: there is no single place a renderer could
 * assert this. The claim is *coverage over a route table* — that no toggleable
 * module has a route the gate forgot — and the route table is 22 JSX lines in a
 * component that pulls in sixty modules and five providers. `companyModules.
 * test.ts` reads `Sidebar.tsx` the same way and for the same reason, and records
 * it: a module-level constant in a component file is read, not imported.
 *
 * So this file is a lexical check, and it says nothing about whether the gate
 * *works* — `moduleEnabled` is unit-tested in `companyModules.test.ts` and the
 * page it renders in `ModuleOffPage.test.ts`. What it does say is that a new
 * toggleable route cannot ship ungated, which is exactly how the production
 * defect got in.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOCKED_MODULE_KEYS, MODULE_DEFINITIONS } from './lib/companyModules';

const APP = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');

/**
 * The `<Route …>` line declaring `path`, or null.
 *
 * The registry spells a route with a leading slash (`/dokumente/:id`); the
 * nested `<Route>`s under `path="/"` spell it without one. One `path="…"` per
 * line throughout the file, which is what makes a line the right unit.
 */
const routeLine = (route: string): string | null => {
  const path = route.replace(/^\//, '');
  return APP.split('\n').find(line => line.includes(`path="${path}"`)) ?? null;
};

const TOGGLEABLE = MODULE_DEFINITIONS.filter(m => m.lockable);

describe('every toggleable module gates every one of its routes', () => {
  // 16 of the 22. If this number moves, a module was added or its `lockable`
  // changed, and the loop below is what then has to pass.
  it('there are 16 of them', () => {
    expect(TOGGLEABLE).toHaveLength(16);
    expect(MODULE_DEFINITIONS.length - TOGGLEABLE.length).toBe(LOCKED_MODULE_KEYS.length);
  });

  for (const definition of TOGGLEABLE) {
    for (const route of definition.routes) {
      it(`${route} is wrapped in <ModuleGate module="${definition.key}">`, () => {
        const line = routeLine(route);
        expect(line, `no <Route path="${route}"> in App.tsx`).not.toBeNull();
        // The key, not merely "a ModuleGate": a copy-paste that left the
        // neighbour's key behind would gate the wrong module, and both halves
        // would still look gated.
        expect(line).toContain(`<ModuleGate module="${definition.key}">`);
      });
    }
  }
});

describe('a locked module carries no route gate', () => {
  /*
    Not defence in depth — unreachable code. `enabled` can only be written by
    `platform_company_set_module`, which refuses all six with `module_locked`,
    and the table carries no write policy for anything else to use. A gate here
    would be a branch no state can reach, and the next reader would have to
    work out whether it was load-bearing.

    `/overview` is the one that would matter if this were ever relaxed: it is the
    target of `path="*"` and of the authenticated index redirect, so a closed
    `/overview` would make every unknown path land on a refusal.
  */
  for (const key of LOCKED_MODULE_KEYS) {
    const definition = MODULE_DEFINITIONS.find(m => m.key === key)!;
    for (const route of definition.routes) {
      it(`${route} has no ModuleGate`, () => {
        const line = routeLine(route);
        expect(line, `no <Route path="${route}"> in App.tsx`).not.toBeNull();
        expect(line).not.toContain('<ModuleGate');
      });
    }
  }
});

describe('message precedence: the plan answers before the module', () => {
  /*
    Section 7 of Docs/design/per-company-modules.md. A company whose plan does
    not include the feature must be told *that*: with the plan forbidding it the
    module row is inert, so "support switched this off" would be false. Nesting
    is what implements the order — `PlanGate` renders `LockedFeaturePage`
    instead of its children, so `ModuleGate` never runs when the plan refuses.

    Read off each line rather than asserted once, because a single route written
    the other way round is the whole defect and would be invisible in a diff.
  */
  it('wherever both gates are on one route, ModuleGate is inside PlanGate', () => {
    const both = APP.split('\n').filter(line => line.includes('<PlanGate') && line.includes('<ModuleGate'));
    expect(both.length).toBeGreaterThan(0);
    for (const line of both) {
      expect(line.indexOf('<PlanGate'), line.trim()).toBeLessThan(line.indexOf('<ModuleGate'));
    }
  });

  it('a module refusal renders ModuleOffPage and never LockedFeaturePage', () => {
    // The lie this prevents: `LockedFeaturePage` says "not included in your
    // plan" and offers an upgrade, to a customer whose plan does include it.
    const gate = APP.match(/const ModuleGate[\s\S]*?\n};/);
    expect(gate, 'ModuleGate not found in App.tsx').not.toBeNull();
    expect(gate![0]).toContain('<ModuleOffPage');
    expect(gate![0]).not.toContain('LockedFeaturePage');
  });

  it('the gate fails open on an unknown key and on a module with no decision', () => {
    // Both are the registry's documented rule and both are read off the source
    // here because the component is not importable on its own: a key this build
    // does not know, and `NO_MODULE_DECISIONS` from a failed read, must render
    // the page rather than close it.
    const gate = APP.match(/const ModuleGate[\s\S]*?\n};/)![0];
    expect(gate).toContain('if (!definition || moduleEnabled(companyModules, module)) return <>{children}</>;');
  });
});

describe('the two routes that belong to no module stay open', () => {
  /*
    `/stundennachweis` and `/fahrtenanalyse` are owned by no module —
    `moduleForRoute` answers null, which `companyModules.test.ts` pins — so no
    operator decision names them and a gate here would have to invent an owner.
    Doing so is a product decision with a visible consequence (switching off
    Fahrtenbuch would close the Stundennachweis screen), so it is an open
    question in the PR rather than a choice taken in passing.

    Their writes are closed with the rest of the `documents` page by the database
    half, so this is a screen that renders over data it cannot change.
  */
  for (const route of ['/stundennachweis', '/fahrtenanalyse', '/mein-konto']) {
    it(`${route} has no ModuleGate`, () => {
      const line = routeLine(route);
      expect(line, `no <Route path="${route}"> in App.tsx`).not.toBeNull();
      expect(line).not.toContain('<ModuleGate');
    });
  }
});
