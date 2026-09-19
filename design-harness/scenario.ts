/**
 * What the harness shows, read once from the query string.
 *
 *   screen  fahrzeuge | fixkosten                       (default fahrzeuge)
 *   data    default | empty | limit | error | missing | loading
 *           limit:   the plan's car limit equals the active vehicles
 *           error:   the first read fails with a network error
 *           missing: the first read fails as if the table did not exist (PGRST204)
 *           loading: the first read never answers
 *   role    admin | viewer                              (viewer may read, not edit)
 *   theme   light | dark                                (written to the app's own storage key)
 *   lang    de | en                                     (likewise)
 */

export type HarnessScreen = 'fahrzeuge' | 'fixkosten';
export type HarnessData = 'default' | 'empty' | 'limit' | 'error' | 'missing' | 'loading';
export type HarnessRole = 'admin' | 'viewer';

export interface HarnessScenario {
  screen: HarnessScreen;
  data: HarnessData;
  role: HarnessRole;
}

const params = new URLSearchParams(window.location.search);

function pick<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = params.get(name);
  return (allowed as readonly string[]).includes(value ?? '') ? (value as T) : fallback;
}

export const scenario: HarnessScenario = {
  screen: pick('screen', ['fahrzeuge', 'fixkosten'] as const, 'fahrzeuge'),
  data: pick('data', ['default', 'empty', 'limit', 'error', 'missing', 'loading'] as const, 'default'),
  role: pick('role', ['admin', 'viewer'] as const, 'admin'),
};

/** Applied before the providers read storage, so a URL alone sets the look. */
export function applyStoredPreferences(): void {
  const theme = params.get('theme');
  const lang = params.get('lang');
  try {
    if (theme === 'light' || theme === 'dark') localStorage.setItem('ya-theme', theme);
    if (lang === 'de' || lang === 'en') localStorage.setItem('ya-language', lang);
  } catch {
    // Storage blocked: the app's defaults (dark, German) apply.
  }
}

export const HARNESS_COMPANY_ID = '00000000-0000-4000-8000-00000000c0de';
export const HARNESS_USER_ID = '00000000-0000-4000-8000-0000000000a1';
