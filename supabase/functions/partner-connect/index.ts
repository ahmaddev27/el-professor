/**
 * Connect: a company links its own partner fleet.
 *
 * The operator mints a token in Reidey, which shows it **once**, and pastes it
 * here. This function proves the token works, learns which fleet it names,
 * seals it and records the connection.
 *
 * ## Why it is a function and not a route on `partner-intake`
 *
 * The project's own advice is to prefer a route, because a function costs a
 * line in `FUNCTION_ENV`, a line in the compose file and a decision about what
 * it may see. It is a function anyway, because `partner-intake` is the
 * **partner's** door: its authority is an `X-Partner-Key` header and its
 * header insists that the bearer proves nothing. This is the opposite — a
 * company administrator's session is the authority and the bearer is
 * everything. One function where half the requests must not be trusted and
 * half must be session-verified is the kind of thing that gets confused later.
 *
 * ## The destination is configuration, the token is input
 *
 * Exactly one thing here comes from the request: the token the operator pasted.
 * The URL it is sent to comes from `PARTNER_REIDEY_BASE_URL` and is validated
 * by `_shared/partner-endpoint.ts` before use — https, a public host, no
 * credentials, port 443, no path. These functions share a Docker network with
 * Reidey's database and with ours, so a destination from a request body would
 * be a server-side request forgery into our own network.
 *
 * ## The verification IS the connection
 *
 * The call to `GET /api/v1/elprofessor/fleet` does three jobs at once: it
 * proves the token is live, it returns the fleet identity we pin the connection
 * to, and — because Reidey records `first_used_at` on a confined read — it
 * flips Reidey's own card from "a token exists" to "connected". So there is no
 * separate first pull to arrange, and a connection that failed to verify never
 * reaches our database at all.
 *
 * ## Nothing is stored before the fleet is known
 *
 * `partner_connection_record` pins `external_company_id`, and
 * `partner_connections_live_per_external` (20261007100000) is what stops two of
 * our companies claiming one Reidey fleet. Recording a connection before the
 * fleet identity is known would write the NULL that index deliberately ignores,
 * so the order here is: verify, then record.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsFor } from '../_shared/http.ts'
import {
  PARTNER_ENDPOINT_VAR,
  partnerEndpoint,
  partnerFleetUrl,
} from '../_shared/partner-endpoint.ts'
import { partnerKeyHash, normalisePartner } from '../_shared/partner-intake-core.ts'
import { sealPartnerToken } from '../_shared/partner-token-seal.ts'

/** The one partner this build knows. A name from the body would be a new door. */
const PARTNER = 'reidey'

