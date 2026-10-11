/**
 * What a partner's driver app submits to us: a note (M3) or a Beleg with its
 * photo (M4), and since 08.10.2026 the **doorbell** that is how either of them
 * actually arrives.
 *
 * ## The doorbell, and why the payload door cannot be the live one
 *
 * Measured, and it decided the design: **Reidey cannot replay the token it
 * issued.** Sanctum stores only a hash, so the partner's own backend cannot
 * read the plaintext back — and the payload door below authenticates with
 * exactly that token (`X-Partner-Key` → HMAC → `partner_credential_company`).
 * So pushing a payload needed a credential nobody holds, for notes as well as
 * Belege.
 *
 * The owner chose, on 08.10.2026, the answer that needs no new secret anywhere:
 * the partner **rings** — `{partner, fleet, submission, kind}`, no payload, no
 * credential — and we fetch the submission from the partner's own host with the
 * token we hold sealed (`20261008110000`). A forged ring is harmless by
 * construction: nothing in it is stored, so the worst it does is make us ask
 * the partner about a submission that answers 404. It is rate limited in the
 * database (`partner_doorbell_resolve`), because Kong has no rate limiting here
 * and the ring carries nothing to limit it by.
 *
 * **The payload door is kept and is not the live path.** It is the generic
 * partner-push shape and it is unreachable rather than merely unused: with no
 * credential it answers 403 to everyone, including the partner. A future
 * partner that can hold a key uses it; Reidey rings.
 *
 * ## `catchup` is the recovery, because there is no scheduler
 *
 * A ring that never arrives — the partner's queue died, we were down, Kong
 * dropped it — is a receipt that silently never came. Nothing in this stack can
 * retry on its own, so the recovery is a human: `kind: 'catchup'` asks the
 * partner for its pending submissions and ingests up to `CATCHUP_MAX` of them.
 * The review tab's button is the caller.
 *
 * ## It is NOT in PUBLIC_FUNCTIONS, and the router's check is not its authority
 *
 * The partner presents the anon key as its bearer. That is a JWT this stack
 * signed, so the router admits it — which is exactly why the router's check
 * proves nothing here: every signed-in customer holds a token it would admit
 * too. For the payload door the authority is `X-Partner-Key`. For a ring there
 * is none, by design, and the limits plus "nothing in the ring is stored" are
 * what make that safe.
 *
 * ## The driver is never taken from the request, or from the answer
 *
 * The payload names the partner's own driver id. Which of OUR drivers that is,
 * if any, is decided inside the two `*_submission_record` RPCs from a
 * **confirmed** `partner_driver_links` row — the `send-document` rule applied
 * to the person a submission is about. An unconfirmed proposal resolves to
 * nothing and the submission waits, which is what makes M2's human confirmation
 * the only way a submission reaches a driver's record.
 *
 * ## What it may see
 *
 * `BASE_ENV`, the service role, `OTP_PEPPER`, `PARTNER_SEAL_KEY` and
 * `PARTNER_REIDEY_BASE_URL` — not the SMTP settings. This function sends no
 * mail, so it gets its own narrow list; handing it the mail credentials would
 * be a widening for nothing.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { corsFor } from '../_shared/http.ts'
import {
  answerForHint,
  parseNoteSubmission,
  partnerKeyHash,
  PARTNER_KEY_HEADER,
} from '../_shared/partner-intake-core.ts'
import {
  documentKey,
  parseReceiptSubmission,
  receiptProblemIsFinal,
} from '../_shared/partner-receipt-core.ts'
import {
  connectionIsBroken,
  CATCHUP_MAX,
  parseCatchUp,
  parseRing,
  pendingPath,
  readPendingAnswer,
  readSubmissionAnswer,
  submissionPath,
  type Ring,
  type RingKind,
} from '../_shared/partner-doorbell-core.ts'
import { PARTNER_ENDPOINT_VAR, partnerEndpoint } from '../_shared/partner-endpoint.ts'
import { openPartnerToken } from '../_shared/partner-token-seal.ts'

const PULL_TIMEOUT_MS = 15_000

interface Answer {
  status: number
  body: Record<string, unknown>
}

/**
 * Validate one submission and record it. The single place both doors reach, so
 * a payload that was pushed and one that was pulled are held to exactly the
 * same rules — the reason this is a function and not two copies.
 */
