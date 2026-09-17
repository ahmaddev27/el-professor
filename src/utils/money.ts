/**
 * Money in integer cents.
 *
 * Summing euro floats drifts (0.1 + 0.2 !== 0.3), and a German amount string
 * does not survive `parseFloat` — "1.234,56" reads as 1.234. Receipts and
 * payment checks therefore convert once at the edge, compute in cents, and
 * format once on the way out.
 */

/**
 * A euro amount as the database returns a numeric column — a JS number, or a
 * decimal string such as "1234.56" — to integer cents, rounding half away from
 * zero. Throws on anything that is not a finite decimal amount: a silent 0 is
 * how a wrong figure reaches a receipt.
 */
export function toCents(value: number | string): number {
  const cents = typeof value === 'string' ? decimalStringToCents(value) : numberToCents(value);
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`toCents: ${value} is too large to hold in cents`);
  }
  return cents;
}

function numberToCents(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`toCents: ${value} is not a finite amount`);
  }
  const cents = Math.round(Math.abs(value) * 100);
  return value < 0 ? -cents : cents;
}

function decimalStringToCents(text: string): number {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) {
    throw new RangeError(`toCents: "${text}" is not a decimal amount`);
  }
  const [, minus, whole, fraction = ''] = match;
  const firstThree = (fraction + '000').slice(0, 3);
  let cents = Number(whole) * 100 + Number(firstThree.slice(0, 2));
  if (Number(firstThree[2]) >= 5) cents += 1;
  return minus ? -cents : cents;
}

/** Cents in German notation with thousands separators: 123456 → "1.234,56". */
export function formatCentsDe(cents: number): string {
  assertWholeCents(cents);
  const abs = Math.abs(cents);
  const euros = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cents < 0 ? '-' : ''}${euros},${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Cents for an editable amount field: decimal comma, no thousands separator,
 * 123456 → "1234,56". Without grouping dots the value reads back unambiguously
 * through parseGermanAmountToCents.
 */
export function formatCentsForInput(cents: number): string {
  assertWholeCents(cents);
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Cents as the decimal text a numeric database parameter reads exactly:
 * 123456 → "1234.56". The inverse of toCents for strings. An RPC receives this
 * rather than cents / 100, so no float stands between a typed amount and the
 * ledger row it becomes.
 */
export function formatCentsForNumeric(cents: number): string {
  assertWholeCents(cents);
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * A non-negative amount typed the German way, to cents; null when it is not
 * one. Accepted:
 *
 *   "1.234,56"  "1234,56"  "1234,5"  "12,"   decimal comma, optional grouping dots
 *   "1.234"     "12.345"                     dots in groups of three: thousands
 *   "1234.56"   "12.5"     "1234"            one dot with one or two decimals
 *
 * Refused: more than two decimals (money is not rounded silently), a sign,
 * English grouping ("1,234.56"), a grouped number starting with 0 ("0.500"
 * could be half a euro or five hundred), and anything else.
 */
export function parseGermanAmountToCents(input: string): number | null {
  // \s also covers the no-break spaces toLocaleString('de-DE') puts before "€".
  const text = input.replace(/\s/g, '').replace(/(€|EUR)$/i, '');
  const parts = splitGermanAmount(text);
  if (!parts) return null;
  const cents = Number(parts.whole) * 100 + Number(parts.fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

function splitGermanAmount(text: string): { whole: string; fraction: string } | null {
  const withComma = /^([1-9]\d{0,2}(?:\.\d{3})+|\d+),(\d{0,2})$/.exec(text);
  if (withComma) return { whole: withComma[1].replace(/\./g, ''), fraction: withComma[2] };

  if (/^[1-9]\d{0,2}(?:\.\d{3})+$/.test(text)) return { whole: text.replace(/\./g, ''), fraction: '' };

  const plain = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (plain) return { whole: plain[1], fraction: plain[2] ?? '' };

  return null;
}

function assertWholeCents(cents: number): void {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`expected whole cents, got ${cents}`);
  }
}
