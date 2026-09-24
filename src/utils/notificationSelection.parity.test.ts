/**
 * The browser and the notification job must answer the same question about a
 * subscription, and this file is what keeps them from drifting apart.
 *
 * `src/utils/planState.ts` decides what the screens unlock;
 * `supabase/functions/_shared/notification-core.ts` decides what the nightly
 * job mails. They cannot be one module: the job runs in Deno and must import
 * nothing from `src/`, whose entry points pull in React. So the predicate is
 * written twice — and two engines that are written twice and checked never is
 * exactly how this codebase produced four competing premium tables.
 *
 * The rule both spell is `get_active_company_id()`'s last two terms:
 *
 *     subscription_status = 'active'
 *     AND (subscription_expires_at IS NULL OR … > now())
 *
 * The stakes are not symmetric. On a screen, a wrong answer shows the wrong
 * banner until the next load. In a mail, it tells a paying customer that the
 * trial they stopped using months ago is expiring — and a mail cannot be taken
 * back. That is why the parity is a test and not a comment.
 *
 * A row that fails here is not fixed by changing one side to match the other:
 * decide which is right against `get_active_company_id()` in
 * `supabase/migrations/20260917130000_unified_tenant_policies.sql`, then move
 * both.
 */
import { describe, expect, it } from 'vitest';
import { subscriptionIsActive as browserSaysActive } from './planState';
import {
  TRIAL_SOON_DAYS,
  TUEV_SOON_DAYS,
  selectNotifications,
  subscriptionIsActive as jobSaysActive,
  type NotificationCompany,
} from '../../supabase/functions/_shared/notification-core';
import { getTuevStatus } from '../types/car';

const NOW = new Date('2026-09-24T08:00:00.000Z');

describe('the subscription predicate is one rule in two places', () => {
  const cases: Array<[string, string | null, string | null]> = [
    ['no subscription',               'inactive', null],
    ['expired word',                  'expired',  null],
    ['cancelled word',                'canceled', '2027-01-01T00:00:00Z'],
    ['no status at all',              null,       null],
    ['active, open ended',            'active',   null],
    ['active, empty expiry',          'active',   ''],
    ['active, expiry ahead',          'active',   '2027-06-30T00:00:00Z'],
    ['active, expiry a second ahead', 'active',   '2026-09-24T08:00:01Z'],
    ['active, expiry a second past',  'active',   '2026-09-24T07:59:59Z'],
    ['active, expiry long past',      'active',   '2025-01-01T00:00:00Z'],
    ['active, expiry unparseable',    'active',   'irgendwann'],
    ['active, expiry is a bare day',  'active',   '2027-01-01'],
  ];

  for (const [name, status, expiry] of cases) {
    it(name, () => {
      expect(jobSaysActive(status, expiry, NOW)).toBe(browserSaysActive(status, expiry, NOW));
    });
  }

  it('answers false, not NaN-driven true, for a broken expiry', () => {
    // Fails closed towards "not paying", which for a *notification* is the
    // permissive direction — so it is pinned rather than left to chance.
    expect(jobSaysActive('active', 'irgendwann', NOW)).toBe(false);
  });
});

describe('the windows are the ones already on screen', () => {
  it('TÜV: the job warns exactly where getTuevStatus() turns the badge amber', () => {
    expect(TUEV_SOON_DAYS).toBe(60);

    const carRow = (isoDay: string) => ({ id: 'car', kennzeichen: 'B-EP 1', tuev_gueltig_bis: isoDay });
    const company = (isoDay: string): NotificationCompany => ({
      company_id: 'c1',
      company_name: 'Test',
      trial_end: null,
      subscription_status: 'active',
      subscription_expires_at: null,
      settings: [],
      cars: [carRow(isoDay)],
      sent: [],
    });

    // The screen and the mail must agree about the same car on the same day.
    // getTuevStatus reads the browser's own clock, so the days are taken
    // relative to it rather than to NOW.
    const inDays = (n: number) => {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() + n);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    for (const [offset, expected] of [
      [-1, 'abgelaufen'],
      [0, 'bald_ablaufend'],
      [59, 'bald_ablaufend'],
      [60, 'bald_ablaufend'],
      [61, 'gueltig'],
    ] as const) {
      const day = inDays(offset);
      expect(getTuevStatus(day).status, `screen at ${offset} days`).toBe(expected);

      const planned = selectNotifications(company(day), new Date());
      const mailed = planned.length === 0 ? 'gueltig'
        : planned[0].type === 'tuev_abgelaufen' ? 'abgelaufen' : 'bald_ablaufend';
      expect(mailed, `mail at ${offset} days`).toBe(expected);
    }
  });

  it('trial: the job warns inside TrialBanner’s own amber window', () => {
    // TrialBanner turns amber at `days <= 7`.
    expect(TRIAL_SOON_DAYS).toBe(7);
  });
});
