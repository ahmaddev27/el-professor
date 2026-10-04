import { amountInWordsFromCents } from './germanAmountInWords';
import { formatCentsDe, toCents } from './money';
import {
  berlinToday,
  snapshotFromReceiptRow,
  type ReceiptSnapshot,
  type ReceiptSnapshotRow,
} from './salaryCashReceiptFlow';
import { getBusinessMonth } from './weekCalculations';

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
 * the database stored. The same rule holds for the Abrechnungsmonat, which is
 * printed because the number's GQ-YYYY is the salary's business year rather
 * than the payment's: a confirmed receipt prints the stored business_month /
 * business_year, and only the preview — where no row exists — derives it. The
 * wording of the confirmation follows the Trinkgeld-Quittung.
 */

/**
 * `payment_view` is a read-only view of a cash payment that has no stored
 * Gehaltsquittung behind it (owner decision 03.10.2026: every cash payment in a
 * salary can be viewed). It is **not** a receipt: it carries no number, claims
 * no signature and is drawn from the payment row alone — see
 * paymentViewDocumentInput.
 */
export type ReceiptDocumentStatus = 'preview' | 'confirmed' | 'voided' | 'payment_view';

/**
 * A salary's business month — the month that owns the Monday of its period's
 * first week, the rule `get_business_month()` applies in the database and
 * `utils/weekCalculations` in the browser.
 *
 * **`month` counts from 1**, like the `business_month` column and
 * `get_business_month()`, and unlike `weekCalculations`, whose months count
 * from 0. The conversion happens once, in businessMonthOfPeriod().
 */
export interface ReceiptBusinessMonth {
  /** 1–12. */
  month: number;
  year: number;
}

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
  /**
   * The salary's Abrechnungsmonat, printed so that the GQ-YYYY in the number
   * explains itself: a period starting Thursday 01.01.2026 belongs to the
   * business month December 2025 and is numbered GQ-2025-….
   *
   * For a confirmed receipt this is the stored `business_month` /
   * `business_year` pair, never a value recomputed here —
   * storedReceiptDocumentInput is the only way it is filled. The preview, where
   * no row exists yet, derives it with businessMonthOfPeriod().
   */
  businessMonth: ReceiptBusinessMonth;
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
  /** The receipt number line, or null where the sheet prints none at all. */
  number: string | null;
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

/** Indexed from 0, so month 1 is MONTHS_DE[0]. The receipt is German in both UI languages. */
const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
] as const;

/**
 * A business month as the receipt prints it: "Dezember 2025".
 *
 * `month` counts from 1. A month outside 1–12 or a year that is not a whole
 * number cannot be printed, and throws for the reason germanDate does: a
 * receipt must not print a period it cannot read. The database's CHECK keeps
 * the stored column inside that range, so this only ever fires on data that
 * never came from confirm_salary_cash_payment.
 */
export function germanBusinessMonth(businessMonth: ReceiptBusinessMonth): string {
  const { month, year } = businessMonth;
  const name = Number.isInteger(month) ? MONTHS_DE[month - 1] : undefined;
  if (!name || !Number.isInteger(year)) {
    throw new RangeError(`germanBusinessMonth: ${month}/${year} is not a business month`);
  }
  return `${name} ${year}`;
}

/**
 * The business month a salary period falls in, for the **preview only**.
 *
 * A confirmed receipt prints the `business_month` / `business_year` the
 * database stored; recomputing those would let a later change to the calendar
 * rule silently reprint an issued document under a different month. Before
 * confirmation there is no row, so the preview derives the same value the RPC
 * will store, from the same rule — getBusinessMonth(), which is
 * get_business_month()'s browser twin.
 *
 * The date is read as local calendar parts rather than through
 * `new Date("YYYY-MM-DD")`, which parses as UTC midnight and lands on the
 * previous day west of Greenwich — which would move the week, and with it the
 * month, for every period starting on a Monday.
 *
 * @throws RangeError for anything that is not a YYYY-MM-DD date.
 */
export function businessMonthOfPeriod(periodStart: string): ReceiptBusinessMonth {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(periodStart);
  if (!match) throw new RangeError(`businessMonthOfPeriod: "${periodStart}" is not a YYYY-MM-DD date`);
  const local = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const { month, year } = getBusinessMonth(local);
  // getBusinessMonth counts months from 0; the stored column counts from 1.
  return { month: month + 1, year };
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
  // `payment_view` carries **no banner** (owner's decision, 04.10.2026). It used
  // to print "ZAHLUNGSANSICHT – keine Gehaltsquittung …", and he had it removed
  // along with the "Ohne Quittungsnummer" line, so the sheet he prints for a
  // driver reads as the document rather than as a caveat about it.
  //
  // What that costs, recorded because the code can no longer say it: the sheet is
  // now indistinguishable from a confirmed Gehaltsquittung except that it carries
  // no number, and nothing on it says a receipt was never stored. `preview` and
  // `voided` keep their banners — only this one state lost it.
  if (input.status === 'payment_view') return null;
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
  /** 1–12, from get_business_month(period_start). The number's GQ-YYYY is business_year. */
  business_month: number;
  business_year: number;
  payment_date: string;
  place: string;
  voided_at: string | null;
  void_reason: string | null;
}

