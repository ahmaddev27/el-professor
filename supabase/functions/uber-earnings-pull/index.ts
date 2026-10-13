/**
 * The Uber earnings pull: reads a driver-by-driver total for a date range from
 * Reidey and hands it to the screen as a PREVIEW. It writes nothing.
 *
 * Shape of `partner-pull`, and the same rules apply. Read its header; the ones
 * that matter here:
 *
 * - **The token.** Opened here and nowhere else the screen can reach, sent to
 *   the one validated destination, never logged, never returned, not even in an
 *   error. `partner_sealed_token` is service_role's alone.
 * - **By a button, not a schedule.** The owner's decision of 13.10.2026: no cron
 *   caller. This needs a session, and the session decides the company; a body
 *   field never does.
 *
 * ## Why it writes nothing
 *
 * The rows are written by `income_import_uber`, called by the screen with the
 * caller's own session after a person has read the preview. Splitting the two
 * keeps this function from ever being the place an income row is created, and
 * keeps the database's gate (role, company state, confirmed link, the unique
 * index) the only door to the table.
 *
 * ## One call per business week
 *
 * The owner's range is cut at every Sunday and Reidey is asked once per piece,
 * because a business week belongs to the month containing its Monday and one
 * income row is written per driver per type per WEEK. Reidey's total for a
 * whole range could not be split afterwards. The pieces are bounded by
 * `MAX_RANGE_DAYS`, so a request cannot make this worker call out without limit.
 *
 * ## Strict or nothing
 *
 * Every answer is read by `uber-earnings-core.ts`: amounts are plain decimal
 * strings and anything else refuses the whole pull. A preview with one driver
 * missing is a total that is too low, which is worse than an error.
 *
 * ## What it does NOT stamp
 *
 * `partner_pull_record` is the roster's "last synced" clock. A successful
 * earnings pull would make a stale roster look fresh, so success is not
 * stamped. A refused or unreadable token is a fact about the connection and is.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsFor } from '../_shared/http.ts'
import {
  PARTNER_ENDPOINT_VAR,
  partnerEndpoint,
} from '../_shared/partner-endpoint.ts'
import { openPartnerToken } from '../_shared/partner-token-seal.ts'
import {
  parseEarningsBody,
  splitIntoBusinessWeeks,
  type UberDriverEarnings,
  type UnmatchedEarner,
  type WeekSegment,
} from '../_shared/uber-earnings-core.ts'

const PARTNER = 'reidey'
const CALL_TIMEOUT_MS = 15_000

interface LinkRow {
  external_driver_id: string
  driver_id: string
  drivers: { name: string } | { name: string }[] | null
}

/**
 * A partner refusal's stable reason, and the sentence beside it.
 *
 * The reason alone was not enough to act on. `uber_error` is Reidey's catch-all
 * for "Uber answered, accepted the session, and returned something other than
 * 2xx / 401 / 403" — a 400 and a 429 arrive under the same word, and they are
 * different problems with different fixes. Reidey already puts the status in
 * its `message` ("Fleet Hub answered 400."); it was this function that dropped
 * it on the floor, so the screen could only show a code nobody can act on.
 *
 * The detail is capped and stripped of control characters: it is a sentence
 * from another product and it ends up in a toast.
 */
