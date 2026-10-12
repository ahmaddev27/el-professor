/**
 * The pure half of the Beleg intake: the body's shape, and the photo's.
 *
 * Imports nothing from Deno, `npm:` or `jsr:`, so vitest loads it.
 *
 * ## The photo is OPTIONAL since 11.10.2026, and this is where that was missed
 *
 * It used to be the point: a submission could carry a category and an amount
 * and no photo at all, so the database refused to accept one and this refused
 * to record one. The owner reversed that on 10.10.2026 — a driver's app reads
 * the receipt on the phone and the image stays there — and `20261010100000`
 * opened the database door.
 *
 * **Nothing arrived for another five hours, because this check stands in FRONT
 * of that door.** The door was measured open by calling the RPC directly,
 * which is precisely the test that skips the guard before it; and the recorded
 * reason read `document_missing` either way, so the measurement confirmed the
 * wrong half. A probe that bypasses a guard is not a probe.
 *
 * A photo that IS sent is still stored and still checked exactly as before —
 * size, type, and whether the declared type matches the bytes. An older app
 * build sends one. What is gone is requiring it to exist.
 *
 * ## Why base64 and not a URL
 *
 * The owner chose base64 on 08.10.2026, and the reason is the same one that
 * governs `partner-endpoint.ts`: a URL in a request body is a destination our
 * server would fetch, and these functions share a Docker network with two
 * databases. The only validated destination in this product is the partner's
 * own host; a per-submission URL would be an unvalidated one.
 *
 * ## The amount is read strictly, because it is money
 *
 * `parseDisplayAmount` in the browser reads `1.234` as **1.23** — wrong by a
 * factor of a thousand — strips a minus sign silently, and answers 0 for
 * anything it cannot read. None of that may happen to a figure that reaches a
 * driver's balance, so the wire format is exactly one shape: a plain decimal
 * string with a dot, no thousands separator, no currency, at most two places.
 * Anything else is refused by name rather than coerced.
 */

/** The four the screen stores literally; `Other` is a sentinel it never saves. */
export const RECEIPT_CATEGORIES = ['Tanken', 'Autowäsche', 'Autozubehör', 'Öl wechseln'] as const

/** What `storage` will accept for a Beleg photo, and nothing else. */
export const RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const

const MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
}

/** 8 MiB decoded. A phone photo is 2–5 MiB; a worker's memory is not a bucket. */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
/** A plain decimal: digits, optionally a dot and at most two more digits. */
const WIRE_AMOUNT = /^\d{1,8}(\.\d{1,2})?$/
const PLZ = /^\d{5}$/

export type ReceiptProblem =
  | 'invalid_body'
  | 'invalid_request'
  | 'document_missing'
  | 'document_too_large'
  | 'document_type_unsupported'
  | 'document_unreadable'
  | 'invalid_amount'
  | 'invalid_category'
  | 'invalid_date'
  | 'invalid_postal_code'
  | 'invalid_time'
  | 'invalid_litres'
  | 'invalid_price_per_litre'
  | 'invalid_payment_method'
  | 'subject_missing'

export interface ReceiptSubmissionInput {
  partner: string
  external_submission_id: string
  external_driver_id: string
  receipt_date: string
  category: string | null
  description: string | null
  amount: string
  payment_method: 'bar' | 'uberweisung'
  postal_code: string | null
  /** Where the Beleg is from, and the clock time printed on it. */
  merchant_name: string | null
  city: string | null
  receipt_time: string | null
  /** Fuel only. Plain decimals with a dot, as strings: the column is numeric
   *  and a float here would round a unit price on its way through. */
  litres: string | null
  price_per_litre: string | null
  captured_at: string | null
  confirmed_by_driver: boolean
  read_by_agent: boolean
  /** Null when the driver's app read the receipt and kept the image. */
  document: { bytes: Uint8Array; contentType: string; extension: string } | null
}

export type ReceiptParseResult =
  | { ok: true; value: ReceiptSubmissionInput }
  | { ok: false; problem: ReceiptProblem; field?: string }

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Decodes base64, with or without a `data:` prefix, or null. */
export function decodeDocument(encoded: string): Uint8Array | null {
  const body = encoded.includes(',') ? encoded.slice(encoded.indexOf(',') + 1) : encoded
  const cleaned = body.replace(/\s/g, '')
  if (cleaned === '') return null
  try {
    const binary = atob(cleaned)
    const bytes = new Uint8Array(new ArrayBuffer(binary.length))
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/**
 * What a file really is, read from its first bytes.
 *
 * The declared `content_type` is a claim by the sender. A JPEG starts `FF D8
 * FF`, a PNG with its 8-byte signature, a PDF with `%PDF`. A mismatch is
 * refused rather than trusted, because the bucket's key carries the extension
 * and a browser will render what the extension promises.
 */
export function sniffDocument(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length >= 8 && png.every((byte, i) => bytes[i] === byte)) return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50
      && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'application/pdf'
  }
  return null
}

