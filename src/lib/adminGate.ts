/**
 * The platform panel's front door (plan slice 3.6a, unified on 17.09.2026).
 *
 * `/admin` is the panel's entry, and its sign-in is **the company sign-in**.
 * The owner decided on 17.09.2026 that there is one sign-in screen for platform
 * accounts and company users alike, routed by account once a session exists —
 * which reverses the half of slice 3.6a that gave the panel a front door of its
 * own. So `/login` is the only place anyone types a password, `/admin/login`
 * (that front door, 16.–17.09.2026) is kept as a redirect onto it so bookmarks
 * and the remembered return path keep working, and `/super-admin` (the entry
 * before both) is still rewritten onto `/admin` until plan slice 3.13 removes
 * it. One panel and one sign-in, with no second copy of either to drift.
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

/**
 * The one sign-in screen, for platform accounts and company users alike.
 *
 * Nothing knows who a visitor is before they sign in, so this screen offers
 * everything any of them may need — the Google button included — and the
 * account decides where the session goes afterwards. A platform account that
 * arrives here by Google is refused: see `googleSignInRefusal` below.
 */
export const SIGN_IN_PATH = '/login';

/**
 * The panel's own sign-in page, 16.–17.09.2026. It is not deleted: it redirects
 * onto `SIGN_IN_PATH`, carrying any remembered return path with it, so a
 * bookmark taken during that day still ends somewhere that signs people in.
 */
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
 * What the browser gets at `/login`, and at every platform path.
 *
 * - `loading` — wait; the session or its profile has not answered.
 * - `signIn` — no session: the one sign-in screen.
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
    case 'signIn': return SIGN_IN_PATH;
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
 * segment that would climb back out are all dropped. The old panel sign-in is
 * dropped too, because it now redirects onto `SIGN_IN_PATH` and would hand the
 * path straight back; `SIGN_IN_PATH` itself never passes the panel-path test.
 */
export function platformReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value === ADMIN_LOGIN_PATH || value.startsWith(`${ADMIN_LOGIN_PATH}/`)) return null;
  if (value !== ADMIN_BASE && !value.startsWith(`${ADMIN_BASE}/`)) return null;
  if (value.includes('\\')) return null;
  if (value.split('/').includes('..')) return null;
  return value;
}

/**
 * The remembered panel path a router location carries, validated.
 *
 * It travels in the router's own location state rather than in the query
 * string, so it never appears in the address bar — and it survives the router
 * swap that signing in performs, because react-router keeps that state in the
 * history entry, which a freshly mounted router reads back.
 *
 * Read through `platformReturnPath`, and read that way **every** time it
 * changes hands: `/admin/login` validates it before passing it on and the
 * sign-in screen validates it again before following it. Nothing about a value
 * that has been checked once makes it safe the second time it is used.
 */
export function rememberedPanelPath(state: unknown): string | null {
  const from = (state as { from?: unknown } | null | undefined)?.from;
  return platformReturnPath(from);
}

/**
 * Where `/admin/login` sends a browser, and what it takes along.
 *
 * The owner's decision of 17.09.2026 left the path in place rather than
 * deleting it: a bookmark from the day the panel had its own front door, and
 * the `PlatformSignInRedirect` that still remembers where a signed-out visitor
 * was heading, both end on the one sign-in screen with that destination intact.
 */
