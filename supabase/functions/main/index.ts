/**
 * Edge-runtime router.
 *
 * `supabase/edge-runtime` serves one "main" worker that dispatches to the real
 * functions by the first path segment: a request for /manage-users/list runs
 * ../manage-users/index.ts. This file is that dispatcher; it is not itself an
 * application function and the client never calls it directly.
 *
 * ## Why the JWT is verified here
 *
 * Hosted Supabase applies `verify_jwt` per function from the dashboard — a
 * setting nobody can diff and nothing in git records. Self-hosted, the check
 * belongs somewhere in version control, and this is the only place every
 * request passes through.
 *
 * `PUBLIC_FUNCTIONS` names the exceptions, and the reason for each is written
 * beside it. Everything else needs a session. A function added later that must
 * be public has to be listed there, in a commit, with its reason.
 *
 * CORS is decided here too: the browser's preflight never reaches the target
 * function, so the allow-list in _shared/http.ts has to be applied by the
 * dispatcher or OPTIONS would always answer `*`.
 *
 * Verification here is authentication, not authorization: it proves the caller
 * holds a token this stack signed. Each function still loads the caller's
 * profile and checks role, tenancy and target — see the assertSameCompany()
 * pattern in manage-users.
 *
 * ## Why each worker gets a written list of environment variables
 *
 * This process holds the whole container environment, JWT_SECRET included. It
 * used to hand all of it to every worker, and with it SUPABASE_DB_URL, a
 * superuser connection string no function ever read. A bug in any function,
 * or a dependency it pulls from npm, could read either. `FUNCTION_ENV` now
 * names exactly what each function receives, and a function with no entry is
 * not started at all, so adding one forces a decision in a commit.
 */
import * as jose from 'https://deno.land/x/jose@v4.14.4/index.ts'
import { corsFor } from './../_shared/http.ts'

// The slice of the edge-runtime API only the main service may use. User
// functions get their own typings from jsr:@supabase/functions-js.
declare const EdgeRuntime: {
  userWorkers: {
    create(options: {
      servicePath: string
      memoryLimitMb: number
      workerTimeoutMs: number
      noModuleCache: boolean
      envVars: [string, string][]
    }): Promise<{ fetch(request: Request): Promise<Response> }>
  }
}

const JWT_SECRET = Deno.env.get('JWT_SECRET')
const FUNCTIONS_ROOT = '/home/deno/functions'

/**
 * Functions reachable without a user token, and why.
 *
 * `company-signup` creates the company and its first user, so by definition
 * nobody holds a session yet. Requiring one made the signup form return 401
 * before the request ever reached the function — the page rendered, the button
 * worked, and every submission failed.
 *
 * `otp-request` and `otp-verify` send and check one-time codes for signup,
 * "Passwort vergessen" and invite activation, all of which happen before the
 * person has a session. Their two signed-in purposes, email_change and
 * platform_login, verify the bearer token inside the function, and their limits
 * (per code, per address, per IP) are enforced by the database, not here.
 *
 * These are not unauthenticated: the publishable anon key must still be
 * presented, exactly as hosted Supabase requires, so arbitrary traffic without
 * the key is refused at the door. What that does NOT give you is rate limiting
 * — the anon key ships in the browser bundle and is therefore public. Anyone
 * holding it can call these endpoints repeatedly, so abuse has to be bounded
 * elsewhere: the OTP functions by otp_issue's limits, company-signup by the same
 * per-IP limit on the code it sends, and by a captcha or a limit in front of
 * Kong before it is exposed to the open internet for long.
 */
const PUBLIC_FUNCTIONS = new Set<string>(['company-signup', 'otp-request', 'otp-verify'])

const BASE_ENV = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'APP_URL', 'EXTRA_CORS_ORIGINS'] as const
const SERVICE_ENV = ['SUPABASE_SERVICE_ROLE_KEY'] as const
const SMTP_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SENDER', 'SMTP_SENDER_NAME'] as const
const OTP_MAIL_ENV = ['OTP_PEPPER', ...SMTP_ENV] as const

