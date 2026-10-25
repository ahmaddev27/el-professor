/**
 * The two driver mails in each language: the prose changes, the numbers do not,
 * and Arabic is built right-to-left.
 */
import { describe, expect, it } from 'vitest';
import {
  renderAbrechnungMail,
  renderReminderMail,
  renderAbrechnungSummaryMail,
  type AbrechnungMailInput,
} from './abrechnung-mail.ts';
import { resolveMailLanguage, type MailLanguage } from './mail-language.ts';

const abrechnung = (language: MailLanguage, over: Partial<AbrechnungMailInput> = {}) =>
  renderAbrechnungMail({
    language,
    driverName: 'Ahmed Hemaid',
    companyName: 'Y&A Mobility',
    periodLabel: 'Woche 5 - August 2026',
    periodRange: '31.08.2026 – 06.09.2026',
    appUrl: 'https://app.elprofessor.eu',
    figures: { cash: 1506.95, belege: 112, difference: 1394.95, belegeCount: 2, tankenquote: 11.3 },
    ...over,
  });

const reminder = (language: MailLanguage) => renderReminderMail({
  language,
  driverName: 'Ahmed Hemaid',
  companyName: 'Y&A Mobility',
  periodLabel: 'Woche 5 - August 2026',
  periodRange: '31.08.2026 – 06.09.2026',
  sendTime: '08:00',
  appUrl: 'https://app.elprofessor.eu',
});

const NUMBERS = ['1.506,95 €', '112,00 €', '1.394,95 €', '11,3 %', '31.08.2026 – 06.09.2026'];

describe.each(['de', 'en', 'ar'] as const)('the Abrechnung in %s', (language) => {
  it('keeps every figure and date in German format, in html and text', () => {
    const mail = abrechnung(language);
    for (const figure of NUMBERS) {
      expect(mail.html, figure).toContain(figure);
      expect(mail.text, figure).toContain(figure);
    }
    for (const part of [mail.html, mail.text, mail.subject]) {
      expect(part).not.toMatch(/\d{2}\/\d{2}\/\d{4}|1,506|\$/);
    }
  });

  it('puts no figure in the subject', () => {
    expect(abrechnung(language).subject).not.toMatch(/€|\d,\d{2}/);
  });

  it('escapes a hostile name', () => {
    const mail = abrechnung(language, { driverName: '<script>x</script>' });
    expect(mail.html).not.toContain('<script>');
  });

  it('declares its language on the document', () => {
    expect(abrechnung(language).html).toContain(`<html lang="${language}"`);
  });
});

describe('English', () => {
  it('is written in English with the credit and the owed cases told apart', () => {
    const owing = abrechnung('en');
    expect(owing.subject).toBe('Settlement Week 5 - August 2026 – Y&A Mobility');
    expect(owing.text).toContain('Hello Ahmed Hemaid,');
    expect(owing.text).toContain('To hand in: 1.394,95 €');
    expect(owing.html).not.toContain('Abzugeben');
    const credit = abrechnung('en', {
      figures: { cash: 80, belege: 200, difference: -120, belegeCount: 4, tankenquote: null },
    });
    expect(credit.text).toContain('Credit: 120,00 €');
    expect(credit.text).not.toContain('-120,00');
    expect(credit.text).not.toContain('Fuel share');
  });

  it('is left-to-right, with the English footer', () => {
    const mail = abrechnung('en');
    expect(mail.html).not.toContain('dir="rtl"');
    expect(mail.html).toContain('Payroll and planning management');
    expect(mail.html).not.toContain('Lohn- und Planungsverwaltung');
    expect(mail.text).toContain('Replies to this address are not read.');
  });

  it('honours imageAttached', () => {
    expect(abrechnung('en').text).toContain('attached to this email');
    expect(abrechnung('en', { imageAttached: false }).text).not.toContain('attached');
  });
});

