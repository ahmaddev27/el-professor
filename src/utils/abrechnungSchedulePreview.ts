/**
 * What the next scheduled Abrechnung will do, as the settings card states it.
 *
 * The Europe/Berlin arithmetic is NOT written here: it is the job's own
 * (`supabase/functions/_shared/abrechnung-schedule-core.ts`), imported, so the
 * date the card names and the week the job mails cannot be two computations.
 * `abrechnungSchedulePreview.test.ts` additionally runs the job's `dueOccurrence`
 * at the moment this function names and requires the same week back.
 *
 * The counts come from `public.abrechnung_schedule_preview`, which calls the
 * job's own figures function; this file only reads the answer.
 */
import {
  addDays,
  berlinParts,
  parseSendTime,
  weekPeriod,
} from '../../supabase/functions/_shared/abrechnung-schedule-core.ts';

export interface NextOccurrence {
  /** The Berlin day the send happens on, `YYYY-MM-DD`. */
  day: string;
  /** `HH:MM`, Europe/Berlin. */
  time: string;
  /** 0 = Sunday. */
  weekday: number;
  /** The Monday of the completed week that send covers. */
  weekMonday: string;
  /** `DD.MM.YYYY – DD.MM.YYYY` */
  weekRange: string;
}

/** The first occurrence strictly after `now`, or null for a time that is not `HH:MM`. */
export function nextOccurrence(weekday: number, sendTime: string, now: Date): NextOccurrence | null {
  const sendMinutes = parseSendTime(sendTime);
  if (sendMinutes === null || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
  const today = berlinParts(now);
  let ahead = (weekday - today.dow + 7) % 7;
  if (ahead === 0 && sendMinutes <= today.minutes) ahead = 7;
  const day = addDays(today.day, ahead);
  // Same rule as dueOccurrence: the week before the one containing the send day.
  const weekMonday = addDays(addDays(day, -((weekday + 6) % 7)), -7);
  return {
    day,
    time: sendTime.slice(0, 5),
    weekday,
    weekMonday,
    weekRange: weekPeriod(weekMonday).range,
  };
}

export interface DriverBuckets {
  sendable: number;
  ambiguous: number;
  no_driver: number;
  inactive: number;
  no_email: number;
  already_claimed: number;
}

/** The answer of `abrechnung_schedule_preview` when it was allowed. */
export interface SchedulePreviewAnswer {
  week_monday: string;
  schedule: {
    driver_mail_enabled: boolean;
    manager_summary_enabled: boolean;
    weekday: number;
    send_time: string;
  } | null;
  rows: number;
  drivers: DriverBuckets;
  manager_recipients: number;
  manager_claimed: boolean;
}

const BUCKET_KEYS: ReadonlyArray<keyof DriverBuckets> = [
  'sendable', 'ambiguous', 'no_driver', 'inactive', 'no_email', 'already_claimed',
];

/**
 * Reads the RPC's jsonb. Anything that is not exactly the documented shape is
 * null, never a partly filled answer: a figure that did not load is not shown.
 */
export function parsePreviewAnswer(data: unknown): SchedulePreviewAnswer | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.ok !== true || typeof d.week_monday !== 'string') return null;
  if (typeof d.rows !== 'number' || typeof d.manager_recipients !== 'number') return null;
  const drivers = d.drivers as Record<string, unknown> | null;
  if (!drivers || BUCKET_KEYS.some((k) => typeof drivers[k] !== 'number')) return null;
  const s = d.schedule as Record<string, unknown> | null;
  const schedule = s && typeof s.driver_mail_enabled === 'boolean'
    && typeof s.manager_summary_enabled === 'boolean'
    && typeof s.weekday === 'number' && typeof s.send_time === 'string'
    ? {
        driver_mail_enabled: s.driver_mail_enabled,
        manager_summary_enabled: s.manager_summary_enabled,
        weekday: s.weekday,
        send_time: s.send_time,
      }
    : null;
  return {
    week_monday: d.week_monday,
    schedule,
    rows: d.rows,
    drivers: drivers as unknown as DriverBuckets,
    manager_recipients: d.manager_recipients,
    manager_claimed: d.manager_claimed === true,
  };
}

/** Whether a channel goes, is switched off, or is on but reaches no one. */
export type ChannelState =
  | { kind: 'off' }
  | { kind: 'goes'; count: number }
  | { kind: 'no_one' };

export interface PreviewVerdict {
  /** The week holds no bookings at all: nothing goes, whatever the switches say. */
  noBookings: boolean;
  drivers: ChannelState;
  manager: ChannelState;
  /** Neither channel sends anything. */
  nothingGoes: boolean;
}

/** Mirrors the job: no rows means no mail of either kind; a claimed one is not repeated. */
export function judgePreview(a: SchedulePreviewAnswer, driverMail: boolean, managerSummary: boolean): PreviewVerdict {
  const noBookings = a.rows === 0;
  const drivers: ChannelState = !driverMail
    ? { kind: 'off' }
    : !noBookings && a.drivers.sendable > 0
      ? { kind: 'goes', count: a.drivers.sendable }
      : { kind: 'no_one' };
  const manager: ChannelState = !managerSummary
    ? { kind: 'off' }
    : !noBookings && a.manager_recipients > 0 && !a.manager_claimed
      ? { kind: 'goes', count: a.manager_recipients }
      : { kind: 'no_one' };
  return {
    noBookings,
    drivers,
    manager,
    nothingGoes: drivers.kind !== 'goes' && manager.kind !== 'goes',
  };
}
