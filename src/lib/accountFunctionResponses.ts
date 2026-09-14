import { DEFAULT_RESEND_COOLDOWN_SECONDS, otpMessage, type OtpMessage } from './otpClient';
import type { OtpNotice } from './otpUi';

/**
 * Messages for the answers of `company-signup` and the invite routes of
 * `manage-users`.
 *
 * Both functions report a machine-readable `reason` next to their German
 * `error` text (contract 3.4 and 3.5). Screens branch on the reason: matching
 * words inside the German text worked only while the UI was German, and broke
 * silently whenever the server rephrased a sentence.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const positiveSeconds = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;

// ─── company-signup ─────────────────────────────────────────────────────────

/** `referral` failures belong under the referral field, everything else above the form. */
export type SignupFailure = { field: 'form' | 'referral'; message: OtpMessage };

export function signupFailure(body: unknown, referralCode: string): SignupFailure {
  switch (isRecord(body) ? body.reason : undefined) {
    case 'email_taken':
      return { field: 'form', message: { key: 'signup.error.emailTaken' } };
    case 'referral_invalid':
      return {
        field: 'referral',
        message: { key: 'signup.error.referralInvalid', vars: { code: referralCode.trim().toUpperCase() } },
      };
    case 'referral_inactive':
      return { field: 'referral', message: { key: 'signup.error.referralInactive' } };
    default:
      return { field: 'form', message: { key: 'signup.error.failed' } };
  }
}

export type VerificationStart = { cooldownSeconds: number; notice: OtpNotice };

/**
 * How the verification step opens after a successful signup. The account
 * stands even when the code could not be sent, so the step always opens; only
 * its first message and the resend countdown differ.
 */
export function signupVerificationStart(body: unknown): VerificationStart {
  const verification = isRecord(body) && isRecord(body.verification) ? body.verification : {};

  if (verification.status === 'send_failed') {
    return { cooldownSeconds: 0, notice: { tone: 'error', message: { key: 'signup.verify.sendFailed' } } };
  }
  if (verification.status === 'rate_limited') {
    const seconds = positiveSeconds(verification.retry_after_seconds) ?? DEFAULT_RESEND_COOLDOWN_SECONDS;
    return {
      cooldownSeconds: seconds,
      notice: { tone: 'error', message: { key: 'otp.error.rateLimited', vars: { seconds } } },
    };
  }
  return {
    cooldownSeconds: positiveSeconds(verification.cooldown_seconds) ?? DEFAULT_RESEND_COOLDOWN_SECONDS,
    notice: { tone: 'success', message: { key: 'otp.sent' } },
  };
}

// ─── manage-users invites ───────────────────────────────────────────────────

/**
 * An error manage-users wrote itself: `{success: false, error, reason?}`.
 *
 * Only such a body is read as one of its outcomes. Kong answers 502 on its own
 * while the functions container restarts, and reading that as "the invitation
 * mail failed" would tell the admin an account exists that was never created.
 */
const isManageUsersFailure = (body: unknown): body is Record<string, unknown> =>
  isRecord(body) && body.success === false;

/**
 * A failed `/create` whose only problem was the invitation mail. The account
 * exists; any other failure returns null and is shown as a creation error.
 */
export function inviteCreateFailure(status: number, body: unknown): OtpMessage | null {
  if (!isManageUsersFailure(body)) return null;
  // A 502 without a reason is the same failure from the release before the
  // one-time-code invite, whose error body did not carry `reason` yet.
  return body.reason === 'send_failed' || status === 502 ? { key: 'users.invite.sendFailed' } : null;
}

export type ResendInviteOutcome =
  | { ok: true; message: OtpMessage }
  | { ok: false; message: OtpMessage | null };

/** `/resend-invite`. A null message means an unexpected failure the caller reports generically. */
export function resendInviteOutcome(status: number, body: unknown): ResendInviteOutcome {
  if (status >= 200 && status < 300 && isRecord(body) && body.success === true) {
    return { ok: true, message: { key: 'users.invite.resent' } };
  }
  if (!isManageUsersFailure(body)) return { ok: false, message: null };

  const reason = body.reason;
  switch (reason) {
    case 'cooldown':
    case 'email_hourly': {
      const retryAfterSeconds = positiveSeconds(body.retry_after_seconds);
      return {
        ok: false,
        message: otpMessage({
          ok: false,
          reason: 'rate_limited',
          scope: reason,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        }),
      };
    }
    case 'send_failed':
      return { ok: false, message: { key: 'users.invite.sendFailed' } };
    case 'not_pending':
      return { ok: false, message: { key: 'users.invite.notPending' } };
    default:
      return { ok: false, message: status === 502 ? { key: 'users.invite.sendFailed' } : null };
  }
}
