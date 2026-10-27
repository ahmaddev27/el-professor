/**
 * How a Beleg's edit history reads on screen (table `receipt_edits`,
 * 20261027160000).
 *
 * Pure: no React, no network. The modal asks this module which label a logged
 * field carries and shows the stored values VERBATIM — the log holds the
 * column's own text ('41.08', '14:32:00'), and reformatting an audit value is
 * how a display helper ends up disagreeing with what the database recorded.
 * An unknown field name (a column added later, logged by the generic trigger
 * before anyone taught this map) falls back to the raw column name rather
 * than hiding the entry: a history that omits a change is worse than one with
 * an untranslated label.
 */
import type { TranslationKey } from '../i18n';

export interface ReceiptEditEntry {
  id: string;
  action: 'change' | 'confirm';
  field: string;
  oldValue: string | null;
  newValue: string | null;
  editedBy: string;
  /** ISO timestamptz, as PostgREST serialises it. */
  editedAt: string;
}

/** A `receipt_edits` row as PostgREST returns it, typed at the seam. */
export function mapReceiptEditRow(row: Record<string, unknown>): ReceiptEditEntry {
  return {
    id: String(row.id ?? ''),
    action: row.action === 'confirm' ? 'confirm' : 'change',
    field: String(row.field ?? ''),
    oldValue: row.old_value === null || row.old_value === undefined ? null : String(row.old_value),
    newValue: row.new_value === null || row.new_value === undefined ? null : String(row.new_value),
    editedBy: String(row.edited_by ?? ''),
    editedAt: String(row.edited_at ?? ''),
  };
}

/**
 * The label each logged column already has on the form, so the history and
 * the field it names never carry two different words. Null for a column the
 * screen has no label for — the caller shows the raw name then.
 */
const FIELD_LABEL_KEYS: Record<string, TranslationKey> = {
  receipt_number: 'rec.receiptNumber',
  date: 'common.date',
  description: 'rec.bookingText',
  driver_name: 'common.driver',
  expense: 'common.expenses',
  postal_code: 'rec.postalCode',
  city: 'rec.city',
  payment_method: 'rec.paymentMethod',
  merchant_name: 'rec.merchant',
  receipt_time: 'rec.receiptTime',
  litres: 'rec.litres',
  price_per_litre: 'rec.pricePerLitre',
  odometer_km: 'rec.odometerKm',
  range_km: 'rec.rangeKm',
  street: 'rec.street',
  station_name: 'rec.stationName',
  operator_name: 'rec.operatorName',
  printed_receipt_number: 'rec.printedNumber',
  tse_time: 'rec.tseTime',
};

export function receiptEditFieldKey(field: string): TranslationKey | null {
  return FIELD_LABEL_KEYS[field] ?? null;
}

/** Newest first, ties broken by id so the order is stable across reloads. */
export function sortReceiptEdits(entries: ReceiptEditEntry[]): ReceiptEditEntry[] {
  return [...entries].sort((a, b) => {
    if (a.editedAt !== b.editedAt) return a.editedAt < b.editedAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}
