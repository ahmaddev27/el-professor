import { describe, expect, it } from 'vitest'
import {
  CATCHUP_MAX,
  parseCatchUp,
  parseRing,
  pendingPath,
  readPendingAnswer,
  readSubmissionAnswer,
  RING_KINDS,
  submissionPath,
} from './partner-doorbell-core'

const ring = { partner: 'reidey', fleet: '7', submission: 'sub-1', subject: 'receipt' }

describe('parseRing', () => {
  it('reads a complete ring', () => {
    expect(parseRing(ring)).toEqual({
      ok: true,
      value: { partner: 'reidey', fleet: '7', submission: 'sub-1', subject: 'receipt' },
    })
  })

  it.each(['partner', 'fleet', 'submission'])('refuses a ring with no %s', (field) => {
    const body: Record<string, unknown> = { ...ring }
    delete body[field]
    expect(parseRing(body)).toEqual({ ok: false, problem: 'invalid_request', field })
  })

  // An absent subject must not default: the two go to different tables, and a
  // Beleg ingested as a note loses its photo and its amount with a 200.
  it('refuses a ring with no subject rather than defaulting to note', () => {
    const body: Record<string, unknown> = { ...ring }
    delete body.subject
    expect(parseRing(body)).toEqual({ ok: false, problem: 'unknown_kind' })
  })

  it('refuses a subject this build does not know', () => {
    expect(parseRing({ ...ring, subject: 'invoice' })).toEqual({ ok: false, problem: 'unknown_kind' })
  })

  // `kind` on the wire is the TRANSPORT, so a ring that puts the subject there
  // is refused rather than read -- the two meanings never share a field.
  it('does not read the subject out of `kind`', () => {
    const body: Record<string, unknown> = { ...ring, kind: 'receipt' }
    delete body.subject
    expect(parseRing(body)).toEqual({ ok: false, problem: 'unknown_kind' })
  })

  it.each(RING_KINDS)('accepts the subject %s', (subject) => {
    expect(parseRing({ ...ring, subject }).ok).toBe(true)
  })

  it('lowercases the partner and the subject, and leaves the ids alone', () => {
    const result = parseRing({ ...ring, partner: 'REIDEY', subject: 'RECEIPT', submission: 'Sub-1' })
    expect(result.ok && [result.value.partner, result.value.subject, result.value.submission])
      .toEqual(['reidey', 'receipt', 'Sub-1'])
  })

  it('a catch-up names a fleet and needs no submission', () => {
    expect(parseCatchUp({ partner: 'Reidey', fleet: '7' }))
      .toEqual({ ok: true, value: { partner: 'reidey', fleet: '7' } })
    expect(parseCatchUp({ partner: 'reidey' }))
      .toEqual({ ok: false, problem: 'invalid_request', field: 'fleet' })
  })

  it('ignores fields it does not read', () => {
    // A partner adding a field of its own must not break ingestion, and
    // nothing it adds is read — the ring cannot assert a submission's contents.
    const result = parseRing({ ...ring, amount: '9999.00', driver_name: 'somebody else' })
    expect(result.ok).toBe(true)
  })

  it.each([null, 'a string', 42, ['a', 'list']])('refuses %s as a body', (body) => {
    expect(parseRing(body)).toEqual({ ok: false, problem: 'invalid_body' })
  })
})

describe('submissionPath', () => {
  it('encodes the id exactly once', () => {
    expect(submissionPath('sub-1')).toBe('/api/v1/elprofessor/submissions/sub-1')
  })

  // An id with a slash or a traversal in it would otherwise reach a different
  // route of the partner's.
  it.each([
    ['a slash', 'a/b', '/api/v1/elprofessor/submissions/a%2Fb'],
    ['a traversal', '../fleet/drivers', '/api/v1/elprofessor/submissions/..%2Ffleet%2Fdrivers'],
    ['a query', 'x?y=1', '/api/v1/elprofessor/submissions/x%3Fy%3D1'],
    ['a space', 'a b', '/api/v1/elprofessor/submissions/a%20b'],
  ])('neutralises %s', (_label, id, expected) => {
    expect(submissionPath(id)).toBe(expected)
  })
})

describe('pendingPath', () => {
  it('asks for pending submissions with a capped page size', () => {
    expect(pendingPath(25)).toBe('/api/v1/elprofessor/submissions?status=pending&per_page=25')
    expect(pendingPath(1000)).toBe('/api/v1/elprofessor/submissions?status=pending&per_page=100')
    expect(pendingPath(0)).toBe('/api/v1/elprofessor/submissions?status=pending&per_page=1')
    expect(pendingPath(Number.NaN)).toBe('/api/v1/elprofessor/submissions?status=pending&per_page=25')
  })
})

describe('readSubmissionAnswer', () => {
  it('unwraps the partner`s data envelope', () => {
    const result = readSubmissionAnswer({ data: { amount: '41.47' } }, 'receipt')
    expect(result.ok && result.payload.amount).toBe('41.47')
  })

  it.each([
    ['no envelope', { amount: '41.47' }],
    ['a null envelope', { data: null }],
    ['a list', { data: [1, 2] }],
    ['not an object at all', 'ok'],
  ])('refuses %s', (_label, answer) => {
    expect(readSubmissionAnswer(answer, 'receipt')).toEqual({ ok: false, problem: 'answer_unreadable' })
  })

  // The ring decided which table we were about to write, so a disagreement is
  // the one case where ingesting anyway would be actively wrong.
  it('refuses an answer whose kind disagrees with the ring', () => {
    expect(readSubmissionAnswer({ data: { kind: 'note' } }, 'receipt'))
      .toEqual({ ok: false, problem: 'answer_kind_mismatch' })
  })

  it('accepts an answer that names no kind, since the ring already did', () => {
    expect(readSubmissionAnswer({ data: { amount: '1.00' } }, 'receipt').ok).toBe(true)
  })

  it('accepts an answer whose kind agrees, whatever its case', () => {
    expect(readSubmissionAnswer({ data: { kind: 'RECEIPT' } }, 'receipt').ok).toBe(true)
  })
})

describe('readPendingAnswer', () => {
  it('reads the ids in order', () => {
    expect(readPendingAnswer({ data: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b'])
  })

  it('takes external_submission_id when there is no id', () => {
    expect(readPendingAnswer({ data: [{ external_submission_id: 'x' }] })).toEqual(['x'])
  })

  it('drops duplicates and unreadable rows rather than failing the catch-up', () => {
    expect(readPendingAnswer({ data: [{ id: 'a' }, { id: 'a' }, null, 7, { nope: 1 }, { id: ' ' }] }))
      .toEqual(['a'])
  })

  it.each([null, {}, { data: null }, { data: 'a' }, 'x'])('answers none for %s', (answer) => {
    expect(readPendingAnswer(answer)).toEqual([])
  })
})

describe('CATCHUP_MAX', () => {
  it('is a cap and not a loop to exhaustion', () => {
    // Each submission is a request to the partner plus an upload, and one
    // click must not become a thousand round trips in one worker's lifetime.
    expect(CATCHUP_MAX).toBeGreaterThan(0)
    expect(CATCHUP_MAX).toBeLessThanOrEqual(50)
  })
})
