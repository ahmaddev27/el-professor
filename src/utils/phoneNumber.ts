/**
 * A phone number, stored the one way that can become a link later.
 *
 * ## Why E.164, decided before anything uses it
 *
 * The owner's stated next step for a driver's number is WhatsApp, and a `wa.me`
 * link takes digits in international form with no plus, no leading zero and no
 * separators — `wa.me/4917012345678`. A number stored the way an operator types
 * it ("0170 1234567", "0170/123 45 67") cannot be turned into one later without
 * reprocessing every row by hand, and by then there are thousands.
 *
 * So the column holds E.164 (`+4917012345678`) from the first day, the database
 * has a CHECK that keeps it true, and this module is the one place that converts
 * what a person types into it.
 *
 * ## What it refuses, and why refusing is the safer error
 *
 * It accepts the three forms a German operator actually writes — `+49…`, `0049…`
 * and the national `0170…` — and **refuses a bare number with no leading `+`, `00`
 * or `0`**. "49170…" could be a German number written internationally without its
 * plus, or a national number of some other country; guessing picks one, and the
 * cost of guessing wrong is a message to a stranger. The field says what to type
 * instead.
 *
 * Nothing here is used to decide what is a *valid* subscriber number — that is a
 * carrier's business and a regex cannot know it. It decides only that the digits
 * can be addressed internationally, which is all storage needs to promise.
 */

/** Germany. The only default the product has a reason to assume. */
export const DEFAULT_COUNTRY_CODE = '49';

/**
 * E.164 bounds: a country code of 1 to 3 digits and 15 digits in all, so the
 * shortest addressable number is 7 digits and the longest 15.
 */
const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

/** Everything a person puts between digits, and nothing else. */
const SEPARATORS = /[\s().\-/‐-―]/g;

export type PhoneProblem =
  | 'empty'
  | 'not_a_number'      // characters that are not digits or a leading plus
  | 'needs_country'     // a bare number: no +, no 00, no leading 0
  | 'too_short'
  | 'too_long';

export interface PhoneResult {
  /** The number in E.164, or null when it could not be read. */
  e164: string | null;
  problem: PhoneProblem | null;
}

/**
 * Reads what was typed into E.164.
 *
 * An empty input is **not** an error — the column is nullable and a driver
 * without a number is ordinary. It answers `{ e164: null, problem: 'empty' }` so
 * a caller can tell "nothing was entered" from "this could not be read", which a
 * bare null would lose.
 */
export function normalizePhone(
  input: string | null | undefined,
  countryCode: string = DEFAULT_COUNTRY_CODE,
): PhoneResult {
  const raw = (input ?? '').trim();
  if (raw === '') return { e164: null, problem: 'empty' };

  const cleaned = raw.replace(SEPARATORS, '');

  // A plus is meaningful only at the front; anywhere else the input is not a
  // number at all, and silently dropping it would change which number is stored.
  const body = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  if (!/^[0-9]+$/.test(body)) return { e164: null, problem: 'not_a_number' };

  let digits: string;
  if (cleaned.startsWith('+')) {
    digits = body;
  } else if (body.startsWith('00')) {
    // The international prefix as dialled from Germany.
    digits = body.slice(2);
  } else if (body.startsWith('0')) {
    // National. The trunk zero is not part of the number; it is dialling.
    digits = `${countryCode}${body.slice(1)}`;
  } else {
    return { e164: null, problem: 'needs_country' };
  }

  // A country code cannot start with zero, so `+0…` and `000…` are not numbers.
  if (digits.startsWith('0')) return { e164: null, problem: 'needs_country' };
  if (digits.length < MIN_DIGITS) return { e164: null, problem: 'too_short' };
  if (digits.length > MAX_DIGITS) return { e164: null, problem: 'too_long' };

  return { e164: `+${digits}`, problem: null };
}

/**
 * The stored number as a person reads it: `+49 170 1234567`.
 *
 * Display only, and deliberately crude — it groups the country code, then a
 * prefix, then the rest, which reads correctly for German numbers and acceptably
 * for others. It is never parsed back; `normalizePhone` is the only reader.
 */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164 || !e164.startsWith('+')) return e164 ?? '';
  const digits = e164.slice(1);
  if (digits.startsWith(DEFAULT_COUNTRY_CODE) && digits.length > 6) {
    const rest = digits.slice(DEFAULT_COUNTRY_CODE.length);
    return `+${DEFAULT_COUNTRY_CODE} ${rest.slice(0, 3)} ${rest.slice(3)}`;
  }
  return `+${digits}`;
}

/**
 * The number as a `wa.me` link takes it: digits only, no plus.
 *
 * Here rather than at a call site because this is the whole reason the column is
 * E.164, and a second copy of the rule is how the two would drift.
 */
export function whatsAppNumber(e164: string | null | undefined): string | null {
  if (!e164 || !e164.startsWith('+')) return null;
  const digits = e164.slice(1);
  return /^[1-9][0-9]{6,14}$/.test(digits) ? digits : null;
}
