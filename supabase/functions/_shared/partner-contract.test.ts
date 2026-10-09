/**
 * The two halves agree, and this is the only way to prove it without a deploy.
 *
 * Our side and Reidey's are separate products in separate repositories, and the
 * only thing joining them is a JSON shape. Nothing in either build fails when
 * that shape drifts: a field they rename, a number they start sending unquoted,
 * a date they switch to German formatting all compile fine on both sides and
 * surface as a submission that is silently refused — or worse, one that is
 * accepted with the wrong figure, because accepting a Beleg writes a row that
 * moves money.
 *
 * So this file holds the answers Reidey's endpoints actually produce,
 * transcribed from its controller on the branch
 * `feat/elprofessor-driver-documents` (`ElProfessorController::submission()`
 * and `submissions()`), and runs them through the parsers that decide whether a
 * submission may be recorded. It is the same idea as
 * `notificationSelection.parity.test.ts`: two implementations that cannot import
 * each other, pinned to one set of answers.
 *
 * **When a field moves on either side, this test is what fails.** It is not a
 * mock of our own code — every expectation below is a value the other product
 * emits, with its PHP type.
 *
 * ## Two transcriptions worth their own line
 *
 * `external_driver_id` is `(string) $row->driver_id` — a PHP integer cast to a
 * string, because our parser refuses a non-string and a driver id that arrived
 * as a number would make every submission `invalid_request`.
 *
 * `document` is `base64_encode($disk->get(...))` and is **absent** when the row
 * names a file the disk does not have. An empty string there would reach us as
 * a photo we cannot read; absent makes us refuse the submission by name, which
 * is what the reviewer needs to see.
 */
import { describe, expect, it } from 'vitest'
import { parseReceiptSubmission } from './partner-receipt-core'
import { parseNoteSubmission } from './partner-intake-core'
import { parseRing, readPendingAnswer, readSubmissionAnswer } from './partner-doorbell-core'

/** 'JPEGBYTES' is what Reidey's own test writes to the fake disk. */
const JPEG_BASE64 = 'Qk0='
const REAL_JPEG_BASE64 = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))

/**
 * `GET /api/v1/elprofessor/submissions/{uuid}` for a receipt, exactly as the
 * controller builds it: the driver's payload verbatim, then the five fields it
 * merges in, then the photo.
 */
const receiptAnswer = {
  data: {
    // the driver's payload, from DriverSubmissionController's validator
    receipt_date: '2026-10-07',
    amount: '41.47',
    category: 'Tanken',
    description: null,
    payment_method: 'bar',
    postal_code: '10115',
    // merged by submission()
    kind: 'receipt',
    subject: 'receipt',
    partner: 'reidey',
    external_submission_id: '0f6e8a1c-6d2e-4c9a-9f3d-2b1a7c4e5d60',
    external_driver_id: '41',
    document: REAL_JPEG_BASE64,
    content_type: 'image/jpeg',
  },
}

/** The same, for a note. */
const noteAnswer = {
  data: {
    note_type: 'breakdown',
    note_text: 'Panne auf der A100',
    start_date: '2026-10-07',
    end_date: '2026-10-07',
    is_full_day: false,
    start_time: '08:00',
    end_time: '10:30',
    kind: 'note',
    subject: 'note',
    partner: 'reidey',
    external_submission_id: '7c1d9b02-3f54-4a18-8e7b-0d5c2a9f1e34',
    external_driver_id: '41',
  },
}

