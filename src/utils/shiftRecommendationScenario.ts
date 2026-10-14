/**
 * The scenario around a shift plan: a trip-count cross-check, the rides, tips
 * and cash a plan is expected to carry, and the plan folded into one row per
 * vehicle and operating day.
 *
 * ## What each input does, and what it deliberately does not
 *
 * - **The plan is built from revenue, nothing here changes it.** Every function
 *   takes the plan as it is and derives figures beside it.
 * - **Cancellation share** changes the expected number of completed rides only.
 *   The profile learns from completed rides, so the expected revenue is already
 *   net of cancellations; subtracting them again from the revenue would count
 *   them twice. The measured share is the one the revenue already reflects, so
 *   `ridesFactor` is 1 at the measured value and moves only when the operator
 *   overrides it.
 * - **Tip share** yields a tip volume of its own. Trinkgeld is pass-through and
 *   never counts toward company profit, so it is never added to a revenue.
 * - **Cash share** yields the cash expected to pass through the hands of the
 *   drivers (the fare paid in cash, which the weekly Abrechnung settles). No
 *   revenue moves. A tip is not part of it: the import stores a tip beside the
 *   fare, not inside it.
 *
 * No ride is produced. A row is a vehicle, a day and counts; this is the
 * screens layer only and nothing here is read by `utils/shiftRecommendation/`.
 */
import type { ExportOptions } from './excelExport';
import type { ShiftRecommendation } from './shiftRecommendation';
import type { ReferenceStats } from './shiftRecommendationReference';
import { parseGermanAmountToCents } from './money';

// ── Reading the inputs ──────────────────────────────────────────────────────

/** A share typed as a percentage ("12,5"): 0–1, or null for anything else. Blank is not a share. */
export function parseShareText(text: string): number | null {
  const trimmed = text.trim().replace(/\s*%$/, '');
  if (trimmed === '') return null;
  const cents = parseGermanAmountToCents(trimmed);
  if (cents === null || cents < 0 || cents > 10000) return null;
  return cents / 10000;
}

/** A trip count: a whole number of at least 1, or null. */
export function parseTripCountText(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,7}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 ? value : null;
}

/** 0.1234 becomes '12,3' (the text a field starts with); '' without a value. */
export function shareToText(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return '';
  return (Math.round(share * 1000) / 10).toFixed(1).replace('.', ',');
}

/** Mean fare of a completed ride in the chosen months, integer cents; null without one. */
export function averageFareCents(stats: ReferenceStats | null): number | null {
  if (!stats || stats.completedRows === 0) return null;
  return Math.round(stats.fareCents / stats.completedRows);
}

// ── The scenario ────────────────────────────────────────────────────────────

export interface Scenario {
  /** Measured; the basis of every rides figure. */
  readonly averageFareCents: number | null;
  /** The share the history shows; the one the plan revenue already reflects. */
  readonly measuredCancellationShare: number | null;
  /** What the operator entered (the measured value unless overridden). */
  readonly cancellationShare: number | null;
  readonly tipShare: number | null;
  readonly cashShare: number | null;
  /** The trip count to cross-check; null = none given. */
  readonly targetTrips: number | null;
}

/**
 * Completed rides per euro of expected revenue, relative to the history.
 * 1 at the measured cancellation share: the revenue is net of it already.
 */
export function ridesFactor(scenario: Scenario): number {
  const { cancellationShare: entered, measuredCancellationShare: measured } = scenario;
  if (entered === null || measured === null || entered >= 1 || measured >= 1) return 1;
  return (1 - entered) / (1 - measured);
}

export function expectedRidesFor(revenueCents: number, scenario: Scenario): number | null {
  if (scenario.averageFareCents === null || scenario.averageFareCents <= 0) return null;
  return Math.round((revenueCents / scenario.averageFareCents) * ridesFactor(scenario));
}

function shareOf(revenueCents: number, share: number | null): number | null {
  return share === null ? null : Math.round(revenueCents * share);
}

// ── The trip-count cross-check ──────────────────────────────────────────────

/** A disagreement at or above this share of the revenue is said out loud. */
export const CROSS_CHECK_MATERIAL_SHARE = 0.1;

export interface TripCrossCheck {
  readonly targetTrips: number;
  /** trips x the measured mean fare, integer cents. */
  readonly impliedRevenueCents: number;
  readonly referenceRevenueCents: number;
  /** implied minus reference: positive when the trip count asks for more than the revenue. */
  readonly differenceCents: number;
  /** difference / reference, signed; null when the reference is 0. */
  readonly differenceShare: number | null;
  readonly material: boolean;
}

