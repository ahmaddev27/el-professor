/**
 * Road time between coordinate pairs, asked of our own routing container.
 *
 * The Fahrtenanalyse checks whether a driver could get from one ride's drop-off
 * to the next ride's pickup in the time between them. It needs a driving time;
 * this function gets one from OSRM (the `osrm` service in deploy/docker-compose.yml)
 * and answers what the container measured, pair by pair. What the numbers mean
 * for the check is decided in the browser (src/utils/travelRouting) and by the
 * rule travel.ts already has; the wire contract is in _shared/travel-route-core.ts.
 *
 * ## Who may ask
 *
 * It is NOT in `PUBLIC_FUNCTIONS`, and the router's check is not the
 * authorization: that check admits any token this stack signed, the anon key
 * that ships in the browser bundle included. So the function asks GoTrue who the
 * caller is (the anon key is not a user and is refused) and asks the database
 * for the caller's company with `get_active_company_id()`, the helper every
 * business table asks: a company or an account the screens refuse gets nothing
 * here either, and a platform account gets an answer only inside an open
 * support context. The answer is public geography and reveals nothing of any
 * company, so there is no role gate beyond that; the point of the gate is that
 * the routing container is a CPU on a host shared with another live product,
 * and the anon key must not be able to use it.
 *
 * ## What it reads and writes
 *
 * Nothing and nothing: no table, no storage, no service-role key (it is not in
 * this function's FUNCTION_ENV), no mail. It receives coordinates and ids, calls
 * one fixed address, and logs counts. A coordinate is never logged: the pairs
 * are the places a passenger was picked up and dropped off.
 *
 * ## It does not decide
 *
 * Whether a pair "passed" is not here. A result carries a duration, a distance
 * and how far each point had to be moved onto a road; a failure carries a
 * reason. No result is ever invented: a container that is down, slow or wrong
 * produces `unavailable` pairs and an ordinary 200, and the screen keeps saying
 * "nicht prüfbar".
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsFor } from '../_shared/http.ts'
import {
  OSRM_ORIGIN,
  parseRouteBody,
  refusalStatus,
  routePairs,
  type RouteRefusalReason,
  type RouteResult,
} from '../_shared/travel-route-core.ts'

/** One route takes milliseconds; three seconds is a container that is stuck. */
const REQUEST_TIMEOUT_MS = 3_000
const CONCURRENCY = 8
/** Inside the router's 60 s worker limit, with room to answer what was routed. */
const DEADLINE_MS = 25_000

/** Counts by outcome. Never a coordinate, an id or an address. */
function tally(results: readonly RouteResult[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const result of results) {
    const key = result.kind === 'route' ? 'routed' : result.reason
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) })

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsFor(req), 'Content-Type': 'application/json' },
    })
  const refuse = (reason: RouteRefusalReason) => respond({ ok: false, reason }, refusalStatus(reason))

  if (req.method !== 'POST') return refuse('method_not_allowed')

  const authorization = req.headers.get('Authorization') ?? ''
  if (!authorization.startsWith('Bearer ')) return refuse('not_authenticated')

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  if (supabaseUrl === '' || anonKey === '') return refuse('server_error')

  try {
    const asCaller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // The caller is a person. The anon key and the service key carry no `sub`
    // and GoTrue refuses both.
    const { data: caller, error: callerError } = await asCaller.auth.getUser()
    if (callerError || !caller?.user) return refuse('not_authenticated')

    // And belongs to a company the product lets work: the helper every business
    // table asks, so a blocked company or account is refused here as it is there.
    const company = await asCaller.rpc('get_active_company_id')
    if (company.error) return refuse('server_error')
    if (!company.data) return refuse('no_company')

    const parsed = parseRouteBody(await req.text())
    if (!parsed.ok) return refuse(parsed.problem)

    const outcome = await routePairs(parsed.pairs, {
      fetchFn: fetch,
      baseUrl: OSRM_ORIGIN,
      timeoutMs: REQUEST_TIMEOUT_MS,
      concurrency: CONCURRENCY,
      deadlineMs: DEADLINE_MS,
      now: () => Date.now(),
    })
    console.log(JSON.stringify({ level: 'info', fn: 'travel-route', pairs: parsed.pairs.length, outcome: tally(outcome.results) }))
    return respond({ ok: true, data_version: outcome.dataVersion, results: outcome.results })
  } catch (err) {
    // The detail names modules and hosts, which is our business and not the
    // caller's: it goes to the log, and the id ties the two together.
    const requestId = crypto.randomUUID().slice(0, 8)
    console.error(JSON.stringify({ level: 'error', fn: 'travel-route', request_id: requestId, detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }))
    return respond({ ok: false, reason: 'server_error', request_id: requestId }, 500)
  }
})
