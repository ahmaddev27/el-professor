import {
  DEFAULT_RESEND_COOLDOWN_SECONDS,
  OTP_CODE_LENGTH,
  normalizeOtpInput,
  otpMessage,
  type OtpMessage,
  type OtpPurpose,
  type OtpRequestResult,
  type OtpVerifyFailureReason,
} from './otpClient';

/**
 * The pure half of the code-entry screens: how an edit changes the six boxes,
 * how long the resend button waits, and what a result does to the challenge.
 * Kept out of the components so it can be tested without a DOM.
 */

export type OtpNotice = { tone: 'success' | 'error'; message: OtpMessage };

/** The code after an edit, and the box that should hold focus next. */
export type CodeEdit = { value: string; focusIndex: number };

const LAST_BOX = OTP_CODE_LENGTH - 1;

// The code is kept contiguous: box i can only hold a digit if every box before
// it does. So the furthest box a user may focus is the first empty one.
export function focusableIndex(value: string, index: number): number {
  return Math.max(0, Math.min(index, value.length, LAST_BOX));
}

/** Digits typed or auto-filled into box `index`; they overwrite from there on. */
export function enterDigits(value: string, index: number, raw: string): CodeEdit {
  const digits = normalizeOtpInput(raw);
  if (digits.length === 0) return { value, focusIndex: focusableIndex(value, index) };
  // A whole code in one box is an OS or password-manager autofill: take it as the code.
  if (digits.length === OTP_CODE_LENGTH) return { value: digits, focusIndex: LAST_BOX };

  const start = Math.min(Math.max(index, 0), value.length);
  const next = (value.slice(0, start) + digits + value.slice(start + digits.length)).slice(0, OTP_CODE_LENGTH);
  return { value: next, focusIndex: Math.min(start + digits.length, LAST_BOX) };
}

/** A paste anywhere replaces the whole code. null when the clipboard held no digit. */
export function pasteDigits(raw: string): CodeEdit | null {
  const digits = normalizeOtpInput(raw);
  return digits ? { value: digits, focusIndex: Math.min(digits.length, LAST_BOX) } : null;
}

/** Backspace: clear this box if it holds a digit, otherwise the previous one; focus moves back. */
export function deleteBackward(value: string, index: number): CodeEdit {
  const position = Math.min(Math.max(index, 0), value.length);
  if (position < value.length) {
    return { value: value.slice(0, position) + value.slice(position + 1), focusIndex: Math.max(position - 1, 0) };
  }
  if (position === 0) return { value, focusIndex: 0 };
  return { value: value.slice(0, position - 1), focusIndex: position - 1 };
}

/** Delete: clear this box; focus stays. */
export function deleteForward(value: string, index: number): CodeEdit {
  const position = Math.min(Math.max(index, 0), value.length);
  const next = value.slice(0, position) + value.slice(position + 1);
  return { value: next, focusIndex: focusableIndex(next, position) };
}

// ─── Resend countdown ───────────────────────────────────────────────────────

/** Whole seconds left, rounded up so the button never reads "0 s" while still disabled. */
export function secondsRemaining(untilMs: number | null, nowMs: number): number {
  if (untilMs === null) return 0;
  return Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
}

export function cooldownDeadline(seconds: number, nowMs: number): number | null {
  return seconds > 0 ? nowMs + seconds * 1000 : null;
}

/**
 * How long the resend button waits after a request, restarted from what the
 * server said. A failed send starts no cooldown on the server either, so the
 * button is available again at once.
 */
export function resendCooldownSeconds(result: OtpRequestResult): number {
  if (result.ok) return result.cooldownSeconds;
  if (result.reason === 'rate_limited') return result.retryAfterSeconds ?? DEFAULT_RESEND_COOLDOWN_SECONDS;
  return 0;
}

// ─── What a result does to the challenge ────────────────────────────────────

const REASONS_THAT_CLOSE_THE_CHALLENGE: ReadonlySet<OtpVerifyFailureReason> = new Set<OtpVerifyFailureReason>([
  'locked', 'expired', 'not_found', 'email_taken', 'session_failed',
]);

/** The code on screen can never succeed any more; only a new one can. */
export function failureNeedsNewCode(reason: OtpVerifyFailureReason): boolean {
  return REASONS_THAT_CLOSE_THE_CHALLENGE.has(reason);
}

/** Wrong or dead codes are cleared so the next attempt starts from the first box. */
export function failureClearsCode(reason: OtpVerifyFailureReason): boolean {
  return reason === 'invalid_code' || failureNeedsNewCode(reason);
}

export function resendNotice(purpose: OtpPurpose, result: OtpRequestResult): OtpNotice {
  if (result.ok) {
    // Password reset answers the same for unknown addresses, so it must not claim a mail went out.
    const key = result.uniform && purpose === 'password_reset' ? 'forgot.codeSentIfExists' : 'otp.sent';
    return { tone: 'success', message: { key } };
  }
  return { tone: 'error', message: otpMessage(result) ?? { key: 'otp.error.internal' } };
}
