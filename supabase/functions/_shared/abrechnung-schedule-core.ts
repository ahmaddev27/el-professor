/**
 * The scheduled Abrechnung: what is due now, which week it is about, and who
 * gets which mail. Decided here and tested without a database.
 *
 * No Deno, `npm:` or `jsr:` import, so vitest runs this file in Node like
 * notification-core.ts, and nothing here reads a clock or a database: the job
 * passes `now` and the rows in.
 *
 * ## The three rules this file is the only place for
 *
 * 1. **A schedule is a Europe/Berlin weekday and wall-clock time.** An
 *    occurrence is due from that moment until `GRACE_MINUTES` later, and not at
 *    all after: a cron that was down for a day sends nothing late, because a
 *    Monday-morning Abrechnung that arrives on Wednesday evening is a surprise,
 *    not a service. The grace window is also why the cron line can run every
 *    few minutes rather than being exact.
 *
 * 2. **What is sent is the most recently completed week**, named by its Monday:
 *    the week before the one that contains the occurrence's day. The week is the
 *    dedupe key (`period_key`), so a repeated run finds it claimed.
 *
 * 3. **A schedule never fires for the past.** An occurrence must fall after
 *    `armed_at`, the moment the administrator last changed the schedule, or
 *    switching it on on a Tuesday would send Monday's mail at once.
 *
 * The comparison is on Berlin wall-clock minutes, not instants. Across a
 * daylight-saving change that is off by at most an hour at the edge of the
 * grace window, which is why the window is hours wide and nothing is
 * claimed on a boundary.
 */
import type { AbrechnungFigures } from './abrechnung-mail.ts';

/** How long after its moment an occurrence may still be sent. */
export const GRACE_MINUTES = 12 * 60;

/** The reminder's lead, in minutes before the driver mail. The column's CHECK is the same range. */
export const REMINDER_LEAD_DEFAULT_MINUTES = 60;
export const REMINDER_LEAD_MIN_MINUTES = 15;
export const REMINDER_LEAD_MAX_MINUTES = 720;

/**
 * How long after its own moment a reminder may still go out. A reminder that is
 * late is worth less every minute (its point is to leave time to enter the data),
 * and the cron ticks every ten minutes, so thirty minutes is three chances. The
 * window also never runs past the driver mail's moment: see `dueReminder`.
 */
export const REMINDER_WINDOW_MINUTES = 30;

const MINUTE = 60_000;

/** One company from `abrechnung_schedule_candidates`. */
export interface ScheduleCompany {
  company_id: string;
  company_name: string | null;
  driver_mail_enabled: boolean;
  manager_summary_enabled: boolean;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  /** `HH:MM`, Europe/Berlin. */
  send_time: string;
  armed_at: string;
  sent: ReadonlyArray<{ kind: string; target_id: string; period_key: string }>;
  /** Remind a driver who has recorded nothing, `reminder_lead_minutes` before the driver mail. */
  reminder_enabled: boolean;
  reminder_lead_minutes: number;
}

/** One row of `abrechnung_week_figures`. */
export interface WeekFigureRow {
  driver_name: string;
  anzahl_belege: number | string;
  ausgegebene_bargeld: number | string;
  bargeld: number | string;
  bar_zuruck: number | string;
  tanken_brutto: number | string;
  umsatz_netto: number | string;
  match_count: number | string;
  driver_id: string | null;
  driver_email: string | null;
}

export interface Berlin {
  /** `YYYY-MM-DD` */
  day: string;
  /** 0 = Sunday */
  dow: number;
  minutes: number;
}

