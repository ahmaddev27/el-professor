import { toCents } from '../money';
import { spreadTips } from './figures';
import { fnv1a32 } from './hash';
import {
  applyMonthlyShare,
  resolveShareRate,
  shareSettingProblem,
  type ShareSetting,
  type ShareSettingProblem,
} from './monthlyRate';
import { createRng } from './rng';
import type { SimRide, SimShift } from './types';
import type { UberMonthImport } from './uberImport';

/**
 * The money of a simulated calendar month, reconciled against what Uber
 * reported (FleetBook round 8, §5 and §6, test classes 13, 19 and 20).
 *
 * **Tips.** No tip is invented. Every tip the generator drew is discarded, and
 * each imported `trinkgeld` total is spread exactly, to the cent, over that
 * driver's simulated completed rides:
 * - a daily row over the rides of its operating day;
 * - a weekly row wholly inside the month over the rides of its week, and
 *   reconciled per week, because Uber did not say how it fell across the days.
 *
 * Such an allocation is labelled simulated, and the imported total stays beside
 * it as the authoritative figure. A tip never moves to another driver, another
 * day or another week, and never lands on a cancelled ride, a declined order or
 * an empty leg. A total the month cannot carry stays unallocated and is named:
 * - no simulated ride that day or week;
 * - a negative amount;
 * - a daily and a weekly row for the same day;
 * - a week across the month boundary.
 *
 * **The share** is taken of the imported `umsatz` of each driver-day, at the
 * rate the setting gives for that date. **It is the company's share**
 * (`company_share`, the owner's answer to D1 on 27.11.2026): imported Uber
 * revenue x 30-33 %, a percentage and never a multiplier of the fares. It is
 * computed and shown, never booked, and it is the configured formula's result
 * (spec section 5, item 6). Simulated fares stand beside it as simulated,
 * never as actual fares, and are not bent towards it or towards the revenue:
 * the gap between them is shown, not closed.
 *
 * **The financial status** is separate from the Fahrtenbuch's export verdict
 * (D10), so a money problem does not block a valid Fahrtenbuch:
 * - `FAILED`: a cent the allocation cannot account for;
 * - `INCOMPLETE`: a figure the month could not read or place;
 * - `CONFIGURATION_REQUIRED`: no share rate set, or a setting that is invalid;
 * - `RECONCILED`: every tip allocated to the cent and every share computed.
 */

/** The imported figures the reconciliation reads. Hand rows and reader issues are optional for old callers. */
export type ReconcileUber = Pick<UberMonthImport, 'days' | 'periods'> & Partial<Pick<UberMonthImport, 'handRows' | 'issues'>>;

export type TipScope = 'day' | 'period';

export type TipOutcome =
  | 'allocated'
  | 'no_simulated_ride'
  | 'negative'
  | 'conflict'
  | 'not_attributable';

/** One imported tip total and what became of it. */
export interface TipAllocation {
  scope: TipScope;
  driverId: string;
  driverName: string;
  /** The operating day, or the period's first and last operating day. */
  from: string;
  to: string;
  /** The imported total, in cents, with its sign. Authoritative. */
  importedCents: number;
  /** The sum of the simulated rides' tips it was spread over. 0 when not allocated. */
  allocatedCents: number;
  /** The simulated completed rides in its scope. */
  completedRides: number;
  outcome: TipOutcome;
}

export type DriverDayNote =
  | 'negative_figure'
  | 'also_in_period'
  | 'no_uber_row'
  | 'share_not_computable';

export type PeriodNote = 'negative_figure' | 'also_in_days' | 'share_not_computable';

/** One driver and one operating day: what Uber reported beside what was simulated. */
export interface DriverDayReconciliation {
  day: string;
  driverId: string;
  driverName: string;
  /** Imported, unchanged. */
  umsatzCents: number;
  aktionenCents: number;
  bargeldCents: number;
  /** The share's base: `umsatz` alone (D1's default). Adjustments stand beside it. */
  basisCents: number;
  rateBasisPoints: number | null;
  /** Computed and shown, never booked; null where no rate applies. */
  shareCents: number | null;
  tipsImportedCents: number;
  /** The simulated rides' tips that day (SIMULIERT). */
  tipsAllocatedCents: number;
  /** Imported minus allocated, where the day's tip was allocated; 0 otherwise. */
  tipDifferenceCents: number;
  /** Simulated completed rides and their fares (SIMULIERT, not actual fares). */
  simulatedCompleted: number;
  simulatedFareCents: number;
  /** The configured formula's result: the company share (D1). Null where no rate applies. */
  formulaTotalCents: number | null;
  notes: DriverDayNote[];
}

