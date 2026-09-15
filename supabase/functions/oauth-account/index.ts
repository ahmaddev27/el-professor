/**
 * POST /functions/v1/oauth-account: settle the caller's own account after a Google sign-in.
 *
 *   {"action":"reconcile"}      after every Google sign-in: cancels a password
 *                               signup Google has just confirmed, or accepts a
 *                               pending invitation
 *   {"action":"register", ...}  registers the company of a new Google account
 *   {"action":"discard"}        deletes a Google account that registered no company
 *
 * Not in PUBLIC_FUNCTIONS: the router verifies the token's signature, and
 * verifyAuthenticatedCaller asks GoTrue whether its session still exists. Every
 * RPC receives that session's user id; nothing in the body can name another.
 * The RPCs are service_role only and make every decision
 * (supabase/migrations/20260916100020_oauth_signup_rpcs.sql). The body, the
 * mapping and the wire contract live in _shared/oauth-account-core.ts, where
 * vitest covers them.
 *
 * Nothing calls this before the Google button ships, and Google sign-in stays
 * off until GOOGLE_SIGNIN_ENABLED=true. No address, code or token is logged.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsFor } from '../_shared/http.ts';
import { otpResponse, serviceClient, verifyAuthenticatedCaller } from '../_shared/otp.ts';
import {
  internalError,
  invalidRequest,
  methodNotAllowed,
  newRequestId,
  readBodyText,
  unauthorized,
} from '../_shared/otp-core.ts';
import {
  logOauthFailure,
  parseOauthAccountRequest,
  runOauthAccountAction,
  type OauthLogContext,
} from '../_shared/oauth-account-core.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) });
  if (req.method !== 'POST') return otpResponse(req, methodNotAllowed());

  const context: OauthLogContext = { request_id: newRequestId() };
  let step = 'read_body';
  try {
    const text = await readBodyText(req).catch(() => null);
    if (text === null) return otpResponse(req, invalidRequest());
    const parsed = parseOauthAccountRequest(text);
    if ('reply' in parsed) return otpResponse(req, parsed.reply);
    context.action = parsed.input.action;

    step = 'authenticate';
    const caller = await verifyAuthenticatedCaller(req);
    if (!caller) return otpResponse(req, unauthorized());
    context.user_id = caller.userId;

    step = parsed.input.action;
    const reply = await runOauthAccountAction(parsed.input, caller.userId, (fn, args) => serviceClient().rpc(fn, args));
    return otpResponse(req, reply);
  } catch (err) {
    logOauthFailure(step, context, err);
    return otpResponse(req, internalError(context.request_id));
  }
});
