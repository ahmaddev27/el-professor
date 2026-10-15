import { describe, expect, it } from 'vitest';
import {
  berlinParts,
  dueOccurrence,
} from '../../supabase/functions/_shared/abrechnung-schedule-core.ts';
import {
  judgePreview,
  nextOccurrence,
  parsePreviewAnswer,
  type SchedulePreviewAnswer,
} from './abrechnungSchedulePreview.ts';

const pad = (n: number) => String(n).padStart(2, '0');

/** The first instant at or after `from` whose Berlin wall clock reads `day` `HH:MM`. */
function instantAt(day: string, time: string, from: Date): Date {
  for (let i = 0; i < 10 * 24 * 60; i += 1) {
    const at = new Date(from.getTime() + i * 60_000);
    const p = berlinParts(at);
    if (p.day === day && `${pad(Math.floor(p.minutes / 60))}:${pad(p.minutes % 60)}` === time) return at;
  }
  throw new Error('no instant');
}

describe('nextOccurrence', () => {
  it('the owner case: Sunday 11:56 on Sunday 04.10.2026 morning covers 21.-27.09.', () => {
    const next = nextOccurrence(0, '11:56', new Date('2026-10-04T07:00:00Z')); // 09:00 Berlin
    expect(next).toMatchObject({ day: '2026-10-04', time: '11:56', weekMonday: '2026-09-21' });
    expect(next?.weekRange).toBe('21.09.2026 – 27.09.2026');
  });

  it('a time already past today rolls to next week', () => {
    const next = nextOccurrence(0, '11:56', new Date('2026-10-04T12:00:00Z'));
    expect(next).toMatchObject({ day: '2026-10-11', weekMonday: '2026-09-28' });
  });

  it('the same minute is not "next"', () => {
    const next = nextOccurrence(1, '08:00', new Date('2026-10-05T06:00:00Z')); // Monday 08:00 Berlin
    expect(next?.day).toBe('2026-10-12');
  });

  it('rejects a malformed schedule', () => {
    expect(nextOccurrence(7, '08:00', new Date())).toBeNull();
    expect(nextOccurrence(1, 'xx', new Date())).toBeNull();
  });

  it('names the week the job itself would mail at that moment', () => {
    const now = new Date('2026-10-01T10:00:00Z');
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const next = nextOccurrence(weekday, '08:30', now);
      expect(next).not.toBeNull();
      const at = instantAt(next!.day, '08:30', now);
      const due = dueOccurrence({ weekday, send_time: '08:30', armed_at: '2026-01-01T00:00:00Z' }, at);
      expect(due.due?.weekMonday).toBe(next!.weekMonday);
    }
  });
});

const answer = (over: Partial<SchedulePreviewAnswer> = {}): SchedulePreviewAnswer => ({
  week_monday: '2026-09-21',
  schedule: { driver_mail_enabled: true, manager_summary_enabled: true, weekday: 0, send_time: '11:56' },
  rows: 3,
  drivers: { sendable: 2, ambiguous: 0, no_driver: 0, inactive: 0, no_email: 1, already_claimed: 0 },
  manager_recipients: 1,
  manager_claimed: false,
  manager_via_address: false,
  ...over,
});

const none = { sendable: 0, ambiguous: 0, no_driver: 0, inactive: 0, no_email: 0, already_claimed: 0 };

describe('judgePreview', () => {
  it('a week with no bookings sends nothing, whatever the switches say', () => {
    const v = judgePreview(answer({ rows: 0, drivers: none }), true, true);
    expect(v.noBookings).toBe(true);
    expect(v.nothingGoes).toBe(true);
  });

  it('drivers and manager both go', () => {
    const v = judgePreview(answer(), true, true);
    expect(v.drivers).toEqual({ kind: 'goes', count: 2 });
    expect(v.manager).toEqual({ kind: 'goes', count: 1 });
    expect(v.nothingGoes).toBe(false);
  });

  it('no driver with an address and no administrator', () => {
    const v = judgePreview(answer({ drivers: { ...none, no_email: 3 }, manager_recipients: 0 }), true, true);
    expect(v.drivers.kind).toBe('no_one');
    expect(v.manager.kind).toBe('no_one');
    expect(v.nothingGoes).toBe(true);
  });

  it('both switches off is not "no one"', () => {
    const v = judgePreview(answer(), false, false);
    expect(v.drivers.kind).toBe('off');
    expect(v.manager.kind).toBe('off');
    expect(v.nothingGoes).toBe(true);
  });
});

describe('parsePreviewAnswer', () => {
  it('accepts the documented shape', () => {
    expect(parsePreviewAnswer({ ok: true, ...answer() })?.rows).toBe(3);
  });
  it('refuses a refusal, a partial answer and garbage', () => {
    expect(parsePreviewAnswer({ ok: false, reason: 'not_authorized' })).toBeNull();
    expect(parsePreviewAnswer({ ok: true, week_monday: '2026-09-21', rows: 1 })).toBeNull();
    expect(parsePreviewAnswer(null)).toBeNull();
  });
});
