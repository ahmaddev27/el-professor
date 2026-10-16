/**
 * Which notifications are due tonight, and for which target — the whole
 * decision, as one pure function.
 *
 * No Deno, npm: or jsr: import: vitest runs this file in Node, the way it runs
 * otp-core.ts and smtp-core.ts. The Deno half, which loads the candidates,
 * resolves the recipients and sends, is notification-delivery.ts.
 *
 * ─── What the two types mean ─────────────────────────────────────────────────
 *
 * They are the values `notification_settings` already stores, and the screen
 * that writes them is `src/pages/NotificationsPage.tsx`:
 *
 *   tuev_bald_ablaufend   a car's `cars.tuev_gueltig_bis` is at most
 *                         TUEV_SOON_DAYS away
 *   tuev_abgelaufen       that date has passed
 *
 * There used to be two more, `trial_bald_ablaufend` and `trial_abgelaufen`.
 * They went with the free trial (owner, 15.10.2026: "there is no 14 day try for
 * free version"); `20261015170000` removes them from the database too.
 *
 * ─── The window is the product's own, not a new constant ─────────────────────
 *
 * TUEV_SOON_DAYS is 60 because `getTuevStatus()` in `src/types/car.ts` already
 * turns the badge amber at 60 days and the Fahrzeuge screen counts
 * `bald_ablaufend` with it, and because `20260502121504_create_notification_settings.sql`
 * documents this very type as "TÜV läuft bald ab (≤60 Tage)". A different
 * number here would make the mail and the screen disagree about the same car on
 * the same day.
 *
 * ─── Every value here is a calendar day in Europe/Berlin ─────────────────────
 *
 * `cars.tuev_gueltig_bis` is a `date`. It is reduced to a `YYYY-MM-DD` day in
 * Europe/Berlin and compared as days, so a run at 03:00 and a run at 23:00 on
 * the same date reach the same answer, and no comparison lands on a DST boundary.
 */

// ─── The two types ──────────────────────────────────────────────────────────

export type NotificationType = 'tuev_bald_ablaufend' | 'tuev_abgelaufen';

export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  'tuev_bald_ablaufend',
  'tuev_abgelaufen',
];

/** `cars.tuev_gueltig_bis` at most this many days away counts as "bald ablaufend". */
export const TUEV_SOON_DAYS = 60;

/**
 * What a company that has never opened the screen is subscribed to.
 *
 * `NotificationsPage` renders exactly this map when `notification_settings`
 * holds no row for the company ("No saved settings yet — keep defaults"), so a
 * company that has never saved is *shown* both types as on. The job has
 * to agree with the screen or the screen is a lie, which is why the fallback
 * lives here and is tested rather than left to the query.
 */
export const NOTIFICATION_DEFAULT_ENABLED: Readonly<Record<NotificationType, boolean>> = {
  tuev_bald_ablaufend: true,
  tuev_abgelaufen: true,
};

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

// ─── Calendar days in Europe/Berlin ──────────────────────────────────────────

