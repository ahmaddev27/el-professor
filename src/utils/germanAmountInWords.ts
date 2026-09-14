/**
 * An amount written out in German words, as printed on a Quittung:
 * 1234.56 → "Eintausendzweihundertvierunddreißig Euro und sechsundfünfzig Cent".
 *
 * Moved out of TrinkgeldQuittungModal so the Gehaltsquittung prints exactly the
 * words the Trinkgeld-Quittung already prints. The wording is pinned by
 * germanAmountInWords.golden.test.ts, generated from the original functions
 * before the move; the move changed no output inside the supported range.
 *
 * The one behaviour change is outside that range. Above 999 999 the old code
 * produced words that are not German ("Zehnhunderttausend" for a million), and
 * printed them on the receipt. It now throws a RangeError instead, and callers
 * check MAX_AMOUNT_IN_WORDS_CENTS before rendering.
 */

/** The largest amount, in cents, that can be written out: 999 999,99 €. */
export const MAX_AMOUNT_IN_WORDS_CENTS = 99_999_999;

const MAX_INT_IN_WORDS = 999_999;

const DE_ONES = [
  'null', 'ein', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun',
  'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn',
  'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn',
];
const DE_TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];

function deUnder100(n: number): string {
  if (n < 20) return DE_ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  if (o === 0) return DE_TENS[t];
  return `${DE_ONES[o]}und${DE_TENS[t]}`;
}

function deUnder1000(n: number): string {
  if (n < 100) return deUnder100(n);
  const h = Math.floor(n / 100);
  const r = n % 100;
  const hp = `${DE_ONES[h]}hundert`;
  return r === 0 ? hp : `${hp}${deUnder100(r)}`;
}

/** A whole number from 0 to 999 999 in lower-case German words, written as one word. */
export function deInt(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_INT_IN_WORDS) {
    throw new RangeError(`deInt: ${n} is not a whole number between 0 and ${MAX_INT_IN_WORDS}`);
  }
  if (n === 0) return 'null';
  if (n < 1000) return deUnder1000(n);
  const k = Math.floor(n / 1000);
  const r = n % 1000;
  const kp = k === 1 ? 'eintausend' : `${deUnder1000(k)}tausend`;
  return r === 0 ? kp : `${kp}${deUnder1000(r)}`;
}

/** Integer cents, 0 to MAX_AMOUNT_IN_WORDS_CENTS, in words. Prefer this form for money. */
export function amountInWordsFromCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_AMOUNT_IN_WORDS_CENTS) {
    throw new RangeError(`amountInWordsFromCents: ${cents} is not a cent amount between 0 and ${MAX_AMOUNT_IN_WORDS_CENTS}`);
  }
  const euroWords = deInt(Math.floor(cents / 100));
  const centWords = deInt(cents % 100);
  const capitalised = euroWords.charAt(0).toUpperCase() + euroWords.slice(1);
  return `${capitalised} Euro und ${centWords} Cent`;
}

/**
 * A euro amount in words, as the Trinkgeld-Quittung has always computed it: a
 * non-finite amount reads as zero and the sign is dropped. Callers must refuse
 * negative amounts before printing — this function will not.
 */
export function amountInWords(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return amountInWordsFromCents(Math.round(Math.abs(safe) * 100));
}
