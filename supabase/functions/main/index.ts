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
 * `PUBLIC_FUNCTIONS` is the allow-list, and it is deliberately empty. Every
 * function this project ships either administers users, spends money, or reads
 * tenant data; none of them should answer an unauthenticated caller. A function
 * added later that genuinely must be public has to be named here, in a commit,
 * with a reason.
 *
 * Verification here is authentication, not authorization: it proves the caller
 * holds a token this stack signed. Each function still loads the caller's
 * profile and checks role, tenancy and target — see the assertSameCompany()
 * pattern in manage-users.
 */
import * as jose from 'https://deno.land/x/jose@v4.14.4/index.ts'

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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const { pathname } = new URL(req.url)
  // Kong strips /functions/v1, so pathname starts at the function name.
  const name = pathname.split('/').filter(Boolean)[0]

  if (!name || name === 'main') {
    return json(404, { error: 'No function named in the request path' })
  }

  if (PUBLIC_FUNCTIONS.has(name)) {
    // The publishable key, not a session. Kong does not enforce one on this
    // route, so the check lives here.
    const apikey = req.headers.get('apikey') ?? bearer(req)
    if (!ANON_KEY || apikey !== ANON_KEY) {
      return json(401, { error: 'Missing or invalid API key' })
    }
  } else {
    const token = bearer(req)
    if (!token || !(await tokenIsValid(token))) {
      return json(401, { error: 'Missing or invalid authorization token' })
    }
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
    // A missing directory and a function that threw at import time both land
    // here; say which so the 500 is diagnosable from the response alone.
    const message = err instanceof Error ? err.message : String(err)
    const missing = message.includes('No such file') || message.includes('not found')
    return json(missing ? 404 : 500, {
      error: missing ? `Unknown function: ${name}` : 'Function failed to start',
      detail: message,
    })
  }
})
