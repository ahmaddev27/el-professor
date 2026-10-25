/**
 * What the Beleg form captures, and the rules that decide whether it may be
 * saved. The company panel and the driver app capture the same Beleg, so these
 * are the driver app's rules (its `receipt-steps.ts`), restated here because
 * that repository cannot be imported.
 *
 * Pure: no React, no network. The form asks this module and nothing else about
 * which fields exist for a category and which are refused.
 *
 * Three rules to keep:
 *  - The refuel figures (litres, unit price, odometer, range) exist only for
 *    the refuel category. Leaving that category drops them on save.
 *  - An absent figure is `undefined` all the way to the column, never 0: a
 *    missing odometer is not a reading of zero.
 *  - The unit price keeps three decimals. A pump prints three; two is a silent
 *    rounding. Nothing here rounds a figure.
 *
 * `receipts.category` does not exist: the category is `receipts.description`
 * (`Tanken` there is what the Tankenquote counts), so it is not a field here.
 */
import type { Receipt } from '../types/receipt';

// These values are written to `receipts.description` and compared on read.
// Only their labels are translated.
export const RECEIPT_CATEGORIES = [
  'Tanken',
  'Autowäsche',
  'Autozubehör',
  'Öl wechseln',
  'Other',
] as const;

export type ReceiptCategory = (typeof RECEIPT_CATEGORIES)[number];

/** The one category that carries fuel figures. */
export const FUEL_CATEGORY: ReceiptCategory = 'Tanken';

export function hasFuelFigures(category: string | null | undefined): boolean {
  return category === FUEL_CATEGORY;
}

/** The form's fields as typed: strings, German decimal comma, `HH:MM`. */
export interface ReceiptDetailsFields {
  merchant: string;
  receiptTime: string;
  postalCode: string;
  city: string;
  litres: string;
  pricePerLitre: string;
  odometerKm: string;
  rangeKm: string;
}

export const EMPTY_DETAILS: ReceiptDetailsFields = {
  merchant: '',
  receiptTime: '',
  postalCode: '',
  city: '',
  litres: '',
  pricePerLitre: '',
  odometerKm: '',
  rangeKm: '',
};

/** The values that reach the columns; `undefined` is an absent figure. */
export interface ReceiptDetailsValues {
  merchantName?: string;
  receiptTime?: string;
  litres?: number;
  pricePerLitre?: number;
  odometerKm?: number;
  rangeKm?: number;
}

/**
 * `create` holds a new Beleg to the driver app's full rule. `edit` lets a field
 * that is empty stay empty - Belege entered before these fields existed have
 * none of them - but a field that is filled must still be valid.
 */
export type ReceiptFormMode = 'create' | 'edit';

export type ReceiptProblemKey =
  | 'rec.err.merchantRequired'
  | 'rec.err.cityRequired'
  | 'rec.err.timeInvalid'
  | 'rec.err.plzInvalid'
  | 'rec.err.litresInvalid'
  | 'rec.err.priceInvalid'
  | 'rec.err.odometerInvalid'
  | 'rec.err.rangeInvalid';

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const POSTAL_CODE = /^\d{5}$/;
const LITRES_MAX = 2000;
const PRICE_MAX = 20;
const RANGE_MAX = 2000;

/**
 * A German-typed decimal as a number: `41,47` and `41.47` both read, a
 * thousands separator does not (`1.234,5` is refused rather than guessed).
 * Null for anything that is not a plain decimal with at most `places` digits.
 */
export function parseDecimal(input: string, places: number): number | null {
  const cleaned = input.trim().replace(/\s/g, '').replace(',', '.');
  if (!new RegExp(`^\\d{1,8}(\\.\\d{1,${places}})?$`).test(cleaned)) return null;
  return Number(cleaned);
}

function decimalInRange(input: string, places: number, max: number): boolean {
  const value = parseDecimal(input, places);
  return value !== null && value > 0 && value <= max;
}

function isBlank(value: string): boolean {
  return value.trim() === '';
}

function odometerProblem(odometer: string, mode: ReceiptFormMode): ReceiptProblemKey | null {
  if (isBlank(odometer)) return mode === 'create' ? 'rec.err.odometerInvalid' : null;
  return /^\d{4,7}$/.test(odometer.trim()) ? null : 'rec.err.odometerInvalid';
}

