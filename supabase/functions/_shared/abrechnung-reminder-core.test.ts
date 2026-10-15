/**
 * The reminder rule and its cap, without a database or a clock.
 *
 * The rule is `nothingRecorded`: a driver with revenue that week and neither
 * cash income nor a cash receipt. Everything else is who can be mailed.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_REMINDERS_PER_RUN,
  nothingRecorded,
  planReminders,
  type ReminderFacts,
} from './abrechnung-reminder-core.ts';
import { planReminder, type ScheduleCompany } from './abrechnung-schedule-core.ts';

const DRIVER_A = 'd0000000-0000-4000-8000-00000000000a';
const DRIVER_B = 'd0000000-0000-4000-8000-00000000000b';
const WEEK = '2026-09-21';

function facts(patch: Partial<ReminderFacts> = {}): ReminderFacts {
  return {
    driver_id: DRIVER_A, driver_name: 'Ahmed Hemaid', driver_status: 'active',
    driver_email: 'a@example.com', match_count: 1,
    umsatz_amount: '812.40', bargeld_rows: 0, bar_receipt_rows: 0,
    ...patch,
  };
}

describe('nothingRecorded', () => {
  it('reminds a driver who drove and handed nothing in', () => {
    expect(nothingRecorded(facts())).toBe(true);
  });

  it('does not remind a driver who recorded cash', () => {
    expect(nothingRecorded(facts({ bargeld_rows: 1 }))).toBe(false);
  });

  it('does not remind a driver who recorded a cash receipt', () => {
    expect(nothingRecorded(facts({ bar_receipt_rows: 2 }))).toBe(false);
  });

  it('does not remind a driver who did not drive: no revenue is not "forgot", it is "off"', () => {
    expect(nothingRecorded(facts({ umsatz_amount: 0 }))).toBe(false);
    expect(nothingRecorded(facts({ umsatz_amount: '0.00' }))).toBe(false);
  });

  it('reads the numeric strings the database returns', () => {
    expect(nothingRecorded(facts({ umsatz_amount: '0.01', bargeld_rows: '0', bar_receipt_rows: '0' }))).toBe(true);
    expect(nothingRecorded(facts({ bargeld_rows: '3' }))).toBe(false);
  });
});

describe('planReminders', () => {
  const nobody: ReadonlySet<string> = new Set();

  it('plans the driver who recorded nothing and not the one who did', () => {
    const rows = [facts(), facts({ driver_id: DRIVER_B, driver_name: 'B', bargeld_rows: 1 })];
    const { sendable, counts } = planReminders(rows, nobody, 20);
    expect(sendable.map((t) => t.driverId)).toEqual([DRIVER_A]);
    expect(counts.planned).toBe(1);
  });

  it('skips a driver with no address, counted and not named', () => {
    const result = planReminders([facts({ driver_email: null })], nobody, 20);
    expect(result.sendable).toEqual([]);
    expect(result.counts.no_address).toBe(1);
    expect(JSON.stringify(result.counts)).not.toContain('Ahmed');
  });

  it('skips an inactive driver and a name two drivers share', () => {
    const result = planReminders([
      facts({ driver_status: 'inactive' }),
      facts({ driver_id: DRIVER_B, match_count: 2 }),
    ], nobody, 20);
    expect(result.sendable).toEqual([]);
    expect(result.counts).toMatchObject({ inactive: 1, ambiguous: 1 });
  });

  it('skips a driver already covered by a claimed driver mail or reminder', () => {
    const result = planReminders([facts()], new Set([DRIVER_A]), 20);
    expect(result.sendable).toEqual([]);
    expect(result.counts.already_covered).toBe(1);
  });

  it('end to end: a driver whose driver_abrechnung is claimed is never reminded', () => {
    const company: ScheduleCompany = {
      company_id: 'c0000000-0000-4000-8000-00000000000a', company_name: 'Test A',
      driver_mail_enabled: true, manager_summary_enabled: false, weekday: 1, send_time: '08:00',
      armed_at: '2026-01-01T00:00:00.000Z',
      sent: [{ kind: 'driver_abrechnung', target_id: DRIVER_A, period_key: WEEK }],
      reminder_enabled: true, reminder_lead_minutes: 60,
    };
    const plan = planReminder(company, new Date('2026-09-28T07:00:00+02:00'));
    expect(plan).not.toBeNull();
    const result = planReminders([facts()], plan!.coveredDriverIds, MAX_REMINDERS_PER_RUN);
    expect(result.sendable).toEqual([]);
    expect(result.counts.already_covered).toBe(1);
  });

  it('caps a run: the rest are counted and left unclaimed for the next tick', () => {
    const rows = Array.from({ length: 5 }, (_, i) => facts({
      driver_id: `d0000000-0000-4000-8000-00000000010${i}`, driver_name: `Fahrer ${i}`,
    }));
    const { sendable, counts } = planReminders(rows, nobody, 3);
    expect(sendable).toHaveLength(3);
    expect(counts).toMatchObject({ planned: 3, capped: 2 });
  });

  it('a spent budget plans nothing, and a negative one is not a licence', () => {
    expect(planReminders([facts()], nobody, 0).sendable).toEqual([]);
    expect(planReminders([facts()], nobody, -4).sendable).toEqual([]);
    expect(planReminders([facts()], nobody, 0).counts.capped).toBe(1);
  });

  it('the run cap is a number small enough to be a safety and large enough to be useful', () => {
    expect(MAX_REMINDERS_PER_RUN).toBe(20);
  });
});
