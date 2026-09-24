/**
 * The notification selection, tested without a database.
 *
 * notification-core.ts imports nothing from Deno, npm: or jsr:, so Node runs it
 * unchanged, the way it runs otp-core.ts and smtp-core.ts.
 *
 * The case this file exists for is §5: **a company on `companies.status =
 * 'trial'` with a live subscription gets no trial notification.** That is a
 * paying customer, and `status` stays `'trial'` for ever, so a job that judged
 * the trial by `trial_end` alone would mail "your trial is ending" to the
 * people who are paying. The browser has made that mistake twice.
 */
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_DEFAULT_ENABLED,
  TRIAL_SOON_DAYS,
  TUEV_SOON_DAYS,
  berlinDay,
  daysBetween,
  notificationEnabled,
  selectAllNotifications,
  selectNotifications,
  subscriptionIsActive,
  toBerlinDay,
  type NotificationCompany,
  type NotificationSettingRow,
} from './notification-core.ts';

// A fixed instant, late enough in the day that Berlin is a day ahead of UTC
// only through the offset, not through the hour: 2026-09-24 10:00 Berlin.
const NOW = new Date('2026-09-24T08:00:00.000Z');
const TODAY = '2026-09-24';

const COMPANY = 'c0000000-0000-4000-8000-00000000000a';
const CAR = 'e0000000-0000-4000-8000-00000000000a';

function allOn(): NotificationSettingRow[] {
  return (['tuev_bald_ablaufend', 'tuev_abgelaufen', 'trial_bald_ablaufend', 'trial_abgelaufen'])
    .map((notification_type) => ({ notification_type, enabled: true, email_global_enabled: true }));
}

function company(patch: Partial<NotificationCompany> = {}): NotificationCompany {
  return {
    company_id: COMPANY,
    company_name: 'Test A',
    trial_end: null,
    subscription_status: 'inactive',
    subscription_expires_at: null,
    settings: allOn(),
    cars: [],
    sent: [],
    ...patch,
  };
}

/** A `YYYY-MM-DD` n days from TODAY. */
function day(offset: number): string {
  const base = Date.UTC(2026, 8, 24);
  return new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
}

// ─── 1. Days in Europe/Berlin ────────────────────────────────────────────────

describe('calendar days', () => {
  it('reduces an instant to its Berlin day, not its UTC one', () => {
    // 23:30 UTC on the 24th is 01:30 Berlin on the 25th (CEST, +2).
    expect(berlinDay(new Date('2026-09-24T23:30:00.000Z'))).toBe('2026-09-25');
    expect(berlinDay(new Date('2026-09-24T08:00:00.000Z'))).toBe('2026-09-24');
  });

  it('takes a bare YYYY-MM-DD as that day, never through a timezone', () => {
    // new Date('2026-11-01') is midnight UTC; pushed through a zone behind
    // Berlin it would read as 31.10.
    expect(toBerlinDay('2026-11-01')).toBe('2026-11-01');
    expect(toBerlinDay(' 2026-11-01 ')).toBe('2026-11-01');
  });

  it('is null for a value that is not a date', () => {
    expect(toBerlinDay(null)).toBeNull();
    expect(toBerlinDay('')).toBeNull();
    expect(toBerlinDay('irgendwann')).toBeNull();
  });

  it('counts whole days in both directions, across a DST change', () => {
    expect(daysBetween('2026-09-24', '2026-09-25')).toBe(1);
    expect(daysBetween('2026-09-24', '2026-09-24')).toBe(0);
    expect(daysBetween('2026-09-24', '2026-09-23')).toBe(-1);
    // CEST → CET falls on 25.10.2026; a naive local-time subtraction would
    // give 30.958… days here and round to 31.
    expect(daysBetween('2026-10-24', '2026-11-24')).toBe(31);
  });
});

// ─── 2. The subscription predicate ───────────────────────────────────────────

