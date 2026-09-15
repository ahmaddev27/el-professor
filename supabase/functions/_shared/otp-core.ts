/**
 * Pure helpers for the one-time-code functions.
 *
 * No Deno, npm: or jsr: import, only web-standard globals (WebCrypto,
 * TextEncoder, atob, URL, Request). vitest runs this file in Node, and
 * otp-request, otp-verify, company-signup and manage-users run the same code.
 *
 * The database decides every outcome (supabase/migrations/20260915100100_otp_rpcs.sql).
 * This file only validates what comes in and turns those outcomes into HTTP.
 * The two mapping tables below are the wire contract src/lib/otpClient.ts is
 * written against: change one, change both.
 */

// ── Purposes and limits ──────────────────────────────────────────────────────

export const OTP_PURPOSES = [
  'signup_verify',
  'password_reset',
  'invite_activate',
  'email_change',
  'platform_login',
] as const;

export type OtpPurpose = (typeof OTP_PURPOSES)[number];
/** Asked for before anyone is signed in. */
export type PublicPurpose = 'signup_verify' | 'password_reset' | 'invite_activate';
/** Asked for with a session; the bearer token is verified by the function. */
export type AuthenticatedPurpose = 'email_change' | 'platform_login';

export function isOtpPurpose(value: unknown): value is OtpPurpose {
  return typeof value === 'string' && (OTP_PURPOSES as readonly string[]).includes(value);
}

export function isPublicPurpose(purpose: OtpPurpose): purpose is PublicPurpose {
  return purpose === 'signup_verify' || purpose === 'password_reset' || purpose === 'invite_activate';
}

// The database enforces cooldown and validity. These copies only tell the
// client what to display, so they must match the migration's constants.
export const OTP_COOLDOWN_SECONDS = 60;
export const OTP_VALIDITY_SECONDS = 600;

export const MAX_BODY_BYTES = 4096;
export const MAX_EMAIL_LENGTH = 254;
/** email_change needs a password sign-in at most this old (the amr claim). */
export const PASSWORD_PROOF_MAX_AGE_SECONDS = 600;
/** Public otp-request responses never leave sooner than this after arrival. */
export const PUBLIC_RESPONSE_FLOOR_MS = 1500;
export const MIN_PEPPER_LENGTH = 32;

// ── The code and its hash ────────────────────────────────────────────────────

/**
 * The largest multiple of 1,000,000 that fits in 32 bits. Random values at or
 * above it are drawn again, so each of the million codes is exactly as likely
 * as any other; `% 1e6` over the full range would favour codes below 967,296.
 */
export const CODE_REJECTION_BOUND = 4_294_000_000;

export const CODE_PATTERN = /^\d{6}$/;

export function generateCode(randomUint32: () => number): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const value = randomUint32() >>> 0;
    if (value < CODE_REJECTION_BOUND) return String(value % 1_000_000).padStart(6, '0');
  }
  // A real random source lands here with probability 0.00023^1000.
  throw new Error('generateCode: the random source never produced a usable value');
}

export function secureRandomUint32(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

const encoder = new TextEncoder();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message))));
}

/**
 * code_hash = lowercase hex of HMAC-SHA256(key = OTP_PEPPER, msg = "<challenge id>:<code>").
 *
 * The challenge id makes the same code hash differently in every challenge, and
 * the pepper, which the database never sees, is what stops a copy of the table
 * from being brute-forced over a million candidates.
 */
export async function hmacHex(pepper: string, challengeId: string, code: string): Promise<string> {
  if (pepper.length < MIN_PEPPER_LENGTH) throw new Error('hmacHex: the pepper is too short');
  if (!UUID_PATTERN.test(challengeId)) throw new Error('hmacHex: the challenge id must be a lowercase uuid');
  if (!CODE_PATTERN.test(code)) throw new Error('hmacHex: the code must be six digits');
  return hmacSha256Hex(pepper, `${challengeId}:${code}`);
}

// ── Input ────────────────────────────────────────────────────────────────────

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed and lower-cased, or null when the value is not a string. */
export function normalizeEmail(raw: unknown): string | null {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : null;
}

export function isValidEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);
}

export function parseEmail(raw: unknown): string | null {
  const email = normalizeEmail(raw);
  return email !== null && isValidEmail(email) ? email : null;
}

/** Six digits once whitespace is removed, so a pasted "123 456" still counts. */
export function parseCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.replace(/\s+/g, '');
  return CODE_PATTERN.test(code) ? code : null;
}

const IPV4_PATTERN = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * The X-Client-IP header as an address Postgres' inet accepts, or null.
 *
 * Caddy overwrites the header on every API host, so a client cannot choose it
 * there; this only guards against a malformed value reaching the cast. IPv4 is
 * matched strictly (no leading zeros, no short forms). IPv6 goes through the URL
 * parser, which rejects anything that is not a valid literal, zone ids included.
 */
