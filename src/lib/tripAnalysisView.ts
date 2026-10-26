/**
 * What the Fahrtenanalyse screen shows, derived from the engine's result.
 *
 * Pure functions only: no database, no React, no clock. The engine
 * (src/utils/tripAnalysis) decides every finding; this module only arranges
 * its answer for a table, a timeline and a filter, and prepares the two
 * inputs the engine takes from the company — the settings and the budgets.
 *
 * Nothing here changes a trip. Every trip shown is the engine's `trip`, which
 * is the object the loader handed in.
 */
import type {
  AnalysisShift,
  AnalysisTrip,
  BudgetInput,
  DriverAnalysis,
  Issue,
  IssueSeverity,
  IssueStatus,
  IssueType,
  PriceTotal,
  TripAnalysisResult,
  TripAnalysisSettings,
} from '../utils/tripAnalysis/types';
import { isDeactivatedDriver } from '../utils/driverStatus';
import { berlinWallClockToInstant } from './tripAnalysisShifts';

// ── Settings ──────────────────────────────────────────────────────────────────

/**
 * The value used when the owner has not decided and chooses to look anyway.
 * Never stored, and every place it is used says "Testwert".
 */
export const TEST_DEFAULT_MINUTES = 30;

/** `trip_analysis_settings` as the screen reads it. */
export interface SettingsRow {
  id: string;
  block_gap_minutes: number | null;
  travel_margin_minutes: number | null;
  updated_at: string | null;
  /** The Betriebssitz (20261008200000). Optional so a row from before that migration still types. */
  base_latitude?: number | string | null;
  base_longitude?: number | string | null;
  base_radius_km?: number | string | null;
}

export type SettingSource = 'stored' | 'test_default' | 'missing';

export interface EffectiveSetting {
  value: number | null;
  source: SettingSource;
}

export interface EffectiveSettings {
  blockGap: EffectiveSetting;
  travelMargin: EffectiveSetting;
  /** What the engine is given, or null while a value is missing. */
  settings: TripAnalysisSettings | null;
  /** True when at least one value is the test default. */
  usesTestDefault: boolean;
}

function effective(stored: number | null | undefined, useTestDefault: boolean): EffectiveSetting {
  if (typeof stored === 'number' && Number.isFinite(stored)) return { value: stored, source: 'stored' };
  if (useTestDefault) return { value: TEST_DEFAULT_MINUTES, source: 'test_default' };
  return { value: null, source: 'missing' };
}

/**
 * The settings the analysis runs with. A value the owner has not set stays
 * missing — and the analysis does not run — unless the viewer chose the test
 * value for this look.
 */
export function effectiveSettings(row: SettingsRow | null, useTestDefault: boolean): EffectiveSettings {
  const blockGap = effective(row?.block_gap_minutes, useTestDefault);
  const travelMargin = effective(row?.travel_margin_minutes, useTestDefault);
  const settings =
    blockGap.value !== null && travelMargin.value !== null
      ? { blockGapMinutes: blockGap.value, travelMarginMinutes: travelMargin.value }
      : null;
  return {
    blockGap,
    travelMargin,
    settings,
    usesTestDefault: blockGap.source === 'test_default' || travelMargin.source === 'test_default',
  };
}

// ── Budgets ───────────────────────────────────────────────────────────────────

/** A company driver, with the pay figures the budget is derived from. */
export interface CompanyDriver {
  id: string;
  name: string;
  status: string | null;
  planning_min_salary: number | string | null;
  planning_max_salary: number | string | null;
  planning_hourly_rate: number | string | null;
}

/** `driver_month_budget` as the screen reads it. */
export interface BudgetRow {
  id: string;
  driver_id: string;
  year: number;
  month: number;
  reserved_hours: number | string | null;
  planning_min_salary: number | string | null;
  planning_max_salary: number | string | null;
  planning_hourly_rate: number | string | null;
  confirmed_at: string | null;
  confirmed_by: string | null;
  recompute_log: unknown;
}

/**
 *   not_confirmed   no row, or a row nobody confirmed: the driver's current
 *                   figures are used, and the screen says so
 *   confirmed       the snapshot is used, and matches the driver today
 *   inputs_changed  the snapshot is used, and the driver's figures have moved
 *                   since: the owner may recompute, explicitly
 */
