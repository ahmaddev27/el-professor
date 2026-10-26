/**
 * Which of the Rollen screen's thirty-two checkboxes enforce anything, pinned
 * against the two places that decide it.
 *
 * Three of these are worth more than the rest, because the failure they guard
 * is silent rather than loud:
 *
 *  - **The classification against `supabase/migrations/`.** The screen now says
 *    "this column is switched off" and "these three are administrators only".
 *    Those are claims about the database, and a migration that gates a new page
 *    turns an honest sentence into a fresh lie — the same lie this file exists
 *    to remove, one release later. So the enforced set is rebuilt by scanning
 *    the migration chain and compared in **both** directions. This is
 *    `rolePageKeys.test.ts`'s rule for the key list, applied to the gate.
 *
 *  - **`can_view` must stay in the payload.** `company_role_save` **replaces** a
 *    role's rows: it deletes every `role_permissions` row and inserts what the
 *    payload names. The tempting next step after "`can_view` is dead" is to stop
 *    sending it, and that breaks twice over. A role with any edit right is
 *    refused outright — `can_edit` true beside `can_view` absent or false is
 *    exactly `edit_without_view`, and the RPC compares with
 *    `IS NOT DISTINCT FROM` precisely so that an *omitted* key refuses too
 *    rather than failing open. A role with only view rights is worse: every
 *    entry drops out of `permissionPayload`'s filter, the payload is `[]`, and
 *    the RPC deletes all sixteen rows and inserts none — a role emptied with a
 *    success toast. Measured on production 25.10.2026: twenty stored rows are
 *    `can_view` true with `can_edit` false, sixteen of them `viewer`'s.
 *
 *  - **`grantedAreaCount` is what the dialog's subtitle says a role grants.**
 *    Counting a dead box there is the same claim as drawing it as settable.
 *
 * ## The scan's premise, and its one blind spot
 *
 * The gate reaches a policy in two shapes in this repository: written out,
 * `current_role_permits('salaries', true)`, and built by a `DO` loop from a
 * `VALUES` table whose third field is the page key, `format(…%L…, t.page)`.
 * The scan reads both, and asserts that each shape found something — so if the
 * house style changes and a regex stops matching, this file fails loudly
 * instead of passing on an empty set.
 *
 * What it cannot see is a page being **un**gated: the chain is cumulative, so a
 * key an old migration gated still appears after a newer one drops the policy.
 * That is the same limitation `rolePageKeys.test.ts` carries, and the reason
 * the authority quoted in `rolePermissionEnforcement.ts` is a read of
 * production's live catalogue rather than this scan.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAGE_DEFINITIONS } from '../types/role';
import { ROLE_PAGE_KEYS, emptyPermissions, permissionPayload, permissionsFromTemplate, type PermissionMap } from './companyRoles';
import {
  COMPANY_ADMIN_PAGES,
  ROLE_EDIT_ENFORCED_PAGES,
  UNENFORCED_PAGES,
  VIEW_IS_ENFORCED,
  editBoxIsSettable,
  enforcementOf,
  grantedAreaCount,
  permissionGroups,
  viewBoxIsSettable,
} from './rolePermissionEnforcement';
import type { RolePermission } from '../types/role';

const KEYS = new Set<string>(ROLE_PAGE_KEYS);

const migrationSources = (): string[] => {
  const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
  return readdirSync(dir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => readFileSync(dir + file, 'utf8'));
};

/**
 * Page keys the migration chain puts behind `current_role_permits(key, true)`.
 *
 * Returned per shape rather than merged, so each can be asserted non-empty.
 */
