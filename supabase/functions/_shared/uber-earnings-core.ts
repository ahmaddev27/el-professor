/**
 * The Uber earnings wire contract, read strictly.
 *
 * Pure: no Deno, no `npm:`, no `jsr:` and no network, so vitest loads it, the
 * edge function validates the partner's answer with it and the screen
 * re-validates what the function returned with the very same code.
 *
 * ## Money is a string on the wire, and this refuses what does not match
 *
 * Reidey sends every amount as a plain decimal string, a dot, at most two
 * places. This product's display parser reads `1.234` as 1.23 and answers 0 for
 * what it cannot read, so a JSON number (or a comma, or a thousands separator)
 * is a figure silently wrong by a factor of a thousand. Nothing here coerces:
 * a value that is not exactly that shape makes the WHOLE answer unusable.
 *
 * Amounts leave this module as integer cents. No float is ever involved.
 *
 * ## Dates are ISO strings and are never put through a `Date`
 *
 * A date here names a calendar day, not a midnight: Uber's week is Monday 04:00
 * to the next Monday 04:00 Europe/Berlin, and a segment `from`..`to` covers
 * 04:00 on `from` to 04:00 on the day after `to`. Reidey applies the offset;
 * nothing in this module does.
 *
 * The business week is Monday to Sunday, and a weekday computed in the local
 * zone shifts on a DST night. Everything here is calendar arithmetic on
 * `YYYY-MM-DD` through `Date.UTC`, which has no daylight saving.
 */

const MONEY = /^(0|[1-9]\d{0,8})(\.\d{1,2})?$/;
const SIGNED_MONEY = /^-?(0|[1-9]\d{0,8})(\.\d{1,2})?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** One driver's totals for one stretch of days, as Reidey reported them. */
export interface UberDriverEarnings {
  /** Reidey's driver id as text: the key `partner_driver_links` is keyed on. */
  externalDriverId: string;
  uberDriverUuid: string | null;
  /** Reidey's own spelling. Display only; never stored, never matched on. */
  name: string;
  fareCents: number;
  promotionCents: number;
  tipsCents: number;
  cashCents: number;
  netOutstandingCents: number;
  trips: number | null;
  /** Reidey's own reconciliation figure; signed. */
  differenceCents: number;
}

/**
 * An earner Uber reports whom Reidey cannot resolve to one of its own drivers.
 * Reidey sends no money for them on purpose, so there is nothing to attribute
 * and nothing to import: they exist here to be NAMED, because an earner nobody
 * can be paid from is a reason to stop the import, not to skip them quietly.
 */
export interface UnmatchedEarner {
  name: string;
  uberDriverUuid: string | null;
  trips: number | null;
}

export interface EarningsBody {
  drivers: UberDriverEarnings[];
  unmatched: UnmatchedEarner[];
}

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; problem: string };

/** `"664.19"` becomes 66419; anything else is null. Never a float. */
export function parseCents(value: unknown, signed = false): number | null {
  if (typeof value !== 'string') return null;
  if (!(signed ? SIGNED_MONEY : MONEY).test(value)) return null;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return negative ? -cents : cents;
}