export function tripCrossCheck(scenario: Scenario, referenceRevenueCents: number): TripCrossCheck | null {
  if (scenario.targetTrips === null || scenario.averageFareCents === null) return null;
  const implied = scenario.targetTrips * scenario.averageFareCents;
  const difference = implied - referenceRevenueCents;
  const share = referenceRevenueCents > 0 ? difference / referenceRevenueCents : null;
  return {
    targetTrips: scenario.targetTrips,
    impliedRevenueCents: implied,
    referenceRevenueCents,
    differenceCents: difference,
    differenceShare: share,
    material: share === null ? difference !== 0 : Math.abs(share) >= CROSS_CHECK_MATERIAL_SHARE,
  };
}

// ── One row per vehicle and operating day ───────────────────────────────────

export interface DailyVehicleRow {
  readonly id: string;
  /** The operating day, 'YYYY-MM-DD'. */
  readonly date: string;
  readonly dayType: number;
  readonly isHoliday: boolean;
  readonly vehicle: string;
  readonly shifts: number;
  readonly minutes: number;
  readonly expectedRevenueCents: number;
  /** null without a measured mean fare. */
  readonly expectedRides: number | null;
  /** null when no tip share is set. Never part of the revenue. */
  readonly expectedTipCents: number | null;
  /** null when no cash share is set. */
  readonly expectedCashCents: number | null;
}

export interface DailyTotals {
  readonly shifts: number;
  readonly minutes: number;
  readonly expectedRevenueCents: number;
  readonly expectedRides: number | null;
  readonly expectedTipCents: number | null;
  readonly expectedCashCents: number | null;
}

export interface DailyVehicleTable {
  readonly rows: readonly DailyVehicleRow[];
  readonly totals: DailyTotals;
}

/**
 * Splits `total` over `weights` in whole units, so the parts add up to `total`
 * exactly: floors first, then the leftover units go to the largest remainders
 * (earlier rows win a tie). A row may differ from the plain rounding of its own
 * figure by one unit; the table total never differs from the figure the KPI
 * shows.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  if (weights.length === 0) return [];
  if (weightSum <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map(w => (total * w) / weightSum);
  const parts = exact.map(Math.floor);
  let rest = total - parts.reduce((sum, p) => sum + p, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of order) {
    if (rest <= 0) break;
    parts[index] += 1;
    rest -= 1;
  }
  return parts;
}

interface Group {
  date: string;
  dayType: number;
  isHoliday: boolean;
  vehicle: string;
  shifts: number;
  minutes: number;
  revenue: number;
}

function groupShifts(recommendation: ShiftRecommendation): Group[] {
  const groups = new Map<string, Group>();
  for (const shift of recommendation.shifts) {
    const key = `${shift.operatingDate}|${shift.vehicle}`;
    const group = groups.get(key) ?? {
      date: shift.operatingDate, dayType: shift.dayType, isHoliday: shift.isHoliday,
      vehicle: shift.vehicle, shifts: 0, minutes: 0, revenue: 0,
    };
    group.shifts += 1;
    group.minutes += shift.minutes;
    group.revenue += shift.expectedRevenueCents;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.vehicle.localeCompare(b.vehicle));
}

function column(total: number | null, weights: number[]): (number | null)[] {
  return total === null ? weights.map(() => null) : apportion(total, weights);
}

/**
 * The plan folded to vehicle x operating day. Shifts, minutes and revenue are
 * sums of the plan's own shifts, so they total exactly what the shift table
 * totals; rides, tips and cash are the scenario's estimates, apportioned so
 * that their totals are the figures computed from the whole plan's revenue.
 */
export function dailyVehicleTable(recommendation: ShiftRecommendation, scenario: Scenario): DailyVehicleTable {
  const groups = groupShifts(recommendation);
  const weights = groups.map(g => g.revenue);
  const revenue = groups.reduce((sum, g) => sum + g.revenue, 0);
  const totals: DailyTotals = {
    shifts: groups.reduce((sum, g) => sum + g.shifts, 0),
    minutes: groups.reduce((sum, g) => sum + g.minutes, 0),
    expectedRevenueCents: revenue,
    expectedRides: expectedRidesFor(revenue, scenario),
    expectedTipCents: shareOf(revenue, scenario.tipShare),
    expectedCashCents: shareOf(revenue, scenario.cashShare),
  };
  const rides = column(totals.expectedRides, weights);
  const tips = column(totals.expectedTipCents, weights);
  const cash = column(totals.expectedCashCents, weights);
  const rows = groups.map((g, i): DailyVehicleRow => ({
    id: `${g.date}|${g.vehicle}`,
    date: g.date,
    dayType: g.dayType,
    isHoliday: g.isHoliday,
    vehicle: g.vehicle,
    shifts: g.shifts,
    minutes: g.minutes,
    expectedRevenueCents: g.revenue,
    expectedRides: rides[i],
    expectedTipCents: tips[i],
    expectedCashCents: cash[i],
  }));
  return { rows, totals };
}