describe('subscriptionIsActive', () => {
  it('needs the word active', () => {
    expect(subscriptionIsActive('inactive', null, NOW)).toBe(false);
    expect(subscriptionIsActive('expired', null, NOW)).toBe(false);
    expect(subscriptionIsActive(null, null, NOW)).toBe(false);
  });

  it('treats a missing expiry as an open subscription', () => {
    expect(subscriptionIsActive('active', null, NOW)).toBe(true);
    expect(subscriptionIsActive('active', '', NOW)).toBe(true);
  });

  it('compares the expiry with now', () => {
    expect(subscriptionIsActive('active', '2026-12-31T00:00:00Z', NOW)).toBe(true);
    expect(subscriptionIsActive('active', '2026-01-01T00:00:00Z', NOW)).toBe(false);
  });

  it('is not a subscription when the expiry does not parse', () => {
    expect(subscriptionIsActive('active', 'nonsense', NOW)).toBe(false);
  });
});

// ─── 3. The settings, including the company that never saved ─────────────────

describe('notificationEnabled', () => {
  it('follows the stored flag', () => {
    const settings = allOn().map((row) =>
      row.notification_type === 'tuev_abgelaufen' ? { ...row, enabled: false } : row);
    expect(notificationEnabled(settings, 'tuev_abgelaufen')).toBe(false);
    expect(notificationEnabled(settings, 'tuev_bald_ablaufend')).toBe(true);
  });

  it('lets the master switch win', () => {
    const off = allOn().map((row) => ({ ...row, email_global_enabled: false }));
    for (const type of ['tuev_bald_ablaufend', 'tuev_abgelaufen', 'trial_bald_ablaufend'] as const) {
      expect(notificationEnabled(off, type)).toBe(false);
    }
  });

  it('falls back to what the screen shows a company that never saved', () => {
    // NotificationsPage renders DEFAULT_ENABLED when the table holds no row, so
    // the job has to agree with it or the screen is a lie.
    expect(notificationEnabled([], 'tuev_bald_ablaufend')).toBe(true);
    expect(notificationEnabled([], 'tuev_abgelaufen')).toBe(true);
    expect(notificationEnabled([], 'trial_bald_ablaufend')).toBe(true);
    expect(notificationEnabled([], 'trial_abgelaufen')).toBe(false);
    expect(NOTIFICATION_DEFAULT_ENABLED.trial_abgelaufen).toBe(false);
  });
});

// ─── 4. TÜV ──────────────────────────────────────────────────────────────────

describe('TÜV', () => {
  const car = (tuev: string | null) => ({ id: CAR, kennzeichen: 'B-EP 1234', tuev_gueltig_bis: tuev });

  it('warns inside the 60-day window and not outside it', () => {
    expect(selectNotifications(company({ cars: [car(day(TUEV_SOON_DAYS))] }), NOW))
      .toHaveLength(1);
    expect(selectNotifications(company({ cars: [car(day(TUEV_SOON_DAYS + 1))] }), NOW))
      .toHaveLength(0);
  });

  it('is the same 60 days the Fahrzeuge screen shows', () => {
    expect(TUEV_SOON_DAYS).toBe(60);
  });

  it('switches to tuev_abgelaufen the day after the date', () => {
    const today = selectNotifications(company({ cars: [car(TODAY)] }), NOW);
    expect(today[0].type).toBe('tuev_bald_ablaufend');
    expect(today[0].daysLeft).toBe(0);

    const past = selectNotifications(company({ cars: [car(day(-1))] }), NOW);
    expect(past[0].type).toBe('tuev_abgelaufen');
    expect(past[0].daysLeft).toBe(-1);
  });

  it('keeps the expiry date as the period key, and the car as the target', () => {
    const [item] = selectNotifications(company({ cars: [car(day(10))] }), NOW);
    expect(item.periodKey).toBe(day(10));
    expect(item.targetId).toBe(CAR);
    expect(item.plate).toBe('B-EP 1234');
  });

  it('has nothing to say about a car with no TÜV date', () => {
    expect(selectNotifications(company({ cars: [car(null)] }), NOW)).toHaveLength(0);
  });

  it('respects the per-type switch', () => {
    const settings = allOn().map((row) =>
      row.notification_type === 'tuev_abgelaufen' ? { ...row, enabled: false } : row);
    expect(selectNotifications(company({ settings, cars: [car(day(-1))] }), NOW)).toHaveLength(0);
    expect(selectNotifications(company({ settings, cars: [car(day(5))] }), NOW)).toHaveLength(1);
  });
});

