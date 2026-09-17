/**
 * POST /functions/v1/otp-verify: check a one-time code and finish its purpose.
 *
 *   {"purpose":"signup_verify"|"password_reset"|"invite_activate", "email":"a@b.de", "code":"123456"}
 *   {"purpose":"email_change", "code":"123456"}      with Authorization
 *   {"purpose":"platform_login", "code":"123456"}    with Authorization
 *
 * Listed in PUBLIC_FUNCTIONS because the first three are verified before anyone
 * is signed in. The other two verify the bearer token here.
 *
 * otp_verify counts the attempt and consumes a matching code in the same
 * transaction, before anything below runs. If a later step fails, the code is
 * spent and the answer is 502 session_failed: the user asks for a new one. That
 * is the safe direction; the alternative is a code that works twice.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsFor } from '../_shared/http.ts';
import {
  issueSession,
  openChallenge,
  otpResponse,
  runAfterResponse,
  sendEmailChangedNotice,
  serviceClient,
  verifyAuthenticatedCaller,
  verifyOtpCode,
} from '../_shared/otp.ts';
import {
  challengeNotFound,
  emailTaken,
  internalError,
  invalidRequest,
  isEmailTakenOnUpdate,
  logFailure,
  mapVerifyToHttp,
  methodNotAllowed,
  newRequestId,
  parseOtpVerify,
  readBodyText,
  sessionFailed,
  unauthorized,
  type HttpReply,
  type LogContext,
  type OtpVerifyInput,
  type VerifyOkDbResult,
} from '../_shared/otp-core.ts';

const FN = 'otp-verify';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) });
  if (req.method !== 'POST') return otpResponse(req, methodNotAllowed());

  const text = await readBodyText(req).catch(() => null);
  const input = text === null ? null : parseOtpVerify(text);
  if (!input) return otpResponse(req, invalidRequest());

  return otpResponse(req, await verify(req, input, newRequestId()));
});

async function verify(req: Request, input: OtpVerifyInput, requestId: string): Promise<HttpReply> {
  let step = 'authenticate';
  let userId: string | undefined;
  try {
    let challengeId: string | null;
    let sessionId: string | null = null;
    if ('email' in input) {
      step = 'open_challenge';
      challengeId = await openChallenge(input.purpose, input.email, null);
    } else {
      const caller = await verifyAuthenticatedCaller(req);
      if (!caller) return unauthorized();
      userId = caller.userId;
      sessionId = caller.sessionId;
      if (input.purpose === 'platform_login' && !sessionId) return unauthorized();
      step = 'open_challenge';
      challengeId = await openChallenge(input.purpose, null, caller.userId);
    }
    if (!challengeId) return challengeNotFound();

    step = 'verify';
    const result = await verifyOtpCode(challengeId, input.purpose, input.code, sessionId);
    if (result.status !== 'ok') return mapVerifyToHttp(result) ?? internalError(requestId);

    return await complete(result, requestId);
  } catch (err) {
    logFailure(FN, step, { request_id: requestId, purpose: input.purpose, user_id: userId }, err);
    return internalError(requestId);
  }
}

/** The code is consumed. Any failure from here on is 502 session_failed. */
async function complete(ok: VerifyOkDbResult, requestId: string): Promise<HttpReply> {
  try {
    switch (ok.purpose) {
      case 'signup_verify':
        return await completeSignup(ok, requestId);
      case 'password_reset':
      case 'invite_activate':
        // The profile of an invited user stays pending_invite: SetPasswordPage
        // activates it once a password is set, as it always has.
        return {
          status: 200,
          body: { ok: true, purpose: ok.purpose, next: 'set_password', session: await issueSession(ok.user_id, ok.email) },
        };
      case 'email_change':
        return await completeEmailChange(ok, requestId);
      case 'platform_login':
        return { status: 200, body: { ok: true, purpose: ok.purpose, verified_until: ok.platform_verified_until } };
    }
    throw new Error('otp_verify returned an unknown purpose');
  } catch (err) {
    logFailure(FN, `complete_${ok.purpose}`, { request_id: requestId, purpose: ok.purpose, user_id: ok.user_id }, err);
    return sessionFailed(requestId);
  }
}

async function completeSignup(ok: VerifyOkDbResult, requestId: string): Promise<HttpReply> {
  // Confirm first: signup_complete refuses an unconfirmed account, and GoTrue
  // refuses a password login until this is set.
  const { error: confirmError } = await serviceClient().auth.admin.updateUserById(ok.user_id, { email_confirm: true });
  if (confirmError) throw confirmError;
  const completion = await runSignupComplete(ok.user_id, { request_id: requestId, purpose: ok.purpose, user_id: ok.user_id });
  const session = await issueSession(ok.user_id, ok.email);
  const discount = (completion as { discount?: unknown } | null)?.discount ?? null;
  return { status: 200, body: { ok: true, purpose: 'signup_verify', next: 'app', session, discount } };
}

/**
 * signup_complete, called a second time if the first call fails.
 *
 * The address is confirmed by now, and otp_issue issues signup codes only for
 * unconfirmed addresses, so a lost call would leave the owner confirmed with a
 * pending profile and no code to finish with. The function is idempotent: if
 * the first call committed after all, the second answers already_completed.
 */
async function runSignupComplete(userId: string, context: LogContext): Promise<unknown> {
  const first = await serviceClient().rpc('signup_complete', { p_user_id: userId });
  if (!first.error) return first.data;
  logFailure(FN, 'signup_complete_retry', context, first.error);
  const second = await serviceClient().rpc('signup_complete', { p_user_id: userId });
  if (second.error) throw second.error;
  return second.data;
}

async function completeEmailChange(ok: VerifyOkDbResult, requestId: string): Promise<HttpReply> {
  if (!ok.new_email) throw new Error('otp_verify returned email_change without new_email');
  // An admin update sends no mail and leaves no pending change: the address is
  // live at once, which is correct because the new mailbox just proved itself.
  const { error } = await serviceClient().auth.admin.updateUserById(ok.user_id, { email: ok.new_email, email_confirm: true });
  if (error) {
    if (isEmailTakenOnUpdate(error)) return emailTaken();
    throw error;
  }
  // user_profiles.email follows through the sync_user_profile_email trigger.
  const notice = sendEmailChangedNotice(ok.email, ok.new_email, {
    request_id: requestId,
    purpose: ok.purpose,
    user_id: ok.user_id,
  });
  if (!runAfterResponse(notice)) await notice;
  return { status: 200, body: { ok: true, purpose: 'email_change', email: ok.new_email } };
}