// ── The form ────────────────────────────────────────────────────────────────

/** The scenario inputs as the fields hold them, so a half-typed "12," survives. */
export interface ScenarioTexts {
  targetTripsText: string;
  cancellationText: string;
  tipText: string;
  cashText: string;
}

export type ScenarioField = keyof ScenarioTexts;

export const EMPTY_SCENARIO_TEXTS: ScenarioTexts = { targetTripsText: '', cancellationText: '', tipText: '', cashText: '' };

/** The measured shares as the starting text of each field; no trip count, because nothing measures one. */
export function defaultScenarioTexts(stats: ReferenceStats | null): ScenarioTexts {
  return {
    targetTripsText: '',
    cancellationText: shareToText(stats?.cancellationShare ?? null),
    tipText: shareToText(stats?.tipShare ?? null),
    cashText: shareToText(stats?.cashShare ?? null),
  };
}

export interface ScenarioReading {
  readonly scenario: Scenario;
  /** Fields with text that is not a value; blank is a valid "not given". */
  readonly invalid: readonly ScenarioField[];
}

export function readScenario(texts: ScenarioTexts, stats: ReferenceStats | null): ScenarioReading {
  const invalid: ScenarioField[] = [];
  const share = (field: ScenarioField): number | null => {
    const value = parseShareText(texts[field]);
    if (value === null && texts[field].trim() !== '') invalid.push(field);
    return value;
  };
  const trips = parseTripCountText(texts.targetTripsText);
  if (trips === null && texts.targetTripsText.trim() !== '') invalid.push('targetTripsText');
  return {
    invalid,
    scenario: {
      averageFareCents: averageFareCents(stats),
      measuredCancellationShare: stats?.cancellationShare ?? null,
      cancellationShare: share('cancellationText'),
      tipShare: share('tipText'),
      cashShare: share('cashText'),
      targetTrips: trips,
    },
  };
}

// ── Excel ───────────────────────────────────────────────────────────────────

export interface DailyExportLabels {
  sheetTitle: string;
  moduleName: string;
  total: string;
  date: string;
  weekday: string;
  vehicle: string;
  shifts: string;
  hours: string;
  revenue: string;
  rides: string;
  tips: string;
  cash: string;
  /** Resolved weekday names, Monday first. */
  weekdays: readonly string[];
  holiday: string;
}

function dottedDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : iso;
}

function euros(cents: number | null): number | '' {
  return cents === null ? '' : cents / 100;
}

/**
 * The daily table as a sheet. Headers follow the UI language (an operational
 * list, not a statutory form) and carry no kilometre column: the import holds no
 * distance. The title says every figure beyond the first four columns is an
 * estimate, because a file travels without its screen.
 */
export function dailyExportOptions(table: DailyVehicleTable, month: string, labels: DailyExportLabels, filterSummary: string[] = []): ExportOptions {
  return {
    filename: `schichtempfehlung_tag_fahrzeug_${month}`,
    sheetTitle: labels.sheetTitle,
    moduleName: labels.moduleName,
    filterSummary,
    columns: [
      { key: 'date', label: labels.date, width: 16 },
      { key: 'weekday', label: labels.weekday, width: 12 },
      { key: 'vehicle', label: labels.vehicle, width: 18 },
      { key: 'shifts', label: labels.shifts, width: 10, type: 'integer' },
      { key: 'hours', label: labels.hours, width: 12, type: 'number' },
      { key: 'revenue', label: labels.revenue, width: 20, type: 'money' },
      { key: 'rides', label: labels.rides, width: 16, type: 'integer' },
      { key: 'tips', label: labels.tips, width: 18, type: 'money' },
      { key: 'cash', label: labels.cash, width: 18, type: 'money' },
    ],
    rows: table.rows.map(r => ({
      date: dottedDate(r.date) + (r.isHoliday ? ` (${labels.holiday})` : ''),
      weekday: labels.weekdays[r.dayType] ?? '',
      vehicle: r.vehicle,
      shifts: r.shifts,
      hours: Math.round((r.minutes / 60) * 100) / 100,
      revenue: r.expectedRevenueCents / 100,
      rides: r.expectedRides ?? '',
      tips: euros(r.expectedTipCents),
      cash: euros(r.expectedCashCents),
    })),
    totals: {
      shifts: table.totals.shifts,
      hours: Math.round((table.totals.minutes / 60) * 100) / 100,
      revenue: table.totals.expectedRevenueCents / 100,
      rides: table.totals.expectedRides ?? '',
      tips: euros(table.totals.expectedTipCents),
      cash: euros(table.totals.expectedCashCents),
    },
    labels: { totalsRow: labels.total },
  };
}