describe('Arabic', () => {
  it('is right-to-left on the document, the body, the outer table and the card', () => {
    const { html } = abrechnung('ar');
    expect(html).toContain('<html lang="ar" dir="rtl"');
    expect(html).toMatch(/<body dir="rtl"/);
    expect(html).toMatch(/<table role="presentation" dir="rtl" width="100%"/);
    expect(html).toMatch(/<td class="card" dir="rtl"/);
  });

  it('flips the figures table and keeps each amount a left-to-right run', () => {
    const { html } = abrechnung('ar');
    expect(html).toContain('<table role="presentation" dir="rtl" style="width:100%');
    expect(html).toContain('text-align:left;font-size:14px;');
    expect(html).not.toContain('text-align:right');
    expect(html).toContain('<span dir="ltr" style="unicode-bidi:isolate;">1.506,95 €</span>');
    expect(html).toContain('<span dir="ltr" style="unicode-bidi:isolate;">31.08.2026 – 06.09.2026</span>');
  });

  it('isolates names so Latin text cannot reorder the sentence', () => {
    const { html, text } = abrechnung('ar');
    expect(html).toContain('<bdi>Ahmed Hemaid</bdi>');
    expect(html).toContain('<bdi>Y&amp;A Mobility</bdi>');
    expect(text).toContain('⁨Ahmed Hemaid⁩');
    expect(text).toContain('⁦1.506,95 €⁩');
  });

  it('translates the prose and the week label, and none of it is German', () => {
    const mail = abrechnung('ar');
    expect(mail.text).toContain('مرحبًا');
    expect(mail.text).toContain('المطلوب تسليمه');
    expect(mail.text).toContain('الأسبوع 5 - أغسطس 2026');
    expect(mail.html).not.toMatch(/Abzugeben|Hallo|Woche|Bargeld|Lohn- und/);
  });

  it('uses the Arabic footer in both parts', () => {
    const mail = abrechnung('ar');
    expect(mail.html).toContain('إدارة الرواتب والتخطيط');
    expect(mail.text).toContain('إدارة الرواتب والتخطيط');
  });
});

describe('the reminder', () => {
  it('states no amount in any language', () => {
    for (const language of ['de', 'en', 'ar'] as const) {
      const mail = reminder(language);
      for (const part of [mail.html, mail.text, mail.subject]) expect(part).not.toMatch(/€|\d,\d\d/);
    }
  });

  it('says the time the German way only in German', () => {
    expect(reminder('de').text).toContain('Um 08:00 Uhr verschickt');
    expect(reminder('en').text).toContain('At 08:00, Y&A Mobility sends out');
    expect(reminder('en').text).not.toContain('Uhr');
    expect(reminder('ar').text).toContain('08:00');
    expect(reminder('ar').text).not.toContain('Uhr');
  });

  it('is right-to-left in Arabic and not otherwise', () => {
    expect(reminder('ar').html).toContain('dir="rtl"');
    expect(reminder('en').html).not.toContain('dir="rtl"');
    expect(reminder('en').subject).toBe('Reminder: settlement Week 5 - August 2026 – Y&A Mobility');
  });
});

describe('the language a mail is built for', () => {
  it("is English when the driver's language is missing or unknown, never German", () => {
    for (const stored of [undefined, null, '', 'fr', 'ar-EG']) {
      const mail = abrechnung(resolveMailLanguage(stored));
      expect(mail.subject, String(stored)).toMatch(/^Settlement /);
      expect(mail.html).toContain('<html lang="en"');
      expect(mail.html).not.toContain('Hallo');
    }
  });

  it('is only chosen for drivers: the manager summary stays German', () => {
    const mail = renderAbrechnungSummaryMail({
      companyName: 'Y&A Mobility', periodLabel: 'Woche 5', periodRange: 'a – b',
      rows: [], appUrl: 'https://app.elprofessor.eu',
    });
    expect(mail.html).toContain('<html lang="de" xmlns=');
    expect(mail.text).toContain('Guten Tag,');
  });
});