/** Reidey answers in well under this; a hang must not hold the operator's tab. */
const VERIFY_TIMEOUT_MS = 10_000

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) })

  const respond = (body: unknown, status = 200) => {
    // This function used to log nothing at all, so a refused connection left no
    // trace on either side: the operator saw one sentence and the container
    // showed nothing to read. Every refusal is recorded here, at the one place
    // all of them pass through. The reason is a fixed code and the body never
    // carries the token, so nothing secret is written.
    const reason = (body as { ok?: boolean; reason?: string } | null)?.reason
    if (reason !== undefined) {
      console.log(JSON.stringify({ level: 'info', fn: 'partner-connect', status, reason }))
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsFor(req), 'Content-Type': 'application/json' },
    })
  }

  if (req.method !== 'POST') {
    return respond({ ok: false, reason: 'method_not_allowed' }, 405)
  }

  const authorization = req.headers.get('Authorization') ?? ''
  if (authorization === '') return respond({ ok: false, reason: 'not_authorized' }, 401)

  const pepper = Deno.env.get('OTP_PEPPER') ?? ''
  const sealKey = Deno.env.get('PARTNER_SEAL_KEY') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''

  // A missing seal key is a dormant deployment, not a bad request: the owner
  // writes it on the host. Named so the screen can say which half is missing
  // rather than reporting the operator's token as the problem.
  if (sealKey === '') return respond({ ok: false, reason: 'seal_key_missing' }, 503)
  if (pepper === '' || serviceKey === '' || supabaseUrl === '') {
    return respond({ ok: false, reason: 'server_error' }, 500)
  }

  const endpoint = partnerEndpoint(Deno.env.get(PARTNER_ENDPOINT_VAR))
  if (!endpoint.ok) {
    // The configured destination is unusable. Its own reason, because
    // "endpoint_private_host" and a wrong token are entirely different repairs.
    return respond({ ok: false, reason: endpoint.problem }, 503)
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return respond({ ok: false, reason: 'invalid_body' }, 400)
  }

  const token = typeof body.token === 'string' ? body.token.trim() : ''
  if (token === '') return respond({ ok: false, reason: 'token_required' }, 400)

  // The caller's own session decides which company this is for — never a
  // company_id from the body. `get_active_company_id()` answers the company
  // whose business data this caller may touch, which is the same question
  // every tenant policy asks.
  const asCaller = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const company = await asCaller.rpc('get_active_company_id')
  if (company.error) return respond({ ok: false, reason: 'not_authorized' }, 401)
  const companyId = company.data as string | null
  if (!companyId) return respond({ ok: false, reason: 'not_authorized' }, 403)

  // Connecting a fleet is an administrator's act: it decides whose roster this
  // company reads and whose drivers its operators will be shown. The database
  // asks again on every write, so this is the message rather than the wall.
  const permitted = await asCaller.rpc('current_role_permits', {
    p_page: 'drivers', p_need_edit: true,
  })
  if (permitted.error || permitted.data !== true) {
    return respond({ ok: false, reason: 'not_authorized' }, 403)
  }

  // Verify against the partner. This is also what flips their card to
  // "connected", because a confined read records `first_used_at` there.
  let fleet: { tenant_id?: unknown; tenant_name?: unknown; payment_reference?: unknown }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS)
    let answer: Response
    try {
      answer = await fetch(partnerFleetUrl(endpoint.origin), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (answer.status === 401 || answer.status === 403) {
      // The token is wrong, revoked, or not the confined one. A final answer:
      // the operator mints a new one rather than retrying.
      return respond({ ok: false, reason: 'token_rejected' }, 200)
    }
    if (!answer.ok) return respond({ ok: false, reason: 'partner_unavailable' }, 502)

    const payload = (await answer.json()) as { data?: Record<string, unknown> }
    fleet = payload?.data ?? {}
  } catch {
    // A timeout or a network failure. Nothing was written, so a retry is safe.
    return respond({ ok: false, reason: 'partner_unavailable' }, 502)
  }

  const tenantId = fleet.tenant_id === undefined || fleet.tenant_id === null
    ? ''
    : String(fleet.tenant_id).trim()
  if (tenantId === '') {
    // A token that reads but names no fleet cannot be pinned, and pinning is
    // what stops two of our companies claiming one fleet.
    return respond({ ok: false, reason: 'fleet_unidentified' }, 502)
  }
  const tenantName = typeof fleet.tenant_name === 'string' ? fleet.tenant_name.trim() : null

  const partner = normalisePartner(PARTNER)
  let keyHash: string
  let sealed: string
  try {
    keyHash = await partnerKeyHash(pepper, partner, token)
    sealed = await sealPartnerToken(sealKey, token)
  } catch {
    return respond({ ok: false, reason: 'server_error' }, 500)
  }

  const caller = await asCaller.auth.getUser()
  const connectedBy = caller.data?.user?.id ?? null

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const recorded = await admin.rpc('partner_connection_record', {
    p_company_id: companyId,
    p_partner: partner,
    p_key_hash: keyHash,
    p_sealed_token: sealed,
    p_external_company_id: tenantId,
    p_external_company_name: tenantName,
    p_connected_by: connectedBy,
  })

  if (recorded.error) {
    // 23505 on partner_connections_live_per_external: this fleet is already
    // connected to another of our companies. A real and expected answer, not a
    // fault — and the one the audit found before any of this was built.
    if (recorded.error.code === '23505') {
      return respond({ ok: false, reason: 'fleet_already_connected' }, 200)
    }
    return respond({ ok: false, reason: 'server_error' }, 500)
  }

  return respond({
    ok: true,
    connection_id: (recorded.data as { connection_id?: string } | null)?.connection_id ?? null,
    fleet_name: tenantName,
  })
})
