import type { TranslationKey } from '../i18n';

/**
 * What a failed redirect back from Google says, in German and English
 * (plan 1.6).
 *
 * GoTrue v2.170.0 answers a failed external sign-in by redirecting to the app
 * with three parameters (`internal/api/external.go`, `redirectErrors`):
 *
 *   #error=access_denied&error_code=user_banned&error_description=...
 *
 * `error` is the OAuth2 family (`access_denied`, `server_error`), `error_code`
 * is GoTrue's own code from `internal/api/errorcodes.go`, and
 * `error_description` is an English sentence written for a developer. Only the
 * codes are mapped: the sentence is never shown, so no English text leaks into
 * the German UI and no wording change in GoTrue can break a screen.
 *
 * The list below is the closed set of codes an *external provider callback* can
 * produce. Everything else — including every code that belongs to password,
 * MFA or SAML routes — falls through to one generic sentence, which is the
 * conservative outcome: a sentence that fits is better than a wrong one.
 */

/** GoTrue's `error_code` values that reach the browser after a Google sign-in. */
const ERROR_CODE_KEYS: Readonly<Record<string, TranslationKey>> = {
  // The person pressed "cancel" at Google, or their Google account may not use
  // this app. GoTrue passes it through as access_denied with no code of its own.
  access_denied: 'auth.google.error.cancelled',

  // Google has the address but has not verified it. GoTrue refuses to hand out
  // a session for an unverified address, and it is right to: the whole account
  // model assumes one confirmed address per person.
  provider_email_needs_verification: 'auth.google.error.emailNotVerified',

  // The account is banned in GoTrue.
  user_banned: 'auth.google.error.userBanned',

  // Google is on in the app but the deployment refuses new accounts: the switch
  // was turned off between the button being shown and the redirect returning.
  signup_disabled: 'auth.google.error.signupDisabled',
  provider_disabled: 'auth.google.error.providerDisabled',
  email_provider_disabled: 'auth.google.error.providerDisabled',
  oauth_provider_not_supported: 'auth.google.error.providerDisabled',

  // The round trip took longer than GoTrue keeps its state, or the browser
  // returned to a state that had already been used. Starting again fixes both.
  bad_oauth_state: 'auth.google.error.flowExpired',
  bad_oauth_callback: 'auth.google.error.flowExpired',
  flow_state_not_found: 'auth.google.error.flowExpired',
  flow_state_expired: 'auth.google.error.flowExpired',
  bad_code_verifier: 'auth.google.error.flowExpired',

  // The address cannot be used here: not in GoTrue's allow-list, or malformed.
  email_address_not_authorized: 'auth.google.error.emailNotAllowed',
  email_address_invalid: 'auth.google.error.emailNotAllowed',
  validation_failed: 'auth.google.error.emailNotAllowed',

  // The Google identity cannot be attached to the account that holds this
  // address. Manual linking is off by design (deploy/docker-compose.yml), so
  // there is nothing the person can do here but sign in with their password.
  identity_already_exists: 'auth.google.error.accountConflict',
  user_already_exists: 'auth.google.error.accountConflict',
  email_conflict_identity_not_deletable: 'auth.google.error.accountConflict',
  single_identity_not_deletable: 'auth.google.error.accountConflict',
  manual_linking_disabled: 'auth.google.error.accountConflict',

  over_request_rate_limit: 'auth.error.tooManyAttempts',

  unexpected_failure: 'auth.google.error.serverError',
  request_timeout: 'auth.google.error.serverError',
  conflict: 'auth.google.error.serverError',
};

/** The OAuth2 `error` values, read only when `error_code` says nothing useful. */
const ERROR_FAMILY_KEYS: Readonly<Record<string, TranslationKey>> = {
  access_denied: 'auth.google.error.cancelled',
  server_error: 'auth.google.error.serverError',
  temporarily_unavailable: 'auth.google.error.serverError',
};

/**
 * The message for a failed Google sign-in, or null when neither parameter names
 * one this module knows. `error_code` wins over `error`: GoTrue sends
 * `access_denied` for a banned account and a disabled signup alike, and the
 * code is what tells those apart.
 */
export function googleErrorMessageKey(error: string, errorCode: string): TranslationKey | null {
  const code = errorCode.trim().toLowerCase();
  if (code && Object.prototype.hasOwnProperty.call(ERROR_CODE_KEYS, code)) return ERROR_CODE_KEYS[code];

  const family = error.trim().toLowerCase();
  if (family && Object.prototype.hasOwnProperty.call(ERROR_FAMILY_KEYS, family)) return ERROR_FAMILY_KEYS[family];

  return null;
}

export interface CallbackErrorInput {
  /** `error` from the redirect. */
  error: string;
  /** `error_code` from the redirect. */
  errorCode: string;
  /** `error_description`; read only for the word "expired", as before. */
  description: string;
  /** True when this browser pressed the Google button (the intent marker). */
  fromGoogle: boolean;
}

/**
 * The whole decision `/auth/callback` makes about a failed return, as one pure
 * function.
 *
 * A Google failure is answered from the code. Everything else keeps the
 * behaviour the mail links have always had: an expired link says so, anything
 * else is an invalid link.
 */
export function callbackErrorMessageKey(input: CallbackErrorInput): TranslationKey {
  const mapped = googleErrorMessageKey(input.error, input.errorCode);
  if (mapped) return mapped;
  if (input.fromGoogle) return 'auth.google.error.generic';
  if (input.description.toLowerCase().includes('expired')) return 'signup.callback.linkExpired';
  return 'signup.callback.linkInvalid';
}
