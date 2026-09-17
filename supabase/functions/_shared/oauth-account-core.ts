/**
 * Pure logic of the oauth-account function (plan step 1.6).
 *
 * No Deno, npm: or jsr: import, like otp-core.ts: vitest runs this file in
 * Node, and supabase/functions/oauth-account runs the same code.
 *
 * The function settles the caller's own account after a Google sign-in. Every
 * decision is the database's (supabase/migrations/20260916100020_oauth_signup_rpcs.sql).
 * This file validates the body, calls the one RPC an action names with the
 * caller's user id, and turns the answer into HTTP. The user id comes from the
 * verified token and never from the body: a user_id there is ignored like any
 * other unknown field.
 *
 * The wire contract the screens are written against:
 *
 *   {"action":"reconcile"}
 *     200 {ok:true, action:"pending_signup_cancelled" | "invite_accepted"}
 *     200 {ok:true, action:"none", reason: one of RECONCILE_NONE_REASONS}
 *   {"action":"register", "full_name", "company_name", "plan"?, "billing_cycle"?,
 *    "subscription_car_limit"?, "referral_code"?, "discount_code"?}
 *     200 {ok:true, company:{id, name, slug, trial_end, approval_status},
 *          discount: null | {success, reason_code, original_price, discount_amount, final_price}}
 *     4xx {ok:false, reason: one of RegisterRefusalReason}
 *   {"action":"discard"}
 *     200 {ok:true, discarded:true}
 *     409 {ok:false, reason:"not_discardable"}
 *
 * Every refusal carries a reason and no sentence, and so does a discount code
 * that did not apply: redeem_discount_code's german_message is dropped. The
 * screens translate the reason into German and English, and no text from the
 * database reaches the browser.
 *
 * Platform staff never sign in with Google (owner decision, 16.09.2026). The
 * database refuses or ignores them in all three actions, asking one function
 * (app_private.oauth_account_is_platform_staff): register is refused with
 * platform_staff, reconcile answers none/platform_staff before it changes
 * anything, and discard answers not_discardable. This file adds no second
 * check, so plan 3.1 still changes one function body.
 */
import { describeError, invalidRequest, parseJsonObject, type HttpReply } from './otp-core.ts';

// ── Actions and input ────────────────────────────────────────────────────────

export const OAUTH_ACCOUNT_ACTIONS = ['reconcile', 'register', 'discard'] as const;
export type OauthAccountAction = (typeof OAUTH_ACCOUNT_ACTIONS)[number];

export const PLANS = ['basic', 'advanced', 'premium'] as const;
export type Plan = (typeof PLANS)[number];
export type BillingCycle = 'monthly' | 'yearly';

// The defaults and bounds company-signup applies to the password signup;
// app_private.signup_insert_company applies them once more to both.
export const DEFAULT_CAR_LIMIT = 3;
export const MIN_CAR_LIMIT = 1;
export const MAX_CAR_LIMIT = 100;
/** company-signup refuses a longer referral code as referral_invalid without asking the database. */
export const MAX_REFERRAL_CODE_LENGTH = 64;
/** The same bound for a discount code. A longer one is no code anybody typed: invalid_request. */
export const MAX_DISCOUNT_CODE_LENGTH = 64;
/**
 * The database stores both names as unbounded text. This bound only keeps a
 * pathological value out of the company list; the 4 KB body limit applies first.
 */
export const MAX_NAME_LENGTH = 200;

/**
 * Control and format characters inside a name: line breaks, NUL, zero-width
 * characters and bidirectional overrides. None belongs in a name a person
 * typed, and an override would reorder the text wherever the name is shown,
 * the platform's company list and generated documents included.
 */
const CONTROL_OR_FORMAT_CHARACTER = /[\p{Cc}\p{Cf}]/u;

export interface RegisterInput {
  action: 'register';
  fullName: string;
  companyName: string;
  plan: Plan;
  billingCycle: BillingCycle;
  carLimit: number;
  referralCode: string | null;
  discountCode: string | null;
}

export type OauthAccountInput = { action: 'reconcile' } | { action: 'discard' } | RegisterInput;

/** A body the function can act on, or the reply that refuses it. */
export type ParsedOauthAccountRequest = { input: OauthAccountInput } | { reply: HttpReply };

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Trimmed text of 1 to MAX_NAME_LENGTH characters with no control or format character, or null. */
function parseName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_NAME_LENGTH) return null;
  return CONTROL_OR_FORMAT_CHARACTER.test(value) ? null : value;
}

export function normalizePlan(raw: unknown): Plan {
  return isOneOf(PLANS, raw) ? raw : 'basic';
}

export function normalizeBillingCycle(raw: unknown): BillingCycle {
  return raw === 'yearly' ? 'yearly' : 'monthly';
}

/** company-signup's rule: a number from 1 to 100, and 3 for anything that is not one. */
export function normalizeCarLimit(raw: unknown): number {
  return Math.max(MIN_CAR_LIMIT, Math.min(MAX_CAR_LIMIT, Math.floor(Number(raw) || DEFAULT_CAR_LIMIT)));
}

