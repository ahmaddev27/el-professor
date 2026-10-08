/**
 * The pure half of the doorbell: what a ring may say, and what the partner's
 * answer has to look like before we believe it.
 *
 * Imports nothing from Deno, `npm:` or `jsr:`, so vitest loads it.
 *
 * ## The ring carries nothing we store
 *
 * Owner's decision of 08.10.2026, on a measurement: Reidey cannot replay the
 * token it issued (Sanctum keeps only a hash), and `partner-intake`'s door
 * authenticates with exactly that token. So the partner **rings** — four
 * fields, no payload, no credential — and we fetch the submission with the
 * token we hold sealed.
 *
 * That makes a forged ring harmless by construction, and it is why this module
 * validates the ring so narrowly: the only thing a ring can do is name a
 * submission at the partner. It cannot assert its contents, its driver, its
 * amount or its company. A ring for a submission that does not exist costs one
 * request that answers 404.
 *
 * ## Why the answer is validated and not trusted
 *
 * We asked for it over an authenticated channel to a validated host, so the
 * answer is from the partner — but "from the partner" is not "well formed".
 * Their fields are theirs: a field they rename, a number they start sending as
 * a float, a date they switch to German format are all things that would
 * otherwise land in `receipts` and move a driver's balance. So the answer goes
 * through the same two parsers a push would have gone through
 * (`parseNoteSubmission`, `parseReceiptSubmission`), and this module's job is
 * only to unwrap it and name which parser it belongs to.
 */

/**
 * The two subjects a driver can submit. The ring names which it is, in a field
 * of its own: `kind` on the wire selects the TRANSPORT (`doorbell`, `catchup`,
 * or a pushed `note`/`receipt`), so the subject needs a second name or the two
 * meanings collide on one field.
 */
export const RING_KINDS = ['note', 'receipt'] as const
export type RingKind = (typeof RING_KINDS)[number]

export type RingProblem =
  | 'invalid_body'
  | 'invalid_request'
  | 'unknown_kind'

export interface Ring {
  partner: string
  /** The partner's own id for the fleet, which we resolve to one company. */
  fleet: string
  /** The partner's own id for the submission, which we fetch by. */
  submission: string
  /** Which of the two subjects it is, from the ring's `subject` field. */
  subject: RingKind
}

/** A catch-up names a fleet and nothing else: it asks what is waiting. */
export interface CatchUp {
  partner: string
  fleet: string
}

export type RingParseResult =
  | { ok: true; value: Ring }
  | { ok: false; problem: RingProblem; field?: string }

export type CatchUpParseResult =
  | { ok: true; value: CatchUp }
  | { ok: false; problem: RingProblem; field?: string }

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * The partner and the fleet, which both a ring and a catch-up carry. Anything
 * else in the body is ignored rather than refused — a partner adding a field of
 * its own must not break ingestion, and nothing it adds is read.
 */
function parseFleet(body: unknown): CatchUpParseResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, problem: 'invalid_body' }
  }
  const b = body as Record<string, unknown>
  const partner = text(b.partner)
  const fleet = text(b.fleet)
  for (const [field, value] of [['partner', partner], ['fleet', fleet]] as const) {
    if (value === null) return { ok: false, problem: 'invalid_request', field }
  }
  return {
    ok: true,
    value: { partner: (partner as string).toLowerCase(), fleet: fleet as string },
  }
}

/** A catch-up: a fleet to ask what is waiting for. */
export function parseCatchUp(body: unknown): CatchUpParseResult {
  return parseFleet(body)
}

/** A ring: a fleet, one submission at the partner, and which subject it is. */
export function parseRing(body: unknown): RingParseResult {
  const fleet = parseFleet(body)
  if (!fleet.ok) return fleet
  const b = body as Record<string, unknown>

  const submission = text(b.submission)
  if (submission === null) {
    return { ok: false, problem: 'invalid_request', field: 'submission' }
  }

  // The subject is NOT defaulted. The two are recorded in different tables and
  // shown on different screens, and a Beleg ingested as a note would lose its
  // photo and its amount with a 200 on the ring.
  const subject = text(b.subject)?.toLowerCase() ?? null
  if (subject === null || !(RING_KINDS as readonly string[]).includes(subject)) {
    return { ok: false, problem: 'unknown_kind' }
  }

  return {
    ok: true,
    value: {
      partner: fleet.value.partner,
      fleet: fleet.value.fleet,
      submission,
      subject: subject as RingKind,
    },
  }
}

/**
 * Where one submission is fetched from. Built here rather than interpolated at
 * the call site so the id is encoded exactly once: a partner id with a slash or
 * a `..` in it would otherwise reach a different route of theirs.
 */
export function submissionPath(submissionId: string): string {
  return `/api/v1/elprofessor/submissions/${encodeURIComponent(submissionId)}`
}

/** Where the catch-up list is fetched from, newest first, one page. */
export function pendingPath(limit: number): string {
  const capped = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 25
  return `/api/v1/elprofessor/submissions?status=pending&per_page=${capped}`
}

/**
 * The partner answers `{ data: … }` like every other route of theirs. This
 * unwraps it and says which parser the payload belongs to, and nothing more:
 * the payload itself is not inspected here, because the two parsers are what
 * decide whether it may be recorded.
 */
export type AnswerResult =
  | { ok: true; kind: RingKind; payload: Record<string, unknown> }
  | { ok: false; problem: 'answer_unreadable' | 'answer_kind_mismatch' }

export function readSubmissionAnswer(answer: unknown, expected: RingKind): AnswerResult {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    return { ok: false, problem: 'answer_unreadable' }
  }
  const data = (answer as Record<string, unknown>).data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, problem: 'answer_unreadable' }
  }
  const payload = data as Record<string, unknown>

  // The partner names the kind in its own answer, and it must agree with the
  // ring. A disagreement is the one case where ingesting anyway would be
  // actively wrong — the ring decided which table we were about to write.
  const kind = typeof payload.kind === 'string' ? payload.kind.trim().toLowerCase() : null
  if (kind !== null && kind !== expected) {
    return { ok: false, problem: 'answer_kind_mismatch' }
  }

  return { ok: true, kind: expected, payload }
}

/** The ids in a catch-up list, in order, with anything unreadable dropped. */
export function readPendingAnswer(answer: unknown): string[] {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return []
  const data = (answer as Record<string, unknown>).data
  if (!Array.isArray(data)) return []
  const out: string[] = []
  for (const row of data) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const id = text((row as Record<string, unknown>).id)
      ?? text((row as Record<string, unknown>).external_submission_id)
    if (id !== null && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * How many submissions one catch-up may ingest. A cap and not a loop to
 * exhaustion: a catch-up is a button somebody pressed, each submission is a
 * request to the partner plus an upload, and a fleet with a thousand waiting
 * receipts must not turn one click into a thousand round trips inside one
 * worker's lifetime. Pressing again continues.
 */
export const CATCHUP_MAX = 25
