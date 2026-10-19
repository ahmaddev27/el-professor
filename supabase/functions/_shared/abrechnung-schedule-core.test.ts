/**
 * The scheduled Abrechnung's decisions, tested without a database or a clock.
 *
 * abrechnung-schedule-core.ts imports nothing from Deno, npm: or jsr:, so Node
 * runs it unchanged. The cases that matter most: an occurrence is sent once and
 * only inside its grace window, a schedule just switched on never fires for the
 * past, the week mailed is the last COMPLETED one, and a name two drivers share
 * is never resolved by picking one.
 */
import { describe, expect, it } from 'vitest';
import {
  GRACE_MINUTES,
  addDays,
  berlinParts,
  dueOccurrence,
  dueReminder,
  nextMoments,
  REMINDER_WINDOW_MINUTES,
  planReminder,
  figuresOfRow,
  parseSendTime,
  planCompany,
  planDriverMails,
  weekPeriod,
  type ScheduleCompany,
  type WeekFigureRow,
} from './abrechnung-schedule-core.ts';

const COMPANY = 'c0000000-0000-4000-8000-00000000000a';
const DRIVER_A = 'd0000000-0000-4000-8000-00000000000a';
const DRIVER_B = 'd0000000-0000-4000-8000-00000000000b';

// Monday 2026-09-28, 08:00 Berlin (CEST, UTC+2) = 06:00 UTC.
const MONDAY_8 = new Date('2026-09-28T06:00:00.000Z');
const LONG_AGO = '2026-01-01T00:00:00.000Z';

function schedule(patch: Partial<ScheduleCompany> = {}): ScheduleCompany {
  return {
    company_id: COMPANY, company_name: 'Test A',
    driver_mail_enabled: true, manager_summary_enabled: true,
    weekday: 1, send_time: '08:00', armed_at: LONG_AGO, sent: [],
    reminder_enabled: true, reminder_lead_minutes: 60,
    ...patch,
  };
}

function row(patch: Partial<WeekFigureRow> = {}): WeekFigureRow {
  return {
    driver_name: 'Ahmed Hemaid', anzahl_belege: 2, ausgegebene_bargeld: '112.00',
    bargeld: '506.95', bar_zuruck: '394.95', tanken_brutto: '40', umsatz_netto: '400',
    match_count: 1, driver_id: DRIVER_A, driver_email: 'a@example.com', ...patch,
  };
}

describe('berlinParts', () => {
  it('reads the Berlin day, weekday and minute, summer and winter', () => {
    expect(berlinParts(MONDAY_8)).toEqual({ day: '2026-09-28', dow: 1, minutes: 480 });
    // 2026-12-07 07:00 UTC is 08:00 CET.
    expect(berlinParts(new Date('2026-12-07T07:00:00.000Z'))).toEqual({ day: '2026-12-07', dow: 1, minutes: 480 });
  });

  it('is the next day in Berlin while it is still the evening in UTC', () => {
    expect(berlinParts(new Date('2026-09-27T22:30:00.000Z'))).toEqual({ day: '2026-09-28', dow: 1, minutes: 30 });
  });
});

describe('parseSendTime', () => {
  it('reads HH:MM and refuses anything else', () => {
    expect(parseSendTime('08:00')).toBe(480);
    expect(parseSendTime('08:00:00')).toBe(480);
    expect(parseSendTime('23:59')).toBe(1439);
    expect(parseSendTime('24:00')).toBeNull();
    expect(parseSendTime('8:00')).toBeNull();
    expect(parseSendTime('')).toBeNull();
  });
});

