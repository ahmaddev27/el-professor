/**
 * The roster pull: the one place a sealed partner token is opened and used.
 *
 * Connect proved the token and sealed it; this reads the partner's roster with
 * it and turns each driver into a proposal a person then confirms. Until this
 * existed, `partner_driver_links` had no rows and M2's proposals tab was empty
 * — which is to say M2 and M3 were built and unusable.
 *
 * ## By a button, not a schedule
 *
 * The owner's decision of 06.10.2026: "the roster pull is a button, not cron".
 * So this needs a session and runs at an operator's pace, there is no host cron
 * line to install, and nothing pulls on its own. A cron caller would need a
 * function with no `auth.uid()` — `notify-expiries`' shape — and that is a
 * separate decision if it is ever wanted.
 *
 * ## What it may do with the token
 *
 * Open it, send it to the one validated destination, and let it go. It is never
 * logged, never returned, and never put in a response — not even in an error.
 * `partner_sealed_token` is the only function in the schema that hands back a
 * replayable secret and it is service_role's alone; this is its only caller.
 *
 * ## Pages, bounded
 *
 * Reidey caps a page at 100 and orders by id. This follows `meta.total` and
 * stops at `MAX_PAGES`, because a partner that reported a wrong total would
 * otherwise keep this worker alive until the runtime killed it — and a bound
 * nobody can see is how a loop becomes an outage.
 *
 * ## Every outcome is stamped on the connection
 *
 * `partner_pull_record` moves `last_pull_at` on every attempt and
 * `last_success_at` only on success, so a failed pull is visible as a failure
 * rather than as silence. This function therefore has no `finally`-free path:
 * whatever happens, the connection says what happened.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsFor } from '../_shared/http.ts'
import {
  PARTNER_ENDPOINT_VAR,
  partnerEndpoint,
} from '../_shared/partner-endpoint.ts'
import { openPartnerToken } from '../_shared/partner-token-seal.ts'

const PARTNER = 'reidey'
const PER_PAGE = 100
/** Reidey caps a page at 100, so this covers 2000 drivers of one fleet. */
const MAX_PAGES = 20
const PAGE_TIMEOUT_MS = 15_000

interface RosterDriver {
  id?: unknown
  name?: unknown
  email?: unknown
  phone?: unknown
  roster_removed_at?: unknown
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) })

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsFor(req), 'Content-Type': 'application/json' },
    })

  if (req.method !== 'POST') {
    return respond({ ok: false, reason: 'method_not_allowed' }, 405)
  }

  const authorization = req.headers.get('Authorization') ?? ''
  if (authorization === '') return respond({ ok: false, reason: 'not_authorized' }, 401)

  const sealKey = Deno.env.get('PARTNER_SEAL_KEY') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  if (sealKey === '') return respond({ ok: false, reason: 'seal_key_missing' }, 503)
  if (serviceKey === '' || supabaseUrl === '') {
    return respond({ ok: false, reason: 'server_error' }, 500)
  }

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

  const permitted = await asCaller.rpc('current_role_permits', {
    p_page: 'drivers', p_need_edit: true,
  })
  if (permitted.error || permitted.data !== true) {
    return respond({ ok: false, reason: 'not_authorized' }, 403)
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const sealed = await admin.rpc('partner_sealed_token', {
    p_company_id: companyId, p_partner: PARTNER,
  })
  if (sealed.error) return respond({ ok: false, reason: 'server_error' }, 500)
  const sealedToken = sealed.data as string | null
  // NULL covers "no connection" and "connected before the seal existed". The
  // operator's repair is the same either way: connect again.
  if (!sealedToken) return respond({ ok: false, reason: 'not_connected' }, 409)

  let token: string | null
  try {
    token = await openPartnerToken(sealKey, sealedToken)
  } catch {
    // A short key is a misconfigured deployment, not one unusable connection.
    return respond({ ok: false, reason: 'server_error' }, 500)
  }
  if (!token) {
    // The seal cannot be opened with this key — the key was rotated, or the row
    // was written under another one. Reconnecting is the repair, and saying so
    // is better than reporting the partner as unreachable.
    await admin.rpc('partner_pull_record', {
      p_company_id: companyId, p_partner: PARTNER, p_error: 'seal_unreadable',
    })
    return respond({ ok: false, reason: 'seal_unreadable' }, 409)
  }

  /** Whatever happens from here, the connection records it. */
  const stamp = (error?: string) => admin.rpc('partner_pull_record', {
    p_company_id: companyId, p_partner: PARTNER, p_error: error ?? null,
  })

  const totals = { seen: 0, new: 0, departed: 0, returned: 0 }
  try {
    let page = 1
    let pages = 1
    while (page <= pages && page <= MAX_PAGES) {
      const url = new URL(`${endpoint.origin}/api/v1/elprofessor/fleet/drivers`)
      url.searchParams.set('per_page', String(PER_PAGE))
      url.searchParams.set('page', String(page))

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS)
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
        await stamp('token_rejected')
        return respond({ ok: false, reason: 'token_rejected' }, 200)
      }
      if (!answer.ok) {
        await stamp(`HTTP ${answer.status}`)
        return respond({ ok: false, reason: 'partner_unavailable' }, 502)
      }

      const payload = (await answer.json()) as {
        data?: RosterDriver[]
        meta?: { total?: unknown; per_page?: unknown }
      }
      const drivers = Array.isArray(payload?.data) ? payload.data : []

      // The page goes to the database as it arrived. Reading the fields here
      // would be a second place that decides what a roster row means.
      const applied = await admin.rpc('partner_roster_apply', {
        p_company_id: companyId, p_partner: PARTNER, p_drivers: drivers,
      })
      if (applied.error) {
        await stamp('apply_failed')
        return respond({ ok: false, reason: 'server_error' }, 500)
      }
      const counts = applied.data as typeof totals
      totals.seen += counts?.seen ?? 0
      totals.new += counts?.new ?? 0
      totals.departed += counts?.departed ?? 0
      totals.returned += counts?.returned ?? 0

      if (page === 1) {
        const total = Number(payload?.meta?.total ?? drivers.length)
        const perPage = Number(payload?.meta?.per_page ?? PER_PAGE) || PER_PAGE
        pages = Number.isFinite(total) && total > 0 ? Math.ceil(total / perPage) : 1
      }
      // A page that came back empty ends the walk whatever the total claimed.
      if (drivers.length === 0) break
      page += 1
    }

    await stamp()
    return respond({ ok: true, ...totals, truncated: page > MAX_PAGES })
  } catch {
    await stamp('unreachable')
    return respond({ ok: false, reason: 'partner_unavailable' }, 502)
  }
})
