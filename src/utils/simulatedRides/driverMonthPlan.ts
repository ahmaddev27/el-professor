import { wallTimeToInstant } from '../fahrtenbuchImportParser';
import type { StructuredNote } from '../monatsplanungPhase3';
import { noteExclusionIntervals } from '../driverNoteValidation';
import { effectOfNote } from '../constraintDecisionLog';
import {
  assessAgainstRange,
  computeHoursRange,
  type HoursRange,
  type HoursRangeProblem,
  type RangeAssessment,
} from '../monthlyPlan/hoursRange';
import { calendarDaysOfMonth, isoWeekdayOf, operatingDayIn, operatingDayStartIn } from './period';
import type { SimulationTenantSettings } from './tenantSettings';

/**
 * One driver's month, planned from the Drivers page and nothing else (Round 8,
 * section 2). This module decides **which operating days** a driver may be
 * given a simulated shift on, **inside which window**, and **how many minutes**
 * each of those days gets. It places no shift and chooses no vehicle: that is
 * the scheduler's (S4), which reads this plan and re-checks every shift.
 *
 * ## Where each figure comes from
 *
 * - **The hours range** is `monthlyPlan/hoursRange.ts`, unchanged: minimum and
 *   maximum salary divided by the hourly rate (decision D5). The owner has no
 *   ceiling. `target_monthly_hours`, `max_monthly_hours` and
 *   `planning_target_salary` are carried for printing only and decide nothing.
 * - **The days** are the operating days of the calendar month (04:00 to 04:00,
 *   the tenant's zone), restricted by `allowed_weekdays`, by every confirmed
 *   blocking note (sick, vacation, off …, through the simulator's own rule in
 *   `simulationConstraints.ts`: only a note with its own window blocks), by the
 *   days that already hold real trips, and, when Uber reported the driver
 *   per day, by the days Uber shows activity on.
 * - **The window** is `work_window_start/end`, or the whole operating day when
 *   `is_full_day_available` is set or no window is configured (the real
 *   planner applies no window then either, `monatsplanungPhase3.checkWindow`).
 *   A window across midnight runs to the next calendar day.
 *
 * ## The two numbers that are not configuration
 *
 * - **360 minutes is the ceiling of a day**, because it is the ceiling of a
 *   shift and a driver gets one shift a day: a longer one needs a rest break
 *   (§4 ArbZG) that this simulator does not place, and no break is configured
 *   anywhere (decision D2). It is a legal bound, not a preference.
 * - **60 minutes is the floor of a planned day.** A simulation preference: a
 *   shorter shift holds hardly a ride. The old universal 240-minute floor is
 *   gone; nothing on the Drivers page asked for it.
 *
 * ## How many minutes
 *
 * The month's target is the middle of the configured range (the owner's: the
 * minimum), cut to what the eligible days can hold, and spread as evenly as
 * the days allow. When the days cannot hold even the minimum, the plan takes
 * what they hold and the shortfall is a discrepancy row (test class 24). It
 * never adds a day, lengthens a shift past its window or past 360 minutes, or
 * touches a salary to make the figures meet.
 */

export const MAX_DAY_MINUTES = 360;
export const MIN_DAY_MINUTES = 60;

/** The Drivers page's columns, by the driver's UUID. */
export interface DriverPlanConfig {
  id: string;
  name: string;
  /** `drivers.status`; only `active` is planned. */
  status: string | null;
  /** `drivers.employment_type`: `employee`, `company_owner`, … */
  employmentType: string | null;
  planningEnabled: boolean | null;
  /** ISO weekdays, Monday = 1. Null or empty: every day. */
  allowedWeekdays: readonly number[] | null;
  workWindowStart: string | null;
  workWindowEnd: string | null;
  isFullDayAvailable: boolean | null;
  minSalary: number | null;
  maxSalary: number | null;
  hourlyRate: number | null;
  /** `drivers.salary_ratio`, the commission. Printed; the reconciliation (S7) uses it. */
  salaryRatio: number | null;
  /** Printed only (D5). */
  targetSalary: number | null;
  targetMonthlyHours: number | null;
  maxMonthlyHours: number | null;
}

/** What Uber reported for the driver in the month, as `uberImport.ts` read it. */
export type UberDriverDetail = 'daily' | 'weekly_only' | 'none';

