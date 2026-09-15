/**
 * The Deno half of the one-time-code flow: environment, the database RPCs, the
 * mail, and turning a verified code into a GoTrue session.
 *
 * Invariants every caller relies on:
 *
 * - A code exists only in memory, between issueOtp() and the mail that carries
 *   it. It is never logged, never returned and never stored. The database sees
 *   only its HMAC, and the pepper never leaves this process.
 * - issueSession() is the only caller of auth.admin.generateLink in the
 *   codebase. generateLink *creates an account* for an address GoTrue does not
 *   know (probed against v2.170.0 on 15.09.2026), so it is only ever handed an
 *   address getUserById has just confirmed belongs to the user the database
 *   named.
 * - No request from here to GoTrue carries X-Client-IP. GoTrue keys its
 *   per-client limits on that header; the limits for codes live in otp_issue
 *   and otp_verify, and a code they admitted must not be refused a second time.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { corsFor } from './http.ts';
import { sendMail } from './mail.ts';
import { buildEmailChangedNotice, buildOtpMail } from './otp-mail.ts';
import {
  asIssueDbResult,
  asVerifyDbResult,
  bearerToken,
  decodeJwtPayload,
  generateCode,
  hmacHex,
  isPublicPurpose,
  logFailure,
  MIN_PEPPER_LENGTH,
  pickSession,
  secureRandomUint32,
  type HttpReply,
  type IssueDbResult,
  type IssueRateLimitReason,
  type LogContext,
  type OtpPurpose,
  type OtpSession,
  type VerifyDbResult,
} from './otp-core.ts';

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`environment variable ${name} is not set`);
  return value;
}

let client: SupabaseClient | null = null;

/** The service-role client, created once per worker. */
export function serviceClient(): SupabaseClient {
  client ??= createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}

function pepper(): string {
  const value = requireEnv('OTP_PEPPER');
  if (value.length < MIN_PEPPER_LENGTH) throw new Error('OTP_PEPPER is shorter than 32 characters');
  return value;
}