/** 66419 becomes "664.19": the plain decimal string the database casts once. */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Whether `iso` is a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(iso: unknown): iso is string {
  if (typeof iso !== 'string') return false;
  const m = ISO_DATE.exec(iso);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

function utcMs(iso: string): number {
  const m = ISO_DATE.exec(iso)!;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUtcMs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const DAY_MS = 86_400_000;

export function addDaysIso(iso: string, days: number): string {
  return fromUtcMs(utcMs(iso) + days * DAY_MS);
}

/** Days from `a` to `b`, positive when `b` is later. */
export function diffDaysIso(a: string, b: string): number {
  return Math.round((utcMs(b) - utcMs(a)) / DAY_MS);
}

/** The Monday of the week `iso` falls in (Monday to Sunday weeks). */
export function mondayOf(iso: string): string {
  const weekday = new Date(utcMs(iso)).getUTCDay(); // 0 = Sunday
  return addDaysIso(iso, -((weekday + 6) % 7));
}

/** A stretch of days inside ONE business week. */
export interface WeekSegment {
  from: string;
  to: string;
  /** The Monday of the business week this stretch lies in. */
  monday: string;
}

/** The widest range one import may cover. Bounds the calls the function makes. */
export const MAX_RANGE_DAYS = 31;

/**
 * Cuts `from`..`to` (inclusive) at every Sunday, so each piece lies inside one
 * business week. The first and last piece may be shorter than a week.
 *
 * The dates are calendar days, but they are NOT midnights. Uber's week runs
 * Monday 04:00 to the next Monday 04:00 (Europe/Berlin), so a segment
 * `from`..`to` means "from 04:00 on `from` until 04:00 on the day AFTER `to`".
 * The ISO dates stay as they are because Reidey takes `date_format:Y-m-d`;
 * Reidey applies the 04:00 offset on its side. This function does only
 * calendar arithmetic and knows nothing of the hour.
 */
export function splitIntoBusinessWeeks(from: string, to: string): ParseOutcome<WeekSegment[]> {
  if (!isIsoDate(from) || !isIsoDate(to)) return { ok: false, problem: 'invalid_range' };
  if (diffDaysIso(from, to) < 0) return { ok: false, problem: 'invalid_range' };
  if (diffDaysIso(from, to) + 1 > MAX_RANGE_DAYS) return { ok: false, problem: 'range_too_long' };
  const segments: WeekSegment[] = [];
  let start = from;
  while (diffDaysIso(start, to) >= 0) {
    const monday = mondayOf(start);
    const sunday = addDaysIso(monday, 6);
    const end = diffDaysIso(sunday, to) < 0 ? to : sunday;
    segments.push({ from: start, to: end, monday });
    start = addDaysIso(end, 1);
  }
  return { ok: true, value: segments };
}

/** A segment is acceptable when it is one stretch inside one business week. */
export function isWeekSegment(value: unknown): value is { from: string; to: string } {
  if (typeof value !== 'object' || value === null) return false;
  const { from, to } = value as Record<string, unknown>;
  if (!isIsoDate(from) || !isIsoDate(to)) return false;
  return diffDaysIso(from, to) >= 0 && mondayOf(from) === mondayOf(to);
}

function readDriver(raw: unknown): ParseOutcome<UberDriverEarnings> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, problem: 'driver_malformed' };
  const r = raw as Record<string, unknown>;
  if (typeof r.driver_id !== 'number' || !Number.isSafeInteger(r.driver_id) || r.driver_id <= 0) {
    return { ok: false, problem: 'driver_id_invalid' };
  }
  if (typeof r.name !== 'string') return { ok: false, problem: 'name_invalid' };
  if (r.uber_driver_uuid != null && typeof r.uber_driver_uuid !== 'string') {
    return { ok: false, problem: 'uuid_invalid' };
  }
  const fare = parseCents(r.fare);
  const promotion = parseCents(r.promotion);
  const tips = parseCents(r.tips);
  const cash = parseCents(r.cash);
  const net = parseCents(r.net_outstanding, true);
  const difference = parseCents(r.difference, true);
  if (fare === null || promotion === null || tips === null || cash === null
      || net === null || difference === null) {
    return { ok: false, problem: 'amount_invalid' };
  }
  const trips = r.trips ?? null;
  if (trips !== null && (typeof trips !== 'number' || !Number.isSafeInteger(trips) || trips < 0)) {
    return { ok: false, problem: 'trips_invalid' };
  }
  return {
    ok: true,
    value: {
      externalDriverId: String(r.driver_id),
      uberDriverUuid: (r.uber_driver_uuid as string | null | undefined) ?? null,
      name: r.name,
      fareCents: fare, promotionCents: promotion, tipsCents: tips, cashCents: cash,
      netOutstandingCents: net, trips, differenceCents: difference,
    },
  };
}

/**
 * Reads Reidey's 200 body for the range `from`..`to`. The answer must name the
 * same range and EUR; one driver that does not parse refuses the whole body,
 * because a preview with a driver quietly missing is a total that is too low.
 */
export function parseEarningsBody(
  body: unknown, from: string, to: string,
): ParseOutcome<EarningsBody> {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (typeof data !== 'object' || data === null) return { ok: false, problem: 'malformed' };
  if (data.from !== from || data.to !== to) return { ok: false, problem: 'range_mismatch' };
  if (data.currency !== 'EUR') return { ok: false, problem: 'currency_unsupported' };
  if (!Array.isArray(data.drivers)) return { ok: false, problem: 'malformed' };
  const drivers: UberDriverEarnings[] = [];
  const seen = new Set<string>();
  for (const raw of data.drivers) {
    const read = readDriver(raw);
    if (!read.ok) return read;
    if (seen.has(read.value.externalDriverId)) return { ok: false, problem: 'driver_duplicated' };
    seen.add(read.value.externalDriverId);
    drivers.push(read.value);
  }
  const unmatched = readUnmatched((body as { meta?: { unmatched?: unknown } }).meta?.unmatched);
  if (!unmatched.ok) return unmatched;
  return { ok: true, value: { drivers, unmatched: unmatched.value } };
}

/** meta.unmatched: absent means none; present must be exactly the agreed shape. */
export function readUnmatched(raw: unknown): ParseOutcome<UnmatchedEarner[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, problem: 'unmatched_invalid' };
  const out: UnmatchedEarner[] = [];
  for (const item of raw) {
    const r = item as Record<string, unknown> | null;
    const trips = r?.trips ?? null;
    if (typeof r !== 'object' || r === null || typeof r.name !== 'string' || r.name.trim() === ''
        || (r.uber_driver_uuid != null && typeof r.uber_driver_uuid !== 'string')
        || (trips !== null && (typeof trips !== 'number' || !Number.isSafeInteger(trips) || trips < 0))) {
      return { ok: false, problem: 'unmatched_invalid' };
    }
    out.push({ name: r.name, uberDriverUuid: (r.uber_driver_uuid as string | null | undefined) ?? null, trips });
  }
  return { ok: true, value: out };
}
