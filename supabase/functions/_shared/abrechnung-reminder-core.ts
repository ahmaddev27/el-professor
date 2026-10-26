/**
 * The weekly reminder: which driver is reminded, and how many at most.
 *
 * No Deno, `npm:` or `jsr:` import, so vitest runs this file in Node like
 * abrechnung-schedule-core.ts. It lives under `_shared/` rather than `src/utils/`
 * because the edge function cannot import from `src/` (only `supabase/functions`
 * is mounted into the functions container), while the browser may import from
 * here, as it already does for the schedule core.
 *
 * ## The rule, in one place: EVERY active driver
 *
 * The owner's instruction of 26.10.2026: "الأصل يصل تذكير للسائق — إذا عندك
 * فرونتير وما رفعتها ارفعها" — the reminder goes to the driver as a matter of
 * course, saying "if you have a Fahrtenbuch you have not handed in, hand it in".
 * So the audience is
 *
 *     every ACTIVE driver of the company who has an address,
 *
 * and nothing about the week is read.
 *
 * ### This reverses the rule of 15.10.2026, deliberately
 *
 * Until now the reminder went only to a driver who had recorded nothing that
 * week (`nothingRecorded`, gone with this change), because "a confident number
 * in a reminder would be wrong". That reason was about the mail's CONTENT, and
 * it still holds: the reminder states no amount, and `renderReminderMail` and
 * `abrechnung-mail-language.test.ts` keep it that way. What is dropped is using
 * the week's data to pick the AUDIENCE, and two measurements say it never could:
 *
 * * 19.10.2026 — a company entered the whole week's revenue at 09:52, after the
 *   reminder had looked three times. The `umsatz` term was removed then.
 * * 26.10.2026 — the same for cash: every `bargeld` row of the week 19.–25.10.
 *   at Y&A Mobility was created at 10:37, an hour and a half after the 09:00
 *   reminder. At reminder time the rule could not tell "handed nothing in" from
 *   "the office has not typed it in yet" for ANY driver of that company.
 *
 * A rule that reads data which does not exist yet is not a narrower rule, it is
 * an arbitrary one. The honest choice is to read nothing and say nothing about
 * what the driver has or has not done — which is what the wording now does.
 *
 * `ReminderFacts` still carries `umsatz_amount`, `bargeld_rows` and
 * `bar_receipt_rows`, because that is the shape
 * `public.abrechnung_reminder_facts` returns. **Nothing here reads them, and a
 * new rule that wants to must first answer the two measurements above.**
 *
 * ## One mailbox, one reminder
 *
 * The exclusions left are about who can be mailed at all, not about the week:
 * an inactive driver, no address, an address a claim already covers, and an
 * address two drivers of one company share.
 *
 * That last one is the audience change's own cost, measured the day it was
 * made: Y&A Mobility holds **two active drivers on one address** — one is the
 * other's duplicate, renamed "delete it" and kept, because a driver is
 * never deleted here, only deactivated. Under "every active driver" both are
 * targets, the dedupe key is the driver id, and the mailbox would get two
 * reminders for one week, one of them greeting a person by the junk row's name.
 * So an address is taken by exactly one driver per week, and because the mail
 * carries no figure and no amount, the one that goes is complete for whoever
 * reads it. When an address stands for more than one driver the mail greets
 * nobody by name (`driverName: null`), because which person reads it is exactly
 * what is not known.
 *
 * The name-collision guard (`match_count`) is gone with the week's data: it was
 * there because `income` and `receipts` carry a driver NAME and no id, so a
 * shared name could have attributed one person's figures to another. A mail
 * that attributes nothing cannot do that, and measured on production
 * (26.10.2026) no company has two drivers sharing a normalised name, so the
 * guard excluded nobody. Addresses are what collide in practice.
 *
 * ## The cap
 *
 * `MAX_REMINDERS_PER_RUN` bounds the mails one run may send across ALL
 * companies. The ones over the cap are left unclaimed, so the next tick (the
 * window is `REMINDER_WINDOW_MINUTES` wide, three ticks) takes them: the cap
 * delays, it does not drop.
 */

/**
 * The most reminder mails one run sends.
 *
 * **It was 20 while the audience was "recorded nothing", and 20 is too small
 * for a roster.** Measured on production 26.10.2026: 43 active drivers in the
 * whole product, 23 of them with an address, and the two companies that have
 * the reminder switched on would have 22 targets between them — over the old
 * cap on the first week, which would have left two drivers to the next tick and
 * mailed them at a time the schedule card does not name.
 *
 * 150 is some six times today's whole product and still bounds a runaway: a
 * roster-wide blast is now the INTENDED behaviour, so the cap no longer guards
 * against the audience being wide, only against a loop that does not terminate
 * and against one run's SMTP work. The driver mails beside it have no cap at
 * all, so this is not what bounds the run's wall-clock time.
 */
export const MAX_REMINDERS_PER_RUN = 150;

/** One row of `abrechnung_reminder_facts`: what the week holds for one driver. */
export interface ReminderFacts {
  driver_id: string;
  driver_name: string;
  driver_status: string;
  driver_email: string | null;
  /** Drivers of the company sharing this one's normalised name. Not read: see the header. */
  match_count: number | string;
  /** The week's figures. Not read: see the header, and do not revive them without it. */
  umsatz_amount: number | string;
  bargeld_rows: number | string;
  bar_receipt_rows: number | string;
}

export interface ReminderTarget {
  driverId: string;
  /**
   * Whom to greet, or null when the address stands for more than one driver of
   * the company and the person reading it is therefore unknown.
   */
  driverName: string | null;
  email: string;
}