/** JSON with the headers every OTP response carries. */
export function otpResponse(req: Request, reply: HttpReply): Response {
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { ...corsFor(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * Lets a task finish after the response through EdgeRuntime.waitUntil. Returns
 * false where the runtime has no such hook, and the caller then awaits the task
 * itself. Probed on 15.09.2026 in the staging functions container: v1.76.2 user
 * workers have it, and a send handed to it finished 1.5 s after the response.
 */
export function runAfterResponse(task: Promise<unknown>): boolean {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (typeof runtime?.waitUntil !== 'function') return false;
  runtime.waitUntil(task);
  return true;
}

// ── Issuing ──────────────────────────────────────────────────────────────────

export interface IssueInput {
  purpose: OtpPurpose;
  /** Public purposes: the address that was typed. */
  email?: string | null;
  /** Authenticated purposes: the verified caller. */
  userId?: string | null;
  /** email_change only. */
  newEmail?: string | null;
  /** platform_login only: the session id from the verified token. */
  sessionId?: string | null;
  /** Null skips the per-IP limit, as for invites sent by an admin. */
  clientIp: string | null;
  /** manage-users invites: the admin who sent it. */
  actorUserId?: string | null;
}

export interface IssuedChallenge {
  db: IssueDbResult;
  /** Present only when the database issued the challenge. Never log it. */
  code: string | null;
}

/** Creates a challenge through otp_issue. The code is generated here and leaves only in the mail. */
export async function issueOtp(input: IssueInput): Promise<IssuedChallenge> {
  const challengeId = crypto.randomUUID();
  const code = generateCode(secureRandomUint32);
  const codeHash = await hmacHex(pepper(), challengeId, code);
  const { data, error } = await serviceClient().rpc('otp_issue', {
    p_challenge_id: challengeId,
    p_purpose: input.purpose,
    p_email: input.email ?? null,
    p_user_id: input.userId ?? null,
    p_new_email: input.newEmail ?? null,
    p_session_id: input.sessionId ?? null,
    p_code_hash: codeHash,
    p_client_ip: input.clientIp,
    p_actor_user_id: input.actorUserId ?? null,
  });
  if (error) throw error;
  const db = asIssueDbResult(data);
  if (db.status !== 'issued') return { db, code: null };
  if (db.challenge_id !== challengeId) throw new Error('otp_issue answered for a different challenge');
  return { db, code };
}

export interface DeliveryInput {
  purpose: OtpPurpose;
  issued: IssuedChallenge;
  /** The account's current address; the recipient comes from the database. */
  accountEmail: string;
  newEmail?: string | null;
  requestId?: string;
}

/**
 * Mails an issued code. Never rejects, so it is safe to hand to waitUntil: a
 * failure is logged and the challenge closed through otp_mark_send_failed, which
 * also keeps the failed send from starting the cooldown.
 */
export async function deliverOtp(input: DeliveryInput): Promise<'sent' | 'send_failed'> {
  const { db, code } = input.issued;
  if (db.status !== 'issued' || code === null) throw new Error('deliverOtp needs an issued challenge');
  const context: LogContext = { request_id: input.requestId, purpose: input.purpose, user_id: db.user_id };
  try {
    const mail = buildOtpMail(input.purpose, {
      appUrl: requireEnv('APP_URL'),
      email: input.accountEmail,
      newEmail: input.newEmail ?? null,
      companyName: db.company_name,
      code,
    });
    await sendMail({ to: db.recipient_email, ...mail });
    return 'sent';
  } catch (err) {
    logFailure('otp', 'send_mail', context, err);
    try {
      const { error } = await serviceClient().rpc('otp_mark_send_failed', { p_challenge_id: db.challenge_id });
      if (error) throw error;
    } catch (markError) {
      logFailure('otp', 'mark_send_failed', context, markError);
    }
    return 'send_failed';
  }
}

export interface IssueAndSendResult {
  /**
   * sent / send_failed: a code was issued, and the mail went out or did not.
   * accepted_silent: a public purpose found no eligible account; nothing was
   * sent and the caller must not say so to the public.
   * rate_limited: see reason and retryAfterSeconds.
   * rejected: an authenticated purpose was refused; reason is the database status.
   */
  status: 'sent' | 'send_failed' | 'accepted_silent' | 'rate_limited' | 'rejected';
  reason?: IssueRateLimitReason | 'no_user' | 'ineligible' | 'same_email' | 'email_taken';
  retryAfterSeconds?: number;
  dbStatus: IssueDbResult['status'];
}

/** Issue and mail in one step, for callers that answer only after the send. */
export async function issueAndSendOtp(
  input: IssueInput & { accountEmail?: string | null; requestId?: string },
): Promise<IssueAndSendResult> {
  const issued = await issueOtp(input);
  const { db } = issued;
  switch (db.status) {
    case 'issued': {
      const status = await deliverOtp({
        purpose: input.purpose,
        issued,
        accountEmail: input.accountEmail ?? db.recipient_email,
        newEmail: input.newEmail,
        requestId: input.requestId,
      });
      return { status, dbStatus: db.status };
    }
    case 'rate_limited':
      return { status: 'rate_limited', reason: db.reason, retryAfterSeconds: db.retry_after_seconds, dbStatus: db.status };
    case 'no_user':
    case 'ineligible':
      return isPublicPurpose(input.purpose)
        ? { status: 'accepted_silent', reason: db.status, dbStatus: db.status }
        : { status: 'rejected', reason: db.status, dbStatus: db.status };
    case 'same_email':
    case 'email_taken':
      return { status: 'rejected', reason: db.status, dbStatus: db.status };
  }
}

// ── Verifying ────────────────────────────────────────────────────────────────

/** The id of the open challenge for this purpose and account, or null. */
export async function openChallenge(purpose: OtpPurpose, email: string | null, userId: string | null): Promise<string | null> {
  const { data, error } = await serviceClient().rpc('otp_open_challenge', {
    p_purpose: purpose,
    p_email: email,
    p_user_id: userId,
  });
  if (error) throw error;
  return typeof data === 'string' && data.length > 0 ? data : null;
}

/** Hashes the typed code for this challenge and lets otp_verify count the attempt. */
export async function verifyOtpCode(
  challengeId: string,
  purpose: OtpPurpose,
  code: string,
  sessionId: string | null,
): Promise<VerifyDbResult> {
  const codeHash = await hmacHex(pepper(), challengeId, code);
  const { data, error } = await serviceClient().rpc('otp_verify', {
    p_challenge_id: challengeId,
    p_purpose: purpose,
    p_code_hash: codeHash,
    p_session_id: purpose === 'platform_login' ? sessionId : null,
  });
  if (error) throw error;
  return asVerifyDbResult(data, purpose);
}

/**
 * A GoTrue session for a user whose code was just verified.
 *
 * generateLink builds a magic-link token without sending anything, and GoTrue's
 * own /verify exchanges its hash for a session. The first step guards the
 * second: the address must belong to exactly the user the challenge named.
 */
export async function issueSession(userId: string, email: string): Promise<OtpSession> {
  const admin = serviceClient();
  const { data: found, error: lookupError } = await admin.auth.admin.getUserById(userId);
  if (lookupError) throw lookupError;
  const accountEmail = found.user?.email?.toLowerCase();
  if (!accountEmail || accountEmail !== email.toLowerCase()) {
    throw new Error('issueSession: the account address does not match the verified challenge');
  }

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email: accountEmail });
  if (linkError) throw linkError;
  if (link.user?.id !== userId) throw new Error('issueSession: generateLink resolved a different user');
  const tokenHash = link.properties?.hashed_token;
  if (!tokenHash) throw new Error('issueSession: generateLink returned no token hash');

  // Exactly these two fields: GoTrue refuses a body with anything more
  // (verify.go:82; probed: 400 "Only the token_hash and type should be
  // provided"). No redirect_to, and no X-Client-IP.
  const response = await fetch(`${requireEnv('SUPABASE_URL')}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: requireEnv('SUPABASE_ANON_KEY'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`issueSession: GoTrue verify answered ${response.status}`);
  }
  return pickSession(await response.json());
}

export interface AuthenticatedCaller {
  userId: string;
  /** The account's current address, lower-cased. */
  email: string;
  sessionId: string | null;
  claims: Record<string, unknown>;
}

/**
 * The signed-in caller of an authenticated purpose, or null for a missing,
 * invalid or revoked token.
 *
 * getUser proves the signature, the user and that the token's session still
 * exists (GoTrue answers session_not_found for a signed-out one). The payload is
 * decoded only after that, never trusted before. A GoTrue outage throws rather
 * than returning null, so it becomes a 500 and not a misleading 401.
 */
export async function verifyAuthenticatedCaller(req: Request): Promise<AuthenticatedCaller | null> {
  const token = bearerToken(req.headers.get('authorization'));
  if (!token) return null;
  const { data, error } = await serviceClient().auth.getUser(token);
  if (error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) return null;
    throw error;
  }
  if (!data.user) return null;
  const claims = decodeJwtPayload(token);
  if (!claims || claims.sub !== data.user.id) return null;
  return {
    userId: data.user.id,
    email: (data.user.email ?? '').toLowerCase(),
    sessionId: typeof claims.session_id === 'string' ? claims.session_id : null,
    claims,
  };
}

/** Best effort: tells the old address that the account's address changed. Never rejects. */
export async function sendEmailChangedNotice(oldEmail: string, newEmail: string, context: LogContext): Promise<void> {
  try {
    const mail = buildEmailChangedNotice({ appUrl: requireEnv('APP_URL'), oldEmail, newEmail, changedAt: new Date() });
    await sendMail({ to: oldEmail, ...mail });
  } catch (err) {
    logFailure('otp', 'email_changed_notice', context, err);
  }
}
