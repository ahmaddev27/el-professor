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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLATFORM_CAPABILITIES } from './platform-access.ts';
import { MANAGE_USERS_ROUTES } from './manage-users-routes.ts';
import { PLATFORM_STAFF_ROUTES, resolvePlatformStaffRoute, staffRoleIsAllowed } from './platform-staff-routes.ts';

const MIGRATION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations/20260916130000_platform_write_rpcs.sql',
);

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

  it('needs staff.manage for every route', () => {
    for (const route of PLATFORM_STAFF_ROUTES) {
      expect(route.capability).toBe('staff.manage');
      expect(route.category).toBe('write');
    }
  });

  it('admits only an owner row until plan step 3.3', () => {
    expect(staffRoleIsAllowed(undefined)).toBe(true);
    expect(staffRoleIsAllowed(null)).toBe(true);
    expect(staffRoleIsAllowed('owner')).toBe(true);
    for (const role of ['support', 'billing', 'read_only', 'admin', '', 0, {}]) {
      expect(staffRoleIsAllowed(role)).toBe(false);
    }
  });
});