/** Counts only: a report built from this carries no name and no address. */
export interface ReminderCounts {
  /** Active, addressable, not covered, one per address, and within the cap. */
  planned: number;
  /** Would be reminded, but the run's cap is spent. */
  capped: number;
  /** This driver's own reminder or driver mail for the week is already claimed. */
  already_covered: number;
  no_address: number;
  /** Skipped because another driver of the company holds the same address. */
  shared_address: number;
  inactive: number;
}

export interface ReminderPlanResult {
  sendable: ReminderTarget[];
  counts: ReminderCounts;
}

/**
 * How two addresses are compared, here and on the settings card.
 *
 * Trimmed and lower-cased. The database already trims (`abrechnung_reminder_facts`
 * returns `NULLIF(btrim(...), '')`); the lower-casing is this module's, and it
 * is deliberately more eager than the RFC: a local part is technically
 * case-sensitive, but no mail provider in this market treats it as such, and
 * being wrong in this direction sends one mail where two were possible, never
 * two where one was meant.
 */
export function reminderAddressKey(email: string | null | undefined): string | null {
  const trimmed = (email ?? '').trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/** The addresses a claimed reminder or driver mail already covers this week. */
function claimedAddresses(
  rows: readonly ReminderFacts[],
  covered: ReadonlySet<string>,
): ReadonlySet<string> {
  const taken = new Set<string>();
  for (const row of rows) {
    if (!covered.has(row.driver_id)) continue;
    const address = reminderAddressKey(row.driver_email);
    if (address) taken.add(address);
  }
  return taken;
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
    planned: 0, capped: 0, already_covered: 0, no_address: 0, shared_address: 0, inactive: 0,
  };
  const taken = claimedAddresses(rows, coveredDriverIds);
  /** The eligible drivers per address, so one of them can be chosen per mailbox. */
  const groups = new Map<string, ReminderFacts[]>();

  for (const row of rows) {
    if (row.driver_status !== 'active') { counts.inactive += 1; continue; }
    const address = reminderAddressKey(row.driver_email);
    if (!address) { counts.no_address += 1; continue; }
    if (coveredDriverIds.has(row.driver_id)) { counts.already_covered += 1; continue; }
    // Whoever at this address holds the claim, the mailbox has its mail.
    if (taken.has(address)) { counts.shared_address += 1; continue; }
    const group = groups.get(address);
    if (group) group.push(row);
    else groups.set(address, [row]);
  }

  const eligible = chooseOnePerAddress(groups, counts);
  const room = Math.max(0, Math.floor(budget));
  const sendable = eligible.slice(0, room);
  counts.planned = sendable.length;
  counts.capped = eligible.length - sendable.length;
  return { sendable, counts };
}

/**
 * One target per address, and the losers counted.
 *
 * The chosen driver is the one with the smallest id, never the first row the
 * query happened to return: the claim is keyed on the driver id, so two ticks
 * of the same window must choose the same driver or the mailbox gets a second
 * mail. The order the targets come back in is by driver id for the same reason
 * — it decides which of them the cap delays, and a name can be edited between
 * two ticks (measured: a driver was renamed to "delete it" between two runs).
 */
function chooseOnePerAddress(
  groups: ReadonlyMap<string, ReminderFacts[]>,
  counts: ReminderCounts,
): ReminderTarget[] {
  const targets: ReminderTarget[] = [];
  for (const group of groups.values()) {
    const chosen = group.reduce((best, row) => (row.driver_id < best.driver_id ? row : best));
    counts.shared_address += group.length - 1;
    targets.push({
      driverId: chosen.driver_id,
      // Several drivers, one mailbox: who reads it is exactly what is unknown.
      driverName: group.length === 1 ? chosen.driver_name : null,
      // The address as it is STORED, never the lower-cased grouping key: a
      // local part is case-sensitive to a pedantic server, and comparing two
      // addresses is not the same act as addressing a mail to one.
      email: (chosen.driver_email ?? '').trim(),
    });
  }
  return targets.sort((a, b) => (a.driverId < b.driverId ? -1 : a.driverId > b.driverId ? 1 : 0));
}

// ─── What the settings card tells the operator ───────────────────────────────

/** One driver as the roster summary needs him: status and address, no name. */
export interface ReminderRosterRow {
  status: string | null;
  email: string | null;
}

export interface ReminderRosterSummary {
  /** Active drivers of the company, whatever their address. */
  active: number;
  /** Active drivers with no address: they receive nothing, and nothing says so. */
  noAddress: number;
  /** Addresses held by more than one active driver: one reminder goes to each. */
  sharedAddresses: number;
  /** Mails a full week's reminder would send: one per distinct address. */
  reachable: number;
}

/**
 * What the next reminder reaches, from the company's roster alone.
 *
 * The settings card needs this because the rest of its preview is built from
 * the WEEK's figures (`abrechnung_schedule_preview`), and a driver with no
 * figures appears in none of those buckets — which is how an active driver with
 * no address came to receive nothing with nobody told (production, 26.10.2026:
 * one driver at Y&A Mobility, and 20 such drivers across six companies).
 *
 * It is here rather than in the card so the card and the job cannot disagree
 * about what an address is or who is active; `planReminders` above applies the
 * same two tests to the same values.
 */
export function summariseReminderRoster(rows: readonly ReminderRosterRow[]): ReminderRosterSummary {
  const perAddress = new Map<string, number>();
  let active = 0;
  let noAddress = 0;
  for (const row of rows) {
    if (row.status !== 'active') continue;
    active += 1;
    const address = reminderAddressKey(row.email);
    if (!address) { noAddress += 1; continue; }
    perAddress.set(address, (perAddress.get(address) ?? 0) + 1);
  }
  let sharedAddresses = 0;
  for (const held of perAddress.values()) if (held > 1) sharedAddresses += 1;
  return { active, noAddress, sharedAddresses, reachable: perAddress.size };
}
