import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
  MAX_ADDRESSES_PER_KIND,
  RECIPIENT_KINDS,
  addressesForKind,
  chooseCompanyRecipients,
  isRecipientKind,
  needsAdministrators,
  type RecipientRow,
} from '../../supabase/functions/_shared/notification-recipients';
import { NOTIFICATION_TYPES } from '../../supabase/functions/_shared/notification-core';

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const admins = ['chef@firma.de', 'zweiter@firma.de'];
const row = (notification_type: string, email: unknown): RecipientRow => ({ notification_type, email });

describe('the kinds that can have their own recipients', () => {
  it('are the four expiry notices plus the Abrechnung manager summary', () => {
    expect([...RECIPIENT_KINDS].sort()).toEqual([...NOTIFICATION_TYPES, 'manager_summary'].sort());
  });

  it('match the database CHECK on notification_recipients', () => {
    const file = readdirSync(new URL('../../supabase/migrations', import.meta.url))
      .filter((name) => name.endsWith('_notification_recipients.sql')).sort().pop();
    expect(file).toBeDefined();
    const sql = source(`supabase/migrations/${file}`);
    const check = /notification_recipients_type_check CHECK \(notification_type IN \(([^)]*)\)/.exec(sql);
    expect(check).not.toBeNull();
    const named = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(named).toEqual([...RECIPIENT_KINDS].sort());
  });

  it('use the same per-kind cap as the trigger', () => {
    const sql = source('supabase/migrations/20261015140000_notification_recipients.sql');
    expect(sql).toContain(`>= ${MAX_ADDRESSES_PER_KIND} THEN`);
  });

  it('isRecipientKind refuses anything else', () => {
    expect(isRecipientKind('manager_summary')).toBe(true);
    expect(isRecipientKind('driver_abrechnung')).toBe(false);
    expect(isRecipientKind('__proto__')).toBe(false);
  });
});

describe('addressesForKind', () => {
  const rows = [
    row('manager_summary', 'a@firma.de'),
    row('tuev_abgelaufen', 'tuev@firma.de'),
    row('manager_summary', 'A@Firma.de'),
    row('manager_summary', 'kaputt'),
    row('manager_summary', 'b@firma.de'),
  ];

  it('keeps only that kind, in order, one per mailbox, well-formed', () => {
    expect(addressesForKind(rows, 'manager_summary')).toEqual(['a@firma.de', 'b@firma.de']);
    expect(addressesForKind(rows, 'tuev_abgelaufen')).toEqual(['tuev@firma.de']);
  });

  it('is empty for a kind nobody listed', () => {
    expect(addressesForKind(rows, 'trial_abgelaufen')).toEqual([]);
  });
});

describe('chooseCompanyRecipients: list, then the single address, then the administrators', () => {
  it('a kind with at least one address sends to exactly those', () => {
    expect(chooseCompanyRecipients({ listed: ['x@y.de', 'z@y.de'], configured: 'buero@firma.de', admins }))
      .toEqual(['x@y.de', 'z@y.de']);
  });

  it('a kind with no address falls back to the single company address', () => {
    expect(chooseCompanyRecipients({ listed: [], configured: 'buero@firma.de', admins })).toEqual(['buero@firma.de']);
  });

  it('a kind with no address and no company address falls back to the administrators', () => {
    expect(chooseCompanyRecipients({ listed: [], configured: null, admins })).toEqual(admins);
  });

  it('is exactly today\'s behaviour when no list is passed at all', () => {
    expect(chooseCompanyRecipients({ configured: null, admins })).toEqual(admins);
    expect(chooseCompanyRecipients({ configured: 'buero@firma.de', admins })).toEqual(['buero@firma.de']);
  });

  it('listing for one kind does not change another kind', () => {
    const rows = [row('manager_summary', 'summary@firma.de')];
    const forKind = (kind: (typeof RECIPIENT_KINDS)[number]) =>
      chooseCompanyRecipients({ listed: addressesForKind(rows, kind), configured: null, admins });
    expect(forKind('manager_summary')).toEqual(['summary@firma.de']);
    expect(forKind('tuev_bald_ablaufend')).toEqual(admins);
  });

  it('does not hand back the caller\'s array', () => {
    const listed = ['x@y.de'];
    expect(chooseCompanyRecipients({ listed, configured: null, admins })).not.toBe(listed);
  });
});

describe('needsAdministrators', () => {
  const kinds = ['tuev_bald_ablaufend', 'manager_summary'] as const;

  it('is false when the single company address covers everything', () => {
    expect(needsAdministrators({ kinds, rows: [], configured: 'buero@firma.de' })).toBe(false);
  });

  it('is false when every kind has its own list', () => {
    const rows = [row('tuev_bald_ablaufend', 'a@b.de'), row('manager_summary', 'c@d.de')];
    expect(needsAdministrators({ kinds, rows, configured: null })).toBe(false);
  });

  it('is true as soon as one kind has neither', () => {
    const rows = [row('manager_summary', 'c@d.de')];
    expect(needsAdministrators({ kinds, rows, configured: null })).toBe(true);
  });
});

describe('who is NOT affected, read from the source', () => {
  it('the delivery job asks for the recipients of the kind it is sending', () => {
    const abrechnung = source('supabase/functions/_shared/abrechnung-delivery.ts');
    expect(abrechnung).toMatch(/loadRecipients\(ctx\.admin, plan\.companyId, ctx\.now, 'manager_summary'\)/);
    const delivery = source('supabase/functions/_shared/notification-delivery.ts');
    expect(delivery).toMatch(/loadRecipientsByKind\(admin, company\.company_id, now, kinds\)/);
    expect(delivery).toMatch(/byKind\.get\(item\.type\)/);
  });

  it('the person-addressed mails never touch the per-kind list', () => {
    for (const file of ['otp.ts', 'activation-code-delivery.ts', 'activation-code-mail.ts']) {
      expect(source(`supabase/functions/_shared/${file}`)).not.toMatch(/notification_recipients|loadRecipients|chooseCompanyRecipients/);
    }
    expect(source('supabase/functions/send-document/index.ts')).not.toMatch(/notification_recipients|loadRecipients/);
    const job = source('supabase/functions/_shared/abrechnung-delivery.ts');
    const from = job.indexOf('async function runDriverMails');
    const to = job.indexOf('async function runManagerSummary');
    expect(job.slice(from, to)).not.toMatch(/notification_recipients|loadRecipients|chooseCompanyRecipients/);
  });
});
