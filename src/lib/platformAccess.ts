/**
 * What the signed-in account may do on the platform, as `platform_whoami()`
 * reports it (plan 3.1).
 *
 * The database is the authority: `app_private.platform_staff` holds the role,
 * `app_private.platform_capability_matrix()` the capabilities, and every policy
 * and RPC checks them again. This module only shapes the answer for the screens,
 * which hide what a role cannot do. The names below are there for type checking;
 * who holds which is never decided here.
 *
 * `user_profiles.is_super_admin` is not read here and grants nothing. It only
 * tells the app whether an account is worth asking about.
 */

export const PLATFORM_ROLES = ['owner', 'support', 'billing', 'read_only'] as const;
export type PlatformRole = typeof PLATFORM_ROLES[number];

export const PLATFORM_CAPABILITIES = [
  'companies.read',
  'business.read',
  'support.session',
  'company_users.manage',
  'companies.lifecycle',
  'companies.hard_delete',
  'billing.manage',
  'pricing.manage',
  'codes.manage',
  'settings.read',
  'settings.manage',
  'metrics.read',
  'audit.read',
  'staff.manage',
] as const;
export type PlatformCapability = typeof PLATFORM_CAPABILITIES[number];

export interface PlatformAccess {
  role: PlatformRole | null;
  capabilities: readonly PlatformCapability[];
}

export const NO_PLATFORM_ACCESS: PlatformAccess = Object.freeze({
  role: null,
  capabilities: Object.freeze([]) as readonly PlatformCapability[],
});

const isRole = (value: unknown): value is PlatformRole =>
  typeof value === 'string' && (PLATFORM_ROLES as readonly string[]).includes(value);

const isCapability = (value: unknown): value is PlatformCapability =>
  typeof value === 'string' && (PLATFORM_CAPABILITIES as readonly string[]).includes(value);

/**
 * Reads a `platform_whoami()` answer. Anything unexpected — a missing or unknown
 * role, a malformed body — means no access, and capabilities without a role are
 * dropped: the screens must never show more than the database would allow.
 */
export function parsePlatformWhoami(data: unknown): PlatformAccess {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return NO_PLATFORM_ACCESS;
  const body = data as Record<string, unknown>;
  if (!isRole(body.role)) return NO_PLATFORM_ACCESS;
  const capabilities = Array.isArray(body.capabilities)
    ? [...new Set(body.capabilities.filter(isCapability))]
    : [];
  return { role: body.role, capabilities };
}

export function platformAccessCan(access: PlatformAccess | null | undefined, capability: PlatformCapability): boolean {
  return !!access?.role && access.capabilities.includes(capability);
}