/** Exactly the variables each worker may see. JWT_SECRET and SUPABASE_DB_URL are never passed. */
const FUNCTION_ENV: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ['company-signup', [...BASE_ENV, ...SERVICE_ENV, ...OTP_MAIL_ENV]],
  ['otp-request', [...BASE_ENV, ...SERVICE_ENV, ...OTP_MAIL_ENV]],
  // Sends the "address changed" notice to the old address.
  ['otp-verify', [...BASE_ENV, ...SERVICE_ENV, ...OTP_MAIL_ENV]],
  // Invites send an OTP.
  ['manage-users', [...BASE_ENV, ...SERVICE_ENV, ...OTP_MAIL_ENV]],
  // Mails the generated code to its target address or its company's admins.
  ['generate-activation-code', [...BASE_ENV, ...SERVICE_ENV, ...SMTP_ENV]],
  ['validate-discount-code', [...BASE_ENV, ...SERVICE_ENV]],
  ['update-income-weeks', [...BASE_ENV]],
  ['extract-receipt', [...BASE_ENV, 'ANTHROPIC_API_KEY']],
])

const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')

// The preflight never reaches the target function — this router answers it —
// so the allow-list has to be applied here too, or every OPTIONS would come
// back `*` no matter what the functions themselves do.
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsFor(req), 'Content-Type': 'application/json' },
  })

function bearer(req: Request): string | null {
  const header = req.headers.get('authorization')
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

async function tokenIsValid(token: string): Promise<boolean> {
  if (!JWT_SECRET) return false
  try {
    await jose.jwtVerify(token, new TextEncoder().encode(JWT_SECRET))
    return true
  } catch {
    return false
  }
}

/** The allowlisted variables that are actually set, as the runtime expects them. */
function workerEnv(names: readonly string[]): [string, string][] {
  return names.flatMap((name): [string, string][] => {
    const value = Deno.env.get(name)
    return value === undefined ? [] : [[name, value]]
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) })

  const { pathname } = new URL(req.url)
  // Kong strips /functions/v1, so pathname starts at the function name.
  const name = pathname.split('/').filter(Boolean)[0]

  if (!name || name === 'main') {
    return json(req, 404, { error: 'No function named in the request path' })
  }

  if (PUBLIC_FUNCTIONS.has(name)) {
    // The publishable key, not a session. Kong does not enforce one on this
    // route, so the check lives here.
    const apikey = req.headers.get('apikey') ?? bearer(req)
    if (!ANON_KEY || apikey !== ANON_KEY) {
      return json(req, 401, { error: 'Missing or invalid API key' })
    }
  } else {
    const token = bearer(req)
    if (!token || !(await tokenIsValid(token))) {
      return json(req, 401, { error: 'Missing or invalid authorization token' })
    }
  }

  // Fails closed: a function nobody gave an environment is not started. The
  // log names the missing entry so the 404 is not a mystery to whoever added it.
  const allowedEnv = FUNCTION_ENV.get(name)
  if (!allowedEnv) {
    console.error(JSON.stringify({ level: 'error', fn: 'main', step: 'env-allowlist',
      detail: `no FUNCTION_ENV entry for "${name}" in supabase/functions/main/index.ts` }))
    return json(req, 404, { error: `Unknown function: ${name}` })
  }

  // Asked for before the worker is built, because the runtime's own failure for
  // a directory that is not there is a generic "worker boot error" 500 that
  // reads like a crash. A function that was deleted should answer 404.
  try {
    const entry = await Deno.stat(`${FUNCTIONS_ROOT}/${name}/index.ts`)
    if (!entry.isFile) throw new Error('not a file')
  } catch {
    return json(req, 404, { error: `Unknown function: ${name}` })
  }

  try {
    // 256 MB and 60 s: manage-users touches the auth admin API several times per
    // request. Raise deliberately after watching a real workload rather than on
    // the first timeout.
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath: `${FUNCTIONS_ROOT}/${name}`,
      memoryLimitMb: 256,
      workerTimeoutMs: 60_000,
      noModuleCache: false,
      envVars: workerEnv(allowedEnv),
    })
    return await worker.fetch(req)
  } catch (err) {
    // The function exists (checked above), so anything here is a real failure to
    // start: a syntax error, a bad import, a missing env var at module scope.
    // The detail names paths and imports, which is our business and not the
    // caller's: it goes to the log, and the request id ties the two together.
    const requestId = crypto.randomUUID().slice(0, 8)
    const detail = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ level: 'error', fn: 'main', step: 'worker-start', function: name,
      request_id: requestId, detail }))
    return json(req, 500, { error: 'Function failed to start', request_id: requestId })
  }
})
