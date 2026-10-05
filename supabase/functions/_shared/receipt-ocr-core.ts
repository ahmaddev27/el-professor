/**
 * The pure half of the receipt OCR endpoint.
 *
 * Imports nothing from Deno, `npm:` or `jsr:`, so vitest loads it — the rule
 * every `_shared` module in this tree follows. The Anthropic call and the HTTP
 * plumbing stay in `extract-receipt/index.ts`; what is decidable without a
 * network lives here and is tested.
 */

/** A base64 image is ~4/3 of its bytes. 6 MiB of base64 is ~4.5 MB of photo. */
export const MAX_IMAGE_BASE64 = 6 * 1024 * 1024;

/**
 * What the agent may be handed. The list mirrors the `salary-receipts` bucket's
 * `allowed_mime_types` minus PDF, because this is a photograph taken in the app
 * and Anthropic's image block takes these four.
 */
export const ALLOWED_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;
export type MediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

/**
 * The categories the extraction may answer with, byte for byte as
 * `receipts.description` stores them (`ReceiptModal.tsx:38-44`). `Tanken` in
 * particular selects the receipts that feed the Tankenquote, so a translated or
 * re-spelled value would silently drop a receipt out of a statutory figure.
 * `Other` is a sentinel: it is never stored, the free text takes its place.
 */
export const RECEIPT_CATEGORIES = [
  'Tanken',
  'Autowäsche',
  'Autozubehör',
  'Öl wechseln',
  'Other',
] as const;
export type ReceiptCategory = (typeof RECEIPT_CATEGORIES)[number];

export interface ExtractedReceipt {
  date?: string;
  time?: string;
  receiptNumber?: string;
  amount?: number;
  postalCode?: string;
  city?: string;
  category?: ReceiptCategory;
  merchantName?: string;
  confidence?: 'high' | 'medium' | 'low';
}

export type RequestProblem =
  | 'invalid_request'
  | 'unsupported_media_type'
  | 'image_too_large';

/**
 * What is wrong with the body, or null when nothing is.
 *
 * The order is the order a caller can act on: a malformed body before a type it
 * cannot change, and the size last because it is the one the caller fixes by
 * taking a smaller photograph.
 */
export function requestProblem(body: unknown): RequestProblem | null {
  if (typeof body !== 'object' || body === null) return 'invalid_request';
  const { imageBase64, mediaType } = body as Record<string, unknown>;
  if (typeof imageBase64 !== 'string' || imageBase64 === '') return 'invalid_request';
  if (typeof mediaType !== 'string') return 'invalid_request';
  if (!(ALLOWED_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    return 'unsupported_media_type';
  }
  // Measured after whitespace is stripped, because that is what is sent on.
  if (imageBase64.replace(/\s+/g, '').length > MAX_IMAGE_BASE64) return 'image_too_large';
  return null;
}

/**
 * The model's answer, reduced to what a caller may act on.
 *
 * Everything is optional on purpose: the agent omits what it cannot read, and a
 * guessed value is worse than a missing one when a person is about to confirm
 * the reading. A field that does not parse is dropped rather than passed
 * through — the driver's preview shows an empty field, which reads as "not
 * read", instead of a number the agent did not mean.
 */
export function parseExtraction(rawText: string): ExtractedReceipt | null {
  const stripped = rawText.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  // `typeof [] === 'object'` and an array is not null, so it has to be named:
  // a JSON array parses, reads as an object, and would answer `{}` — "the agent
  // read nothing" — for what is really an answer in the wrong shape.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  const out: ExtractedReceipt = {};

  if (typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)) out.date = raw.date;
  if (typeof raw.time === 'string' && /^\d{2}:\d{2}$/.test(raw.time)) out.time = raw.time;
  if (typeof raw.receiptNumber === 'string' && raw.receiptNumber.trim() !== '') {
    out.receiptNumber = raw.receiptNumber.trim().slice(0, 64);
  }
  if (typeof raw.amount === 'number' && Number.isFinite(raw.amount) && raw.amount > 0) {
    // Two decimals, the column's unit. Rounded here rather than on the screen,
    // so the preview and the stored figure cannot differ.
    out.amount = Math.round(raw.amount * 100) / 100;
  }
  if (typeof raw.postalCode === 'string' && /^\d{5}$/.test(raw.postalCode.trim())) {
    out.postalCode = raw.postalCode.trim();
  }
  if (typeof raw.city === 'string' && raw.city.trim() !== '') {
    out.city = raw.city.trim().slice(0, 120);
  }
  if (typeof raw.category === 'string'
      && (RECEIPT_CATEGORIES as readonly string[]).includes(raw.category)) {
    out.category = raw.category as ReceiptCategory;
  }
  if (typeof raw.merchantName === 'string' && raw.merchantName.trim() !== '') {
    out.merchantName = raw.merchantName.trim().slice(0, 120);
  }
  if (raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low') {
    out.confidence = raw.confidence;
  }
  return out;
}

/**
 * The instruction handed to the agent.
 *
 * Kept beside the category list it names, so the two cannot drift: a prompt
 * offering a category the parser then rejects would read a receipt correctly
 * and drop the answer.
 */
export function extractionPrompt(): string {
  return `You are a receipt data extractor for a German taxi and Mietwagen company.

Read the receipt in the image and return ONLY a JSON object with these keys.
Omit any key you cannot read with reasonable confidence — a missing value is
better than a guessed one, because a person confirms this reading before it is
stored.

{
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "receiptNumber": "string",
  "amount": number,
  "postalCode": "string",
  "city": "string",
  "category": ${RECEIPT_CATEGORIES.map((c) => `"${c}"`).join(' | ')},
  "merchantName": "string",
  "confidence": "high" | "medium" | "low"
}

Rules:
- fuel, petrol or diesel  -> "Tanken"
- car wash                -> "Autowäsche"
- oil change              -> "Öl wechseln"
- car parts or equipment  -> "Autozubehör"
- anything else, or when the kind is unclear -> "Other"
- amount: the FINAL payable total (Gesamtbetrag, Endbetrag, Brutto, Zu zahlen).
  Never Netto, never MwSt, never the price per litre.
- a German date "26.04.2026" is "2026-04-26".
- postalCode is a 5-digit German PLZ, digits only.
- Return the JSON object and nothing else: no markdown fence, no explanation.`;
}
