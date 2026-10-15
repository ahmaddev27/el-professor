import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  chooseCompanyRecipients,
  parseNotificationAddress,
  storedNotificationAddress,
} from '../../supabase/functions/_shared/notification-recipients';
import { planDriverMails, type WeekFigureRow } from '../../supabase/functions/_shared/abrechnung-schedule-core';

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('parseNotificationAddress', () => {
  it('treats null, undefined and blank text as "not set"', () => {
    for (const raw of [null, undefined, '', '   ', '\t']) {
      expect(parseNotificationAddress(raw)).toEqual({ kind: 'empty' });
    }
  });

  it('accepts an ordinary address and trims it', () => {
    expect(parseNotificationAddress('  buero@firma.de ')).toEqual({ kind: 'valid', value: 'buero@firma.de' });
  });

  it('refuses what cannot be an address, the way drivers_email_shape does', () => {
    for (const raw of ['kein-at.de', 'a@b', 'a@@b.de', 'a b@c.de', '@c.de', 'a@.', 42]) {
      expect(parseNotificationAddress(raw)).toEqual({ kind: 'invalid' });
    }
  });
});

describe('chooseCompanyRecipients', () => {
  const admins = ['chef@firma.de', 'zweiter@firma.de'];

  it('a configured address replaces the administrators, it is not added to them', () => {
    expect(chooseCompanyRecipients({ configured: 'buero@firma.de', admins })).toEqual(['buero@firma.de']);
  });

  it('falls back to the administrators when no address is set', () => {
    expect(chooseCompanyRecipients({ configured: null, admins })).toEqual(admins);
    expect(chooseCompanyRecipients({ configured: '', admins })).toEqual(admins);
  });

  it('falls back to the administrators when the stored value is malformed', () => {
    expect(chooseCompanyRecipients({ configured: 'kaputt', admins })).toEqual(admins);
  });

  it('a configured address still reaches a company with no usable administrator', () => {
    expect(chooseCompanyRecipients({ configured: 'buero@firma.de', admins: [] })).toEqual(['buero@firma.de']);
  });

  it('does not hand back the caller\'s array', () => {
    const result = chooseCompanyRecipients({ configured: null, admins });
    expect(result).not.toBe(admins);
  });

  it('storedNotificationAddress is null unless the value is usable', () => {
    expect(storedNotificationAddress('x@y.de')).toBe('x@y.de');
    expect(storedNotificationAddress('x')).toBeNull();
    expect(storedNotificationAddress(null)).toBeNull();
  });
});

describe('driver mails are not affected by the company notification address', () => {
  const row = (over: Partial<WeekFigureRow> = {}): WeekFigureRow => ({
    driver_name: 'Anna Fahrer',
    anzahl_belege: 1,
    ausgegebene_bargeld: 0,
    bargeld: 100,
    bar_zuruck: 0,
    tanken_brutto: 0,
    umsatz_netto: 0,
    match_count: 1,
    driver_id: 'd1',
    driver_email: 'anna@fahrer.de',
    ...over,
  });

  it('a driver mail goes to the driver\'s own address and takes no company address as input', () => {
    const plan = planDriverMails([row()], new Set());
    expect(plan.sendable.map((t) => t.email)).toEqual(['anna@fahrer.de']);
    expect(planDriverMails.length).toBe(2);
  });

  it('the driver path of the delivery job never reads company recipients', () => {
    const job = source('supabase/functions/_shared/abrechnung-delivery.ts');
    const from = job.indexOf('async function runDriverMails');
    const to = job.indexOf('async function runManagerSummary');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const driverPath = job.slice(from, to);
    expect(driverPath).not.toMatch(/loadRecipients|chooseCompanyRecipients|notification_email|notification-recipients/);
    expect(driverPath).toMatch(/target\.email/);
  });

  it('only the manager summary and the expiry notices read the company address', () => {
    const job = source('supabase/functions/_shared/abrechnung-delivery.ts');
    expect(job.match(/loadRecipients\(/g)).toHaveLength(1);
    expect(job.indexOf('loadRecipients(')).toBeGreaterThan(job.indexOf('async function runManagerSummary'));
    const delivery = source('supabase/functions/_shared/notification-delivery.ts');
    expect(delivery).toMatch(/select\('notification_email'\)/);
  });
});
