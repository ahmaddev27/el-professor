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
 * 1. `unauthorized`         — no session, or one GoTrue no longer knows.
 * 2. `not_platform_account` — no **active** staff row. A company user is told
 *    this whatever its session looks like, so it is asked before the session
 *    test: the answer "use the code" must not depend on how you signed in.
 * 3. `reauth_required`      — the session's amr does not name a password
 *    sign-in inside PASSWORD_PROOF_MAX_AGE_SECONDS. With the code gone this is
 *    the only proof that the person at the keyboard knows the password.
 * 4. `same_email` / `email_taken` / `no_account` — the address itself.
 *
 * Steps 2 and 4 are one round trip: `platform_self_email_change_check` answers
 * both in one snapshot, and its verdicts are reported in the order above.
 *
 * ## After the change
 *
 * One audit row (`auth` / `auth.platform_email_change`), written by the
 * database, and the same "your address changed" notice to the **old** address
 * the code path sends — which is what makes a mistyped address visible to
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
  checkResultReply,
  emailChanged,
  notPlatformAccount,
  parseEmailChangeBody,
  passwordProofState,
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

    // 2. A company user keeps the code path, whatever its session looks like.
    if (check === 'not_platform_account') return notPlatformAccount();

    // 3. The password proof. This is the control the emailed code did not
    //    provide and does not replace: the code went to the *new* address,
    //    which whoever asks has already chosen. Do not relax this.
    if (passwordProofState(caller.claims, Math.floor(Date.now() / 1000)) !== 'fresh') {
      return reauthRequired();
    }

    // 4. The address itself.
    const refusal = checkResultReply(check);
    if (refusal) return refusal;

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
      // The check above closed the ordinary case; this catches a registration
      // that landed between the two.
      if (isEmailTakenOnUpdate(updateError)) return emailTakenReply();
      throw updateError;
    }

    // The one audit row. Best effort by necessity: the address has already
    // moved, so answering 500 would report a failure that did not happen and
    // send the user into a retry loop against their own new address. A row
    // that could not be written is logged loudly instead, with the request id.
    step = 'audit';
    await recordChange(caller.userId, caller.email, newEmail, caller.sessionId, requestId);

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

/** Never rejects: the change has already happened by the time this is called. */
async function recordChange(
  userId: string,
  oldEmail: string,
  newEmail: string,
  sessionId: string | null,
  requestId: string,
): Promise<void> {
  const context = { request_id: requestId, purpose: 'email_change', user_id: userId };
  try {
    const { data, error } = await serviceClient().rpc('platform_self_email_change_record', {
      p_user_id: userId,
      p_old_email: oldEmail,
      p_new_email: newEmail,
      p_session_id: sessionId,
    });
    if (error) throw error;
    // NULL means the database saw no active staff row for an account this route
    // had just accepted as one. The change stands; the log is the only place it
    // can still be noticed.
    if (data === null || data === undefined) {
      throw new Error('platform_self_email_change_record wrote no row');
    }
  } catch (err) {
    logFailure(FN, `${STEP}_audit_lost`, context, err);
  }
}