export type BudgetState = 'not_confirmed' | 'confirmed' | 'inputs_changed';

const sameAmount = (a: number | string | null, b: number | string | null) => {
  if (a === null || a === '' || b === null || b === '') return (a === null || a === '') === (b === null || b === '');
  return Number(a) === Number(b);
};

export function budgetState(driver: CompanyDriver | undefined, row: BudgetRow | undefined): BudgetState {
  if (!row?.confirmed_at) return 'not_confirmed';
  if (!driver) return 'confirmed';
  const same =
    sameAmount(driver.planning_min_salary, row.planning_min_salary) &&
    sameAmount(driver.planning_max_salary, row.planning_max_salary) &&
    sameAmount(driver.planning_hourly_rate, row.planning_hourly_rate);
  return same ? 'confirmed' : 'inputs_changed';
}

/** The figures the budget of one driver and month is computed from. */
export function budgetInputFor(driver: CompanyDriver, row: BudgetRow | undefined): BudgetInput {
  const confirmed = Boolean(row?.confirmed_at);
  return {
    salaryMin: confirmed ? row!.planning_min_salary : driver.planning_min_salary,
    salaryMax: confirmed ? row!.planning_max_salary : driver.planning_max_salary,
    hourlyRate: confirmed ? row!.planning_hourly_rate : driver.planning_hourly_rate,
    // Missing is "not set", never 0.
    reservedHours: row?.reserved_hours ?? null,
  };
}

/** Budget inputs for every company driver, by driver id. */
export function budgetInputs(drivers: readonly CompanyDriver[], rows: readonly BudgetRow[]): Record<string, BudgetInput> {
  const byDriver = new Map(rows.map(row => [row.driver_id, row]));
  return Object.fromEntries(drivers.map(driver => [driver.id, budgetInputFor(driver, byDriver.get(driver.id))]));
}

/** One entry of `recompute_log`, as the database writes it. */
export interface RecomputeLogEntry {
  kind: 'recompute' | 'reserve';
  at: string;
  by: string | null;
}

export function recomputeLog(row: BudgetRow | undefined): RecomputeLogEntry[] {
  if (!row || !Array.isArray(row.recompute_log)) return [];
  return row.recompute_log.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const { kind, at, by } = entry as Record<string, unknown>;
    if ((kind !== 'recompute' && kind !== 'reserve') || typeof at !== 'string') return [];
    return [{ kind, at, by: typeof by === 'string' ? by : null }];
  });
}

// ── Drivers ───────────────────────────────────────────────────────────────────

const MS_PER_HOUR = 3_600_000;

export interface DriverTableRow {
  driverId: string;
  name: string;
  /** The id is one of the company's drivers. */
  linked: boolean;
  /**
   * The linked driver is deactivated.
   *
   * The row stays — this table reports an import that already happened, and
   * dropping it would both hide rides that were driven and make the driver read
   * as `unlinked`, a finding of fact that is not one. The table marks the name
   * instead. False for a driver the import never matched to the company.
   */
  deactivated: boolean;
  budgetState: BudgetState;
  salaryMin: number | string | null;
  salaryMax: number | string | null;
  hourlyRate: number | string | null;
  hoursMin: number | null;
  hoursMax: number | null;
  /** Null: not set. */
  reservedHours: number | null;
  capHours: number | null;
  /** Union of the recorded shifts, in hours; null without shift records. */
  shiftHours: number | null;
  /** Union of the analysed trips, in hours. */
  activityHours: number;
  /** Minutes over hoursMax; 0 when within; null when the budget cannot be computed. */
  overByMinutes: number | null;
  /** Minutes left below hoursMax; 0 when over; null when the budget cannot be computed. */
  remainingMinutes: number | null;
  /** Fares of completed trips, by currency. Not a salary cost. */
  fares: PriceTotal[];
  /** Cancellation fees, by currency. */
  cancellationFees: PriceTotal[];
  tripCount: number;
  analysedCount: number;
  conflictCount: number;
  unverifiableCount: number;
}

function numberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The driver's findings by status, from the result's issue list. */
function issueCounts(driver: DriverAnalysis, issuesById: Map<string, Issue>) {
  let conflict = 0;
  let unverifiable = 0;
  for (const id of driver.issueIds) {
    const issue = issuesById.get(id);
    if (issue?.status === 'conflict') conflict += 1;
    if (issue?.status === 'unverifiable') unverifiable += 1;
  }
  return { conflict, unverifiable };
}

