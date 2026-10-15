/**
 * The scheduled Uber pull: which operating day is due, what is still to claim,
 * and the income rows of one day. Decided here and tested without a database.
 *
 * No Deno, `npm:` or `jsr:` import, so vitest runs this file in Node like
 * abrechnung-schedule-core.ts, and nothing here reads a clock or a database:
 * the job passes `now` and the rows in.
 *
 * ## The rules this file is the only place for
 *
 * 1. **Uber's operating day D runs from D 04:00 to D+1 04:00 (Europe/Berlin).**
 *    At a Berlin wall time T the day still RUNNING is T's date, or the day
 *    before when T is earlier than 04:00.
 *
 * 2. **A run pulls the most recent COMPLETED operating day**, the one before the
 *    running day, never the running one: a half day would be imported as a whole
 *    one. `uber_pull_claim` refuses a day that is not complete as a second wall.
 *
 * 3. **A schedule is a Europe/Berlin time of day.** An occurrence is due from
 *    that moment until `GRACE_MINUTES` later and not at all after: the cron ticks
 *    every ten minutes, so the window is also what lets it run late. The day to
 *    pull is decided from the OCCURRENCE, not from the moment the job happens to
 *    run, so a tick at 06:40 and one at 11:50 ask for the same day.
 *
 * 4. **A schedule never fires for the past.** The occurrence must fall after
 *    `armed_at`, the moment the administrator last changed the switch or the
 *    time, or switching it on at noon would pull for a 06:00 that never ran.
 *
 * 5. **The first pass of a day is claimed once; the recheck exists only when the
 *    corrections switch is on and the day before was imported.** Replace is the
 *    claim's property in the database; this file only decides which claims to
 *    try.
 *
 * Comparisons are on Berlin WALL-CLOCK minutes, not instants. Across a
 * daylight-saving change that is off by at most an hour at the edge of the
 * grace window, which is why the window is hours wide and nothing is decided on
 * a boundary.
 */
import { addDays, berlinParts, parseSendTime } from './abrechnung-schedule-core.ts';
import {
  centsToDecimal,
  mondayOf,
  type UberDriverEarnings,
} from './uber-earnings-core.ts';

/** Uber's operating day starts here, in minutes after midnight Berlin time. */
export const OPERATING_DAY_START_MINUTES = 4 * 60;

/** How long after its moment an occurrence may still run. */
export const GRACE_MINUTES = 12 * 60;

const MINUTE = 60_000;

function wall(day: string, minutes: number): number {
  return Date.parse(`${day}T00:00:00Z`) / MINUTE + minutes;
}

/** The operating day a Berlin wall-clock moment falls in. */
export function operatingDayOf(day: string, minutes: number): string {
  return minutes < OPERATING_DAY_START_MINUTES ? addDays(day, -1) : day;
}

/** The operating day still running at `instant`. */
export function runningOperatingDay(instant: Date): string {
  const parts = berlinParts(instant);
  return operatingDayOf(parts.day, parts.minutes);
}

/** The most recent operating day that has COMPLETED at `instant`. */
export function completedOperatingDay(instant: Date): string {
  return addDays(runningOperatingDay(instant), -1);
}

export type UberPass = 'first' | 'recheck';

export type UberPullOutcome =
  | 'imported' | 'nothing_to_import' | 'blocked_unlinked' | 'blocked_unmatched'
  | 'already_imported' | 'not_connected' | 'seal_unreadable' | 'token_rejected'
  | 'partner_refused' | 'partner_unavailable' | 'partner_malformed'
  | 'company_blocked' | 'refused' | 'failed';

/** An outcome that wrote what was asked, or had nothing to write. */
const SUCCESS_OUTCOMES: ReadonlySet<string> = new Set(['imported', 'nothing_to_import']);

/** Anything but a success, and a claim with no outcome at all (a crash), is a failure a person must see. */
export function isFailure(outcome: string | null): boolean {
  return outcome === null || !SUCCESS_OUTCOMES.has(outcome);
}

/** One company from `uber_pull_candidates`. */
export interface UberPullCompany {
  company_id: string;
  /** `HH:MM`, Europe/Berlin. */
  run_time: string;
  replace_corrections: boolean;
  armed_at: string;
  runs: ReadonlyArray<{ day_key: string; pass: string; outcome: string | null }>;
}

export type NotDueReason = 'invalid_schedule' | 'missed' | 'before_armed';

export interface DueOccurrence {
  /** The Berlin day the schedule's moment fell on. */
  occurrenceDay: string;
  /** The completed operating day this occurrence pulls. */
  pullDay: string;
}

/**
 * The occurrence that is due now, or the reason there is none.
 *
 * The latest moment at or before `now` that falls on the schedule's time is the
 * only candidate; an earlier one is never revived.
 */
