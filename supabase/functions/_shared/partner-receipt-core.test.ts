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

  // Flipped on 11.10.2026 with the owner's decision of the 10th: a driver
  // sends the figures, not the document. This was the audit's blocker and the
  // reasoning behind it still holds — nothing downstream can check a figure
  // against a receipt nobody has — which is why the app will not send a field
  // its rules were unsure about until the driver confirms it by hand. The
  // evidence moved; it was not dropped.
  it('accepts a submission with no photo, and says so with a null', () => {
    const body: Record<string, unknown> = { ...good }
    delete body.document
    const parsed = parseReceiptSubmission(body)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.document).toBeNull()
  })

  it('still refuses a photo that IS sent and cannot be opened', () => {
    // Optional does not mean unchecked: a file nobody can render is worse than
    // no file, because the reviewer is shown something and learns nothing.
    expect(parseReceiptSubmission({ ...good, document: 'not base64 at all !!' }).ok).toBe(false)
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

// ── The five fields the owner asked for on 11.10.2026 ───────────────────────
//
// Litres and the unit price are required on `Tanken` ONLY, and that rule lives
// in the driver's app: a car wash has neither, and demanding them here would
// refuse every receipt that is not a refuel. What this parser owes is the
// SHAPE — one wire format, checked, never coerced.

describe('the receipt fields beyond the amount', () => {
  const withFields = (extra: Record<string, unknown>) => ({ ...good, ...extra })

  it('carries the merchant, the city and the time through', () => {
    const r = parseReceiptSubmission(withFields({
      merchant_name: 'ARAL Tankstelle', city: 'Berlin', receipt_time: '14:32',
    }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.merchant_name).toBe('ARAL Tankstelle')
    expect(r.value.city).toBe('Berlin')
    expect(r.value.receipt_time).toBe('14:32')
  })

  it('takes litres with two places and a unit price with three', () => {
    const r = parseReceiptSubmission(withFields({ litres: '41.47', price_per_litre: '1.789' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.litres).toBe('41.47')
    expect(r.value.price_per_litre).toBe('1.789')
  })

  it('refuses German formatting rather than coercing it', () => {
    // `parseDisplayAmount` reads `1.234` as 1.23 and answers 0 for what it
    // cannot read. None of that may happen to a figure an accountant reads.
    expect(parseReceiptSubmission(withFields({ litres: '41,47' })))
      .toEqual({ ok: false, problem: 'invalid_litres' })
    expect(parseReceiptSubmission(withFields({ price_per_litre: '1,789' })))
      .toEqual({ ok: false, problem: 'invalid_price_per_litre' })
  })

  it('refuses a unit price with four places and litres with three', () => {
    expect(parseReceiptSubmission(withFields({ price_per_litre: '1.7891' })))
      .toEqual({ ok: false, problem: 'invalid_price_per_litre' })
    expect(parseReceiptSubmission(withFields({ litres: '41.473' })))
      .toEqual({ ok: false, problem: 'invalid_litres' })
  })

  it('checks the HOUR of the time, not just its shape', () => {
    // `25:00` parses to 1500 minutes in a naive reader and walks the entry
    // into the next day. It is not a time, and it is refused as one.
    expect(parseReceiptSubmission(withFields({ receipt_time: '25:00' })))
      .toEqual({ ok: false, problem: 'invalid_time' })
    expect(parseReceiptSubmission(withFields({ receipt_time: '14:60' })))
      .toEqual({ ok: false, problem: 'invalid_time' })
    expect(parseReceiptSubmission(withFields({ receipt_time: '23:59' })).ok).toBe(true)
  })

  it('leaves all five null when the partner sends none of them', () => {
    // An older Reidey build sends nothing here, and nothing must not become
    // an empty string: the columns are numeric and a time.
    const r = parseReceiptSubmission(good)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.litres).toBeNull()
    expect(r.value.price_per_litre).toBeNull()
    expect(r.value.receipt_time).toBeNull()
    expect(r.value.merchant_name).toBeNull()
  })
})
// -- The odometer, required with a refuel since 11.10.2026 -------------------
//
// The figure is read on the phone from a photo of the cluster that stays
// there, so nobody downstream can check it against anything. That is why the
// reading rule abstains rather than guessing, and why this door's bounds are
// the COLUMN's bounds to the digit: past here there is no second reader, only
// a constraint whose name means nothing to a driver.

describe('the odometer and the range', () => {
  const withOdo = (extra: Record<string, unknown>) => ({ ...good, ...extra })

  it('carries both whole figures through as strings', () => {
    const r = parseReceiptSubmission(withOdo({ odometer_km: '25382', range_km: '277' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.odometer_km).toBe('25382')
    expect(r.value.range_km).toBe('277')
  })

  it('refuses a decimal odometer, because a cluster shows none', () => {
    // A dot here is a misread of the consumption figure or the clock, not a
    // measurement; the column is an integer and would truncate it silently.
    expect(parseReceiptSubmission(withOdo({ odometer_km: '25382.0' })))
      .toEqual({ ok: false, problem: 'invalid_odometer' })
    expect(parseReceiptSubmission(withOdo({ range_km: '27.7' })))
      .toEqual({ ok: false, problem: 'invalid_range' })
  })

  it('holds the column`s floor and ceiling, to the digit', () => {
    // 20261012100000: odometer_km BETWEEN 100 AND 10000000.
    expect(parseReceiptSubmission(withOdo({ odometer_km: '99' })))
      .toEqual({ ok: false, problem: 'invalid_odometer' })
    expect(parseReceiptSubmission(withOdo({ odometer_km: '100' })).ok).toBe(true)
    expect(parseReceiptSubmission(withOdo({ odometer_km: '10000000' })).ok).toBe(true)
    expect(parseReceiptSubmission(withOdo({ odometer_km: '10000001' })))
      .toEqual({ ok: false, problem: 'invalid_odometer' })
  })

  it('takes a range of zero and refuses one no car holds', () => {
    // Driven to empty is a real reading, and the one a fleet most wants to
    // see. 2000 km of range is not a range.
    expect(parseReceiptSubmission(withOdo({ range_km: '0' })).ok).toBe(true)
    expect(parseReceiptSubmission(withOdo({ range_km: '2000' })).ok).toBe(true)
    expect(parseReceiptSubmission(withOdo({ range_km: '2001' })))
      .toEqual({ ok: false, problem: 'invalid_range' })
  })

  it('refuses a unit, a sign and a separator rather than reading round them', () => {
    for (const bad of ['25382 km', '-25382', '25.382', '2 5382', 'km']) {
      expect(parseReceiptSubmission(withOdo({ odometer_km: bad })))
        .toEqual({ ok: false, problem: 'invalid_odometer' })
    }
  })

  it('leaves both null when the partner sends neither', () => {
    // A Beleg that is not a refuel has neither, and an app build older than
    // 12.10.2026 sends neither on any Beleg at all.
    const r = parseReceiptSubmission(good)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.odometer_km).toBeNull()
    expect(r.value.range_km).toBeNull()
  })

  it('calls both refusals final, so the partner`s queue stops', () => {
    // A figure that is the wrong shape is the wrong shape for ever: the app
    // has discarded the photo it read it from before the request leaves.
    expect(receiptProblemIsFinal('invalid_odometer')).toBe(true)
    expect(receiptProblemIsFinal('invalid_range')).toBe(true)
  })
})
