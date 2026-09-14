import type { TranslationKey, TranslationVars } from '../i18n';

/**
 * The only caller of the `otp-request` and `otp-verify` edge functions.
 *
 * Every screen that sends or checks a one-time code goes through here, so the
 * wire format (snake_case, HTTP status, closed reason lists) is parsed in one
 * place and every screen sees the same camelCase result. An unexpected answer
 * never throws: a failed fetch or a body that is not JSON becomes `network`,
 * and a reason outside the closed list becomes `internal`.
 *
 * Contract: Phase 1 interface contract, sections 3.2, 3.3 and 5.1.
 */

export type OtpPurpose =
  | 'signup_verify'
  | 'password_reset'
  | 'invite_activate'
  | 'email_change'
  | 'platform_login';

/** The purposes a visitor without a session may use; they identify the account by email. */
export type PublicOtpPurpose = 'signup_verify' | 'password_reset' | 'invite_activate';

export type OtpRequestInput =
  | { purpose: PublicOtpPurpose; email: string }
  | { purpose: 'email_change'; newEmail: string; accessToken: string }
  | { purpose: 'platform_login'; accessToken: string };

export type OtpRequestFailureReason =
  | 'invalid_request' | 'rate_limited' | 'unauthorized' | 'reauth_required' | 'forbidden'
  | 'same_email' | 'email_taken' | 'send_failed' | 'internal' | 'network';

export type OtpRateLimitScope = 'ip' | 'cooldown' | 'email_hourly';

export type OtpRequestFailure = {
  ok: false;
  reason: OtpRequestFailureReason;
  scope?: OtpRateLimitScope;
  retryAfterSeconds?: number;
};

/** `uniform` is true for HTTP 202: the answer is the same whether or not the account exists. */
export type OtpRequestResult =
  | { ok: true; cooldownSeconds: number; expiresInSeconds: number; uniform: boolean }
  | OtpRequestFailure;

export type OtpSession = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  token_type: string;
};

export type OtpVerifyFailureReason =
  | 'invalid_request' | 'invalid_code' | 'locked' | 'expired' | 'not_found' | 'email_taken'
  | 'unauthorized' | 'session_failed' | 'internal' | 'network';

export type OtpSessionSuccess = {
  ok: true;
  purpose: PublicOtpPurpose;
  next: 'app' | 'set_password';
  session: OtpSession;
};

export type OtpVerifySuccess =
  | OtpSessionSuccess
  | { ok: true; purpose: 'email_change'; email: string }
  | { ok: true; purpose: 'platform_login'; verifiedUntil: string };

export type OtpVerifyFailure = { ok: false; reason: OtpVerifyFailureReason; attemptsLeft?: number };

export type OtpVerifyResult = OtpVerifySuccess | OtpVerifyFailure;

export type OtpVerifyInput = { purpose: OtpPurpose; email?: string; code: string; accessToken?: string };

/** A message as translation keys; `plural` is appended after the main sentence. */
export type OtpMessage = {
  key: TranslationKey;
  vars?: TranslationVars;
  plural?: { one: TranslationKey; other: TranslationKey; count: number };
};

export const OTP_CODE_LENGTH = 6;
export const DEFAULT_RESEND_COOLDOWN_SECONDS = 60;
const DEFAULT_CODE_VALIDITY_SECONDS = 600;
// The same bound and shape the functions check (contract 3.1), so an address
// the server would refuse with 400 is refused here without a request.
const MAX_EMAIL_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PUBLIC_PURPOSES: ReadonlySet<OtpPurpose> = new Set<OtpPurpose>([
  'signup_verify', 'password_reset', 'invite_activate',
]);

const REQUEST_FAILURE_REASONS: ReadonlySet<string> = new Set<OtpRequestFailureReason>([
  'invalid_request', 'rate_limited', 'unauthorized', 'reauth_required', 'forbidden',
  'same_email', 'email_taken', 'send_failed', 'internal', 'network',
]);

const VERIFY_FAILURE_REASONS: ReadonlySet<string> = new Set<OtpVerifyFailureReason>([
  'invalid_request', 'invalid_code', 'locked', 'expired', 'not_found', 'email_taken',
  'unauthorized', 'session_failed', 'internal', 'network',
]);

const RATE_LIMIT_SCOPES: ReadonlySet<string> = new Set<OtpRateLimitScope>(['ip', 'cooldown', 'email_hourly']);

export const isPublicOtpPurpose = (purpose: OtpPurpose): purpose is PublicOtpPurpose =>
  PUBLIC_PURPOSES.has(purpose);

/** Digits only, at most six. A pasted "123 456" or "123-456" becomes "123456". */
export function normalizeOtpInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, OTP_CODE_LENGTH);
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isPlausibleEmail(raw: string): boolean {
  const email = normalizeEmail(raw);
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_SHAPE.test(email);
}

/**
 * The address carried in a mail link's fragment, `#email=a%40b.de`.
 *
 * Parsed by hand rather than with URLSearchParams, which turns a literal `+`
 * into a space and would corrupt `name+tag@example.de`.
 */
