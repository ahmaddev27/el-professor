/**
 * The Abrechnung mail: what it says, what it must never say, and its money.
 *
 * It goes to a driver about their own money, so three things are pinned here that
 * nothing else would catch: the German formatting, that the subject carries no
 * figure, and that a negative difference reads as a credit rather than as
 * something to hand in.
 */
import { describe, it, expect } from 'vitest';
import {
  renderAbrechnungMail,
  renderAbrechnungSummaryMail,
  renderReminderMail,
  attachmentName,
  euro,
  percent,
  type AbrechnungMailInput,
} from './abrechnung-mail.ts';

const input = (over: Partial<AbrechnungMailInput> = {}): AbrechnungMailInput => ({
  language: 'de',
  driverName: 'Nora Vogt',
  companyName: 'Y&A Mobility',
  periodLabel: 'Woche 5',
  periodRange: '31.08.2026 – 06.09.2026',
  appUrl: 'https://app.elprofessor.eu',
  figures: { cash: 506.95, belege: 112, difference: 394.95, belegeCount: 2, tankenquote: 11.3 },
  ...over,
});

describe('euro — German money, and it is the only formatter here', () => {
  it('uses a comma for the decimal and a dot for thousands', () => {
    expect(euro(506.95)).toBe('506,95 €');
    expect(euro(1234.5)).toBe('1.234,50 €');
    expect(euro(1234567.89)).toBe('1.234.567,89 €');
    expect(euro(0)).toBe('0,00 €');
  });

  it('never writes a US format', () => {
    expect(euro(1234.5)).not.toContain('1,234');
  });

  it('keeps the sign outside the grouping', () => {
    expect(euro(-394.95)).toBe('-394,95 €');
    expect(euro(-1234.5)).toBe('-1.234,50 €');
  });

  it('rounds to the cent rather than truncating', () => {
    expect(euro(0.005)).toBe('0,01 €');
    expect(euro(1.005)).toBe('1,00 €'); // binary float: 1.005 is below the half
  });
});

describe('percent', () => {
  it('prints one decimal with a comma', () => {
    expect(percent(11.3)).toBe('11,3 %');
    expect(percent(11.25)).toBe('11,3 %');
    expect(percent(0)).toBe('0,0 %');
  });
});

