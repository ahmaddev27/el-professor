import { toCents } from '../money';

/**
 * The money Uber reported, read for one calendar month (Round 8, sections 4–7).
 *
 * The income table holds it in three shapes, and this module keeps them apart
 * rather than turning one into another:
 *
 * - **a daily row**: the nightly pull. `source = 'uber'` and
 *   `source_period_start = source_period_end` = the Uber operating day D, which
 *   runs from D 04:00 to D+1 04:00 Europe/Berlin. One row per driver, per type,
 *   per day. This is the only shape that supports a per-day figure.
 * - **a period row**: the manual Uber import, one Uber week (Monday to Sunday by
 *   operating day). It is reported for the whole period and **never split by
 *   day**: section 7 forbids an even split, and nothing else could be invented.
 *   A period wholly inside the month counts for the month; a period that
 *   crosses the month's first or last day counts for neither, because no
 *   source says how much of it fell on which side.
 * - **a hand-typed row**: `source IS NULL`. Its period is not stated, so it is
 *   listed apart and is never taken as an Uber figure.
 *
 * Nothing here alters an imported value. Every figure is the row's own amount
 * in integer cents; a negative amount (a refund or a clawback, which the
 * database stores for `umsatz`, `aktionen` and `trinkgeld`) is kept with its
 * sign and named. Whether `umsatz` is before or after Uber's service fee is
 * not recorded anywhere, so this module does not say either.
 */

/** A row of `public.income` as the loader selects it. */
export interface UberIncomeRow {
  id: string | number;
  type: string;
  /** Euro, as the numeric(12,2) column returns it: a number or a decimal string. */
  amount: number | string;
  date: string;
  driver_name: string | null;
  source: string | null;
  source_driver_key: string | null;
  source_period_start: string | null;
  source_period_end: string | null;
  trip_count: number | null;
}

export interface UberDriverRef {
  id: string;
  name: string;
}

/** A row of `public.partner_driver_links` for the partner the pull writes as. */
export interface UberPartnerLink {
  external_driver_id: string;
  driver_id: string | null;
  status: string;
}

export const UBER_FIGURE_TYPES = ['umsatz', 'aktionen', 'trinkgeld', 'bargeld'] as const;
export type UberFigureType = (typeof UBER_FIGURE_TYPES)[number];

/** How the row's driver was found. A name match is weaker than a link, so it is reported. */
export type UberIdentity = 'partner_link' | 'name_only';

export interface UberFigures {
  umsatzCents: number;
  aktionenCents: number;
  trinkgeldCents: number;
  bargeldCents: number;
  /** Uber's trip count, carried on the `umsatz` row only; null when no row stated one. */
  tripCount: number | null;
}

export interface UberDriverDay {
  driverId: string;
  driverName: string;
  /** The Uber operating day, YYYY-MM-DD; it is also the calendar date the month counts it on. */
  date: string;
  figures: UberFigures;
  identity: UberIdentity;
  rowIds: string[];
  /** The types whose amount on this day is below zero. */
  negativeTypes: UberFigureType[];
  /** A period row of the same driver also covers this day. Neither is used silently. */
  overlapsPeriod: boolean;
}

export type UberPeriodPlacement = 'inside_month' | 'crosses_month_boundary';

export interface UberPeriodTotal {
  driverId: string;
  driverName: string;
  periodStart: string;
  periodEnd: string;
  /** Inclusive count of operating days in the period. */
  days: number;
  placement: UberPeriodPlacement;
  figures: UberFigures;
  identity: UberIdentity;
  rowIds: string[];
  negativeTypes: UberFigureType[];
  /** Days of this period on which the same driver also has a daily row. */
  overlappingDailyDates: string[];
}

export interface UberHandRow {
  rowId: string;
  date: string;
  driverName: string | null;
  type: string;
  amountCents: number;
}

export type UberRowIssue =
  | 'driver_unresolved'
  | 'driver_ambiguous'
  | 'period_missing'
  | 'period_invalid'
  | 'amount_invalid'
  | 'type_unknown'
  | 'duplicate_row';

export interface UberIssue {
  rowId: string;
  issue: UberRowIssue;
  /** Data, not a sentence: the key or value that caused it. */
  detail: string;
}

/** Whether the month has a per-day figure for every driver Uber reported, for some, or for none. */
export type UberDailyDetail = 'available' | 'partial' | 'unavailable';