/** One weekly Uber row: reported for its period, never split by day. */
export interface PeriodReconciliation {
  driverId: string;
  driverName: string;
  periodStart: string;
  periodEnd: string;
  placement: 'inside_month' | 'crosses_month_boundary';
  /** What keeps this week from being reconciled, besides its tip and its placement. */
  notes: PeriodNote[];
  umsatzCents: number;
  aktionenCents: number;
  tipsImportedCents: number;
  tipsAllocatedCents: number;
  rateBasisPoints: number | null;
  shareCents: number | null;
}

export type FinancialStatus = 'RECONCILED' | 'CONFIGURATION_REQUIRED' | 'INCOMPLETE' | 'FAILED';

/** What the share is (D1, owner 27.11.2026): the company's share of the imported revenue. */
export type ShareMeaning = 'company_share';
export const SHARE_MEANING: ShareMeaning = 'company_share';
/** The meaning as the German documents print it. */
export const SHARE_MEANING_TEXT: Record<ShareMeaning, string> = { company_share: 'Unternehmensanteil' };

export type FinancialReason =
  | 'uber_not_read'
  | 'no_uber_figures'
  | 'share_not_configured'
  | 'share_setting_invalid'
  | 'share_not_computable'
  | 'uber_negative_figure'
  | 'uber_day_in_period'
  | 'week_across_boundary'
  | 'simulated_without_uber'
  | 'tip_no_simulated_ride'
  | 'tip_negative'
  | 'tip_conflict'
  | 'tip_week_across_boundary'
  | 'hand_rows'
  | 'uber_row_issues'
  | 'tip_mismatch';

export interface FinancialReconciliation {
  status: FinancialStatus;
  /** Every reason that holds, worst first. */
  reasons: FinancialReason[];
  /** The read-back's findings: a cent the allocation cannot account for. Empty unless FAILED. */
  violations: string[];
  uberRead: boolean;
  share: {
    /** The company's share (D1, owner 27.11.2026): computed and shown, never booked. */
    meaning: ShareMeaning;
    basis: 'umsatz';
    setting: ShareSetting | null;
    settingProblem: ShareSettingProblem | null;
  };
  tips: TipAllocation[];
  days: DriverDayReconciliation[];
  periods: PeriodReconciliation[];
  totals: {
    umsatzCents: number;
    tipsImportedCents: number;
    tipsAllocatedCents: number;
    tipsUnallocatedCents: number;
    shareCents: number;
  };
}

const completed = (r: SimRide): boolean => r.status === 'completed';
const tipCents = (r: SimRide): number => toCents(r.tip);

/** The day each ride counts on: its shift's operating day. */
function rideDays(shifts: readonly SimShift[]): Map<string, string> {
  return new Map(shifts.map(s => [s.id, s.operatingDay]));
}

/** Each allocation has its own stream, so one day's tips never depend on another's. */
export function tipStreamSeed(seed: number, driverId: string, from: string, to: string): number {
  return (fnv1a32(`${Math.trunc(seed)}|tips|${driverId}|${from}|${to}`) ^ 0x7f4a_7c15) >>> 0;
}

/**
 * Discards every drawn tip, then spreads each imported total over its scope.
 * Writes the rides' `tip` (euro, from whole cents) and returns what happened
 * to every imported total that is not zero.
 */
