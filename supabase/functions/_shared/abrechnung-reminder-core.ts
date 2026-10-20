/**
 * The weekly reminder: which driver is reminded, and how many at most.
 *
 * No Deno, `npm:` or `jsr:` import, so vitest runs this file in Node like
 * abrechnung-schedule-core.ts. It lives under `_shared/` rather than `src/utils/`
 * because the edge function cannot import from `src/` (only `supabase/functions`
 * is mounted into the functions container), while the browser may import from
 * here, as it already does for the schedule core.
 *
 * ## The rule, in one place
 *
 * The weekly mail is built from rows that exist only for a driver with a `bar`
 * receipt or `bargeld` income in the week, so the driver who recorded nothing
 * gets no mail at all. This module is the reminder for exactly that driver:
 *
 *     he handed nothing in (no `bargeld` income row, no `bar` receipt).
 *
 * Until 20.10.2026 the rule also required "he drove" (income of type `umsatz`).
 * Measured on production: the reminder ticked three times at 09:30, 09:40 and
 * 09:50, each with `reminders_due: 1`, `planned: 0` and every skip counter at
 * zero, because the company entered that week's revenue in one go at 09:52:25.
 * The rule read a week that was not filled in yet, and could not tell "drove
 * and handed nothing in" from "not entered yet". Revenue is the company's own
 * data entry, so the term is gone; the cost is a harmless reminder to a driver
 * who did not work that week. Restoring it is one line in `nothingRecorded`.
 *
 * The owner decided (15.10.2026) that a reminder reaching somebody who did not
 * need it is not worth machinery: "if the driver forgets to submit the data on
 * Reidey it is his fault not ours". So there is no history window, no
 * "usually pays by card" exemption, and nothing else here. Change the rule by
 * changing `nothingRecorded` and its test.
 *
 * Skips that are not about the rule but about who can be mailed are the driver
 * mail's own: an inactive driver, no address, a name two drivers share (income
 * and receipts carry a name and no driver id, so a shared name would mail one
 * person for the other's week).
 *
 * ## The cap
 *
 * `MAX_REMINDERS_PER_RUN` bounds the mails one run may send across ALL
 * companies. The ones over the cap are left unclaimed, so the next tick (the
 * window is three ticks wide) takes them: the cap delays, it does not drop.
 */

/**
 * The most reminder mails one run sends. A fleet is dozens of drivers, so this
 * is above any honest run and far below a roster-wide blast from a schedule
 * switched on by mistake, or a company the rule matches entirely. Staging holds
 * real addresses and relays through production's Resend account.
 */
export const MAX_REMINDERS_PER_RUN = 20;

/** One row of `abrechnung_reminder_facts`: what the week holds for one driver. */
export interface ReminderFacts {
  driver_id: string;
  driver_name: string;
  driver_status: string;
  driver_email: string | null;
  match_count: number | string;
  umsatz_amount: number | string;
  bargeld_rows: number | string;
  bar_receipt_rows: number | string;
}

function num(value: number | string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * THE rule: the driver recorded neither cash nor a cash receipt. No revenue term
 * (20.10.2026): revenue is entered by the company from the Uber export, often
 * after the reminder has looked, so a rule hanging on it found nobody.
 */
export function nothingRecorded(facts: Pick<ReminderFacts, 'bargeld_rows' | 'bar_receipt_rows'>): boolean {
  return num(facts.bargeld_rows) === 0
    && num(facts.bar_receipt_rows) === 0;
}

export interface ReminderTarget {
  driverId: string;
  driverName: string;
  email: string;
}

/** Counts only: a report built from this carries no name and no address. */
export interface ReminderCounts {
  /** Matches the rule, can be mailed, not covered, and within the cap. */
  planned: number;
  /** Matches the rule and can be mailed, but the run's cap is spent. */
  capped: number;
  /** Matches the rule, but a reminder or the driver mail is already claimed. */
  already_covered: number;
  no_address: number;
  ambiguous: number;
  inactive: number;
}

export interface ReminderPlanResult {
  sendable: ReminderTarget[];
  counts: ReminderCounts;
}

/**
 * Who is reminded among a company's drivers for one week.
 *
 * `coveredDriverIds` holds every driver with this week's reminder or this
 * week's driver mail already claimed; `budget` is how many more the run may take.
 */
export function planReminders(
  rows: readonly ReminderFacts[],
  coveredDriverIds: ReadonlySet<string>,
  budget: number,
): ReminderPlanResult {
  const counts: ReminderCounts = {
    planned: 0, capped: 0, already_covered: 0, no_address: 0, ambiguous: 0, inactive: 0,
  };
  const eligible: ReminderTarget[] = [];

  for (const row of rows) {
    if (!nothingRecorded(row)) continue;
    if (num(row.match_count) > 1) counts.ambiguous += 1;
    else if (row.driver_status !== 'active') counts.inactive += 1;
    else if (!row.driver_email) counts.no_address += 1;
    else if (coveredDriverIds.has(row.driver_id)) counts.already_covered += 1;
    else eligible.push({ driverId: row.driver_id, driverName: row.driver_name, email: row.driver_email });
  }

  const room = Math.max(0, Math.floor(budget));
  const sendable = eligible.slice(0, room);
  counts.planned = sendable.length;
  counts.capped = eligible.length - sendable.length;
  return { sendable, counts };
}
