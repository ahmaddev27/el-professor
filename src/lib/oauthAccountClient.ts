import type { TranslationKey } from '../i18n';
import type { Plan } from '../contexts/PlanContext';
import type { BillingCycle } from '../utils/pricing';

/**
 * The only caller of the `oauth-account` edge function (plan step 1.6).
 *
 * Its wire contract is written down once, in
 * `supabase/functions/_shared/oauth-account-core.ts`, and this module is its
 * other half: one place that knows the snake_case body, the HTTP statuses and
 * the closed reason lists, so every screen sees the same checked result.
 *
 *   {"action":"reconcile"}      after a Google sign-in: cancels a password
 *                               signup Google has just confirmed, or accepts a
 *                               pending invitation
 *   {"action":"register", ...}  registers the company of a new Google account
 *   {"action":"discard"}        deletes a Google account that registered none
 *
 * Every decision is the database's. The function takes the caller's user id
 * from the verified token, so nothing here identifies an account — the access
 * token is the whole request.
 *
 * As in `otpClient`, an unexpected answer never throws: a failed fetch or a
 * body that is not JSON becomes `network`, and a reason outside the closed list
 * becomes `internal`.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type WireAnswer = { status: number; body: Record<string, unknown> | null };

/** null means the request never produced a JSON answer. */
async function callOauthAccount(payload: Record<string, unknown>, accessToken: string): Promise<WireAnswer | null> {
  const baseUrl = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/functions/v1/oauth-account`, {
      method: 'POST',
      headers: {
        apikey: String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''),
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return null;
  }
  return { status: response.status, body: isRecord(parsed) ? parsed : null };
}

/** The transport failures every action shares. */
export type OauthTransportFailure = 'unauthorized' | 'network' | 'internal';

const transportFailure = (answer: WireAnswer): OauthTransportFailure =>
  answer.status === 401 ? 'unauthorized' : 'internal';

// ─── reconcile ──────────────────────────────────────────────────────────────

export const RECONCILE_NONE_REASONS = [
  'account_not_found',
  'account_blocked',
  'not_google_account',
  'platform_staff',
  'pending_signup_kept',
  'nothing_pending',
] as const;
export type ReconcileNoneReason = (typeof RECONCILE_NONE_REASONS)[number];

export type ReconcileResult =
  | { ok: true; action: 'pending_signup_cancelled' | 'invite_accepted' }
  | { ok: true; action: 'none'; reason: ReconcileNoneReason }
  | { ok: false; reason: OauthTransportFailure };

function parseReconcile(answer: WireAnswer): ReconcileResult {
  const body = answer.body;
  if (body?.ok === true) {
    const action = body.action;
    if (action === 'pending_signup_cancelled' || action === 'invite_accepted') return { ok: true, action };
    if (action === 'none') {
      const reason = typeof body.reason === 'string' && (RECONCILE_NONE_REASONS as readonly string[]).includes(body.reason)
        ? (body.reason as ReconcileNoneReason)
        : 'nothing_pending';
      return { ok: true, action: 'none', reason };
    }
    return { ok: false, reason: 'internal' };
  }
  return { ok: false, reason: transportFailure(answer) };
}

export async function reconcileOauthAccount(accessToken: string): Promise<ReconcileResult> {
  const answer = await callOauthAccount({ action: 'reconcile' }, accessToken);
  return answer ? parseReconcile(answer) : { ok: false, reason: 'network' };
}

/** Where the session goes once reconcile has answered. */
export interface ReconcileRouting {
  /**
   * `app` lets the existing gates decide as they do for a password session;
   * `complete_registration` sends the account to the registration screen;
   * `sign_out` ends the session and shows `message` on the sign-in screen.
   */
  route: 'app' | 'complete_registration' | 'sign_out';
  /** The database changed the profile: load it again before any gate reads it. */
  reloadProfile: boolean;
  message: TranslationKey | null;
}

/**
 * What the app does with reconcile's answer.
 *
 * Only three answers end the session, and each is an account that must not be
 * signed in through Google at all:
 *
 * - `platform_staff` — the owner's decision of 16.09.2026: a platform account
 *   signs in with email and password. The database refuses it in all three
 *   actions; the screens say why.
 * - `account_not_found` and `account_blocked` — the token was valid a moment
 *   ago and the account is gone or banned.
 *
 * Everything else continues into the app. `pending_signup_kept` in particular
 * is a company that is simply waiting for approval, and App's approval gate
 * already has the right screen for it.
 *
 * A reconcile that never answered (`network`, `internal`) is not a reason to
 * throw a valid session away: nothing has been changed, the sign-in stands, and
 * the next sign-in tries again. The invitation an employee was accepting stays
 * pending until then, which is the same state they were in a minute earlier.
 */
export function nextAfterReconcile(result: ReconcileResult): ReconcileRouting {
  if (!result.ok) {
    return result.reason === 'unauthorized'
      ? { route: 'sign_out', reloadProfile: false, message: 'auth.google.error.generic' }
      : { route: 'app', reloadProfile: false, message: null };
  }

  // Tested against 'none' rather than against each action in turn: that is the
  // test TypeScript narrows the union on, and it leaves `reason` readable below.
  if (result.action !== 'none') {
    return result.action === 'invite_accepted'
      ? { route: 'app', reloadProfile: true, message: null }
      : { route: 'complete_registration', reloadProfile: true, message: null };
  }

  switch (result.reason) {
    case 'platform_staff':
      return { route: 'sign_out', reloadProfile: false, message: 'auth.google.error.platformStaff' };
    case 'account_blocked':
      return { route: 'sign_out', reloadProfile: false, message: 'auth.google.error.accountBlocked' };
    case 'account_not_found':
      return { route: 'sign_out', reloadProfile: false, message: 'auth.google.error.generic' };
    default:
      return { route: 'app', reloadProfile: false, message: null };
  }
}

// ─── register ───────────────────────────────────────────────────────────────

export interface OauthRegisterInput {
  fullName: string;
  companyName: string;
  plan: Plan;
  billingCycle: BillingCycle;
  carLimit: number;
  referralCode: string | null;
  discountCode: string | null;
}

/** The refusals `oauth_signup_create_company` reports, as the function names them. */
export const REGISTER_REFUSAL_REASONS = [
  'invalid_request',
  'account_not_found',
  'account_blocked',
  'email_not_confirmed',
  'not_google_account',
  'platform_staff',
  'company_exists',
  'no_pending_signup',
  'referral_invalid',
  'referral_inactive',
] as const;
export type RegisterRefusalReason = (typeof REGISTER_REFUSAL_REASONS)[number];

/** Why a discount code did not apply, as `redeem_discount_code` reports it. */
export interface DiscountSummary {
  success: boolean;
  reason_code: string | null;
  original_price: number | null;
  discount_amount: number | null;
  final_price: number | null;
}

export interface RegisteredCompany {
  id: string;
  name: string | null;
  slug: string | null;
  trial_end: string | null;
  approval_status: string | null;
}

export type RegisterResult =
  | { ok: true; company: RegisteredCompany; discount: DiscountSummary | null }
  | { ok: false; reason: RegisterRefusalReason | OauthTransportFailure };

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function parseDiscount(raw: unknown): DiscountSummary | null {
  if (!isRecord(raw)) return null;
  return {
    success: raw.success === true,
    reason_code: textOrNull(raw.reason_code),
    original_price: numberOrNull(raw.original_price),
    discount_amount: numberOrNull(raw.discount_amount),
    final_price: numberOrNull(raw.final_price),
  };
}

function parseRegister(answer: WireAnswer): RegisterResult {
  const body = answer.body;
  if (body?.ok === true && isRecord(body.company) && typeof body.company.id === 'string') {
    const company = body.company;
    return {
      ok: true,
      company: {
        id: company.id as string,
        name: textOrNull(company.name),
        slug: textOrNull(company.slug),
        trial_end: textOrNull(company.trial_end),
        approval_status: textOrNull(company.approval_status),
      },
      discount: parseDiscount(body.discount),
    };
  }
  if (body?.ok === false) {
    const reason = typeof body.reason === 'string' && (REGISTER_REFUSAL_REASONS as readonly string[]).includes(body.reason)
      ? (body.reason as RegisterRefusalReason)
      : 'internal';
    return { ok: false, reason };
  }
  return { ok: false, reason: transportFailure(answer) };
}

export async function registerOauthCompany(input: OauthRegisterInput, accessToken: string): Promise<RegisterResult> {
  const answer = await callOauthAccount(
    {
      action: 'register',
      full_name: input.fullName,
      company_name: input.companyName,
      plan: input.plan,
      billing_cycle: input.billingCycle,
      subscription_car_limit: input.carLimit,
      referral_code: input.referralCode,
      // The code the user typed, not a validation result: the database redeems
      // it inside the same transaction that creates the company, exactly as the
      // password signup does.
      discount_code: input.discountCode,
    },
    accessToken,
  );
  return answer ? parseRegister(answer) : { ok: false, reason: 'network' };
}

/**
 * Where a refusal belongs on the registration form, and what it says. A
 * referral code the server rejected is the field's own error, as in the
 * password signup (`accountFunctionResponses.signupFailure`); everything else
 * is shown above the form.
 */
export interface RegisterFailureMessage {
  field: 'form' | 'referral';
  message: TranslationKey;
  /** True when the session cannot be used any more and the screen should sign out. */
  fatal: boolean;
}

export function registerFailure(reason: RegisterRefusalReason | OauthTransportFailure): RegisterFailureMessage {
  switch (reason) {
    case 'referral_invalid':
      return { field: 'referral', message: 'signup.error.referralInvalid', fatal: false };
    case 'referral_inactive':
      return { field: 'referral', message: 'signup.error.referralInactive', fatal: false };
    case 'platform_staff':
      return { field: 'form', message: 'auth.google.error.platformStaff', fatal: true };
    case 'account_blocked':
      return { field: 'form', message: 'auth.google.error.accountBlocked', fatal: true };
    case 'account_not_found':
    case 'unauthorized':
      return { field: 'form', message: 'gsignup.error.sessionGone', fatal: true };
    case 'email_not_confirmed':
      return { field: 'form', message: 'gsignup.error.emailNotConfirmed', fatal: false };
    case 'not_google_account':
      return { field: 'form', message: 'gsignup.error.notGoogle', fatal: false };
    case 'company_exists':
      return { field: 'form', message: 'gsignup.error.companyExists', fatal: false };
    case 'no_pending_signup':
      return { field: 'form', message: 'gsignup.error.noPendingSignup', fatal: false };
    case 'invalid_request':
      return { field: 'form', message: 'gsignup.error.invalid', fatal: false };
    case 'network':
      return { field: 'form', message: 'otp.error.network', fatal: false };
    default:
      return { field: 'form', message: 'gsignup.error.failed', fatal: false };
  }
}

// ─── discard ────────────────────────────────────────────────────────────────

export type DiscardResult = { ok: true } | { ok: false; reason: 'not_discardable' | OauthTransportFailure };

export async function discardOauthAccount(accessToken: string): Promise<DiscardResult> {
  const answer = await callOauthAccount({ action: 'discard' }, accessToken);
  if (!answer) return { ok: false, reason: 'network' };
  if (answer.body?.ok === true) return { ok: true };
  if (answer.body?.reason === 'not_discardable') return { ok: false, reason: 'not_discardable' };
  return { ok: false, reason: transportFailure(answer) };
}
