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
  /**
   * When the context ends on *this browser's* clock, or null when the answer
   * carried no expiry the browser can use — which the gate reads as ended.
   *
   * Counted from `seconds_remaining` and the moment the answer arrived rather
   * than from `expires_at`, because the database computes the remainder on its
   * own clock: a laptop set an hour wrong still closes the company when the
   * database does. The database floors the remainder, so this runs up to a
   * second early, and late by no more than the round trip.
   */
  expiresAtMs: number | null;
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
 *
 * Exported because `platform_context_open` answers the very same body in its
 * `context` field (20260917140000, section 9). Reading that answer is what lets
 * a screen open a company and go straight there: the alternative is to ask
 * `platform_whoami()` again and navigate before it lands, into the window where
 * the browser still holds no context and `PlatformAccountGuard` bounces the tab
 * back to the panel. It is the database's own answer either way, not a guess.
 */
export function parsePlatformCompanyContext(value: unknown, receivedAt: number): PlatformCompanyContext | null {
  return parseCompanyContext(value, receivedAt);
}

function parseCompanyContext(value: unknown, receivedAt: number): PlatformCompanyContext | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.company_id !== 'string' || !isMode(body.mode)) return null;
  const expiresAt = typeof body.expires_at === 'string' ? body.expires_at : null;
  const secondsRemaining =
    typeof body.seconds_remaining === 'number' && Number.isFinite(body.seconds_remaining)
      ? body.seconds_remaining
      : null;
  return {
    companyId: body.company_id,
    companyName: typeof body.company_name === 'string' ? body.company_name : null,
    mode: body.mode,
    expiresAt,
    secondsRemaining,
    expiresAtMs: contextEndMs(secondsRemaining, expiresAt, receivedAt),
  };
}

/** The remainder when the answer has one; the absolute time only as a fallback. */
function contextEndMs(secondsRemaining: number | null, expiresAt: string | null, receivedAt: number): number | null {
  if (secondsRemaining !== null) return receivedAt + Math.max(0, secondsRemaining) * 1000;
  if (expiresAt === null) return null;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) ? at : null;
}

/**
 * `receivedAt` is when the answer arrived, on this browser's clock — the
 * instant `seconds_remaining` counts from. Injected so the clock is testable.
 */
export function parsePlatformWhoami(data: unknown, receivedAt: number = Date.now()): PlatformAccess {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return NO_PLATFORM_ACCESS;
  const body = data as Record<string, unknown>;
  if (!isRole(body.role)) return NO_PLATFORM_ACCESS;
  const capabilities = Array.isArray(body.capabilities)
    ? [...new Set(body.capabilities.filter(isCapability))]
    : [];
  return {
    role: body.role,
    capabilities,
    companyContext: parseCompanyContext(body.company_context, receivedAt),
  };
}

export function platformAccessCan(access: PlatformAccess | null | undefined, capability: PlatformCapability): boolean {
  return !!access?.role && access.capabilities.includes(capability);
}

// ─── The company gate ────────────────────────────────────────────────────────
//
// Since 20260917140000 (plan 3.4) a platform account reads a company's business
// data only through an open context, and get_active_company_id() answers with
// that company and no other. A screen reached without one renders against rows
// the database returns nothing for: every list empty, every total a confident
// zero, and no error to say why. These functions are the browser's one copy of
// that rule. None of them is the boundary — the database decides again on every
// statement — but each one is what stops a screen claiming what it never read.
//
// Every one takes `now`, because a context ends by the clock and not by an
// event: an answer that said "open" at 10:00 is wrong at 11:01 whether or not
// anyone has asked again since.

/**
 * The open context, if it has not ended by `now`. Null when there is none, when
 * it has run out, and when its answer carried no expiry the browser can use: a
 * context the screens cannot time is a context they do not act on.
 */
export function liveCompanyContext(
  access: PlatformAccess | null | undefined,
  now: number,
): PlatformCompanyContext | null {
  const context = access?.companyContext ?? null;
  if (context === null || context.expiresAtMs === null) return null;
  return context.expiresAtMs > now ? context : null;
}

/** Whether `companyId` may be opened: `business.read`, and a live context on that very company. */
export function platformCanEnterCompany(
  access: PlatformAccess | null | undefined,
  companyId: string,
  now: number,
): boolean {
  if (!platformAccessCan(access, 'business.read')) return false;
  return liveCompanyContext(access, now)?.companyId === companyId;
}

/**
 * The seam as the database answers it, for the company a screen is reading.
 * False for a company user, for whom it means nothing: such an account reads
 * its own data through its membership, not through a context.
 */
export function platformReadsCompany(
  access: PlatformAccess | null | undefined,
  companyId: string | null,
  now: number,
): boolean {
  return companyId !== null && platformCanEnterCompany(access, companyId, now);
}

/** Milliseconds until the open context ends, for a timer; null when none is live. */
export function msUntilContextEnds(access: PlatformAccess | null | undefined, now: number): number | null {
  const context = liveCompanyContext(access, now);
  if (context === null || context.expiresAtMs === null) return null;
  return context.expiresAtMs - now;
}

/**
 * Whether two answers grant the same thing.
 *
 * `secondsRemaining` and `expiresAtMs` are left out on purpose: they differ in
 * every answer, so an answer that differs only in them is not news. Replacing
 * the state with it would re-run everything keyed on the access each time the
 * tab regained focus, and the earlier `expiresAtMs` is still a correct estimate
 * of the same `expiresAt`.
 */
export function samePlatformAccess(a: PlatformAccess, b: PlatformAccess): boolean {
  if (a.role !== b.role) return false;
  if (a.capabilities.length !== b.capabilities.length) return false;
  if (!a.capabilities.every(capability => b.capabilities.includes(capability))) return false;
  const x = a.companyContext;
  const y = b.companyContext;
  if (x === null || y === null) return x === y;
  return x.companyId === y.companyId
    && x.companyName === y.companyName
    && x.mode === y.mode
    && x.expiresAt === y.expiresAt;
}

/**
 * The same access with no company open — what a re-ask that failed leaves. It
 * closes the company and keeps the panel: a request lost on a flaky connection
 * must not sign staff out of /admin, but it must not keep a company open on an
 * answer nobody can confirm either. Returns the same object when nothing was
 * open, so a failed re-ask with no context changes no state.
 */
export function withoutCompanyContext(access: PlatformAccess): PlatformAccess {
  return access.companyContext === null ? access : { ...access, companyContext: null };
}

/**
 * Whether the account's *own* company answers its business tables.
 *
 * For a company user the router has already settled it: App.tsx refuses a
 * blocked account or company before any tenant screen renders, on the same
 * conditions get_active_company_id() applies. A platform account skips those
 * gates (`isSuperAdmin`, App.tsx), yet the database still applies them to its
 * own company — and answers NULL, not the context, because the staff branch is
 * for company-less accounts only. The browser holds no copy to judge by:
 * AuthContext loads a company's approval and subscription only for accounts
 * that are not platform staff, and keeps no company status at all. So for staff
 * the one trustworthy answer is the database's own, and not yet answered,
 * failed or NULL all read as no.
 */
export function ownCompanyDataReadable({
  accountIsPlatformStaff,
  ownCompanyId,
  activeCompanyId,
}: {
  accountIsPlatformStaff: boolean;
  ownCompanyId: string | null;
  /** What get_active_company_id() last answered; undefined until it has. */
  activeCompanyId: string | null | undefined;
}): boolean {
  if (!accountIsPlatformStaff) return true;
  return ownCompanyId !== null && activeCompanyId === ownCompanyId;
}
