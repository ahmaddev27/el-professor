/**
 * Telling a driver their submission was rejected.
 *
 * The last half of M3, and it was blocked until the token could be replayed:
 * `partner_credentials` held only an HMAC until `20261008110000`, so there was
 * nothing to authenticate an outbound call with. Reidey's receiving endpoint
 * and the driver notification behind it already exist and are tested on its
 * branch (20 tests, 145 assertions).
 *
 * ## Why this is a third function and not an action on `partner-pull`
 *
 * They share a direction and nothing else. The pull reads a roster for a whole
 * company at an operator's pace; this tells one person about one decision, and
 * it is triggered by that decision rather than by a button someone presses when
 * they feel like it. Folding them together would mean a function whose name
 * describes half of what it does, which is the thing the Connect/intake split
 * already avoided once in this slice.
 *
 * ## What travels, and what deliberately does not
 *
 * A reason code, the reviewer's own words, the partner's own ids. **Not** the
 * note's text, not who reviewed it, not the `driver_note_id` — a driver is told
 * why their submission was refused, not sent their own note back with the
 * company's internal record attached. `partner_submission_push_target` carries
 * exactly those four fields and self-check 4 fails a release where it starts
 * carrying more.
 *
 * The reason code is always `review_rejected`, because there is one way a note
 * gets rejected: a person decided. It is a kind of event, not a taxonomy — and
 * Reidey's `AppNotification` requires that shape anyway, storing "a stable
 * semantic type + structured params, NOT pre-rendered text, so the frontend
 * renders the title/body/icon in each user's own language".
 *
 * ## A failure is recorded, never retried here
 *
 * There is no scheduler in this stack, so this function does not pretend to be
 * one. Whatever happens, `partner_submission_push_record` writes it: a success
 * stamps the time, a failure keeps the reason and leaves the time NULL — which
 * is the state the review screen shows as "the driver has not been told". The
 * operator retries by pressing again. Silence was the alternative, and silence
 * is what makes a driver wait for an answer that was given days ago.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsFor } from '../_shared/http.ts'
import { PARTNER_ENDPOINT_VAR, partnerEndpoint } from '../_shared/partner-endpoint.ts'
import { openPartnerToken } from '../_shared/partner-token-seal.ts'

/** One way a note is rejected: a person decided. A kind of event, not a list. */
const REASON_CODE = 'review_rejected'
const PUSH_TIMEOUT_MS = 10_000

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

  const sealKey = Deno.env.get('PARTNER_SEAL_KEY') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  if (sealKey === '') return respond({ ok: false, reason: 'seal_key_missing' }, 503)
  if (serviceKey === '' || supabaseUrl === '') return respond({ ok: false, reason: 'server_error' }, 500)

  const endpoint = partnerEndpoint(Deno.env.get(PARTNER_ENDPOINT_VAR))
  if (!endpoint.ok) return respond({ ok: false, reason: endpoint.problem }, 503)

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return respond({ ok: false, reason: 'invalid_body' }, 400)
  }
  const submissionId = typeof body.submission_id === 'string' ? body.submission_id.trim() : ''
  if (submissionId === '') return respond({ ok: false, reason: 'invalid_request' }, 400)

  const asCaller = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const company = await asCaller.rpc('get_active_company_id')
  if (company.error) return respond({ ok: false, reason: 'not_authorized' }, 401)
  const companyId = company.data as string | null
  if (!companyId) return respond({ ok: false, reason: 'not_authorized' }, 403)

  // The reviewer's own page: telling a driver about a note decision belongs to
  // whoever may make that decision.
  const permitted = await asCaller.rpc('current_role_permits', {
    p_page: 'notes', p_need_edit: true,
  })
  if (permitted.error || permitted.data !== true) {
    return respond({ ok: false, reason: 'not_authorized' }, 403)
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const target = await admin.rpc('partner_submission_push_target', {
    p_submission_id: submissionId,
  })
  if (target.error) return respond({ ok: false, reason: 'server_error' }, 500)
  const plan = target.data as {
    ok?: boolean
    reason?: string
    company_id?: string
    partner?: string
    external_submission_id?: string
    external_driver_id?: string
    reason_text?: string | null
  }
  if (!plan?.ok) return respond({ ok: false, reason: plan?.reason ?? 'server_error' }, 200)

  // The submission's company is checked against the CALLER's, not taken from
  // the row: the target function runs as the service role and would happily
  // describe another company's submission to anyone who knows its id.
  if (plan.company_id !== companyId) {
    return respond({ ok: false, reason: 'submission_not_found' }, 200)
  }

  const sealed = await admin.rpc('partner_sealed_token', {
    p_company_id: companyId, p_partner: plan.partner,
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
    await admin.rpc('partner_submission_push_record', {
      p_submission_id: submissionId, p_error: 'seal_unreadable',
    })
    return respond({ ok: false, reason: 'seal_unreadable' }, 409)
  }

  const record = (error?: string) => admin.rpc('partner_submission_push_record', {
    p_submission_id: submissionId, p_error: error ?? null,
  })

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS)
    let answer: Response
    try {
      answer = await fetch(`${endpoint.origin}/api/v1/elprofessor/submissions/status`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          kind: 'note',
          external_submission_id: plan.external_submission_id,
          external_driver_id: plan.external_driver_id,
          status: 'rejected',
          reason_code: REASON_CODE,
          reason_text: plan.reason_text ?? null,
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (answer.status === 401 || answer.status === 403) {
      await record('token_rejected')
      return respond({ ok: false, reason: 'token_rejected' }, 200)
    }
    // A 404 is the partner saying it has no such driver — the roster moved
    // under us. Final for this submission: no retry will find them.
    if (answer.status === 404) {
      await record('driver_unknown_at_partner')
      return respond({ ok: false, reason: 'driver_unknown_at_partner' }, 200)
    }
    if (!answer.ok) {
      await record(`HTTP ${answer.status}`)
      return respond({ ok: false, reason: 'partner_unavailable' }, 502)
    }

    // Reidey answers `notified: false, duplicate: true` when the driver has
    // already been told. That is a success for us: the driver knows, and
    // stamping it stops the screen asking for a delivery that happened.
    const payload = (await answer.json()) as { data?: { notified?: boolean; duplicate?: boolean } }
    await record()
    return respond({
      ok: true,
      notified: payload?.data?.notified ?? null,
      duplicate: payload?.data?.duplicate ?? null,
    })
  } catch {
    await record('unreachable')
    return respond({ ok: false, reason: 'partner_unavailable' }, 502)
  }
})