// ─── 5. Trials — the paying customer ─────────────────────────────────────────

describe('trials', () => {
  const trialEnd = (offset: number) => `${day(offset)}T12:00:00.000Z`;

  it('warns inside the 7-day window and not outside it', () => {
    expect(selectNotifications(company({ trial_end: trialEnd(TRIAL_SOON_DAYS) }), NOW))
      .toHaveLength(1);
    expect(selectNotifications(company({ trial_end: trialEnd(TRIAL_SOON_DAYS + 1) }), NOW))
      .toHaveLength(0);
    expect(TRIAL_SOON_DAYS).toBe(7);
  });

  it('says trial_abgelaufen once the end has passed', () => {
    const [item] = selectNotifications(company({ trial_end: trialEnd(-1) }), NOW);
    expect(item.type).toBe('trial_abgelaufen');
    expect(item.targetId).toBe(COMPANY);
    expect(item.periodKey).toBe(day(-1));
  });

  it('mails trial_abgelaufen although the company is blocked — that is the point of it', () => {
    // This company's access has lapsed: subscription_status is 'inactive', so
    // get_active_company_id() answers NULL for it. Requiring a live
    // subscription here would mean the one notification that says "your access
    // ended" could only reach companies whose access had not ended.
    const lapsed = company({ trial_end: trialEnd(-3), subscription_status: 'inactive' });
    expect(selectNotifications(lapsed, NOW).map((i) => i.type)).toEqual(['trial_abgelaufen']);
  });

  // ── The case this file exists for ──────────────────────────────────────────

  it('sends NO trial notification to a paying customer still on status=trial', () => {
    // The normal path: signup writes companies.status = 'trial',
    // redeem_activation_code writes the subscription columns and never touches
    // status, so a paying customer reads as a trial company for ever. Its
    // trial_end is long past — and it must hear nothing about a trial.
    const paying = company({
      trial_end: trialEnd(-40),
      subscription_status: 'active',
      subscription_expires_at: '2027-06-30T00:00:00.000Z',
    });
    expect(selectNotifications(paying, NOW)).toEqual([]);
  });

  it('sends no "trial ending" to a customer who paid before the trial ran out', () => {
    const earlyPayer = company({
      trial_end: trialEnd(2),
      subscription_status: 'active',
      subscription_expires_at: null,
    });
    expect(selectNotifications(earlyPayer, NOW)).toEqual([]);
  });

  it('still mails that customer about its TÜV', () => {
    // Paying does not silence the vehicle types: they are about a car, not
    // about billing.
    const paying = company({
      trial_end: trialEnd(-40),
      subscription_status: 'active',
      subscription_expires_at: null,
      cars: [{ id: CAR, kennzeichen: 'B-EP 1234', tuev_gueltig_bis: day(3) }],
    });
    expect(selectNotifications(paying, NOW).map((i) => i.type)).toEqual(['tuev_bald_ablaufend']);
  });

  it('is off by default for trial_abgelaufen when the company never saved', () => {
    expect(selectNotifications(company({ settings: [], trial_end: trialEnd(-1) }), NOW))
      .toHaveLength(0);
    expect(selectNotifications(company({ settings: [], trial_end: trialEnd(2) }), NOW))
      .toHaveLength(1);
  });

  it('treats the last day of a trial as running until the stored moment passes', () => {
    // trial_end later today: still a running trial, as buildPlanState reads it.
    const running = company({ trial_end: '2026-09-24T20:00:00.000Z' });
    expect(selectNotifications(running, NOW)[0].type).toBe('trial_bald_ablaufend');
    // …and an hour ago: over.
    const over = company({ trial_end: '2026-09-24T07:00:00.000Z' });
    expect(selectNotifications(over, NOW)[0].type).toBe('trial_abgelaufen');
  });
});

