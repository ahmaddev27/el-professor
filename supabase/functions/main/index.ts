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
 */
import * as jose from 'https://deno.land/x/jose@v4.14.4/index.ts'
import { corsFor } from './../_shared/http.ts'

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
 * These are not unauthenticated: the publishable anon key must still be
 * presented, exactly as hosted Supabase requires, so arbitrary traffic without
 * the key is refused at the door. What that does NOT give you is rate limiting
 * — the anon key ships in the browser bundle and is therefore public. Anyone
 * holding it can call this endpoint repeatedly, so signup abuse has to be
 * bounded somewhere else (a captcha, or a limit in front of Kong) before this
 * is exposed to the open internet for long.
 */
const PUBLIC_FUNCTIONS = new Set<string>(['company-signup'])

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
      envVars: Object.entries(Deno.env.toObject()),
    })
    return await worker.fetch(req)
  } catch (err) {
    // The function exists (checked above), so anything here is a real failure to
    // start: a syntax error, a bad import, a missing env var at module scope.
    // `detail` names a path or an import error in our own code — no database
    // text and no credentials reach here — so it stays, because a 500 with no
    // detail from a dispatcher is undiagnosable.
    const message = err instanceof Error ? err.message : String(err)
    return json(req, 500, { error: 'Function failed to start', detail: message })
  }
})
