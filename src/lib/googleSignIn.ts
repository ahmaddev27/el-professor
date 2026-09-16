import type { BillingCycle } from '../utils/pricing';
import type { Plan } from '../contexts/PlanContext';
import type { TranslationKey } from '../i18n';

/**
 * Starting a Google sign-in, and the one-time marker that records one is under
 * way (plan step 1.6).
 *
 * The flow is GoTrue's own: the button sends the browser to
 * `/auth/v1/authorize?provider=google`, Google returns to
 * `/auth/v1/callback`, and GoTrue redirects to `redirectTo` with the session in
 * the fragment — the same implicit flow every mail link already uses, so
 * nothing about session handling changes.
 *
 * Two query parameters, and no more:
 *
 * - `prompt=select_account` so a browser signed in to several Google accounts
 *   asks which one, instead of silently reusing the last one. A colleague
 *   signing in on the same machine is otherwise handed the previous account.
 * - **No `access_type=offline`.** That asks Google for a refresh token, which is
 *   only for calling Google's APIs later. We never call one: the account's
 *   address is all we take, and a token nobody uses is a secret we would have to
 *   keep. Our own session is refreshed by GoTrue, not by Google.
 *
 * Scopes are left to GoTrue (`openid email profile` for Google), which is what
 * the Google Cloud client is registered for; naming them here would only let
 * the two drift apart.
 *
 * ## The intent marker
 *
 * Google's redirect carries no memory of where it started, and the errors come
 * back as bare codes in the fragment. The marker is what tells the callback
 * screen that this browser pressed the Google button, which screen it pressed
 * it on (an invited employee needs a different sentence than a new company),
 * and which plan a visitor had picked before leaving for Google.
 *
 * It lives in `sessionStorage`, so it belongs to this tab and disappears with
 * it, holds no address, code or token, and expires after ten minutes — longer
 * than any sign-in takes and short enough that an abandoned one cannot
 * misdirect a later visit. Whoever settles the flow consumes it.
 */

export const GOOGLE_INTENT_STORAGE_KEY = 'el-professor.google-signin';

/** Longer than a sign-in takes, short enough that an abandoned marker cannot be read as a fresh one. */
export const GOOGLE_INTENT_MAX_AGE_MS = 10 * 60 * 1000;

const ORIGINS = ['login', 'signup', 'invite'] as const;

/** The screen the Google button was pressed on. */
export type GoogleSignInOrigin = (typeof ORIGINS)[number];

/** What a visitor had chosen on the signup screen before leaving for Google. */
export interface GoogleSignInSelection {
  plan: Plan;
  carLimit: number;
  billingCycle: BillingCycle;
}

export interface GoogleSignInIntent {
  from: GoogleSignInOrigin;
  /** Epoch milliseconds, for the age check. */
  startedAt: number;
  /** Only the signup screen has one; every other origin stores null. */
  selection: GoogleSignInSelection | null;
}

