/**
 * POST /functions/v1/platform-staff/email-change
 *
 *   {"new_email":"neu@example.com"}      with Authorization
 *
 * A platform account changes its **own** address with its current password and
 * no emailed code (the owner's decision of 17.09.2026). Company users keep the
 * code exactly as it is: they never reach this route, and otp-request /
 * otp-verify are untouched.
 *
 * ## Why this lives on platform-staff
 *
 * It needs a verified session, so it must not be a `PUBLIC_FUNCTIONS` entry,
 * and every new function costs a line in `PUBLIC_FUNCTIONS`/`FUNCTION_ENV` in
 * supabase/functions/main/index.ts and one in deploy/docker-compose.yml.
 * `platform-staff` is already the authenticated function for platform accounts
 * and already receives exactly the environment this route needs: the service
 * role (GoTrue admin + the two RPCs) and SMTP (the notice to the old address).
 *
 * It is matched **before** `resolvePlatformStaffRoute`, and is not a row in
 * that table, because that table pairs a route with a capability and an action
 * `app_private.platform_edge_audit_actions()` must list. This route needs no
 * capability — changing your own address is a fact about your own account, not
 * a platform right, so a `read_only` account may do it — and its audit row is
 * written by the database under an action `platform_audit_record` must go on
 * refusing.
 *
 * ## The order of refusals, and why it is that order
 *
 * 1. `unauthorized`      — no session, or one GoTrue no longer knows.
 * 2. the account's standing, asked before the session is looked at because the
 *    answer must not depend on how the caller signed in:
 *    `not_platform_account` (no **active** staff row — a company user keeps the
 *    code path), `account_blocked` (banned or deleted in GoTrue, the
 *    containment lever that must work even while an issued token is still
 *    valid), `no_account`.
 * 3. `reauth_required`   — the session's amr names no fresh re-authentication
 *    inside PASSWORD_PROOF_MAX_AGE_SECONDS. With the code gone this is the only
 *    proof that the person at the keyboard knows the password.
 * 4. the request itself: `rate_limited` (five completed changes this hour),
 *    `same_email`, `email_taken`.
 *
 * Steps 2 and 4 are one round trip: `platform_self_email_change_check` answers
 * both in one snapshot, and its verdicts are reported in the order above.
 *
 * ## The audit fails closed
 *
 * `auditedPlatformWrite()`'s shape, in `_shared/platform-access.ts`: an
 * `attempt` row before GoTrue is asked to move the address — and the route
 * answers 500 `audit_unavailable` without moving it when that row cannot be
 * written — then `ok` or `error` afterwards, best-effort, because by then the
 * change has happened or failed and a 500 would report a failure that did not
 * occur.
 *
 * Afterwards the same "your address changed" notice goes to the **old** address
 * the code path sends, which is what makes a mistyped address visible to
 * someone who can still read the old mailbox.
 */
import {
  otpResponse,
  runAfterResponse,
  sendEmailChangedNotice,
  serviceClient,
  verifyAuthenticatedCaller,
} from '../_shared/otp.ts';
import {
  internalError,
  invalidRequest,
  isEmailTakenOnUpdate,
  logFailure,
  methodNotAllowed,
  newRequestId,
  readBodyText,
  reauthRequired,
  unauthorized,
  emailTaken as emailTakenReply,
  type HttpReply,
} from '../_shared/otp-core.ts';
import {
  asCheckResult,
  auditUnavailable,
  checkResultReply,
  emailChanged,
  isAccountStanding,
  parseEmailChangeBody,
  reauthProofState,
} from '../_shared/platform-email-change.ts';

const FN = 'platform-staff';
const STEP = 'email-change';

export async function changeOwnPlatformEmail(req: Request, allowed: boolean): Promise<Response> {
  if (!allowed) return otpResponse(req, methodNotAllowed());

  const text = await readBodyText(req).catch(() => null);
  const input = text === null ? null : parseEmailChangeBody(text);
  if (!input) return otpResponse(req, invalidRequest());

  return otpResponse(req, await changeEmail(req, input.newEmail, newRequestId()));
}