const gatedPagesInMigrations = (): { literal: Set<string>; loop: Set<string> } => {
  const literal = new Set<string>();
  const loop = new Set<string>();

  for (const sql of migrationSources()) {
    if (!sql.includes('current_role_permits')) continue;

    // Written out. The doubled quotes are the dollar-quoted `format()` strings
    // inside a DO block, where a literal key is escaped as ''salaries''.
    for (const match of sql.matchAll(/current_role_permits\(\s*'{1,2}([a-z][a-z0-9-]*)'{1,2}\s*,\s*true\s*\)/g)) {
      if (KEYS.has(match[1])) literal.add(match[1]);
    }

    // Built by a loop over a VALUES table. Only read in a file that actually
    // builds the gate dynamically, so an unrelated VALUES list elsewhere is not
    // mistaken for a gate.
    if (!/current_role_permits\(%L,\s*true\)/.test(sql)) continue;
    // ('table', 'SIUD', 'page', …) — slice C and 3.3's shape.
    for (const match of sql.matchAll(/^\s*\(\s*'[a-z_]+'\s*,\s*'[SIUDM]+'\s*,\s*'([a-z][a-z0-9-]*)'/gm)) {
      if (KEYS.has(match[1])) loop.add(match[1]);
    }
    // ('table', 'page') — 20260910120000's shape.
    for (const match of sql.matchAll(/^\s*\(\s*'[a-z_]+'\s*,\s*'([a-z][a-z0-9-]*)'\s*\)/gm)) {
      if (KEYS.has(match[1])) loop.add(match[1]);
    }
  }

  return { literal, loop };
};

/** Page keys whose route App.tsx wraps in `CompanyAdminRoute`. */
const adminRoutedPages = (): string[] => {
  const app = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8');
  const paths = [...app.matchAll(/<Route\s+path="([a-z-]+)"\s+element=\{<CompanyAdminRoute>/g)].map(m => m[1]);
  // `billing` and `datensicherung` are admin-only screens with no page_key of
  // their own, so they are not part of this comparison.
  return [...new Set(paths.filter(path => KEYS.has(path)))].sort();
};

const permission = (page_key: string, can_view: boolean, can_edit: boolean): RolePermission => ({
  id: `p-${page_key}`,
  role_id: 'r1',
  page_key,
  can_view,
  can_edit,
  created_at: '2026-10-25T00:00:00Z',
});

describe('the enforced pages are the pages the migrations gate', () => {
  it('both scan shapes find gates, so neither assertion below can pass on an empty set', () => {
    const { literal, loop } = gatedPagesInMigrations();
    expect(literal.size).toBeGreaterThan(0);
    expect(loop.size).toBeGreaterThan(0);
  });

  it('every page the chain gates is classified as role-enforced', () => {
    const { literal, loop } = gatedPagesInMigrations();
    const gated = [...new Set([...literal, ...loop])].sort();
    for (const key of gated) {
      expect(enforcementOf(key), `${key} is gated by a migration but classified ${enforcementOf(key)}`)
        .toBe('role_edit');
    }
  });

  it('and every page classified as role-enforced is gated by the chain', () => {
    const { literal, loop } = gatedPagesInMigrations();
    const gated = new Set([...literal, ...loop]);
    for (const key of ROLE_EDIT_ENFORCED_PAGES) {
      expect(gated.has(key), `${key} is drawn as settable but no migration gates it`).toBe(true);
    }
  });

  it('the two sets are equal, which is the ten measured on production', () => {
    const { literal, loop } = gatedPagesInMigrations();
    expect([...new Set([...literal, ...loop])].sort()).toEqual([...ROLE_EDIT_ENFORCED_PAGES]);
  });

  it('none of the six dead Bearbeiten keys is gated anywhere in the chain', () => {
    const { literal, loop } = gatedPagesInMigrations();
    const gated = new Set([...literal, ...loop]);
    for (const key of [...COMPANY_ADMIN_PAGES, ...UNENFORCED_PAGES]) {
      expect(gated.has(key), `${key} is gated after all — move its row into the live group`).toBe(false);
    }
  });
});

describe('the administrator-only three are the three App.tsx gates on isAdmin', () => {
  it('COMPANY_ADMIN_PAGES is exactly the page keys behind CompanyAdminRoute', () => {
    // The screen says "administrators only" about these three. App.tsx is the
    // other half of that claim: `CompanyAdminRoute` sends a non-`admin` away
    // from the route entirely, on the same `user_profiles.role = 'admin'` test
    // `is_company_admin()` reads.
    expect(adminRoutedPages()).toEqual([...COMPANY_ADMIN_PAGES]);
  });
});

describe('the sixteen areas are partitioned, and the screen draws all of them', () => {
  it('every page key is classified exactly once', () => {
    const all = [...ROLE_EDIT_ENFORCED_PAGES, ...COMPANY_ADMIN_PAGES, ...UNENFORCED_PAGES];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...ROLE_PAGE_KEYS].sort());
  });

  it('ten are role-enforced, three administrator-only, three enforced by nothing', () => {
    expect(ROLE_EDIT_ENFORCED_PAGES).toHaveLength(10);
    expect(COMPANY_ADMIN_PAGES).toHaveLength(3);
    expect(UNENFORCED_PAGES).toHaveLength(3);
  });

  it('permissionGroups() draws all sixteen rows, each once, in PAGE_DEFINITIONS order per group', () => {
    const groups = permissionGroups();
    const drawn = groups.flatMap(group => group.pages.map(page => page.key));
    expect(drawn).toHaveLength(16);
    expect(new Set(drawn).size).toBe(16);

    const order: string[] = PAGE_DEFINITIONS.map(page => page.key);
    for (const group of groups) {
      const keys = group.pages.map(page => page.key);
      expect(keys).toEqual([...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    }
  });

  it('the live group comes first, and only the other two carry a reason', () => {
    const groups = permissionGroups();
    expect(groups.map(group => group.kind)).toEqual(['role_edit', 'company_admin', 'unenforced']);
    expect(groups[0].reasonKey).toBeUndefined();
    expect(groups[1].reasonKey).toBeDefined();
    expect(groups[2].reasonKey).toBeDefined();
  });

  it('the two unsettable groups give different reasons, because the reasons differ', () => {
    // "administrators only" is a rule an administrator can act on; "nothing
    // gates this page" is not. One blanket sentence would lose that.
    const groups = permissionGroups();
    expect(groups[1].reasonKey).not.toBe(groups[2].reasonKey);
  });
});

describe('the Ansehen column is unsettable on every page', () => {
  it('VIEW_IS_ENFORCED is false', () => {
    // Production, 25.10.2026: 177 occurrences of current_role_permits in policy
    // expressions and 23 in function bodies, every one passing need_edit = true.
    // The function has no default for that argument, so nothing reaches its
    // `ELSE rp.can_view` branch.
    expect(VIEW_IS_ENFORCED).toBe(false);
  });

  it('viewBoxIsSettable() is false and takes no page', () => {
    expect(viewBoxIsSettable()).toBe(false);
    expect(viewBoxIsSettable).toHaveLength(0);
  });

  it('editBoxIsSettable() is true for the ten and false for the six', () => {
    for (const key of ROLE_EDIT_ENFORCED_PAGES) expect(editBoxIsSettable(key)).toBe(true);
    for (const key of [...COMPANY_ADMIN_PAGES, ...UNENFORCED_PAGES]) expect(editBoxIsSettable(key)).toBe(false);
  });

  it('a page key this build does not know is treated as enforcing nothing', () => {
    // Fail closed: a box that may do nothing is drawn as doing nothing, rather
    // than promising a right nobody has checked for.
    expect(enforcementOf('a-screen-added-later')).toBe('unenforced');
    expect(editBoxIsSettable('a-screen-added-later')).toBe(false);
  });
});

describe('stilling the column must not strip can_view from what company_role_save stores', () => {
  it('a payload entry never carries can_edit without can_view', () => {
    // This is `edit_without_view`, the one refusal that would make the save
    // fail outright — and the RPC compares with IS NOT DISTINCT FROM, so an
    // omitted can_view refuses exactly as a false one does.
    const map: PermissionMap = { ...emptyPermissions() };
    for (const key of ROLE_PAGE_KEYS) map[key] = { can_view: false, can_edit: true };
    for (const entry of permissionPayload(map)) {
      expect(entry.can_view, `${entry.page_key} would be refused as edit_without_view`).toBe(true);
    }
  });

  it('every entry still names can_view, with the value the row holds', () => {
    const map: PermissionMap = {
      ...emptyPermissions(),
      salaries: { can_view: true, can_edit: true },
      statistics: { can_view: true, can_edit: false },
    };
    const payload = permissionPayload(map);
    for (const entry of payload) expect(Object.keys(entry)).toContain('can_view');
    expect(payload).toEqual([
      { page_key: 'salaries', can_view: true, can_edit: true },
      { page_key: 'statistics', can_view: true, can_edit: false },
    ]);
  });

  it("a view-only role survives the round trip the modal makes of it", () => {
    /*
      The modal seeds its map from the stored rows and sends the map back, so a
      role whose every row is can_view-only — `viewer`, and the sixteen rows a
      company role copied from it carries — must come back out unchanged. With
      can_view dropped, `permissionPayload`'s filter would empty the array and
      the RPC would delete all sixteen rows and insert none.
    */
    const stored = [...ROLE_PAGE_KEYS].map(key => permission(key, true, false));
    const payload = permissionPayload(permissionsFromTemplate(stored));
    expect(payload).toHaveLength(16);
    expect(payload.every(entry => entry.can_view && !entry.can_edit)).toBe(true);
    expect(payload.map(entry => entry.page_key).sort()).toEqual([...ROLE_PAGE_KEYS].sort());
  });

  it('a stored can_view on an administrator-only page is carried, not dropped', () => {
    // The box is disabled on both columns for these three. The row still has to
    // come back, or opening a role and pressing Save would quietly delete it.
    const stored = [permission('settings', true, true), permission('users', true, false)];
    const payload = permissionPayload(permissionsFromTemplate(stored));
    // In PAGE_DEFINITIONS order, which is the order permissionPayload walks —
    // `users` is the eleventh key and `settings` the sixteenth.
    expect(payload).toEqual([
      { page_key: 'users', can_view: true, can_edit: false },
      { page_key: 'settings', can_view: true, can_edit: true },
    ]);
  });
});

describe('grantedAreaCount: what the dialog says a role grants', () => {
  it('counts can_edit on an enforced page', () => {
    expect(grantedAreaCount({ salaries: { can_edit: true }, drivers: { can_edit: true } })).toBe(2);
  });

  it('ignores can_view entirely', () => {
    const viewer = Object.fromEntries([...ROLE_PAGE_KEYS].map(key => [key, { can_edit: false }]));
    expect(grantedAreaCount(viewer)).toBe(0);
  });

  it('ignores can_edit on a page nothing enforces', () => {
    // `supervisor` holds can_edit on users, roles and settings — three rights
    // nothing honours — and `editor` holds one on overview. Counting them would
    // be the subtitle making the claim the checkboxes stopped making.
    expect(grantedAreaCount({
      users: { can_edit: true },
      roles: { can_edit: true },
      settings: { can_edit: true },
      overview: { can_edit: true },
      statistics: { can_edit: true },
      accounting: { can_edit: true },
    })).toBe(0);
  });

  it('an absent page is not granted', () => {
    expect(grantedAreaCount({})).toBe(0);
  });

  it("the seeded supervisor's sixteen edit rows count as ten", () => {
    const supervisor = Object.fromEntries([...ROLE_PAGE_KEYS].map(key => [key, { can_edit: true }]));
    expect(grantedAreaCount(supervisor)).toBe(10);
  });
});
