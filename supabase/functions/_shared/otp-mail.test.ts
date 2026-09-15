import { describe, expect, it } from 'vitest';
import { OTP_PURPOSES, type OtpPurpose } from './otp-core.ts';
import { buildEmailChangedNotice, buildOtpMail, formatBerlinDateTime, fragmentValue } from './otp-mail.ts';

const APP = 'https://app.elprofessor.eu';
const CODE = '048213';

// Contract 4.2.
const SUBJECTS: Record<OtpPurpose, string> = {
  signup_verify: 'Ihr Bestätigungscode – El-Professor',
  password_reset: 'Code zum Zurücksetzen Ihres Passworts – El-Professor',
  invite_activate: 'Ihre Einladung zu El-Professor',
  email_change: 'Neue E-Mail-Adresse bestätigen – El-Professor',
  platform_login: 'Ihr Anmeldecode für die Plattformverwaltung – El-Professor',
};

const vars = {
  appUrl: APP,
  email: 'anna@example.com',
  newEmail: 'neu@example.com',
  companyName: 'Taxi Müller & Söhne',
  code: CODE,
};

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe.each(OTP_PURPOSES)('%s', (purpose) => {
  const mail = buildOtpMail(purpose, vars);

  it('has the contract subject, and the subject never holds the code', () => {
    expect(mail.subject).toBe(SUBJECTS[purpose]);
    expect(mail.subject).not.toContain(CODE);
  });

  it('shows the code exactly once in each part, on a line of its own in the text', () => {
    expect(count(mail.html, CODE)).toBe(1);
    expect(count(mail.text, CODE)).toBe(1);
    expect(mail.text.split('\n')).toContain(CODE);
  });

  it('says how long the code lasts and that it must never be passed on', () => {
    for (const part of [mail.html, mail.text]) {
      expect(part).toContain('Der Code ist 10 Minuten gültig.');
      expect(part).toContain('Geben Sie den Code niemals weiter – El-Professor fragt Sie nie danach.');
    }
  });

  it('carries no template action, no token and no link with a query string', () => {
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

describe('links', () => {
  it('sends a signup back to the verify page, the address only in the fragment', () => {
    expect(hrefs(buildOtpMail('signup_verify', vars).html)).toEqual([`${APP}/auth/verify-email#email=anna%40example.com`]);
  });

  it('sends a password reset to the forgot-password page', () => {
    expect(hrefs(buildOtpMail('password_reset', vars).html)).toEqual([`${APP}/auth/forgot-password`]);
  });

  it('gives an invitation a button to /einladung, repeated as a plain link', () => {
    const target = `${APP}/einladung#email=anna%40example.com`;
    expect(hrefs(buildOtpMail('invite_activate', vars).html)).toEqual([target, target]);
    expect(buildOtpMail('invite_activate', vars).text).toContain(`Einladung annehmen:\n${target}`);
  });

  it('has no link for an email change or a platform login', () => {
    expect(hrefs(buildOtpMail('email_change', vars).html)).toEqual([]);
    expect(hrefs(buildOtpMail('platform_login', vars).html)).toEqual([]);
  });

  it.each(["o'brien@example.com", 'anna+taxi(1)!*@example.com'])(
    'still builds the link for the legal address %j, and the page decodes it back',
    (email) => {
      const [href] = hrefs(buildOtpMail('invite_activate', { ...vars, email }).html);
      expect(href).toMatch(/^https:\/\/app\.elprofessor\.eu\/einladung#email=[A-Za-z0-9%._~-]+$/);
      expect(decodeURIComponent(href.slice(href.indexOf('#email=') + '#email='.length))).toBe(email);
      expect(fragmentValue(email)).not.toMatch(/[!'()*@+]/);
    },
  );
});

describe('copy', () => {
  it('names the company in an invitation when there is one, and reads correctly without', () => {
    const named = buildOtpMail('invite_activate', vars);
    expect(named.html).toContain('Für Sie wurde ein Zugang bei <strong');
    expect(named.html).toContain('Taxi Müller &amp; Söhne</strong> angelegt.');
    expect(named.text).toContain('Für Sie wurde ein Zugang bei Taxi Müller & Söhne angelegt.');
    expect(named.text).toContain('Abgelaufen? Auf der Einladungsseite erhalten Sie einen neuen Code.');

    const unnamed = buildOtpMail('invite_activate', { ...vars, companyName: null });
    expect(unnamed.text).toContain('Für Sie wurde ein Zugang angelegt.');
  });

  it('names both addresses in an email change', () => {
    expect(buildOtpMail('email_change', vars).text)
      .toContain('um die Anmeldeadresse von anna@example.com auf neu@example.com zu ändern.');
  });

  it('escapes every interpolated value', () => {
    const hostile = buildOtpMail('email_change', {
      ...vars,
      email: 'a"<b>@example.com',
      newEmail: "o'<script>@example.com",
    });
    expect(hostile.html).not.toContain('<script>');
    expect(hostile.html).not.toContain('<b>@');
    expect(hostile.html).toContain('a&quot;&lt;b&gt;@example.com');
    expect(hostile.html).toContain('o&#39;&lt;script&gt;@example.com');

    const invite = buildOtpMail('invite_activate', { ...vars, email: 'x"onclick="y@example.com', companyName: '<img src=x>' });
    expect(invite.html).not.toContain('<img src=x>');
    for (const href of hrefs(invite.html)) expect(href).not.toContain('"');
  });

  it('refuses a code that is not six digits, and an email change without the new address', () => {
    expect(() => buildOtpMail('password_reset', { ...vars, code: '12345' })).toThrow();
    expect(() => buildOtpMail('email_change', { ...vars, newEmail: null })).toThrow();
  });

  it('accepts APP_URL with a trailing slash and refuses one with a path', () => {
    expect(hrefs(buildOtpMail('password_reset', { ...vars, appUrl: `${APP}/` }).html)).toEqual([`${APP}/auth/forgot-password`]);
    expect(() => buildOtpMail('password_reset', { ...vars, appUrl: `${APP}/app` })).toThrow();
  });
});

describe('the notice to the old address', () => {
  const notice = buildEmailChangedNotice({
    appUrl: APP,
    oldEmail: 'alt@example.com',
    newEmail: 'neu@example.com',
    changedAt: new Date('2026-09-14T10:05:00Z'),
  });

  it('says when, in Berlin time, and from which address to which', () => {
    expect(notice.subject).toBe('Ihre E-Mail-Adresse wurde geändert – El-Professor');
    expect(notice.text).toContain('am 14.09.2026, 12:05 Uhr (Europe/Berlin) von alt@example.com auf neu@example.com geändert.');
    expect(notice.text).toContain('Nicht Sie? Wenden Sie sich sofort an Ihren Administrator oder den Support.');
  });

  it('carries no code and no link', () => {
    expect(notice.text).not.toMatch(/(?<!\d)\d{6}(?!\d)/);
    expect(notice.html).not.toContain('letter-spacing:0.3em');
    expect(hrefs(notice.html)).toEqual([]);
  });

  it('formats dates the way the product does, across daylight saving time', () => {
    expect(formatBerlinDateTime(new Date('2026-09-14T10:05:00Z'))).toBe('14.09.2026, 12:05');
    expect(formatBerlinDateTime(new Date('2026-01-10T23:30:00Z'))).toBe('11.01.2026, 00:30');
  });
});
