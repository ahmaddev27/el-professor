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
 *
 * **The Google mapping is consulted only for an actual Google attempt**, and the
 * order matters more than it looks. GoTrue answers a dead mail link — measured
 * on staging against `/auth/v1/verify`, identical for `type=recovery` and
 * `type=invite` — with
 *
 *   #error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired
 *
 * and `access_denied` is also the family of a cancelled Google sign-in. Asking
 * the Google mapping first answered that shape with "cancelled at Google" and
 * left `signup.callback.linkExpired` unreachable for every GoTrue failure in
 * that family — together with the "Neuen Link anfordern" action, which the
 * screen hides for a Google attempt.
 *
 * These mail-link paths are legacy: forgot-password, signup verification and
 * invitations are all one-time codes now, nothing in the app calls
 * `/auth/v1/recover` or `/auth/v1/invite`, and the branch is reachable only by
 * a pre-code mail still in an inbox or a link an operator generates by hand. So
 * this is a wrong answer to a shape that does arrive, not a broken customer
 * flow — and the reason the test suite never saw it is that the case it pinned
 * used an `error`/`error_code` pair GoTrue never sends.
 */
export function callbackErrorMessageKey(input: CallbackErrorInput): TranslationKey {
  if (input.fromGoogle) return googleErrorMessageKey(input.error, input.errorCode) ?? 'auth.google.error.generic';
  // `error_description` arrives plus-encoded in the fragment; the caller reads it
  // through URLSearchParams, which turns "has+expired" back into "has expired".
  if (input.description.toLowerCase().includes('expired')) return 'signup.callback.linkExpired';
  return 'signup.callback.linkInvalid';
}

/** What the callback screen shows for a failure: the sentence, and the way out. */
export interface CallbackFailureView {
  messageKey: TranslationKey;
  /**
   * Whether to offer "Neuen Link anfordern". A mail link can be requested
   * again, and losing that button is the one failure a person cannot recover
   * from; a Google sign-in is simply started again from the sign-in screen.
   */
  offerNewLink: boolean;
  /** Title the card as a sign-in rather than as a mail link. */
  googleTitle: boolean;
}

/**
 * Message and buttons from one input, so the two can never again disagree about
 * where a failure came from.
 */
export function callbackFailureView(input: CallbackErrorInput): CallbackFailureView {
  return {
    messageKey: callbackErrorMessageKey(input),
    offerNewLink: !input.fromGoogle,
    googleTitle: input.fromGoogle,
  };
}
