/**
 * The pure half of `partner-intake`: the key's hash, the body's shape, and what
 * each database refusal becomes on the wire.
 *
 * It imports nothing from Deno, `npm:` or `jsr:`, so vitest loads it — the rule
 * every `_shared` module with a test file follows.
 *
 * ## What this validates, and what it deliberately does not
 *
 * It checks that the fields are present and of the right JSON type, and nothing
 * about their meaning. Which note types may cross, whether `25:00` is a time,
 * and how long a range may be are decided in
 * `public.partner_note_submission_record` and nowhere else. Copying the
 * allow-list here would create a second place to forget a type, and the two
 * would drift in the direction that matters: this side would admit something
 * the database then refuses, or — worse — refuse something it would admit, so a
 * driver's note disappears with a reason nobody wrote.
 *
 * ## Why a refusal is 200 and not 4xx
 *
 * A partner's queue retries a 4xx or 5xx. "This note type may not be
 * transferred" and "25:00 is not a time" are **final**: retrying sends the same
 * note again and gets the same answer, so the shape is
 * `200 {ok: false, reason}` — the `driver_has_no_email` precedent in
 * `send-document`. Only two things are not final and keep their status: a
 * malformed request, which is a fault in the caller's code (400), and an
 * unexpected database error (500), which a retry may well clear.
 *
 * A wrong key is `403` with **no body detail at all**: a prober learns whether
 * the key is wrong, never which part of it, and never whether the company
 * exists.
 */

export const PARTNER_KEY_HEADER = 'X-Partner-Key'

/** The reasons this module and the database produce, as the wire sees them. */
export type IntakeReason =
  | 'invalid_body'
  | 'invalid_request'
  | 'note_type_not_transferable'
  | 'unknown_note_type'
  | 'invalid_start_time'
  | 'invalid_end_time'
  | 'invalid_range'
  | 'range_too_long'
  | 'server_error'

export interface NoteSubmissionInput {
  partner: string
  external_submission_id: string
  external_driver_id: string
  note_type: string
  note_text: string
  start_date: string | null
  end_date: string | null
  is_full_day: boolean
  start_time: string | null
  end_time: string | null
}

export type ParseResult =
  | { ok: true; value: NoteSubmissionInput }
  | { ok: false; reason: 'invalid_body' | 'invalid_request'; field?: string }

/**
 * `key_hash = lowercase hex of HMAC-SHA256(OTP_PEPPER, "<partner>:<key>")`.
 *
 * The partner name is inside the message rather than beside it, so one partner's
 * key cannot be replayed as another's even if the same secret were ever issued
 * twice. `partner_connection_record` stores exactly this and refuses anything
 * that is not 64 hex characters.
 *
 * The pepper is an existing secret `deploy.sh` already guards at 32 characters
 * and that staging does not share with production, so this adds no environment
 * variable and no deploy check.
 */
export async function partnerKeyHash(
  pepper: string,
  partner: string,
  key: string,
): Promise<string> {
  if (pepper.length < 32) throw new Error('partnerKeyHash: the pepper is too short')
  const encoder = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signed = await crypto.subtle.sign(
    'HMAC', cryptoKey, encoder.encode(`${normalisePartner(partner)}:${key}`),
  )
  return [...new Uint8Array(signed)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Lower-cased and trimmed, the form the database's CHECK demands. */
export function normalisePartner(partner: string): string {
  return partner.trim().toLowerCase()
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Reads one note submission out of a request body.
 *
 * `note_text` is the one field that may legitimately be empty, so it is read
 * with its own rule rather than through `text()`: an absent text is `''`, which
 * is what the column stores by default. The owner's decision of 07.10.2026 is
 * that the text crosses, and for the seven types that may cross it is the
 * content — but a note submitted without one is still a note.
 */
export function parseNoteSubmission(body: unknown): ParseResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'invalid_body' }
  }
  const b = body as Record<string, unknown>

  const partner = text(b.partner)
  const submissionId = text(b.external_submission_id)
  const driverId = text(b.external_driver_id)
  const noteType = text(b.note_type)

  for (const [field, value] of [
    ['partner', partner],
    ['external_submission_id', submissionId],
    ['external_driver_id', driverId],
    ['note_type', noteType],
  ] as const) {
    if (value === null) return { ok: false, reason: 'invalid_request', field }
  }

  if (b.note_text !== undefined && b.note_text !== null && typeof b.note_text !== 'string') {
    return { ok: false, reason: 'invalid_request', field: 'note_text' }
  }

  for (const field of ['start_date', 'end_date'] as const) {
    const value = text(b[field])
    if (value !== null && !ISO_DATE.test(value)) {
      return { ok: false, reason: 'invalid_request', field }
    }
  }

  if (b.is_full_day !== undefined && b.is_full_day !== null && typeof b.is_full_day !== 'boolean') {
    return { ok: false, reason: 'invalid_request', field: 'is_full_day' }
  }

  return {
    ok: true,
    value: {
      partner: normalisePartner(partner as string),
      external_submission_id: submissionId as string,
      external_driver_id: driverId as string,
      note_type: (noteType as string).toLowerCase(),
      note_text: typeof b.note_text === 'string' ? b.note_text : '',
      start_date: text(b.start_date),
      end_date: text(b.end_date),
      is_full_day: b.is_full_day === true,
      start_time: text(b.start_time),
      end_time: text(b.end_time),
    },
  }
}

/** The hints the database raises, and the status each one answers with. */
const FINAL_REASONS: ReadonlySet<string> = new Set([
  'note_type_not_transferable',
  'unknown_note_type',
  'invalid_start_time',
  'invalid_end_time',
  'invalid_range',
  'range_too_long',
])

export interface WireAnswer {
  status: number
  body: { ok: boolean; reason?: string; submission_id?: string; duplicate?: boolean }
}

/**
 * Turns a database refusal into the answer the partner's queue should see.
 *
 * A hint this build does not know becomes a 500, never a silent 200: an unknown
 * refusal is exactly the case where the caller must retry and a person must
 * look, and answering 200 would make a new database refusal look like a
 * rejected note.
 */
export function answerForHint(hint: string | null | undefined): WireAnswer {
  const reason = (hint ?? '').trim()
  if (reason === 'invalid_request') return { status: 400, body: { ok: false, reason } }
  if (FINAL_REASONS.has(reason)) return { status: 200, body: { ok: false, reason } }
  return { status: 500, body: { ok: false, reason: 'server_error' } }
}
