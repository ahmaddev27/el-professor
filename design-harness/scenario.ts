/**
 * What the harness shows, read once from the query string.
 *
 *   screen  fahrzeuge | fixkosten | gehaelter | abrechnung | bargeld   (default fahrzeuge)
 *   data    default | empty | limit | error | missing | loading | drivers-error
 *           limit:   the plan's car limit equals the active vehicles
 *           error:   the first read fails with a network error
 *           missing: the first read fails as if the table did not exist (PGRST204)
 *           loading: the first read never answers
 *           drivers-error: Gehälter only, the driver list itself fails to load
 *   role    admin | viewer | view | billing                (viewer may read, not edit)
 *           view:    a platform account inside a read-only view context
 *           billing: a platform billing account inside a view context; it
 *                    holds no business.read, so the cash ledger is out of scope
 *   theme   light | dark                                (written to the app's own storage key)
 *   lang    de | en                                     (likewise)
 */

export type HarnessScreen = 'fahrzeuge' | 'fixkosten' | 'gehaelter' | 'abrechnung' | 'bargeld';
export type HarnessData = 'default' | 'empty' | 'limit' | 'error' | 'missing' | 'loading' | 'drivers-error';
export type HarnessRole = 'admin' | 'viewer' | 'view' | 'billing';

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
  screen: pick('screen', ['fahrzeuge', 'fixkosten', 'gehaelter', 'abrechnung', 'bargeld'] as const, 'fahrzeuge'),
  data: pick('data', ['default', 'empty', 'limit', 'error', 'missing', 'loading', 'drivers-error'] as const, 'default'),
  role: pick('role', ['admin', 'viewer', 'view', 'billing'] as const, 'admin'),
};

/** A platform account inside a company's view context, rather than a member of it. */
export const isPlatformReader = scenario.role === 'view' || scenario.role === 'billing';

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