describe('dueOccurrence', () => {
  it('is due at the moment, for the week that ended the day before', () => {
    const result = dueOccurrence(schedule(), MONDAY_8);
    expect(result).toEqual({ due: { occurrenceDay: '2026-09-28', weekMonday: '2026-09-21' } });
  });

  it('is not due a minute before: that is last week, long past its window', () => {
    const result = dueOccurrence(schedule(), new Date(MONDAY_8.getTime() - 60_000));
    expect(result).toEqual({ due: null, reason: 'missed' });
  });

  it('is still due at the end of the grace window and not after it', () => {
    const edge = new Date(MONDAY_8.getTime() + GRACE_MINUTES * 60_000);
    expect(dueOccurrence(schedule(), edge).due).not.toBeNull();
    expect(dueOccurrence(schedule(), new Date(edge.getTime() + 60_000)))
      .toEqual({ due: null, reason: 'missed' });
  });

  it('never revives an earlier occurrence: Wednesday after a missed Monday sends nothing', () => {
    const wednesday = new Date('2026-09-30T10:00:00.000Z');
    expect(dueOccurrence(schedule(), wednesday)).toEqual({ due: null, reason: 'missed' });
  });

  it('names the same week for every run inside the window', () => {
    const early = dueOccurrence(schedule(), MONDAY_8);
    const late = dueOccurrence(schedule(), new Date(MONDAY_8.getTime() + 5 * 3_600_000));
    expect(late).toEqual(early);
  });

  it('on a Sunday schedule mails the week before, not the one still running', () => {
    // Sunday 2026-09-27 20:00 Berlin = 18:00 UTC. The week 21.-27.09 ends at midnight.
    const sunday = new Date('2026-09-27T18:00:00.000Z');
    const result = dueOccurrence(schedule({ weekday: 0, send_time: '20:00' }), sunday);
    expect(result).toEqual({ due: { occurrenceDay: '2026-09-27', weekMonday: '2026-09-14' } });
  });

  it('on a Friday schedule mails the week before', () => {
    const friday = new Date('2026-10-02T08:00:00.000Z'); // 10:00 Berlin
    const result = dueOccurrence(schedule({ weekday: 5, send_time: '09:30' }), friday);
    expect(result).toEqual({ due: { occurrenceDay: '2026-10-02', weekMonday: '2026-09-21' } });
  });

  it('does not fire for an occurrence that fell before the schedule was armed', () => {
    // Armed at 07:00 Berlin, an hour before the moment: the occurrence is after it.
    const armedAfter = '2026-09-28T05:00:00.000Z';
    expect(dueOccurrence(schedule({ armed_at: armedAfter }), MONDAY_8).due).not.toBeNull();
    // Armed at 08:30 Berlin, after the moment: this Monday is the past.
    const armedLater = '2026-09-28T06:30:00.000Z';
    expect(dueOccurrence(schedule({ armed_at: armedLater }), new Date('2026-09-28T07:00:00.000Z')))
      .toEqual({ due: null, reason: 'before_armed' });
  });

  it('treats a schedule it cannot read as not due, never as due', () => {
    expect(dueOccurrence(schedule({ send_time: 'soon' }), MONDAY_8)).toEqual({ due: null, reason: 'invalid_schedule' });
    expect(dueOccurrence(schedule({ weekday: 7 }), MONDAY_8)).toEqual({ due: null, reason: 'invalid_schedule' });
    expect(dueOccurrence(schedule({ armed_at: 'never' }), MONDAY_8)).toEqual({ due: null, reason: 'invalid_schedule' });
  });
});

describe('weekPeriod', () => {
  it('labels a week as the screen does, by the month of its Monday', () => {
    expect(weekPeriod('2026-08-31')).toEqual({
      label: 'Woche 5 - August 2026', range: '31.08.2026 – 06.09.2026',
    });
    expect(weekPeriod('2026-09-07').label).toBe('Woche 1 - September 2026');
    expect(weekPeriod('2026-09-21').label).toBe('Woche 3 - September 2026');
  });

  it('writes German dates, never US', () => {
    expect(weekPeriod('2026-09-21').range).toBe('21.09.2026 – 27.09.2026');
  });
});

describe('addDays', () => {
  it('crosses month ends and the clock change without drifting', () => {
    expect(addDays('2026-09-28', 3)).toBe('2026-10-01');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(addDays('2026-03-29', -1)).toBe('2026-03-28');
  });
});

