/**
 * The routes of the platform-staff function, and what each needs (plan 3.5).
 *
 * Shaped like manage-users-routes.ts: the table decides the capability and the
 * audit row, and `app_private.platform_edge_audit_actions()` (migration
 * 20260916130000) must list every action here with the same category and
 * capability. platform-access-actions.test.ts compares the two.
 *
 * Pure: no Deno, npm: or jsr: imports.
 */
import type { AuditCategory, PlatformCapability } from './platform-access.ts';

export type PlatformStaffRouteName = 'invite' | 'resend-invite';

export interface PlatformStaffRoute {
  name: PlatformStaffRouteName;
  method: 'POST';
  segment: string;
  capability: PlatformCapability;
  category: AuditCategory;
  action: string;
}

export const PLATFORM_STAFF_ROUTES: readonly PlatformStaffRoute[] = [
  { name: 'invite',        method: 'POST', segment: '/invite',        capability: 'staff.manage', category: 'write', action: 'platform_staff_invite.create' },
  { name: 'resend-invite', method: 'POST', segment: '/resend-invite', capability: 'staff.manage', category: 'write', action: 'platform_staff_invite.resend' },
];

/**
 * Matched like manage-users': method, then the first segment the path contains,
 * in this order. `/resend-invite` is listed after `/invite` but contains it, so
 * it is matched on the longer segment first.
 */
export function resolvePlatformStaffRoute(method: string, pathname: string): PlatformStaffRoute | null {
  const byLongestSegment = [...PLATFORM_STAFF_ROUTES].sort((a, b) => b.segment.length - a.segment.length);
  return byLongestSegment.find(r => r.method === method && pathname.includes(r.segment)) ?? null;
}

/**
 * The four roles a staff row may carry, as `app_private.platform_staff`'s CHECK
 * constraint and `app_private.platform_capability_matrix()` define them.
 *
 * All four have been enabled since migration 20260923110000 (owner's decision,
 * 23.09.2026). Until then `platform_staff_add` refused every role but `owner`
 * with reason `role_requires_3_3` — originally because every tenant policy was
 * built on `is_user_super_admin()` and would have given a "support" row an
 * owner's writes, and after 20260917130000 fixed that, because enabling the
 * other roles decides which accounts read every customer's data and was the
 * owner's to approve on its own.
 *
 * The database decides regardless: `platform_staff_add` validates the role
 * against the same four and answers `invalid` for anything else. This is the
 * same rule at the door, so an invitation with a bad role never creates an
 * account it would then have to delete.
 */
export const PLATFORM_STAFF_ROLES = ['owner', 'support', 'billing', 'read_only'] as const;
export type PlatformStaffRole = typeof PLATFORM_STAFF_ROLES[number];

/** What a request that names no role gets, and what the RPC's own default is. */
export const DEFAULT_STAFF_ROLE: PlatformStaffRole = 'owner';

export const STAFF_ROLE_REFUSAL_DE =
  'Unbekannte Plattform-Rolle. Erlaubt sind: owner, support, billing, read_only.';

/**
 * The role to write, or null when the request named one that is not a role.
 *
 * One function rather than a "check" and a separate "read": a value that decides
 * how much of every customer's data an account may reach must not be able to
 * *fall back* to a role. `owner` is returned only where the request named
 * nothing at all, which is the RPC's own default and how the previous release
 * called it; anything unrecognised is null, and the route refuses.
 */
export function parseStaffRole(role: unknown): PlatformStaffRole | null {
  if (role === undefined || role === null) return DEFAULT_STAFF_ROLE;
  return (PLATFORM_STAFF_ROLES as readonly unknown[]).includes(role)
    ? role as PlatformStaffRole
    : null;
}

/** Whether this request may create a staff row with the role it asked for. */
export function staffRoleIsAllowed(role: unknown): boolean {
  return parseStaffRole(role) !== null;
}
