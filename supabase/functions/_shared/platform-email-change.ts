/**
 * The pure half of `POST /platform-staff/email-change`: a platform account
 * changes its own email address with its current password and no code (the
 * owner's decision of 17.09.2026). Company users keep the one-time code, and
 * nothing here touches otp-request or otp-verify.
 *
 * Why the code could go, and what has to stay:
 *
 * The `email_change` code is mailed to the **new** address, so it proves
 * control of that mailbox and nothing about the account — an attacker at an
 * unattended signed-in browser chooses the new address and reads their own
 * code. What stops that attacker is the other half, `otp-request`'s rule that
 * the session's `amr` claim must name a **password** sign-in no older than
 * `PASSWORD_PROOF_MAX_AGE_SECONDS`. `passwordProofState` below is that same
 * rule, reading the same constant and the same `passwordAmrAgeSeconds`, and it
 * is now the only proof that the person at the keyboard knows the password.
 * Loosening it turns this route into account takeover from an open tab.
 *
 * This route is deliberately **not** a row in `PLATFORM_STAFF_ROUTES`. That
 * table pairs a route with a capability and an action the database accepts in
 * `app_private.platform_edge_audit_actions()`; this one needs no capability
 * (changing your own address is not a platform right, it is a fact about your
 * own account) and its audit row is written by the database itself, under an
 * action `platform_audit_record` must go on refusing.
 *
 * Pure: no Deno, npm: or jsr: imports, so vitest runs it under Node.
 */
import {
  emailTaken,
  parseEmail,
  parseJsonObject,
  PASSWORD_PROOF_MAX_AGE_SECONDS,
  passwordAmrAgeSeconds,
  type HttpReply,
} from './otp-core.ts';

/** The last path segment this route answers on. */
export const PLATFORM_EMAIL_CHANGE_SEGMENT = 'email-change';

export type RouteMatch = 'match' | 'method_not_allowed' | 'no_match';

/**
 * Whether a request is for this route.
 *
 * Matched on the **last** path segment rather than with `includes()`, the way
 * the older route tables match: `/platform-staff/email-change` is this route,
 * `/platform-staff/email-change/other` is not, and no other platform-staff
 * segment can be read as this one. A wrong method on the right path is
 * `method_not_allowed`, not `no_match`, so it never falls through to the
 * capability-gated table below it.
 */
export function matchPlatformEmailChangeRoute(method: string, pathname: string): RouteMatch {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[segments.length - 1] !== PLATFORM_EMAIL_CHANGE_SEGMENT) return 'no_match';
  return method === 'POST' ? 'match' : 'method_not_allowed';
}

export interface EmailChangeInput {
  /** Trimmed, lower-cased and shape-checked. */
  newEmail: string;
}

/**
 * The request body. Unknown fields are ignored; anything invalid is null, which
 * the route answers with 400 invalid_request.
 *
 * Note what is **not** in it: the password. The browser spends it on
 * `signInWithPassword` against the current address, which is what mints the
 * fresh password session this route then demands. Sending the password here as
 * well would put it through a second service for no extra proof.
 */
export function parseEmailChangeBody(text: string): EmailChangeInput | null {
  const body = parseJsonObject(text);
  if (!body) return null;
  const newEmail = parseEmail(body.new_email);
  return newEmail ? { newEmail } : null;
}

export type PasswordProofState = 'fresh' | 'stale' | 'absent';

/**
 * How the caller's session was established, as this route cares about it.
 *
 * `absent` — no password sign-in in the token's `amr` at all (an OTP session
 * from a password reset, or a session Google minted).
 * `stale`  — a password sign-in older than the window.
 * `fresh`  — a password sign-in inside the window; the only state that passes.
 *
 * Both failures are reported as `reauth_required`: telling them apart would
 * tell a holder of a stolen token which kind it holds.
 */
export function passwordProofState(claims: Record<string, unknown>, nowSec: number): PasswordProofState {
  const age = passwordAmrAgeSeconds(claims, nowSec);
  if (age === null) return 'absent';
  return age <= PASSWORD_PROOF_MAX_AGE_SECONDS ? 'fresh' : 'stale';
}

export const CHECK_RESULTS = [
  'ok',
  'not_platform_account',
  'no_account',
  // Banned or deleted in GoTrue. GoTrue does not revoke an issued access token
  // when an account is banned, so without this the obvious containment lever —
  // ban the compromised account — would not stop it moving its own address for
  // the rest of the password window.
  'account_blocked',
  // Five completed changes in the last hour. Not aimed at a stranger, who
  // cannot reach the route: it bounds an insider loop that would mail the
  // change notice from the product's domain at request rate.
  'rate_limited',
  'same_email',
  'email_taken',
] as const;

export type CheckResult = (typeof CHECK_RESULTS)[number];

/**
 * `platform_self_email_change_check`'s answer, checked. A value outside the
 * list means the migration and this file disagree, which is a 500 and not a
 * refusal — exactly as `asIssueDbResult` treats an unknown status.
 */
export function asCheckResult(raw: unknown): CheckResult {
  if (typeof raw === 'string' && (CHECK_RESULTS as readonly string[]).includes(raw)) {
    return raw as CheckResult;
  }
  throw new Error('platform_self_email_change_check returned a result outside the contract');
}

/** 403: the caller has no active platform staff row, so it keeps the code path. */
export const notPlatformAccount = (): HttpReply =>
  ({ status: 403, body: { ok: false, reason: 'not_platform_account' } });

/** 400: already the account's address. The same reason otp-request answers. */
export const sameEmail = (): HttpReply =>
  ({ status: 400, body: { ok: false, reason: 'same_email' } });

/** 404: the id has no account, or no address on it. */
export const noAccount = (): HttpReply =>
  ({ status: 404, body: { ok: false, reason: 'no_account' } });

/** 403: banned or deleted in GoTrue, whatever the staff row still says. */
export const accountBlocked = (): HttpReply =>
  ({ status: 403, body: { ok: false, reason: 'account_blocked' } });

/** 429: the per-account hourly cap on completed changes. */
export const rateLimited = (): HttpReply =>
  ({ status: 429, body: { ok: false, reason: 'rate_limited' } });

/** 500: the audit row that must precede the change could not be written. */
export const auditUnavailable = (): HttpReply =>
  ({ status: 500, body: { ok: false, reason: 'audit_unavailable' } });

export const emailChanged = (email: string): HttpReply =>
  ({ status: 200, body: { ok: true, email } });

/**
 * Whether a verdict is about the account's standing rather than the request.
 *
 * These three are reported **before** the freshness test, so the answer "this
 * account may not use this route at all" never depends on how the caller signed
 * in: a company user is always told to use the code path, and a banned or
 * deleted account is always refused. Everything else — the hourly cap, the
 * address itself — is about the request and is reported after it, so a caller
 * holding a stale token learns nothing about the account's history.
 */
export function isAccountStanding(result: CheckResult): boolean {
  return result === 'not_platform_account' || result === 'account_blocked' || result === 'no_account';
}

/**
 * The check's refusal as HTTP, or null for `ok`.
 *
 * Every shape matches the code path's, so `email_taken` reads identically
 * whichever route produced it.
 */
export function checkResultReply(result: CheckResult): HttpReply | null {
  switch (result) {
    case 'ok':
      return null;
    case 'not_platform_account':
      return notPlatformAccount();
    case 'no_account':
      return noAccount();
    case 'account_blocked':
      return accountBlocked();
    case 'rate_limited':
      return rateLimited();
    case 'same_email':
      return sameEmail();
    case 'email_taken':
      return emailTaken();
  }
}
