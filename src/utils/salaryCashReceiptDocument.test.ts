import { describe, expect, it } from 'vitest';
import { MAX_AMOUNT_IN_WORDS_CENTS } from './germanAmountInWords';
import {
  ReceiptDocumentError,
  buildReceiptDocumentText,
  germanDate,
  receiptCompany,
  receiptDocumentProblem,
  storedReceiptDocumentInput,
  type ReceiptDocumentInput,
} from './salaryCashReceiptDocument';

/**
 * The Gehaltsquittung text is German in both UI languages, so these strings are
 * asserted byte for byte: a changed word here is a changed statutory document.
 */

const partial: ReceiptDocumentInput = {
  status: 'confirmed',
  receiptNumber: 'GQ-2026-0012',
  company: { name: 'Muster Mietwagen GmbH', addressLines: ['Hauptstraße 5', '10115 Berlin'] },
  driver: { name: 'Max Mustermann', gender: 'male' },
  periodStart: '2026-08-03',
  periodEnd: '2026-08-30',
  paymentDate: '2026-09-14',
  place: ' Berlin ',
  figures: {
    dueCents: 250000,
    paidBankCents: 100000,
    paidCashManualCents: 2000,
    paidCashWeeklyCents: 5000,
    paidCashReceiptsCents: 0,
    remainingBeforeCents: 143000,
    amountCents: 123456,
    remainingAfterCents: 19544,
    isPartial: true,
  },
};

describe('buildReceiptDocumentText — a confirmed partial payment', () => {
  const text = buildReceiptDocumentText(partial);

  it('names the document, its number and the parties', () => {
    expect(text.title).toBe('Gehaltsquittung');
    expect(text.subtitle).toBe('Barzahlung des Gehalts');
    expect(text.number).toBe('Nr. GQ-2026-0012');
    expect(text.banner).toBeNull();
    expect(text.company).toEqual({ name: 'Muster Mietwagen GmbH', addressLines: ['Hauptstraße 5', '10115 Berlin'] });
    expect(text.parties).toEqual({
      between: 'Zwischen',
      employee: 'Herr Max Mustermann',
      employeeNote: '(nachfolgend Arbeitnehmer genannt)',
      and: 'und',
      employer: 'der Firma Muster Mietwagen GmbH',
      employerNote: '(nachfolgend Arbeitgeber genannt)',
    });
  });

  it('writes the amount in German figures and words', () => {
    expect(text.amount).toEqual({
      label: 'Betrag (EUR)',
      figures: '1.234,56 EUR',
      words: 'Eintausendzweihundertvierunddreißig Euro und sechsundfünfzig Cent',
    });
  });

  it('states the confirmation with period, payment date, figures and words', () => {
    expect(text.confirmation).toBe(
      'Der Arbeitnehmer bestätigt hiermit, am 14.09.2026 als Barzahlung auf das Gehalt für den Zeitraum ' +
        '03.08.2026 – 30.08.2026 den Betrag von 1.234,56 EUR (in Worten: Eintausendzweihundertvierunddreißig Euro ' +
        'und sechsundfünfzig Cent) vom Arbeitgeber erhalten zu haben. Mit seiner Unterschrift bestätigt der ' +
        'Arbeitnehmer den Erhalt des oben genannten Betrages.',
    );
    expect(text.facts).toEqual([
      { label: 'Zeitraum', value: '03.08.2026 – 30.08.2026', emphasis: false },
      { label: 'Zahlungsdatum', value: '14.09.2026', emphasis: false },
    ]);
  });

  it('prints the balance the snapshot holds, Bar zurück on its own line, in German number format', () => {
    expect(text.balance.map(row => [row.label, row.value])).toEqual([
      ['Fälliges Nettogehalt', '2.500,00 EUR'],
      ['Bereits überwiesen', '1.000,00 EUR'],
      ['Bereits bar gezahlt', '20,00 EUR'],
      ['Bar zurück aus der Wochenabrechnung', '50,00 EUR'],
      ['Frühere Gehaltsquittungen', '0,00 EUR'],
      ['Offen vor dieser Zahlung', '1.430,00 EUR'],
      ['Diese Barzahlung', '1.234,56 EUR'],
      ['Offen nach dieser Zahlung', '195,44 EUR'],
    ]);
    expect(text.settlement).toBe('Teilzahlung: Nach dieser Zahlung bleiben 195,44 EUR offen.');
  });

  it('closes with place, date and both signature lines', () => {
    expect(text.placeAndDate).toEqual({ label: 'Ort, Datum', value: 'Berlin, den 14.09.2026' });
    expect(text.signatures).toEqual({
      employee: { caption: 'Unterschrift Arbeitnehmer', name: 'Max Mustermann' },
      employer: { caption: 'Unterschrift Arbeitgeber', name: 'Muster Mietwagen GmbH' },
    });
    expect(text.fileName).toBe('Gehaltsquittung_GQ-2026-0012_Max_Mustermann');
  });
});

