import { describe, expect, it } from 'vitest'
import {
  decodeDocument,
  documentKey,
  MAX_DOCUMENT_BYTES,
  parseReceiptSubmission,
  receiptProblemIsFinal,
  RECEIPT_CATEGORIES,
  sniffDocument,
} from './partner-receipt-core'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])

function b64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const good = {
  partner: 'reidey',
  external_submission_id: 'r-1',
  external_driver_id: 'd-1',
  receipt_date: '2026-10-07',
  category: 'Tanken',
  amount: '41.47',
  payment_method: 'bar',
  document: b64(JPEG),
}

describe('parseReceiptSubmission', () => {
  it('reads a complete submission', () => {
    const result = parseReceiptSubmission(good)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.amount).toBe('41.47')
    expect(result.value.category).toBe('Tanken')
    expect(result.value.document.contentType).toBe('image/jpeg')
    expect(result.value.document.extension).toBe('jpg')
  })

  it.each(['partner', 'external_submission_id', 'external_driver_id'])(
    'refuses a body with no %s',
    (field) => {
      const body: Record<string, unknown> = { ...good }
      delete body[field]
      expect(parseReceiptSubmission(body)).toEqual({ ok: false, problem: 'invalid_request', field })
    },
  )

  // The audit's blocker: a category and an amount and no photo at all.
  it('refuses a submission with NO PHOTO — the audit blocker', () => {
    const body: Record<string, unknown> = { ...good }
    delete body.document
    expect(parseReceiptSubmission(body)).toEqual({ ok: false, problem: 'document_missing' })
  })

  it('refuses a photo that does not decode', () => {
    expect(parseReceiptSubmission({ ...good, document: 'not base64 !!' }))
      .toEqual({ ok: false, problem: 'document_unreadable' })
  })

  it('refuses a photo over the size bound', () => {
    const big = b64(new Uint8Array(MAX_DOCUMENT_BYTES + 1).fill(0xff))
    expect(parseReceiptSubmission({ ...good, document: big }))
      .toEqual({ ok: false, problem: 'document_too_large' })
  })

  it('refuses a file that is not an image or a PDF, whatever it claims', () => {
    expect(parseReceiptSubmission({
      ...good,
      document: b64(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), // a zip
      content_type: 'image/jpeg',
    })).toEqual({ ok: false, problem: 'document_type_unsupported' })
  })

  it('refuses a declared type that disagrees with the bytes', () => {
    // The key carries the extension and a browser renders what the extension
    // promises, so the claim is never trusted over the content.
    expect(parseReceiptSubmission({ ...good, document: b64(PNG), content_type: 'image/jpeg' }))
      .toEqual({ ok: false, problem: 'document_type_unsupported' })
  })

  it('accepts a PNG and a PDF on their own bytes', () => {
    for (const [bytes, type, ext] of [
      [PNG, 'image/png', 'png'],
      [PDF, 'application/pdf', 'pdf'],
    ] as const) {
      const result = parseReceiptSubmission({ ...good, document: b64(bytes) })
      expect(result.ok && [result.value.document.contentType, result.value.document.extension])
        .toEqual([type, ext])
    }
  })

  it('accepts a data: URI, which is how a phone hands over a photo', () => {
    const result = parseReceiptSubmission({
      ...good, document: `data:image/jpeg;base64,${b64(JPEG)}`,
    })
    expect(result.ok && result.value.document.contentType).toBe('image/jpeg')
  })

  // Money. The browser's own parser reads `1.234` as 1.23 and answers 0 for
  // anything it cannot read; neither may happen to a driver's balance.
  it.each([
    ['a thousands separator', '1.234,56'],
    ['a German decimal comma', '41,47'],
    ['a currency symbol', '41.47 €'],
    ['three decimal places', '41.470'],
    ['a negative', '-41.47'],
    ['empty', ''],
    ['words', 'vierzig'],
  ])('refuses %s as an amount rather than coercing it', (_label, amount) => {
    expect(parseReceiptSubmission({ ...good, amount }))
      .toEqual({ ok: false, problem: 'invalid_amount' })
  })

  it('accepts the shapes a plain decimal can take', () => {
    for (const amount of ['0', '0.5', '41.47', '12345678', '7.0']) {
      expect(parseReceiptSubmission({ ...good, amount }).ok).toBe(true)
    }
  })

  it.each(RECEIPT_CATEGORIES)('accepts the stored category %s literally', (category) => {
    expect(parseReceiptSubmission({ ...good, category }).ok).toBe(true)
  })

  it('refuses `Other`, which is a sentinel the screen never stores', () => {
    expect(parseReceiptSubmission({ ...good, category: 'Other' }))
      .toEqual({ ok: false, problem: 'invalid_category' })
  })

  it('refuses a category this product has no row for', () => {
    expect(parseReceiptSubmission({ ...good, category: 'Reifen' }))
      .toEqual({ ok: false, problem: 'invalid_category' })
  })

  it('takes a free description instead of a category', () => {
    const body: Record<string, unknown> = { ...good, description: 'Reifenwechsel' }
    delete body.category
    const result = parseReceiptSubmission(body)
    expect(result.ok && [result.value.category, result.value.description])
      .toEqual([null, 'Reifenwechsel'])
  })

  it('refuses a submission with neither a category nor a description', () => {
    const body: Record<string, unknown> = { ...good }
    delete body.category
    expect(parseReceiptSubmission(body)).toEqual({ ok: false, problem: 'subject_missing' })
  })

  it.each([
    ['a German date', '07.10.2026'],
    ['missing', undefined],
    ['nonsense', 'gestern'],
  ])('refuses %s as the receipt date', (_label, receipt_date) => {
    const body: Record<string, unknown> = { ...good, receipt_date }
    if (receipt_date === undefined) delete body.receipt_date
    expect(parseReceiptSubmission(body)).toEqual({ ok: false, problem: 'invalid_date' })
  })

  it('refuses a postal code that is not five digits, and accepts one that is', () => {
    expect(parseReceiptSubmission({ ...good, postal_code: '1234' }))
      .toEqual({ ok: false, problem: 'invalid_postal_code' })
    expect(parseReceiptSubmission({ ...good, postal_code: '10115' }).ok).toBe(true)
  })

  it('refuses a payment method outside the column CHECK, and defaults to bar', () => {
    expect(parseReceiptSubmission({ ...good, payment_method: 'kreditkarte' }))
      .toEqual({ ok: false, problem: 'invalid_payment_method' })
    const body: Record<string, unknown> = { ...good }
    delete body.payment_method
    const result = parseReceiptSubmission(body)
    // `bar` is what moves a driver's balance, so defaulting to it is the
    // conservative choice only because the reviewer sees the row before it does.
    expect(result.ok && result.value.payment_method).toBe('bar')
  })

  it('does not judge the driver: resolving one is the database\'s job', () => {
    // The partner's own driver id travels; which of OUR drivers that is comes
    // from a confirmed link, never from here.
    const result = parseReceiptSubmission({ ...good, external_driver_id: 'anything' })
    expect(result.ok).toBe(true)
  })
})

