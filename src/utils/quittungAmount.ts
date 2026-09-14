import { MAX_AMOUNT_IN_WORDS_CENTS } from './germanAmountInWords';
import { parseGermanAmountToCents } from './money';

/**
 * The amount typed into a Quittung's amount field, in cents — or null when it
 * must not be printed: unreadable, or too large to write out in words.
 *
 * The Trinkgeld-Quittung used to prefill that field with the display format
 * and read it back with parseFloat after swapping one comma. 1.234,56 € was
 * prefilled as "1,234,56", read back as 1.234 and exported as 1,23 €: every
 * amount of 1000 € or more was printed wrong. Prefill with formatCentsForInput
 * and read with this, and the two are exact inverses.
 */
export function parseQuittungAmountCents(field: string): number | null {
  const cents = parseGermanAmountToCents(field);
  return cents !== null && cents <= MAX_AMOUNT_IN_WORDS_CENTS ? cents : null;
}
