import { amountInWordsFromCents } from './germanAmountInWords';
import { formatCentsDe } from './money';
import {
  berlinToday,
  snapshotFromReceiptRow,
  type ReceiptSnapshot,
  type ReceiptSnapshotRow,
} from './salaryCashReceiptFlow';

/**
 * The text of a Gehaltsquittung (cash salary receipt).
 *
 * German in both UI languages: the receipt is a statutory document, one of the
 * closed list in src/i18n/index.ts, so nothing here goes through the
 * dictionaries and the builder takes no language. The screen preview and the
 * PDF render the same text, so what the user confirms is what prints.
 *
 * Every figure arrives as a ReceiptSnapshot and is only formatted here: before
 * confirmation the preview's computeReceiptFigures result, after it the row
 * the database stored. The wording of the confirmation follows the
 * Trinkgeld-Quittung.
 */

export type ReceiptDocumentStatus = 'preview' | 'confirmed' | 'voided';

export interface ReceiptDocumentInput {
  status: ReceiptDocumentStatus;
  /**
   * GQ-YYYY-NNNN, issued by the database; null in the preview.
   *
   * **Never predict it here.** `confirm_salary_cash_payment` draws it from a
   * counter row it locks inside its own transaction, so only that transaction
   * knows the sequence. The YYYY is the *salary's* business year — the
   * `business_year` the receipt stores, not the year of the payment date
   * (owner decision 17.09.2026, migration `20260919160000`) — and receipts
   * issued before that migration carry the payment year instead, so the number
   * cannot be derived from the row's other fields either.
   */
  receiptNumber: string | null;
  company: { name: string; addressLines: readonly string[] };
  driver: { name: string; gender: 'male' | 'female' | null };
  /** YYYY-MM-DD */
  periodStart: string;
  /** YYYY-MM-DD */
  periodEnd: string;
  /** YYYY-MM-DD */
  paymentDate: string;
  place: string;
  figures: ReceiptSnapshot;
  /** For a voided receipt: the day it was voided (YYYY-MM-DD) and why. */
  voided?: { date: string; reason: string } | null;
}

export interface ReceiptDocumentRow {
  label: string;
  value: string;
  emphasis: boolean;
}

export interface ReceiptDocumentText {
  title: string;
  subtitle: string;
  number: string;
  /** A notice across the top: the preview is not valid, a voided receipt is void. */
  banner: string | null;
  company: { name: string; addressLines: string[] };
  parties: {
    between: string;
    employee: string;
    employeeNote: string;
    and: string;
    employer: string;
    employerNote: string;
  };
  confirmation: string;
  amount: { label: string; figures: string; words: string };
  facts: ReceiptDocumentRow[];
  balanceHeading: string;
  balance: ReceiptDocumentRow[];
  settlement: string;
  placeAndDate: { label: string; value: string };
  signatures: {
    employee: { caption: string; name: string };
    employer: { caption: string; name: string };
  };
  /** Without the .pdf extension. */
  fileName: string;
}

/** YYYY-MM-DD → DD.MM.YYYY. A receipt must not print a date it cannot read, so anything else throws. */
export function germanDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new RangeError(`germanDate: "${isoDate}" is not a YYYY-MM-DD date`);
  return `${match[3]}.${match[2]}.${match[1]}`;
}

const euro = (cents: number) => `${formatCentsDe(cents)} EUR`;

function salutation(gender: 'male' | 'female' | null): string {
  if (gender === 'male') return 'Herr ';
  if (gender === 'female') return 'Frau ';
  return '';
}

function fileNamePart(text: string): string {
  return text.trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_');
}

function banner(input: ReceiptDocumentInput): string | null {
  if (input.status === 'preview') return 'VORSCHAU – noch nicht bestätigt und nicht gültig';
  if (input.status === 'voided') {
    const when = input.voided ? ` am ${germanDate(input.voided.date)}` : '';
    const why = input.voided?.reason.trim() ? ` – Grund: ${input.voided.reason.trim()}` : '';
    return `STORNIERT${when}${why}`;
  }
  return null;
}

export interface CompanyAddressSettings {
  company_name?: string | null;
  legal_company_name?: string | null;
  street?: string | null;
  house_number?: string | null;
  postal_code?: string | null;
  city?: string | null;
}

/** The issuing company as the receipt names it: the legal name when there is one, as the Trinkgeld-Quittung's letterhead does. */
export function receiptCompany(settings: CompanyAddressSettings | null): { name: string; addressLines: string[] } {
  const name = settings?.legal_company_name?.trim() || settings?.company_name?.trim() || '';
  const street = [settings?.street, settings?.house_number].filter(Boolean).join(' ');
  const city = [settings?.postal_code, settings?.city].filter(Boolean).join(' ');
  return { name, addressLines: [street, city].filter(Boolean) };
}

/** The salary_cash_receipts columns a stored receipt prints from. */
export interface StoredReceiptFields extends ReceiptSnapshotRow {
  receipt_number: string;
  status: 'confirmed' | 'voided';
  period_start: string;
  period_end: string;
  payment_date: string;
  place: string;
  voided_at: string | null;
  void_reason: string | null;
}

/**
 * The document for a receipt the database stored: its own number, status and
 * snapshot, never a figure recomputed in the browser. A voided receipt carries
 * the Berlin day it was voided on.
 */
