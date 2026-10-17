/**
 * The four notification mails.
 *
 * The rules they share with every other mail this product sends: German in
 * both UI languages, `DD.MM.YYYY` and never US `MM/DD/YYYY`, every interpolated
 * value escaped, and no token or query string in a link.
 *
 * What this file must **not** do is touch the five templates
 * `email-layout.test.ts` pins to their exact bytes. It renders new mails
 * through the same layout and never changes it.
 */
import { describe, expect, it } from 'vitest';
import { buildNotificationMail, describeCar, formatGermanDay, selectNotificationRecipients } from './notification-mail.ts';
import type { PlannedNotification } from './notification-core.ts';

const APP_URL = 'https://elprofessor.eu';

function planned(patch: Partial<PlannedNotification> = {}): PlannedNotification {
  return {
    companyId: 'c0000000-0000-4000-8000-00000000000a',
    companyName: 'Taxi Muster GmbH',
    type: 'tuev_bald_ablaufend',
    targetId: 'e0000000-0000-4000-8000-00000000000a',
    periodKey: '2026-11-01',
    plate: 'B-EP 1234',
    dueDay: '2026-11-01',
    daysLeft: 38,
    ...patch,
  };
}

describe('formatGermanDay', () => {
  it('writes DD.MM.YYYY, never MM/DD/YYYY', () => {
    expect(formatGermanDay('2026-11-01')).toBe('01.11.2026');
    expect(formatGermanDay('2026-01-31')).toBe('31.01.2026');
  });

  it('refuses anything that is not a YYYY-MM-DD day', () => {
    expect(() => formatGermanDay('01.11.2026')).toThrow();
  });
});

describe('describeCar', () => {
  it('uses the plate, or a neutral word when there is none', () => {
    expect(describeCar('B-EP 1234')).toBe('B-EP 1234');
    expect(describeCar('  ')).toBe('Ihr Fahrzeug');
    expect(describeCar(null)).toBe('Ihr Fahrzeug');
  });
});

describe('the two mails', () => {
  const cases: Array<[PlannedNotification['type'], Partial<PlannedNotification>, string, string]> = [
    ['tuev_bald_ablaufend',  { daysLeft: 38 },                     'TÜV läuft ab: B-EP 1234 – El-Professor', '/fahrzeuge'],
    ['tuev_abgelaufen',      { daysLeft: -4 },                     'TÜV abgelaufen: B-EP 1234 – El-Professor', '/fahrzeuge'],
  ];

  for (const [type, patch, subject, path] of cases) {
    it(`${type}: German subject, German date, one link to ${path}`, () => {
      const mail = buildNotificationMail(planned({ type, ...patch }), APP_URL);
      expect(mail.subject).toBe(subject);
      expect(mail.html).toContain('01.11.2026');
      expect(mail.text).toContain('01.11.2026');
      expect(mail.html).toContain(`${APP_URL}${path}`);
      expect(mail.text).toContain(`${APP_URL}${path}`);
      // No US date anywhere, and no query string on the link.
      expect(mail.html).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
      expect(mail.html).not.toContain(`${APP_URL}${path}?`);
      // Every mail says how to turn it off.
      expect(mail.text).toContain('Benachrichtigungen');
      expect(mail.html).toContain('lang="de"');
    });
  }

  it('escapes a company name that contains markup', () => {
    const mail = buildNotificationMail(
      planned({ type: 'tuev_abgelaufen', daysLeft: -1, plate: 'Taxi <script>x</script> & Co' }),
      APP_URL,
    );
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&amp; Co');
  });

  it('escapes a number plate that contains markup', () => {
    const mail = buildNotificationMail(
      planned({ plate: '<b>B-EP 1</b>' }),
      APP_URL,
    );
    expect(mail.html).not.toContain('<b>B-EP 1</b>');
  });

  it('counts days in German singular and plural', () => {
    expect(buildNotificationMail(planned({ daysLeft: 1 }), APP_URL).text).toContain('in 1 Tag');
    expect(buildNotificationMail(planned({ daysLeft: 5 }), APP_URL).text).toContain('in 5 Tagen');
    expect(buildNotificationMail(planned({ daysLeft: 0 }), APP_URL).text).toContain('heute');
    expect(buildNotificationMail(planned({ type: 'tuev_abgelaufen', daysLeft: -1 }), APP_URL).text)
      .toContain('seit 1 Tag');
    expect(buildNotificationMail(planned({ type: 'tuev_abgelaufen', daysLeft: -9 }), APP_URL).text)
      .toContain('seit 9 Tagen');
  });

  it('carries no six-digit run that could be mistaken for a code', () => {
    // These mails have no code at all; the layout would refuse one that was
    // not exactly six digits, and the subject must never hold one either.
    for (const [type] of cases) {
      const mail = buildNotificationMail(planned({ type, daysLeft: -1 }), APP_URL);
      expect(mail.subject).not.toMatch(/\d{6}/);
    }
  });
});

describe('selectNotificationRecipients', () => {
  const now = new Date('2026-09-24T08:00:00.000Z');
  const admin = (patch: Record<string, unknown> = {}) => ({
    email: 'chef@example.com',
    role: 'admin',
    status: 'active',
    isSuperAdmin: false,
    emailConfirmedAt: '2026-01-01T00:00:00Z',
    bannedUntil: null,
    deletedAt: null,
    ...patch,
  });

  it('is the activation code rule: active, confirmed, not staff, not banned, not deleted', () => {
    expect(selectNotificationRecipients({ companyId: 'c1', companyAdmins: [admin()], now }))
      .toEqual(['chef@example.com']);
    for (const patch of [
      { status: 'inactive' },
      { role: 'editor' },
      { isSuperAdmin: true },
      { emailConfirmedAt: null },
      { deletedAt: '2026-02-01T00:00:00Z' },
      { bannedUntil: '2099-01-01T00:00:00Z' },
      { email: null },
    ]) {
      expect(selectNotificationRecipients({ companyId: 'c1', companyAdmins: [admin(patch)], now }))
        .toEqual([]);
    }
  });

  it('is nobody when the company has no such admin', () => {
    expect(selectNotificationRecipients({ companyId: 'c1', companyAdmins: [], now })).toEqual([]);
  });
});