export function legacyAdminLoginRedirect(state: unknown): { to: string; from: string | null } {
  return { to: SIGN_IN_PATH, from: rememberedPanelPath(state) };
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

// ─── Where a platform account belongs, on this load ──────────────────────────

/**
 * What `PlatformAccountGuard` (App.tsx) renders.
 *
 * - `tenant` — the company app, because this session is in a company.
 * - `panel` — `/admin`, because it is not.
 * - `wait` — **neither, yet.** The account is platform staff and
 *   `platform_whoami()` has not answered, so which of the two is right is not
 *   known.
 *
 * ## Why `wait` exists, measured rather than reasoned
 *
 * Opening a company and then reloading the page threw the session out of it —
 * seen on staging on 18.09.2026: after the reload the address was `/admin`, the
 * platform overview was on screen, and the read-only bar above it still named
 * the company. No `platform_context_close` was ever sent and `platform_whoami`
 * went on being asked, so the context had survived exactly as designed. What
 * had not survived was the routing: on a fresh load this guard ran before the
 * first whoami answered, saw no company, and redirected; the answer arrived a
 * moment later, too late to matter.
 *
 * So the state this reads is not "is there a company" but "do we know yet", and
 * `platformAccessStatus` is where that is recorded. It is `loading` only for the
 * *first* question — a re-ask keeps the previous answer on screen — so this
 * blocks a fresh load and never a tab regaining focus. `idle` is the same
 * unknown one render earlier, before the provider's effect has run.
 *
 * ## What `wait` must not become
 *
 * A spinner, and never "assume allowed". A guard that lets the tenant router
 * mount before it knows is the shape that put the owner's own Google signup
 * into a company-less tenant router, where every query asked for
 * `company_id = null` and the screens filled with
 * `invalid input syntax for type uuid: "null"` — the incident
 * `needsCompanyRegistration` was written for.
 *
 * A failed whoami is **not** `wait`: it is `panel`, which is where AdminLayout
 * shows the failure with a retry. An unanswered question is not permission, and
 * a question that failed is not a reason to spin for ever.
 */
export type PlatformAccountRoute = 'tenant' | 'panel' | 'wait';

export interface PlatformAccountRouteState {
  /** The profile flag: routing only, never a right. */
  isSuperAdmin: boolean;
  platformAccessStatus: PlatformAccessState;
  /** `SuperAdminContext.effectiveCompanyId` — own company, or the open context. */
  hasCompany: boolean;
}

export function platformAccountRoute(state: PlatformAccountRouteState): PlatformAccountRoute {
  // A company user is never this guard's business, and a platform account that
  // already has a company — its own, or an open context — needs no answer to
  // decide: the tenant router is right either way.
  if (!state.isSuperAdmin || state.hasCompany) return 'tenant';
  if (state.platformAccessStatus === 'idle' || state.platformAccessStatus === 'loading') return 'wait';
  return 'panel';
}

// ─── A platform account that arrived by Google ───────────────────────────────

/** What a refused Google session is shown, and where. */
export interface GoogleSignInRefusal {
  /** The address the browser is put on before the session ends. */
  to: string;
  /** The sentence that screen then shows. */
  messageKey: TranslationKey;
}

/**
 * Whether a settled Google session must be ended because it belongs to a
 * platform account — the owner's decision of 16.09.2026, that platform staff
 * sign in with an email address and a password and never with Google.
 *
 * **`cameFromGoogle` is `sessionCameFromGoogle(user, hasIntent)`: "this session
 * was minted by Google", and never "this account has a Google identity".** A
 * platform account whose address also exists at Google would otherwise be
 * signed out of a correct password sign-in — the whole reason that test is
 * written the way it is (`src/lib/googleAccount.ts`).
 *
 * The browser's refusal is the **message**, not the wall. Since
 * `20260919130000` the database itself answers NULL to every platform
 * capability asked from a session GoTrue did not mint with a password
 * (`app_private.session_amr_permits_platform`), so a Google session reaches
 * **none** of the panel's data whatever this decides — `platform_whoami`,
 * `platform_can`, the five read models, both settings RPCs and every write RPC
 * refuse together. What this decides is only whether the person is told why, or
 * left staring at an empty panel. So it must not be "simplified away" on the
 * grounds that the server covers it — and equally, it must not be *promoted*
 * into the wall: the wall is in the database on purpose, because a browser
 * check protects nothing that a direct call to PostgREST cannot skip.
 *
 * One sign-in screen means one place for that sentence, and `SIGN_IN_PATH` is
 * where the caller puts the address before ending the session: signing out
 * swaps the public router in, and it starts wherever the address points.
 */
export function googleSignInRefusal(session: {
  cameFromGoogle: boolean;
  isPlatformAccount: boolean;
}): GoogleSignInRefusal | null {
  if (!session.cameFromGoogle || !session.isPlatformAccount) return null;
  return { to: SIGN_IN_PATH, messageKey: 'auth.google.error.platformStaff' };
}
