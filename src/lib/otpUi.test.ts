import { describe, expect, it } from 'vitest';
import {
  cooldownDeadline,
  deleteBackward,
  deleteForward,
  enterDigits,
  failureClearsCode,
  failureNeedsNewCode,
  focusableIndex,
  pasteDigits,
  resendCooldownSeconds,
  resendNotice,
  secondsRemaining,
} from './otpUi';
import type { OtpVerifyFailureReason } from './otpClient';

describe('focusableIndex', () => {
  it('never lets focus pass the first empty box or the last box', () => {
    expect(focusableIndex('', 4)).toBe(0);
    expect(focusableIndex('12', 5)).toBe(2);
    expect(focusableIndex('12', 1)).toBe(1);
    expect(focusableIndex('123456', 9)).toBe(5);
    expect(focusableIndex('123', -1)).toBe(0);
  });
});

describe('enterDigits', () => {
  it('appends a typed digit and moves on', () => {
    expect(enterDigits('12', 2, '3')).toEqual({ value: '123', focusIndex: 3 });
  });

  it('overwrites a digit in place', () => {
    expect(enterDigits('123456', 2, '9')).toEqual({ value: '129456', focusIndex: 3 });
  });

  it('stays on the last box when the sixth digit arrives', () => {
    expect(enterDigits('12345', 5, '6')).toEqual({ value: '123456', focusIndex: 5 });
    expect(enterDigits('123456', 5, '0')).toEqual({ value: '123450', focusIndex: 5 });
  });

  it('writes at the first empty box when a later box was targeted', () => {
    expect(enterDigits('1', 4, '2')).toEqual({ value: '12', focusIndex: 2 });
  });

  it('spreads several digits from the box they entered', () => {
    expect(enterDigits('1', 1, '234')).toEqual({ value: '1234', focusIndex: 4 });
    expect(enterDigits('123456', 1, '99')).toEqual({ value: '199456', focusIndex: 3 });
    expect(enterDigits('1234', 3, '5678')).toEqual({ value: '123567', focusIndex: 5 });
  });

  it('takes a whole autofilled code as the code, whichever box it landed in', () => {
    expect(enterDigits('12', 2, '987654')).toEqual({ value: '987654', focusIndex: 5 });
  });

  it('ignores input without digits', () => {
    expect(enterDigits('12', 2, 'x')).toEqual({ value: '12', focusIndex: 2 });
  });
});

describe('pasteDigits', () => {
  it('replaces the whole code with the digits of the clipboard', () => {
    expect(pasteDigits('Ihr Code: 123 456')).toEqual({ value: '123456', focusIndex: 5 });
    expect(pasteDigits('12-3')).toEqual({ value: '123', focusIndex: 3 });
    expect(pasteDigits('1234567')).toEqual({ value: '123456', focusIndex: 5 });
  });

  it('does nothing for a clipboard without digits', () => {
    expect(pasteDigits('hello')).toBeNull();
  });
});

describe('deleteBackward', () => {
  it('clears the focused digit and moves back', () => {
    expect(deleteBackward('123456', 5)).toEqual({ value: '12345', focusIndex: 4 });
    expect(deleteBackward('12345', 4)).toEqual({ value: '1234', focusIndex: 3 });
  });

  it('clears the previous digit from an empty box', () => {
    expect(deleteBackward('123', 3)).toEqual({ value: '12', focusIndex: 2 });
  });

  it('empties the code from right to left when held', () => {
    let edit = { value: '123', focusIndex: 3 };
    for (let i = 0; i < 4; i += 1) edit = deleteBackward(edit.value, edit.focusIndex);
    expect(edit).toEqual({ value: '', focusIndex: 0 });
  });

  it('stays put on an empty first box', () => {
    expect(deleteBackward('', 0)).toEqual({ value: '', focusIndex: 0 });
  });
});

describe('deleteForward', () => {
  it('removes the focused digit without moving', () => {
    expect(deleteForward('123456', 2)).toEqual({ value: '12456', focusIndex: 2 });
    expect(deleteForward('12', 2)).toEqual({ value: '12', focusIndex: 2 });
  });
});

describe('resend countdown', () => {
  it('counts whole seconds, rounded up, and stops at zero', () => {
    expect(secondsRemaining(null, 1_000)).toBe(0);
    expect(secondsRemaining(61_000, 1_000)).toBe(60);
    expect(secondsRemaining(61_000, 1_001)).toBe(60);
    expect(secondsRemaining(61_000, 60_001)).toBe(1);
    expect(secondsRemaining(61_000, 61_000)).toBe(0);
    expect(secondsRemaining(61_000, 90_000)).toBe(0);
  });

  it('sets a deadline only for a positive wait', () => {
    expect(cooldownDeadline(60, 1_000)).toBe(61_000);
    expect(cooldownDeadline(0, 1_000)).toBeNull();
  });

  it('restarts from what the server said', () => {
    expect(resendCooldownSeconds({ ok: true, cooldownSeconds: 60, expiresInSeconds: 600, uniform: true })).toBe(60);
    expect(resendCooldownSeconds({ ok: false, reason: 'rate_limited', scope: 'cooldown', retryAfterSeconds: 17 })).toBe(17);
    expect(resendCooldownSeconds({ ok: false, reason: 'rate_limited' })).toBe(60);
    expect(resendCooldownSeconds({ ok: false, reason: 'send_failed' })).toBe(0);
    expect(resendCooldownSeconds({ ok: false, reason: 'network' })).toBe(0);
  });
});

describe('what a failed verification does', () => {
  it.each<[OtpVerifyFailureReason, boolean, boolean]>([
    ['invalid_code', false, true],
    ['locked', true, true],
    ['expired', true, true],
    ['not_found', true, true],
    ['email_taken', true, true],
    ['session_failed', true, true],
    ['unauthorized', false, false],
    ['invalid_request', false, false],
    ['internal', false, false],
    ['network', false, false],
  ])('%s: needs a new code %s, clears the input %s', (reason, needsNewCode, clears) => {
    expect(failureNeedsNewCode(reason)).toBe(needsNewCode);
    expect(failureClearsCode(reason)).toBe(clears);
  });
});

describe('resendNotice', () => {
  const uniform = { ok: true, cooldownSeconds: 60, expiresInSeconds: 600, uniform: true } as const;

  it('does not claim a mail went out for a uniform password-reset answer', () => {
    expect(resendNotice('password_reset', uniform)).toEqual({ tone: 'success', message: { key: 'forgot.codeSentIfExists' } });
    expect(resendNotice('invite_activate', uniform)).toEqual({ tone: 'success', message: { key: 'otp.sent' } });
    expect(resendNotice('email_change', { ...uniform, uniform: false })).toEqual({ tone: 'success', message: { key: 'otp.sent' } });
  });

  it('reports a failure as an error', () => {
    expect(resendNotice('email_change', { ok: false, reason: 'reauth_required' }))
      .toEqual({ tone: 'error', message: { key: 'otp.error.reauthRequired' } });
  });
});