describe('sniffDocument', () => {
  it('reads the real type from the first bytes', () => {
    expect(sniffDocument(JPEG)).toBe('image/jpeg')
    expect(sniffDocument(PNG)).toBe('image/png')
    expect(sniffDocument(PDF)).toBe('application/pdf')
  })

  it.each([
    ['a zip', [0x50, 0x4b, 0x03, 0x04]],
    ['too short', [0xff, 0xd8]],
    ['empty', []],
    ['text', [0x68, 0x65, 0x6c, 0x6c, 0x6f]],
  ])('answers null for %s', (_label, bytes) => {
    expect(sniffDocument(new Uint8Array(bytes))).toBeNull()
  })
})

describe('decodeDocument', () => {
  it('round-trips bytes', () => {
    expect(Array.from(decodeDocument(b64(JPEG)) ?? [])).toEqual(Array.from(JPEG))
  })

  it('tolerates whitespace, which a wrapped base64 body carries', () => {
    const wrapped = b64(JPEG).replace(/(.{2})/g, '$1\n')
    expect(Array.from(decodeDocument(wrapped) ?? [])).toEqual(Array.from(JPEG))
  })

  it.each(['', '   ', 'äöü not base64'])('answers null for %s', (value) => {
    expect(decodeDocument(value)).toBeNull()
  })
})

describe('documentKey', () => {
  it('is the company folder the bucket policies key on', () => {
    // Read is `folder = get_user_company_id()`, so the company must be FIRST.
    expect(documentKey('c0', 's1', 'jpg')).toBe('c0/partner/s1.jpg')
    expect(documentKey('c0', 's1', 'jpg').split('/')[0]).toBe('c0')
  })
})

describe('receiptProblemIsFinal', () => {
  it('treats every input fault as final, so a queue does not retry it', () => {
    for (const problem of [
      'document_missing', 'document_too_large', 'document_type_unsupported',
      'document_unreadable', 'invalid_amount', 'invalid_category', 'invalid_date',
      'invalid_postal_code', 'invalid_payment_method', 'subject_missing',
    ] as const) {
      expect(receiptProblemIsFinal(problem)).toBe(true)
    }
  })

  it('does not treat a caller fault as final', () => {
    // `invalid_request` and `invalid_body` are bugs in the caller's code, which
    // a deploy can fix — so they keep their 4xx and are worth retrying after.
    expect(receiptProblemIsFinal('invalid_request')).toBe(false)
    expect(receiptProblemIsFinal('invalid_body')).toBe(false)
  })
})
