/**
 * The platform panel's front door (plan slice 3.6a).
 *
 * `/admin` is the panel's own entry, and `/admin/login` its own sign-in page:
 * platform staff no longer reach the panel by signing in through the company
 * login and being routed onward. `/super-admin` was that entry and keeps
 * working — every one of its paths is rewritten onto `/admin` below, so there
 * is one panel and not two — until plan slice 3.13 removes it.
 *
 * **None of this is a security boundary.** It decides which screen a browser is
 * shown. What a platform account may read or write is decided in the database,
 * by `platform_can()` and by RLS, on every call. `user_profiles.is_super_admin`
 * is read here for routing only — it has granted nothing since plan slice 3.1 —
 * and the role and capabilities come from `platform_whoami()`, through
 * SuperAdminContext.
 *
 * Kept pure and out of the components so the decisions can be tested: vitest
 * runs in node here, with no DOM and no React testing library.
 */

import type { TranslationKey } from '../i18n';

/** The panel's entry. Every platform screen lives below it. */
export const ADMIN_BASE = '/admin';

/** The platform team's own sign-in page: email and password, nothing else. */
export const ADMIN_LOGIN_PATH = '/admin/login';

/** The panel's previous entry, kept working until plan slice 3.13. */
export const LEGACY_ADMIN_BASE = '/super-admin';

/** Where a company user belongs when it asks for a platform path. */
export const TENANT_HOME = '/overview';

// ─── The old entry ───────────────────────────────────────────────────────────

/**
 * The `/admin` path a `/super-admin` one names, or null when the path is not a
 * platform one at all.
 *
 * The panel is registered once, under `/admin`; this is what keeps the old
 * entry working without a second copy of the routes, which could drift from the
 * first. Bookmarks, and the in-app links that still point at `/super-admin`
 * (the company sidebar, the user menu, the overview card, the platform
 * dashboard's own links), therefore land on exactly the screen they always did.
 * Slice 3.13 deletes this together with those links.
 */
export function legacyAdminTarget(pathname: string): string | null {
  if (pathname === LEGACY_ADMIN_BASE) return ADMIN_BASE;
  if (!pathname.startsWith(`${LEGACY_ADMIN_BASE}/`)) return null;
  return ADMIN_BASE + pathname.slice(LEGACY_ADMIN_BASE.length);
}

// ─── Who reaches the panel ───────────────────────────────────────────────────

/** As much of the session as the front door has to know. */
export interface PlatformSessionState {
  /** AuthContext is still reading the stored session. */
  authLoading: boolean;
  hasSession: boolean;
  /**
   * The profile query has *answered* for this session — with a row or with
   * none. A profile that has not loaded is not an account without one, and
   * reading the first as the second is what would route a platform account into
   * the tenant app for the rest of its session.
   */
  profileLoaded: boolean;
  /** `user_profiles.is_super_admin`: routing only, and it grants nothing. */
  isSuperAdmin: boolean;
}

/**
 * What the browser gets at `/admin` and at `/admin/login`.
 *
 * - `loading` — wait; the session or its profile has not answered.
 * - `signIn` — no session: the platform sign-in page.
 * - `panel` — an account the panel is for. Whether it may actually use it is
 *   `decideAdminGate` below, and then the database.
 * - `tenant` — a signed-in company user: its own app, not an empty shell.
 */
export type PlatformEntry = 'loading' | 'signIn' | 'panel' | 'tenant';

export function platformEntry(state: PlatformSessionState): PlatformEntry {
  if (state.authLoading) return 'loading';
  if (!state.hasSession) return 'signIn';
  if (!state.profileLoaded) return 'loading';
  return state.isSuperAdmin ? 'panel' : 'tenant';
}

/** Where an entry decision points, or null while there is nothing to decide. */
export function platformEntryPath(entry: PlatformEntry): string | null {
  switch (entry) {
    case 'signIn': return ADMIN_LOGIN_PATH;
    case 'panel':  return ADMIN_BASE;
    case 'tenant': return TENANT_HOME;
    default:       return null;
  }
}

/**
 * The panel path a signed-out visitor was heading for, if going back to it is
 * safe — otherwise null, and the caller falls back to the panel's entry.
 *
 * Without this a bookmark of `/admin/protokoll` ends on the dashboard, because
 * the sign-in page is reached by a redirect that remembers nothing.
 *
 * It is a validator and not a formality: a value that decides where a browser
 * goes after signing in is an open redirect the moment it is taken on trust.
 * Only a path inside the panel is kept — an absolute URL, a protocol-relative
 * `//host`, a backslash the browser may read as a separator, and any `..`
 * segment that would climb back out are all dropped. The sign-in page itself is
 * dropped too: `AdminLoginRoute` would answer it with this same path, forever.
 */
export function platformReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value === ADMIN_LOGIN_PATH || value.startsWith(`${ADMIN_LOGIN_PATH}/`)) return null;
  if (value !== ADMIN_BASE && !value.startsWith(`${ADMIN_BASE}/`)) return null;
  if (value.includes('\\')) return null;
  if (value.split('/').includes('..')) return null;
  return value;
}

// ─── What the panel itself shows ─────────────────────────────────────────────

/** Where the `platform_whoami()` answer for this account stands. */
export type PlatformAccessState = 'idle' | 'loading' | 'ready' | 'error';

export interface AdminGateState {
  /** Routing only, as above. */
  isSuperAdmin: boolean;
  platformAccessStatus: PlatformAccessState;
  /** `platform_whoami()` reported an active role. */
  hasPlatformRole: boolean;
}

/**
 * What AdminLayout renders.
 *
 * - `notPlatform` — not an account for this shell: send it to the company app.
 * - `loading` — `platform_whoami()` has not answered yet.
 * - `accessUnknown` — it failed. The panel stays shut and the screen offers a
 *   retry: an unanswered question is not permission.
 * - `noRole` — it answered, and this account has no active role.
 * - `panel` — the shell, with the navigation the role's capabilities allow.
 */
export type AdminGateDecision = 'notPlatform' | 'loading' | 'accessUnknown' | 'noRole' | 'panel';

export function decideAdminGate(state: AdminGateState): AdminGateDecision {
  if (!state.isSuperAdmin) return 'notPlatform';
  if (state.platformAccessStatus === 'idle' || state.platformAccessStatus === 'loading') return 'loading';
  if (state.platformAccessStatus === 'error') return 'accessUnknown';
  return state.hasPlatformRole ? 'panel' : 'noRole';
}

// ─── What a failed platform sign-in says ─────────────────────────────────────

/**
 * The message the platform sign-in page shows for a failure.
 *
 * Every refusal reads the same: a wrong password, an address nobody has, an
 * unconfirmed one, a suspended account, a company that is not approved. The
 * page is a directory of the people who administer the platform, so a message
 * that told those apart would answer, to anyone who asked, whether an address
 * is one of them. The company login is free to be more helpful — it has a
 * signup page beside it, so the same question is already answerable there.
 *
 * Two answers are kept, because neither says anything about an address:
 *
 * - the rate limit, which GoTrue applies per client address (the `X-Client-IP`
 *   Caddy writes), so it is reached by guessing, not by existing. Collapsing it
 *   into the generic message would leave a locked-out owner retrying a password
 *   that is correct.
 * - a request that never arrived.
 */
export function platformSignInMessageKey(error: { message?: unknown } | null | undefined): TranslationKey {
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  if (message.includes('too many requests') || message.includes('rate limit')) {
    return 'admin.login.tooManyAttempts';
  }
  if (message.includes('network') || message.includes('failed to fetch')) {
    return 'admin.login.network';
  }
  return 'admin.login.failed';
}