async function changeEmail(req: Request, newEmail: string, requestId: string): Promise<HttpReply> {
  let step = 'authenticate';
  let userId: string | undefined;
  try {
    // 1. The caller comes from the bearer token, never from the body. getUser
    //    proves the signature, the account and that the session still exists.
    const caller = await verifyAuthenticatedCaller(req);
    if (!caller) return unauthorized();
    userId = caller.userId;

    // 2 and 4, in one snapshot. The address was normalised and shape-checked
    //    above, so a 22023 here is a contract break, not a typed address.
    step = 'check';
    const { data, error } = await serviceClient().rpc('platform_self_email_change_check', {
      p_user_id: caller.userId,
      p_new_email: newEmail,
    });
    if (error) throw error;
    const check = asCheckResult(data);

    // 2. The account's standing, before the session is looked at: a company
    //    user keeps the code path, and a banned or deleted account is refused,
    //    whatever either one's session looks like.
    if (isAccountStanding(check)) return checkResultReply(check)!;

    // 3. The password proof. This is the control the emailed code did not
    //    provide and does not replace: the code went to the *new* address,
    //    which whoever asks has already chosen. Do not relax this.
    if (reauthProofState(caller.claims, Math.floor(Date.now() / 1000)) !== 'fresh') {
      return reauthRequired();
    }

    // 4. The hourly cap and the address itself.
    const refusal = checkResultReply(check);
    if (refusal) return refusal;

    // The attempt row, before anything moves. This is what makes the audit fail
    // closed: an address the log cannot record is an address that does not
    // change. The outcome row below is the best-effort half, exactly as in
    // _shared/platform-access.ts's auditedPlatformWrite().
    step = 'audit_attempt';
    if (!(await record(caller, newEmail, 'attempt', requestId))) return auditUnavailable();

    // The same admin update the code path applies (otp-verify's
    // completeEmailChange): no mail from GoTrue, no pending change, and the
    // address live at once. user_profiles.email follows through the
    // sync_user_profile_email trigger.
    step = 'apply';
    const { error: updateError } = await serviceClient().auth.admin.updateUserById(caller.userId, {
      email: newEmail,
      email_confirm: true,
    });
    if (updateError) {
      await record(caller, newEmail, 'error', requestId);
      // The check above closed the ordinary case. This catches a registration
      // that landed between the two — but only when GoTrue names the refusal:
      // v2.170.0 answers a taken address on update with a 500 "Error updating
      // user" that cannot be told from any other failed update (otp-core.ts's
      // isEmailTakenOnUpdate says so), so that race ends as `internal`, not as
      // `email_taken`. The caller's next attempt gets the check's own verdict.
      if (isEmailTakenOnUpdate(updateError)) return emailTakenReply();
      throw updateError;
    }

    // The outcome row. Best effort by necessity: the address has already moved,
    // so answering 500 would report a failure that did not happen and send the
    // user into a retry loop against their own new address. The attempt row
    // above is already in the log, so a lost outcome leaves a trace of what was
    // being attempted rather than nothing at all.
    step = 'audit_outcome';
    await record(caller, newEmail, 'ok', requestId);

    // Best effort, as on the code path: the old mailbox learns what happened.
    const notice = sendEmailChangedNotice(caller.email, newEmail, {
      request_id: requestId,
      purpose: 'email_change',
      user_id: caller.userId,
    });
    if (!runAfterResponse(notice)) await notice;

    return emailChanged(newEmail);
  } catch (err) {
    logFailure(FN, `${STEP}_${step}`, { request_id: requestId, purpose: 'email_change', user_id: userId }, err);
    return internalError(requestId);
  }
}

/**
 * Writes one audit row and says whether it landed. Never rejects, so the caller
 * decides what a lost row means: fatal for `attempt`, logged for the rest.
 *
 * A NULL answer means the database saw no active staff row for an account this
 * route had just accepted as one, which is no more a reason to go on than a
 * failed call.
 */
async function record(
  caller: { userId: string; email: string; sessionId: string | null },
  newEmail: string,
  outcome: 'attempt' | 'ok' | 'error',
  requestId: string,
): Promise<boolean> {
  try {
    const { data, error } = await serviceClient().rpc('platform_self_email_change_record', {
      p_user_id: caller.userId,
      p_old_email: caller.email,
      p_new_email: newEmail,
      p_outcome: outcome,
      p_session_id: caller.sessionId,
    });
    if (error) throw error;
    if (data === null || data === undefined) {
      throw new Error('platform_self_email_change_record wrote no row');
    }
    return true;
  } catch (err) {
    logFailure(FN, `${STEP}_audit_${outcome}`, { request_id: requestId, purpose: 'email_change', user_id: caller.userId }, err);
    return false;
  }
}