const PLANS: readonly Plan[] = ['basic', 'advanced', 'premium'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Storage access that never throws. A private window, blocked site data or a
 * full quota must not stop a sign-in: without the marker the callback screen
 * falls back to its generic wording, and nothing else changes.
 */
type MarkerStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function markerStorage(): MarkerStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function clearMarker(): void {
  try {
    markerStorage()?.removeItem(GOOGLE_INTENT_STORAGE_KEY);
  } catch {
    // Nothing to do: an unreadable store is treated as an absent marker.
  }
}

/** The stored selection, or null for anything that is not a complete one. */
function parseSelection(raw: unknown): GoogleSignInSelection | null {
  if (!isRecord(raw)) return null;
  const { plan, carLimit, billingCycle } = raw;
  if (typeof plan !== 'string' || !PLANS.includes(plan as Plan)) return null;
  if (typeof carLimit !== 'number' || !Number.isFinite(carLimit) || carLimit < 1) return null;
  if (billingCycle !== 'monthly' && billingCycle !== 'yearly') return null;
  return { plan: plan as Plan, carLimit: Math.floor(carLimit), billingCycle };
}

/** The pure half: a stored string and the current time become an intent, or null. */
export function parseGoogleSignInIntent(raw: string | null, nowMs: number): GoogleSignInIntent | null {
  if (!raw) return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;

  const { from, startedAt } = body;
  if (typeof from !== 'string' || !ORIGINS.includes(from as GoogleSignInOrigin)) return null;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  // Both directions: a marker from the future is a clock change, not a sign-in
  // this browser started a moment ago.
  const age = nowMs - startedAt;
  if (age < 0 || age > GOOGLE_INTENT_MAX_AGE_MS) return null;

  return { from: from as GoogleSignInOrigin, startedAt, selection: parseSelection(body.selection) };
}

/** Records that this tab is leaving for Google. Replaces any earlier marker. */
export function markGoogleSignInIntent(
  from: GoogleSignInOrigin,
  selection: GoogleSignInSelection | null = null,
  nowMs: number = Date.now(),
): void {
  const intent: GoogleSignInIntent = { from, startedAt: nowMs, selection };
  try {
    markerStorage()?.setItem(GOOGLE_INTENT_STORAGE_KEY, JSON.stringify(intent));
  } catch {
    // See markerStorage: the sign-in continues without the marker.
  }
}

/** Reads the marker without consuming it. An unusable one is cleared. */
export function readGoogleSignInIntent(nowMs: number = Date.now()): GoogleSignInIntent | null {
  let raw: string | null = null;
  try {
    raw = markerStorage()?.getItem(GOOGLE_INTENT_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  const intent = parseGoogleSignInIntent(raw, nowMs);
  if (!intent && raw !== null) clearMarker();
  return intent;
}

/** Reads the marker and removes it: the flow it described is over. */
export function consumeGoogleSignInIntent(nowMs: number = Date.now()): GoogleSignInIntent | null {
  const intent = readGoogleSignInIntent(nowMs);
  clearMarker();
  return intent;
}

// ─── Starting the flow ──────────────────────────────────────────────────────

/** What supabase-js is handed. Structural, so the module needs no client import. */
export interface GoogleOAuthCredentials {
  provider: 'google';
  options: {
    redirectTo: string;
    queryParams: Record<string, string>;
  };
}

/**
 * The credentials of every Google sign-in. `prompt=select_account` and nothing
 * else; see the header for why `access_type` is absent and scopes are GoTrue's.
 */
export function googleOAuthCredentials(redirectTo: string): GoogleOAuthCredentials {
  return {
    provider: 'google',
    options: { redirectTo, queryParams: { prompt: 'select_account' } },
  };
}

/** The supabase-js surface this module uses, narrowed so a test can pass a fake. */
export interface OAuthCapableClient {
  auth: {
    signInWithOAuth: (credentials: GoogleOAuthCredentials) => PromiseLike<{ error: unknown }>;
  };
}

export type GoogleSignInStart = { ok: true } | { ok: false; message: TranslationKey };

export interface StartGoogleSignInOptions {
  selection?: GoogleSignInSelection | null;
  /** Injected by the tests; production takes the app's own client and origin. */
  client?: OAuthCapableClient;
  appOrigin?: string;
  now?: number;
}

/**
 * Marks the intent and hands the browser to Google. Resolves only when the
 * redirect did not happen — on success the page is already leaving.
 *
 * The client is imported when the button is pressed rather than at module load,
 * so this file stays free of the browser-only globals `lib/supabase` reads, and
 * the tests can run it in Node without a DOM.
 */
export async function startGoogleSignIn(
  from: GoogleSignInOrigin,
  options: StartGoogleSignInOptions = {},
): Promise<GoogleSignInStart> {
  const now = options.now ?? Date.now();
  markGoogleSignInIntent(from, options.selection ?? null, now);

  try {
    let client = options.client;
    let origin = options.appOrigin;
    if (!client || origin === undefined) {
      const module = await import('./supabase');
      client = client ?? (module.supabase as unknown as OAuthCapableClient);
      origin = origin ?? module.appOrigin;
    }

    const { error } = await client.auth.signInWithOAuth(
      googleOAuthCredentials(`${origin.replace(/\/$/, '')}/auth/callback`),
    );
    if (error) {
      consumeGoogleSignInIntent(now);
      return { ok: false, message: 'auth.google.error.startFailed' };
    }
    return { ok: true };
  } catch {
    consumeGoogleSignInIntent(now);
    return { ok: false, message: 'auth.google.error.startFailed' };
  }
}