export function parseOauthAccountRequest(text: string): ParsedOauthAccountRequest {
  const body = parseJsonObject(text);
  const action = body?.action;
  if (!body || !isOneOf(OAUTH_ACCOUNT_ACTIONS, action)) return { reply: invalidRequest() };
  if (action !== 'register') return { input: { action } };

  const fullName = parseName(body.full_name);
  const companyName = parseName(body.company_name);
  if (!fullName || !companyName) return { reply: invalidRequest() };

  // As company-signup reads them: anything but a string counts as no code.
  const referralCode = typeof body.referral_code === 'string' ? body.referral_code.trim().toUpperCase() : '';
  if (referralCode.length > MAX_REFERRAL_CODE_LENGTH) return { reply: registerRefusal('referral_invalid') };
  const discountCode = typeof body.discount_code === 'string' ? body.discount_code.trim() : '';
  if (discountCode.length > MAX_DISCOUNT_CODE_LENGTH) return { reply: invalidRequest() };

  return {
    input: {
      action,
      fullName,
      companyName,
      plan: normalizePlan(body.plan),
      billingCycle: normalizeBillingCycle(body.billing_cycle),
      carLimit: normalizeCarLimit(body.subscription_car_limit),
      referralCode: referralCode || null,
      discountCode: discountCode || null,
    },
  };
}

// ── Database results ─────────────────────────────────────────────────────────

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
  | { action: 'pending_signup_cancelled' | 'invite_accepted' }
  | { action: 'none'; reason: ReconcileNoneReason };

/** oauth_session_reconcile's jsonb, checked. Its company_id stays on the server: the caller reads its own profile. */
export function asReconcileDbResult(raw: unknown): ReconcileResult {
  const result = (raw ?? {}) as Record<string, unknown>;
  const { action, reason } = result;
  if (action === 'pending_signup_cancelled' || action === 'invite_accepted') return { action };
  if (action === 'none' && isOneOf(RECONCILE_NONE_REASONS, reason)) return { action, reason };
  throw new Error('oauth_session_reconcile returned a result outside the contract');
}

/** redeem_discount_code's reason codes (20260911120000). Any other value is passed on as null. */
export const DISCOUNT_REASON_CODES = [
  'INVALID',
  'INACTIVE',
  'NOT_YET_VALID',
  'EXPIRED',
  'WRONG_PLAN',
  'WRONG_BILLING_CYCLE',
  'TOO_FEW_CARS',
  'TOO_MANY_CARS',
  'ALREADY_USED',
  'LIMIT_REACHED',
] as const;
export type DiscountReasonCode = (typeof DISCOUNT_REASON_CODES)[number];

/**
 * What the registration screen needs of the discount code: whether it applied,
 * why not, and the prices. redeem_discount_code also returns a German sentence,
 * the code's id, type and usage mode; none of that is passed on.
 */
export interface DiscountSummary {
  success: boolean;
  /** Set only when the code did not apply. */
  reason_code: DiscountReasonCode | null;
  /** Set only when the code applied. */
  original_price: number | null;
  discount_amount: number | null;
  final_price: number | null;
}

const finiteNumberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** null when no discount code was given. The company is committed by the time this runs, so it never throws. */
export function asDiscountSummary(raw: unknown): DiscountSummary | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const result = raw as Record<string, unknown>;
  if (result.success === true) {
    return {
      success: true,
      reason_code: null,
      original_price: finiteNumberOrNull(result.original_price),
      discount_amount: finiteNumberOrNull(result.discount_amount),
      final_price: finiteNumberOrNull(result.final_price),
    };
  }
  return {
    success: false,
    reason_code: isOneOf(DISCOUNT_REASON_CODES, result.reason_code) ? result.reason_code : null,
    original_price: null,
    discount_amount: null,
    final_price: null,
  };
}

export interface RegisteredCompany {
  id: string;
  name: string | null;
  slug: string | null;
  trial_end: string | null;
  approval_status: string | null;
}