export function parseClientIp(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 45) return null;
  if (IPV4_PATTERN.test(value)) return value;
  if (!value.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(value)) return null;
  try {
    new URL(`http://[${value}]/`);
    return value.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The request body as text, or null when it is larger than `maxBytes` or not
 * UTF-8. Reads the stream itself, so a missing or false Content-Length cannot
 * make the worker buffer more than the limit.
 */
export async function readBodyText(req: Request, maxBytes = MAX_BODY_BYTES): Promise<string | null> {
  const declared = req.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export type OtpRequestInput =
  | { purpose: PublicPurpose; email: string }
  | { purpose: 'email_change'; newEmail: string }
  | { purpose: 'platform_login' };

/** otp-request's body. Unknown fields are ignored; anything invalid is null. */
export function parseOtpRequest(text: string): OtpRequestInput | null {
  const body = parseJsonObject(text);
  if (!body || !isOtpPurpose(body.purpose)) return null;
  const purpose = body.purpose;
  if (isPublicPurpose(purpose)) {
    const email = parseEmail(body.email);
    return email ? { purpose, email } : null;
  }
  if (purpose === 'email_change') {
    const newEmail = parseEmail(body.new_email);
    return newEmail ? { purpose, newEmail } : null;
  }
  return { purpose };
}

export type OtpVerifyInput =
  | { purpose: PublicPurpose; email: string; code: string }
  | { purpose: AuthenticatedPurpose; code: string };

/** otp-verify's body. A malformed code is a 400 and never costs an attempt. */
export function parseOtpVerify(text: string): OtpVerifyInput | null {
  const body = parseJsonObject(text);
  if (!body || !isOtpPurpose(body.purpose)) return null;
  const code = parseCode(body.code);
  if (!code) return null;
  const purpose = body.purpose;
  if (isPublicPurpose(purpose)) {
    const email = parseEmail(body.email);
    return email ? { purpose, email, code } : null;
  }
  return { purpose, code };
}

// ── Tokens ───────────────────────────────────────────────────────────────────

export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * The payload of a JWT, without verifying anything. Only ever called on a token
 * GoTrue has just accepted through getUser.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*$/.test(base64)) return null;
  try {
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Seconds since the newest password sign-in recorded in the token's amr claim,
 * or null when the session was never established with a password.
 *
 * GoTrue v2.170.0 writes `amr: [{method: "password", timestamp: <sign-in>}]`
 * and keeps that timestamp when a refresh issues a new token (probed
 * 15.09.2026), so this is the age of the password proof, not of the access
 * token. A session made by /verify, as issueSession makes them, carries
 * `method: "otp"` and never counts as a password proof.
 */
export function passwordAmrAgeSeconds(payload: Record<string, unknown>, nowSec: number): number | null {
  const amr = payload.amr;
  if (!Array.isArray(amr)) return null;
  let newest: number | null = null;
  for (const entry of amr) {
    if (!entry || typeof entry !== 'object') continue;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    if (method !== 'password' || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue;
    newest = newest === null ? timestamp : Math.max(newest, timestamp);
  }
  return newest === null ? null : Math.max(0, Math.floor(nowSec - newest));
}

// ── Database results ─────────────────────────────────────────────────────────

export type IssueRateLimitReason = 'ip_hourly' | 'cooldown' | 'email_hourly';

export interface IssuedDbResult {
  status: 'issued';
  challenge_id: string;
  user_id: string;
  recipient_email: string;
  expires_at: string;
  full_name: string | null;
  company_name: string | null;
}

export type IssueDbResult =
  | IssuedDbResult
  | { status: 'no_user' | 'ineligible' | 'same_email' | 'email_taken' }
  | { status: 'rate_limited'; reason: IssueRateLimitReason; retry_after_seconds: number };

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** An integer of at least 1, whatever the database sent. */
export function retryAfterSeconds(value: unknown): number {
  const seconds = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : OTP_COOLDOWN_SECONDS;
}

/** otp_issue's jsonb, checked. A shape outside the contract means the migration and the function disagree. */
export function asIssueDbResult(raw: unknown): IssueDbResult {
  const result = (raw ?? {}) as Record<string, unknown>;
  const { status, reason } = result;
  if (status === 'issued') {
    const { challenge_id, user_id, recipient_email, expires_at } = result;
    if (isText(challenge_id) && isText(user_id) && isText(recipient_email) && isText(expires_at)) {
      return {
        status, challenge_id, user_id, recipient_email, expires_at,
        full_name: textOrNull(result.full_name),
        company_name: textOrNull(result.company_name),
      };
    }
  } else if (status === 'no_user' || status === 'ineligible' || status === 'same_email' || status === 'email_taken') {
    return { status };
  } else if (status === 'rate_limited' && (reason === 'ip_hourly' || reason === 'cooldown' || reason === 'email_hourly')) {
    return { status, reason, retry_after_seconds: retryAfterSeconds(result.retry_after_seconds) };
  }
  throw new Error('otp_issue returned a result outside the contract');
}

export interface VerifyOkDbResult {
  status: 'ok';
  purpose: OtpPurpose;
  user_id: string;
  email: string;
  new_email: string | null;
  platform_verified_until: string | null;
}

export type VerifyDbResult =
  | VerifyOkDbResult
  | { status: 'wrong'; attempts_left: number }
  | { status: 'locked' | 'expired' | 'not_found' | 'session_invalid' | 'email_taken' };

/** otp_verify's jsonb, checked, including that an `ok` is for the purpose that was asked. */
export function asVerifyDbResult(raw: unknown, expectedPurpose: OtpPurpose): VerifyDbResult {
  const result = (raw ?? {}) as Record<string, unknown>;
  const { status } = result;
  if (status === 'ok') {
    const { purpose, user_id, email } = result;
    if (isOtpPurpose(purpose) && purpose === expectedPurpose && isText(user_id) && isText(email)) {
      return {
        status, purpose, user_id, email,
        new_email: textOrNull(result.new_email),
        platform_verified_until: textOrNull(result.platform_verified_until),
      };
    }
  } else if (status === 'wrong') {
    const left = Number(result.attempts_left);
    return { status, attempts_left: Number.isFinite(left) ? Math.min(4, Math.max(1, Math.floor(left))) : 1 };
  } else if (
    status === 'locked' || status === 'expired' || status === 'not_found' ||
    status === 'session_invalid' || status === 'email_taken'
  ) {
    return { status };
  }
  throw new Error('otp_verify returned a result outside the contract');
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

export interface HttpReply {
  status: number;
  body: Record<string, unknown>;
}

export const methodNotAllowed = (): HttpReply => ({ status: 405, body: { ok: false, reason: 'method_not_allowed' } });
export const invalidRequest = (): HttpReply => ({ status: 400, body: { ok: false, reason: 'invalid_request' } });
export const unauthorized = (): HttpReply => ({ status: 401, body: { ok: false, reason: 'unauthorized' } });
export const reauthRequired = (): HttpReply => ({ status: 401, body: { ok: false, reason: 'reauth_required' } });
export const challengeNotFound = (): HttpReply => ({ status: 422, body: { ok: false, reason: 'not_found' } });
export const emailTaken = (): HttpReply => ({ status: 409, body: { ok: false, reason: 'email_taken' } });
export const internalError = (requestId: string): HttpReply =>
  ({ status: 500, body: { ok: false, reason: 'internal', request_id: requestId } });
export const sessionFailed = (requestId: string): HttpReply =>
  ({ status: 502, body: { ok: false, reason: 'session_failed', request_id: requestId } });

const codeTiming = { cooldown_seconds: OTP_COOLDOWN_SECONDS, expires_in_seconds: OTP_VALIDITY_SECONDS };

/**
 * otp_issue's outcome as HTTP.
 *
 * Public purposes answer one 202 for everything that depends on the address
 * (issued, no account, ineligible, cooldown, hourly limit, failed mail), so the
 * endpoint cannot be used to learn which addresses have accounts. The per-IP
 * limit is the one exception, because it is the same for every address.
 *
 * Authenticated purposes belong to a signed-in user, who may learn everything
 * about their own request, so they answer precisely. `mail` is the send result
 * for an issued code.
 */
export function mapIssueToHttp(
  kind: 'public' | 'authenticated',
  db: IssueDbResult,
  mail?: 'sent' | 'send_failed',
): HttpReply {
  if (kind === 'public') {
    if (db.status === 'rate_limited' && db.reason === 'ip_hourly') {
      return {
        status: 429,
        body: { ok: false, reason: 'rate_limited', scope: 'ip', retry_after_seconds: retryAfterSeconds(db.retry_after_seconds) },
      };
    }
    return { status: 202, body: { ok: true, status: 'accepted', ...codeTiming } };
  }

  switch (db.status) {
    case 'issued':
      return mail === 'sent'
        ? { status: 200, body: { ok: true, status: 'sent', ...codeTiming } }
        : { status: 502, body: { ok: false, reason: 'send_failed' } };
    case 'rate_limited':
      return {
        status: 429,
        body: {
          ok: false,
          reason: 'rate_limited',
          scope: db.reason === 'ip_hourly' ? 'ip' : db.reason,
          retry_after_seconds: retryAfterSeconds(db.retry_after_seconds),
        },
      };
    case 'same_email':
      return { status: 400, body: { ok: false, reason: 'same_email' } };
    case 'email_taken':
      return emailTaken();
    case 'ineligible':
    case 'no_user':
      return { status: 403, body: { ok: false, reason: 'forbidden' } };
  }
}

/** otp_verify's failures as HTTP; null for `ok`, which each purpose completes itself. */
export function mapVerifyToHttp(db: VerifyDbResult): HttpReply | null {
  switch (db.status) {
    case 'ok':
      return null;
    case 'wrong':
      return { status: 422, body: { ok: false, reason: 'invalid_code', attempts_left: db.attempts_left } };
    case 'locked':
      return { status: 422, body: { ok: false, reason: 'locked' } };
    case 'expired':
      return { status: 422, body: { ok: false, reason: 'expired' } };
    case 'not_found':
      return challengeNotFound();
    case 'session_invalid':
      return unauthorized();
    case 'email_taken':
      return emailTaken();
  }
}

export interface OtpSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  token_type: string;
}

/** Exactly the five session fields from GoTrue's /verify answer; its `user` object is dropped. */
export function pickSession(raw: unknown): OtpSession {
  const { access_token, refresh_token, expires_in, expires_at, token_type } = (raw ?? {}) as Record<string, unknown>;
  if (
    typeof access_token !== 'string' || typeof refresh_token !== 'string' || typeof token_type !== 'string' ||
    typeof expires_in !== 'number' || typeof expires_at !== 'number'
  ) {
    throw new Error('GoTrue verify returned no usable session');
  }
  return { access_token, refresh_token, expires_in, expires_at, token_type };
}

// ── GoTrue errors ────────────────────────────────────────────────────────────

function errorFields(error: unknown): { code?: unknown; status?: unknown; message?: unknown } {
  return error && typeof error === 'object' ? (error as { code?: unknown; status?: unknown; message?: unknown }) : {};
}

/**
 * auth.admin.createUser refused because the address already has an account.
 * GoTrue v2.170.0 answers 422 email_exists for any letter case of the address
 * (probed 15.09.2026); the message match covers older wording.
 */
export function isEmailExistsError(error: unknown): boolean {
  const { code, message } = errorFields(error);
  return code === 'email_exists' ||
    (typeof message === 'string' && /already (been )?registered|already exists/i.test(message));
}

/**
 * auth.admin.updateUserById refused a new address because another account has it.
 *
 * Only a refusal GoTrue names is recognised: email_exists, or a 422. GoTrue
 * v2.170.0 names none here. Probed on 15.09.2026, moving an account to an
 * address another account holds answers 500 "Error updating user", which cannot
 * be told apart from any other failed update, so it is not guessed at. The gap
 * is narrow: otp_verify refuses a taken address before it consumes the code, so
 * only a registration landing between the two ends as session_failed, and the
 * next otp-request then answers email_taken.
 */
export function isEmailTakenOnUpdate(error: unknown): boolean {
  const { status } = errorFields(error);
  return isEmailExistsError(error) || status === 422;
}

// ── Timing and logs ──────────────────────────────────────────────────────────

export async function padElapsed(startedAtMs: number, floorMs: number, now: () => number = Date.now): Promise<void> {
  const remaining = floorMs - (now() - startedAtMs);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

export function newRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * The last line of defence for anything written to a log: a JWT, a run of 32 or
 * more hex characters (a code hash, GoTrue's hashed_token) and a lone six-digit
 * number are replaced. No call site passes a code or a token on purpose; this
 * catches an error message that echoes one back.
 */
export function scrubForLog(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g, '[jwt]')
    .replace(/[0-9a-fA-F]{32,}/g, '[hex]')
    .replace(/(?<![0-9])[0-9]{6}(?![0-9])/g, '[digits]')
    .slice(0, 500);
}

/**
 * One line about an error. For a PostgREST error that is its code and message;
 * `details`, which can quote a whole failing row, is deliberately left out.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return scrubForLog(`${err.name}${typeof code === 'string' ? ` ${code}` : ''}: ${err.message}`);
  }
  const { code, message } = errorFields(err);
  if (typeof message === 'string') return scrubForLog(`${typeof code === 'string' ? `${code}: ` : ''}${message}`);
  return scrubForLog(String(err));
}

export interface LogContext {
  request_id?: string;
  purpose?: string;
  user_id?: string;
}

export function logFailure(fn: string, step: string, context: LogContext, err: unknown): void {
  console.error(JSON.stringify({ level: 'error', fn, step, ...context, detail: describeError(err) }));
}