export function parseReceiptSubmission(body: unknown): ReceiptParseResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, problem: 'invalid_body' }
  }
  const b = body as Record<string, unknown>

  const partner = text(b.partner)
  const submissionId = text(b.external_submission_id)
  const driverId = text(b.external_driver_id)
  for (const [field, value] of [
    ['partner', partner],
    ['external_submission_id', submissionId],
    ['external_driver_id', driverId],
  ] as const) {
    if (value === null) return { ok: false, problem: 'invalid_request', field }
  }

  const date = text(b.receipt_date)
  if (date === null || !ISO_DATE.test(date)) {
    return { ok: false, problem: 'invalid_date' }
  }

  // Money, read strictly. The browser's own parser reads `1.234` as 1.23 and
  // answers 0 for anything it cannot read; neither may happen here.
  const amount = text(b.amount)
  if (amount === null || !WIRE_AMOUNT.test(amount)) {
    return { ok: false, problem: 'invalid_amount' }
  }

  const category = text(b.category)
  if (category !== null && !(RECEIPT_CATEGORIES as readonly string[]).includes(category)) {
    // `Other` is a sentinel the screen never stores: the free text goes into
    // the description instead, so a partner sending it is sending a category
    // this product has no row for.
    return { ok: false, problem: 'invalid_category' }
  }
  const description = text(b.description)
  if (category === null && description === null) {
    // The table's own CHECK demands one of the two; refusing by name here beats
    // a 23514 carrying a constraint name.
    return { ok: false, problem: 'subject_missing' }
  }

  const method = text(b.payment_method) ?? 'bar'
  if (method !== 'bar' && method !== 'uberweisung') {
    return { ok: false, problem: 'invalid_payment_method' }
  }

  // `HH:MM`, with the hour checked: `25:00` is not a time, and a parser that
  // accepts it moves the entry into the next day.
  const receiptTime = text(b.receipt_time)
  if (receiptTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(receiptTime)) {
    return { ok: false, problem: 'invalid_time' }
  }

  // Both fuel figures travel as plain decimals with a dot, like the amount,
  // and for the same reason: `parseDisplayAmount` reads `1.234` as 1.23 and
  // answers 0 for what it cannot read, and these reach an accountant.
  const litres = text(b.litres)
  if (litres !== null && !/^\d{1,8}(\.\d{1,2})?$/.test(litres)) {
    return { ok: false, problem: 'invalid_litres' }
  }
  const pricePerLitre = text(b.price_per_litre)
  if (pricePerLitre !== null && !/^\d{1,8}(\.\d{1,3})?$/.test(pricePerLitre)) {
    return { ok: false, problem: 'invalid_price_per_litre' }
  }

  const postalCode = text(b.postal_code)
  if (postalCode !== null && !PLZ.test(postalCode)) {
    return { ok: false, problem: 'invalid_postal_code' }
  }

  // The photo, when there is one. A build of 10.10.2026 or later sends none.
  // One that arrives is checked exactly as before: a photo nobody can open is
  // worse than no photo, so an unreadable or oversized one is still a refusal.
  let document: { bytes: Uint8Array; contentType: string; extension: string } | null = null
  const encoded = text(b.document)
  if (encoded !== null) {
    const bytes = decodeDocument(encoded)
    if (bytes === null || bytes.length === 0) {
      return { ok: false, problem: 'document_unreadable' }
    }
    if (bytes.length > MAX_DOCUMENT_BYTES) {
      return { ok: false, problem: 'document_too_large' }
    }
    const sniffed = sniffDocument(bytes)
    if (sniffed === null) return { ok: false, problem: 'document_type_unsupported' }
    const declared = text(b.content_type)
    // A declared type that disagrees with the bytes is refused rather than
    // trusted: the key carries the extension and a browser renders what the
    // extension promises.
    if (declared !== null && declared.toLowerCase() !== sniffed) {
      return { ok: false, problem: 'document_type_unsupported' }
    }
    document = { bytes, contentType: sniffed, extension: MIME_EXTENSION[sniffed] }
  }

  return {
    ok: true,
    value: {
      partner: (partner as string).toLowerCase(),
      external_submission_id: submissionId as string,
      external_driver_id: driverId as string,
      receipt_date: date,
      category,
      description,
      amount,
      payment_method: method,
      postal_code: postalCode,
      merchant_name: text(b.merchant_name),
      city: text(b.city),
      receipt_time: receiptTime,
      litres,
      price_per_litre: pricePerLitre,
      captured_at: text(b.captured_at),
      confirmed_by_driver: b.confirmed_by_driver === true,
      read_by_agent: b.read_by_agent === true,
      document,
    },
  }
}

/** `<company>/partner/<submission>.<ext>` in the private `documents` bucket. */
export function documentKey(companyId: string, submissionId: string, extension: string): string {
  return `${companyId}/partner/${submissionId}.${extension}`
}

/** Which refusals are final, so a partner's queue does not retry them. */
const FINAL: ReadonlySet<ReceiptProblem> = new Set<ReceiptProblem>([
  'document_missing', 'document_too_large', 'document_type_unsupported',
  'document_unreadable', 'invalid_amount', 'invalid_category', 'invalid_date',
  'invalid_postal_code', 'invalid_payment_method', 'subject_missing',
])

export function receiptProblemIsFinal(problem: ReceiptProblem): boolean {
  return FINAL.has(problem)
}
