import { describe, expect, it } from 'vitest';
import {
  inviteCreateFailure,
  resendInviteOutcome,
  signupFailure,
  signupVerificationStart,
} from './accountFunctionResponses';

describe('signupFailure', () => {
  it('maps each reason, never the German error text', () => {
    expect(signupFailure({ success: false, error: 'Diese E-Mail-Adresse ist bereits registriert', reason: 'email_taken' }, ''))
      .toEqual({ field: 'form', message: { key: 'signup.error.emailTaken' } });
    expect(signupFailure({ success: false, reason: 'referral_invalid' }, ' partner24 '))
      .toEqual({ field: 'referral', message: { key: 'signup.error.referralInvalid', vars: { code: 'PARTNER24' } } });
    expect(signupFailure({ success: false, reason: 'referral_inactive' }, 'X'))
      .toEqual({ field: 'referral', message: { key: 'signup.error.referralInactive' } });
  });

  it('falls back to the generic message, even when the text looks like a known one', () => {
    expect(signupFailure({ success: false, error: 'bereits registriert' }, ''))
      .toEqual({ field: 'form', message: { key: 'signup.error.failed' } });
    expect(signupFailure(null, '')).toEqual({ field: 'form', message: { key: 'signup.error.failed' } });
  });
});

describe('signupVerificationStart', () => {
  it('opens with the sent notice and the server cooldown', () => {
    expect(signupVerificationStart({ success: true, verification: { status: 'sent', cooldown_seconds: 60, retry_after_seconds: null } }))
      .toEqual({ cooldownSeconds: 60, notice: { tone: 'success', message: { key: 'otp.sent' } } });
  });

  it('lets a failed send be retried at once', () => {
    expect(signupVerificationStart({ success: true, verification: { status: 'send_failed', cooldown_seconds: 60 } }))
      .toEqual({ cooldownSeconds: 0, notice: { tone: 'error', message: { key: 'signup.verify.sendFailed' } } });
  });

  it('waits out a rate limit', () => {
    expect(signupVerificationStart({ success: true, verification: { status: 'rate_limited', retry_after_seconds: 45 } }))
      .toEqual({ cooldownSeconds: 45, notice: { tone: 'error', message: { key: 'otp.error.rateLimited', vars: { seconds: 45 } } } });
  });

  it('assumes a sent code when the field is missing', () => {
    expect(signupVerificationStart({ success: true }))
      .toEqual({ cooldownSeconds: 60, notice: { tone: 'success', message: { key: 'otp.sent' } } });
  });
});

describe('inviteCreateFailure', () => {
  it('singles out a failed invitation mail', () => {
    expect(inviteCreateFailure(502, { success: false, error: 'x', reason: 'send_failed' })).toEqual({ key: 'users.invite.sendFailed' });
    // The previous release reports the same failure without a reason.
    expect(inviteCreateFailure(502, { success: false, error: 'x' })).toEqual({ key: 'users.invite.sendFailed' });
  });

  it('does not read a gateway 502 as a created account', () => {
    expect(inviteCreateFailure(502, { message: 'An invalid response was received from the upstream server' })).toBeNull();
    expect(inviteCreateFailure(502, null)).toBeNull();
  });

  it('leaves every other failure to the generic creation error', () => {
    expect(inviteCreateFailure(409, { success: false, error: 'bereits registriert' })).toBeNull();
    expect(inviteCreateFailure(500, null)).toBeNull();
  });
});

describe('resendInviteOutcome', () => {
  it('confirms a resent invitation', () => {
    expect(resendInviteOutcome(200, { success: true })).toEqual({ ok: true, message: { key: 'users.invite.resent' } });
  });

  it('maps the cooldown with its seconds, and the hourly limit', () => {
    expect(resendInviteOutcome(429, { success: false, reason: 'cooldown', retry_after_seconds: 38 }))
      .toEqual({ ok: false, message: { key: 'otp.error.rateLimited', vars: { seconds: 38 } } });
    expect(resendInviteOutcome(429, { success: false, reason: 'email_hourly', retry_after_seconds: 2400 }))
      .toEqual({ ok: false, message: { key: 'otp.error.rateLimitedHourly' } });
  });

  it('maps a failed send and an invitation that was already accepted', () => {
    expect(resendInviteOutcome(502, { success: false, reason: 'send_failed' }))
      .toEqual({ ok: false, message: { key: 'users.invite.sendFailed' } });
    expect(resendInviteOutcome(409, { success: false, reason: 'not_pending' }))
      .toEqual({ ok: false, message: { key: 'users.invite.notPending' } });
  });

  it('treats a 502 from manage-users without a reason as a failed send, but not a gateway 502', () => {
    expect(resendInviteOutcome(502, { success: false, error: 'x' }))
      .toEqual({ ok: false, message: { key: 'users.invite.sendFailed' } });
    expect(resendInviteOutcome(502, { message: 'An invalid response was received from the upstream server' }))
      .toEqual({ ok: false, message: null });
  });

  it('leaves anything else to the caller', () => {
    expect(resendInviteOutcome(403, { success: false, error: 'Keine Berechtigung' })).toEqual({ ok: false, message: null });
    expect(resendInviteOutcome(409, { success: false, error: 'x' })).toEqual({ ok: false, message: null });
    expect(resendInviteOutcome(200, { success: false })).toEqual({ ok: false, message: null });
    expect(resendInviteOutcome(200, null)).toEqual({ ok: false, message: null });
  });
});
