/**
 * The notification selection, tested without a database.
 *
 * notification-core.ts imports nothing from Deno, npm: or jsr:, so Node runs it
 * unchanged, the way it runs otp-core.ts and smtp-core.ts.
 *
 * The trial notices are gone (owner, 15.10.2026: no free trial). §5 pins that:
 * the type list holds the two TÜV types and nothing else, so a trial type
 * cannot come back through this module without this file noticing.
 */
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_DEFAULT_ENABLED,
  NOTIFICATION_TYPES,
  TUEV_SOON_DAYS,
  berlinDay,
  daysBetween,
  notificationEnabled,
  selectAllNotifications,
  selectNotifications,
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
  return (['tuev_bald_ablaufend', 'tuev_abgelaufen'])
    .map((notification_type) => ({ notification_type, enabled: true, email_global_enabled: true }));
}

function company(patch: Partial<NotificationCompany> = {}): NotificationCompany {
  return {
    company_id: COMPANY,
    company_name: 'Test A',
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
    for (const type of ['tuev_bald_ablaufend', 'tuev_abgelaufen'] as const) {
      expect(notificationEnabled(off, type)).toBe(false);
    }
  });

  it('falls back to what the screen shows a company that never saved', () => {
    // NotificationsPage renders DEFAULT_ENABLED when the table holds no row, so
    // the job has to agree with it or the screen is a lie.
    expect(notificationEnabled([], 'tuev_bald_ablaufend')).toBe(true);
    expect(notificationEnabled([], 'tuev_abgelaufen')).toBe(true);
    expect(NOTIFICATION_DEFAULT_ENABLED).toEqual({ tuev_bald_ablaufend: true, tuev_abgelaufen: true });
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

// ─── 5. No trial notices ─────────────────────────────────────────────────────

describe('no trial notices', () => {
  it('knows exactly the two TÜV types', () => {
    expect([...NOTIFICATION_TYPES]).toEqual(['tuev_bald_ablaufend', 'tuev_abgelaufen']);
  });

  it('plans nothing for a company without cars', () => {
    expect(selectNotifications(company(), NOW)).toHaveLength(0);
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
});

// ─── 7. Several companies at once ────────────────────────────────────────────

describe('selectAllNotifications', () => {
  it('flattens in the order the companies came in', () => {
    const a = company({ cars: [{ id: CAR, kennzeichen: 'A', tuev_gueltig_bis: day(1) }] });
    const b = company({
      company_id: 'c0000000-0000-4000-8000-00000000000b',
      company_name: 'Test B',
      cars: [{ id: CAR, kennzeichen: 'B', tuev_gueltig_bis: day(-2) }],
    });
    expect(selectAllNotifications([a, b], NOW).map((i) => [i.companyId, i.type])).toEqual([
      [COMPANY, 'tuev_bald_ablaufend'],
      ['c0000000-0000-4000-8000-00000000000b', 'tuev_abgelaufen'],
    ]);
  });
});