function rangeProblem(range: string): ReceiptProblemKey | null {
  if (isBlank(range)) return null;
  const text = range.trim();
  return /^\d{1,4}$/.test(text) && Number(text) <= RANGE_MAX ? null : 'rec.err.rangeInvalid';
}

function requiredText(value: string, mode: ReceiptFormMode, key: ReceiptProblemKey): ReceiptProblemKey | null {
  return mode === 'create' && isBlank(value) ? key : null;
}

function timeProblem(time: string, mode: ReceiptFormMode): ReceiptProblemKey | null {
  if (isBlank(time)) return mode === 'create' ? 'rec.err.timeInvalid' : null;
  return CLOCK.test(time.trim()) ? null : 'rec.err.timeInvalid';
}

function postalProblem(postalCode: string): ReceiptProblemKey | null {
  return isBlank(postalCode) || POSTAL_CODE.test(postalCode.trim()) ? null : 'rec.err.plzInvalid';
}

function fuelProblem(f: ReceiptDetailsFields, mode: ReceiptFormMode): ReceiptProblemKey | null {
  if (isBlank(f.litres)) {
    if (mode === 'create') return 'rec.err.litresInvalid';
  } else if (!decimalInRange(f.litres, 2, LITRES_MAX)) return 'rec.err.litresInvalid';
  if (isBlank(f.pricePerLitre)) {
    if (mode === 'create') return 'rec.err.priceInvalid';
  } else if (!decimalInRange(f.pricePerLitre, 3, PRICE_MAX)) return 'rec.err.priceInvalid';
  return odometerProblem(f.odometerKm, mode) ?? rangeProblem(f.rangeKm);
}

/**
 * The first reason the details cannot be saved, in the order the form reads, or
 * null. The fuel figures are checked only for the refuel category, exactly as
 * they are shown only for it.
 */
export function receiptDetailsProblem(
  category: string,
  fields: ReceiptDetailsFields,
  mode: ReceiptFormMode,
): ReceiptProblemKey | null {
  return (
    requiredText(fields.merchant, mode, 'rec.err.merchantRequired') ??
    postalProblem(fields.postalCode) ??
    requiredText(fields.city, mode, 'rec.err.cityRequired') ??
    timeProblem(fields.receiptTime, mode) ??
    (hasFuelFigures(category) ? fuelProblem(fields, mode) : null)
  );
}

function textOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function wholeNumberOrUndefined(value: string): number | undefined {
  return isBlank(value) ? undefined : Number(value.trim());
}

function decimalOrUndefined(value: string, places: number): number | undefined {
  return isBlank(value) ? undefined : (parseDecimal(value, places) ?? undefined);
}

/**
 * The typed fields as the values to store. Fuel figures are dropped for any
 * other category, so a stale litre count cannot ride along on a car wash.
 */
export function receiptDetailsValues(category: string, f: ReceiptDetailsFields): ReceiptDetailsValues {
  const fuel = hasFuelFigures(category);
  return {
    merchantName: textOrUndefined(f.merchant),
    receiptTime: textOrUndefined(f.receiptTime),
    litres: fuel ? decimalOrUndefined(f.litres, 2) : undefined,
    pricePerLitre: fuel ? decimalOrUndefined(f.pricePerLitre, 3) : undefined,
    odometerKm: fuel ? wholeNumberOrUndefined(f.odometerKm) : undefined,
    rangeKm: fuel ? wholeNumberOrUndefined(f.rangeKm) : undefined,
  };
}

/** A stored figure as typed in the form: German comma, nothing padded or rounded. */
export function figureToInput(value: number | undefined): string {
  return value === undefined ? '' : String(value).split('.').join(',');
}

/** `14:32:00` from a `time` column as `14:32`; anything else is empty. */
function clockToInput(value: string | undefined): string {
  const match = value === undefined ? null : /^(\d{2}):(\d{2})/.exec(value);
  return match === null ? '' : `${match[1]}:${match[2]}`;
}

/** The form's fields for a stored Beleg; what it does not carry stays empty. */
export function detailsFieldsFromReceipt(receipt: Receipt): ReceiptDetailsFields {
  return {
    merchant: receipt.merchantName ?? '',
    receiptTime: clockToInput(receipt.receiptTime),
    postalCode: receipt.postalCode ?? '',
    city: receipt.city ?? '',
    litres: figureToInput(receipt.litres),
    pricePerLitre: figureToInput(receipt.pricePerLitre),
    odometerKm: figureToInput(receipt.odometerKm),
    rangeKm: figureToInput(receipt.rangeKm),
  };
}