describe("Reidey's receipt answer, through our parser", () => {
  it('is unwrapped and accepted exactly as it arrives', () => {
    const unwrapped = readSubmissionAnswer(receiptAnswer, 'receipt')
    expect(unwrapped.ok).toBe(true)
    if (!unwrapped.ok) return

    const parsed = parseReceiptSubmission(unwrapped.payload)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    // Every value that reaches a `receipts` row, against what they sent.
    expect(parsed.value.amount).toBe('41.47')
    expect(parsed.value.category).toBe('Tanken')
    expect(parsed.value.payment_method).toBe('bar')
    expect(parsed.value.postal_code).toBe('10115')
    expect(parsed.value.receipt_date).toBe('2026-10-07')
    expect(parsed.value.external_driver_id).toBe('41')
    expect(parsed.value.document.contentType).toBe('image/jpeg')
  })

  // `(string) $row->driver_id` in the controller. Without the cast it is a PHP
  // integer, and our parser refuses a non-string outright.
  it('breaks if they stop casting the driver id to a string', () => {
    const drifted = { data: { ...receiptAnswer.data, external_driver_id: 41 } }
    const unwrapped = readSubmissionAnswer(drifted, 'receipt')
    expect(unwrapped.ok).toBe(true)
    if (!unwrapped.ok) return
    expect(parseReceiptSubmission(unwrapped.payload))
      .toEqual({ ok: false, problem: 'invalid_request', field: 'external_driver_id' })
  })

  // Their validator pins `regex:/^\d{1,8}(\.\d{1,2})?$/` for the same reason:
  // the figure reaches a driver's balance.
  it('breaks if an amount ever arrives in German formatting', () => {
    const drifted = { data: { ...receiptAnswer.data, amount: '41,47' } }
    const unwrapped = readSubmissionAnswer(drifted, 'receipt')
    expect(unwrapped.ok).toBe(true)
    if (!unwrapped.ok) return
    expect(parseReceiptSubmission(unwrapped.payload))
      .toEqual({ ok: false, problem: 'invalid_amount' })
  })

  // The controller omits `document` when the disk does not have the file.
  it('refuses a receipt whose photo was absent from the answer', () => {
    const { document: _omitted, ...withoutPhoto } = receiptAnswer.data
    const unwrapped = readSubmissionAnswer({ data: withoutPhoto }, 'receipt')
    expect(unwrapped.ok).toBe(true)
    if (!unwrapped.ok) return
    expect(parseReceiptSubmission(unwrapped.payload))
      .toEqual({ ok: false, problem: 'document_missing' })
  })

  // And a photo that is there but is not an image: their validator admits
  // jpg/jpeg/png/pdf by EXTENSION, which is a claim about the file's name.
  it('refuses a photo whose bytes are not an image, whatever they called it', () => {
    const drifted = { data: { ...receiptAnswer.data, document: JPEG_BASE64 } }
    const unwrapped = readSubmissionAnswer(drifted, 'receipt')
    expect(unwrapped.ok).toBe(true)
    if (!unwrapped.ok) return
    expect(parseReceiptSubmission(unwrapped.payload))
      .toEqual({ ok: false, problem: 'document_type_unsupported' })
  })
})

describe("Reidey's note answer, through our parser", () => {
  it('is unwrapped and accepted exactly as it arrives', () => {
    const unwrapped = readSubmissionAnswer(noteAnswer, 'note')
    expect(unwrapped.ok).toBe(true)
    if (!unwrapped.ok) return

    const parsed = parseNoteSubmission(unwrapped.payload)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.note_type).toBe('breakdown')
    expect(parsed.value.note_text).toBe('Panne auf der A100')
    expect(parsed.value.start_time).toBe('08:00')
    expect(parsed.value.end_time).toBe('10:30')
    expect(parsed.value.is_full_day).toBe(false)
  })

  // The ring decided which of our two tables was about to be written, so this
  // disagreement is the one case where ingesting anyway is actively wrong.
  it('is refused when their answer says one kind and the ring said the other', () => {
    expect(readSubmissionAnswer(noteAnswer, 'receipt'))
      .toEqual({ ok: false, problem: 'answer_kind_mismatch' })
  })

  /*
    The three absence types, and WHERE they are refused — measured, because the
    first version of this test asserted the wrong layer and failed.

    `parseNoteSubmission` ACCEPTS `sick`, `vacation` and `off`: the seven-type
    allow-list lives in `partner_note_submission_record`
    (`c_transferable`, 20261007110000), so the wall is the database's and the
    refusal arrives as a hint the function maps. Reidey's own validator offers
    only the seven, so none of them is ever sent — but if one were, it would be
    stored by nobody and refused with a reason, not silently dropped here.

    Do not "fix" this by adding the list to the parser as well: two copies of a
    closed vocabulary drift, and the one that decides is the one in the
    transaction that writes. `tests/rls/partner-note-intake.sql` probes it.
  */
  it.each(['sick', 'vacation', 'off'])('lets the absence type %s past the PARSER, by design', (type) => {
    const drifted = { data: { ...noteAnswer.data, note_type: type } }
    const unwrapped = readSubmissionAnswer(drifted, 'note')
    expect(unwrapped.ok).toBe(true)
    if (!unwrapped.ok) return
    // Accepted here, refused by the database. The division is the point.
    expect(parseNoteSubmission(unwrapped.payload).ok).toBe(true)
  })
})

