/**
 * What the batch-4 harness shows, read once from the query string.
 *
 * Batch 4 is the sign-in and account screens plus Benutzer, Rollen,
 * Einstellungen and Abonnement. Half of them render before a session exists,
 * so this harness has its own entry, its own fakes and its own scenario rather
 * than extending the batch-1 one other batches are editing at the same time.
 *
 *   screen   login | forgot | verify-email | set-password | invite | signup |
 *            complete-registration | callback | blocked | pending | rejected |
 *            suspended | users | roles | settings | activation | billing
 *   signin   invalid | blocked | unconfirmed | too-many | network | generic
 *            what the fake signIn() answers on /login (default invalid)
 *   notice   platform-google   a notice AuthContext left for /login on mount
 *   google   on | off          what /auth/v1/settings reports (default off)
 *   env      staging           the staging banner, as VITE_DEPLOY_ENV=staging draws it
 *   scope    own | view | support   the company the session is in (default own)
 *   role     admin | viewer    the profile role inside its own company
 *   data     default | empty | error | loading
 *            billing also: expired | inactive | history (inactive with history)
 *   session  none | other      set-password without a session; /einladung while
 *                              another account is signed in
 *   invite   1                 set-password for a pending invitation
 *   intent   invite            complete-registration after an invitation link
 *   theme    light | dark      written to the app's own storage key
 *   lang     de | en           likewise
 */

export type HarnessScreen =
  | 'login'
  | 'forgot'
  | 'verify-email'
  | 'set-password'
  | 'invite'
  | 'signup'
  | 'complete-registration'
  | 'callback'
  | 'blocked'
  | 'pending'
  | 'rejected'
  | 'suspended'
  | 'users'
  | 'roles'
  | 'settings'
  | 'activation'
  | 'billing';

export type HarnessSignIn = 'invalid' | 'blocked' | 'unconfirmed' | 'too-many' | 'network' | 'generic';
export type HarnessScope = 'own' | 'view' | 'support';
export type HarnessRole = 'admin' | 'viewer';
export type HarnessData = 'default' | 'empty' | 'error' | 'loading' | 'expired' | 'inactive' | 'history';

export interface HarnessScenario {
  screen: HarnessScreen;
  signIn: HarnessSignIn;
  notice: 'platform-google' | null;
  google: boolean;
  staging: boolean;
  scope: HarnessScope;
  role: HarnessRole;
  data: HarnessData;
  session: 'default' | 'none' | 'other';
  invite: boolean;
  intentFromInvite: boolean;
}

const params = new URLSearchParams(window.location.search);

function pick<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = params.get(name);
  return (allowed as readonly string[]).includes(value ?? '') ? (value as T) : fallback;
}

const SCREENS = [
  'login', 'forgot', 'verify-email', 'set-password', 'invite', 'signup', 'complete-registration',
  'callback', 'blocked', 'pending', 'rejected', 'suspended', 'users', 'roles', 'settings',
  'activation', 'billing',
] as const;

export const scenario: HarnessScenario = {
  screen: pick('screen', SCREENS, 'login'),
  signIn: pick('signin', ['invalid', 'blocked', 'unconfirmed', 'too-many', 'network', 'generic'] as const, 'invalid'),
  notice: params.get('notice') === 'platform-google' ? 'platform-google' : null,
  google: params.get('google') === 'on',
  staging: params.get('env') === 'staging',
  scope: pick('scope', ['own', 'view', 'support'] as const, 'own'),
  role: pick('role', ['admin', 'viewer'] as const, 'admin'),
  data: pick('data', ['default', 'empty', 'error', 'loading', 'expired', 'inactive', 'history'] as const, 'default'),
  session: pick('session', ['default', 'none', 'other'] as const, 'default'),
  invite: params.get('invite') === '1',
  intentFromInvite: params.get('intent') === 'invite',
};

/** The signed-in screens render inside AppLayout; the rest are full pages of their own. */
export const IN_APP_LAYOUT: ReadonlySet<HarnessScreen> = new Set(['users', 'roles', 'settings', 'activation', 'billing']);

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
export const HARNESS_OTHER_COMPANY_ID = '00000000-0000-4000-8000-0000000000b2';
export const HARNESS_USER_ID = '00000000-0000-4000-8000-0000000000a1';
export const HARNESS_EMAIL = 'katrin.lindner@example.com';

/** The code every harness one-time-code screen accepts; any other six digits are refused. */
export const HARNESS_GOOD_CODE = '482913';
