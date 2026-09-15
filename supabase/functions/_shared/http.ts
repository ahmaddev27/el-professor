/**
 * Shared response handling for the edge functions.
 *
 * Two things every function got wrong in the same way.
 *
 * **CORS was `*`.** Harmless while every route demanded a JWT, less so now that
 * company-signup is deliberately public. The allow-list is built from APP_URL,
 * which the compose file already defines, so the browser origin is the only one
 * that gets a permissive header back.
 *
 * Note where the *browser* preflight is actually answered: **Kong**, not here.
 * Its `cors` plugin replies to OPTIONS itself and the request never reaches the
 * edge runtime, so an origin list written only in this file changes nothing a
 * browser sees — that cost an afternoon of chasing a `*` that was being emitted
 * two layers up. `deploy/kong.yml` carries the same list, and the two have to
 * be changed together. This function still matters for every non-preflight
 * response and for any caller that does not go through Kong.
 *
 * **`err.message` went to the browser verbatim.** That is right for a
 * validation message the user is meant to read and wrong for anything else: a
 * Postgres error names columns and constraints, and these functions hold the
 * service-role key. The two are told apart by type, not by inspecting the
 * string — throw `UserError` when the text is for the user, throw anything else
 * and the caller gets a fixed sentence while the detail goes to the log with a
 * request id to match them up.
 */

/**
 * An error whose message is written for the end user and may be returned as-is.
 *
 * `reason` is a stable code for the client to branch on, so no screen has to
 * match German text. `extra` carries further fields such as
 * retry_after_seconds. Both go into the response body next to the message.
 */
export class UserError extends Error {
  readonly status: number;
  readonly reason?: string;
  readonly extra?: Record<string, unknown>;
  constructor(message: string, status = 400, reason?: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'UserError';
    this.status = status;
    this.reason = reason;
    this.extra = extra;
  }
}

const ALLOWED_ORIGINS = (() => {
  const app = Deno.env.get('APP_URL')?.replace(/\/$/, '');
  const extra = (Deno.env.get('EXTRA_CORS_ORIGINS') ?? '')
    .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  return new Set([app, ...extra].filter(Boolean) as string[]);
})();

/**
 * CORS headers for this request.
 *
 * An origin we do not know gets no allow-origin header at all, which is what
 * makes the browser refuse the response. Requests without an Origin header —
 * curl, server-to-server — are unaffected: CORS is a browser rule, not an
 * authorization one, and every route still does its own auth.
 */
export function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get('origin')?.replace(/\/$/, '');
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
    'Vary': 'Origin',
  };
  // With no list configured, fall back to the old behaviour rather than
  // breaking every function the moment APP_URL is missing.
  if (ALLOWED_ORIGINS.size === 0) return { ...base, 'Access-Control-Allow-Origin': '*' };
  if (origin && ALLOWED_ORIGINS.has(origin)) return { ...base, 'Access-Control-Allow-Origin': origin };
  return base;
}

export function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsFor(req), 'Content-Type': 'application/json' },
  });
}

/**
 * Turn a thrown value into a response.
 *
 * A UserError keeps its text. Anything else is logged with a request id and
 * answered with a sentence that says nothing about the implementation — the id
 * is what ties the two together when someone reports it.
 */
export function errorResponse(req: Request, err: unknown, fn: string): Response {
  if (err instanceof UserError) {
    return json(req, err.status, {
      ...err.extra,
      success: false,
      error: err.message,
      ...(err.reason ? { reason: err.reason } : {}),
    });
  }
  const requestId = crypto.randomUUID().slice(0, 8);
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(JSON.stringify({ level: 'error', fn, requestId, detail }));
  return json(req, 500, {
    success: false,
    error: 'Es ist ein interner Fehler aufgetreten. Bitte versuchen Sie es erneut.',
    request_id: requestId,
  });
}
