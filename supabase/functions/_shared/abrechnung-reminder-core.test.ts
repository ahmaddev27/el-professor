/**
 * The reminder audience and its cap, without a database or a clock.
 *
 * Since 26.10.2026 the rule is "every active driver with an address" and the
 * week's figures are not read at all. What is left to test is therefore who
 * CAN be mailed — and above all that one mailbox never gets two reminders for
 * one week, which is the audience change's own risk.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_REMINDERS_PER_RUN,
  planReminders,
  reminderAddressKey,
  summariseReminderRoster,
  type ReminderFacts,
} from './abrechnung-reminder-core.ts';
import { planReminder, type ScheduleCompany } from './abrechnung-schedule-core.ts';

const DRIVER_A = 'd0000000-0000-4000-8000-00000000000a';
const DRIVER_B = 'd0000000-0000-4000-8000-00000000000b';
const WEEK = '2026-09-21';

function facts(patch: Partial<ReminderFacts> = {}): ReminderFacts {
  return {
    driver_id: DRIVER_A, driver_name: 'Fahrer A', driver_status: 'active',
    driver_email: 'a@example.com', match_count: 1,
    umsatz_amount: '812.40', bargeld_rows: 0, bar_receipt_rows: 0,
    ...patch,
  };
}

describe('the audience: every active driver', () => {
  const nobody: ReadonlySet<string> = new Set();

  it('reminds a driver who already recorded cash and receipts, as it does one who recorded nothing', () => {
    const rows = [
      facts(),
      facts({
        driver_id: DRIVER_B, driver_name: 'B', driver_email: 'b@example.com',
        bargeld_rows: 3, bar_receipt_rows: 5, umsatz_amount: '1567.69',
      }),
    ];
    const { sendable, counts } = planReminders(rows, nobody, 20);
    expect(sendable.map((t) => t.driverId).sort()).toEqual([DRIVER_A, DRIVER_B]);
    expect(counts.planned).toBe(2);
  });

  it('reads nothing of the week: the three figure columns cannot change the audience', () => {
    const plain = planReminders([facts()], nobody, 20);
    for (const patch of [
      { umsatz_amount: 0 }, { umsatz_amount: '0.00' },
      { bargeld_rows: 1 }, { bargeld_rows: '9' },
      { bar_receipt_rows: 2 }, { bar_receipt_rows: '7' },
      { umsatz_amount: '1.00', bargeld_rows: 1, bar_receipt_rows: 1 },
    ] as Array<Partial<ReminderFacts>>) {
      const result = planReminders([facts(patch)], nobody, 20);
      expect(result.sendable, JSON.stringify(patch)).toEqual(plain.sendable);
      expect(result.counts, JSON.stringify(patch)).toEqual(plain.counts);
    }
  });

  it('reminds two drivers who share a name, because the mail attributes nothing to either', () => {
    const rows = [
      facts({ match_count: 2 }),
      facts({ driver_id: DRIVER_B, match_count: 2, driver_email: 'b@example.com' }),
    ];
    const { sendable, counts } = planReminders(rows, nobody, 20);
    expect(sendable).toHaveLength(2);
    expect(counts.planned).toBe(2);
  });

  it('skips a driver with no address, counted and not named', () => {
    for (const email of [null, '', '   '] as Array<string | null>) {
      const result = planReminders([facts({ driver_email: email })], nobody, 20);
      expect(result.sendable, String(email)).toEqual([]);
      expect(result.counts.no_address, String(email)).toBe(1);
      expect(JSON.stringify(result.counts)).not.toContain('Fahrer');
    }
  });

  it('skips a driver who is not active, whatever the status word is', () => {
    for (const status of ['inactive', 'deactivated', 'suspended', '']) {
      const result = planReminders([facts({ driver_status: status })], nobody, 20);
      expect(result.sendable, status).toEqual([]);
      expect(result.counts.inactive, status).toBe(1);
    }
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
});

/**
 * Y&A Mobility, measured 26.10.2026: **two active drivers on one address**, one
 * of them the other's duplicate, renamed "delete it" and kept, because a driver
 * is never deleted here. Under "every active driver" both are targets and the
 * dedupe key is the driver id, so without this the mailbox gets two mails for
 * one week — one of them greeting a person by the junk row's name.
 *
 * The real address and the real name are deliberately not written down (this
 * repository is public); `driver.a@example.com` and its `Driver.A@Example.com`
 * spelling carry the one property the case-insensitive grouping needs.
 */
