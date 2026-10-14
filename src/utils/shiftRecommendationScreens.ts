/**
 * What the shift-recommendation screens derive, as pure functions.
 *
 * The screens add **no recommendation rule**: the profile and the plan come from
 * `src/utils/shiftRecommendation/`. What is left over is screen arithmetic —
 * which imports to offer, which months a target may be, how a duration is
 * written, which holidays a history touches, how a cell is shaded, how a shift
 * is shaped into a table row — and it lives here, not in a component, so it can
 * be tested without a renderer (the project has none), as `monthlyPlanScreens`
 * does for the standard plan.
 *
 * Nothing here reads the clock, a database or the language: a label is returned
 * as a dictionary key and the component resolves it with `t(...)`.
 */
import type { TranslationKey } from '../i18n';
import type { ExportOptions } from './excelExport';
import { getHolidaysForYear } from './germanHolidays';
import { parseGermanAmountToCents } from './money';
import { plannableMonths, type PlanImportRow } from './monthlyPlanScreens';
import {
  DEFAULT_PLAN_SETTINGS,
  type Confidence,
  type DayType,
  type PlanSettings,
  type ProfileExclusionReason,
  type RecommendedShift,
  type SettingsProblem,
  type YearMonth,
} from './shiftRecommendation';

// ── The two planning types (the route's `art` parameter) ────────────────────

/** The values `art` may carry; the entry page never compares against a bare string. */
export const PLANNING_TYPES = { standard: 'standard', shifts: 'schichten' } as const;
export type PlanningType = (typeof PLANNING_TYPES)[keyof typeof PLANNING_TYPES];

/** An unknown value is not a choice: it shows the chooser instead of guessing. */
export function parsePlanningType(raw: string | null): PlanningType | null {
  return raw === PLANNING_TYPES.standard || raw === PLANNING_TYPES.shifts ? raw : null;
}

// ── Months ──────────────────────────────────────────────────────────────────

/** January … December, the keys every month name in the product comes from. */
export const MONTH_NAME_KEYS: readonly TranslationKey[] = [
  'doc.month.january', 'doc.month.february', 'doc.month.march', 'doc.month.april',
  'doc.month.may', 'doc.month.june', 'doc.month.july', 'doc.month.august',
  'doc.month.september', 'doc.month.october', 'doc.month.november', 'doc.month.december',
];

export function monthKey({ year, month }: YearMonth): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function parseMonthKey(key: string): YearMonth | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? { year: Number(match[1]), month } : null;
}