export interface DriverMonthInputs {
  year: number;
  month: number;
  settings: Pick<SimulationTenantSettings, 'timeZone' | 'operatingDayStartHour'>;
  /** Non-neutral notes by driver UUID (`loadDriverNotes`). */
  notes: ReadonlyMap<string, readonly StructuredNote[]>;
  /** Operating days with Uber activity, by driver UUID; only drivers Uber reported per day. */
  uberActiveDays: ReadonlyMap<string, ReadonlySet<string>>;
  /** Drivers Uber reported for the month only as a period total. */
  uberWeeklyOnly: ReadonlySet<string>;
  /** Operating days that already hold real trips, by driver UUID (section 4). */
  realTripDays?: ReadonlyMap<string, ReadonlySet<string>>;
}

export type WindowSource = 'configured' | 'full_day' | 'unrestricted';

export type WindowProblem = 'work_window_incomplete' | 'work_window_unreadable' | 'work_window_empty';

export type DayStatus =
  | 'planned'
  | 'not_needed'
  | 'driver_not_planned'
  | 'weekday_not_allowed'
  | 'absent'
  | 'window_too_short'
  | 'no_uber_activity'
  | 'real_trips'
  | 'clock_unreadable';

export interface PlanNoteRef {
  id: string;
  type: string;
}

export interface DriverDayPlan {
  /** The operating day, YYYY-MM-DD. */
  date: string;
  isoWeekday: number;
  status: DayStatus;
  /** The window the shift must lie in, after confirmed notes cut it; null when the day has none. */
  windowStartMs: number | null;
  windowEndMs: number | null;
  capacityMinutes: number;
  plannedMinutes: number;
  /** null when Uber did not report the driver per day. */
  uberActive: boolean | null;
  /** The confirmed note that took the day away or cut its window. */
  blockingNote: PlanNoteRef | null;
  /** Unconfirmed blocking notes: the day stays, and the plan says so. */
  reviewNotes: PlanNoteRef[];
}

export type NotPlannedReason = 'inactive' | 'planning_disabled' | 'configuration_required' | 'no_eligible_day';

export type DriverDiscrepancy =
  | { kind: 'configuration_required'; problems: (HoursRangeProblem | WindowProblem)[] }
  | { kind: 'capacity_below_minimum'; minMinutes: number; capacityMinutes: number }
  | { kind: 'target_cut_to_capacity'; targetMinutes: number; capacityMinutes: number }
  | { kind: 'target_below_one_shift'; targetMinutes: number }
  | { kind: 'uber_activity_on_unavailable_day'; date: string; dayStatus: DayStatus }
  | { kind: 'uber_activity_driver_not_planned'; reason: NotPlannedReason; days: number };

export interface DriverMonthPlan {
  driverId: string;
  driverName: string;
  employmentType: string | null;
  isOwner: boolean;
  planned: boolean;
  notPlannedReason: NotPlannedReason | null;
  range: HoursRange;
  window: { source: WindowSource; startMinute: number; endMinute: number } | null;
  uberDetail: UberDriverDetail;
  days: DriverDayPlan[];
  /** The middle of the range (owner: the minimum), in minutes; null without a usable range. */
  targetMinutes: number | null;
  capacityMinutes: number;
  plannedMinutes: number;
  assessment: RangeAssessment;
  discrepancies: DriverDiscrepancy[];
  /** Carried for the sheet, decides nothing. */
  printed: Pick<DriverPlanConfig, 'salaryRatio' | 'targetSalary' | 'targetMonthlyHours' | 'maxMonthlyHours' | 'hourlyRate' | 'minSalary' | 'maxSalary'>;
}