describe('one mailbox, one reminder', () => {
  const nobody: ReadonlySet<string> = new Set();
  const shared = (patch: Partial<ReminderFacts>) => facts({ driver_email: 'driver.a@example.com', ...patch });

  it('sends one mail to an address two active drivers share', () => {
    const rows = [
      shared({ driver_id: DRIVER_B, driver_name: 'Fahrer B' }),
      shared({ driver_id: DRIVER_A, driver_name: 'delete it' }),
    ];
    const { sendable, counts } = planReminders(rows, nobody, 20);
    expect(sendable).toHaveLength(1);
    expect(counts).toMatchObject({ planned: 1, shared_address: 1 });
  });

  it('greets nobody by name at a shared address, so the junk row cannot address a person', () => {
    const rows = [
      shared({ driver_id: DRIVER_A, driver_name: 'delete it' }),
      shared({ driver_id: DRIVER_B, driver_name: 'Fahrer B' }),
    ];
    const [target] = planReminders(rows, nobody, 20).sendable;
    expect(target.driverName).toBeNull();
    expect(target.email).toBe('driver.a@example.com');
  });

  it('names the driver when the address is his alone', () => {
    const [target] = planReminders([facts()], nobody, 20).sendable;
    expect(target.driverName).toBe('Fahrer A');
  });

  it('chooses the same driver whatever order the rows arrive in, so two ticks claim one row', () => {
    const rows = [
      shared({ driver_id: DRIVER_B, driver_name: 'Fahrer B' }),
      shared({ driver_id: DRIVER_A, driver_name: 'delete it' }),
    ];
    const forward = planReminders(rows, nobody, 20).sendable;
    const backward = planReminders([...rows].reverse(), nobody, 20).sendable;
    expect(forward).toEqual(backward);
    expect(forward[0].driverId).toBe(DRIVER_A);
  });

  it('leaves the address alone once ANY driver on it holds a claim', () => {
    const rows = [
      shared({ driver_id: DRIVER_A, driver_name: 'delete it' }),
      shared({ driver_id: DRIVER_B, driver_name: 'Fahrer B' }),
    ];
    // DRIVER_B's own mail is claimed, so the mailbox has had its mail.
    const { sendable, counts } = planReminders(rows, new Set([DRIVER_B]), 20);
    expect(sendable).toEqual([]);
    expect(counts).toMatchObject({ already_covered: 1, shared_address: 1, planned: 0 });
  });

  /**
   * The reminder window is three ticks wide, so the plan runs again over the
   * same roster ten minutes later. This walks tick 1 → the claim it made →
   * tick 2, for the whole shape of the thing: a plain driver, a shared address,
   * and one left behind by the cap.
   */
  it('a second tick of the same window sends nothing a first tick already sent', () => {
    const rows = [
      facts({ driver_id: DRIVER_A, driver_email: 'a@example.com' }),
      shared({ driver_id: DRIVER_B, driver_name: 'Fahrer B' }),
      shared({ driver_id: 'd0000000-0000-4000-8000-00000000000c', driver_name: 'delete it' }),
      facts({ driver_id: 'd0000000-0000-4000-8000-00000000000d', driver_email: 'd@example.com' }),
    ];
    // Tick 1 with room for two: two mailboxes are taken, one is left to the cap.
    const first = planReminders(rows, new Set(), 2);
    expect(first.counts).toMatchObject({ planned: 2, capped: 1, shared_address: 1 });

    // What the database now holds, which is what `planReminder` reads back.
    const claimed = new Set(first.sendable.map((t) => t.driverId));

    const second = planReminders(rows, claimed, MAX_REMINDERS_PER_RUN);
    // Nobody already mailed is mailed again, and no mailbox is mailed twice.
    for (const target of second.sendable) expect(claimed.has(target.driverId)).toBe(false);
    const mailboxes = second.sendable.map((t) => reminderAddressKey(t.email));
    const alreadyMailed = first.sendable.map((t) => reminderAddressKey(t.email));
    expect(mailboxes.filter((m) => alreadyMailed.includes(m))).toEqual([]);
    expect(new Set(mailboxes).size).toBe(mailboxes.length);

    // The one the cap delayed goes now, and the run is then complete. Each of
    // the two reasons is named, so losing either guard shows up here as well as
    // in its own case: the two drivers mailed in tick 1 are covered in their own
    // right, and their colleague at the shared address is covered through it.
    expect(second.counts).toMatchObject({ planned: 1, already_covered: 2, shared_address: 1 });
    const third = planReminders(rows, new Set([...claimed, ...second.sendable.map((t) => t.driverId)]), 99);
    expect(third.sendable).toEqual([]);
  });

  it('compares addresses trimmed and case-insensitively, and mails the stored spelling', () => {
    expect(reminderAddressKey('  Driver.A@Example.com ')).toBe('driver.a@example.com');
    expect(reminderAddressKey(null)).toBeNull();
    expect(reminderAddressKey('   ')).toBeNull();
    const rows = [
      shared({ driver_id: DRIVER_A, driver_email: 'Driver.A@Example.com' }),
      shared({ driver_id: DRIVER_B }),
    ];
    const { sendable, counts } = planReminders(rows, new Set(), 20);
    expect(counts.shared_address).toBe(1);
    expect(sendable[0].email).toBe('Driver.A@Example.com');
  });

  it('an inactive driver does not hold an address hostage', () => {
    const rows = [
      shared({ driver_id: DRIVER_A, driver_status: 'inactive', driver_name: 'delete it' }),
      shared({ driver_id: DRIVER_B, driver_name: 'Fahrer B' }),
    ];
    const { sendable, counts } = planReminders(rows, new Set(), 20);
    expect(sendable).toHaveLength(1);
    expect(sendable[0].driverName).toBe('Fahrer B');
    expect(counts).toMatchObject({ inactive: 1, shared_address: 0, planned: 1 });
  });
});