export function driverTableRows(
  result: TripAnalysisResult,
  drivers: readonly CompanyDriver[],
  budgetRows: readonly BudgetRow[],
): DriverTableRow[] {
  const companyDrivers = new Map(drivers.map(driver => [driver.id, driver]));
  const budgetByDriver = new Map(budgetRows.map(row => [row.driver_id, row]));
  const issuesById = new Map(result.issues.map(issue => [issue.id, issue]));

  return result.drivers
    // Only drivers seen in the trips: a company driver with neither trips nor
    // shifts has nothing to explain this month.
    .filter(driver => driver.tripIds.length > 0 || driver.shiftIds.length > 0)
    .map(driver => {
      const company = companyDrivers.get(driver.driverId);
      const row = budgetByDriver.get(driver.driverId);
      const input = company ? budgetInputFor(company, row) : null;
      const budget = driver.budget;
      const comparison = driver.budgetComparison;
      const counts = issueCounts(driver, issuesById);
      const over = comparison ? comparison.activityVsMaxMinutes : null;
      return {
        driverId: driver.driverId,
        name: company?.name ?? driver.driverNames[0] ?? driver.driverId,
        linked: Boolean(company),
        deactivated: company ? isDeactivatedDriver(company) : false,
        budgetState: budgetState(company, row),
        salaryMin: input?.salaryMin ?? null,
        salaryMax: input?.salaryMax ?? null,
        hourlyRate: input?.hourlyRate ?? null,
        hoursMin: budget?.hoursMin ?? null,
        hoursMax: budget?.hoursMax ?? null,
        reservedHours: numberOrNull(row?.reserved_hours),
        capHours: budget?.capHours ?? null,
        shiftHours: driver.shiftUnionMs === null ? null : driver.shiftUnionMs / MS_PER_HOUR,
        activityHours: driver.metrics.unionMs / MS_PER_HOUR,
        overByMinutes: over === null ? null : Math.max(0, over),
        remainingMinutes: over === null ? null : Math.max(0, -over),
        fares: driver.prices.totals.filter(total => total.status === 'completed'),
        cancellationFees: driver.prices.totals.filter(total => total.status === 'cancelled' && total.totalCents !== 0),
        tripCount: driver.tripIds.length,
        analysedCount: driver.analysedTripIds.length,
        conflictCount: counts.conflict,
        unverifiableCount: counts.unverifiable,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

/**
 * Fare totals over every driver the analysis knows, by currency: the engine's
 * own per-driver sums, added. Rows without a driver id belong to no driver and
 * are not in it; the screen names them beside the total (unlinkedDrivers).
 */
export function fareTotals(result: TripAnalysisResult, status: 'completed' | 'cancelled' = 'completed'): PriceTotal[] {
  const byCurrency = new Map<string | null, PriceTotal>();
  for (const driver of result.drivers) {
    for (const total of driver.prices.totals) {
      if (total.status !== status) continue;
      const seen = byCurrency.get(total.currency);
      byCurrency.set(total.currency, {
        currency: total.currency,
        status,
        totalCents: (seen?.totalCents ?? 0) + total.totalCents,
        tripCount: (seen?.tripCount ?? 0) + total.tripCount,
      });
    }
  }
  return [...byCurrency.values()].sort((a, b) => String(a.currency).localeCompare(String(b.currency)));
}

// ── Unlinked drivers ──────────────────────────────────────────────────────────

export interface UnlinkedDriver {
  /** The name as the file spells it. */
  name: string;
  /** Null: the trips carry no driver id at all. Set: an id that is not one of the company's drivers. */
  driverId: string | null;
  tripIds: string[];
}

/**
 * Trips whose driver the analysis cannot place: no driver id at all (the
 * import could not match the name), or an id that is not among the company's
 * drivers. Grouped by name, sorted by name.
 */
export function unlinkedDrivers(trips: readonly AnalysisTrip[], drivers: readonly CompanyDriver[]): UnlinkedDriver[] {
  const known = new Set(drivers.map(driver => driver.id));
  const groups = new Map<string, UnlinkedDriver>();
  for (const trip of trips) {
    if (trip.driver_id !== null && known.has(trip.driver_id)) continue;
    const name = trip.driver_name?.trim() || '';
    const key = `${trip.driver_id ?? ''}|${name}`;
    const group = groups.get(key) ?? { name, driverId: trip.driver_id, tripIds: [] };
    group.tripIds.push(trip.id);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'de') || String(a.driverId).localeCompare(String(b.driverId)));
}

// ── Issues ────────────────────────────────────────────────────────────────────

export interface IssueFilter {
  type: IssueType | 'all';
  severity: IssueSeverity | 'all';
  status: IssueStatus | 'all';
  driverId?: string | null;
}

export function filterIssues(issues: readonly Issue[], filter: IssueFilter): Issue[] {
  return issues.filter(
    issue =>
      (filter.type === 'all' || issue.type === filter.type) &&
      (filter.severity === 'all' || issue.severity === filter.severity) &&
      (filter.status === 'all' || issue.status === filter.status) &&
      (!filter.driverId || issue.driverId === filter.driverId),
  );
}

/** How many findings of each status there are, for the filter's counts. */
export function issueStatusCounts(issues: readonly Issue[]): Record<IssueStatus, number> {
  const counts: Record<IssueStatus, number> = { passed: 0, conflict: 0, unverifiable: 0 };
  for (const issue of issues) counts[issue.status] += 1;
  return counts;
}

/** The types that occur, in the result's order, for the type filter. */
export function issueTypesPresent(issues: readonly Issue[]): IssueType[] {
  return [...new Set(issues.map(issue => issue.type))];
}

// ── Time on the Berlin clock ──────────────────────────────────────────────────

const BERLIN = 'Europe/Berlin';
let dateTimeFormat: Intl.DateTimeFormat | null = null;
let timeFormat: Intl.DateTimeFormat | null = null;
let keyFormat: Intl.DateTimeFormat | null = null;

/** `03.08.2026, 08:15`, on the Berlin clock whatever the browser's zone is. */
export function formatBerlinDateTime(ms: number | null): string {
  if (ms === null) return '';
  dateTimeFormat ??= new Intl.DateTimeFormat('de-DE', {
    timeZone: BERLIN, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return dateTimeFormat.format(new Date(ms));
}

/** `08:15:30`, on the Berlin clock. */
export function formatBerlinTime(ms: number | null): string {
  if (ms === null) return '';
  timeFormat ??= new Intl.DateTimeFormat('de-DE', { timeZone: BERLIN, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return timeFormat.format(new Date(ms));
}

/** The Berlin calendar day of an instant, `YYYY-MM-DD`. */
export function berlinDateKey(ms: number): string {
  keyFormat ??= new Intl.DateTimeFormat('en-CA', { timeZone: BERLIN, year: 'numeric', month: '2-digit', day: '2-digit' });
  return keyFormat.format(new Date(ms));
}

/** The instant a Berlin calendar day starts, and the next one. */
export function berlinDayBounds(dateKey: string): { startMs: number; endMs: number } {
  const [year, month, day] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    startMs: berlinWallClockToInstant(year, month, day, 0, 0).ms,
    endMs: berlinWallClockToInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0).ms,
  };
}

// ── The driver's timeline ─────────────────────────────────────────────────────

export type TimelineLane = 'shift' | 'trip' | 'block' | 'issue';

export interface TimelineSegment {
  lane: TimelineLane;
  /** Share of the day, 0 to 1. A DST day is 23 or 25 hours long, and the share is of that. */
  from: number;
  to: number;
  /** The part of the item on this day, as instants. */
  startMs: number;
  endMs: number;
  /** The trip, shift, block or issue it stands for. */
  refId: string;
  /** For an issue: its status, which picks the marker. */
  status?: IssueStatus;
  /** True when the item runs on from the day before or into the next. */
  clippedStart: boolean;
  clippedEnd: boolean;
}

export interface TimelineDay {
  dateKey: string;
  segments: TimelineSegment[];
}

interface Span {
  lane: TimelineLane;
  startMs: number;
  endMs: number;
  refId: string;
  status?: IssueStatus;
}

/**
 * A finding's marks on the clock: **one per piece of evidence**, at exactly
 * that trip's or shift's interval.
 *
 * Not one span from the first start to the last end, which is what this did
 * first: a finding about the whole month (no shift records, a budget that
 * cannot be computed) cites every trip of the driver, and the span between the
 * first and the last of them painted every day in between — including days on
 * which nothing happened, which then appeared on the timeline at all.
 *
 * A finding that cites *every* analysed trip of the driver is a statement
 * about the month rather than about a moment, and gets no mark: the findings
 * list carries it, and a mark on each of sixty rides says nothing.
 */
function issueSpans(
  issue: Issue,
  analysedIds: ReadonlySet<string>,
  trips: Map<string, AnalysisTrip>,
  shifts: Map<string, AnalysisShift>,
): Span[] {
  const citesEveryTrip =
    analysedIds.size > 1 &&
    issue.tripIds.length >= analysedIds.size &&
    [...analysedIds].every(id => issue.tripIds.includes(id));
  if (citesEveryTrip) return [];

  const spans: Span[] = [];
  for (const id of issue.tripIds) {
    const trip = trips.get(id);
    if (trip?.start_ms == null) continue;
    spans.push({
      lane: 'issue',
      startMs: trip.start_ms,
      endMs: Math.max(trip.end_ms ?? trip.start_ms, trip.start_ms),
      refId: issue.id,
      status: issue.status,
    });
  }
  for (const id of issue.shiftIds ?? []) {
    const shift = shifts.get(id);
    if (!shift) continue;
    spans.push({ lane: 'issue', startMs: shift.start_ms, endMs: Math.max(shift.end_ms, shift.start_ms), refId: issue.id, status: issue.status });
  }
  return spans;
}

/**
 * One row per Berlin calendar day on which the driver has a trip, a shift, a
 * block or a finding, each item cut at midnight into the days it touches. A
 * trip across midnight appears on both days, marked as continuing.
 */
export function driverTimeline(
  result: TripAnalysisResult,
  driverId: string,
  shifts: readonly AnalysisShift[],
): TimelineDay[] {
  const driver = result.drivers.find(candidate => candidate.driverId === driverId);
  if (!driver) return [];

  const trips = new Map(result.trips.map(analyzed => [analyzed.trip.id, analyzed.trip]));
  const driverShifts = shifts.filter(shift => shift.driver_id === driverId);
  const shiftsById = new Map(driverShifts.map(shift => [shift.id, shift]));
  const spans: Span[] = [];

  for (const shift of driverShifts) {
    if (shift.end_ms > shift.start_ms) spans.push({ lane: 'shift', startMs: shift.start_ms, endMs: shift.end_ms, refId: shift.id });
  }
  for (const id of driver.analysedTripIds) {
    const trip = trips.get(id);
    if (trip?.start_ms == null || trip.end_ms == null) continue;
    spans.push({ lane: 'trip', startMs: trip.start_ms, endMs: trip.end_ms, refId: id });
  }
  for (const block of result.blocks) {
    if (block.driverId === driverId) spans.push({ lane: 'block', startMs: block.startMs, endMs: block.endMs, refId: block.id });
  }
  const analysedIds = new Set(driver.analysedTripIds);
  for (const issue of result.issues.filter(issue => issue.driverId === driverId)) {
    spans.push(...issueSpans(issue, analysedIds, trips, shiftsById));
  }

  const days = new Map<string, TimelineSegment[]>();
  for (const span of spans) {
    // A zero-length item still gets a mark on its day.
    let cursor = span.startMs;
    const last = Math.max(span.endMs, span.startMs);
    for (;;) {
      const key = berlinDateKey(cursor);
      const bounds = berlinDayBounds(key);
      const length = bounds.endMs - bounds.startMs;
      const segmentEnd = Math.min(last, bounds.endMs);
      const list = days.get(key) ?? [];
      list.push({
        lane: span.lane,
        from: (cursor - bounds.startMs) / length,
        to: (segmentEnd - bounds.startMs) / length,
        startMs: cursor,
        endMs: segmentEnd,
        refId: span.refId,
        status: span.status,
        clippedStart: cursor > span.startMs,
        clippedEnd: segmentEnd < last,
      });
      days.set(key, list);
      if (last <= bounds.endMs) break;
      cursor = bounds.endMs;
    }
  }

  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dateKey, segments]) => ({ dateKey, segments }));
}