const BERLIN_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The Europe/Berlin calendar day an instant falls on, as `YYYY-MM-DD`. */
export function berlinDay(instant: Date): string {
  if (Number.isNaN(instant.getTime())) throw new RangeError('notification: invalid instant');
  const parts: Record<string, string> = {};
  for (const part of BERLIN_DAY.formatToParts(instant)) parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * A stored value → the Europe/Berlin calendar day it names, or null.
 *
 * A bare `YYYY-MM-DD` — what PostgREST returns for a `date` column — is that
 * day and is never pushed through a timezone, because `new Date('2026-11-01')`
 * is midnight *UTC* and would read as 31.10. in a zone behind Berlin. Anything
 * else is parsed as an instant and reduced to its Berlin day. A value that does
 * not parse is null: a broken date is not a reason to mail anyone.
 */
export function toBerlinDay(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  if (ISO_DAY.test(text)) return text;
  const instant = new Date(text);
  return Number.isNaN(instant.getTime()) ? null : berlinDay(instant);
}

/** Whole days from one `YYYY-MM-DD` to another; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = ISO_DAY.exec(from);
  const b = ISO_DAY.exec(to);
  if (!a || !b) throw new RangeError('notification: day must be YYYY-MM-DD');
  const start = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const end = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.round((end - start) / 86_400_000);
}

// ─── The candidate rows ──────────────────────────────────────────────────────

/** One row of `notification_settings`, as the candidate query returns it. */
export interface NotificationSettingRow {
  notification_type: string;
  enabled: boolean;
  email_global_enabled: boolean;
}

/** One of the company's cars: the id, the plate for the mail, and the TÜV date. */
export interface NotificationCarRow {
  id: string;
  kennzeichen: string | null;
  tuev_gueltig_bis: string | null;
}

/** One row of `notification_deliveries`: a notification already claimed. */
export interface NotificationSentRow {
  notification_type: string;
  target_id: string;
  period_key: string;
}

/**
 * One company as the candidate RPC returns it.
 *
 * The RPC has already dropped every company the product blocks outright — not
 * `approved`, or a `status` other than `active` — so nothing here has to
 * re-check that. What is left for this module is the arithmetic.
 */
export interface NotificationCompany {
  company_id: string;
  company_name: string | null;
  settings: readonly NotificationSettingRow[];
  cars: readonly NotificationCarRow[];
  sent: readonly NotificationSentRow[];
}

/** One notification the job would send. */
export interface PlannedNotification {
  companyId: string;
  companyName: string | null;
  type: NotificationType;
  /** The car the notification is about. */
  targetId: string;
  /**
   * The occurrence this notification is about: the date the type turns on.
   *
   * See `selectNotifications` for why this, and not the day of the run, is what
   * the dedupe is keyed on.
   */
  periodKey: string;
  /** The car's plate, for a TÜV notification. */
  plate?: string | null;
  /** The date the mail names: the TÜV expiry. */
  dueDay: string;
  /** Days from today to `dueDay`; negative once it has passed. */
  daysLeft: number;
}

// ─── Is a type on for this company ───────────────────────────────────────────

/**
 * Whether a company wants one type, exactly as its screen shows it.
 *
 * The master switch wins, and it is read off whichever row carries it — the
 * screen writes the same value to every row in one upsert, and the page
 * reads `rows[0]`. Without any row at all the company has never saved, and both
 * the master switch and the type fall back to what the screen displays.
 */
export function notificationEnabled(
  settings: readonly NotificationSettingRow[],
  type: NotificationType,
): boolean {
  if (settings.length > 0 && !settings.some((row) => row.email_global_enabled === true)) return false;
  const row = settings.find((candidate) => candidate.notification_type === type);
  return row ? row.enabled === true : NOTIFICATION_DEFAULT_ENABLED[type];
}

// ─── The decision ────────────────────────────────────────────────────────────

/**
 * Everything due for one company, in a stable order, with everything already
 * claimed removed.
 *
 * **The dedupe key is the occurrence, never the day of the run.** A
 * notification is identified by (company, type, target, `periodKey`), and
 * `periodKey` is the date the occurrence is *about*: the car's TÜV expiry, or
 * That is the answer to "is a re-notification ever
 * correct":
 *
 *   - A TÜV that expires and is never renewed keeps the same
 *     `tuev_gueltig_bis`, so its `tuev_abgelaufen` has one occurrence and is
 *     mailed once — not once a night for as long as the car sits there.
 *   - A TÜV that is renewed gets a *new* `tuev_gueltig_bis`. That is a new
 *     occurrence, so the car is warned again 60 days before the new date, and
 *     told again if it lapses again. Renew → expire → renew → expire mails four
 *     times, once per occurrence, which is right.
 *   - The two TÜV types are separate occurrences of the same date, so a car
 *     warned at 60 days is still told when the date passes. They are not one
 *     notification in two states.
 *
 * So the rule is: **one mail per fact, and a fact that changes is a new fact.**
 * Nothing is ever re-sent because a night went by.
 */
export function selectNotifications(
  company: NotificationCompany,
  now: Date,
): PlannedNotification[] {
  const today = berlinDay(now);

  const planned: PlannedNotification[] = [];

  // ── TÜV, per car ─────────────────────────────────────────────────────────
  //
  // A car with no date has no occurrence — `getTuevStatus` calls that
  // `unbekannt` and the screen shows no badge, so there is nothing to mail.
  for (const car of company.cars) {
    const due = toBerlinDay(car.tuev_gueltig_bis);
    if (!due) continue;
    const daysLeft = daysBetween(today, due);

    // The same two branches as getTuevStatus(), in the same order.
    const type: NotificationType | null = daysLeft < 0
      ? 'tuev_abgelaufen'
      : daysLeft <= TUEV_SOON_DAYS
        ? 'tuev_bald_ablaufend'
        : null;
    if (!type) continue;
    if (!notificationEnabled(company.settings, type)) continue;

    planned.push({
      companyId: company.company_id,
      companyName: company.company_name,
      type,
      targetId: car.id,
      periodKey: due,
      plate: car.kennzeichen,
      dueDay: due,
      daysLeft,
    });
  }

  const already = new Set(
    company.sent.map((row) => deliveryKey(row.notification_type, row.target_id, row.period_key)),
  );
  return planned.filter((item) => !already.has(deliveryKey(item.type, item.targetId, item.periodKey)));
}

/** The identity of one notification inside one company. */
export function deliveryKey(type: string, targetId: string, periodKey: string): string {
  return `${type}\u0000${targetId}\u0000${periodKey}`;
}

/** Every company's notifications, flattened, companies in the order given. */
export function selectAllNotifications(
  companies: readonly NotificationCompany[],
  now: Date,
): PlannedNotification[] {
  return companies.flatMap((company) => selectNotifications(company, now));
}