export interface RegisterResult {
  company: RegisteredCompany;
  discount: DiscountSummary | null;
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * oauth_signup_create_company's jsonb. By the time it arrives the company is
 * committed, so only what the screens cannot do without is required: ok and the
 * company id. A registration answered with 500 would be submitted again and
 * refused as company_exists.
 */
export function asRegisterDbResult(raw: unknown): RegisterResult {
  const result = (raw ?? {}) as Record<string, unknown>;
  const company = (result.company ?? {}) as Record<string, unknown>;
  if (result.ok !== true || typeof company.id !== 'string' || company.id.length === 0) {
    throw new Error('oauth_signup_create_company returned a result outside the contract');
  }
  return {
    company: {
      id: company.id,
      name: textOrNull(company.name),
      slug: textOrNull(company.slug),
      trial_end: textOrNull(company.trial_end),
      approval_status: textOrNull(company.approval_status),
    },
    discount: asDiscountSummary(result.discount),
  };
}

// ── Refusals ─────────────────────────────────────────────────────────────────

export type RegisterRefusalReason =
  | 'invalid_request'
  | 'account_not_found'
  | 'account_blocked'
  | 'email_not_confirmed'
  | 'not_google_account'
  | 'platform_staff'
  | 'company_exists'
  | 'no_pending_signup'
  | 'referral_invalid'
  | 'referral_inactive';

const REGISTER_REFUSAL_STATUS: Readonly<Record<RegisterRefusalReason, number>> = {
  invalid_request: 400,
  // The token was valid a moment ago; the account is gone. The screen signs out.
  account_not_found: 401,
  account_blocked: 403,
  email_not_confirmed: 403,
  not_google_account: 403,
  platform_staff: 403,
  company_exists: 409,
  no_pending_signup: 409,
  // 400, as company-signup answers the same two for the password signup.
  referral_invalid: 400,
  referral_inactive: 400,
};

/**
 * The SQLSTATE oauth_signup_create_company raises for each refusal (class OA,
 * listed in its migration), and 22023 for a broken argument contract. The code
 * is mapped, never the message.
 */
export const REGISTER_SQLSTATE_REASONS: Readonly<Record<string, RegisterRefusalReason>> = {
  '22023': 'invalid_request',
  OA001: 'account_not_found',
  OA002: 'account_blocked',
  OA003: 'email_not_confirmed',
  OA004: 'not_google_account',
  OA005: 'platform_staff',
  OA006: 'company_exists',
  OA007: 'no_pending_signup',
  OA008: 'referral_invalid',
  OA009: 'referral_inactive',
};

export function registerRefusal(reason: RegisterRefusalReason): HttpReply {
  return { status: REGISTER_REFUSAL_STATUS[reason], body: { ok: false, reason } };
}

/** The reply for a refusal the database raised, or null for any other error. */
export function mapRegisterError(error: unknown): HttpReply | null {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(REGISTER_SQLSTATE_REASONS, code)) return null;
  return registerRefusal(REGISTER_SQLSTATE_REASONS[code]);
}

export const notDiscardable = (): HttpReply => ({ status: 409, body: { ok: false, reason: 'not_discardable' } });

// ── Dispatch ─────────────────────────────────────────────────────────────────

/** The service-role client's rpc, narrowed to what dispatch uses, so a test can pass a fake. */
export type RpcCall = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs one action for the verified caller; `userId` is the only user id any RPC
 * receives. Resolves with the reply for every outcome the database reports, and
 * rejects for anything else (a transport error, an unknown SQLSTATE, a result
 * outside the contract), which the function logs and answers with 500.
 */
export async function runOauthAccountAction(input: OauthAccountInput, userId: string, rpc: RpcCall): Promise<HttpReply> {
  if (!USER_ID_PATTERN.test(userId)) throw new Error('oauth-account: the verified caller has no usable user id');
  switch (input.action) {
    case 'reconcile':
      return reconcile(userId, rpc);
    case 'register':
      return register(input, userId, rpc);
    case 'discard':
      return discard(userId, rpc);
  }
  throw new Error('oauth-account: unknown action');
}

async function reconcile(userId: string, rpc: RpcCall): Promise<HttpReply> {
  const { data, error } = await rpc('oauth_session_reconcile', { p_user_id: userId });
  if (error) throw error;
  return { status: 200, body: { ok: true, ...asReconcileDbResult(data) } };
}

async function register(input: RegisterInput, userId: string, rpc: RpcCall): Promise<HttpReply> {
  const { data, error } = await rpc('oauth_signup_create_company', {
    p_user_id: userId,
    p_full_name: input.fullName,
    p_company_name: input.companyName,
    p_plan: input.plan,
    p_billing_cycle: input.billingCycle,
    p_car_limit: input.carLimit,
    p_referral_code: input.referralCode,
    p_discount_code: input.discountCode,
  });
  if (error) {
    const refusal = mapRegisterError(error);
    if (refusal) return refusal;
    throw error;
  }
  const { company, discount } = asRegisterDbResult(data);
  return { status: 200, body: { ok: true, company, discount } };
}

async function discard(userId: string, rpc: RpcCall): Promise<HttpReply> {
  const { data, error } = await rpc('oauth_signup_discard', { p_user_id: userId });
  if (error) throw error;
  if (typeof data !== 'boolean') throw new Error('oauth_signup_discard returned a result outside the contract');
  return data ? { status: 200, body: { ok: true, discarded: true } } : notDiscardable();
}

// ── Logs ─────────────────────────────────────────────────────────────────────

// Anything shaped like an address, including one describeError's length limit
// cut short after the @.
const ADDRESS_IN_TEXT = /[^\s@"'<>(),;:[\]]+@[^\s@"'<>(),;:[\]]*/g;

/** describeError (no JWTs, hashes or six-digit runs), with addresses removed as well. */
export function describeOauthError(err: unknown): string {
  return describeError(err).replace(ADDRESS_IN_TEXT, '[address]');
}

export interface OauthLogContext {
  request_id: string;
  action?: OauthAccountAction;
  user_id?: string;
}

export function logOauthFailure(step: string, context: OauthLogContext, err: unknown): void {
  console.error(JSON.stringify({ level: 'error', fn: 'oauth-account', step, ...context, detail: describeOauthError(err) }));
}
