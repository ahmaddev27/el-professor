/**
 * Display formatting for the design system.
 *
 * Money and dates keep German conventions in both UI languages (see
 * src/i18n/index.ts): a figure on screen corresponds one-to-one with a figure
 * on a German document. These helpers only format; they never do arithmetic on
 * money.
 *
 * Euro amounts go through src/utils/money.ts, the integer-cent module behind
 * the Gehaltsquittung, so a figure on a screen and the same figure on a receipt
 * are rounded and written by one implementation.
 */
import { formatCentsDe, toCents } from '../../utils/money';

const NBSP = ' ';

const numberFormats = new Map<number, Intl.NumberFormat>();
const percentFormats = new Map<number, Intl.NumberFormat>();

function cached(cache: Map<number, Intl.NumberFormat>, digits: number, options: Intl.NumberFormatOptions) {
  let format = cache.get(digits);
  if (!format) {
    format = new Intl.NumberFormat('de-DE', { ...options, minimumFractionDigits: digits, maximumFractionDigits: digits });
    cache.set(digits, format);
  }
  return format;
}

/** Integer cents, `4821640` → `48.216,40 €` (non-breaking space before the sign). */
export function formatEuroCents(cents: number): string {
  return `${formatCentsDe(cents)}${NBSP}€`;
}

/**
 * A euro amount as a numeric column stores it, `48216.4` → `48.216,40 €`.
 * Rounded to the cent half away from zero, as `toCents` rounds; a value that
 * is not a finite amount throws instead of showing a wrong figure.
 */
export function formatEuro(amount: number): string {
  return formatEuroCents(toCents(amount));
}

/** `1234.5` → `1.235`, or `1.234,5` with one fraction digit. */
export function formatNumber(value: number, fractionDigits = 0): string {
  return cached(numberFormats, fractionDigits, {}).format(value);
}

/** A ratio, not a percentage: `0.3804` → `38,0 %`. */
export function formatPercent(ratio: number, fractionDigits = 1): string {
  return cached(percentFormats, fractionDigits, { style: 'percent' }).format(ratio);
}

/**
 * `2026-09-14` → `14.09.2026`.
 *
 * Reads the stored `YYYY-MM-DD` text directly instead of going through `Date`,
 * which would shift a date-only value across midnight in some timezones.
 */
export function formatDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return isoDate;
  return `${match[3]}.${match[2]}.${match[1]}`;
}