export function dueOccurrence(
  schedule: Pick<UberPullCompany, 'run_time' | 'armed_at'>,
  now: Date,
): { due: DueOccurrence } | { due: null; reason: NotDueReason } {
  const runMinutes = parseSendTime(schedule.run_time);
  const armed = Date.parse(schedule.armed_at);
  if (runMinutes === null || Number.isNaN(armed)) return { due: null, reason: 'invalid_schedule' };

  const today = berlinParts(now);
  const occurrenceDay = runMinutes > today.minutes ? addDays(today.day, -1) : today.day;

  const occurrence = wall(occurrenceDay, runMinutes);
  if (wall(today.day, today.minutes) - occurrence > GRACE_MINUTES) {
    return { due: null, reason: 'missed' };
  }

  const armedParts = berlinParts(new Date(armed));
  if (occurrence <= wall(armedParts.day, armedParts.minutes)) {
    return { due: null, reason: 'before_armed' };
  }

  const running = operatingDayOf(occurrenceDay, runMinutes);
  return { due: { occurrenceDay, pullDay: addDays(running, -1) } };
}

/** One claim the job should try, in the order to try them. */
export interface UberPullTask {
  day: string;
  pass: UberPass;
}

/** What is to be claimed for one company right now. */
export interface UberPullPlan {
  companyId: string;
  occurrenceDay: string;
  tasks: UberPullTask[];
}

/**
 * The plan for one company, or null when nothing is due.
 *
 * `first` for the completed day unless a claim for it exists, whatever its
 * outcome: a failed day is not retried by the schedule (the button pulls it).
 * `recheck` for the day before it, only with the corrections switch on, only
 * when that day's first pass was IMPORTED, and only once.
 */
export function planCompany(company: UberPullCompany, now: Date): UberPullPlan | null {
  const result = dueOccurrence(company, now);
  if (result.due === null) return null;
  const { pullDay, occurrenceDay } = result.due;

  const held = (day: string, pass: UberPass) =>
    company.runs.some((r) => r.day_key === day && r.pass === pass);

  const tasks: UberPullTask[] = [];
  if (!held(pullDay, 'first')) tasks.push({ day: pullDay, pass: 'first' });

  const recheckDay = addDays(pullDay, -1);
  const firstImported = company.runs.some(
    (r) => r.day_key === recheckDay && r.pass === 'first' && r.outcome === 'imported',
  );
  if (company.replace_corrections && firstImported && !held(recheckDay, 'recheck')) {
    tasks.push({ day: recheckDay, pass: 'recheck' });
  }

  return tasks.length === 0 ? null : { companyId: company.company_id, occurrenceDay, tasks };
}

/**
 * `Woche N`: how many Mondays of the Monday's month have passed, this one
 * included. Same value as the screen's `weekNumberOf` (pinned by a parity test).
 */
export function businessWeekNumber(monday: string): number {
  const dayOfMonth = Number(monday.slice(8, 10));
  return Math.floor((dayOfMonth - 1) / 7) + 1;
}

/** The text written to `income.description`; `Woche \d+` must stay first. */
export function importDescription(week: number): string {
  return `Woche ${week} - Uber`;
}

/** One element of the `p_rows` array the system writer takes. */
export interface UberImportRow {
  external_driver_id: string;
  type: 'umsatz' | 'aktionen' | 'trinkgeld' | 'bargeld';
  amount: string;
  date: string;
  week: number;
  description: string;
  trip_count: number | null;
  period_start: string;
  period_end: string;
}

const TYPES: ReadonlyArray<{
  type: UberImportRow['type'];
  field: 'fareCents' | 'promotionCents' | 'tipsCents' | 'cashCents';
}> = [
  { type: 'umsatz', field: 'fareCents' },
  { type: 'aktionen', field: 'promotionCents' },
  { type: 'trinkgeld', field: 'tipsCents' },
  { type: 'bargeld', field: 'cashCents' },
];

/**
 * The rows of one operating day, by the screen's own rule: one row per driver
 * per type, a zero amount is not a row (except a `umsatz` of 0 with trips), and
 * the trip count rides on the `umsatz` row only.
 */
export function buildDayRows(day: string, drivers: readonly UberDriverEarnings[]): UberImportRow[] {
  const week = businessWeekNumber(mondayOf(day));
  const rows: UberImportRow[] = [];
  for (const driver of drivers) {
    for (const { type, field } of TYPES) {
      const cents = driver[field];
      const tripsOnly = type === 'umsatz' && cents === 0 && (driver.trips ?? 0) > 0;
      if (cents <= 0 && !tripsOnly) continue;
      rows.push({
        external_driver_id: driver.externalDriverId,
        type,
        amount: centsToDecimal(cents),
        date: day,
        week,
        description: importDescription(week),
        trip_count: type === 'umsatz' ? driver.trips : null,
        period_start: day,
        period_end: day,
      });
    }
  }
  return rows;
}

/** The earners that would produce a row, once each. */
export function driversWithRows(drivers: readonly UberDriverEarnings[], day: string): UberDriverEarnings[] {
  return drivers.filter((d) => buildDayRows(day, [d]).length > 0);
}

/**
 * Maps the system writer's refusal reason to the outcome the run records.
 * An unknown reason is `refused`, with the reason in the detail.
 */
export function outcomeOfRefusal(reason: string): UberPullOutcome {
  switch (reason) {
    case 'already_imported': return 'already_imported';
    case 'driver_not_linked': return 'blocked_unlinked';
    case 'company_blocked': return 'company_blocked';
    default: return 'refused';
  }
}