function shiftDate(day: string, days: number): string {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function minuteOfDay(text: string | null): number | null {
  if (text == null) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const h = +m[1];
  const min = +m[2];
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

/** A wall time `minute` minutes after midnight of `day` (may run into the next day). */
function instantAt(day: string, minute: number, zone: string): number | null {
  const date = shiftDate(day, Math.floor(minute / 1440));
  const rest = minute % 1440;
  const result = wallTimeToInstant(
    { year: +date.slice(0, 4), month: +date.slice(5, 7), day: +date.slice(8, 10), hour: Math.floor(rest / 60), minute: rest % 60, second: 0 },
    zone,
  );
  return result.kind === 'ok' ? result.ms : null;
}

function resolveWindow(config: DriverPlanConfig): { window: DriverMonthPlan['window']; problem: WindowProblem | null } {
  if (config.isFullDayAvailable) return { window: { source: 'full_day', startMinute: 0, endMinute: 0 }, problem: null };
  const hasStart = config.workWindowStart != null && config.workWindowStart.trim() !== '';
  const hasEnd = config.workWindowEnd != null && config.workWindowEnd.trim() !== '';
  if (!hasStart && !hasEnd) return { window: { source: 'unrestricted', startMinute: 0, endMinute: 0 }, problem: null };
  if (!hasStart || !hasEnd) return { window: null, problem: 'work_window_incomplete' };
  const start = minuteOfDay(config.workWindowStart);
  const end = minuteOfDay(config.workWindowEnd);
  if (start == null || end == null) return { window: null, problem: 'work_window_unreadable' };
  if (start === end) return { window: null, problem: 'work_window_empty' };
  return { window: { source: 'configured', startMinute: start, endMinute: end <= start ? end + 1440 : end }, problem: null };
}

interface DayWindow {
  date: string;
  startMs: number | null;
  endMs: number | null;
}

/** One window per operating day of the month; a window starting before the cutoff belongs to the day before. */
function windowsOfMonth(window: NonNullable<DriverMonthPlan['window']>, inputs: DriverMonthInputs): DayWindow[] {
  const { timeZone, operatingDayStartHour } = inputs.settings;
  const days = calendarDaysOfMonth(inputs.year, inputs.month);
  if (window.source !== 'configured') {
    return days.map(day => {
      const start = operatingDayStartIn(day, timeZone, operatingDayStartHour);
      const next = operatingDayStartIn(shiftDate(day, 1), timeZone, operatingDayStartHour);
      return start.kind === 'ok' && next.kind === 'ok'
        ? { date: day, startMs: start.ms, endMs: next.ms }
        : { date: day, startMs: null, endMs: null };
    });
  }
  const inMonth = new Set(days);
  const byDay = new Map<string, DayWindow>(days.map(day => [day, { date: day, startMs: null, endMs: null }]));
  const anchors = [shiftDate(days[0], -1), ...days, shiftDate(days[days.length - 1], 1)];
  for (const anchor of anchors) {
    const startMs = instantAt(anchor, window.startMinute, timeZone);
    const endMs = instantAt(anchor, window.endMinute, timeZone);
    // The operating day is read from the wall clock, so a window whose start
    // the clock skips or repeats still has a day; it just has no instant.
    const startsBeforeCutoff = window.startMinute < operatingDayStartHour * 60;
    const day = startMs != null ? operatingDayIn(startMs, timeZone, operatingDayStartHour) : startsBeforeCutoff ? shiftDate(anchor, -1) : anchor;
    if (!inMonth.has(day)) continue;
    byDay.set(day, { date: day, startMs: startMs != null && endMs != null ? startMs : null, endMs: startMs != null && endMs != null ? endMs : null });
  }
  return days.map(day => byDay.get(day)!);
}

/** The window less every confirmed blocking interval: its longest free stretch. */
function freeStretch(startMs: number, endMs: number, blocks: readonly { start: number; end: number }[]): { start: number; end: number } | null {
  const cuts = blocks.filter(b => b.start < endMs && b.end > startMs).sort((a, b) => a.start - b.start);
  let best: { start: number; end: number } | null = null;
  let cursor = startMs;
  for (const cut of [...cuts, { start: endMs, end: endMs }]) {
    if (cut.start > cursor) {
      const stretch = { start: cursor, end: Math.min(cut.start, endMs) };
      if (!best || stretch.end - stretch.start > best.end - best.start) best = stretch;
    }
    cursor = Math.max(cursor, cut.end);
    if (cursor >= endMs) break;
  }
  return best;
}

/** Spread `target` minutes over days with the given caps, as evenly as the caps allow. Integer minutes, exact sum. */
export function spreadMinutes(caps: readonly number[], target: number): number[] {
  const total = caps.reduce((s, c) => s + c, 0);
  const goal = Math.max(0, Math.min(Math.floor(target), total));
  let lo = 0;
  let hi = Math.max(0, ...caps);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const used = caps.reduce((s, c) => s + Math.min(c, mid), 0);
    if (used <= goal) lo = mid;
    else hi = mid - 1;
  }
  const out = caps.map(c => Math.min(c, lo));
  let rest = goal - out.reduce((s, m) => s + m, 0);
  for (let i = 0; i < out.length && rest > 0; i++) {
    if (out[i] < caps[i]) {
      out[i] += 1;
      rest -= 1;
    }
  }
  return out;
}

/** Choose `k` of `n` days spread evenly over the month (indices, ascending). */
function evenlyChosen(n: number, k: number): number[] {
  return Array.from({ length: k }, (_, i) => Math.floor(((i + 0.5) * n) / k));
}

function notPlannedPlan(
  base: Omit<DriverMonthPlan, 'planned' | 'notPlannedReason' | 'plannedMinutes' | 'assessment'>,
  reason: NotPlannedReason,
  isOwner: boolean,
): DriverMonthPlan {
  const days = base.days.map(d => ({ ...d, plannedMinutes: 0, status: d.status === 'planned' ? ('driver_not_planned' as const) : d.status }));
  const active = days.filter(d => d.uberActive === true).length;
  const discrepancies = active > 0 ? [...base.discrepancies, { kind: 'uber_activity_driver_not_planned' as const, reason, days: active }] : base.discrepancies;
  return { ...base, days, discrepancies, planned: false, notPlannedReason: reason, plannedMinutes: 0, assessment: assessAgainstRange(0, base.range, isOwner) };
}

export function planDriverMonth(config: DriverPlanConfig, inputs: DriverMonthInputs): DriverMonthPlan {
  const isOwner = config.employmentType === 'company_owner';
  const range = computeHoursRange({ minSalary: config.minSalary, maxSalary: config.maxSalary, hourlyRate: config.hourlyRate, isOwner });
  const { window, problem: windowProblem } = resolveWindow(config);
  const activeDays = inputs.uberActiveDays.get(config.id);
  const uberDetail: UberDriverDetail = activeDays ? 'daily' : inputs.uberWeeklyOnly.has(config.id) ? 'weekly_only' : 'none';
  const realDays = inputs.realTripDays?.get(config.id);
  const notes = inputs.notes.get(config.id) ?? [];
  const confirmed = notes.filter(n => n.note_planning_behavior === 'exclude_from_plan' && effectOfNote(n).certainty === 'confirmed');
  const unconfirmed = notes.filter(n => n.note_planning_behavior === 'exclude_from_plan' && effectOfNote(n).certainty !== 'confirmed');
  const ref = (n: StructuredNote): PlanNoteRef => ({ id: n.id, type: n.note_type });

  const calendar = calendarDaysOfMonth(inputs.year, inputs.month);
  const windows = window ? windowsOfMonth(window, inputs) : calendar.map(date => ({ date, startMs: null, endMs: null }));

  const discrepancies: DriverDiscrepancy[] = [];
  const days: DriverDayPlan[] = windows.map(w => {
    const isoWeekday = isoWeekdayOf(w.date);
    const day: DriverDayPlan = {
      date: w.date, isoWeekday, status: 'planned', windowStartMs: w.startMs, windowEndMs: w.endMs,
      capacityMinutes: 0, plannedMinutes: 0, uberActive: activeDays ? activeDays.has(w.date) : null,
      blockingNote: null, reviewNotes: [],
    };
    const allowed = config.allowedWeekdays;
    if (allowed && allowed.length > 0 && !allowed.includes(isoWeekday)) return { ...day, status: 'weekday_not_allowed' };
    if (realDays?.has(w.date)) return { ...day, status: 'real_trips' };
    if (w.startMs == null || w.endMs == null) return { ...day, status: 'clock_unreadable' };

    const blockingHere = confirmed.filter(n => noteExclusionIntervals(n).some(iv => iv.start < w.endMs! && iv.end > w.startMs!));
    day.reviewNotes = unconfirmed.filter(n => noteExclusionIntervals(n).some(iv => iv.start < w.endMs! && iv.end > w.startMs!)).map(ref);
    let start = w.startMs;
    let end = w.endMs;
    if (blockingHere.length > 0) {
      day.blockingNote = ref(blockingHere[0]);
      const free = freeStretch(start, end, blockingHere.flatMap(n => noteExclusionIntervals(n)));
      if (!free) return { ...day, status: 'absent', windowStartMs: null, windowEndMs: null };
      start = free.start;
      end = free.end;
    }
    const length = Math.floor((end - start) / 60_000);
    if (length < MIN_DAY_MINUTES) {
      return { ...day, status: day.blockingNote ? 'absent' : 'window_too_short', windowStartMs: start, windowEndMs: end };
    }
    if (activeDays && !activeDays.has(w.date)) return { ...day, status: 'no_uber_activity', windowStartMs: start, windowEndMs: end };
    return { ...day, windowStartMs: start, windowEndMs: end, capacityMinutes: Math.min(MAX_DAY_MINUTES, length) };
  });

  const capacityMinutes = days.reduce((s, d) => s + d.capacityMinutes, 0);
  const base = {
    driverId: config.id, driverName: config.name, employmentType: config.employmentType, isOwner, range, window, uberDetail,
    days, targetMinutes: null as number | null, capacityMinutes, discrepancies,
    printed: {
      salaryRatio: config.salaryRatio, targetSalary: config.targetSalary, targetMonthlyHours: config.targetMonthlyHours,
      maxMonthlyHours: config.maxMonthlyHours, hourlyRate: config.hourlyRate, minSalary: config.minSalary, maxSalary: config.maxSalary,
    },
  };

  if (config.status !== 'active') return notPlannedPlan(base, 'inactive', isOwner);
  if (config.planningEnabled === false) return notPlannedPlan(base, 'planning_disabled', isOwner);
  const problems = [...range.problems, ...(windowProblem ? [windowProblem] : [])];
  if (!range.usable || problems.length > 0 || range.minHours == null) {
    return notPlannedPlan({ ...base, discrepancies: [{ kind: 'configuration_required', problems }, ...discrepancies] }, 'configuration_required', isOwner);
  }

  const minMinutes = Math.ceil(range.minHours * 60);
  const targetMinutes = isOwner || range.effectiveMaxHours == null
    ? minMinutes
    : Math.round(((range.minHours + range.effectiveMaxHours) / 2) * 60);
  base.targetMinutes = targetMinutes;
  const open = days.map((d, i) => ({ d, i })).filter(x => x.d.status === 'planned');
  if (open.length === 0) return notPlannedPlan(base, 'no_eligible_day', isOwner);

  // Uber says the driver drove on a day the Drivers page or a note takes away.
  // Reported, never planned over: the day's money stays with the import.
  for (const day of days) {
    if (day.uberActive && day.status !== 'planned') {
      discrepancies.push({ kind: 'uber_activity_on_unavailable_day', date: day.date, dayStatus: day.status });
    }
  }

  if (capacityMinutes < minMinutes) discrepancies.push({ kind: 'capacity_below_minimum', minMinutes, capacityMinutes });
  else if (capacityMinutes < targetMinutes) discrepancies.push({ kind: 'target_cut_to_capacity', targetMinutes, capacityMinutes });
  const goal = Math.min(targetMinutes, capacityMinutes);
  if (goal < MIN_DAY_MINUTES) discrepancies.push({ kind: 'target_below_one_shift', targetMinutes: goal });

  // Even spread; when that would leave a day under the floor, fewer days, spread over the month.
  const caps = open.map(x => x.d.capacityMinutes);
  let chosen = open.map((_, k) => k);
  let minutes = spreadMinutes(caps, goal);
  if (minutes.some(m => m < MIN_DAY_MINUTES)) {
    const k = Math.floor(goal / MIN_DAY_MINUTES);
    chosen = k > 0 ? evenlyChosen(open.length, Math.min(k, open.length)) : [];
    minutes = spreadMinutes(chosen.map(k2 => caps[k2]), goal);
  }
  const plannedByIndex = new Map(chosen.map((k2, j) => [open[k2].i, minutes[j]]));
  const plannedDays = days.map((d, i) => {
    if (d.status !== 'planned') return d;
    const m = plannedByIndex.get(i) ?? 0;
    return m >= MIN_DAY_MINUTES ? { ...d, plannedMinutes: m } : { ...d, status: 'not_needed' as const, plannedMinutes: 0 };
  });
  const plannedMinutes = plannedDays.reduce((s, d) => s + d.plannedMinutes, 0);
  return {
    ...base, days: plannedDays, targetMinutes, planned: true, notPlannedReason: null, plannedMinutes,
    assessment: assessAgainstRange(plannedMinutes, range, isOwner),
  };
}
