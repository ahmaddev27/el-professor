import { describe, expect, it } from 'vitest';
import { MAX_AMOUNT_IN_WORDS_CENTS } from './germanAmountInWords';
import {
  ReceiptDocumentError,
  buildReceiptDocumentText,
  businessMonthOfPeriod,
  germanBusinessMonth,
  germanDate,
  paymentViewDocumentInput,
  receiptCompany,
  receiptDocumentProblem,
  storedReceiptDocumentInput,
  type ReceiptDocumentInput,
} from './salaryCashReceiptDocument';
import { getBusinessMonth } from './weekCalculations';

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
  businessMonth: { month: 8, year: 2026 },
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

  it('states the confirmation with the Abrechnungsmonat, payment date, figures and words', () => {
    // Owner's decision, 28.09.2026: the sheet names the month, never the period.
    expect(text.confirmation).toBe(
      'Der Arbeitnehmer bestätigt hiermit, am 14.09.2026 als Barzahlung auf das Gehalt für ' +
        'August 2026 den Betrag von 1.234,56 EUR (in Worten: Eintausendzweihundertvierunddreißig Euro ' +
        'und sechsundfünfzig Cent) vom Arbeitgeber erhalten zu haben. Mit seiner Unterschrift bestätigt der ' +
        'Arbeitnehmer den Erhalt des oben genannten Betrages.',
    );
    expect(text.confirmation).not.toContain('Zeitraum');
    expect(text.confirmation).not.toContain('03.08.2026');
    expect(text.facts).toEqual([
      { label: 'Abrechnungsmonat', value: 'August 2026', emphasis: false },
      { label: 'Zahlungsdatum', value: '14.09.2026', emphasis: false },
    ]);
  });

  it('prints no balances at all — no table, no settlement line', () => {
    // The salary-status table and the Teilzahlung sentence were removed by the
    // same decision, with nothing in their place. This test is the record of
    // that: the document object must not carry them back.
    //
    // What it costs, and the owner chose it knowing: the signed paper no longer
    // tells a part payment from a full one. Two receipts for the same month read
    // identically apart from amount and number.
    const asAny = text as unknown as Record<string, unknown>;
    expect(asAny.balance).toBeUndefined();
    expect(asAny.balanceHeading).toBeUndefined();
    expect(asAny.settlement).toBeUndefined();

    // And none of the figures the ledger still holds may appear anywhere on it.
    const printed = JSON.stringify(text);
    for (const gone of ['Fälliges Nettogehalt', 'Bereits überwiesen', 'Offen vor dieser Zahlung',
                        'Offen nach dieser Zahlung', 'Teilzahlung', '2.500,00', '1.430,00', '195,44']) {
      expect(printed).not.toContain(gone);
    }
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
  it('reads the same whether the payment settles the salary or not', () => {
    // The consequence of the 28.09.2026 decision, asserted rather than implied:
    // a full payment and a part payment differ only in their amount.
    const settling = buildReceiptDocumentText({
      ...partial,
      figures: { ...partial.figures, amountCents: 143000, remainingAfterCents: 0, isPartial: false },
    });
    expect(settling.amount.words).toBe('Eintausendvierhundertdreißig Euro und null Cent');

    const stillOpen = buildReceiptDocumentText(partial);
    expect(settling.facts).toEqual(stillOpen.facts);
    expect(settling.confirmation.replace('1.430,00', 'X').replace(/\(in Worten:[^)]*\)/, '(W)'))
      .toBe(stillOpen.confirmation.replace('1.234,56', 'X').replace(/\(in Worten:[^)]*\)/, '(W)'));
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

  it('names the Abrechnungsmonat on the preview too, where the number is not issued yet', () => {
    const text = buildReceiptDocumentText({
      ...partial,
      status: 'preview',
      receiptNumber: null,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-25',
      businessMonth: businessMonthOfPeriod('2026-01-01'),
    });
    expect(text.number).toBe('Nr. wird bei der Bestätigung vergeben');
    expect(text.facts).toEqual([
      { label: 'Abrechnungsmonat', value: 'Dezember 2025', emphasis: false },
      { label: 'Zahlungsdatum', value: '14.09.2026', emphasis: false },
    ]);
  });

  it('refuses what it cannot print correctly', () => {
    expect(() => buildReceiptDocumentText({ ...partial, paymentDate: '14.09.2026' })).toThrow(RangeError);
    expect(() => buildReceiptDocumentText({ ...partial, businessMonth: { month: 0, year: 2026 } })).toThrow(RangeError);
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
    business_month: 8,
    business_year: 2026,
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

  it('takes the Abrechnungsmonat from business_month and business_year, never from the period', () => {
    // The row is the authority once a receipt is confirmed. A stored pair that
    // the period alone would not produce must still print as stored: a value
    // recomputed here would let a later change to the calendar rule reprint an
    // issued document under a different month than the one it was numbered by.
    const input = storedReceiptDocumentInput({ ...stored, business_month: 12, business_year: 2025 }, partial.driver, partial.company);
    expect(input.businessMonth).toEqual({ month: 12, year: 2025 });
    expect(buildReceiptDocumentText(input).facts).toContainEqual({
      label: 'Abrechnungsmonat',
      value: 'Dezember 2025',
      emphasis: false,
    });
  });

  it('prints no void notice on a confirmed receipt', () => {
    const input = storedReceiptDocumentInput({ ...stored, status: 'confirmed', voided_at: null, void_reason: null }, partial.driver, partial.company);
    expect(input.voided).toBeNull();
    expect(buildReceiptDocumentText(input).banner).toBeNull();
  });
});

describe('germanBusinessMonth — the month that explains the number', () => {
  it('writes the German month name and the year, months counting from 1', () => {
    expect(germanBusinessMonth({ month: 1, year: 2026 })).toBe('Januar 2026');
    expect(germanBusinessMonth({ month: 3, year: 2026 })).toBe('März 2026');
    expect(germanBusinessMonth({ month: 12, year: 2025 })).toBe('Dezember 2025');
  });

  it('refuses a month outside 1–12, so a 0-indexed caller cannot print silently wrong', () => {
    for (const bad of [0, 13, -1, 1.5, Number.NaN]) {
      expect(() => germanBusinessMonth({ month: bad, year: 2026 })).toThrow(RangeError);
    }
    expect(() => germanBusinessMonth({ month: 8, year: Number.NaN })).toThrow(RangeError);
  });
});

describe('businessMonthOfPeriod — the preview derives what the RPC will store', () => {
  it('counts a week to the month of its Monday, so January can belong to December', () => {
    // 01.01.2026 is a Thursday; its week's Monday is 29.12.2025. The stored
    // receipt's business_year is therefore 2025, and so is the GQ-YYYY in its
    // number — which is exactly what the printed Abrechnungsmonat explains.
    expect(businessMonthOfPeriod('2026-01-01')).toEqual({ month: 12, year: 2025 });
    expect(germanBusinessMonth(businessMonthOfPeriod('2026-01-01'))).toBe('Dezember 2025');
  });

  it('counts months from 1, unlike weekCalculations', () => {
    // getBusinessMonth('2026-08-03') is { month: 7 }; the stored column is 8.
    expect(businessMonthOfPeriod('2026-08-03')).toEqual({ month: 8, year: 2026 });
    expect(businessMonthOfPeriod('2026-01-05')).toEqual({ month: 1, year: 2026 });
  });

  it('keeps a period that starts on a Monday in its own month', () => {
    // Read as UTC midnight this would fall back a day west of Greenwich, moving
    // the week and with it the month.
    expect(businessMonthOfPeriod('2026-06-01')).toEqual({ month: 6, year: 2026 });
    expect(businessMonthOfPeriod('2026-03-02')).toEqual({ month: 3, year: 2026 });
  });

  it('agrees with weekCalculations, the rule get_business_month() mirrors', () => {
    for (const iso of ['2026-01-01', '2026-04-01', '2025-12-29', '2026-08-03', '2026-11-30']) {
      const [year, month, day] = iso.split('-').map(Number);
      const reference = getBusinessMonth(new Date(year, month - 1, day));
      expect(businessMonthOfPeriod(iso)).toEqual({ month: reference.month + 1, year: reference.year });
    }
  });

  it('refuses anything that is not a YYYY-MM-DD date', () => {
    for (const bad of ['01.01.2026', '2026-1-1', '', '2026-01-01T00:00:00Z']) {
      expect(() => businessMonthOfPeriod(bad)).toThrow(RangeError);
    }
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
        business_month: 8, business_year: 2026,
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

describe('paymentViewDocumentInput — a view of a payment, not a receipt', () => {
  const payment = { amount: 300, paymentDate: '2026-09-15', periodStart: '2026-09-07', periodEnd: '2026-09-13' };
  const driver = { name: 'Max Muster', gender: 'male' as const };
  const company = { name: 'Muster GmbH', addressLines: ['Weg 1'] };

  it('draws no number, says what it is, and prints the amount from the payment', () => {
    const input = paymentViewDocumentInput(payment, driver, company);
    expect(input.receiptNumber).toBeNull();
    expect(input.status).toBe('payment_view');
    const text = buildReceiptDocumentText(input);
    expect(text.number).toBe('Ohne Quittungsnummer');
    expect(text.banner).toContain('keine Gehaltsquittung');
    expect(text.amount.figures).toBe('300,00 EUR');
    expect(text.fileName).toBe('Gehaltsquittung_Zahlungsansicht_Max_Muster');
  });

  it('does not claim the employee confirmed receipt', () => {
    const text = buildReceiptDocumentText(paymentViewDocumentInput(payment, driver, company));
    expect(text.confirmation).not.toContain('bestätigt hiermit');
    expect(text.confirmation).toContain('15.09.2026');
    expect(text.placeAndDate.value).toBe('den 15.09.2026');
  });

  it('refuses an unreadable date or amount instead of printing it', () => {
    expect(() => paymentViewDocumentInput({ ...payment, periodStart: 'x' }, driver, company)).toThrow(RangeError);
    expect(() => paymentViewDocumentInput({ ...payment, amount: 'abc' }, driver, company)).toThrow();
  });
});
