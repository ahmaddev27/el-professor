/**
 * What GoTrue says it accepts, read from `GET /auth/v1/settings` (plan 1.6).
 *
 * The Google button is rendered only when GoTrue reports the provider enabled.
 * The switch is an environment variable on the host (`GOOGLE_SIGNIN_ENABLED`),
 * so the bundle cannot know its value: a button built from a build-time flag
 * would either show while the provider is off — every press ending in a 400
 * from GoTrue — or stay hidden after the owner turns it on, until the next
 * release. Asking the server is the only answer that is right in both
 * directions, and it needs no session: the route is public, and the settings it
 * returns are public knowledge about the deployment.
 *
 * The answer is read **once per page load** and shared by every screen. It
 * cannot change without a redeploy, which loads the page again.
 *
 * Any failure — an unreachable API, a body that is not JSON, a field that is
 * not a boolean — reads as "off". The conservative direction: the password form
 * is always there, so a hidden button costs a sign-in nobody was promised,
 * while a button that cannot work costs a failed one.
 */

export interface AuthProviderSettings {
  /** Whether GoTrue accepts `provider=google` right now. */
  google: boolean;
}

/** What every failure and every unrecognised answer resolves to. */
export const AUTH_PROVIDERS_OFF: AuthProviderSettings = { google: false };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads GoTrue's `/settings` body. Only `external.google === true` counts as
 * on; anything else, including a missing field or a truthy string, is off.
 */
export function parseAuthProviderSettings(body: unknown): AuthProviderSettings {
  if (!isRecord(body) || !isRecord(body.external)) return AUTH_PROVIDERS_OFF;
  return { google: body.external.google === true };
}

/** One uncached read. Exported for the tests; screens use `loadAuthProviderSettings`. */
export async function fetchAuthProviderSettings(): Promise<AuthProviderSettings> {
  const baseUrl = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  const anonKey = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '');
  if (!baseUrl) return AUTH_PROVIDERS_OFF;

  try {
    const response = await fetch(`${baseUrl}/auth/v1/settings`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    if (!response.ok) return AUTH_PROVIDERS_OFF;
    return parseAuthProviderSettings(await response.json());
  } catch {
    return AUTH_PROVIDERS_OFF;
  }
}

let pending: Promise<AuthProviderSettings> | null = null;

/**
 * The settings for this page load, fetched at most once however many buttons
 * ask. The promise itself is cached, so buttons that mount together share one
 * request rather than racing.
 */
export function loadAuthProviderSettings(): Promise<AuthProviderSettings> {
  pending ??= fetchAuthProviderSettings();
  return pending;
}

/** Drops the cache. For the tests; nothing in the app calls it. */
export function resetAuthProviderSettingsCache(): void {
  pending = null;
}