export function allocateImportedTips(args: {
  uber: ReconcileUber | null;
  rides: SimRide[];
  shifts: readonly SimShift[];
  seed: number;
}): TipAllocation[] {
  for (const ride of args.rides) ride.tip = 0;
  if (!args.uber) return [];
  const dayOf = rideDays(args.shifts);
  const ridesOf = (driverId: string, from: string, to: string): SimRide[] => args.rides.filter(r => {
    const day = dayOf.get(r.shiftId);
    return completed(r) && r.driver.id === driverId && day !== undefined && day >= from && day <= to;
  });

  const out: TipAllocation[] = [];
  const place = (scope: TipScope, driverId: string, driverName: string, from: string, to: string, cents: number, blocked: TipOutcome | null) => {
    if (cents === 0) return;
    const rides = ridesOf(driverId, from, to);
    const row: TipAllocation = { scope, driverId, driverName, from, to, importedCents: cents, allocatedCents: 0, completedRides: rides.length, outcome: 'allocated' };
    if (blocked) row.outcome = blocked;
    else if (cents < 0) row.outcome = 'negative';
    else if (rides.length === 0) row.outcome = 'no_simulated_ride';
    else {
      // spreadTips cannot refuse here: it takes at most one ride per cent.
      spreadTips(createRng(tipStreamSeed(args.seed, driverId, from, to)), rides, cents);
      row.allocatedCents = rides.reduce((n, r) => n + tipCents(r), 0);
    }
    out.push(row);
  };

  for (const d of args.uber.days) {
    place('day', d.driverId, d.driverName, d.date, d.date, d.figures.trinkgeldCents, d.overlapsPeriod ? 'conflict' : null);
  }
  for (const p of args.uber.periods) {
    const blocked: TipOutcome | null = p.placement === 'crosses_month_boundary'
      ? 'not_attributable'
      : p.overlappingDailyDates.length > 0 ? 'conflict' : null;
    place('period', p.driverId, p.driverName, p.periodStart, p.periodEnd, p.figures.trinkgeldCents, blocked);
  }
  return out;
}

/**
 * The read-back: every tip on a ride is backed by an imported total, and every
 * allocated total is met to the cent. A finding here is a cent nobody can
 * account for, and the month's financial status is FAILED.
 */
export function checkTips(rides: readonly SimRide[], shifts: readonly SimShift[], allocations: readonly TipAllocation[]): string[] {
  const out: string[] = [];
  const dayOf = rideDays(shifts);
  const allocated = allocations.filter(a => a.outcome === 'allocated');
  for (const ride of rides) {
    if (ride.tip === 0) continue;
    if (!completed(ride)) {
      out.push(`${ride.tripId ?? ride.shiftId}: a ${ride.status} ride carries a tip`);
      continue;
    }
    const day = dayOf.get(ride.shiftId);
    const backed = day !== undefined && allocated.some(a => a.driverId === ride.driver.id && day >= a.from && day <= a.to);
    if (!backed) out.push(`${ride.tripId ?? ride.shiftId}: a tip no imported total backs`);
  }
  for (const a of allocated) {
    const sum = rides.filter(r => completed(r) && r.driver.id === a.driverId)
      .filter(r => { const day = dayOf.get(r.shiftId); return day !== undefined && day >= a.from && day <= a.to; })
      .reduce((n, r) => n + tipCents(r), 0);
    if (sum !== a.importedCents) out.push(`tips of ${a.driverId} ${a.from}..${a.to}: ${sum} cents on the rides, ${a.importedCents} imported`);
  }
  return out;
}

const TIP_REASON: Record<Exclude<TipOutcome, 'allocated'>, FinancialReason> = {
  no_simulated_ride: 'tip_no_simulated_ride',
  negative: 'tip_negative',
  conflict: 'tip_conflict',
  not_attributable: 'tip_week_across_boundary',
};

const REASON_ORDER: readonly FinancialReason[] = [
  'tip_mismatch',
  'uber_not_read', 'no_uber_figures', 'uber_row_issues', 'hand_rows',
  'tip_conflict', 'tip_week_across_boundary', 'tip_negative', 'tip_no_simulated_ride', 'share_not_computable',
  'uber_negative_figure', 'uber_day_in_period', 'week_across_boundary', 'simulated_without_uber',
  'share_not_configured', 'share_setting_invalid',
];

const INCOMPLETE_REASONS: ReadonlySet<FinancialReason> = new Set([
  'uber_not_read', 'no_uber_figures', 'uber_row_issues', 'hand_rows',
  'tip_conflict', 'tip_week_across_boundary', 'tip_negative', 'tip_no_simulated_ride', 'share_not_computable',
  'uber_negative_figure', 'uber_day_in_period', 'week_across_boundary', 'simulated_without_uber',
]);

const dateParts = (day: string) => ({ year: +day.slice(0, 4), month: +day.slice(5, 7), day: +day.slice(8, 10) });