export function emailFromFragment(hash: string): string {
  const pair = hash
    .replace(/^#/, '')
    .split('&')
    .find(part => part.startsWith('email='));
  if (!pair) return '';
  try {
    return normalizeEmail(decodeURIComponent(pair.slice('email='.length)));
  } catch {
    return '';
  }
}

// ─── Transport ──────────────────────────────────────────────────────────────

type WireAnswer = { status: number; body: Record<string, unknown> | null; retryAfterHeader: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** null means the request never produced a JSON answer. */
async function callFunction(
  name: 'otp-request' | 'otp-verify',
  payload: Record<string, unknown>,
  accessToken?: string,
): Promise<WireAnswer | null> {
  const baseUrl = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  const headers: Record<string, string> = {
    apikey: String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''),
    'Content-Type': 'application/json',
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/functions/v1/${name}`, {
      method: 'POST',
      headers,
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
  return {
    status: response.status,
    body: isRecord(parsed) ? parsed : null,
    retryAfterHeader: response.headers.get('Retry-After'),
  };
}

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.ceil(value) : undefined;

/** The server promises at least 1 s; a header or body that says otherwise is rounded up to 1. */
const retryAfter = (value: unknown): number | undefined => {
  const seconds = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  const parsed = nonNegativeInteger(seconds);
  return parsed === undefined ? undefined : Math.max(1, parsed);
};

// ─── otp-request ────────────────────────────────────────────────────────────

function requestPayload(input: OtpRequestInput): { payload: Record<string, unknown>; accessToken?: string } | null {
  if (input.purpose === 'email_change') {
    const newEmail = normalizeEmail(input.newEmail);
    if (!isPlausibleEmail(newEmail) || !input.accessToken) return null;
    return { payload: { purpose: input.purpose, new_email: newEmail }, accessToken: input.accessToken };
  }
  if (input.purpose === 'platform_login') {
    if (!input.accessToken) return null;
    return { payload: { purpose: input.purpose }, accessToken: input.accessToken };
  }
  const email = normalizeEmail(input.email);
  if (!isPlausibleEmail(email)) return null;
  return { payload: { purpose: input.purpose, email } };
}

function parseRequestAnswer(answer: WireAnswer): OtpRequestResult {
  const { status, body } = answer;

  if (body?.ok === true) {
    return {
      ok: true,
      cooldownSeconds: nonNegativeInteger(body.cooldown_seconds) ?? DEFAULT_RESEND_COOLDOWN_SECONDS,
      expiresInSeconds: nonNegativeInteger(body.expires_in_seconds) ?? DEFAULT_CODE_VALIDITY_SECONDS,
      uniform: status === 202,
    };
  }

  if (body?.ok === false) {
    const reason = typeof body.reason === 'string' && REQUEST_FAILURE_REASONS.has(body.reason)
      ? (body.reason as OtpRequestFailureReason)
      : 'internal';
    const failure: OtpRequestFailure = { ok: false, reason };
    if (typeof body.scope === 'string' && RATE_LIMIT_SCOPES.has(body.scope)) {
      failure.scope = body.scope as OtpRateLimitScope;
    }
    const seconds = retryAfter(body.retry_after_seconds);
    if (seconds !== undefined) failure.retryAfterSeconds = seconds;
    return failure;
  }

  // Not our body: the router's own 401, or a proxy in front of it.
  if (status === 401) return { ok: false, reason: 'unauthorized' };
  if (status === 429) {
    const seconds = retryAfter(answer.retryAfterHeader);
    return seconds === undefined
      ? { ok: false, reason: 'rate_limited' }
      : { ok: false, reason: 'rate_limited', retryAfterSeconds: seconds };
  }
  return { ok: false, reason: 'internal' };
}

export async function requestOtp(input: OtpRequestInput): Promise<OtpRequestResult> {
  const prepared = requestPayload(input);
  if (!prepared) return { ok: false, reason: 'invalid_request' };
  const answer = await callFunction('otp-request', prepared.payload, prepared.accessToken);
  return answer ? parseRequestAnswer(answer) : { ok: false, reason: 'network' };
}

// ─── otp-verify ─────────────────────────────────────────────────────────────

function parseSession(value: unknown): OtpSession | null {
  if (!isRecord(value)) return null;
  const { access_token, refresh_token } = value;
  if (typeof access_token !== 'string' || access_token === '') return null;
  if (typeof refresh_token !== 'string' || refresh_token === '') return null;
  return {
    access_token,
    refresh_token,
    expires_in: nonNegativeInteger(value.expires_in) ?? 0,
    expires_at: nonNegativeInteger(value.expires_at) ?? 0,
    token_type: typeof value.token_type === 'string' ? value.token_type : 'bearer',
  };
}

function parseVerifySuccess(purpose: OtpPurpose, body: Record<string, unknown>): OtpVerifyResult {
  if (typeof body.purpose === 'string' && body.purpose !== purpose) {
    return { ok: false, reason: 'internal' };
  }

  if (purpose === 'email_change') {
    return { ok: true, purpose, email: typeof body.email === 'string' ? body.email : '' };
  }
  if (purpose === 'platform_login') {
    return { ok: true, purpose, verifiedUntil: typeof body.verified_until === 'string' ? body.verified_until : '' };
  }

  // The code is already consumed at this point, so an answer without a usable
  // session is the same situation as the server's own session_failed.
  const session = parseSession(body.session);
  if (!session) return { ok: false, reason: 'session_failed' };
  const next = body.next === 'app' || body.next === 'set_password'
    ? body.next
    : purpose === 'signup_verify' ? 'app' : 'set_password';
  return { ok: true, purpose, next, session };
}

function parseVerifyAnswer(purpose: OtpPurpose, answer: WireAnswer): OtpVerifyResult {
  const { status, body } = answer;

  if (body?.ok === true) return parseVerifySuccess(purpose, body);

  if (body?.ok === false) {
    const reason = typeof body.reason === 'string' && VERIFY_FAILURE_REASONS.has(body.reason)
      ? (body.reason as OtpVerifyFailureReason)
      : 'internal';
    const attemptsLeft = nonNegativeInteger(body.attempts_left);
    return reason === 'invalid_code' && attemptsLeft !== undefined
      ? { ok: false, reason, attemptsLeft }
      : { ok: false, reason };
  }

  return { ok: false, reason: status === 401 ? 'unauthorized' : 'internal' };
}

export async function verifyOtp(input: OtpVerifyInput): Promise<OtpVerifyResult> {
  const code = normalizeOtpInput(input.code);
  if (code.length !== OTP_CODE_LENGTH) return { ok: false, reason: 'invalid_request' };

  if (isPublicOtpPurpose(input.purpose)) {
    const email = normalizeEmail(input.email ?? '');
    if (!isPlausibleEmail(email)) return { ok: false, reason: 'invalid_request' };
    const answer = await callFunction('otp-verify', { purpose: input.purpose, email, code });
    return answer ? parseVerifyAnswer(input.purpose, answer) : { ok: false, reason: 'network' };
  }

  if (!input.accessToken) return { ok: false, reason: 'invalid_request' };
  const answer = await callFunction('otp-verify', { purpose: input.purpose, code }, input.accessToken);
  return answer ? parseVerifyAnswer(input.purpose, answer) : { ok: false, reason: 'network' };
}

// ─── Messages ───────────────────────────────────────────────────────────────

type FixedMessageReason = Exclude<OtpRequestFailureReason | OtpVerifyFailureReason, 'rate_limited' | 'invalid_code'>;

// A Record over the exact union: adding a reason without a message fails to compile.
const FIXED_FAILURE_KEYS: Record<FixedMessageReason, TranslationKey> = {
  invalid_request: 'otp.error.invalidInput',
  unauthorized:    'otp.error.unauthorized',
  reauth_required: 'otp.error.reauthRequired',
  forbidden:       'otp.error.forbidden',
  same_email:      'account.error.emailUnchanged',
  email_taken:     'otp.error.emailTaken',
  send_failed:     'otp.error.sendFailed',
  locked:          'otp.error.locked',
  expired:         'otp.error.expired',
  not_found:       'otp.error.notFound',
  session_failed:  'otp.error.sessionFailed',
  internal:        'otp.error.internal',
  network:         'otp.error.network',
};

/**
 * The message a result shows, per contract 5.3. A successful request reads
 * `otp.sent`; the forgot-password screen substitutes its own uniform wording.
 * A successful verification has no message — the screen moves on.
 */
export function otpMessage(result: OtpRequestResult | OtpVerifyResult): OtpMessage | null {
  if (result.ok) return 'cooldownSeconds' in result ? { key: 'otp.sent' } : null;

  switch (result.reason) {
    case 'rate_limited':
      return result.scope === 'email_hourly'
        ? { key: 'otp.error.rateLimitedHourly' }
        : { key: 'otp.error.rateLimited', vars: { seconds: result.retryAfterSeconds ?? DEFAULT_RESEND_COOLDOWN_SECONDS } };
    case 'invalid_code':
      return result.attemptsLeft === undefined
        ? { key: 'otp.error.invalidCode' }
        : {
            key: 'otp.error.invalidCode',
            plural: { one: 'otp.error.attemptsLeftOne', other: 'otp.error.attemptsLeftOther', count: result.attemptsLeft },
          };
    default:
      return { key: FIXED_FAILURE_KEYS[result.reason] };
  }
}

type Translate = (key: TranslationKey, vars?: TranslationVars) => string;
type TranslatePlural = (keys: { one: TranslationKey; other: TranslationKey }, count: number, vars?: TranslationVars) => string;

export function formatOtpMessage(message: OtpMessage, t: Translate, tPlural: TranslatePlural): string {
  const sentence = t(message.key, message.vars);
  if (!message.plural) return sentence;
  const { one, other, count } = message.plural;
  return `${sentence} ${tPlural({ one, other }, count)}`;
}