/**
 * The document for a receipt the database stored: its own number, status,
 * snapshot and Abrechnungsmonat, never a value recomputed in the browser. A
 * voided receipt carries the Berlin day it was voided on.
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
    businessMonth: { month: receipt.business_month, year: receipt.business_year },
    paymentDate: receipt.payment_date,
    place: receipt.place,
    figures: snapshotFromReceiptRow(receipt),
    voided:
      receipt.status === 'voided' && receipt.voided_at
        ? { date: berlinToday(new Date(receipt.voided_at)), reason: receipt.void_reason ?? '' }
        : null,
  };
}

/** The part of a salary_payments row, and its salary, a payment view prints from. */
export interface PaymentViewFields {
  /** Euros, as the salary_payments column stores it. */
  amount: number | string;
  /** YYYY-MM-DD */
  paymentDate: string;
  /** YYYY-MM-DD */
  periodStart: string;
  /** YYYY-MM-DD */
  periodEnd: string;
}

/**
 * The document for a cash payment that has no stored receipt.
 *
 * It draws a number from nothing and writes nothing: receiptNumber is null and
 * stays null (the GQ-YYYY-NNNN sequence belongs to confirm_salary_cash_payment
 * alone), the status says what the sheet is, and the Abrechnungsmonat is
 * derived from the period exactly as the preview derives it, since no stored
 * row exists to read it from. Only the amount is printed from the payment; the
 * balance figures are not printed by any status, and are zero here rather than
 * invented.
 *
 * @throws RangeError for a date that is not YYYY-MM-DD or an amount toCents refuses.
 */
export function paymentViewDocumentInput(
  payment: PaymentViewFields,
  driver: ReceiptDocumentInput['driver'],
  company: ReceiptDocumentInput['company'],
): ReceiptDocumentInput {
  const amountCents = toCents(payment.amount);
  return {
    status: 'payment_view',
    receiptNumber: null,
    company,
    driver,
    periodStart: payment.periodStart,
    periodEnd: payment.periodEnd,
    businessMonth: businessMonthOfPeriod(payment.periodStart),
    paymentDate: payment.paymentDate,
    place: '',
    figures: {
      dueCents: 0,
      paidBankCents: 0,
      paidCashManualCents: 0,
      paidCashWeeklyCents: 0,
      paidCashReceiptsCents: 0,
      remainingBeforeCents: 0,
      amountCents,
      remainingAfterCents: 0,
      isPartial: false,
    },
    voided: null,
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
  const businessMonth = germanBusinessMonth(input.businessMonth);
  const paymentDate = germanDate(input.paymentDate);
  const amountFigures = euro(figures.amountCents);
  const amountWords = amountInWordsFromCents(figures.amountCents);
  const employee = `${salutation(input.driver.gender)}${input.driver.name}`;

  return {
    title: 'Gehaltsquittung',
    subtitle: 'Barzahlung des Gehalts',
    // A `payment_view` prints no number line at all rather than saying it has
    // none — the owner asked for both markers gone on 04.10.2026.
    number: input.receiptNumber
      ? `Nr. ${input.receiptNumber}`
      : input.status === 'payment_view'
        ? null
        : 'Nr. wird bei der Bestätigung vergeben',
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
    // The sheet names the Abrechnungsmonat and nothing else about the period.
    //
    // Owner's decision, 28.09.2026, marked on a printed receipt. It replaces the
    // half of the 18.09.2026 decision that put the Abrechnungsmonat *beside* the
    // Zeitraum: the month alone identifies the salary, and it is still the one
    // fact that explains the GQ-YYYY in the number, since a January period can
    // carry December's year.
    confirmation: input.status === 'payment_view'
      ? `Für das Gehalt für ${businessMonth} ist am ${paymentDate} eine Barzahlung von ${amountFigures} ` +
        `(in Worten: ${amountWords}) erfasst. Diese Ansicht wurde aus der erfassten Zahlung erstellt; ` +
        'eine Empfangsbestätigung des Arbeitnehmers liegt hier nicht vor.'
      : `Der Arbeitnehmer bestätigt hiermit, am ${paymentDate} als Barzahlung auf das Gehalt für ` +
      `${businessMonth} den Betrag von ${amountFigures} (in Worten: ${amountWords}) vom Arbeitgeber ` +
      'erhalten zu haben. Mit seiner Unterschrift bestätigt der Arbeitnehmer den Erhalt des oben ' +
      'genannten Betrages.',
    amount: { label: 'Betrag (EUR)', figures: amountFigures, words: amountWords },
    facts: [
      { label: 'Abrechnungsmonat', value: businessMonth, emphasis: false },
      { label: 'Zahlungsdatum', value: paymentDate, emphasis: false },
    ],
    // The salary-status table and the Teilzahlung sentence are gone, by the same
    // decision, and deliberately with nothing in their place: the sheet states the
    // amount, the month and the date of payment, and no balances at all.
    //
    // What that costs, said plainly because the owner chose it knowing: the signed
    // paper no longer distinguishes a part payment from a full one. Two receipts
    // for the same month read identically apart from their amount and number. The
    // distinction lives on the screen — GehaltsquittungModal still shows the full
    // balance before the payment is confirmed — and in the ledger, which keeps
    // every figure that used to be printed here.
    //
    // `figures` is still computed and still governs the refusal to pay more than
    // the balance; it simply is not printed.
    placeAndDate: {
      label: 'Ort, Datum',
      value: input.place.trim() ? `${input.place.trim()}, den ${paymentDate}` : `den ${paymentDate}`,
    },
    signatures: {
      employee: { caption: 'Unterschrift Arbeitnehmer', name: input.driver.name },
      employer: { caption: 'Unterschrift Arbeitgeber', name: input.company.name },
    },
    fileName: [
      'Gehaltsquittung',
      input.receiptNumber ?? (input.status === 'payment_view' ? 'Zahlungsansicht' : 'Vorschau'),
      fileNamePart(input.driver.name),
      ...(input.status === 'voided' ? ['STORNIERT'] : []),
    ].join('_'),
  };
}
