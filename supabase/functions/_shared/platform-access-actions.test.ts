/**
 * The edge functions' audit actions and what the database accepts are one list
 * in two places (plan 3.5).
 *
 * `public.platform_audit_record` refuses any action that is not in
 * `app_private.platform_edge_audit_actions()`, with its category, and lets a
 * role record anything but a refusal only when it holds that action's
 * capability. A route added here and forgotten there would fail closed at
 * runtime — the audit row cannot be written, so the action does not happen.
 * This test reads the migration and fails the build instead.
 *
 * The migration text is the source: the function is written down once, in SQL,
 * and nothing duplicates it in TypeScript.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLATFORM_CAPABILITIES } from './platform-access.ts';
import { MANAGE_USERS_ROUTES } from './manage-users-routes.ts';
import {
  DEFAULT_STAFF_ROLE,
  parseStaffRole,
  parseStaffRoleChange,
  PLATFORM_STAFF_ROLES,
  PLATFORM_STAFF_ROUTES,
  resolvePlatformStaffRoute,
  staffRoleIsAllowed,
} from './platform-staff-routes.ts';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const DEFINITION = 'FUNCTION app_private.platform_edge_audit_actions()';

/**
 * The migration that defines the list **last**.
 *
 * It was 20260916130000 alone until 20260923140000 restated the function to add
 * the set-role route's action. Migrations run in filename order and the live
 * definition is the newest one, so naming a file here would pin the test to a
 * definition the database has already replaced — which is exactly the drift
 * this file exists to catch.
 */
const MIGRATION = (() => {
  const named = readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith('.sql'))
    .sort()
    .filter(name => readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8').includes(DEFINITION));
  if (named.length === 0) throw new Error('no migration defines platform_edge_audit_actions()');
  return path.join(MIGRATIONS_DIR, named[named.length - 1]);
})();

interface EdgeAction {
  action: string;
  category: string;
  capability: string | null;
}

/** The VALUES rows of app_private.platform_edge_audit_actions(). */
function edgeActionsFromMigration(): EdgeAction[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  const start = sql.indexOf('FUNCTION app_private.platform_edge_audit_actions()');
  expect(start, 'platform_edge_audit_actions() is missing from the migration').toBeGreaterThan(-1);
  const body = sql.slice(start, sql.indexOf('$$;', start));

  const rows = [...body.matchAll(/\(\s*'([a-z0-9_.]+)'\s*,\s*'([a-z]+)'\s*,\s*(?:'([a-z0-9_.]+)'|NULL)\s*\)/g)];
  return rows.map(([, action, category, capability]) => ({
    action,
    category,
    capability: capability ?? null,
  }));
}

const EDGE_ACTIONS = edgeActionsFromMigration();
const ROUTES = [...MANAGE_USERS_ROUTES, ...PLATFORM_STAFF_ROUTES];

