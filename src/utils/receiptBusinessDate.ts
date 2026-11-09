/**
 * The day a Beleg counts on (owner's decision, 09.11.2026).
 *
 * A Beleg whose printed time is before 04:00 counts on the PREVIOUS calendar
 * day, in every place a receipt is counted: the weekly Abrechnung, the
 * Tankenquote, the till, the Overview. Uber income already runs on a 04:00
 * operating day (`uberPeriods.ts`); the receipts were the half that used
 * midnight, so "Abzugeben = Bargeld - Belege" compared two different weeks.
 *
 * The database holds the same rule as `public.receipt_business_date(date,
 * time)` and stores it in `receipts.business_date`; this is its browser twin,
 * for a row that lacks the column. `receiptBusinessDate.test.ts` reads the
 * newest migration that defines the SQL function and fails when its cut
 * differs from `RECEIPT_DAY_START`.
 *
 * `receipt_time` is the wall-clock time PRINTED on the Beleg, so there is no
 * time-zone conversion anywhere, and the day is subtracted on the calendar
 * date (UTC arithmetic on year/month/day), never on a local `Date`.
 * What a screen shows as the receipt's date and time does not change.
 */
export const RECEIPT_DAY_START = '04:00';

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/** `YYYY-MM-DD` of the calendar day before `isoDate`. */
function dayBefore(isoDate: string): string {
  const match = ISO_DAY.exec(isoDate);
  if (!match) return isoDate;
  const previous = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) - 1));
  return previous.toISOString().slice(0, 10);
}

/**
 * `date` is `YYYY-MM-DD`, `time` is `HH:MM` or `HH:MM:SS` or absent. A time
 * before 04:00:00 (03:59:59 moves, 04:00:00 stays) moves the day back by one;
 * a missing or unreadable time keeps the printed date.
 */
export function receiptBusinessDate(date: string, time?: string | null): string {
  const day = ISO_DAY.exec(date)?.[0];
  if (!day) return date;
  const clock = (time ?? '').trim();
  if (!/^\d{2}:\d{2}/.test(clock)) return day;
  // Zero-padded clock text compares in time order; "04:00:00" is not < "04:00".
  return clock < RECEIPT_DAY_START ? dayBefore(day) : day;
}

/** The day a loaded Beleg counts on: the column when the row has it, else the rule. */
export function receiptCountsOn(receipt: {
  date: string;
  receiptTime?: string | null;
  businessDate?: string | null;
}): string {
  return receipt.businessDate || receiptBusinessDate(receipt.date, receipt.receiptTime);
}
