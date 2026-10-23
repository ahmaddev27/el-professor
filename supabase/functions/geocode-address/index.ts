/**
 * Puts the addresses of the Fahrtenbuch on the map: asks the Nominatim ridy runs
 * on this host, through the geocoder gateway of this stack, and answers a point
 * only where the answer is a house.
 *
 * The Fahrtenanalyse checks whether a driver could get from one ride's drop-off
 * to the next ride's pickup, and the sheet gives addresses where the routing
 * container (travel-route) needs points. This function is the missing step. What
 * counts as a point, and why a street or a postal area never does, is decided in
 * _shared/geocode-core.ts; the wire contract is there too.
 *
 * ## Who may ask
 *
 * Like travel-route: it is NOT in `PUBLIC_FUNCTIONS`, and the router's check is
 * not the authorization (it admits the anon key that ships in the bundle). The
 * function asks GoTrue who the caller is and the database for the caller's company
 * with `get_active_company_id()`, the helper every business table asks. The
 * service behind the gateway is another product's, with no limits of its own, so
 * "who may use it" is a question about its owner's server as well as ours.
 *
 * ## What it receives, and what it never writes down
 *
 * Addresses: passengers'. They go to one place, the gateway of this stack, which
 * passes three facts of each on to ridy's Nominatim (the owner's decision of
 * 22.10.2026, with its cost: that container logs requests, so an address asked of
 * it is in its log). They are never logged here: this function logs how many
 * addresses it was given and how many ended each way, and nothing from any text.
 * It reads and writes no table; the answers are kept by the browser in the
 * company's own geocode_cache, under the company's own policies.
 *
 * ## It does not decide what a point is worth
 *
 * A located address is a point at house level or it is not located. Whether two
 * points are far enough apart for a driver to make the drive is decided by travel.ts
 * and the routing container, as before.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsFor } from '../_shared/http.ts'
import {
  GEOCODER_ORIGIN,
  geocodeAddresses,
  geocodeRefusalStatus,
  parseGeocodeBody,
  type GeocodeRefusalReason,
  type GeocodeResult,
} from '../_shared/geocode-core.ts'

/** The gateway gives their service 5 s, and holds a request back for 2 s at most before that. */
const REQUEST_TIMEOUT_MS = 8_000
/** The gateway lets two requests through at a time for the whole stack. */
const CONCURRENCY = 2
/** Inside the router's 60 s worker limit, with room to answer what was placed. */
const DEADLINE_MS = 35_000
/** The service has failed three times in a row: it is down or struggling, so the rest is not asked. */
const MAX_CONSECUTIVE_FAILURES = 3

/** Counts by outcome. Never a coordinate, an id or an address. */
function tally(results: readonly GeocodeResult[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const result of results) {
    const key = result.kind === 'located' ? 'located' : result.reason
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
  const refuse = (reason: GeocodeRefusalReason) => respond({ ok: false, reason }, geocodeRefusalStatus(reason))

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

    // And belongs to a company the product lets work, as every business table asks.
    const company = await asCaller.rpc('get_active_company_id')
    if (company.error) return refuse('server_error')
    if (!company.data) return refuse('no_company')

    const parsed = parseGeocodeBody(await req.text())
    if (!parsed.ok) return refuse(parsed.problem)

    const outcome = await geocodeAddresses(parsed.queries, {
      fetchFn: fetch,
      baseUrl: GEOCODER_ORIGIN,
      timeoutMs: REQUEST_TIMEOUT_MS,
      concurrency: CONCURRENCY,
      deadlineMs: DEADLINE_MS,
      now: () => Date.now(),
      maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
    })
    console.log(JSON.stringify({
      level: 'info',
      fn: 'geocode-address',
      addresses: parsed.queries.length,
      outcome: tally(outcome.results),
      data_updated: outcome.dataUpdated,
    }))
    return respond({ ok: true, data_updated: outcome.dataUpdated, results: outcome.results })
  } catch (err) {
    // The detail names modules and hosts, which is our business and not the
    // caller's: it goes to the log, and the id ties the two together.
    const requestId = crypto.randomUUID().slice(0, 8)
    console.error(JSON.stringify({ level: 'error', fn: 'geocode-address', request_id: requestId, detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }))
    return respond({ ok: false, reason: 'server_error', request_id: requestId }, 500)
  }
})