export interface UberMonthImport {
  year: number;
  month: number;
  days: UberDriverDay[];
  periods: UberPeriodTotal[];
  handRows: UberHandRow[];
  issues: UberIssue[];
  dailyDetail: UberDailyDetail;
  /** Sums over `days` only: the figures that can be attributed to a calendar day of the month. */
  dailyTotals: UberFigures;
  /** Sums over the periods wholly inside the month: attributable to the month, not to a day. */
  insidePeriodTotals: UberFigures;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function daysBetweenInclusive(start: string, end: string): number {
  const a = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
  const b = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10));
  return Math.round((b - a) / 86_400_000) + 1;
}

function isRealDate(day: string): boolean {
  if (!ISO_DATE.test(day)) return false;
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)));
  return d.toISOString().slice(0, 10) === day;
}

function datesOf(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10)));
  for (;;) {
    const iso = d.toISOString().slice(0, 10);
    if (iso > end) return out;
    out.push(iso);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

const emptyFigures = (): UberFigures => ({ umsatzCents: 0, aktionenCents: 0, trinkgeldCents: 0, bargeldCents: 0, tripCount: null });

const FIELD: Record<UberFigureType, keyof Omit<UberFigures, 'tripCount'>> = {
  umsatz: 'umsatzCents',
  aktionen: 'aktionenCents',
  trinkgeld: 'trinkgeldCents',
  bargeld: 'bargeldCents',
};

function addFigures(into: UberFigures, from: UberFigures): void {
  into.umsatzCents += from.umsatzCents;
  into.aktionenCents += from.aktionenCents;
  into.trinkgeldCents += from.trinkgeldCents;
  into.bargeldCents += from.bargeldCents;
  if (from.tripCount != null) into.tripCount = (into.tripCount ?? 0) + from.tripCount;
}

function amountCents(amount: number | string): number | null {
  try {
    return toCents(amount);
  } catch {
    return null;
  }
}

interface Resolved {
  driver: UberDriverRef;
  identity: UberIdentity;
}

/**
 * The row's driver: through the partner link first, the way both writers
 * wrote it, and by an exact name only when no link answers (a link can be
 * removed after the row was written). Two drivers of one name answer nothing.
 */
function resolverFor(drivers: readonly UberDriverRef[], links: readonly UberPartnerLink[]) {
  const byId = new Map(drivers.map(d => [d.id, d]));
  const byName = new Map<string, UberDriverRef[]>();
  for (const d of drivers) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
  const linked = new Map<string, string>();
  for (const l of links) if (l.status === 'linked' && l.driver_id) linked.set(l.external_driver_id, l.driver_id);

  return (row: UberIncomeRow): Resolved | 'unresolved' | 'ambiguous' => {
    const viaLink = row.source_driver_key ? linked.get(row.source_driver_key) : undefined;
    const linkedDriver = viaLink ? byId.get(viaLink) : undefined;
    if (linkedDriver) return { driver: linkedDriver, identity: 'partner_link' };
    const named = row.driver_name != null ? byName.get(row.driver_name) ?? [] : [];
    if (named.length === 1) return { driver: named[0], identity: 'name_only' };
    return named.length > 1 ? 'ambiguous' : 'unresolved';
  };
}

/**
 * Read one calendar month's Uber figures out of the rows the loader returned.
 * Rows outside the month (the loader reads the weeks around it) are ignored;
 * every row inside it ends up in exactly one of `days`, `periods`,
 * `handRows` or `issues`.
 */
export function readUberMonth(
  year: number,
  month: number,
  rows: readonly UberIncomeRow[],
  drivers: readonly UberDriverRef[],
  links: readonly UberPartnerLink[],
): UberMonthImport {
  const monthStart = `${year}-${pad2(month)}-01`;
  const monthEnd = `${year}-${pad2(month)}-${pad2(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
  const resolve = resolverFor(drivers, links);
  const issues: UberIssue[] = [];
  const handRows: UberHandRow[] = [];
  const dayMap = new Map<string, UberDriverDay>();
  const periodMap = new Map<string, UberPeriodTotal>();
  const seenKeys = new Set<string>();

  const ordered = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
  for (const row of ordered) {
    const rowId = String(row.id);

    if (row.source == null) {
      if (row.date >= monthStart && row.date <= monthEnd) {
        const cents = amountCents(row.amount);
        if (cents == null) issues.push({ rowId, issue: 'amount_invalid', detail: String(row.amount) });
        else handRows.push({ rowId, date: row.date, driverName: row.driver_name, type: row.type, amountCents: cents });
      }
      continue;
    }

    const start = row.source_period_start;
    const end = row.source_period_end;
    if (!start || !end) {
      if (row.date >= monthStart && row.date <= monthEnd) issues.push({ rowId, issue: 'period_missing', detail: row.date });
      continue;
    }
    if (!isRealDate(start) || !isRealDate(end) || end < start) {
      issues.push({ rowId, issue: 'period_invalid', detail: `${start}..${end}` });
      continue;
    }
    if (end < monthStart || start > monthEnd) continue;

    if (!(UBER_FIGURE_TYPES as readonly string[]).includes(row.type)) {
      issues.push({ rowId, issue: 'type_unknown', detail: row.type });
      continue;
    }
    const type = row.type as UberFigureType;
    const cents = amountCents(row.amount);
    if (cents == null) {
      issues.push({ rowId, issue: 'amount_invalid', detail: String(row.amount) });
      continue;
    }

    // The database's own unique key. A second row on it would count the same
    // Uber transaction twice (test class 18), so it is reported, not added.
    const key = `${row.source}|${row.source_driver_key ?? `name:${row.driver_name}`}|${start}|${type}`;
    if (seenKeys.has(key)) {
      issues.push({ rowId, issue: 'duplicate_row', detail: key });
      continue;
    }

    const who = resolve(row);
    if (who === 'unresolved' || who === 'ambiguous') {
      issues.push({ rowId, issue: who === 'ambiguous' ? 'driver_ambiguous' : 'driver_unresolved', detail: row.source_driver_key ?? row.driver_name ?? '' });
      continue;
    }
    seenKeys.add(key);

    const figures = emptyFigures();
    figures[FIELD[type]] = cents;
    if (type === 'umsatz' && row.trip_count != null) figures.tripCount = row.trip_count;

    if (start === end) {
      const mapKey = `${who.driver.id}|${start}`;
      const day = dayMap.get(mapKey) ?? {
        driverId: who.driver.id, driverName: who.driver.name, date: start, figures: emptyFigures(),
        identity: who.identity, rowIds: [], negativeTypes: [], overlapsPeriod: false,
      };
      addFigures(day.figures, figures);
      day.rowIds.push(rowId);
      if (who.identity === 'name_only') day.identity = 'name_only';
      if (cents < 0 && !day.negativeTypes.includes(type)) day.negativeTypes.push(type);
      dayMap.set(mapKey, day);
      continue;
    }

    const mapKey = `${who.driver.id}|${start}|${end}`;
    const period = periodMap.get(mapKey) ?? {
      driverId: who.driver.id, driverName: who.driver.name, periodStart: start, periodEnd: end,
      days: daysBetweenInclusive(start, end),
      placement: (start >= monthStart && end <= monthEnd ? 'inside_month' : 'crosses_month_boundary') as UberPeriodPlacement,
      figures: emptyFigures(), identity: who.identity, rowIds: [], negativeTypes: [], overlappingDailyDates: [],
    };
    addFigures(period.figures, figures);
    period.rowIds.push(rowId);
    if (who.identity === 'name_only') period.identity = 'name_only';
    if (cents < 0 && !period.negativeTypes.includes(type)) period.negativeTypes.push(type);
    periodMap.set(mapKey, period);
  }

  const days = [...dayMap.values()].filter(d => d.date >= monthStart && d.date <= monthEnd);
  const periods = [...periodMap.values()];
  for (const p of periods) {
    const covered = new Set(datesOf(p.periodStart, p.periodEnd));
    for (const d of days) {
      if (d.driverId === p.driverId && covered.has(d.date)) {
        d.overlapsPeriod = true;
        p.overlappingDailyDates.push(d.date);
      }
    }
    p.overlappingDailyDates.sort();
  }
  days.sort((a, b) => (a.date === b.date ? a.driverName.localeCompare(b.driverName, 'de') || a.driverId.localeCompare(b.driverId) : a.date.localeCompare(b.date)));
  periods.sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.driverName.localeCompare(b.driverName, 'de') || a.driverId.localeCompare(b.driverId));

  const dailyTotals = emptyFigures();
  for (const d of days) addFigures(dailyTotals, d.figures);
  const insidePeriodTotals = emptyFigures();
  for (const p of periods) if (p.placement === 'inside_month') addFigures(insidePeriodTotals, p.figures);

  const withDaily = new Set(days.map(d => d.driverId));
  const reported = new Set([...withDaily, ...periods.map(p => p.driverId)]);
  const onlyPeriods = [...reported].some(id => !withDaily.has(id)) || periods.length > 0;
  const dailyDetail: UberDailyDetail = withDaily.size === 0 ? 'unavailable' : onlyPeriods ? 'partial' : 'available';

  return { year, month, days, periods, handRows, issues, dailyDetail, dailyTotals, insidePeriodTotals };
}
