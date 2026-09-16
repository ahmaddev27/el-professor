import { describe, expect, it } from 'vitest';
import { callbackErrorMessageKey, callbackFailureView, googleErrorMessageKey } from './oauthErrors';

describe('googleErrorMessageKey', () => {
  it.each([
    // GoTrue sends access_denied for three very different situations; the code
    // is what tells them apart, so it has to win over the family.
    ['access_denied', '', 'auth.google.error.cancelled'],
    ['access_denied', 'user_banned', 'auth.google.error.userBanned'],
    ['access_denied', 'signup_disabled', 'auth.google.error.signupDisabled'],
    ['access_denied', 'provider_email_needs_verification', 'auth.google.error.emailNotVerified'],

    ['server_error', 'bad_oauth_state', 'auth.google.error.flowExpired'],
    ['server_error', 'flow_state_expired', 'auth.google.error.flowExpired'],
    ['server_error', 'unexpected_failure', 'auth.google.error.serverError'],
    ['server_error', '', 'auth.google.error.serverError'],
    ['temporarily_unavailable', '', 'auth.google.error.serverError'],

    ['', 'provider_disabled', 'auth.google.error.providerDisabled'],
    ['', 'identity_already_exists', 'auth.google.error.accountConflict'],
    ['', 'manual_linking_disabled', 'auth.google.error.accountConflict'],
    ['', 'email_address_not_authorized', 'auth.google.error.emailNotAllowed'],
    ['', 'over_request_rate_limit', 'auth.error.tooManyAttempts'],
  ])('error=%j code=%j reads as %s', (error, code, key) => {
    expect(googleErrorMessageKey(error, code)).toBe(key);
  });

  it('ignores case and surrounding space, as a pasted URL can carry either', () => {
    expect(googleErrorMessageKey('', ' USER_BANNED ')).toBe('auth.google.error.userBanned');
  });

  it.each([
    ['nothing at all', '', ''],
    ['a code from another route', '', 'mfa_challenge_expired'],
    ['a family nobody defines', 'kaputt', ''],
  ])('answers null for %s', (_label, error, code) => {
    expect(googleErrorMessageKey(error, code)).toBeNull();
  });
});

describe('callbackErrorMessageKey', () => {
  it('answers a Google failure from its code', () => {
    expect(callbackErrorMessageKey({
      error: 'access_denied',
      errorCode: 'user_banned',
      description: 'User is banned',
      fromGoogle: true,
    })).toBe('auth.google.error.userBanned');
  });

  it('falls back to one Google sentence when the code says nothing we know', () => {
    expect(callbackErrorMessageKey({
      error: '',
      errorCode: 'something_new_in_gotrue',
      description: 'Some English prose',
      fromGoogle: true,
    })).toBe('auth.google.error.generic');
  });

  it.each([
    ['Email link is invalid or has expired', 'signup.callback.linkExpired'],
    ['Token has expired or is invalid', 'signup.callback.linkExpired'],
    ['Invalid request', 'signup.callback.linkInvalid'],
  ])('keeps the mail-link wording for %j', (description, key) => {
    expect(callbackErrorMessageKey({ error: '', errorCode: '', description, fromGoogle: false })).toBe(key);
  });

  // The pair above — both parameters empty — is not a shape GoTrue ever sends,
  // which is why this went unnoticed: a real mail-link failure carries
  // `access_denied` and `otp_expired`, and reading the Google mapping first
  // answered it with "cancelled at Google" and made the expired branch
  // unreachable for every GoTrue failure in that family.
  it('reads the pair a dead mail link really carries as an expired link', () => {
    expect(callbackErrorMessageKey({
      error: 'access_denied',
      errorCode: 'otp_expired',
      description: 'Email link is invalid or has expired',
      fromGoogle: false,
    })).toBe('signup.callback.linkExpired');
  });

  it('reads that same pair as a cancelled sign-in only when this browser went to Google', () => {
    expect(callbackErrorMessageKey({
      error: 'access_denied',
      errorCode: 'otp_expired',
      description: 'Email link is invalid or has expired',
      fromGoogle: true,
    })).toBe('auth.google.error.cancelled');
  });
});

describe('the fragment GoTrue really sends for a dead mail link', () => {
  // Measured on staging against /auth/v1/verify with an invalid token, byte for
  // byte — and identical for type=recovery and type=invite, so this one shape
  // pins both branches. Both are legacy paths (the app sends one-time codes,
  // not link mails); what is pinned here is the answer, not a live flow.
  const FRAGMENT =
    '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';

  /** Read the way lib/supabase reads it, so the test sees what the page sees. */
  const hash = new URLSearchParams(FRAGMENT.replace(/^#/, ''));
  const read = (key: string) => hash.get(key) ?? '';
  const redirect = {
    error: read('error_description') || read('error'),
    errorFamily: read('error'),
    errorCode: read('error_code'),
  };

  const input = (fromGoogle: boolean) => ({
    error: redirect.errorFamily,
    errorCode: redirect.errorCode,
    description: redirect.error,
    fromGoogle,
  });

  it('arrives plus-encoded, and is decoded before the word expired is looked for', () => {
    expect(FRAGMENT).toContain('has+expired');
    expect(redirect.error).toBe('Email link is invalid or has expired');
    expect(redirect.errorFamily).toBe('access_denied');
    expect(redirect.errorCode).toBe('otp_expired');
  });

  it.each(['recovery', 'invite'] as const)('leaves the %s flow a way out', () => {
    const view = callbackFailureView(input(false));
    expect(view.messageKey).toBe('signup.callback.linkExpired');
    // The assertion that would have caught this: a wrong sentence is
    // recoverable, losing "Neuen Link anfordern" is not.
    expect(view.offerNewLink).toBe(true);
    expect(view.googleTitle).toBe(false);
  });

  it('is a cancelled Google sign-in only when the intent marker says so', () => {
    const view = callbackFailureView(input(true));
    expect(view.messageKey).toBe('auth.google.error.cancelled');
    expect(view.offerNewLink).toBe(false);
    expect(view.googleTitle).toBe(true);
  });
});
