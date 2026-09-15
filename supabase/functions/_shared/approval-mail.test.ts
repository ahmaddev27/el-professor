import { describe, expect, it } from 'vitest';
import { APPROVAL_MAIL_SUBJECT, buildApprovalMail } from './approval-mail.ts';

const APP = 'https://app.elprofessor.eu';
const CODE = '048213';

const trial = { appUrl: APP, companyName: 'Taxi Müller & Söhne', code: CODE, trialDays: 14 };
const plain = { appUrl: APP, companyName: 'Taxi Müller & Söhne', code: null, trialDays: 14 };

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe.each([
  ['with a trial code', trial],
  ['without a code', plain],
])('the approval mail %s', (_label, vars) => {
  const mail = buildApprovalMail(vars);

  it('has the fixed subject, which never holds a code', () => {
    expect(mail.subject).toBe('Ihr Unternehmen ist freigeschaltet – El-Professor');
    expect(mail.subject).toBe(APPROVAL_MAIL_SUBJECT);
    expect(mail.subject).not.toMatch(/\d{6}/);
  });

  it('says the company is approved, naming it', () => {
    expect(mail.text).toContain('Taxi Müller & Söhne ist jetzt für El-Professor freigeschaltet.');
    expect(mail.html).toContain('Taxi Müller &amp; Söhne</strong> ist jetzt für El-Professor freigeschaltet.');
  });

  it('links only into the app, with no token and no query string', () => {
    for (const part of [mail.html, mail.text]) {
      expect(part).not.toContain('{{');
      expect(part.toLowerCase()).not.toContain('token');
    }
    for (const href of hrefs(mail.html)) {
      expect(href.startsWith(`${APP}/`)).toBe(true);
      expect(href).not.toContain('?');
    }
  });

  it('is a German document', () => {
    expect(mail.html).toContain('<html lang="de"');
  });
});

describe('with a trial code', () => {
  const mail = buildApprovalMail(trial);

  it('shows the code exactly once in each part, on a line of its own in the text', () => {
    expect(count(mail.html, CODE)).toBe(1);
    expect(count(mail.text, CODE)).toBe(1);
    expect(mail.text.split('\n')).toContain(CODE);
  });

  it('says the trial days start at redemption, not with the mail', () => {
    for (const part of [mail.html, mail.text]) {
      expect(part).toContain('Mit diesem Code starten Sie Ihre 14-tägige Testphase:');
      expect(part).toContain('Die 14 Tage beginnen erst, wenn Sie den Code einlösen.');
    }
  });

  it('explains how to redeem it: sign in, then the activation page', () => {
    expect(hrefs(mail.html)).toEqual([`${APP}/login`, `${APP}/abo-aktivieren`]);
    expect(mail.html).toContain('>Anmelden</a>');
    expect(mail.html).toContain('>Zur Aktivierungsseite</a>');
    expect(mail.text).toContain(`Zur Aktivierungsseite:\n${APP}/abo-aktivieren`);
    expect(mail.text).toContain(`Melden Sie sich unter ${APP}/login bei El-Professor an und geben Sie den Code auf der Aktivierungsseite ein.`);
    for (const part of [mail.html, mail.text]) {
      expect(part).toContain('Das kann nur ein Administrator Ihres Unternehmens.');
      expect(part).toContain('Der Code gilt, bis er eingelöst oder durch einen neuen Code ersetzt wird.');
    }
  });

  it('takes the number of days from the caller', () => {
    expect(buildApprovalMail({ ...trial, trialDays: 30 }).text).toContain('Die 30 Tage beginnen erst, wenn Sie den Code einlösen.');
  });

  it('reads correctly without a company name', () => {
    expect(buildApprovalMail({ ...trial, companyName: '  ' }).text)
      .toContain('Ihr Unternehmen ist jetzt für El-Professor freigeschaltet. Mit diesem Code');
  });
});

describe('without a code', () => {
  const mail = buildApprovalMail(plain);

  it('carries no code, no trial and a single sign-in link', () => {
    // The HTML holds six-digit colours (#111827); the code block is what must be absent there.
    expect(mail.text).not.toMatch(/(?<!\d)\d{6}(?!\d)/);
    expect(mail.html).not.toContain('letter-spacing:0.3em');
    for (const part of [mail.html, mail.text]) {
      expect(part).not.toContain('Testphase');
    }
    expect(hrefs(mail.html)).toEqual([`${APP}/login`, `${APP}/login`]);
    expect(mail.text).toContain(`Anmelden:\n${APP}/login`);
  });
});

describe('escaping and refusals', () => {
  it('escapes a hostile company name', () => {
    for (const vars of [trial, plain]) {
      const mail = buildApprovalMail({ ...vars, companyName: '<img src=x onerror=alert(1)> "A&B"' });
      expect(mail.html).not.toContain('<img src=x');
      expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt; &quot;A&amp;B&quot;');
      for (const href of hrefs(mail.html)) expect(href).not.toContain('"');
    }
  });

  it('refuses a code that is not six digits', () => {
    expect(() => buildApprovalMail({ ...trial, code: '12345' })).toThrow();
    expect(() => buildApprovalMail({ ...trial, code: '12345a' })).toThrow();
  });

  it('refuses a trial length that is not a positive whole number', () => {
    expect(() => buildApprovalMail({ ...trial, trialDays: 0 })).toThrow();
    expect(() => buildApprovalMail({ ...trial, trialDays: 1.5 })).toThrow();
    expect(() => buildApprovalMail({ ...plain, trialDays: Number.NaN })).toThrow();
  });

  it('accepts APP_URL with a trailing slash and refuses one with a path', () => {
    expect(hrefs(buildApprovalMail({ ...trial, appUrl: `${APP}/` }).html)).toEqual([`${APP}/login`, `${APP}/abo-aktivieren`]);
    expect(() => buildApprovalMail({ ...trial, appUrl: `${APP}/app` })).toThrow();
  });
});
