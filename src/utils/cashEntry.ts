import { parseGermanAmountToCents } from './money';

/**
 * Input rules for a manual till entry (record_cash_movement). Pure, so the
 * dialog's validation can be tested; the database checks every one of these
 * again and stays the boundary.
 */

export type CashEntryDirection = 'in' | 'out';

export type CashEntryFieldError = 'amount' | 'date' | 'dateFuture' | 'purpose';

export interface CashEntryInput {
  amountText: string;
  /** `TT.MM.JJJJ`, the way the rest of the product writes a date. */
  dateText: string;
  purpose: string;
}

export interface ValidCashEntry {
  amountCents: number;
  /** `YYYY-MM-DD` */
  date: string;
  purpose: string;
}

export const CASH_ENTRY_PURPOSE_MAX = 200;
/** The database's lower bound for a movement date. */
const EARLIEST_YEAR = 2000;

/** `DD.MM.YYYY` to `YYYY-MM-DD`, or null for anything that is not a real calendar day. */
export function parseGermanDate(text: string): string | null {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  const real = probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
  if (!real || year < EARLIEST_YEAR) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` to `DD.MM.YYYY`. */
export function formatGermanDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}

/** The problems per field, or the entry ready to send. `today` is `YYYY-MM-DD`, compared as text. */
export function validateCashEntry(
  input: CashEntryInput,
  today: string,
): { ok: true; entry: ValidCashEntry } | { ok: false; errors: Partial<Record<CashEntryFieldError, true>> } {
  const errors: Partial<Record<CashEntryFieldError, true>> = {};
  const amountCents = parseGermanAmountToCents(input.amountText);
  if (amountCents === null || amountCents <= 0) errors.amount = true;

  const date = parseGermanDate(input.dateText);
  if (date === null) errors.date = true;
  else if (date > today) errors.dateFuture = true;

  const purpose = input.purpose.trim();
  if (purpose === '' || purpose.length > CASH_ENTRY_PURPOSE_MAX) errors.purpose = true;

  if (Object.keys(errors).length > 0 || amountCents === null || date === null) return { ok: false, errors };
  return { ok: true, entry: { amountCents, date, purpose } };
}

export type CashEntryRefusal =
  | 'not_authorized'
  | 'platform_session_not_allowed'
  | 'invalid_amount'
  | 'invalid_date'
  | 'invalid_description'
  | 'invalid_request'
  | 'request_id_conflict'
  /** No answer came back: the entry may or may not have been booked. */
  | 'no_response'
  | 'unexpected';

const DATABASE_REFUSALS: readonly string[] = [
  'not_authorized',
  'platform_session_not_allowed',
  'invalid_amount',
  'invalid_date',
  'invalid_description',
  'invalid_request',
  'request_id_conflict',
];

/** The stable reason is the HINT; the German message is never shown or matched. */
export function cashEntryRefusal(error: { code?: string | null; hint?: string | null }): CashEntryRefusal {
  const hint = error.hint ?? '';
  if (DATABASE_REFUSALS.includes(hint)) return hint as CashEntryRefusal;
  if (!error.code) return 'no_response';
  if (error.code === '42501') return 'not_authorized';
  return 'unexpected';
}