describe('renderAbrechnungMail', () => {
  it('names the driver, the period and the company', () => {
    const mail = renderAbrechnungMail(input());
    expect(mail.html).toContain('Nora Vogt');
    expect(mail.html).toContain('Woche 5');
    expect(mail.html).toContain('31.08.2026 – 06.09.2026');
    expect(mail.html).toContain('Y&amp;A Mobility');
    expect(mail.text).toContain('Nora Vogt');
  });

  it('carries no figure in the subject', () => {
    // A subject is shown on a lock screen. What a driver owes is not for whoever
    // is holding the phone.
    const mail = renderAbrechnungMail(input());
    expect(mail.subject).toBe('Abrechnung Woche 5 – Y&A Mobility');
    expect(mail.subject).not.toMatch(/\d+,\d{2}/);
    expect(mail.subject).not.toContain('€');
  });

  it('calls a negative difference a credit, not something to hand in', () => {
    // The one case a driver most needs to understand, and the one a single label
    // would be silent about.
    const owing = renderAbrechnungMail(input());
    expect(owing.html).toContain('Abzugeben');
    expect(owing.text).toContain('Abzugeben: 394,95 €');

    const credit = renderAbrechnungMail(input({
      figures: { cash: 80, belege: 200, difference: -120, belegeCount: 4, tankenquote: null },
    }));
    expect(credit.html).toContain('Guthaben');
    // The amount is shown without its sign, because the word carries the direction.
    expect(credit.text).toContain('Guthaben: 120,00 €');
    expect(credit.text).not.toContain('-120,00');
  });

  it('leaves the Tankenquote out when it could not be computed', () => {
    const mail = renderAbrechnungMail(input({
      figures: { cash: 1, belege: 0, difference: 1, belegeCount: 0, tankenquote: null },
    }));
    expect(mail.html).not.toContain('Tankenquote');
    expect(mail.text).not.toContain('Tankenquote');
  });

  it('escapes what it interpolates — a name can contain anything', () => {
    const mail = renderAbrechnungMail(input({ driverName: '<script>alert(1)</script>' }));
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('says what the mail is, and does not claim to be a payslip or a receipt', () => {
    const mail = renderAbrechnungMail(input());
    expect(mail.html).toContain('Bei Fragen wende dich bitte an das Büro');

    // The heading and the subject are where a claim would be made, so that is
    // where the words are refused. The BODY is allowed to contain them, and does:
    // the footer says in so many words "keine Rechnung und keine
    // Zahlungsaufforderung", and the first version of this test failed on exactly
    // that sentence — it searched for the word where it meant to search for the
    // claim. Corrected rather than loosened: a denial is the opposite of a claim.
    for (const word of ['Lohnabrechnung', 'Quittung', 'Gehaltsabrechnung']) {
      expect(mail.subject, `the subject calls this a ${word}`).not.toContain(word);
    }
    expect(mail.subject).not.toMatch(/Rechnung/);

    // And the denial is actually there, in both parts.
    expect(mail.html).toContain('keine Rechnung');
    expect(mail.text).toContain('keine Rechnung');
  });

  it('tells the reader the image is attached', () => {
    const mail = renderAbrechnungMail(input());
    expect(mail.html).toContain('als Bild an');
    expect(mail.text).toContain('als Bild an');
  });
});

describe('attachmentName', () => {
  it('builds a filename the MIME header accepts', () => {
    expect(attachmentName('Woche 5')).toBe('Abrechnung_Woche_5.png');
    expect(attachmentName('Woche 5 - August 2026')).toBe('Abrechnung_Woche_5_August_2026.png');
  });

  it('strips anything that would break out of the header', () => {
    // `buildMimeMessage` refuses a filename with a quote or a line break; this is
    // what keeps a period label from ever producing one.
    const name = attachmentName('Woche "5"\r\nBcc: x@y.z');
    expect(name).toMatch(/^[A-Za-z0-9 ._-]{1,120}$/);
    expect(name).not.toContain('"');
  });

  it('never produces an empty name', () => {
    expect(attachmentName('—')).toBe('Abrechnung_Uebersicht.png');
    expect(attachmentName('')).toBe('Abrechnung_Uebersicht.png');
  });
});

describe('renderAbrechnungMail without the image', () => {
  it('does not claim an attachment it does not carry', () => {
    const mail = renderAbrechnungMail(input({ imageAttached: false }));
    expect(mail.html).not.toContain('als Bild an');
    expect(mail.text).not.toContain('als Bild an');
  });

  it('keeps the default: the screens send still says the card is attached', () => {
    const mail = renderAbrechnungMail(input());
    expect(mail.html).toContain('als Bild an');
    expect(mail.text).toContain('als Bild an');
  });
});

describe('renderAbrechnungSummaryMail', () => {
  const rows = [
    { driverName: 'Nora Vogt', figures: { cash: 506.95, belege: 112, difference: 394.95, belegeCount: 2, tankenquote: 11.3 } },
    { driverName: 'Max <b>Muster</b>', figures: { cash: 100, belege: 130.5, difference: -30.5, belegeCount: 1, tankenquote: null } },
  ];
  const summary = () => renderAbrechnungSummaryMail({
    companyName: 'Y&A Mobility', periodLabel: 'Woche 5 - August 2026',
    periodRange: '31.08.2026 – 06.09.2026', rows, appUrl: 'https://app.elprofessor.eu',
  });

  it('lists every driver with German figures and adds the totals', () => {
    const mail = summary();
    expect(mail.text).toContain('Nora Vogt: Bargeld 506,95 €, Belege 112,00 €, Abzugeben 394,95 €');
    expect(mail.text).toContain('Guthaben 30,50 €');
    expect(mail.text).toContain('Gesamt: Bargeld 606,95 €, Belege 242,50 €, Saldo 364,45 €');
  });

  it('carries no figure in the subject', () => {
    const { subject } = summary();
    expect(subject).toBe('Abrechnungsübersicht Woche 5 - August 2026 – Y&A Mobility');
    expect(subject).not.toMatch(/\d,\d\d/);
  });

  it('escapes a driver name', () => {
    const mail = summary();
    expect(mail.html).not.toContain('<b>Muster</b>');
    expect(mail.html).toContain('&lt;b&gt;Muster&lt;/b&gt;');
  });

  it('never calls itself an invoice, a receipt or a payslip', () => {
    const mail = summary();
    for (const text of [mail.html, mail.text, mail.subject]) {
      expect(text).not.toMatch(/Quittung|Lohnabrechnung|Gehaltsabrechnung/);
    }
    expect(mail.text).toContain('keine Rechnung');
  });
});

describe('renderReminderMail', () => {
  const reminder = () => renderReminderMail({
    language: 'de',
    driverName: 'Nora Vogt',
    companyName: 'Y&A Mobility',
    periodLabel: 'Woche 5 - August 2026',
    periodRange: '31.08.2026 – 06.09.2026',
    sendTime: '08:00',
    appUrl: 'https://app.elprofessor.eu',
  });

  it('says which week, what is missing and when the figures go out', () => {
    const { text } = reminder();
    expect(text).toContain('Woche 5 - August 2026');
    expect(text).toContain('31.08.2026 – 06.09.2026');
    expect(text).toContain('weder Bargeld noch Barbelege');
    expect(text).toContain('08:00 Uhr');
  });

  it('states no amount anywhere, because the figures are what is incomplete', () => {
    const mail = reminder();
    for (const part of [mail.html, mail.text, mail.subject]) {
      expect(part).not.toMatch(/€|\d,\d\d/);
    }
  });

  it('carries no link and no figure in the subject', () => {
    const mail = reminder();
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.subject).toBe('Erinnerung: Abrechnung Woche 5 - August 2026 – Y&A Mobility');
  });

  it('tells a driver with nothing to hand in that he can ignore it', () => {
    expect(reminder().text).toContain('ignorieren');
  });

  it('escapes a driver name', () => {
    const mail = renderReminderMail({
      language: 'de',
      driverName: '<b>Muster</b>', companyName: 'X', periodLabel: 'Woche 1',
      periodRange: 'a – b', sendTime: '08:00', appUrl: 'https://app.elprofessor.eu',
    });
    expect(mail.html).not.toContain('<b>Muster</b>');
    expect(mail.html).toContain('&lt;b&gt;Muster&lt;/b&gt;');
  });

  it('never calls itself an invoice, a receipt or a payslip', () => {
    const mail = reminder();
    for (const text of [mail.html, mail.text, mail.subject]) {
      expect(text).not.toMatch(/Quittung|Lohnabrechnung|Gehaltsabrechnung/);
    }
  });
});