const WEEKDAYS = new Map([['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6]]);

const BERLIN_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  weekday: 'short',
});

/** The Europe/Berlin calendar day, weekday and minute of day of an instant. */
export function berlinParts(instant: Date): Berlin {
  const parts: Record<string, string> = {};
  for (const part of BERLIN_FORMAT.formatToParts(instant)) parts[part.type] = part.value;
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    dow: WEEKDAYS.get(parts.weekday) ?? 0,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseDay(day: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new RangeError('abrechnung schedule: day must be YYYY-MM-DD');
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `day` moved by `offset` calendar days. UTC arithmetic: no daylight-saving drift. */
export function addDays(day: string, offset: number): string {
  return formatDay(parseDay(day) + offset * 86_400_000);
}

/** A Berlin wall-clock moment as minutes since the epoch, for comparing two of them. */
function wall(day: string, minutes: number): number {
  return parseDay(day) / MINUTE + minutes;
}

/** `HH:MM` as minutes of the day, or null when it is not one. */
export function parseSendTime(text: string): number | null {
  const match = /^(\d{2}):(\d{2})/.exec(text);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[1]) < 24 && Number(match[2]) < 60 ? minutes : null;
}

export interface DueOccurrence {
  /** The Berlin day the schedule's moment fell on. */
  occurrenceDay: string;
  /** The Monday of the completed week the mails are about, `YYYY-MM-DD`. */
  weekMonday: string;
}

export type NotDueReason = 'invalid_schedule' | 'missed' | 'before_armed';

/**
 * The occurrence that is due now, or the reason there is none.
 *
 * The latest moment at or before `now` that falls on the schedule's weekday and
 * time is the only candidate; an earlier one is never revived.
 */
export function dueOccurrence(
  schedule: Pick<ScheduleCompany, 'weekday' | 'send_time' | 'armed_at'>,
  now: Date,
): { due: DueOccurrence } | { due: null; reason: NotDueReason } {
  const sendMinutes = parseSendTime(schedule.send_time);
  const armed = Date.parse(schedule.armed_at);
  if (sendMinutes === null || !Number.isInteger(schedule.weekday)
      || schedule.weekday < 0 || schedule.weekday > 6 || Number.isNaN(armed)) {
    return { due: null, reason: 'invalid_schedule' };
  }

  const today = berlinParts(now);
  let back = (today.dow - schedule.weekday + 7) % 7;
  // Today is the day, but the time has not come: the latest occurrence is last week's.
  if (back === 0 && sendMinutes > today.minutes) back = 7;
  const occurrenceDay = addDays(today.day, -back);

  const occurrence = wall(occurrenceDay, sendMinutes);
  const elapsed = wall(today.day, today.minutes) - occurrence;
  if (elapsed > GRACE_MINUTES) return { due: null, reason: 'missed' };

  const armedParts = berlinParts(new Date(armed));
  if (occurrence <= wall(armedParts.day, armedParts.minutes)) {
    return { due: null, reason: 'before_armed' };
  }

  const mondayOfOccurrence = addDays(occurrenceDay, -((schedule.weekday + 6) % 7));
  return { due: { occurrenceDay, weekMonday: addDays(mondayOfOccurrence, -7) } };
}

export interface DueReminder {
  /** The Berlin day of the driver mail this reminder precedes. */
  mainDay: string;
  /** The Monday of the completed week the figures are about, `YYYY-MM-DD`. */
  weekMonday: string;
}

export type ReminderNotDueReason = 'invalid_schedule' | 'not_in_window' | 'before_armed';

/**
 * The reminder that is due now, or the reason there is none.
 *
 * A reminder moment is the driver mail's moment minus `reminder_lead_minutes`.
 * It is due from that moment for `REMINDER_WINDOW_MINUTES`, and **never at or
 * after the driver mail's own moment**, so the window cannot run into the mail
 * it warns about. (That is the clock's half; the claim's half, which holds even
 * when the clock is wrong, is `abrechnung_delivery_claim`.) The mail's moment can
 * lie on the next Berlin day when the lead crosses midnight, so today and
 * tomorrow are both candidates. Like `dueOccurrence`, a reminder never fires for
 * a moment before `armed_at`.
 */
export function dueReminder(
  schedule: Pick<ScheduleCompany, 'weekday' | 'send_time' | 'armed_at' | 'reminder_lead_minutes'>,
  now: Date,
): { due: DueReminder } | { due: null; reason: ReminderNotDueReason } {
  const sendMinutes = parseSendTime(schedule.send_time);
  const armed = Date.parse(schedule.armed_at);
  const lead = schedule.reminder_lead_minutes;
  if (sendMinutes === null || !Number.isInteger(schedule.weekday)
      || schedule.weekday < 0 || schedule.weekday > 6 || Number.isNaN(armed)
      || !Number.isInteger(lead)
      || lead < REMINDER_LEAD_MIN_MINUTES || lead > REMINDER_LEAD_MAX_MINUTES) {
    return { due: null, reason: 'invalid_schedule' };
  }

  const today = berlinParts(now);
  const nowWall = wall(today.day, today.minutes);
  const armedParts = berlinParts(new Date(armed));
  const armedWall = wall(armedParts.day, armedParts.minutes);

  let armedOut = false;
  for (const offset of [0, 1]) {
    if ((today.dow + offset) % 7 !== schedule.weekday) continue;
    const mainDay = addDays(today.day, offset);
    const mainWall = wall(mainDay, sendMinutes);
    const reminderWall = mainWall - lead;
    const windowEnd = Math.min(reminderWall + REMINDER_WINDOW_MINUTES, mainWall);
    if (nowWall < reminderWall || nowWall >= windowEnd) continue;
    if (reminderWall <= armedWall) { armedOut = true; continue; }
    const mondayOfMain = addDays(mainDay, -((schedule.weekday + 6) % 7));
    return { due: { mainDay, weekMonday: addDays(mondayOfMain, -7) } };
  }
  return { due: null, reason: armedOut ? 'before_armed' : 'not_in_window' };
}

/** A Berlin wall-clock moment, split for display. */
export interface Moment {
  /** `YYYY-MM-DD`, the moment's own Berlin day. */
  day: string;
  /** `HH:MM` */
  time: string;
  /** 0 = Sunday. */
  weekday: number;
}

export interface NextMoments {
  /** The next driver mail that will actually go out. */
  send: Moment;
  /** The next reminder that will actually go out; null when reminders are off. */
  reminder: Moment | null;
}

function momentOf(wallMinutes: number): Moment {
  const dayIndex = Math.floor(wallMinutes / 1440);
  const minutes = wallMinutes - dayIndex * 1440;
  const day = formatDay(dayIndex * 86_400_000);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return { day, time: `${hh}:${mm}`, weekday: new Date(dayIndex * 86_400_000).getUTCDay() };
}

/**
 * The next moments this schedule really produces, for the settings card, or null
 * when the schedule is invalid. It applies the same rules as `dueOccurrence` and
 * `dueReminder`, including rule 3: a moment at or before `armed_at` never fires,
 * so it is skipped and the answer is the week after. The reminder is reported
 * only when it and the driver mail are both on, as `planReminder` requires; a
 * reminder still inside its window counts as next, because it will go out.
 */
export function nextMoments(
  schedule: Pick<ScheduleCompany, 'weekday' | 'send_time' | 'armed_at' | 'reminder_lead_minutes'
    | 'reminder_enabled' | 'driver_mail_enabled'>,
  now: Date,
): NextMoments | null {
  const sendMinutes = parseSendTime(schedule.send_time);
  const armed = Date.parse(schedule.armed_at);
  const lead = schedule.reminder_lead_minutes;
  if (sendMinutes === null || !Number.isInteger(schedule.weekday)
      || schedule.weekday < 0 || schedule.weekday > 6 || Number.isNaN(armed)) return null;

  const today = berlinParts(now);
  const nowWall = wall(today.day, today.minutes);
  const armedParts = berlinParts(new Date(armed));
  const armedWall = wall(armedParts.day, armedParts.minutes);
  const wantReminder = schedule.reminder_enabled && schedule.driver_mail_enabled
    && Number.isInteger(lead) && lead >= REMINDER_LEAD_MIN_MINUTES && lead <= REMINDER_LEAD_MAX_MINUTES;

  // From yesterday: a reminder before a mail just after midnight belongs to the day before it.
  const first = addDays(today.day, -1);
  const firstDow = (today.dow + 6) % 7;
  let mainDay = addDays(first, (schedule.weekday - firstDow + 7) % 7);

  let send: Moment | null = null;
  let reminder: Moment | null = null;
  for (let week = 0; week < 4 && (send === null || (wantReminder && reminder === null)); week++) {
    const mainWall = wall(mainDay, sendMinutes);
    if (send === null && mainWall > nowWall && mainWall > armedWall) send = momentOf(mainWall);
    if (wantReminder && reminder === null) {
      const reminderWall = mainWall - lead;
      const windowEnd = Math.min(reminderWall + REMINDER_WINDOW_MINUTES, mainWall);
      if (windowEnd > nowWall && reminderWall > armedWall) reminder = momentOf(reminderWall);
    }
    mainDay = addDays(mainDay, 7);
  }
  return send === null ? null : { send, reminder };
}

const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/** `DD.MM.YYYY` from `YYYY-MM-DD`. Never US `MM/DD/YYYY`. */
export function germanDay(day: string): string {
  const [y, m, d] = day.split('-');
  return `${d}.${m}.${y}`;
}

/**
 * The week as the Abrechnung screen labels it: "Woche 5 - August 2026" and
 * "31.08.2026 – 06.09.2026".
 *
 * A business week belongs to the month containing its Monday, and its number is
 * how many Mondays of that month have passed including this one, which is
 * `ceil(day of month / 7)` for a Monday.
 */
export function weekPeriod(weekMonday: string): { label: string; range: string } {
  const [year, month, dayOfMonth] = weekMonday.split('-').map(Number);
  const number = Math.floor((dayOfMonth - 1) / 7) + 1;
  return {
    label: `Woche ${number} - ${MONTH_NAMES[month - 1]} ${year}`,
    range: `${germanDay(weekMonday)} – ${germanDay(addDays(weekMonday, 6))}`,
  };
}

/** What one company needs doing right now, before any claim. */
export interface ScheduledPlan {
  companyId: string;
  companyName: string;
  weekMonday: string;
  occurrenceDay: string;
  /** The driver mails are switched on; which drivers are still to get one is decided per row. */
  driverMail: boolean;
  /** The manager summary is on and has not been claimed for this week. */
  managerSummary: boolean;
  claimedDriverIds: ReadonlySet<string>;
}

/** The plan for one company, or null when nothing is due. */
export function planCompany(company: ScheduleCompany, now: Date): ScheduledPlan | null {
  const result = dueOccurrence(company, now);
  if (result.due === null) return null;
  const { weekMonday, occurrenceDay } = result.due;

  const inWeek = company.sent.filter((s) => s.period_key === weekMonday);
  const summaryClaimed = inWeek.some(
    (s) => s.kind === 'manager_summary' && s.target_id === company.company_id,
  );
  const claimedDriverIds = new Set(
    inWeek.filter((s) => s.kind === 'driver_abrechnung').map((s) => s.target_id),
  );

  return {
    companyId: company.company_id,
    companyName: (company.company_name ?? '').trim() || '—',
    weekMonday,
    occurrenceDay,
    driverMail: company.driver_mail_enabled,
    managerSummary: company.manager_summary_enabled && !summaryClaimed,
    claimedDriverIds,
  };
}

/** What one company needs doing for the reminder right now. */
export interface ReminderPlan {
  companyId: string;
  companyName: string;
  weekMonday: string;
  /** `HH:MM`, the moment the driver mail goes out, Europe/Berlin. */
  sendTime: string;
  /**
   * Drivers who already have this week's reminder OR this week's driver mail
   * claimed. The second half is the rule that a reminder never follows the mail;
   * the claim enforces it again.
   */
  coveredDriverIds: ReadonlySet<string>;
}

/** The reminder plan for one company, or null when none is due (or it is off). */
export function planReminder(company: ScheduleCompany, now: Date): ReminderPlan | null {
  // The reminder warns about the driver mail, so it needs that mail to be on.
  if (!company.reminder_enabled || !company.driver_mail_enabled) return null;
  const result = dueReminder(company, now);
  if (result.due === null) return null;
  const { weekMonday } = result.due;

  const covered = new Set(
    company.sent
      .filter((s) => s.period_key === weekMonday
        && (s.kind === 'driver_abrechnung' || s.kind === 'driver_reminder'))
      .map((s) => s.target_id),
  );
  return {
    companyId: company.company_id,
    companyName: (company.company_name ?? '').trim() || '—',
    weekMonday,
    sendTime: company.send_time.slice(0, 5),
    coveredDriverIds: covered,
  };
}

function toNumber(value: number | string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The figures one row carries, read as the Abrechnung screen reads them.
 *
 * The Tankenquote is shown only when there is revenue to divide by (the screen's
 * `calcTankenquote`), and left out otherwise rather than printed as a nought.
 */
export function figuresOfRow(row: WeekFigureRow): AbrechnungFigures {
  const umsatz = toNumber(row.umsatz_netto);
  return {
    cash: toNumber(row.bargeld),
    belege: toNumber(row.ausgegebene_bargeld),
    difference: toNumber(row.bar_zuruck),
    belegeCount: Math.round(toNumber(row.anzahl_belege)),
    tankenquote: umsatz > 0 ? (toNumber(row.tanken_brutto) / umsatz) * 100 : null,
  };
}

export interface DriverMailTarget {
  driverId: string;
  driverName: string;
  email: string;
  figures: AbrechnungFigures;
}

export interface DriverMailPlan {
  /** Will be mailed (a dry run reports them, a send claims them). */
  sendable: DriverMailTarget[];
  /** Already claimed for this week: not mailed again. */
  alreadyClaimed: string[];
  /** Two or more drivers carry this name: never resolved by picking one. */
  ambiguous: string[];
  /** No active driver with an address matches the row. */
  noAddress: string[];
}

/**
 * Who among a week's rows gets a mail. The names go in the report, never an
 * address: the address stays on the row it came from.
 */
export function planDriverMails(
  rows: readonly WeekFigureRow[],
  claimedDriverIds: ReadonlySet<string>,
): DriverMailPlan {
  const plan: DriverMailPlan = { sendable: [], alreadyClaimed: [], ambiguous: [], noAddress: [] };
  for (const row of rows) {
    if (toNumber(row.match_count) > 1) {
      plan.ambiguous.push(row.driver_name);
    } else if (!row.driver_id || !row.driver_email) {
      plan.noAddress.push(row.driver_name);
    } else if (claimedDriverIds.has(row.driver_id)) {
      plan.alreadyClaimed.push(row.driver_name);
    } else {
      plan.sendable.push({
        driverId: row.driver_id,
        driverName: row.driver_name,
        email: row.driver_email,
        figures: figuresOfRow(row),
      });
    }
  }
  return plan;
}
