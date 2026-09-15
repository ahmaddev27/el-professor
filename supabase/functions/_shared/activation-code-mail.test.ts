import { describe, expect, it } from 'vitest';
import {
  ACTIVATION_CODE_MAIL_SUBJECT,
  buildActivationCodeMail,
  describeActivationCodeGrant,
  formatBerlinTime,
  selectActivationCodeRecipients,
  type CompanyAdminCandidate,
} from './activation-code-mail.ts';

const APP = 'https://app.elprofessor.eu';
const CODE = '048213';
// 14:07 in Berlin (CEST) on 15.09.2026.
const EXPIRES = new Date('2026-09-15T12:07:30Z');

const vars = {
  appUrl: APP,
  code: CODE,
  durationType: '1_monat',
  expiresAt: EXPIRES,
  companyName: 'Taxi Müller & Söhne',
};

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('the activation code mail', () => {
  const mail = buildActivationCodeMail(vars);

  it('has the fixed subject, which never holds the code', () => {
    expect(mail.subject).toBe('Ihr Aktivierungscode für El-Professor');
    expect(mail.subject).toBe(ACTIVATION_CODE_MAIL_SUBJECT);
    expect(mail.subject).not.toMatch(/\d{6}/);
  });

  it('shows the code exactly once in each part, on a line of its own in the text', () => {
    expect(count(mail.html, CODE)).toBe(1);
    expect(count(mail.text, CODE)).toBe(1);
    expect(mail.text.split('\n')).toContain(CODE);
  });

  it('says what the code grants and until when it is valid, in Berlin time', () => {
    for (const part of [mail.html, mail.text]) {
      expect(part).toContain('Der Code ist bis 14:07 Uhr (Europe/Berlin) gültig und kann nur einmal verwendet werden.');
    }
    expect(mail.text).toContain('Für Taxi Müller & Söhne wurde ein Aktivierungscode für El-Professor erstellt. Laufzeit: 1 Monat.');
  });

  it('links to the activation page built from APP_URL, with no token and no query string', () => {
    expect(hrefs(mail.html)).toEqual([`${APP}/abo-aktivieren`, `${APP}/abo-aktivieren`]);
    expect(mail.text).toContain(`Code einlösen:\n${APP}/abo-aktivieren`);
    for (const part of [mail.html, mail.text]) {
      expect(part).not.toContain('{{');
      expect(part.toLowerCase()).not.toContain('token');
    }
    for (const href of hrefs(mail.html)) expect(href).not.toContain('?');
  });

  it('is a German document', () => {
    expect(mail.html).toContain('<html lang="de"');
  });

  it('reads correctly for a code bound to no company', () => {
    expect(buildActivationCodeMail({ ...vars, companyName: null }).text)
      .toContain('Für Sie wurde ein Aktivierungscode für El-Professor erstellt.');
  });
});

describe('what the code grants', () => {
  it('uses the words of the activation screen', () => {
    expect(describeActivationCodeGrant({ durationType: '1_monat' })).toBe('1 Monat');
    expect(describeActivationCodeGrant({ durationType: '3_monate' })).toBe('3 Monate');
    expect(describeActivationCodeGrant({ durationType: '1_jahr' })).toBe('1 Jahr');
    expect(describeActivationCodeGrant({ durationType: 'benutzerdefiniert' })).toBe('Benutzerdefiniert');
  });

  it('adds the custom days, or the fixed end date in Berlin, which redeem_activation_code reads first', () => {
    expect(describeActivationCodeGrant({ durationType: 'benutzerdefiniert', customDays: 45 })).toBe('Benutzerdefiniert: 45 Tage');
    expect(describeActivationCodeGrant({ durationType: 'benutzerdefiniert', customDays: 1 })).toBe('Benutzerdefiniert: 1 Tag');
    expect(describeActivationCodeGrant({
      durationType: 'benutzerdefiniert', customDays: 45, customExpiresAt: '2026-12-31T23:30:00Z',
    })).toBe('Benutzerdefiniert: bis 01.01.2027');
  });

  it('ignores custom values on a fixed duration, and refuses an unknown one', () => {
    expect(describeActivationCodeGrant({ durationType: '1_jahr', customDays: 9 })).toBe('1 Jahr');
    expect(() => describeActivationCodeGrant({ durationType: 'testphase' })).toThrow();
  });
});

