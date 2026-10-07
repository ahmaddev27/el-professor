import { describe, expect, it } from 'vitest'
import {
  answerForHint,
  normalisePartner,
  parseNoteSubmission,
  partnerKeyHash,
  PARTNER_KEY_HEADER,
} from './partner-intake-core'

const PEPPER = 'x'.repeat(32)

describe('partnerKeyHash', () => {
  it('is 64 lowercase hex characters, the form partner_connection_record demands', async () => {
    const hash = await partnerKeyHash(PEPPER, 'reidey', 'secret-token')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic, or a stored hash could never be matched again', async () => {
    const a = await partnerKeyHash(PEPPER, 'reidey', 'secret-token')
    const b = await partnerKeyHash(PEPPER, 'reidey', 'secret-token')
    expect(a).toBe(b)
  })

  it('binds the partner into the message, so one partner cannot replay another', async () => {
    const reidey = await partnerKeyHash(PEPPER, 'reidey', 'same-token')
    const other = await partnerKeyHash(PEPPER, 'anderer', 'same-token')
    expect(reidey).not.toBe(other)
  })

  it('reads the partner name in its normalised form, so casing cannot fork the hash', async () => {
    const plain = await partnerKeyHash(PEPPER, 'reidey', 't')
    const shouting = await partnerKeyHash(PEPPER, '  REIDEY ', 't')
    expect(shouting).toBe(plain)
  })

  it('separates the key, so a different key is a different hash', async () => {
    const a = await partnerKeyHash(PEPPER, 'reidey', 'one')
    const b = await partnerKeyHash(PEPPER, 'reidey', 'two')
    expect(a).not.toBe(b)
  })

  it('refuses a pepper under 32 characters rather than producing a weak hash', async () => {
    await expect(partnerKeyHash('short', 'reidey', 't')).rejects.toThrow(/pepper is too short/)
  })
})

describe('normalisePartner', () => {
  it('trims and lower-cases, the form the column CHECK demands', () => {
    expect(normalisePartner('  Reidey ')).toBe('reidey')
  })
})

describe('parseNoteSubmission', () => {
  const good = {
    partner: 'reidey',
    external_submission_id: 'sub-1',
    external_driver_id: 'drv-1',
    note_type: 'breakdown',
    note_text: 'Panne auf der A100',
  }

  it('reads a complete body', () => {
    const result = parseNoteSubmission(good)
    expect(result).toEqual({
      ok: true,
      value: {
        partner: 'reidey',
        external_submission_id: 'sub-1',
        external_driver_id: 'drv-1',
        note_type: 'breakdown',
        note_text: 'Panne auf der A100',
        start_date: null,
        end_date: null,
        is_full_day: false,
        start_time: null,
        end_time: null,
      },
    })
  })

  it.each(['partner', 'external_submission_id', 'external_driver_id', 'note_type'])(
    'refuses a body with no %s, naming the field',
    (field) => {
      const body: Record<string, unknown> = { ...good }
      delete body[field]
      expect(parseNoteSubmission(body)).toEqual({ ok: false, reason: 'invalid_request', field })
    },
  )

  it('treats a blank string as absent', () => {
    expect(parseNoteSubmission({ ...good, partner: '   ' }))
      .toEqual({ ok: false, reason: 'invalid_request', field: 'partner' })
  })

  it('refuses something that is not an object at all', () => {
    for (const body of [null, 'a string', 42, [1, 2]]) {
      expect(parseNoteSubmission(body)).toEqual({ ok: false, reason: 'invalid_body' })
    }
  })

  it('lets note_text be absent, because an empty note is still a note', () => {
    const body: Record<string, unknown> = { ...good }
    delete body.note_text
    const result = parseNoteSubmission(body)
    expect(result.ok && result.value.note_text).toBe('')
  })

  it('refuses a note_text that is not a string, rather than coercing it', () => {
    expect(parseNoteSubmission({ ...good, note_text: { de: 'x' } }))
      .toEqual({ ok: false, reason: 'invalid_request', field: 'note_text' })
  })

  it('lower-cases the note type, so the database compares one form', () => {
    const result = parseNoteSubmission({ ...good, note_type: 'BREAKDOWN' })
    expect(result.ok && result.value.note_type).toBe('breakdown')
  })

  it.each(['start_date', 'end_date'])('refuses a %s that is not ISO', (field) => {
    expect(parseNoteSubmission({ ...good, [field]: '01.05.2026' }))
      .toEqual({ ok: false, reason: 'invalid_request', field })
  })

  it('takes an ISO range as given', () => {
    const result = parseNoteSubmission({ ...good, start_date: '2026-05-01', end_date: '2026-05-03' })
    expect(result.ok && [result.value.start_date, result.value.end_date])
      .toEqual(['2026-05-01', '2026-05-03'])
  })

  it('refuses a non-boolean is_full_day instead of reading it as true', () => {
    expect(parseNoteSubmission({ ...good, is_full_day: 'yes' }))
      .toEqual({ ok: false, reason: 'invalid_request', field: 'is_full_day' })
  })

  it('passes the times through untouched — the database decides whether 25:00 is a time', () => {
    const result = parseNoteSubmission({ ...good, start_time: '25:00' })
    expect(result.ok && result.value.start_time).toBe('25:00')
  })

  it('does NOT judge the note type: the allow-list lives in one place', () => {
    // A refused type must reach the database and be refused there, so there is
    // only ever one list to keep. If this ever starts failing because the parser
    // learned the list, two places can now disagree.
    const result = parseNoteSubmission({ ...good, note_type: 'sick' })
    expect(result.ok).toBe(true)
  })
})

describe('answerForHint', () => {
  it('answers a caller fault with 400', () => {
    expect(answerForHint('invalid_request')).toEqual({
      status: 400, body: { ok: false, reason: 'invalid_request' },
    })
  })

  it.each([
    'note_type_not_transferable',
    'unknown_note_type',
    'invalid_start_time',
    'invalid_end_time',
    'invalid_range',
    'range_too_long',
  ])('answers the final refusal %s with 200, so a queue does not retry it', (hint) => {
    expect(answerForHint(hint)).toEqual({ status: 200, body: { ok: false, reason: hint } })
  })

  it('answers an unknown hint with 500, never a silent 200', () => {
    // A refusal this build has not heard of is the case where the caller SHOULD
    // retry and a person should look. A 200 would make it read as a rejected note.
    for (const hint of ['something_new', '', null, undefined]) {
      expect(answerForHint(hint)).toEqual({ status: 500, body: { ok: false, reason: 'server_error' } })
    }
  })
})

describe('the header', () => {
  it('is the one the function reads and the one ridy sends', () => {
    expect(PARTNER_KEY_HEADER).toBe('X-Partner-Key')
  })
})