async function refusalReason(
  answer: Response,
): Promise<{ reason: string | null; detail: string | null }> {
  try {
    const body = (await answer.json()) as { reason?: unknown; message?: unknown }
    const reason = typeof body?.reason === 'string' && /^[a-z][a-z0-9_]{0,59}$/.test(body.reason)
      ? body.reason : null
    const detail = typeof body?.message === 'string'
      // eslint-disable-next-line no-control-regex
      ? body.message.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) || null
      : null
    return { reason, detail }
  } catch {
    return { reason: null, detail: null }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) })

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsFor(req), 'Content-Type': 'application/json' },
    })

  if (req.method !== 'POST') return respond({ ok: false, reason: 'method_not_allowed' }, 405)

  const authorization = req.headers.get('Authorization') ?? ''
  if (authorization === '') return respond({ ok: false, reason: 'not_authorized' }, 401)

  let requested: { from?: unknown; to?: unknown }
  try {
    requested = await req.json()
  } catch {
    return respond({ ok: false, reason: 'invalid_range' }, 400)
  }
  const split = splitIntoBusinessWeeks(String(requested?.from), String(requested?.to))
  if (!split.ok) return respond({ ok: false, reason: split.problem }, 400)
  const segments = split.value

  const sealKey = Deno.env.get('PARTNER_SEAL_KEY') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  if (sealKey === '') return respond({ ok: false, reason: 'seal_key_missing' }, 503)
  if (serviceKey === '' || supabaseUrl === '') return respond({ ok: false, reason: 'server_error' }, 500)

  const endpoint = partnerEndpoint(Deno.env.get(PARTNER_ENDPOINT_VAR))
  if (!endpoint.ok) return respond({ ok: false, reason: endpoint.problem }, 503)

  const asCaller = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // The caller's own session decides the company; never a body field.
  const company = await asCaller.rpc('get_active_company_id')
  if (company.error) return respond({ ok: false, reason: 'not_authorized' }, 401)
  const companyId = company.data as string | null
  if (!companyId) return respond({ ok: false, reason: 'not_authorized' }, 403)

  // The page the income table's own write policies carry: whoever could not
  // type these rows by hand cannot pull them either.
  const permitted = await asCaller.rpc('current_role_permits', {
    p_page: 'income', p_need_edit: true,
  })
  if (permitted.error || permitted.data !== true) {
    return respond({ ok: false, reason: 'not_authorized' }, 403)
  }

  // Our confirmed links, read as the caller so tenancy is RLS's. The import
  // function resolves them again itself; this is only so the preview can name
  // our driver beside theirs and say who is unlinked.
  const linkRows = await asCaller.from('partner_driver_links')
    .select('external_driver_id, driver_id, drivers(name)')
    .eq('partner', PARTNER).eq('status', 'linked')
  if (linkRows.error) return respond({ ok: false, reason: 'server_error' }, 500)
  const links: Record<string, { driverId: string; driverName: string }> = {}
  for (const row of (linkRows.data ?? []) as unknown as LinkRow[]) {
    const driver = Array.isArray(row.drivers) ? row.drivers[0] : row.drivers
    if (driver?.name) links[row.external_driver_id] = { driverId: row.driver_id, driverName: driver.name }
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const sealed = await admin.rpc('partner_sealed_token', {
    p_company_id: companyId, p_partner: PARTNER,
  })
  if (sealed.error) return respond({ ok: false, reason: 'server_error' }, 500)
  const sealedToken = sealed.data as string | null
  if (!sealedToken) return respond({ ok: false, reason: 'not_connected' }, 409)

  let token: string | null
  try {
    token = await openPartnerToken(sealKey, sealedToken)
  } catch {
    return respond({ ok: false, reason: 'server_error' }, 500)
  }
  if (!token) {
    await admin.rpc('partner_pull_record', {
      p_company_id: companyId, p_partner: PARTNER, p_error: 'seal_unreadable',
    })
    return respond({ ok: false, reason: 'seal_unreadable' }, 409)
  }

  const weeks: Array<WeekSegment & { drivers: UberDriverEarnings[] }> = []
  // Earners Reidey could not resolve, once each across the weeks.
  const unmatched = new Map<string, UnmatchedEarner>()
  try {
    for (const segment of segments) {
      const url = new URL(`${endpoint.origin}/api/v1/elprofessor/earnings`)
      url.searchParams.set('from', segment.from)
      url.searchParams.set('to', segment.to)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
      let answer: Response
      try {
        answer = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }

      if (answer.status === 401 || answer.status === 403) {
        await admin.rpc('partner_pull_record', {
          p_company_id: companyId, p_partner: PARTNER, p_error: 'token_rejected',
        })
        return respond({ ok: false, reason: 'token_rejected' }, 200)
      }
      if (!answer.ok) {
        // Reidey's refusals carry a stable reason; pass THAT through (and only
        // if it is the agreed shape) so the screen can name it.
        const refusal = await refusalReason(answer)
        if (refusal.reason) {
          return respond({
            ok: false,
            reason: 'partner_refused',
            partner_reason: refusal.reason,
            partner_detail: refusal.detail,
          }, 200)
        }
        return respond({ ok: false, reason: 'partner_unavailable' }, 502)
      }

      let payload: unknown
      try {
        payload = await answer.json()
      } catch {
        return respond({ ok: false, reason: 'partner_malformed', problem: 'malformed' }, 502)
      }
      const read = parseEarningsBody(payload, segment.from, segment.to)
      if (!read.ok) {
        return respond({ ok: false, reason: 'partner_malformed', problem: read.problem }, 502)
      }
      weeks.push({ ...segment, drivers: read.value.drivers })
      for (const earner of read.value.unmatched) {
        unmatched.set(earner.uberDriverUuid ?? earner.name, earner)
      }
    }
  } catch {
    return respond({ ok: false, reason: 'partner_unavailable' }, 502)
  }

  return respond({ ok: true, weeks, links, unmatched: [...unmatched.values()] })
})
