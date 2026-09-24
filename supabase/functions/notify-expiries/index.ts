/**
 * The nightly notification job: TÜV expiries and trial ends.
 *
 * ─── Why this is a function of its own ───────────────────────────────────────
 *
 * The rule is to prefer a route on an existing authenticated function, because
 * a new one costs a line in `PUBLIC_FUNCTIONS`/`FUNCTION_ENV` in
 * `supabase/functions/main/index.ts` and one in `deploy/docker-compose.yml`.
 * Both lines are added with this file.
 *
 * It is a function rather than a route because its authorization is not any
 * existing function's. Every other authenticated function answers a **person**:
 * it resolves `auth.uid()` and asks `platform_can(…)` or the caller's profile.
 * This one answers a **cron line holding the service key**, which has no
 * `auth.uid()` at all — every platform RPC would refuse it. Grafting that onto
 * `platform-staff` or `manage-users` would mean adding a branch to those
 * functions that skips their own authorization, which is worse than a line in
 * two lists.
 *
 * ─── Who may call it ─────────────────────────────────────────────────────────
 *
 * `main/index.ts` verifies that the bearer token was signed by this stack's
 * `JWT_SECRET`. That is authentication, not authorization: **every signed-in
 * customer holds such a token.** So the gate here is that the bearer must be
 * exactly `SUPABASE_SERVICE_ROLE_KEY`, compared in constant time. It is
 * deliberately not "a platform capability", because the caller is a cron line
 * and not a member of the platform team.
 *
 * ─── The dry run is real ─────────────────────────────────────────────────────
 *
 * `{"mode":"dry_run"}` reads the same rows, makes the same decision and builds
 * the same mails, then claims nothing, sends nothing and writes nothing. It is
 * the mode the host cron line is installed with first. **The default is
 * `dry_run`**: a call with no body, or a body that does not parse, reports and
 * sends nothing, so a mistyped cron line cannot mail a customer.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsFor } from '../_shared/http.ts';
import { logFailure } from '../_shared/otp-core.ts';
import { runNotificationJob, type NotificationRunMode } from '../_shared/notification-delivery.ts';

const FN = 'notify-expiries';

/** Constant-time comparison, so a wrong key learns nothing from how long it took. */
function secretEquals(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  // The lengths themselves are not secret; the bytes are.
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

function bearer(req: Request): string | null {
  const header = req.headers.get('Authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

/** `dry_run` for anything that is not exactly `send`. */
async function modeOf(req: Request): Promise<NotificationRunMode> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' && (body as Record<string, unknown>).mode === 'send'
      ? 'send'
      : 'dry_run';
  } catch {
    return 'dry_run';
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) });

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsFor(req), 'Content-Type': 'application/json' },
    });

  if (req.method !== 'POST') {
    return respond({ ok: false, reason: 'method_not_allowed' }, 405);
  }

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const token = bearer(req);
  if (!serviceKey || !token || !secretEquals(token, serviceKey)) {
    // No detail: a caller who is not the job learns only that it is not.
    return respond({ ok: false, reason: 'not_authorized' }, 403);
  }

  const mode = await modeOf(req);

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      serviceKey,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const report = await runNotificationJob(admin, mode);
    // The run's shape, for the cron line's log. No address appears in it.
    console.log(JSON.stringify({
      level: 'info', fn: FN, step: 'run', mode,
      companies_scanned: report.companies_scanned, planned: report.planned,
      sent: report.sent, no_recipients: report.no_recipients,
      already_claimed: report.already_claimed, send_failed: report.send_failed,
      lookup_failed: report.lookup_failed,
    }));
    return respond({ ok: true, ...report });
  } catch (err) {
    logFailure(FN, 'run', { purpose: 'notifications', mode }, err);
    return respond({ ok: false, reason: 'run_failed' }, 500);
  }
});
