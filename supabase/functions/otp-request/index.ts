/**
 * POST /functions/v1/otp-request: send a one-time code.
 *
 *   {"purpose":"password_reset"|"signup_verify"|"invite_activate", "email":"a@b.de"}
 *   {"purpose":"email_change", "new_email":"neu@b.de"}    with Authorization
 *   {"purpose":"platform_login"}                          with Authorization
 *
 * Listed in PUBLIC_FUNCTIONS because the first three are asked for before anyone
 * is signed in. The other two verify the bearer token here.
 *
 * The public purposes give one answer, 202, whether the address has an account,
 * is not eligible, is cooling down, or the mail failed; and never sooner than
 * 1.5 s after the request arrived, with the send itself finishing after the
 * response. Only the per-IP limit shows, because it is the same for every
 * address. Nothing here creates an account: an unknown address stops inside
 * otp_issue.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsFor } from '../_shared/http.ts';
import { deliverOtp, issueOtp, otpResponse, runAfterResponse, verifyAuthenticatedCaller } from '../_shared/otp.ts';
import {
  internalError,
  invalidRequest,
  logFailure,
  mapIssueToHttp,
  methodNotAllowed,
  newRequestId,
  padElapsed,
  parseClientIp,
  parseOtpRequest,
  PASSWORD_PROOF_MAX_AGE_SECONDS,
  reauthProofAgeSeconds,
  PUBLIC_RESPONSE_FLOOR_MS,
  readBodyText,
  reauthRequired,
  unauthorized,
  type HttpReply,
  type OtpRequestInput,
} from '../_shared/otp-core.ts';

const FN = 'otp-request';

type PublicRequest = Extract<OtpRequestInput, { email: string }>;
type AuthenticatedRequest = Exclude<OtpRequestInput, { email: string }>;

Deno.serve(async (req: Request) => {
  const startedAt = Date.now();
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) });
  if (req.method !== 'POST') return otpResponse(req, methodNotAllowed());

  const text = await readBodyText(req).catch(() => null);
  const input = text === null ? null : parseOtpRequest(text);
  if (!input) return otpResponse(req, invalidRequest());

  const requestId = newRequestId();
  const clientIp = parseClientIp(req.headers.get('x-client-ip'));

  if ('email' in input) {
    const reply = await requestPublicCode(input, clientIp, requestId);
    await padElapsed(startedAt, PUBLIC_RESPONSE_FLOOR_MS);
    return otpResponse(req, reply);
  }
  return otpResponse(req, await requestAuthenticatedCode(req, input, clientIp, requestId));
});

async function requestPublicCode(input: PublicRequest, clientIp: string | null, requestId: string): Promise<HttpReply> {
  try {
    const issued = await issueOtp({ purpose: input.purpose, email: input.email, clientIp });
    if (issued.db.status === 'issued') {
      const delivery = deliverOtp({
        purpose: input.purpose,
        issued,
        accountEmail: issued.db.recipient_email,
        requestId,
      });
      if (!runAfterResponse(delivery)) await delivery;
    }
    return mapIssueToHttp('public', issued.db);
  } catch (err) {
    logFailure(FN, 'issue', { request_id: requestId, purpose: input.purpose }, err);
    return internalError(requestId);
  }
}

async function requestAuthenticatedCode(
  req: Request,
  input: AuthenticatedRequest,
  clientIp: string | null,
  requestId: string,
): Promise<HttpReply> {
  let userId: string | undefined;
  let step = 'authenticate';
  try {
    const caller = await verifyAuthenticatedCaller(req);
    if (!caller) return unauthorized();
    userId = caller.userId;

    let newEmail: string | null = null;
    let sessionId: string | null = null;
    if (input.purpose === 'email_change') {
      // A browser left signed in must not be able to move the account to
      // another address: the change needs a password or passkey sign-in from
      // the last ten minutes, which the client produces right before asking.
      const age = reauthProofAgeSeconds(caller.claims, Math.floor(Date.now() / 1000));
      if (age === null || age > PASSWORD_PROOF_MAX_AGE_SECONDS) return reauthRequired();
      newEmail = input.newEmail;
    } else {
      if (!caller.sessionId) return unauthorized();
      sessionId = caller.sessionId;
    }

    step = 'issue';
    const issued = await issueOtp({ purpose: input.purpose, userId: caller.userId, newEmail, sessionId, clientIp });
    const mail = issued.db.status === 'issued'
      ? await deliverOtp({ purpose: input.purpose, issued, accountEmail: caller.email, newEmail, requestId })
      : undefined;
    return mapIssueToHttp('authenticated', issued.db, mail);
  } catch (err) {
    logFailure(FN, step, { request_id: requestId, purpose: input.purpose, user_id: userId }, err);
    return internalError(requestId);
  }
}
