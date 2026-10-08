/**
 * What a partner's driver app submits to us. M3 carries one kind — a note —
 * and the receipt is M4's branch here rather than a function of its own.
 *
 * ## Why a `kind` and not a second function
 *
 * `send-document`'s reasoning, applied again: every new function costs a line
 * in `PUBLIC_FUNCTIONS`/`FUNCTION_ENV`, a line in `deploy/docker-compose.yml`,
 * and a decision about what environment it may see. A `kind` costs a branch.
 * M4's receipt shares this function's authentication, its idempotency contract
 * and its answer shape, and differs only in what it records.
 *
 * ## It is NOT in PUBLIC_FUNCTIONS, and the router's check is not its authority
 *
 * The partner presents the anon key as its bearer. That is a JWT this stack
 * signed, so the router admits it — which is exactly why the router's check
 * proves nothing here: every signed-in customer holds a token it would admit
 * too. The authority is the `X-Partner-Key` header, hashed with `OTP_PEPPER`
 * and resolved to one company by `public.partner_credential_company`, which is
 * service-role only and reads a table in `app_private` that no API role can
 * reach.
 *
 * A key that resolves to nothing is `403` with no detail. A prober learns that
 * the key is wrong and nothing else: not which part of it, not whether the
 * partner name exists, and not whether any company is connected.
 *
 * ## The driver is never taken from the request
 *
 * The body names the partner's own driver id. Which of OUR drivers that is, if
 * any, is decided inside `partner_note_submission_record` from a **confirmed**
 * `partner_driver_links` row — the `send-document` rule ("the recipient's
 * address is never taken from the request") applied to the person a note is
 * about. An unconfirmed proposal resolves to nothing and the submission waits,
 * which is what makes M2's human confirmation the only way a note reaches a
 * driver's record.
 *
 * ## What it may see
 *
 * `BASE_ENV`, the service role, and `OTP_PEPPER` — not the SMTP settings. The
 * pepper is bundled with them in `OTP_MAIL_ENV` for the functions that send
 * mail; this one sends none, so it gets its own narrow list. Handing it the
 * mail credentials would be a widening for nothing, and the whole point of
 * `FUNCTION_ENV` is that each worker sees only what it needs.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
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

  const partnerKey = req.headers.get(PARTNER_KEY_HEADER)?.trim() ?? ''
  // No detail, and the same answer as a key that resolves to nothing below.
  if (partnerKey === '') return respond({ ok: false }, 403)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return respond({ ok: false, reason: 'invalid_body' }, 400)
  }

  const kind = typeof (body as Record<string, unknown>)?.kind === 'string'
    ? ((body as Record<string, unknown>).kind as string).trim().toLowerCase()
    : 'note'
  // A kind this build does not know is a caller fault, not a rejected
  // submission, so it keeps its 400.
  if (kind !== 'note' && kind !== 'receipt') {
    return respond({ ok: false, reason: 'unknown_kind' }, 400)
  }

  // Parsed per kind, because the two subjects validate nothing in common
  // beyond the partner name — and the Beleg's photo has to be decoded and
  // sniffed before anything is stored.
  const noteParsed = kind === 'note' ? parseNoteSubmission(body) : null
  const receiptParsed = kind === 'receipt' ? parseReceiptSubmission(body) : null

  if (noteParsed && !noteParsed.ok) {
    return respond(
      { ok: false, reason: noteParsed.reason, ...(noteParsed.field ? { field: noteParsed.field } : {}) },
      400,
    )
  }
  if (receiptParsed && !receiptParsed.ok) {
    // A content fault is FINAL: the same photo would be refused the same
    // way, so a queue must not retry it. A caller fault keeps its 400.
    const final = receiptProblemIsFinal(receiptParsed.problem)
    return respond(
      {
        ok: false,
        reason: receiptParsed.problem,
        ...(receiptParsed.field ? { field: receiptParsed.field } : {}),
      },
      final ? 200 : 400,
    )
  }

  const subject = noteParsed?.ok ? noteParsed.value : receiptParsed!.value!
  const note = noteParsed?.ok ? noteParsed.value : null

  const pepper = Deno.env.get('OTP_PEPPER') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (pepper === '' || serviceKey === '') {
    // A misconfigured worker must not read as a refused submission.
    return respond({ ok: false, reason: 'server_error' }, 500)
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    serviceKey,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  let keyHash: string
  try {
    keyHash = await partnerKeyHash(pepper, subject.partner, partnerKey)
  } catch {
    return respond({ ok: false, reason: 'server_error' }, 500)
  }

  const resolved = await admin.rpc('partner_credential_company', {
    p_partner: subject.partner,
    p_key_hash: keyHash,
  })
  if (resolved.error) return respond({ ok: false, reason: 'server_error' }, 500)

  const companyId = resolved.data as string | null
  // The same 403 with the same empty body as a missing header.
  if (!companyId) return respond({ ok: false }, 403)

  if (kind === 'receipt') {
    const receipt = receiptParsed!.value!
    const key = documentKey(companyId, receipt.external_submission_id, receipt.document.extension)

    // The photo FIRST, because a submission row that names a file nobody
    // stored is the state the whole slice exists to prevent: the reviewer
    // sees a Beleg and cannot open it. `upsert` so a partner's retry
    // overwrites its own object rather than failing on a name it chose.
    const stored = await admin.storage.from('documents').upload(
      key,
      receipt.document.bytes,
      { contentType: receipt.document.contentType, upsert: true },
    )
    if (stored.error) return respond({ ok: false, reason: 'storage_failed' }, 500)

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
      return respond(answer.body, answer.status)
    }
    const data = put.data as { submission_id: string; status: string; duplicate: boolean }
    return respond({
      ok: true,
      submission_id: data.submission_id,
      status: data.status,
      duplicate: data.duplicate,
    })
  }

  const recorded = await admin.rpc('partner_note_submission_record', {
    p_company_id: companyId,
    p_partner: subject.partner,
    p_external_submission_id: note!.external_submission_id,
    p_external_driver_id: note!.external_driver_id,
    p_note_type: note!.note_type,
    p_note_text: note!.note_text,
    p_start_date: note!.start_date,
    p_end_date: note!.end_date,
    p_is_full_day: note!.is_full_day,
    p_start_time: note!.start_time,
    p_end_time: note!.end_time,
    // What arrived, kept verbatim for the reviewer and for a later dispute. It
    // is the body, not our reading of it.
    p_raw_payload: body,
  })

  if (recorded.error) {
    const answer = answerForHint(recorded.error.hint)
    return respond(answer.body, answer.status)
  }

  const data = recorded.data as { submission_id: string; status: string; duplicate: boolean }
  return respond({
    ok: true,
    submission_id: data.submission_id,
    status: data.status,
    duplicate: data.duplicate,
  })
})