async function recordSubmission(
  admin: SupabaseClient,
  companyId: string,
  kind: RingKind,
  payload: Record<string, unknown>,
): Promise<Answer> {
  if (kind === 'receipt') {
    const parsed = parseReceiptSubmission(payload)
    if (!parsed.ok) {
      // A content fault is FINAL: the same photo would be refused the same way,
      // so a partner's queue must not retry it. A caller fault keeps its 400.
      const final = receiptProblemIsFinal(parsed.problem)
      return {
        status: final ? 200 : 400,
        body: {
          ok: false,
          reason: parsed.problem,
          ...(parsed.field ? { field: parsed.field } : {}),
        },
      }
    }
    const receipt = parsed.value
    const key = documentKey(companyId, receipt.external_submission_id, receipt.document.extension)

    // The photo FIRST, because a submission row that names a file nobody stored
    // is the state the whole slice exists to prevent: the reviewer sees a Beleg
    // and cannot open it. `upsert` so a retry overwrites its own object rather
    // than failing on a name it chose.
    const stored = await admin.storage.from('documents').upload(
      key,
      receipt.document.bytes,
      { contentType: receipt.document.contentType, upsert: true },
    )
    if (stored.error) return { status: 500, body: { ok: false, reason: 'storage_failed' } }

    const put = await admin.rpc('partner_receipt_submission_record', {
      p_company_id: companyId,
      p_partner: receipt.partner,
      p_external_submission_id: receipt.external_submission_id,
      p_external_driver_id: receipt.external_driver_id,
      p_receipt_date: receipt.receipt_date,
      p_category: receipt.category,
      p_description: receipt.description,
      p_amount: receipt.amount,
      p_payment_method: receipt.payment_method,
      p_postal_code: receipt.postal_code,
      p_document_path: key,
      p_captured_at: receipt.captured_at,
      p_confirmed_by_driver: receipt.confirmed_by_driver,
      p_read_by_agent: receipt.read_by_agent,
      p_raw_payload: null,
    })
    if (put.error) {
      const answer = answerForHint(put.error.hint)
      return { status: answer.status, body: answer.body as Record<string, unknown> }
    }
    const data = put.data as { submission_id: string; status: string; duplicate: boolean }
    return {
      status: 200,
      body: {
        ok: true,
        submission_id: data.submission_id,
        status: data.status,
        duplicate: data.duplicate,
      },
    }
  }

  const parsed = parseNoteSubmission(payload)
  if (!parsed.ok) {
    return {
      status: 400,
      body: {
        ok: false,
        reason: parsed.reason,
        ...(parsed.field ? { field: parsed.field } : {}),
      },
    }
  }
  const note = parsed.value

  const recorded = await admin.rpc('partner_note_submission_record', {
    p_company_id: companyId,
    p_partner: note.partner,
    p_external_submission_id: note.external_submission_id,
    p_external_driver_id: note.external_driver_id,
    p_note_type: note.note_type,
    p_note_text: note.note_text,
    p_start_date: note.start_date,
    p_end_date: note.end_date,
    p_is_full_day: note.is_full_day,
    p_start_time: note.start_time,
    p_end_time: note.end_time,
    // What arrived, kept verbatim for the reviewer and for a later dispute. It
    // is the payload, not our reading of it.
    p_raw_payload: payload,
  })
  if (recorded.error) {
    const answer = answerForHint(recorded.error.hint)
    return { status: answer.status, body: answer.body as Record<string, unknown> }
  }
  const data = recorded.data as { submission_id: string; status: string; duplicate: boolean }
  return {
    status: 200,
    body: {
      ok: true,
      submission_id: data.submission_id,
      status: data.status,
      duplicate: data.duplicate,
    },
  }
}

/** One authenticated GET to the partner, with a timeout and no retry. */
async function askPartner(origin: string, path: string, token: string): Promise<
  { ok: true; json: unknown } | { ok: false; reason: string }
> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PULL_TIMEOUT_MS)
  try {
    const answer = await fetch(`${origin}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (answer.status === 401 || answer.status === 403) return { ok: false, reason: 'token_rejected' }
    // The partner has no such submission. Final for this ring: no retry finds
    // it, and a ring for a submission nobody made lands here too.
    if (answer.status === 404) return { ok: false, reason: 'submission_not_found' }
    if (!answer.ok) return { ok: false, reason: 'partner_unavailable' }
    return { ok: true, json: await answer.json() }
  } catch {
    return { ok: false, reason: 'partner_unavailable' }
  } finally {
    clearTimeout(timer)
  }
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

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return respond({ ok: false, reason: 'invalid_body' }, 400)
  }

  const kind = typeof (body as Record<string, unknown>)?.kind === 'string'
    ? ((body as Record<string, unknown>).kind as string).trim().toLowerCase()
    : 'note'

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  if (serviceKey === '' || supabaseUrl === '') {
    // A misconfigured worker must not read as a refused submission.
    return respond({ ok: false, reason: 'server_error' }, 500)
  }
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ── the doorbell, and its catch-up ────────────────────────────────────────
  //
  //  `kind` on the wire selects the TRANSPORT and `subject` names which of the
  //  two things a ring is about, which is why they are separate fields: one
  //  field carrying both meanings is how a Beleg ends up ingested as a note.
  if (kind === 'doorbell' || kind === 'catchup') {
    // Both transports name a partner and a fleet; only a ring also names one
    // submission and its subject. Parsed as two steps rather than one result
    // narrowed by a cast -- the cast compiled under vitest and `deno check`
    // refused it, which is the third time this branch has been the one to say
    // so.
    const fleet = parseCatchUp(body)
    if (!fleet.ok) {
      return respond(
        { ok: false, reason: fleet.problem, ...(fleet.field ? { field: fleet.field } : {}) },
        400,
      )
    }
    let ring: Ring | null = null
    if (kind === 'doorbell') {
      const parsed = parseRing(body)
      if (!parsed.ok) {
        return respond(
          { ok: false, reason: parsed.problem, ...(parsed.field ? { field: parsed.field } : {}) },
          400,
        )
      }
      ring = parsed.value
    }

    const sealKey = Deno.env.get('PARTNER_SEAL_KEY') ?? ''
    if (sealKey === '') return respond({ ok: false, reason: 'seal_key_missing' }, 503)
    const endpoint = partnerEndpoint(Deno.env.get(PARTNER_ENDPOINT_VAR))
    if (!endpoint.ok) return respond({ ok: false, reason: endpoint.problem }, 503)

    // Counted before anything else happens, and counted for an unknown fleet
    // too — so enumerating fleet ids is bounded rather than free.
    const resolved = await admin.rpc('partner_doorbell_resolve', {
      p_partner: fleet.value.partner,
      p_external_company_id: fleet.value.fleet,
    })
    if (resolved.error) return respond({ ok: false, reason: 'server_error' }, 500)
    const plan = resolved.data as { ok?: boolean; reason?: string; company_id?: string }
    if (!plan?.ok || !plan.company_id) {
      // `rate_limited` gets a 429 so a partner's queue backs off; an unknown or
      // revoked fleet is a 200 with a reason, because retrying will not help.
      return respond(
        { ok: false, reason: plan?.reason ?? 'not_connected' },
        plan?.reason === 'rate_limited' ? 429 : 200,
      )
    }
    const companyId = plan.company_id

    const sealed = await admin.rpc('partner_sealed_token', {
      p_company_id: companyId,
      p_partner: fleet.value.partner,
    })
    if (sealed.error) return respond({ ok: false, reason: 'server_error' }, 500)
    const sealedToken = sealed.data as string | null
    if (!sealedToken) return respond({ ok: false, reason: 'not_connected' }, 200)

    let token: string
    try {
      const opened = await openPartnerToken(sealKey, sealedToken)
      if (!opened) return respond({ ok: false, reason: 'seal_unreadable' }, 409)
      token = opened
    } catch {
      return respond({ ok: false, reason: 'server_error' }, 500)
    }

    /** Fetch one submission and record it, naming every failure. */
    const ingest = async (id: string, subject: RingKind): Promise<Answer> => {
      const asked = await askPartner(endpoint.origin, submissionPath(id), token)
      if (!asked.ok) {
        return {
          status: asked.reason === 'partner_unavailable' ? 502 : 200,
          body: { ok: false, reason: asked.reason },
        }
      }
      const unwrapped = readSubmissionAnswer(asked.json, subject)
      if (!unwrapped.ok) return { status: 200, body: { ok: false, reason: unwrapped.problem } }
      return recordSubmission(admin, companyId, subject, unwrapped.payload)
    }

    /**
     * The connection carries the record: `last_pull_at` always, the error
     * otherwise — so a fleet whose ingestion is failing is visible on the
     * Connect card instead of silently not arriving.
     */
    const stamp = (error: string | null) => admin.rpc('partner_pull_record', {
      p_company_id: companyId,
      p_partner: fleet.value.partner,
      p_error: error,
    })

    if (ring) {
      const answer = await ingest(ring.submission, ring.subject)
      const reason = answer.body.ok === true ? null : String(answer.body.reason ?? 'failed')
      // A refusal is recorded, always. Silence was how the first real failure
      // went unnoticed: no log here, no row there, and the driver's app said
      // nothing — it took reading three databases to find it.
      if (reason !== null) {
        console.error(JSON.stringify({
          fn: 'partner-intake', step: 'ingest_refused',
          company: companyId, submission: ring.submission, subject: ring.subject,
          reason, connection_broken: connectionIsBroken(reason),
        }))
      }
      await stamp(connectionIsBroken(reason) ? reason : null)
      return respond(answer.body, answer.status)
    }

    // ── catch-up: what a lost ring leaves behind ───────────────────────────
    const listed = await askPartner(endpoint.origin, pendingPath(CATCHUP_MAX), token)
    if (!listed.ok) {
      await stamp(listed.reason)
      return respond(
        { ok: false, reason: listed.reason },
        listed.reason === 'partner_unavailable' ? 502 : 200,
      )
    }

    // The partner's list names each submission's subject, so the catch-up does
    // not guess which table a waiting submission belongs to.
    const rows = Array.isArray((listed.json as Record<string, unknown>)?.data)
      ? ((listed.json as Record<string, unknown>).data as Record<string, unknown>[])
      : []
    const ids = readPendingAnswer(listed.json)

    let ingested = 0
    let failed = 0
    const problems: string[] = []
    for (const id of ids.slice(0, CATCHUP_MAX)) {
      const row = rows.find(r => r?.id === id || r?.external_submission_id === id)
      const named = typeof row?.subject === 'string'
        ? row.subject.trim().toLowerCase()
        : typeof row?.kind === 'string' ? row.kind.trim().toLowerCase() : ''
      if (named !== 'note' && named !== 'receipt') {
        failed += 1
        if (!problems.includes('unknown_kind')) problems.push('unknown_kind')
        continue
      }
      const answer = await ingest(id, named)
      if (answer.body.ok === true) {
        ingested += 1
      } else {
        failed += 1
        const reason = String(answer.body.reason ?? 'failed')
        if (!problems.includes(reason)) problems.push(reason)
      }
    }

    await stamp(failed > 0 ? problems.join(',') : null)

    // `ok` is about the catch-up having run, and the counts say what it did. A
    // catch-up that ingested nothing because nothing was waiting and one that
    // failed on every submission must not look alike, which is what `failed`
    // and `problems` are for.
    return respond({
      ok: true,
      waiting: ids.length,
      ingested,
      failed,
      ...(problems.length > 0 ? { problems } : {}),
      ...(ids.length > CATCHUP_MAX ? { more: true } : {}),
    })
  }

  // ── the payload door: kept, generic, and unreachable without a key ───────
  // A kind this build does not know is a caller fault, not a rejected
  // submission, so it keeps its 400.
  if (kind !== 'note' && kind !== 'receipt') {
    return respond({ ok: false, reason: 'unknown_kind' }, 400)
  }

  const partnerKey = req.headers.get(PARTNER_KEY_HEADER)?.trim() ?? ''
  // No detail, and the same answer as a key that resolves to nothing below.
  if (partnerKey === '') return respond({ ok: false }, 403)

  const pepper = Deno.env.get('OTP_PEPPER') ?? ''
  if (pepper === '') return respond({ ok: false, reason: 'server_error' }, 500)

  // The partner name is read from the payload only to hash the key with it; the
  // payload's own validation happens inside recordSubmission, after the key has
  // resolved to a company. Before 08.10 a malformed body was answered 400 ahead
  // of the key check, which told an unauthenticated caller about its body.
  const named = typeof (body as Record<string, unknown>)?.partner === 'string'
    ? ((body as Record<string, unknown>).partner as string).trim().toLowerCase()
    : ''
  if (named === '') return respond({ ok: false }, 403)

  let keyHash: string
  try {
    keyHash = await partnerKeyHash(pepper, named, partnerKey)
  } catch {
    return respond({ ok: false, reason: 'server_error' }, 500)
  }

  const resolved = await admin.rpc('partner_credential_company', {
    p_partner: named,
    p_key_hash: keyHash,
  })
  if (resolved.error) return respond({ ok: false, reason: 'server_error' }, 500)

  const companyId = resolved.data as string | null
  // The same 403 with the same empty body as a missing header.
  if (!companyId) return respond({ ok: false }, 403)

  const answer = await recordSubmission(
    admin,
    companyId,
    kind,
    body as Record<string, unknown>,
  )
  return respond(answer.body, answer.status)
})
