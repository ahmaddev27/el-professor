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

export const PLATFORM_CONTEXT_MODES = ['view', 'support'] as const;
export type PlatformContextMode = typeof PLATFORM_CONTEXT_MODES[number];

/**
 * The company this account has open, as `platform_whoami().company_context`
 * reports it (plan 3.4). Null when none is open — which, until 3.4b builds the
 * screens that open one, is always.
 *
 * It is not a permission: the database decides again on every statement, by
 * answering `get_active_company_id()` with this company and no other. It is
 * here so the browser can stop offering what the database will refuse.
 */
export interface PlatformCompanyContext {
  companyId: string;
  companyName: string | null;
  mode: PlatformContextMode;
  expiresAt: string | null;
  secondsRemaining: number | null;
}

export interface PlatformAccess {
  role: PlatformRole | null;
  capabilities: readonly PlatformCapability[];
  companyContext: PlatformCompanyContext | null;
}

export const NO_PLATFORM_ACCESS: PlatformAccess = Object.freeze({
  role: null,
  capabilities: Object.freeze([]) as readonly PlatformCapability[],
  companyContext: null,
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
const isMode = (value: unknown): value is PlatformContextMode =>
  typeof value === 'string' && (PLATFORM_CONTEXT_MODES as readonly string[]).includes(value);

/**
 * The open context, or null. Strict on purpose: a body without a company id or
 * with a mode this build does not know is read as "no context", so the screens
 * offer nothing rather than offering something the database will refuse.
 */
function parseCompanyContext(value: unknown): PlatformCompanyContext | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.company_id !== 'string' || !isMode(body.mode)) return null;
  return {
    companyId: body.company_id,
    companyName: typeof body.company_name === 'string' ? body.company_name : null,
    mode: body.mode,
    expiresAt: typeof body.expires_at === 'string' ? body.expires_at : null,
    secondsRemaining: typeof body.seconds_remaining === 'number' ? body.seconds_remaining : null,
  };
}

export function parsePlatformWhoami(data: unknown): PlatformAccess {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return NO_PLATFORM_ACCESS;
  const body = data as Record<string, unknown>;
  if (!isRole(body.role)) return NO_PLATFORM_ACCESS;
  const capabilities = Array.isArray(body.capabilities)
    ? [...new Set(body.capabilities.filter(isCapability))]
    : [];
  return { role: body.role, capabilities, companyContext: parseCompanyContext(body.company_context) };
}

/** The company this account may act on, or null. */
export function platformContextCompanyId(access: PlatformAccess | null | undefined): string | null {
  return access?.companyContext?.companyId ?? null;
}

export function platformAccessCan(access: PlatformAccess | null | undefined, capability: PlatformCapability): boolean {
  return !!access?.role && access.capabilities.includes(capability);
}