describe("Reidey's pending list, through our reader", () => {
  /** `GET /api/v1/elprofessor/submissions`, as submissions() builds it. */
  const list = {
    data: [
      {
        id: '0f6e8a1c-6d2e-4c9a-9f3d-2b1a7c4e5d60',
        subject: 'receipt',
        status: 'pending',
        created_at: '2026-10-07T06:21:00+00:00',
        document_bytes: 184320,
      },
      {
        id: '7c1d9b02-3f54-4a18-8e7b-0d5c2a9f1e34',
        subject: 'note',
        status: 'pending',
        created_at: '2026-10-07T07:02:00+00:00',
        document_bytes: null,
      },
    ],
    meta: { per_page: 25, tenant_id: 7 },
  }

  it('reads the ids in the order they are waiting', () => {
    expect(readPendingAnswer(list)).toEqual([
      '0f6e8a1c-6d2e-4c9a-9f3d-2b1a7c4e5d60',
      '7c1d9b02-3f54-4a18-8e7b-0d5c2a9f1e34',
    ])
  })

  it('carries each submission`s subject, so the catch-up never guesses the table', () => {
    // The catch-up reads `subject` off each row and skips a row it cannot
    // place, rather than defaulting it to a note.
    expect(list.data.map(r => r.subject)).toEqual(['receipt', 'note'])
  })

  it('carries no payload and no photo', () => {
    for (const row of list.data) {
      expect(row).not.toHaveProperty('amount')
      expect(row).not.toHaveProperty('document')
      expect(row).not.toHaveProperty('payload')
    }
  })
})

describe("Reidey's ring, through our parser", () => {
  /** The body `RingElProfessor::handle()` posts, field for field. */
  const ring = {
    kind: 'doorbell',
    partner: 'reidey',
    fleet: '7',
    submission: '0f6e8a1c-6d2e-4c9a-9f3d-2b1a7c4e5d60',
    subject: 'receipt',
  }

  it('is read, and `fleet` is the string Connect stored', () => {
    // Connect stores `String(fleet.tenant_id).trim()`; the ring sends
    // `(string) $row->tenant_id`. Both are '7', and `partner_doorbell_resolve`
    // compares them as text — so a cast dropped on either side makes every
    // ring answer `not_connected` with nothing in any log to say why.
    const parsed = parseRing(ring)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.fleet).toBe('7')
    expect(parsed.value.subject).toBe('receipt')
    expect(parsed.value.partner).toBe('reidey')
  })

  it('is five fields and we read four of them', () => {
    // `kind` is the transport and is read before this parser. If they ever send
    // a sixth field it is ignored, which is deliberate: a ring cannot assert
    // anything about the submission it names.
    expect(Object.keys(ring).sort()).toEqual(
      ['fleet', 'kind', 'partner', 'subject', 'submission'],
    )
  })
})