/** The rate on a date, or null without a usable setting. */
function rateOn(setting: ShareSetting | null, day: string): number | null {
  if (!setting || shareSettingProblem(setting)) return null;
  return resolveShareRate(setting, dateParts(day)).rateBasisPoints;
}

function shareOf(basisCents: number, rateBp: number | null): number | null {
  if (rateBp === null) return null;
  const applied = applyMonthlyShare(basisCents, rateBp);
  return applied.ok ? applied.result.amountCents : null;
}

export function reconcileMonth(args: {
  uber: ReconcileUber | null;
  rides: readonly SimRide[];
  shifts: readonly SimShift[];
  allocations: readonly TipAllocation[];
  shareSetting: ShareSetting | null;
}): FinancialReconciliation {
  const { uber, rides, shifts, allocations, shareSetting } = args;
  const settingProblem = shareSetting ? shareSettingProblem(shareSetting) : null;
  const dayOf = rideDays(shifts);
  const reasons = new Set<FinancialReason>();
  if (!shareSetting) reasons.add('share_not_configured');
  else if (settingProblem) reasons.add('share_setting_invalid');

  // Simulated rides by driver-day: the simulation's side, labelled as such.
  const simulated = new Map<string, { driverId: string; driverName: string; day: string; completed: number; fareCents: number; tipCents: number }>();
  for (const r of rides) {
    const day = dayOf.get(r.shiftId);
    if (day === undefined || !completed(r)) continue;
    // A driver without an id (never in calendar mode) is kept under its name, where no Uber row can match it.
    const key = `${r.driver.id ?? `ohne-id:${r.driver.name}`}|${day}`;
    const s = simulated.get(key) ?? { driverId: r.driver.id ?? '', driverName: r.driver.name, day, completed: 0, fareCents: 0, tipCents: 0 };
    s.completed += 1;
    s.fareCents += toCents(r.fare);
    s.tipCents += tipCents(r);
    simulated.set(key, s);
  }

  const days: DriverDayReconciliation[] = [];
  const seen = new Set<string>();
  for (const d of uber?.days ?? []) {
    const key = `${d.driverId}|${d.date}`;
    seen.add(key);
    const sim = simulated.get(key);
    const rateBp = rateOn(shareSetting, d.date);
    const shareCents = shareOf(d.figures.umsatzCents, rateBp);
    const tip = allocations.find(a => a.scope === 'day' && a.driverId === d.driverId && a.from === d.date);
    const notes: DriverDayNote[] = [];
    if (d.negativeTypes.length > 0) notes.push('negative_figure');
    if (d.overlapsPeriod) notes.push('also_in_period');
    if (rateBp !== null && shareCents === null) {
      notes.push('share_not_computable');
      reasons.add('share_not_computable');
    }
    days.push({
      day: d.date, driverId: d.driverId, driverName: d.driverName,
      umsatzCents: d.figures.umsatzCents, aktionenCents: d.figures.aktionenCents, bargeldCents: d.figures.bargeldCents,
      basisCents: d.figures.umsatzCents, rateBasisPoints: rateBp, shareCents,
      tipsImportedCents: d.figures.trinkgeldCents,
      tipsAllocatedCents: sim?.tipCents ?? 0,
      tipDifferenceCents: tip?.outcome === 'allocated' ? d.figures.trinkgeldCents - (sim?.tipCents ?? 0) : 0,
      simulatedCompleted: sim?.completed ?? 0, simulatedFareCents: sim?.fareCents ?? 0,
      formulaTotalCents: shareCents, notes,
    });
  }
  // A simulated driver-day Uber has no row for: shown, with nothing imported beside it.
  for (const [key, sim] of simulated) {
    if (seen.has(key)) continue;
    days.push({
      day: sim.day, driverId: sim.driverId, driverName: sim.driverName,
      umsatzCents: 0, aktionenCents: 0, bargeldCents: 0, basisCents: 0, rateBasisPoints: null, shareCents: null,
      tipsImportedCents: 0, tipsAllocatedCents: sim.tipCents, tipDifferenceCents: 0,
      simulatedCompleted: sim.completed, simulatedFareCents: sim.fareCents, formulaTotalCents: null, notes: ['no_uber_row'],
    });
  }
  days.sort((a, b) => a.day.localeCompare(b.day) || a.driverName.localeCompare(b.driverName) || a.driverId.localeCompare(b.driverId));

  const periods: PeriodReconciliation[] = (uber?.periods ?? []).map(p => {
    const inside = p.placement === 'inside_month';
    // A week has one rate only when every day of it has the same one: a fixed rate or the month's draw.
    const oneRate = inside && shareSetting !== null && !settingProblem && (shareSetting.mode === 'fixed' || shareSetting.scope === 'month');
    const rateBp = oneRate ? rateOn(shareSetting, p.periodStart) : null;
    const notes: PeriodNote[] = [];
    if (p.negativeTypes.length > 0) notes.push('negative_figure');
    if (p.overlappingDailyDates.length > 0) notes.push('also_in_days');
    if (inside && shareSetting && !settingProblem && !oneRate) {
      notes.push('share_not_computable');
      reasons.add('share_not_computable');
    }
    const tip = allocations.find(a => a.scope === 'period' && a.driverId === p.driverId && a.from === p.periodStart && a.to === p.periodEnd);
    return {
      driverId: p.driverId, driverName: p.driverName, periodStart: p.periodStart, periodEnd: p.periodEnd, placement: p.placement,
      notes, umsatzCents: p.figures.umsatzCents, aktionenCents: p.figures.aktionenCents,
      tipsImportedCents: p.figures.trinkgeldCents, tipsAllocatedCents: tip?.allocatedCents ?? 0,
      rateBasisPoints: rateBp, shareCents: shareOf(p.figures.umsatzCents, rateBp),
    };
  });

  // Every note that keeps a row of sheet 4 from being reconciled is a reason for
  // the month too, so the month never reads better than its own rows.
  if (days.some(d => d.notes.includes('negative_figure')) || periods.some(p => p.notes.includes('negative_figure'))) reasons.add('uber_negative_figure');
  if (days.some(d => d.notes.includes('also_in_period')) || periods.some(p => p.notes.includes('also_in_days'))) reasons.add('uber_day_in_period');
  if (periods.some(p => p.placement === 'crosses_month_boundary')) reasons.add('week_across_boundary');
  // Only beside figures Uber did report: with none at all, `uber_not_read` or `no_uber_figures` says it.
  const uberReported = uber !== null && (uber.days.length > 0 || uber.periods.length > 0);
  if (uberReported && days.some(d => d.notes.includes('no_uber_row'))) reasons.add('simulated_without_uber');
  if (!uber) reasons.add('uber_not_read');
  else if (uber.days.length === 0 && uber.periods.length === 0) reasons.add('no_uber_figures');
  if ((uber?.issues ?? []).length > 0) reasons.add('uber_row_issues');
  if ((uber?.handRows ?? []).length > 0) reasons.add('hand_rows');
  for (const a of allocations) if (a.outcome !== 'allocated') reasons.add(TIP_REASON[a.outcome]);

  const violations = checkTips(rides, shifts, allocations);
  if (violations.length > 0) reasons.add('tip_mismatch');

  const ordered = REASON_ORDER.filter(r => reasons.has(r));
  const status: FinancialStatus = violations.length > 0 ? 'FAILED'
    : ordered.some(r => INCOMPLETE_REASONS.has(r)) ? 'INCOMPLETE'
      : ordered.length > 0 ? 'CONFIGURATION_REQUIRED' : 'RECONCILED';

  const tipsImportedCents = allocations.reduce((n, a) => n + a.importedCents, 0);
  const tipsAllocatedCents = rides.filter(completed).reduce((n, r) => n + tipCents(r), 0);
  return {
    status,
    reasons: ordered,
    violations,
    uberRead: uber !== null,
    share: { meaning: SHARE_MEANING, basis: 'umsatz', setting: shareSetting, settingProblem },
    tips: [...allocations],
    days,
    periods,
    totals: {
      umsatzCents: days.reduce((n, d) => n + d.umsatzCents, 0) + periods.filter(p => p.placement === 'inside_month').reduce((n, p) => n + p.umsatzCents, 0),
      tipsImportedCents,
      tipsAllocatedCents,
      tipsUnallocatedCents: allocations.filter(a => a.outcome !== 'allocated').reduce((n, a) => n + a.importedCents, 0),
      shareCents: [...days.map(d => d.shareCents), ...periods.map(p => p.shareCents)].reduce<number>((n, c) => n + (c ?? 0), 0),
    },
  };
}