export function storedReceiptDocumentInput(
  receipt: StoredReceiptFields,
  driver: ReceiptDocumentInput['driver'],
  company: ReceiptDocumentInput['company'],
): ReceiptDocumentInput {
  return {
    status: receipt.status,
    receiptNumber: receipt.receipt_number,
    company,
    driver,
    periodStart: receipt.period_start,
    periodEnd: receipt.period_end,
    paymentDate: receipt.payment_date,
    place: receipt.place,
    figures: snapshotFromReceiptRow(receipt),
    voided:
      receipt.status === 'voided' && receipt.voided_at
        ? { date: berlinToday(new Date(receipt.voided_at)), reason: receipt.void_reason ?? '' }
        : null,
  };
}

export type ReceiptDocumentProblem = 'missing_driver_name' | 'missing_company_name';

/**
 * Why a receipt cannot be printed, or null. A receipt with an empty name would
 * carry an unnamed signature line. The names are today's company settings and
 * driver record, not a copy taken at confirmation; keeping one on the receipt
 * is database work.
 */
export function receiptDocumentProblem(input: Pick<ReceiptDocumentInput, 'driver' | 'company'>): ReceiptDocumentProblem | null {
  if (!input.company.name.trim()) return 'missing_company_name';
  if (!input.driver.name.trim()) return 'missing_driver_name';
  return null;
}

export class ReceiptDocumentError extends Error {
  readonly problem: ReceiptDocumentProblem;

  constructor(problem: ReceiptDocumentProblem) {
    super(`Gehaltsquittung cannot be printed: ${problem}`);
    this.name = 'ReceiptDocumentError';
    this.problem = problem;
  }
}

/**
 * @throws ReceiptDocumentError when the driver or company name is empty.
 * @throws RangeError for a date that is not YYYY-MM-DD, or an amount too large to write in words.
 */
export function buildReceiptDocumentText(input: ReceiptDocumentInput): ReceiptDocumentText {
  const problem = receiptDocumentProblem(input);
  if (problem) throw new ReceiptDocumentError(problem);
  const { figures } = input;
  const period = `${germanDate(input.periodStart)} – ${germanDate(input.periodEnd)}`;
  const paymentDate = germanDate(input.paymentDate);
  const amountFigures = euro(figures.amountCents);
  const amountWords = amountInWordsFromCents(figures.amountCents);
  const employee = `${salutation(input.driver.gender)}${input.driver.name}`;

  return {
    title: 'Gehaltsquittung',
    subtitle: 'Barzahlung des Gehalts',
    number: input.receiptNumber ? `Nr. ${input.receiptNumber}` : 'Nr. wird bei der Bestätigung vergeben',
    banner: banner(input),
    company: { name: input.company.name, addressLines: [...input.company.addressLines] },
    parties: {
      between: 'Zwischen',
      employee,
      employeeNote: '(nachfolgend Arbeitnehmer genannt)',
      and: 'und',
      employer: `der Firma ${input.company.name}`,
      employerNote: '(nachfolgend Arbeitgeber genannt)',
    },
    confirmation:
      `Der Arbeitnehmer bestätigt hiermit, am ${paymentDate} als Barzahlung auf das Gehalt für den Zeitraum ` +
      `${period} den Betrag von ${amountFigures} (in Worten: ${amountWords}) vom Arbeitgeber erhalten zu haben. ` +
      'Mit seiner Unterschrift bestätigt der Arbeitnehmer den Erhalt des oben genannten Betrages.',
    amount: { label: 'Betrag (EUR)', figures: amountFigures, words: amountWords },
    facts: [
      { label: 'Zeitraum', value: period, emphasis: false },
      { label: 'Zahlungsdatum', value: paymentDate, emphasis: false },
    ],
    balanceHeading: 'Stand des Gehalts bei dieser Zahlung',
    balance: [
      { label: 'Fälliges Nettogehalt', value: euro(figures.dueCents), emphasis: false },
      { label: 'Bereits überwiesen', value: euro(figures.paidBankCents), emphasis: false },
      { label: 'Bereits bar gezahlt', value: euro(figures.paidCashManualCents), emphasis: false },
      { label: 'Bar zurück aus der Wochenabrechnung', value: euro(figures.paidCashWeeklyCents), emphasis: false },
      { label: 'Frühere Gehaltsquittungen', value: euro(figures.paidCashReceiptsCents), emphasis: false },
      { label: 'Offen vor dieser Zahlung', value: euro(figures.remainingBeforeCents), emphasis: true },
      { label: 'Diese Barzahlung', value: amountFigures, emphasis: false },
      { label: 'Offen nach dieser Zahlung', value: euro(figures.remainingAfterCents), emphasis: true },
    ],
    settlement: figures.isPartial
      ? `Teilzahlung: Nach dieser Zahlung bleiben ${euro(figures.remainingAfterCents)} offen.`
      : 'Mit dieser Zahlung ist das Gehalt für den Zeitraum vollständig bezahlt.',
    placeAndDate: { label: 'Ort, Datum', value: `${input.place.trim()}, den ${paymentDate}` },
    signatures: {
      employee: { caption: 'Unterschrift Arbeitnehmer', name: input.driver.name },
      employer: { caption: 'Unterschrift Arbeitgeber', name: input.company.name },
    },
    fileName: [
      'Gehaltsquittung',
      input.receiptNumber ?? 'Vorschau',
      fileNamePart(input.driver.name),
      ...(input.status === 'voided' ? ['STORNIERT'] : []),
    ].join('_'),
  };
}
