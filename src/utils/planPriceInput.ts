/**
 * The monthly price an administrator types into the Plan management modal, read
 * as a number of euros.
 *
 * **The rule this preserves:** a price is stored in the unit the column carries
 * — `subscription_plans.monthly_price` is euros, not cents — and a figure nobody
 * typed is never stored. The screen's field is a free-text input, so German is
 * what an administrator writes into it.
 *
 * What shipped was `parseFloat(text.replace(',', '.'))`, which is wrong in three
 * ways, all silent:
 *
 *   '1.200,00' -> '1.200.00' -> parseFloat stops at the second dot -> **1.2**
 *   '1.200'    -> unchanged   -> **1.2**            (a plan priced at 1,20 €)
 *   'abc'      -> **NaN**, which supabase-js serialises as `null`
 *
 * `String.replace` with a string argument also replaces only the *first* comma,
 * so a second one is left to stop `parseFloat` as well.
 *
 * The parsing itself is `parseMoney` from the Fahrtenbuch import — the one place
 * in this codebase that decides what a German amount means, and the only one
 * with measurements behind it (`src/utils/parseMoney.test.ts`). This module adds
 * exactly what a price field needs on top of it and no parsing of its own: a
 * shape check, so text carrying no number is refused rather than read as
 * `parseMoney`'s `0`, and a refusal of a negative price.
 *
 * That import reaches `xlsx`, which `fahrtenbuchImportParser` needs and this does
 * not. It costs nothing today — every page in `App.tsx` is a static import and
 * four of them already pull `xlsx`, so it is in the one main bundle either way.
 * If the app is ever code-split, move `parseMoney` into a module of its own and
 * have both callers read it there; do not copy it, which is how this codebase
 * came to have four premium engines.
 */
import { parseMoney } from './fahrtenbuchImportParser';

/**
 * Digits first, then only digits, spaces and the two German separators.
 *
 * This is deliberately narrower than `parseMoney`, which strips anything else
 * and answers 0. Here 0 is a legitimate price — a free plan, and `'0'` already
 * passed the modal's own required-field guard — so "the text was zero" and "the
 * text was not a number" must be distinguishable, and only a shape check can
 * tell them apart. A leading sign is refused rather than negated: a monthly
 * price below zero is a typo every time.
 */
const PRICE_SHAPE = /^\d[\d .,]*$/;

/** A trailing euro sign, which a German administrator types by habit. */
const TRAILING_EURO = /\s*€$/;

/**
 * One dot, no comma, exactly three digits after it — `'1.200'`.
 *
 * `parseMoney` reads this as 1.2 on purpose, and for a ride's Preis that is the
 * right call: 27273 stored amounts depend on a single dot meaning a decimal
 * point, and the file gives no reason to guess otherwise. A plan price is the
 * other way round — nobody sells a subscription for 1,20 € — so reading it as
 * `parseMoney` does would keep exactly the factor of 1000 this module exists to
 * remove, just by a different route.
 *
 * So this one shape is refused rather than decided. `'1200'` and `'1.200,00'`
 * both say plainly what they mean and both parse; two dots (`'1.200.000'`) are
 * unambiguously grouping and parse; a space group (`'1 200'`) parses, because a
 * space is never a decimal separator. Only the genuinely ambiguous form asks the
 * administrator to write it again.
 */
const AMBIGUOUS_GROUPING = /^\d{1,3}\.\d{3}$/;

/**
 * The price in euros, or `null` when the text does not carry a number we are
 * willing to read. `null` is a refusal the caller must show; it is never a price.
 */
export function parsePlanPriceInput(raw: string): number | null {
  const text = raw.trim().replace(TRAILING_EURO, '').trim();
  if (!PRICE_SHAPE.test(text)) return null;
  if (AMBIGUOUS_GROUPING.test(text)) return null;

  const value = parseMoney(text);
  // parseMoney already rounds to the cent and answers 0 for anything it cannot
  // read; the shape check above is what makes that 0 mean the typed zero.
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}