describe('buildReceiptDocumentText — other states', () => {
  it('says so when the payment settles the salary', () => {
    const text = buildReceiptDocumentText({
      ...partial,
      figures: { ...partial.figures, amountCents: 143000, remainingAfterCents: 0, isPartial: false },
    });
    expect(text.settlement).toBe('Mit dieser Zahlung ist das Gehalt für den Zeitraum vollständig bezahlt.');
    expect(text.amount.words).toBe('Eintausendvierhundertdreißig Euro und null Cent');
  });

  it('marks the preview as not valid and leaves the number to the database', () => {
    const text = buildReceiptDocumentText({ ...partial, status: 'preview', receiptNumber: null });
    expect(text.number).toBe('Nr. wird bei der Bestätigung vergeben');
    expect(text.banner).toBe('VORSCHAU – noch nicht bestätigt und nicht gültig');
    expect(text.fileName).toBe('Gehaltsquittung_Vorschau_Max_Mustermann');
  });

  it('marks a voided receipt with the day and reason, in the file name too', () => {
    const text = buildReceiptDocumentText({
      ...partial,
      status: 'voided',
      voided: { date: '2026-09-15', reason: '  Falscher Betrag erfasst ' },
    });
    expect(text.banner).toBe('STORNIERT am 15.09.2026 – Grund: Falscher Betrag erfasst');
    expect(text.number).toBe('Nr. GQ-2026-0012');
    expect(text.fileName).toBe('Gehaltsquittung_GQ-2026-0012_Max_Mustermann_STORNIERT');
  });

  it('addresses a woman as Frau and leaves out a salutation it does not know', () => {
    expect(buildReceiptDocumentText({ ...partial, driver: { name: 'Anna Beispiel', gender: 'female' } }).parties.employee).toBe('Frau Anna Beispiel');
    expect(buildReceiptDocumentText({ ...partial, driver: { name: 'Sam Beispiel', gender: null } }).parties.employee).toBe('Sam Beispiel');
  });

  it('keeps a file name free of path characters', () => {
    const text = buildReceiptDocumentText({ ...partial, driver: { name: 'Ali / Özdemir-Nowak', gender: null } });
    expect(text.fileName).toBe('Gehaltsquittung_GQ-2026-0012_Ali_Özdemir-Nowak');
  });

  it('refuses what it cannot print correctly', () => {
    expect(() => buildReceiptDocumentText({ ...partial, paymentDate: '14.09.2026' })).toThrow(RangeError);
    expect(() =>
      buildReceiptDocumentText({ ...partial, figures: { ...partial.figures, amountCents: MAX_AMOUNT_IN_WORDS_CENTS + 1 } }),
    ).toThrow(RangeError);
  });
});

describe('receiptCompany', () => {
  it('prefers the legal name and builds the address lines', () => {
    expect(
      receiptCompany({
        company_name: 'Muster Taxi',
        legal_company_name: 'Muster Mietwagen GmbH',
        street: 'Hauptstraße',
        house_number: '5',
        postal_code: '10115',
        city: 'Berlin',
      }),
    ).toEqual({ name: 'Muster Mietwagen GmbH', addressLines: ['Hauptstraße 5', '10115 Berlin'] });
  });

  it('falls back to the company name and leaves out missing address parts', () => {
    expect(receiptCompany({ company_name: 'Muster Taxi', legal_company_name: ' ', city: 'Berlin' })).toEqual({
      name: 'Muster Taxi',
      addressLines: ['Berlin'],
    });
    expect(receiptCompany(null)).toEqual({ name: '', addressLines: [] });
  });
});

