/**
 * How the Fahrtenanalyse writes its figures: hours, minutes and money, German
 * notation in both languages (src/i18n/index.ts), through the design system's
 * formatters and utils/money.ts. Display only — nothing here feeds a
 * calculation, and a trip's own price is formatted, never changed.
 */
import type { PriceTotal } from '../utils/tripAnalysis/types';
import { formatCentsDe, toCents } from '../utils/money';
import { formatEuroCents, formatNumber } from '../components/ui/format';

const NBSP = ' ';

/** `71,94 h` — two decimals, the way the plan writes a budget. */
export function formatHours(hours: number): string {
  return `${formatNumber(hours, 2)}${NBSP}h`;
}

/** Minutes shown as hours, `4316` → `71,93 h`. */
export function formatMinutesAsHours(minutes: number): string {
  return formatHours(minutes / 60);
}

/** Whole minutes, `12,5` → `13 Min.` via the caller's unit label. */
export function formatMinutes(minutes: number): string {
  return formatNumber(Math.round(minutes), 0);
}

/** Integer cents in a currency: `1.234,50 €`, `12,00 USD`, or the bare amount when the file named none. */
export function formatCentsIn(cents: number, currency: string | null): string {
  if (currency === 'EUR') return formatEuroCents(cents);
  return currency ? `${formatCentsDe(cents)}${NBSP}${currency}` : formatCentsDe(cents);
}

export function formatPriceTotal(total: PriceTotal): string {
  return formatCentsIn(total.totalCents, total.currency);
}

/**
 * A trip's price for the screen. A number or a decimal string is written in
 * German notation with its currency; anything else is shown exactly as stored.
 */
export function formatTripPrice(price: number | string | null, currency: string | null): string {
  if (price === null || price === '') return '';
  try {
    return formatCentsIn(toCents(price), currency);
  } catch {
    return String(price);
  }
}

/** A stored euro amount (a salary, an hourly rate), or null when it is not one. */
export function formatStoredEuro(value: number | string | null): string | null {
  if (value === null || value === '') return null;
  try {
    return formatEuroCents(toCents(value));
  } catch {
    return null;
  }
}
