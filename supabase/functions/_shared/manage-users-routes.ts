/**
 * The routes of the manage-users function, what a platform account needs for
 * each, and the pure decisions every route takes before it changes anything:
 * which company the caller's authority reaches, whether a target account is in
 * it, and which company a new account may be created in.
 *
 * Matched the way the function always matched them: method, then the first
 * segment the path contains, in this order.
 *
 * Pure: no Deno, npm: or jsr: imports.
 */
import { UUID_SHAPE, type AuditCategory, type PlatformCapability } from './platform-access.ts';

export type ManageUsersRouteName =
  | 'list' | 'create' | 'update' | 'activate-deactivate' | 'resend-invite' | 'reset-password' | 'delete';

export interface ManageUsersRoute {
  name: ManageUsersRouteName;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  segment: string;
  /**
   * What a platform account must hold to use this route — inside a support
   * session on the company it acts on, which resolveManageUsersScope() adds.
   */
  capability: PlatformCapability;
  /** The audit row the route writes when a platform account uses it. */
  category: AuditCategory;
  action: string;
}

export const MANAGE_USERS_ROUTES: readonly ManageUsersRoute[] = [
  // Listing a company's users is a read: the capability is business.read.
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

/** Two company ids name the same company: both present, compared as uuids. */
export function sameCompany(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a !== '' && a.toLowerCase() === b.toLowerCase();
}

// ─── Whose accounts the caller reaches ───────────────────────────────────────

/** Why a caller reaches no company's accounts at all. */
export type ManageUsersScopeRefusal = 'not_admin' | 'admin_without_company' | 'support_session_required';

export type ManageUsersScope =
  | { ok: true; companyId: string; via: 'membership' | 'support_session' }
  | { ok: false; refusal: ManageUsersScopeRefusal };

export interface ManageUsersScopeFacts {
  /** The caller holds the route's platform capability (platform_can). */
  isPlatformCaller: boolean;
  /** The caller's own user_profiles.role. */
  callerRole: string | null;
  /** The caller's own user_profiles.company_id: its membership. */
  membershipCompanyId: string | null;
  /**
   * platform_support_company_id(), asked with the caller's own token. Asked
   * only for a platform caller with no company of its own.
   */
  supportSessionCompanyId: () => Promise<string | null>;
}

/**
 * The one company whose accounts the caller may list and change, decided
 * before anything is read (plan 3.13a).
 *
 * - The authority is unchanged: a platform capability, or the profile role
 *   `admin`. Anyone else is refused.
 * - The company is the caller's membership when it has one — a company admin's
 *   own company, and for a platform account that still sits in a company, that
 *   company, the order get_user_company_id() uses.
 * - For a platform account with no company it is the company of its open
 *   support session, and nothing otherwise: no context, a view context or an
 *   expired one reach no company's accounts. The function acts with the
 *   service role, so 3.4a's confinement never reaches it; this is where it is
 *   applied instead.
 *
 * A failed check throws; it never reads as a scope.
 */
export async function resolveManageUsersScope(facts: ManageUsersScopeFacts): Promise<ManageUsersScope> {
  if (!facts.isPlatformCaller && facts.callerRole !== 'admin') {
    return { ok: false, refusal: 'not_admin' };
  }
  if (facts.membershipCompanyId) {
    return { ok: true, companyId: facts.membershipCompanyId, via: 'membership' };
  }
  // A company admin with no company has no tenant to administer. This state
  // once fell through every tenant check as "no restriction" and turned a
  // company-less 'admin' profile into a de-facto platform account.
  if (!facts.isPlatformCaller) {
    return { ok: false, refusal: 'admin_without_company' };
  }
  const supportCompanyId = await facts.supportSessionCompanyId();
  return supportCompanyId
    ? { ok: true, companyId: supportCompanyId, via: 'support_session' }
    : { ok: false, refusal: 'support_session_required' };
}

/** What each scope refusal says. German, shown verbatim by the screens. */
export const MANAGE_USERS_SCOPE_MESSAGES: Readonly<Record<ManageUsersScopeRefusal, string>> = {
  not_admin:
    'Keine Berechtigung: Nur Administratoren dürfen Benutzer verwalten.',
  admin_without_company:
    'Keine Berechtigung: Dieses Administratorkonto ist keinem Unternehmen zugeordnet.',
  support_session_required:
    'Keine Berechtigung: Benutzer eines Unternehmens lassen sich von der Plattform aus nur in einer offenen Support-Sitzung für dieses Unternehmen verwalten.',
};

// ─── The account a route acts on ─────────────────────────────────────────────

export type AccountTargetDecision = 'allowed' | 'other_company' | 'platform_staff_account';

export interface AccountTargetFacts {
  isPlatformCaller: boolean;
  /** The company resolveManageUsersScope() answered. */
  scopeCompanyId: string | null;
  targetCompanyId: string | null;
  /** platform_can_manage_account for the caller; asked only for a platform caller's same-company target. */
  platformCanManage: () => Promise<boolean>;
  /** Whether the target has a staff row; asked only for a company admin's same-company target. */
  targetIsPlatformStaff: () => Promise<boolean>;
}

/**
 * Whether the caller may act on an existing account, decided before anything
 * changes.
 *
 * - Every caller reaches only accounts of the company its scope names. Both
 *   companies must be present and equal, so two NULLs never match — and an
 *   account with no company (a platform account) is nobody's to change here.
 *   Before 3.13a a platform caller skipped this comparison altogether.
 * - A platform caller then needs platform_can_manage_account, which reserves
 *   accounts with a staff row for staff.manage.
 * - A company admin never reaches an account with a staff row, even inside its
 *   company: manage-users acts with the service role, and a new address or
 *   password there would let the admin sign in as platform staff.
 *
 * A failed check throws; it never reads as allowed.
 */
export async function decideAccountTarget(facts: AccountTargetFacts): Promise<AccountTargetDecision> {
  if (!sameCompany(facts.targetCompanyId, facts.scopeCompanyId)) {
    return 'other_company';
  }
  if (facts.isPlatformCaller) {
    return (await facts.platformCanManage()) ? 'allowed' : 'platform_staff_account';
  }
  return (await facts.targetIsPlatformStaff()) ? 'platform_staff_account' : 'allowed';
}

// ─── The company a new account is created in ────────────────────────────────

export type CreateCompanyDecision =
  | { ok: true; companyId: string }
  | { ok: false; refusal: 'invalid_company' | 'other_company' };

/**
 * The company a new account goes into: the caller's scope. A `company_id` in
 * the request may only name that same company; one that names another is
 * refused, and one that is not a uuid is a broken request. Before 3.13a a
 * platform caller's `company_id` was taken as it came — and interpolated into
 * a PostgREST filter for the role lookup.
 */
export function decideCreateCompany(scopeCompanyId: string, requested: unknown): CreateCompanyDecision {
  if (requested === undefined || requested === null || requested === '') {
    return { ok: true, companyId: scopeCompanyId };
  }
  if (typeof requested !== 'string' || !UUID_SHAPE.test(requested)) {
    return { ok: false, refusal: 'invalid_company' };
  }
  return sameCompany(requested, scopeCompanyId)
    ? { ok: true, companyId: scopeCompanyId }
    : { ok: false, refusal: 'other_company' };
}
