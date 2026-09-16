import { describe, expect, it } from 'vitest';
import { callbackErrorMessageKey, googleErrorMessageKey } from './oauthErrors';

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
});