describe('planCompany', () => {
  it('plans both mails for a due company', () => {
    const plan = planCompany(schedule(), MONDAY_8);
    expect(plan).toMatchObject({
      companyId: COMPANY, weekMonday: '2026-09-21', driverMail: true, managerSummary: true,
    });
  });

  it('plans nothing when nothing is due', () => {
    expect(planCompany(schedule(), new Date('2026-09-29T10:00:00.000Z'))).toBeNull();
  });

  it('does not plan a summary already claimed for that week, and keeps the claimed drivers', () => {
    const plan = planCompany(schedule({
      sent: [
        { kind: 'manager_summary', target_id: COMPANY, period_key: '2026-09-21' },
        { kind: 'driver_abrechnung', target_id: DRIVER_A, period_key: '2026-09-21' },
        // Another week's claim means nothing for this one.
        { kind: 'driver_abrechnung', target_id: DRIVER_B, period_key: '2026-09-14' },
      ],
    }), MONDAY_8);
    expect(plan?.managerSummary).toBe(false);
    expect([...(plan?.claimedDriverIds ?? [])]).toEqual([DRIVER_A]);
  });

  it('respects the two switches independently', () => {
    expect(planCompany(schedule({ manager_summary_enabled: false }), MONDAY_8))
      .toMatchObject({ driverMail: true, managerSummary: false });
    expect(planCompany(schedule({ driver_mail_enabled: false }), MONDAY_8))
      .toMatchObject({ driverMail: false, managerSummary: true });
  });
});

describe('figuresOfRow', () => {
  it('reads the screen\'s four figures and the Tankenquote', () => {
    expect(figuresOfRow(row())).toEqual({
      cash: 506.95, belege: 112, difference: 394.95, belegeCount: 2, tankenquote: 10,
    });
  });

  it('leaves the Tankenquote out when there is no revenue to divide by', () => {
    expect(figuresOfRow(row({ umsatz_netto: 0 })).tankenquote).toBeNull();
  });

  it('keeps a negative difference negative', () => {
    expect(figuresOfRow(row({ bar_zuruck: '-12.50' })).difference).toBe(-12.5);
  });
});

describe('planDriverMails', () => {
  it('sends to a driver with exactly one match and an address', () => {
    const plan = planDriverMails([row()], new Set());
    expect(plan.sendable).toHaveLength(1);
    expect(plan.sendable[0]).toMatchObject({ driverId: DRIVER_A, email: 'a@example.com' });
  });

  it('never resolves a shared name by picking one', () => {
    const plan = planDriverMails([row({ match_count: 2, driver_id: null, driver_email: null })], new Set());
    expect(plan.sendable).toEqual([]);
    expect(plan.ambiguous).toEqual(['Ahmed Hemaid']);
  });

  it('reports a driver with no address, or no active match, rather than skipping silently', () => {
    const plan = planDriverMails([
      row({ driver_email: null }),
      row({ driver_name: 'Fremd', match_count: 0, driver_id: null, driver_email: null }),
    ], new Set());
    expect(plan.noAddress).toEqual(['Ahmed Hemaid', 'Fremd']);
  });

  it('does not mail a driver already claimed for the week', () => {
    const plan = planDriverMails([row()], new Set([DRIVER_A]));
    expect(plan.sendable).toEqual([]);
    expect(plan.alreadyClaimed).toEqual(['Ahmed Hemaid']);
  });
});

// ─── The reminder ───────────────────────────────────────────────────────────

/** A Berlin (CEST, UTC+2) wall time on 2026-09-28, the Monday of the schedule above. */
const mondayAt = (hhmm: string) => new Date(`2026-09-28T${hhmm}:00+02:00`);