describe('the valid-until time', () => {
  it('is HH:MM in Europe/Berlin, across daylight saving time', () => {
    expect(formatBerlinTime(new Date('2026-09-15T12:07:30Z'))).toBe('14:07');
    expect(formatBerlinTime(new Date('2026-01-10T23:30:00Z'))).toBe('00:30');
  });
});

describe('escaping and refusals', () => {
  it('escapes a hostile company name', () => {
    const mail = buildActivationCodeMail({ ...vars, companyName: '<img src=x onerror=alert(1)> "A&B"' });
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt; &quot;A&amp;B&quot;');
    for (const href of hrefs(mail.html)) expect(href).not.toContain('"');
  });

  it('refuses a code that is not six digits, and an invalid expiry', () => {
    expect(() => buildActivationCodeMail({ ...vars, code: '12345' })).toThrow();
    expect(() => buildActivationCodeMail({ ...vars, code: '' })).toThrow();
    expect(() => buildActivationCodeMail({ ...vars, expiresAt: new Date('nope') })).toThrow();
  });

  it('accepts APP_URL with a trailing slash and refuses one with a path', () => {
    expect(hrefs(buildActivationCodeMail({ ...vars, appUrl: `${APP}/` }).html)[0]).toBe(`${APP}/abo-aktivieren`);
    expect(() => buildActivationCodeMail({ ...vars, appUrl: `${APP}/app` })).toThrow();
  });
});

describe('who receives the code', () => {
  const NOW = new Date('2026-09-15T12:05:30Z');
  const admin = (overrides: Partial<CompanyAdminCandidate> = {}): CompanyAdminCandidate => ({
    email: 'chef@example.com',
    role: 'admin',
    status: 'active',
    isSuperAdmin: false,
    emailConfirmedAt: '2026-09-01T08:00:00Z',
    bannedUntil: null,
    deletedAt: null,
    ...overrides,
  });

  it('is the target address when the code has one, whatever the company', () => {
    expect(selectActivationCodeRecipients({
      targetEmail: '  Kunde@Example.com ', companyId: 'c1', companyAdmins: [admin()], now: NOW,
    })).toEqual({ source: 'target_email', recipients: ['kunde@example.com'] });
  });

  it('is otherwise the company admins who can sign in, lower-cased, once each, sorted', () => {
    const result = selectActivationCodeRecipients({
      targetEmail: '  ',
      companyId: 'c1',
      companyAdmins: [
        admin({ email: 'Zweite@Example.com' }),
        admin({ email: 'chef@example.com' }),
        admin({ email: 'CHEF@example.com' }),
        admin({ email: 'bann-vorbei@example.com', bannedUntil: '2026-09-15T12:00:00Z' }),
      ],
      now: NOW,
    });
    expect(result).toEqual({
      source: 'company_admins',
      recipients: ['bann-vorbei@example.com', 'chef@example.com', 'zweite@example.com'],
    });
  });

  it('leaves out everyone who is not an active, confirmed, unbanned company admin', () => {
    const result = selectActivationCodeRecipients({
      companyId: 'c1',
      companyAdmins: [
        admin({ email: 'viewer@example.com', role: 'viewer' }),
        admin({ email: 'eingeladen@example.com', status: 'pending_invite' }),
        admin({ email: 'plattform@example.com', isSuperAdmin: true }),
        admin({ email: 'offen@example.com', emailConfirmedAt: null }),
        admin({ email: 'gesperrt@example.com', bannedUntil: '2026-09-16T00:00:00Z' }),
        admin({ email: 'geloescht@example.com', deletedAt: '2026-09-10T00:00:00Z' }),
        admin({ email: '   ' }),
        admin({ email: null }),
      ],
      now: NOW,
    });
    expect(result).toEqual({ source: 'company_admins', recipients: [] });
  });

  it('is nobody when the code has neither a target address nor a company', () => {
    expect(selectActivationCodeRecipients({ targetEmail: null, companyId: null, companyAdmins: [admin()], now: NOW }))
      .toEqual({ source: 'none', recipients: [] });
  });
});
