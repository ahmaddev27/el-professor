/**
 * Uber earnings import: the rules that turn Reidey's per-week totals into
 * `income` rows. Pure; no React, no network, no Supabase.
 *
 * The wire format is read by `supabase/functions/_shared/uber-earnings-core.ts`
 * (shared with the edge function, which refuses what does not match); this file
 * is what the screen does with the answer.
 *
 * ## The mapping is one to one, and `type` is stored data
 *
 *   fare      -> umsatz       promotion -> aktionen
 *   tips      -> trinkgeld    cash      -> bargeld
 *
 * The four words are what `income_type_check` admits and what every aggregate
 * matches; they are never translated.
 *
 * ## One row per driver, per type, per business week
 *
 * A business week belongs to the month containing its MONDAY, and the screen's
 * `Woche N` is the week's index inside that business month. `Woche N` is written
 * into `income.description` and matched back with a regex elsewhere, so it is
 * stored data and stays German in both UI languages.
 *
 * `trip_count` goes on the `umsatz` row only: `tallyTrips` counts net-fare rows,
 * so the same number on all four types would be a count the screen ignores.
 *
 * ## Which driver a row belongs to is not decided here
 *
 * The browser sends Reidey's driver id and nothing else about the person. The
 * database resolves it through `partner_driver_links` (confirmed by a human) and
 * writes OUR `drivers` row's name. A name from Reidey is display text only.
 */
import {
  centsToDecimal,
  readUnmatched,
  type UnmatchedEarner,
  isWeekSegment,
  mondayOf,
  type UberDriverEarnings,
  type WeekSegment,
} from '../../supabase/functions/_shared/uber-earnings-core';
import { getWeekNumberForDate } from './weekCalculations';

export type IncomeImportType = 'umsatz' | 'aktionen' | 'trinkgeld' | 'bargeld';

/** Order is the order rows are written and listed in. */
export const IMPORT_TYPES: ReadonlyArray<{
  type: IncomeImportType;
  field: 'fareCents' | 'promotionCents' | 'tipsCents' | 'cashCents';
}> = [
  { type: 'umsatz', field: 'fareCents' },
  { type: 'aktionen', field: 'promotionCents' },
  { type: 'trinkgeld', field: 'tipsCents' },
  { type: 'bargeld', field: 'cashCents' },
];

/** Written to `income.source`; part of the unique index that refuses a re-import. */
export const UBER_SOURCE = 'uber';

export interface WeekEarnings {
  segment: WeekSegment;
  drivers: UberDriverEarnings[];
}

/** Our driver a partner driver is confirmed to be, keyed by external id. */
export type DriverLinks = Readonly<Record<string, { driverId: string; driverName: string }>>;

/** One element of the `p_rows` array `income_import_uber` takes. */
export interface IncomeImportRow {
  external_driver_id: string;
  type: IncomeImportType;
  /** A plain decimal string; the database casts it once. */
  amount: string;
  date: string;
  week: number;
  description: string;
  trip_count: number | null;
  period_start: string;
  period_end: string;
}

function localDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** `Woche N`, the screen's own week index (1-based within the business month). */
export function weekNumberOf(segment: WeekSegment): number {
  return getWeekNumberForDate(localDate(segment.monday));
}

/** The text written to `income.description`; `Woche \d+` must stay first. */
export function importDescription(week: number): string {
  return `Woche ${week} - Uber`;
}

function rowsForDriver(
  driver: UberDriverEarnings, segment: WeekSegment, week: number,
): IncomeImportRow[] {
  const rows: IncomeImportRow[] = [];
  for (const { type, field } of IMPORT_TYPES) {
    const cents = driver[field];
    const tripsOnly = type === 'umsatz' && cents === 0 && (driver.trips ?? 0) > 0;
    if (cents <= 0 && !tripsOnly) continue;
    rows.push({
      external_driver_id: driver.externalDriverId,
      type,
      amount: centsToDecimal(cents),
      date: segment.from,
      week,
      description: importDescription(week),
      trip_count: type === 'umsatz' ? driver.trips : null,
      period_start: segment.from,
      period_end: segment.to,
    });
  }
  return rows;
}

