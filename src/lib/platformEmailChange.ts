import type { TranslationKey } from '../i18n';
import { isPlausibleEmail, normalizeEmail } from './otpClient';

/**
 * The only caller of `POST /functions/v1/platform-staff/email-change`.
 *
 * A platform account changes its own address with its current password and no
 * emailed code (the owner's decision of 17.09.2026). Company users keep the
 * code and never reach this module — `AccountPage` branches on the account, and
 * the server refuses a company user with `not_platform_account` whatever the
 * browser believes.
 *
 * The password is **not** sent here. `AccountPage` spends it on
 * `supabase.auth.signInWithPassword`, which is what mints the fresh
 * password-session the route demands: the route reads the `amr` claim of the
 * token passed in `accessToken` and refuses a proof older than ten minutes
 * (`reauth_required`). That is the server-side check — the browser's own
 * sign-in call is how the password reaches GoTrue, not a check the browser
 * performs and reports.
 *
 * Shaped like `src/lib/otpClient.ts`: snake_case on the wire, a closed reason
 * list, and never a throw — a failed fetch or a body that is not JSON is
 * `network`, and a reason outside the list is `internal`.
 */

export type PlatformEmailChangeReason =
  | 'invalid_request'
  | 'unauthorized'
  | 'reauth_required'
  | 'not_platform_account'
  | 'no_account'
  | 'same_email'
  | 'email_taken'
  | 'internal'
  | 'network';

export type PlatformEmailChangeResult =
  | { ok: true; email: string }
  | { ok: false; reason: PlatformEmailChangeReason };

export interface PlatformEmailChangeInput {
  newEmail: string;
  /** The access token of the sign-in that just proved the password. */
  accessToken: string;
}

const FAILURE_REASONS: ReadonlySet<string> = new Set<PlatformEmailChangeReason>([
  'invalid_request', 'unauthorized', 'reauth_required', 'not_platform_account',
  'no_account', 'same_email', 'email_taken', 'internal', 'network',
]);

/** The message each refusal shows. A Record over the union: a new reason must get one. */
const FAILURE_KEYS: Record<PlatformEmailChangeReason, TranslationKey> = {
  invalid_request:      'account.error.emailInvalid',
  unauthorized:         'otp.error.unauthorized',
  reauth_required:      'otp.error.reauthRequired',
  // The profile's routing hint said platform, the database says otherwise.
  not_platform_account: 'otp.error.forbidden',
  no_account:           'otp.error.forbidden',
  same_email:           'account.error.emailUnchanged',
  email_taken:          'otp.error.emailTaken',
  internal:             'otp.error.internal',
  network:              'otp.error.network',
};

export const platformEmailChangeMessageKey = (reason: PlatformEmailChangeReason): TranslationKey =>
  FAILURE_KEYS[reason];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseAnswer(status: number, body: Record<string, unknown> | null): PlatformEmailChangeResult {
  if (body?.ok === true) {
    return { ok: true, email: typeof body.email === 'string' ? body.email : '' };
  }
  if (body?.ok === false) {
    return {
      ok: false,
      reason: typeof body.reason === 'string' && FAILURE_REASONS.has(body.reason)
        ? (body.reason as PlatformEmailChangeReason)
        : 'internal',
    };
  }
  // Not our body: the edge router's own 401, or a proxy in front of it.
  return { ok: false, reason: status === 401 ? 'unauthorized' : 'internal' };
}

export async function changePlatformEmail(input: PlatformEmailChangeInput): Promise<PlatformEmailChangeResult> {
  const newEmail = normalizeEmail(input.newEmail);
  if (!isPlausibleEmail(newEmail) || !input.accessToken) return { ok: false, reason: 'invalid_request' };

  const baseUrl = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/functions/v1/platform-staff/email-change`, {
      method: 'POST',
      headers: {
        apikey: String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''),
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ new_email: newEmail }),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, reason: 'network' };
  }
  return parseAnswer(response.status, isRecord(parsed) ? parsed : null);
}