describe('platform_edge_audit_actions() and the route tables', () => {
  it('reads the list from the migration at all', () => {
    expect(EDGE_ACTIONS.length).toBeGreaterThanOrEqual(ROUTES.length);
    for (const entry of EDGE_ACTIONS) {
      expect(['read', 'write']).toContain(entry.category);
      expect(entry.action).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);
      // The namespaces the database writes itself; platform_audit_record
      // refuses them whatever the list says.
      expect(entry.action).not.toMatch(/^(platform_staff|legacy|auth)(\.|$)/);
      if (entry.capability !== null) {
        expect(PLATFORM_CAPABILITIES).toContain(entry.capability);
      }
    }
  });

  it('lists every route action with the route’s own category and capability', () => {
    for (const route of ROUTES) {
      const entry = EDGE_ACTIONS.find(a => a.action === route.action);
      expect(entry, `${route.action} is not accepted by platform_audit_record`).toBeDefined();
      expect(entry!.category).toBe(route.category);
      expect(entry!.capability).toBe(route.capability);
    }
  });

  it('has no listed action that no route and no function sends', () => {
    // `manage_users.unknown` is the fallback manage-users records when no route
    // matched; `activation_code.generate` is generate-activation-code's.
    const otherSenders = new Set(['manage_users.unknown', 'activation_code.generate']);
    const sent = new Set([...ROUTES.map(r => r.action), ...otherSenders]);
    for (const entry of EDGE_ACTIONS) {
      expect(sent.has(entry.action), `${entry.action} is accepted but nothing sends it`).toBe(true);
    }
  });

  it('names each action exactly once', () => {
    const names = EDGE_ACTIONS.map(a => a.action);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('platform-staff routes', () => {
  it('resolves each route by method and path', () => {
    expect(resolvePlatformStaffRoute('POST', '/platform-staff/invite')?.name).toBe('invite');
    expect(resolvePlatformStaffRoute('POST', '/platform-staff/resend-invite')?.name).toBe('resend-invite');
  });

  it('matches the longer segment first, so /resend-invite is never read as /invite', () => {
    expect(resolvePlatformStaffRoute('POST', '/platform-staff/resend-invite')?.action)
      .toBe('platform_staff_invite.resend');
  });

  it('resolves nothing for a wrong method or an unknown path', () => {
    expect(resolvePlatformStaffRoute('GET', '/platform-staff/invite')).toBeNull();
    expect(resolvePlatformStaffRoute('POST', '/platform-staff/other')).toBeNull();
  });

  it('resolves the role change added by 20260923140000', () => {
    const route = resolvePlatformStaffRoute('POST', '/platform-staff/set-role');
    expect(route?.name).toBe('set-role');
    expect(route?.action).toBe('platform_staff_role.set');
    expect(route?.capability).toBe('staff.manage');
    expect(resolvePlatformStaffRoute('GET', '/platform-staff/set-role')).toBeNull();
  });

  it('keeps the role change out of the namespace the database writes itself', () => {
    // platform_audit_record refuses `platform_staff.`, so an action there could
    // never be recorded and the route would fail closed at runtime.
    const route = PLATFORM_STAFF_ROUTES.find(r => r.name === 'set-role')!;
    expect(route.action.startsWith('platform_staff.')).toBe(false);
  });

  it('needs staff.manage for every team route, and companies.hard_delete for the company delete', () => {
    for (const route of PLATFORM_STAFF_ROUTES) {
      expect(route.capability).toBe(route.name === 'delete-company' ? 'companies.hard_delete' : 'staff.manage');
      expect(route.category).toBe('write');
    }
  });

  it('resolves the complete company delete added by 20261016140000', () => {
    const route = resolvePlatformStaffRoute('POST', '/platform-staff/delete-company');
    expect(route?.name).toBe('delete-company');
    expect(route?.action).toBe('platform_company_hard_delete.execute');
    expect(resolvePlatformStaffRoute('GET', '/platform-staff/delete-company')).toBeNull();
    expect(route!.action.startsWith('platform_staff.')).toBe(false);
  });

  /*
    Migration 20260923110000 lifted the `role_requires_3_3` guard, so the door
    admits all four roles the database knows. The list here and the one in
    `platform_staff_add`'s argument contract must stay the same four, or an
    invitation would create an account the RPC then refuses — and the function
    deletes it again, so the operator sees a failure with no explanation.
  */
  it('admits every role the database knows, and nothing else', () => {
    expect(PLATFORM_STAFF_ROLES).toEqual(['owner', 'support', 'billing', 'read_only']);
    expect(DEFAULT_STAFF_ROLE).toBe('owner');

    expect(staffRoleIsAllowed(undefined)).toBe(true);
    expect(staffRoleIsAllowed(null)).toBe(true);
    for (const role of PLATFORM_STAFF_ROLES) {
      expect(staffRoleIsAllowed(role)).toBe(true);
    }
    // Profile roles, platform capabilities and the shapes a JSON body can carry.
    for (const role of ['admin', 'viewer', 'super_admin', 'Owner', 'OWNER', 'staff.manage',
                        '', ' owner', 0, 1, true, {}, [], ['owner']]) {
      expect(staffRoleIsAllowed(role), `${JSON.stringify(role)} must be refused`).toBe(false);
    }
  });

  it('names the four roles exactly as the database CHECK constraint does', () => {
    const migration = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)),
        '../../migrations/20260916110000_platform_staff_and_audit_log.sql'),
      'utf8',
    );
    const check = migration.match(/role\s+text\s+NOT NULL CHECK \(role IN \(([^)]+)\)\)/);
    expect(check, 'the platform_staff role CHECK constraint moved').not.toBeNull();
    const constraintRoles = [...check![1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
    expect([...PLATFORM_STAFF_ROLES].sort()).toEqual(constraintRoles.sort());
  });

  it('resolves owner only where no role was named, and never as a fallback', () => {
    expect(parseStaffRole(undefined)).toBe('owner');
    expect(parseStaffRole(null)).toBe('owner');
    for (const role of PLATFORM_STAFF_ROLES) {
      expect(parseStaffRole(role)).toBe(role);
    }
    // The value decides how much of every customer's data the account reaches.
    // A role the door does not know is refused, never promoted to the default.
    for (const role of ['admin', 'viewer', 'Owner', '', ' owner', 0, true, {}, ['owner']]) {
      expect(parseStaffRole(role), `${JSON.stringify(role)} must not resolve`).toBeNull();
    }
  });

  /*
    A *change* has no default. `parseStaffRole`'s `owner` for a missing role is
    right where a row is created — it is the RPC's own default, and what the
    release before the four roles sent — and wrong where one already exists: a
    body that forgot its `role` would read as "make this member an owner".
  */
  it('refuses a role change that names no role', () => {
    expect(parseStaffRoleChange(undefined)).toBeNull();
    expect(parseStaffRoleChange(null)).toBeNull();
    for (const role of PLATFORM_STAFF_ROLES) {
      expect(parseStaffRoleChange(role)).toBe(role);
    }
    for (const role of ['admin', 'viewer', 'Owner', 'OWNER', '', ' owner', 0, 1, true, {}, [], ['owner']]) {
      expect(parseStaffRoleChange(role), `${JSON.stringify(role)} must not resolve`).toBeNull();
    }
  });
});