describe('the run cap', () => {
  const nobody: ReadonlySet<string> = new Set();

  it('caps a run: the rest are counted and left unclaimed for the next tick', () => {
    const rows = Array.from({ length: 5 }, (_, i) => facts({
      driver_id: `d0000000-0000-4000-8000-00000000010${i}`,
      driver_name: `Fahrer ${i}`, driver_email: `f${i}@example.com`,
    }));
    const { sendable, counts } = planReminders(rows, nobody, 3);
    expect(sendable).toHaveLength(3);
    expect(counts).toMatchObject({ planned: 3, capped: 2 });
  });

  it('delays the same drivers on every tick, so the cap cannot shuffle the roster', () => {
    const rows = Array.from({ length: 5 }, (_, i) => facts({
      driver_id: `d0000000-0000-4000-8000-00000000010${i}`,
      driver_name: `Fahrer ${i}`, driver_email: `f${i}@example.com`,
    }));
    const first = planReminders(rows, nobody, 3).sendable.map((t) => t.driverId);
    const shuffled = planReminders([...rows].reverse(), nobody, 3).sendable.map((t) => t.driverId);
    expect(shuffled).toEqual(first);
  });

  it('a spent budget plans nothing, and a negative one is not a licence', () => {
    expect(planReminders([facts()], nobody, 0).sendable).toEqual([]);
    expect(planReminders([facts()], nobody, -4).sendable).toEqual([]);
    expect(planReminders([facts()], nobody, 0).counts.capped).toBe(1);
  });

  it('is large enough for every roster the product holds, measured 26.10.2026', () => {
    // 43 active drivers in the whole product, 23 of them with an address, and
    // the two companies with the reminder on would have had 22 targets — over
    // the old cap of 20 on the first week.
    expect(MAX_REMINDERS_PER_RUN).toBe(150);
    expect(MAX_REMINDERS_PER_RUN).toBeGreaterThan(23);
  });
});

/**
 * The counts an operator reads on the settings card. Measured on production
 * 26.10.2026: one driver at Y&A Mobility is active with no address, so he
 * receives nothing, and the card's other figures cannot see him — they are
 * built from the week's bookings and he has none. Twenty such drivers across
 * six companies.
 */
describe('summariseReminderRoster', () => {
  const row = (status: string, email: string | null) => ({ status, email });

  it('counts the active drivers, those with no address, and the mails one week sends', () => {
    expect(summariseReminderRoster([
      row('active', 'a@example.com'),
      row('active', 'b@example.com'),
      row('active', null),
      row('inactive', 'c@example.com'),
    ])).toEqual({ active: 3, noAddress: 1, sharedAddresses: 0, reachable: 2 });
  });

  it('counts a shared address once, and as one mail', () => {
    expect(summariseReminderRoster([
      row('active', 'driver.a@example.com'),
      row('active', 'Driver.A@Example.com'),
      row('active', 'other@example.com'),
    ])).toEqual({ active: 3, noAddress: 0, sharedAddresses: 1, reachable: 2 });
  });

  it('ignores an inactive driver entirely, address or not', () => {
    expect(summariseReminderRoster([
      row('inactive', null),
      row('inactive', 'a@example.com'),
    ])).toEqual({ active: 0, noAddress: 0, sharedAddresses: 0, reachable: 0 });
  });

  it('reads a blank address the way the job does', () => {
    expect(summariseReminderRoster([row('active', '  '), row('active', '')]))
      .toEqual({ active: 2, noAddress: 2, sharedAddresses: 0, reachable: 0 });
  });

  it('agrees with planReminders about who is reachable', () => {
    const roster = [
      facts({ driver_id: DRIVER_A, driver_email: 'a@example.com' }),
      facts({ driver_id: DRIVER_B, driver_email: 'A@Example.com' }),
      facts({ driver_id: 'd0000000-0000-4000-8000-00000000000c', driver_email: null }),
      facts({ driver_id: 'd0000000-0000-4000-8000-00000000000d', driver_status: 'inactive' }),
    ];
    const summary = summariseReminderRoster(
      roster.map((r) => ({ status: r.driver_status, email: r.driver_email })),
    );
    const planned = planReminders(roster, new Set(), MAX_REMINDERS_PER_RUN);
    expect(planned.counts.planned).toBe(summary.reachable);
    expect(planned.counts.no_address).toBe(summary.noAddress);
  });
});
