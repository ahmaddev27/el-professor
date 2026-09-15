/**
 * The routes of the manage-users function, and what a platform account needs
 * for each. A company admin is authorized by role and tenancy inside the
 * function; this table only decides the platform side.
 *
 * Matched the way the function always matched them: method, then the first
 * segment the path contains, in this order.
 *
 * Pure: no Deno, npm: or jsr: imports.
 */
import type { AuditCategory, PlatformCapability } from './platform-access.ts';

export type ManageUsersRouteName =
  | 'list' | 'create' | 'update' | 'activate-deactivate' | 'resend-invite' | 'reset-password' | 'delete';

export interface ManageUsersRoute {
  name: ManageUsersRouteName;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  segment: string;
  /** What a platform account must hold to use this route across companies. */
  capability: PlatformCapability;
  /** The audit row the route writes when a platform account uses it. */
  category: AuditCategory;
  action: string;
}

export const MANAGE_USERS_ROUTES: readonly ManageUsersRoute[] = [
  // Listing every company's users is a read: support and read_only may.
  { name: 'list',                method: 'GET',    segment: '/list',                capability: 'business.read',        category: 'read',  action: 'manage_users.list' },
  { name: 'create',              method: 'POST',   segment: '/create',              capability: 'company_users.manage', category: 'write', action: 'manage_users.create' },
  { name: 'update',              method: 'PUT',    segment: '/update',              capability: 'company_users.manage', category: 'write', action: 'manage_users.update' },
  { name: 'activate-deactivate', method: 'POST',   segment: '/activate-deactivate', capability: 'company_users.manage', category: 'write', action: 'manage_users.set_status' },
  { name: 'resend-invite',       method: 'POST',   segment: '/resend-invite',       capability: 'company_users.manage', category: 'write', action: 'manage_users.resend_invite' },
  { name: 'reset-password',      method: 'POST',   segment: '/reset-password',      capability: 'company_users.manage', category: 'write', action: 'manage_users.reset_password' },
  { name: 'delete',              method: 'DELETE', segment: '/delete',              capability: 'company_users.manage', category: 'write', action: 'manage_users.delete' },
];

export function resolveManageUsersRoute(method: string, pathname: string): ManageUsersRoute | null {
  return MANAGE_USERS_ROUTES.find(r => r.method === method && pathname.includes(r.segment)) ?? null;
}

export type AccountTargetDecision = 'allowed' | 'other_company' | 'platform_staff_account';

export interface AccountTargetFacts {
  isPlatformCaller: boolean;
  callerCompanyId: string | null;
  targetCompanyId: string | null;
  /** platform_can_manage_account for the caller; asked only for a platform caller. */
  platformCanManage: () => Promise<boolean>;
  /** Whether the target has a staff row; asked only for a company admin's same-company target. */
  targetIsPlatformStaff: () => Promise<boolean>;
}

/**
 * Whether the caller may act on an existing account, decided before anything
 * changes.
 *
 * - A platform caller needs platform_can_manage_account, which reserves
 *   accounts with a staff row for staff.manage.
 * - A company admin reaches only users of its own company. Both companies must
 *   be present and equal, so two NULLs never match.
 * - Even inside its company, a company admin never reaches an account with a
 *   staff row: manage-users acts with the service role, and a new address or
 *   password there would let the admin sign in as platform staff.
 *
 * A failed check throws; it never reads as allowed.
 */
export async function decideAccountTarget(facts: AccountTargetFacts): Promise<AccountTargetDecision> {
  if (facts.isPlatformCaller) {
    return (await facts.platformCanManage()) ? 'allowed' : 'platform_staff_account';
  }
  if (!facts.targetCompanyId || facts.targetCompanyId !== facts.callerCompanyId) {
    return 'other_company';
  }
  return (await facts.targetIsPlatformStaff()) ? 'platform_staff_account' : 'allowed';
}