/** Every row the import would write. A zero amount is not a row. */
export function buildImportRows(weeks: readonly WeekEarnings[]): IncomeImportRow[] {
  return weeks.flatMap(({ segment, drivers }) => {
    const week = weekNumberOf(segment);
    return drivers.flatMap(driver => rowsForDriver(driver, segment, week));
  });
}

export interface UnlinkedDriver {
  externalDriverId: string;
  /** Reidey's spelling, to tell the operator who to link. Display only. */
  name: string;
}

/** Drivers that would produce a row but have no confirmed link, once each. */
export function findUnlinked(
  weeks: readonly WeekEarnings[], links: DriverLinks,
): UnlinkedDriver[] {
  const found = new Map<string, UnlinkedDriver>();
  for (const { segment, drivers } of weeks) {
    for (const driver of drivers) {
      if (links[driver.externalDriverId]) continue;
      if (rowsForDriver(driver, segment, 1).length === 0) continue;
      found.set(driver.externalDriverId, {
        externalDriverId: driver.externalDriverId, name: driver.name,
      });
    }
  }
  return [...found.values()];
}

export interface DriverPreview {
  externalDriverId: string;
  /** Reidey's spelling. */
  uberName: string;
  /** Our driver's name when linked; this is what would be stored. */
  ourName: string | null;
  fareCents: number;
  promotionCents: number;
  tipsCents: number;
  cashCents: number;
  trips: number | null;
  /** Sum over the weeks. */
  differenceCents: number;
  /** Any single week non-zero: a sum can cancel two weeks that do not. */
  hasDifference: boolean;
  rowCount: number;
}

/** One line per driver across the whole range, for the preview table. */
export function summarizeByDriver(
  weeks: readonly WeekEarnings[], links: DriverLinks,
): DriverPreview[] {
  const byDriver = new Map<string, DriverPreview>();
  for (const { segment, drivers } of weeks) {
    for (const d of drivers) {
      const row = byDriver.get(d.externalDriverId) ?? {
        externalDriverId: d.externalDriverId, uberName: d.name,
        ourName: links[d.externalDriverId]?.driverName ?? null,
        fareCents: 0, promotionCents: 0, tipsCents: 0, cashCents: 0,
        trips: null, differenceCents: 0, hasDifference: false, rowCount: 0,
      };
      row.fareCents += d.fareCents;
      row.promotionCents += d.promotionCents;
      row.tipsCents += d.tipsCents;
      row.cashCents += d.cashCents;
      if (d.trips !== null) row.trips = (row.trips ?? 0) + d.trips;
      row.differenceCents += d.differenceCents;
      row.hasDifference = row.hasDifference || d.differenceCents !== 0;
      row.rowCount += rowsForDriver(d, segment, 1).length;
      byDriver.set(d.externalDriverId, row);
    }
  }
  return [...byDriver.values()];
}

const CENT_FIELDS = [
  'fareCents', 'promotionCents', 'tipsCents', 'cashCents', 'netOutstandingCents', 'differenceCents',
] as const;

function isDriverShape(d: unknown): d is UberDriverEarnings {
  if (typeof d !== 'object' || d === null) return false;
  const r = d as Record<string, unknown>;
  return typeof r.externalDriverId === 'string' && /^[0-9]+$/.test(r.externalDriverId)
    && typeof r.name === 'string'
    && CENT_FIELDS.every(f => Number.isSafeInteger(r[f]))
    && [r.fareCents, r.promotionCents, r.tipsCents, r.cashCents].every(v => (v as number) >= 0)
    && (r.trips === null || (Number.isSafeInteger(r.trips) && (r.trips as number) >= 0));
}

/**
 * Reads the edge function's answer. Anything that is not exactly the shape it
 * sends is null, so the screen shows its error state rather than a table with a
 * NaN in it: a figure whose load failed is not shown.
 */
