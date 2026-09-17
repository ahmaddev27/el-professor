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
 * The only role a staff row may be created with before plan step 3.3.
 *
 * Every policy still built on is_user_super_admin() gives *any* active staff
 * row an owner's writes on the tenant tables, so a "support" or "read_only" row
 * would hold more than its name says until 3.3 moves those policies onto
 * capabilities. `platform_staff_add` refuses the others in the database as
 * well; this is the same rule at the door, so the account is never created.
 */
export const STAFF_ROLE_UNTIL_3_3 = 'owner';

export const STAFF_ROLE_REFUSAL_DE =
  'Andere Rollen als „owner" sind erst ab Plan-Schritt 3.3 möglich.';

/** Whether this request may create a staff row with the role it asked for. */
export function staffRoleIsAllowed(role: unknown): boolean {
  return role === undefined || role === null || role === STAFF_ROLE_UNTIL_3_3;
}