describe('storedReceiptDocumentInput — a stored receipt prints its own snapshot', () => {
  const stored = {
    receipt_number: 'GQ-2026-0012',
    status: 'voided' as const,
    period_start: '2026-08-03',
    period_end: '2026-08-30',
    payment_date: '2026-09-14',
    place: 'Berlin',
    due_amount: '2500.00',
    paid_bank_before: 1000,
    paid_cash_manual_before: '20.00',
    paid_cash_weekly_before: '50.00',
    paid_cash_receipts_before: 0,
    remaining_before: '1430.00',
    amount: '1234.56',
    remaining_after: '195.44',
    is_partial: true,
    // 00:30 on 16 September in Berlin.
    voided_at: '2026-09-15T22:30:00+00:00',
    void_reason: 'Falscher Betrag erfasst',
  };

  it('reads the figures from the row, and the void day in Berlin', () => {
    const input = storedReceiptDocumentInput(stored, partial.driver, partial.company);
    expect(input.figures).toEqual(partial.figures);
    expect(input.voided).toEqual({ date: '2026-09-16', reason: 'Falscher Betrag erfasst' });
    expect(buildReceiptDocumentText(input).banner).toBe('STORNIERT am 16.09.2026 – Grund: Falscher Betrag erfasst');
  });

  it('prints no void notice on a confirmed receipt', () => {
    const input = storedReceiptDocumentInput({ ...stored, status: 'confirmed', voided_at: null, void_reason: null }, partial.driver, partial.company);
    expect(input.voided).toBeNull();
    expect(buildReceiptDocumentText(input).banner).toBeNull();
  });
});

describe('germanDate', () => {
  it('reads the stored text without a Date, so no timezone moves the day', () => {
    expect(germanDate('2026-01-01')).toBe('01.01.2026');
    expect(germanDate('2026-12-31')).toBe('31.12.2026');
  });

  it('never writes US order and refuses anything but YYYY-MM-DD', () => {
    expect(germanDate('2026-09-04')).toBe('04.09.2026');
    for (const bad of ['09/04/2026', '2026-9-4', '', '2026-09-04T00:00:00Z']) {
      expect(() => germanDate(bad)).toThrow(RangeError);
    }
  });
});

describe('a receipt without names is not printed', () => {
  it('names the missing driver or company name', () => {
    expect(receiptDocumentProblem(partial)).toBeNull();
    expect(receiptDocumentProblem({ ...partial, driver: { name: '   ', gender: 'male' } })).toBe('missing_driver_name');
    expect(receiptDocumentProblem({ ...partial, company: receiptCompany(null) })).toBe('missing_company_name');
  });

  it('refuses to build an unnamed signature line, for a new receipt and a stored one', () => {
    const unnamedDriver = () => buildReceiptDocumentText({ ...partial, driver: { name: '', gender: null } });
    expect(unnamedDriver).toThrow(ReceiptDocumentError);
    expect(unnamedDriver).toThrow(/missing_driver_name/);

    const stored = storedReceiptDocumentInput(
      {
        receipt_number: 'GQ-2026-0012', status: 'confirmed', period_start: '2026-08-03', period_end: '2026-08-30',
        payment_date: '2026-09-14', place: 'Berlin', due_amount: '2500.00', paid_bank_before: '1000.00',
        paid_cash_manual_before: '20.00', paid_cash_weekly_before: '50.00', paid_cash_receipts_before: '0.00',
        remaining_before: '1430.00', amount: '1234.56', remaining_after: '195.44', is_partial: true,
        voided_at: null, void_reason: null,
      },
      partial.driver,
      { name: ' ', addressLines: [] },
    );
    expect(() => buildReceiptDocumentText(stored)).toThrow(/missing_company_name/);
  });
});