/** The month `offset` months after `from` (1-based months, year rolls over). */
export function addMonths(from: YearMonth, offset: number): YearMonth {
  const index = from.year * 12 + (from.month - 1) + offset;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** The `count` months that follow `newest`, nearest first: the targets a plan may be made for. */
export function targetMonthOptions(newest: YearMonth, count = 12): YearMonth[] {
  return Array.from({ length: count }, (_, i) => addMonths(newest, i + 1));
}

export interface HistoryMonthOption {
  /** `YYYY-MM`. */
  key: string;
  year: number;
  month: number;
  /** The month's newest import: the one whose trips are read. */
  importId: string;
  fileName: string;
  rowCount: number;
  /** The month's other live imports, which are not read: the screen names them rather than leaving them out silently. */
  otherImports: number;
}

/**
 * One option per month, each carrying that month's **newest** import, newest
 * month first. Archived imports and unreadable months are left out by
 * `plannableMonths`, so this screen offers exactly the months the standard plan
 * offers.
 */
export function historyMonthOptions(rows: readonly PlanImportRow[]): HistoryMonthOption[] {
  return plannableMonths(rows).months.map(m => ({
    key: m.key,
    year: m.year,
    month: m.month,
    importId: m.imports[0].id,
    fileName: m.imports[0].fileName,
    rowCount: m.imports[0].rowCount,
    otherImports: m.imports.length - 1,
  }));
}

/** The newest `count` months, which is where an operator starts. */
export function defaultHistoryKeys(options: readonly HistoryMonthOption[], count = 3): string[] {
  return options.slice(0, count).map(o => o.key);
}

/** Selected options, oldest first, so the profile's months read in calendar order. */
export function selectedHistory(options: readonly HistoryMonthOption[], keys: ReadonlySet<string>): HistoryMonthOption[] {
  return options.filter(o => keys.has(o.key)).reverse();
}

// ── Holidays ────────────────────────────────────────────────────────────────

/** Region codes `normaliseBundesland` accepts. '' means the nationwide holidays only. */
export const HOLIDAY_REGIONS = ['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH'] as const;

/** Every year the history and the target touch (a January target after a December history spans two). */
export function yearsTouched(history: readonly YearMonth[], target: YearMonth): number[] {
  return [...new Set([...history.map(m => m.year), target.year])].sort((a, b) => a - b);
}

/** The union of the holiday dates of every year touched; '' region = nationwide only. */
export function holidaySet(years: readonly number[], region: string): Set<string> {
  const all = new Set<string>();
  for (const year of years) {
    for (const date of getHolidaysForYear(year, region || undefined)) all.add(date);
  }
  return all;
}

// ── Durations and the settings form ─────────────────────────────────────────

/** 285 → '4:45'. The unit ("h") is the dictionary's, not ours. */
export function formatDuration(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Minute values from `from` to `to` in `step`s, both included. */
export function minuteRange(from: number, to: number, step = 15): number[] {
  const out: number[] = [];
  for (let value = from; value <= to; value += step) out.push(value);
  return out;
}

export const MIN_SHIFT_CHOICES = minuteRange(60, 360);
export const MAX_SHIFT_CHOICES = minuteRange(60, 360);
export const BREAK_CHOICES = minuteRange(0, 120);
export const MAX_SHIFTS_CHOICES = [1, 2, 3, 4] as const;
export const SLOT_CHOICES = [15, 30, 60] as const;

/** The plan form as the inputs hold it; the threshold stays text so a half-typed "25," survives. */
export interface PlanForm {
  /** How the month is planned: towards a revenue target (the threshold is searched) or from a threshold the operator names. */
  mode: PlanMode;
  /** Euro text, as typed; used in 'target' mode. */
  targetText: string;
  thresholdText: string;
  minShiftMinutes: number;
  maxShiftMinutes: number;
  maxShiftsPerVehiclePerDay: number;
  minBreakMinutes: number;
}

export type PlanMode = 'target' | 'threshold';

/**
 * The operational constraints as named choices (the generator's shapes): the
 * longest block in minutes, and the break between two shifts. Each maps onto
 * the engine's own setting and nothing is widened — 285 is "under five hours",
 * and the 360-minute ceiling stays where `validatePlanSettings` puts it.
 */
export const OPERATIONAL_BLOCK_CHOICES = [240, 270, 285] as const;
export const OPERATIONAL_BREAK_CHOICES = [30, 45, 60] as const;
export const BLOCK_CHOICE_KEYS: Record<(typeof OPERATIONAL_BLOCK_CHOICES)[number], TranslationKey> = {
  240: 'shiftrec.ops.block.240',
  270: 'shiftrec.ops.block.270',
  285: 'shiftrec.ops.block.285',
};

/** The named choices, plus the current value when it is not one of them (a free entry must stay visible). */
export function withCurrentChoice(choices: readonly number[], current: number): { value: number; custom: boolean }[] {
  const options = choices.map(value => ({ value, custom: false }));
  return choices.includes(current) ? options : [...options, { value: current, custom: true }];
}

/** The target in cents, null when the text is not an amount ≥ 0. */
export function targetRevenueCents(text: string): number | null {
  return thresholdCents(text);
}

/** Whole euros of a month's revenue, as the text the target field starts with. */
export function defaultTargetText(monthlyRevenueCents: number | null): string {
  if (monthlyRevenueCents === null || !Number.isFinite(monthlyRevenueCents) || monthlyRevenueCents <= 0) return '';
  return String(Math.round(monthlyRevenueCents / 100));
}

/** The whole euros under the history's average rate, as the text the field starts with. */
export function defaultThresholdText(revenuePerHourCents: number | null): string {
  if (revenuePerHourCents === null || !Number.isFinite(revenuePerHourCents)) return '0';
  return String(Math.max(0, Math.floor(revenuePerHourCents / 100)));
}

export function defaultPlanForm(revenuePerHourCents: number | null, monthlyRevenueCents: number | null = null): PlanForm {
  return {
    mode: 'target',
    targetText: defaultTargetText(monthlyRevenueCents),
    thresholdText: defaultThresholdText(revenuePerHourCents),
    ...DEFAULT_PLAN_SETTINGS,
  };
}

/** null when the threshold is not an amount: the screen says so instead of planning with a guess. */
export function thresholdCents(text: string): number | null {
  const cents = parseGermanAmountToCents(text.trim());
  return cents === null || cents < 0 ? null : cents;
}

export function planSettingsFromForm(form: PlanForm): PlanSettings | null {
  const threshold = thresholdCents(form.thresholdText);
  if (threshold === null) return null;
  return {
    minShiftMinutes: form.minShiftMinutes,
    maxShiftMinutes: form.maxShiftMinutes,
    minBreakMinutes: form.minBreakMinutes,
    maxShiftsPerVehiclePerDay: form.maxShiftsPerVehiclePerDay,
    minRevenuePerHourCents: threshold,
  };
}

/**
 * The settings without a threshold, for planning towards a target: the search
 * chooses the threshold, so the form's threshold text is not read at all.
 */
export function targetPlanSettingsFromForm(form: PlanForm): Omit<PlanSettings, 'minRevenuePerHourCents'> {
  return {
    minShiftMinutes: form.minShiftMinutes,
    maxShiftMinutes: form.maxShiftMinutes,
    minBreakMinutes: form.minBreakMinutes,
    maxShiftsPerVehiclePerDay: form.maxShiftsPerVehiclePerDay,
  };
}

/** A usable block gap from the company's setting, else the default. A stored value is a preference, not a promise. */
export function effectiveBlockGap(stored: number | null | undefined, fallback: number): number {
  return typeof stored === 'number' && Number.isFinite(stored) && stored >= 0 ? stored : fallback;
}

// ── Dictionary keys for the engine's codes ──────────────────────────────────

export const PROBLEM_KEYS: Record<SettingsProblem, TranslationKey> = {
  slot_minutes_unsupported: 'shiftrec.problem.slot_minutes_unsupported',
  operating_day_start_invalid: 'shiftrec.problem.operating_day_start_invalid',
  block_gap_invalid: 'shiftrec.problem.block_gap_invalid',
  min_evidence_days_invalid: 'shiftrec.problem.min_evidence_days_invalid',
  min_shift_invalid: 'shiftrec.problem.min_shift_invalid',
  max_shift_invalid: 'shiftrec.problem.max_shift_invalid',
  max_shift_above_limit: 'shiftrec.problem.max_shift_above_limit',
  min_shift_above_max: 'shiftrec.problem.min_shift_above_max',
  shift_not_slot_multiple: 'shiftrec.problem.shift_not_slot_multiple',
  min_break_invalid: 'shiftrec.problem.min_break_invalid',
  max_shifts_per_day_invalid: 'shiftrec.problem.max_shifts_per_day_invalid',
  min_revenue_per_hour_invalid: 'shiftrec.problem.min_revenue_per_hour_invalid',
};

export const EXCLUSION_KEYS: Record<ProfileExclusionReason, TranslationKey> = {
  cancelled: 'shiftrec.exclusion.cancelled',
  status_unknown: 'shiftrec.exclusion.status_unknown',
  missing_vehicle: 'shiftrec.exclusion.missing_vehicle',
  missing_start: 'shiftrec.exclusion.missing_start',
  missing_end: 'shiftrec.exclusion.missing_end',
  end_before_start: 'shiftrec.exclusion.end_before_start',
  implausible_duration: 'shiftrec.exclusion.implausible_duration',
  ambiguous_local_time: 'shiftrec.exclusion.ambiguous_local_time',
  unpriced: 'shiftrec.exclusion.unpriced',
};

export const CONFIDENCE_KEYS: Record<Confidence, TranslationKey> = {
  high: 'shiftrec.confidence.high',
  medium: 'shiftrec.confidence.medium',
  low: 'shiftrec.confidence.low',
};

/** Monday … Sunday, matching the engine's `DayType`. */
export const WEEKDAY_KEYS: readonly TranslationKey[] = [
  'fleet.weekday.mon', 'fleet.weekday.tue', 'fleet.weekday.wed', 'fleet.weekday.thu',
  'fleet.weekday.fri', 'fleet.weekday.sat', 'fleet.weekday.sun',
];

export const REGION_KEYS: Record<(typeof HOLIDAY_REGIONS)[number], TranslationKey> = {
  BW: 'shiftrec.region.BW', BY: 'shiftrec.region.BY', BE: 'shiftrec.region.BE', BB: 'shiftrec.region.BB',
  HB: 'shiftrec.region.HB', HH: 'shiftrec.region.HH', HE: 'shiftrec.region.HE', MV: 'shiftrec.region.MV',
  NI: 'shiftrec.region.NI', NW: 'shiftrec.region.NW', RP: 'shiftrec.region.RP', SL: 'shiftrec.region.SL',
  SN: 'shiftrec.region.SN', ST: 'shiftrec.region.ST', SH: 'shiftrec.region.SH', TH: 'shiftrec.region.TH',
};

/** The exclusion reasons that actually occurred, most frequent first. */
export function exclusionRows(
  excluded: Readonly<Record<ProfileExclusionReason, number>>,
): { reason: ProfileExclusionReason; count: number }[] {
  return (Object.keys(excluded) as ProfileExclusionReason[])
    .map(reason => ({ reason, count: excluded[reason] }))
    .filter(row => row.count > 0)
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

// ── The heatmap ─────────────────────────────────────────────────────────────

/**
 * Shade classes, written out in full because Tailwind finds a class by reading
 * the source: a class assembled from a template would never be generated.
 * The middle step is the operator's threshold, so "dark" reads as "worth it".
 */
const NO_EVIDENCE_CLASS = 'bg-sunken';
const SHADES = ['bg-brand/10', 'bg-brand/25', 'bg-brand/40', 'bg-brand/60', 'bg-brand/80'] as const;
/** Upper bounds of the rate relative to the threshold, one per shade but the last. */
const SHADE_LIMITS = [0.5, 1, 1.25, 1.5] as const;

/** null = too little evidence; a threshold of 0 cannot be a ratio, so every rated hour is "above". */
export function heatClass(rateCents: number | null, thresholdCentsValue: number): string {
  if (rateCents === null) return NO_EVIDENCE_CLASS;
  if (thresholdCentsValue <= 0) return SHADES[SHADES.length - 1];
  const ratio = rateCents / thresholdCentsValue;
  const step = SHADE_LIMITS.findIndex(limit => ratio < limit);
  return step === -1 ? SHADES[SHADES.length - 1] : SHADES[step];
}

export const HEAT_LEGEND: readonly string[] = SHADES;
export const HEAT_NO_EVIDENCE_CLASS = NO_EVIDENCE_CLASS;

// ── Shift rows ──────────────────────────────────────────────────────────────

export interface ShiftRow {
  id: string;
  vehicle: string;
  /**
   * The OPERATING day, 'YYYY-MM-DD' — the day the weekday, the holiday mark and
   * the profile all belong to. A Friday-night shift from 01:00 to 04:00 is
   * Friday's, and is shown as Friday with both times marked (+1), never as a
   * Saturday date beside a Friday weekday.
   */
  date: string;
  /** Operating date, then position: a 01:00 (+1) shift sorts after 22:00, as it happens. */
  sortKey: string;
  dayType: DayType;
  isHoliday: boolean;
  startTime: string;
  endTime: string;
  /** The start is on the calendar day after the operating day: "01:00 (+1)". */
  startsNextDay: boolean;
  /** The end is on the calendar day after the operating day: "22:00 – 02:00 (+1)". */
  endsNextDay: boolean;
  minutes: number;
  expectedRevenueCents: number;
  expectedRevenuePerHourCents: number;
  evidenceDays: number;
  confidence: Confidence;
}

export function shiftRows(shifts: readonly RecommendedShift[]): ShiftRow[] {
  return shifts.map(s => ({
    id: s.id,
    vehicle: s.vehicle,
    date: s.operatingDate,
    sortKey: `${s.operatingDate}#${String(s.startPosition).padStart(3, '0')}`,
    dayType: s.dayType,
    isHoliday: s.isHoliday,
    startTime: s.start.time,
    endTime: s.end.time,
    startsNextDay: s.start.date !== s.operatingDate,
    endsNextDay: s.end.date !== s.operatingDate,
    minutes: s.minutes,
    expectedRevenueCents: s.expectedRevenueCents,
    expectedRevenuePerHourCents: s.expectedRevenuePerHourCents,
    evidenceDays: s.evidenceDays,
    confidence: s.confidence,
  }));
}

/** "01:00 (+1)" for a time on the calendar day after the operating day. The mark is a symbol, not language. */
export function timeLabel(time: string, nextDay: boolean): string {
  return nextDay ? `${time} (+1)` : time;
}

/** '' = all vehicles. */
export function filterShiftRows(rows: readonly ShiftRow[], vehicle: string): ShiftRow[] {
  return vehicle === '' ? [...rows] : rows.filter(r => r.vehicle === vehicle);
}

/** Per-month figures to hours with one decimal, for a KPI: 612 min → 10,2. */
export function minutesToHours(minutes: number): number {
  return Math.round((minutes / 60) * 10) / 10;
}

// ── Excel ───────────────────────────────────────────────────────────────────

export interface ShiftExportLabels {
  sheetTitle: string;
  moduleName: string;
  total: string;
  date: string;
  weekday: string;
  vehicle: string;
  from: string;
  to: string;
  hours: string;
  revenue: string;
  rate: string;
  evidence: string;
  confidence: string;
  /** Resolved weekday names, Monday first. */
  weekdays: readonly string[];
  /** Resolved confidence words. */
  confidences: Readonly<Record<Confidence, string>>;
  holiday: string;
}

/**
 * The sheet `exportTableToExcel` draws. Headers follow the UI language: this is
 * an operational list, not a statutory form. Money is a euro NUMBER in a money
 * column so Excel can sum it. The expected figures are estimates and the sheet
 * title says so, because a file travels without its screen.
 */
export function shiftExportOptions(
  rows: readonly ShiftRow[],
  target: YearMonth,
  labels: ShiftExportLabels,
  filterSummary: string[] = [],
): ExportOptions {
  const totalMinutes = rows.reduce((sum, r) => sum + r.minutes, 0);
  const totalCents = rows.reduce((sum, r) => sum + r.expectedRevenueCents, 0);
  return {
    filename: `schichtempfehlung_${monthKey(target)}`,
    sheetTitle: labels.sheetTitle,
    moduleName: labels.moduleName,
    filterSummary,
    columns: [
      { key: 'date', label: labels.date, width: 14 },
      { key: 'weekday', label: labels.weekday, width: 12 },
      { key: 'vehicle', label: labels.vehicle, width: 18 },
      { key: 'from', label: labels.from, width: 10 },
      { key: 'to', label: labels.to, width: 14 },
      { key: 'hours', label: labels.hours, width: 12, type: 'number' },
      { key: 'revenue', label: labels.revenue, width: 20, type: 'money' },
      { key: 'rate', label: labels.rate, width: 20, type: 'money' },
      { key: 'evidence', label: labels.evidence, width: 12, type: 'integer' },
      { key: 'confidence', label: labels.confidence, width: 14 },
    ],
    rows: rows.map(r => ({
      date: germanDate(r.date) + (r.isHoliday ? ` (${labels.holiday})` : ''),
      weekday: labels.weekdays[r.dayType] ?? '',
      vehicle: r.vehicle,
      from: timeLabel(r.startTime, r.startsNextDay),
      to: timeLabel(r.endTime, r.endsNextDay),
      hours: Math.round((r.minutes / 60) * 100) / 100,
      revenue: r.expectedRevenueCents / 100,
      rate: r.expectedRevenuePerHourCents / 100,
      evidence: r.evidenceDays,
      confidence: labels.confidences[r.confidence],
    })),
    totals: {
      hours: Math.round((totalMinutes / 60) * 100) / 100,
      revenue: totalCents / 100,
    },
    labels: { totalsRow: labels.total },
  };
}

/** 'YYYY-MM-DD' → 'DD.MM.YYYY'; anything else is returned as it came. */
export function germanDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : isoDate;
}

// ── A read or build that may throw ──────────────────────────────────────────

export type Attempt<T> = { ok: true; value: T } | { ok: false };

/** Runs `fn`; a throw becomes a failed attempt, so a screen can say so instead of showing an empty result. */
export function attempt<T>(fn: () => T): Attempt<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    console.error('Schichtempfehlung: calculation failed', error);
    return { ok: false };
  }
}