export function readPullAnswer(
  data: unknown,
): { weeks: WeekEarnings[]; links: DriverLinks; unmatched: UnmatchedEarner[] } | null {
  const answer = data as { ok?: unknown; weeks?: unknown; links?: unknown } | null;
  if (!answer || answer.ok !== true || !Array.isArray(answer.weeks)) return null;
  if (typeof answer.links !== 'object' || answer.links === null) return null;
  const weeks: WeekEarnings[] = [];
  for (const raw of answer.weeks as unknown[]) {
    const w = raw as { from: string; to: string; monday?: unknown; drivers?: unknown } | null;
    if (!w || !isWeekSegment(w)) return null;
    if (typeof w.monday !== 'string' || mondayOf(w.from) !== w.monday) return null;
    if (!Array.isArray(w.drivers) || !w.drivers.every(isDriverShape)) return null;
    weeks.push({
      segment: { from: w.from, to: w.to, monday: w.monday },
      drivers: w.drivers as UberDriverEarnings[],
    });
  }
  const links: Record<string, { driverId: string; driverName: string }> = {};
  for (const [key, value] of Object.entries(answer.links as Record<string, unknown>)) {
    const link = value as { driverId?: unknown; driverName?: unknown };
    if (typeof link?.driverId !== 'string' || typeof link?.driverName !== 'string') return null;
    links[key] = { driverId: link.driverId, driverName: link.driverName };
  }
  const unmatched = readUnmatched((answer as { unmatched?: unknown }).unmatched);
  if (!unmatched.ok) return null;
  return { weeks, links, unmatched: unmatched.value };
}

/** One name the operator must resolve before the import can run. */
export interface BlockingEarner {
  name: string;
  /** Reidey cannot place the Uber earner, or we have not linked the Reidey driver. */
  kind: 'unmatched_at_reidey' | 'unlinked_here';
  /** Reidey's driver id, for the second kind. */
  externalDriverId: string | null;
}

/** Every earner that stops the import, from both causes, named. */
export function blockingEarners(
  unlinked: readonly UnlinkedDriver[], unmatched: readonly UnmatchedEarner[],
): BlockingEarner[] {
  return [
    ...unmatched.map(u => ({ name: u.name, kind: 'unmatched_at_reidey' as const, externalDriverId: null })),
    ...unlinked.map(u => ({ name: u.name, kind: 'unlinked_here' as const, externalDriverId: u.externalDriverId })),
  ];
}

/** An income row already in the table, as far as the preview needs it. */
export interface ExistingIncome {
  driver_name: string;
  date: string;
  type: string;
  amount: number;
  source: string | null;
  source_period_start: string | null;
  source_period_end: string | null;
}

export interface ExistingInWeek {
  /** OUR driver's name: the text income rows are joined on. */
  driverName: string;
  segment: WeekSegment;
  manualCount: number;
  importedCount: number;
}

/**
 * Income that already stands for a driver and a business week this import would
 * write, WHATEVER its source. Two different things come out and must never be
 * confused, because a driver's pay rides on the difference:
 *
 * - `manualCount`: rows somebody typed. The import does not refuse them; both
 *   sets stand and every figure becomes their sum. A warning, not a block.
 * - `importedCount`: rows of an earlier import whose days overlap. The database
 *   refuses these (`already_imported`); the preview says so before the click.
 *
 * Matching is the product's own: the stored `driver_name` against OUR driver's
 * name with `===`, since `income` has no driver_id.
 */
export function findExistingIncome(
  weeks: readonly WeekEarnings[], links: DriverLinks, existing: readonly ExistingIncome[],
): ExistingInWeek[] {
  const found: ExistingInWeek[] = [];
  for (const { segment, drivers } of weeks) {
    for (const d of drivers) {
      const link = links[d.externalDriverId];
      if (!link || rowsForDriver(d, segment, 1).length === 0) continue;
      let manualCount = 0;
      let importedCount = 0;
      for (const row of existing) {
        if (row.driver_name !== link.driverName) continue;
        if (row.source === UBER_SOURCE) {
          const start = row.source_period_start ?? row.date;
          const end = row.source_period_end ?? row.date;
          if (start <= segment.to && end >= segment.from) importedCount += 1;
        } else if (row.date >= segment.from && row.date <= segment.to) {
          manualCount += 1;
        }
      }
      if (manualCount + importedCount > 0) {
        found.push({ driverName: link.driverName, segment, manualCount, importedCount });
      }
    }
  }
  return found;
}