describe('dueReminder', () => {
  it('is due from its own moment, one lead before the driver mail, for the week the mail covers', () => {
    const result = dueReminder(schedule(), mondayAt('07:00'));
    expect(result).toEqual({ due: { mainDay: '2026-09-28', weekMonday: '2026-09-21' } });
    expect(dueReminder(schedule(), mondayAt('07:29')).due).not.toBeNull();
  });

  it('is not due before its moment', () => {
    expect(dueReminder(schedule(), mondayAt('06:59'))).toEqual({ due: null, reason: 'not_in_window' });
  });

  it('is not due after its window, so a late cron sends nothing stale', () => {
    expect(REMINDER_WINDOW_MINUTES).toBe(30);
    expect(dueReminder(schedule(), mondayAt('07:30'))).toEqual({ due: null, reason: 'not_in_window' });
  });

  it('never runs into the driver mail: the window ends at the mail, whatever the lead', () => {
    // 15 minutes lead: the window would be 30 minutes long but the mail is at 08:00.
    const s = schedule({ reminder_lead_minutes: 15 });
    expect(dueReminder(s, mondayAt('07:59')).due).not.toBeNull();
    expect(dueReminder(s, mondayAt('08:00'))).toEqual({ due: null, reason: 'not_in_window' });
    expect(dueReminder(s, mondayAt('08:05'))).toEqual({ due: null, reason: 'not_in_window' });
  });

  it('crosses midnight: a mail at 00:30 is warned on the evening before', () => {
    // Mail Monday 00:30, lead 60: the reminder is Sunday 23:30 Berlin.
    const s = schedule({ send_time: '00:30' });
    const sunday = new Date('2026-09-27T23:30:00+02:00');
    expect(dueReminder(s, sunday)).toEqual({ due: { mainDay: '2026-09-28', weekMonday: '2026-09-21' } });
  });

  it('never fires for a moment before the schedule was armed', () => {
    const armedAfterReminderMoment = schedule({ armed_at: '2026-09-28T05:10:00.000Z' }); // 07:10 Berlin, after the 07:00 moment
    expect(dueReminder(armedAfterReminderMoment, mondayAt('07:20')))
      .toEqual({ due: null, reason: 'before_armed' });
  });

  it.each([14, 721, 60.5, Number.NaN])('refuses a lead of %s', (lead) => {
    expect(dueReminder(schedule({ reminder_lead_minutes: lead }), mondayAt('07:00')))
      .toEqual({ due: null, reason: 'invalid_schedule' });
  });
});

describe('planReminder', () => {
  const week = '2026-09-21';

  it('is null when the reminder is off, or the driver mail it warns about is off', () => {
    expect(planReminder(schedule({ reminder_enabled: false }), mondayAt('07:00'))).toBeNull();
    expect(planReminder(schedule({ driver_mail_enabled: false }), mondayAt('07:00'))).toBeNull();
  });

  it('carries the mail time and the week, and nobody is covered on an empty record', () => {
    const plan = planReminder(schedule(), mondayAt('07:00'));
    expect(plan).toMatchObject({ weekMonday: week, sendTime: '08:00', companyId: COMPANY });
    expect(plan?.coveredDriverIds.size).toBe(0);
  });

  it('never fires once that week driver mail is claimed for the driver', () => {
    const plan = planReminder(schedule({
      sent: [{ kind: 'driver_abrechnung', target_id: DRIVER_A, period_key: week }],
    }), mondayAt('07:00'));
    expect(plan?.coveredDriverIds.has(DRIVER_A)).toBe(true);
    expect(plan?.coveredDriverIds.has(DRIVER_B)).toBe(false);
  });

  it('counts this week reminder as covered, and no other week claim', () => {
    const plan = planReminder(schedule({
      sent: [
        { kind: 'driver_reminder', target_id: DRIVER_A, period_key: week },
        { kind: 'driver_abrechnung', target_id: DRIVER_B, period_key: '2026-09-14' },
        { kind: 'manager_summary', target_id: COMPANY, period_key: week },
      ],
    }), mondayAt('07:00'));
    expect([...plan!.coveredDriverIds]).toEqual([DRIVER_A]);
  });
});