// ─── 6. The dedupe rule ──────────────────────────────────────────────────────

describe('dedupe', () => {
  const car = (tuev: string) => ({ id: CAR, kennzeichen: 'B-EP 1234', tuev_gueltig_bis: tuev });

  it('drops a notification already claimed for the same occurrence', () => {
    const sent = [{ notification_type: 'tuev_abgelaufen', target_id: CAR, period_key: day(-1) }];
    expect(selectNotifications(company({ cars: [car(day(-1))], sent }), NOW)).toHaveLength(0);
  });

  it('does not re-send because a night went by', () => {
    const sent = [{ notification_type: 'tuev_abgelaufen', target_id: CAR, period_key: day(-1) }];
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    // Same car, same untouched date, one day later: still nothing.
    expect(selectNotifications(company({ cars: [car(day(-1))], sent }), tomorrow)).toHaveLength(0);
  });

  it('warns again after a renewal, because a new date is a new occurrence', () => {
    // Expired on the 23rd, mailed. The workshop renews it to +40 days: that is
    // a different period key, so the warning goes out again.
    const sent = [{ notification_type: 'tuev_abgelaufen', target_id: CAR, period_key: day(-1) }];
    const renewed = selectNotifications(company({ cars: [car(day(40))], sent }), NOW);
    expect(renewed.map((i) => [i.type, i.periodKey]))
      .toEqual([['tuev_bald_ablaufend', day(40)]]);
  });

  it('still says "expired" to a car it warned about at 60 days', () => {
    // The two types are separate occurrences of the same date.
    const sent = [{ notification_type: 'tuev_bald_ablaufend', target_id: CAR, period_key: day(-1) }];
    expect(selectNotifications(company({ cars: [car(day(-1))], sent }), NOW).map((i) => i.type))
      .toEqual(['tuev_abgelaufen']);
  });

  it('keeps one car’s claim out of another car’s way', () => {
    const other = 'e0000000-0000-4000-8000-00000000000b';
    const sent = [{ notification_type: 'tuev_abgelaufen', target_id: other, period_key: day(-1) }];
    expect(selectNotifications(company({ cars: [car(day(-1))], sent }), NOW)).toHaveLength(1);
  });

  it('warns again when a trial is extended', () => {
    const sent = [{ notification_type: 'trial_abgelaufen', target_id: COMPANY, period_key: day(-1) }];
    const extended = company({ trial_end: `${day(3)}T12:00:00.000Z`, sent });
    expect(selectNotifications(extended, NOW).map((i) => i.type))
      .toEqual(['trial_bald_ablaufend']);
  });
});

// ─── 7. Several companies at once ────────────────────────────────────────────

describe('selectAllNotifications', () => {
  it('flattens in the order the companies came in', () => {
    const a = company({ cars: [{ id: CAR, kennzeichen: 'A', tuev_gueltig_bis: day(1) }] });
    const b = company({
      company_id: 'c0000000-0000-4000-8000-00000000000b',
      company_name: 'Test B',
      trial_end: `${day(-2)}T12:00:00.000Z`,
    });
    expect(selectAllNotifications([a, b], NOW).map((i) => [i.companyId, i.type])).toEqual([
      [COMPANY, 'tuev_bald_ablaufend'],
      ['c0000000-0000-4000-8000-00000000000b', 'trial_abgelaufen'],
    ]);
  });
});