describe('nextMoments', () => {
  // Berlin is UTC+2 until 2026-10-25. Monday 2026-10-19 is the owner's day.
  const owner = (patch: Partial<ScheduleCompany> = {}) => schedule({
    send_time: '13:40', reminder_lead_minutes: 15,
    armed_at: '2026-10-19T11:25:42.000Z', // 13:25:42 Berlin, 42 s after the reminder moment
    ...patch,
  });
  const at = (iso: string) => new Date(iso);

  it('names the next send and reminder of an ordinary schedule', () => {
    // Wednesday 2026-10-14 10:00 Berlin; armed long ago.
    const got = nextMoments(schedule({ send_time: '13:40', reminder_lead_minutes: 15 }), at('2026-10-14T08:00:00Z'));
    expect(got).toEqual({
      send: { day: '2026-10-19', time: '13:40', weekday: 1 },
      reminder: { day: '2026-10-19', time: '13:25', weekday: 1 },
    });
  });

  it('skips a reminder moment that passed before the schedule was armed (the owner, 19.10.2026)', () => {
    // 13:30 Berlin: the send is still ahead, but the 13:25 reminder was armed out.
    const got = nextMoments(owner(), at('2026-10-19T11:30:00Z'));
    expect(got?.send).toEqual({ day: '2026-10-19', time: '13:40', weekday: 1 });
    expect(got?.reminder).toEqual({ day: '2026-10-26', time: '13:25', weekday: 1 });
    // And the job agrees: nothing is due at 13:25 that day.
    expect(dueReminder(owner(), at('2026-10-19T11:26:00Z')).due).toBeNull();
  });

  it('after the send has passed, both are next Monday', () => {
    const got = nextMoments(owner(), at('2026-10-19T13:20:00Z')); // 15:20 Berlin
    expect(got?.send.day).toBe('2026-10-26');
    expect(got?.reminder).toEqual({ day: '2026-10-26', time: '13:25', weekday: 1 });
  });

  it('puts a reminder whose lead crosses midnight on the previous day', () => {
    // Tuesday 02:00 with a 12-hour lead reminds Monday 14:00.
    const tue = schedule({ weekday: 2, send_time: '02:00', reminder_lead_minutes: 720 });
    expect(nextMoments(tue, at('2026-10-13T08:00:00Z'))).toEqual({
      send: { day: '2026-10-20', time: '02:00', weekday: 2 },
      reminder: { day: '2026-10-19', time: '14:00', weekday: 1 },
    });
    // Tuesday 00:10, 15 minutes: Monday 23:55.
    const early = schedule({ weekday: 2, send_time: '00:10', reminder_lead_minutes: 15 });
    expect(nextMoments(early, at('2026-10-13T08:00:00Z'))?.reminder)
      .toEqual({ day: '2026-10-19', time: '23:55', weekday: 1 });
  });

  it('finds a reminder that lies on the day before the weekday when now is already past it', () => {
    // Monday 2026-10-19 15:00 Berlin; Tuesday 02:00 send, lead 12 h: reminder Monday 14:00 + 30 min window is over.
    const tue = schedule({ weekday: 2, send_time: '02:00', reminder_lead_minutes: 720 });
    const got = nextMoments(tue, at('2026-10-19T13:00:00Z'));
    expect(got?.send.day).toBe('2026-10-20');
    expect(got?.reminder?.day).toBe('2026-10-26');
  });

  it('has no reminder when it is off or when the driver mail is off', () => {
    const now = at('2026-10-14T08:00:00Z');
    expect(nextMoments(schedule({ reminder_enabled: false }), now)?.reminder).toBeNull();
    expect(nextMoments(schedule({ driver_mail_enabled: false }), now)?.reminder).toBeNull();
    expect(nextMoments(schedule({ driver_mail_enabled: false }), now)?.send).toBeTruthy();
  });

  it('is null for an invalid schedule', () => {
    const now = at('2026-10-14T08:00:00Z');
    expect(nextMoments(schedule({ send_time: 'soon' }), now)).toBeNull();
    expect(nextMoments(schedule({ weekday: 7 }), now)).toBeNull();
    expect(nextMoments(schedule({ armed_at: 'never' }), now)).toBeNull();
  });
});
