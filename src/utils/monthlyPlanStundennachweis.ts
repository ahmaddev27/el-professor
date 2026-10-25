/**
 * §11 — one Stundennachweis per driver, built from a **confirmed monthly plan**.
 *
 * Pure: no supabase, no React, and no value imported from `jspdf` (the renderer
 * is imported for its types, and lazily for the download helper at the bottom),
 * so a test runs this in node without a canvas.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE RULES THIS PRESERVES, STATED BEFORE THE CODE
 * ────────────────────────────────────────────────────────────────────────────
 *
 * **1. One source. This module recomputes no planning decision.**
 * §12: "the totals must come from the same plan data used in the Stundennachweis"
 * (acceptance criterion 22). Every figure below is derived from the stored plan
 * — `monthly_plan_blocks` (its absolute bounds, its span and ride minutes, its
 * driver) and `monthly_plan_drivers` (the per-driver snapshot). Nothing here
 * rebuilds a block, re-assigns a driver or reads `fahrtenbuch_trips`. That is
 * not a style preference: the product already has **two** Stundennachweis
 * builders that disagree (`MonatsplanungStundennachweisPreview` and
 * `FinalizePlanningModal`, the latter hard-coding `isHol: false` and so losing
 * every holiday hour), and this must not become a third rule.
 *
 * **2. Compression merges for display and changes no figure.**
 * CLAUDE.md: "Schicht compression (max 3 shifts/day) is display- and
 * export-only. It must not alter stored minutes, premium buckets, or Brutto
 * figures." §11: "Do not drop any period when a day has more than three shifts;
 * use an explicit merge rule or an extra page."
 *
 * So the day is measured **twice, from two different sets of windows**:
 *
 *   · the **paid** figures come from `assessDay(...)`'s merged windows — the
 *     day's real periods, overlaps merged, nothing compressed;
 *   · the three printed Von/Bis pairs come from `compressToThree(...)` of those
 *     same windows.
 *
 * `compressToThree` closes the gap between two periods to show them as one, so
 * its windows are **longer** than the work. Reading minutes off them is the
 * defect this module exists to avoid: `MonatsplanungStundennachweisPreview`
 * recomputes `seg_minutes` from the merged timestamps after compressing, so the
 * gap between two shifts is paid — and 92.5% of driver-days are compressed
 * (measured on staging, 26.09.2026), so it is wrong for nearly every driver.
 * A day with more than three periods therefore prints three pairs, a `(n)`
 * marker naming the real count, and a note; its totals still count all n.
 *
 * **3. A gap *inside* a block is paid; a gap *between* blocks is not.**
 * This is the one place the two figures §3 stores per block are spent, and it is
 * the rule the product already follows, not a new one. A block is the vehicle's
 * continuous engagement: rides closer together than the switch duration cannot
 * be given to another driver, so the driver holds the car across the idle time.
 * Every existing implementation pays block start → block end. So the paid window
 * is the block's **span**, and `ride_minutes` is reported beside it as the other
 * half of the idle share, never subtracted here. Between two blocks the driver
 * is off and the car may go to somebody else — which is exactly why compression
 * may not absorb that gap.
 *
 * **4. This plans a month that has not happened, so every output says so.**
 * The header line, and the `_PLANUNG_` in the filename. Nothing in this module
 * writes anything: no `fahrtenbuch_trips`, and no `saved_stundennachweise`
 * either — that table is the statutory archive, keyed per driver and month, and
 * a proposal in it would overwrite a real record.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE PREMIUM BUCKETS
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `computeLohnartSeconds` and `getGermanNationalHolidays` from the clean engine,
 * which are the only premium computation in this project under golden-master
 * tests (`src/utils/lohnart.golden.test.ts`, `holidays.golden.test.ts`). The
 * `new_month` path's own `computeNightBuckets` is deliberately **not** copied.
 *
 * Two consequences a reader must know, because they are visible on the paper:
 *
 *   · **The night window starts at 20:00 here, not 23:00.** The clean engine's
 *     `night25Sec` is 20:00–24:00 plus 04:00–06:00; `computeNightBuckets` in
 *     `MonatsplanungStundennachweisPreview` uses 23:00–24:00 plus 04:00–06:00.
 *     The two disagree (Docs/audit/FINDINGS.md H20) and the 20:00 boundary is
 *     the one §3b EStG names. Nobody in this project has checked either against
 *     the statute, so this is a recorded difference, not a claim of correctness:
 *     a planning Stundennachweis shows more Nachtarbeit than the `new_month`
 *     one for the same evening shift.
 *   · **`night25Sec` and `night40Sec` are already mutually exclusive**, which is
 *     CLAUDE.md's rule for Lohnart 1500 and 1501 exactly: `1500 = nightSec −
 *     night0to4Sec` is the clean engine's `night25Sec`, and `1501 =
 *     night0to4Sec` its `night40Sec`. Nothing is added or subtracted here, so
 *     the two can never double-count.
 *
 * `sundaySec` and `holidaySec` are **not** a partition — each is the whole
 * overlap with a Sunday or a holiday calendar day, so on a holiday that is also
 * a Sunday both carry the day (FINDINGS.md H19). The form has one column each,
 * and all three existing builders print Sonntag as `isSun && !isHol`. That
 * column rule is kept — Feiertag wins — and the clean engine's unsuppressed
 * figure is carried on the day as `sonntagMinutesCumulated`, so nothing is
 * hidden from a reviewer. This is a column mapping, not a fourth premium engine.
 *
 * `getGermanNationalHolidays` is **national only and counts Ostersonntag**,
 * which is a statutory holiday nowhere in Germany but Brandenburg. So a shift on
 * Easter Sunday reads as Feiertag here (and Sonntag reads 0, by the column
 * rule), and a Bavarian company's Fronleichnam does not read as Feiertag at all.
 * `germanHolidays.ts` has the Bundesland table and excludes Ostersonntag; the
 * two disagree every year and the golden masters pin the difference. Swapping
 * tables is a payroll decision, not a documents one.
 */

import {
  assessDay,
  compressToThree,
  MAX_DAY_MINUTES,
  MAX_SHIFT_MINUTES,
  type DayWindow,
} from './shiftDayLimits';
import {
  computeLohnartSeconds,
  getGermanNationalHolidays,
} from './historicalWorkingHoursCleanEngine';
import type {
  PdfDayRow,
  PdfNote,
  PdfTotals,
  StundennachweisExportData,
} from './stundennachweisPdfExport';

// ── Document text ────────────────────────────────────────────────────────────
// German in both UI languages, and it lives here rather than in a dictionary:
// CLAUDE.md's closed list of generated documents names the Stundennachweis, and
// these strings are drawn into a statutory form. The preview renders that same
// form, so it reads these same constants.

/** The header line §1's fourth screen requires on every planning document. */
export const PLANNING_NOTICE = 'PLANUNG / VORSCHAU — kein Arbeitszeitnachweis';

/** The marker every planning filename carries. */
export const PLANNING_FILENAME_MARKER = 'PLANUNG';

const MONTH_NAMES_DE: string[] = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

const WEEKDAY_SHORT_DE: string[] = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** The month's German name, or a neutral word for a month number out of range. */
function monthNameDe(month: number): string {
  return month >= 1 && month <= 12 ? MONTH_NAMES_DE[month - 1] : 'Monat';
}

/**
 * The form's six duration columns, in order, so the on-screen preview draws the
 * same sheet the PDF prints. Samstag is computed and deliberately has no column
 * — the renderer says so too.
 */
export const PLAN_STUNDENNACHWEIS_COLUMNS = [
  { key: 'grundlohn',     label: 'Grundlohn'          },
  { key: 'nachtarbeit',   label: 'Nachtarbeit'        },
  { key: 'nachtarbeit04', label: 'Nacht 0–4 Uhr'      },
  { key: 'sonntag',       label: 'Sonntag'            },
  { key: 'feiertag',      label: 'Feiertag'           },
  { key: 'weihnachten',   label: 'Weihnachten/1. Mai' },
] as const;

// ── The stored plan, as the four tables of 20260930100000 hold it ────────────

/** One row of `monthly_plan_block_trips`, as far as a document reads it. */
export interface StoredPlanBlockTrip {
  tripId: string;
  startsAt: string;
  endsAt: string;
  minutes: number;
}

/** One row of `monthly_plan_blocks`, with its rides. */
export interface StoredPlanBlock {
  blockKey: string;
  carId: string | null;
  carIdentifier: string | null;
  startsAt: string;
  endsAt: string;
  spanMinutes: number;
  rideMinutes: number;
  /** NULL is an unassigned block (§8). It belongs to no document and is reported. */
  driverId: string | null;
  driverName: string | null;
  trips?: readonly StoredPlanBlockTrip[];
}

/**
 * One row of `monthly_plan_drivers` — the §13 snapshot, as far as a document
 * needs it.
 *
 * `personalnummer` is **not a column of that table** and is not invented here:
 * the snapshot stores §4's eight planning values and the driver's name, nothing
 * else. It is accepted as an optional value a caller may pass from the live
 * `drivers` row, it appears only under the name on the sheet, and it enters no
 * figure. Left out, the sheet simply has no Pers.-Nr. line.
 */
export interface StoredPlanDriver {
  driverId: string;
  driverName: string;
  isOwner: boolean;
  selected?: boolean;
  personalnummer?: string | null;
}

export interface StoredMonthlyPlan {
  year: number;
  /** 1–12, as the column stores it. */
  month: number;
  status: 'draft' | 'confirmed' | 'superseded';
  /** True when any ride behind the plan is simulated; the document says so. */
  simulated: boolean;
  drivers: readonly StoredPlanDriver[];
  blocks: readonly StoredPlanBlock[];
}

// ── What comes out ───────────────────────────────────────────────────────────

/** One period of one calendar day. After the midnight split, never both days. */
export interface PlanDayShift {
  startMs: number;
  endMs: number;
  /** Integer minutes of this period. */
  minutes: number;
  /** `HH:MM`, local. */
  startLabel: string;
  /** `HH:MM`, local, and `24:00` for a period running to the end of the day. */
  endLabel: string;
  /**
   * How many of the day's real periods this one stands for. 1 everywhere except
   * in `displayShifts`, where compression merged several into one column pair.
   */
  mergedFrom: number;
}

export interface PlanDayHours {
  /** `YYYY-MM-DD`, local. */
  dateKey: string;
  /** German short weekday, as the form prints it. */
  weekday: string;
  isSaturday: boolean;
  isSunday: boolean;
  isHoliday: boolean;
  /** The day's real periods, overlaps merged, nothing compressed. Pay reads these. */
  shifts: PlanDayShift[];
  /** At most three, for the Von/Bis columns only. */
  displayShifts: PlanDayShift[];
  /** `shifts.length > 3`, so the columns show fewer pairs than the day has. */
  compressed: boolean;
  /** The Grundlohn column: the day's worked minutes. Never from a compressed window. */
  workedMinutes: number;
  /** Lohnart 1500, the clean engine's `night25Sec`. */
  nachtarbeitMinutes: number;
  /** Lohnart 1501, the clean engine's `night40Sec`. Never overlaps the line above. */
  nacht0bis4Minutes: number;
  /** The Sonntag column: 0 on a holiday, because Feiertag wins there. */
  sonntagMinutes: number;
  /** The clean engine's unsuppressed Sunday figure, cumulated with Feiertag (H19). */
  sonntagMinutesCumulated: number;
  feiertagMinutes: number;
  weihnachtenMinutes: number;
  /** Computed, and the form has no column for it. */
  samstagMinutes: number;
  longestShiftMinutes: number;
  exceedsDayLimit: boolean;
  exceedsShiftLimit: boolean;
}

/** Minutes per column, the unit `PdfTotals` is in. */
export interface PlanHoursTotals {
  grundlohn: number;
  nachtarbeit: number;
  nacht04: number;
  sonntag: number;
  feiertag: number;
  weihnachten: number;
  samstag: number;
}

/** A period of an assigned block that falls outside the planned month. */
export interface PlanCarryOver {
  dateKey: string;
  startLabel: string;
  endLabel: string;
  minutes: number;
}

export type PlanDocumentProblemKind =
  | 'source_incomplete'
  | 'block_without_driver'
  | 'driver_not_in_snapshot'
  | 'block_ends_before_start'
  | 'block_minutes_disagree'
  | 'period_outside_month';

export interface PlanDocumentProblem {
  kind: PlanDocumentProblemKind;
  /** German, for the screen. A document problem is not a translated label. */
  detail: string;
  driverId?: string | null;
  blockKey?: string | null;
  dateKey?: string | null;
  /** True withholds the document: a figure that cannot be trusted is not exported. */
  blocking: boolean;
}

export interface MonthlyPlanStundennachweis {
  driverId: string;
  driverName: string;
  isOwner: boolean;
  /** One entry per calendar day of the planned month, always the whole month. */
  days: PlanDayHours[];
  totals: PlanHoursTotals;
  assignedBlockCount: number;
  /** Sum of the assigned blocks' stored `span_minutes`. The plan's own figure. */
  planBlockMinutes: number;
  /** Sum of the assigned blocks' stored `ride_minutes`. The idle share's other half. */
  planRideMinutes: number;
  carryOver: PlanCarryOver[];
  problems: PlanDocumentProblem[];
  /** False when a problem is blocking. The screen must neither show nor export it. */
  exportable: boolean;
  /** Exactly what `exportStundennachweisAsPdf` / `getStundennachweisBlob` take. */
  exportData: StundennachweisExportData;
  /** Without the `.pdf` suffix, which the renderer appends. */
  filename: string;
}

export interface MonthlyPlanStundennachweisSet {
  year: number;
  month: number;
  /** `Mai 2026`. German, like the sheet. */
  monthLabel: string;
  /** The header line every document carries, generation date included. */
  noticeLine: string;
  drivers: MonthlyPlanStundennachweis[];
  unassignedBlockCount: number;
  unassignedBlockMinutes: number;
  problems: PlanDocumentProblem[];
  /** True when nothing may be shown or exported — a failed load, above all. */
  withheld: boolean;
}

export interface BuildPlanStundennachweisOptions {
  /**
   * The clock, so a test is deterministic and the printed generation date is the
   * caller's. Defaults to now.
   */
  generatedAt?: Date;
  /**
   * False when the screen's read of the plan failed or came back short. The
   * result is then withheld whole: an empty sheet and a total of 0,00 are
   * claims (CLAUDE.md), and a Stundennachweis is the worst place to make one.
   */
  dataComplete?: boolean;
}

// ── Local-calendar helpers ───────────────────────────────────────────────────
// Every boundary is resolved per calendar day with `new Date(y, m, d)`, which is
// what makes this DST-correct: the day after a 23-hour day is still its own
// midnight, and adding 86_400_000 would not find it.

const MS_PER_MINUTE = 60_000;

function nextLocalMidnightOf(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

function dateKeyOf(ms: number): string {
  const d = new Date(ms);
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mo}-${day}`;
}

function clockLabel(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** `dd.MM.yyyy`, never a US order. */
function germanDate(ms: number): string {
  const d = new Date(ms);
  const day = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${mo}.${d.getFullYear()}`;
}

/**
 * Decimal hours with a German comma, and empty for zero.
 *
 * Decimal rather than `H:MM`, because the renderer's own totals row is labelled
 * "Summe (Dez.)" and prints decimal whatever the cells hold. The two existing
 * builders disagree here — one prints `H:MM` cells above a decimal total — and
 * one unit per sheet is the only way a reader can add a column up. §16's own
 * figure is decimal too: 81 minutes is 1,35 hours.
 *
 * Exported because the on-screen preview draws the same sheet: the row cells it
 * reads are already formatted, but the totals row is in minutes, and a screen
 * formatting that itself would be a second opinion about the same figure.
 */
export function formatPlanHours(minutes: number): string {
  if (minutes === 0) return '';
  return (minutes / 60).toFixed(2).replace('.', ',');
}

/** Integer minutes from seconds, rounded once. */
function minutesFromSeconds(seconds: number): number {
  return Math.round(seconds / 60);
}

/**
 * Cuts a span at every local midnight it crosses, so one period never lands on
 * two rows of a monthly form.
 */
function splitAtLocalMidnight(span: DayWindow): DayWindow[] {
  const out: DayWindow[] = [];
  let cursor = span.startMs;
  while (cursor < span.endMs) {
    const boundary = nextLocalMidnightOf(cursor);
    // A boundary that does not advance would loop for ever. It cannot happen for
    // a real instant, and the guard costs nothing.
    if (boundary <= cursor) break;
    const end = Math.min(boundary, span.endMs);
    out.push({ startMs: cursor, endMs: end });
    cursor = end;
  }
  return out;
}

function toPlanDayShift(span: DayWindow, mergedFrom: number): PlanDayShift {
  const endsAtMidnight = span.endMs === nextLocalMidnightOf(span.startMs);
  return {
    startMs: span.startMs,
    endMs: span.endMs,
    minutes: Math.round((span.endMs - span.startMs) / MS_PER_MINUTE),
    startLabel: clockLabel(span.startMs),
    // A period running to the end of the day reads 24:00: 00:00 would look like
    // a zero-length shift, and 23:59 would claim a minute was not worked.
    endLabel: endsAtMidnight ? '24:00' : clockLabel(span.endMs),
    mergedFrom,
  };
}

/** How many of `merged` a compressed span covers. */
function countCovered(compressed: DayWindow, merged: readonly DayWindow[]): number {
  let n = 0;
  for (const m of merged) {
    if (m.startMs >= compressed.startMs && m.endMs <= compressed.endMs) n++;
  }
  return n === 0 ? 1 : n;
}

function isWeihnachtenOrErsterMai(ms: number): boolean {
  const d = new Date(ms);
  const month = d.getMonth();
  const day = d.getDate();
  return (month === 11 && (day === 25 || day === 26)) || (month === 4 && day === 1);
}

// ── The build ────────────────────────────────────────────────────────────────

/** `Stundennachweis_PLANUNG_<Fahrer>_<Monat>_<Jahr>`, without the extension. */
export function monthlyPlanStundennachweisFilename(
  driverName: string,
  month: number,
  year: number,
): string {
  const safe = (driverName || 'Fahrer').replace(/[/\\:*?"<>|\s]+/g, '_');
  const monthName = monthNameDe(month);
  return `Stundennachweis_${PLANNING_FILENAME_MARKER}_${safe}_${monthName}_${year}`;
}

/** The header line, with the date the document was generated. */
export function planningNoticeLine(generatedAt: Date): string {
  return `${PLANNING_NOTICE} · Erstellt am ${germanDate(generatedAt.getTime())}`;
}

/**
 * Holidays for the planned month, plus the year on either side so a December
 * plan's carry-over into January, and a period reaching back out of December,
 * are classified rather than silently read as ordinary days.
 */
function holidaysAround(year: number): Set<string> {
  const set = new Set<string>();
  for (const y of [year - 1, year, year + 1]) {
    for (const key of getGermanNationalHolidays(y)) set.add(key);
  }
  return set;
}

interface DriverWork {
  driverId: string;
  driverName: string;
  windows: DayWindow[];
  blockCount: number;
  spanMinutes: number;
  rideMinutes: number;
  problems: PlanDocumentProblem[];
}

/**
 * Measures one calendar day. The two sets of windows of rule 2 are produced
 * here, and the paid figures never touch the compressed one.
 */
function measureDay(
  dayMs: number,
  windows: readonly DayWindow[],
  holidays: Set<string>,
): PlanDayHours {
  const dateKey = dateKeyOf(dayMs);
  const weekdayIndex = new Date(dayMs).getDay();
  const isSunday = weekdayIndex === 0;
  const isSaturday = weekdayIndex === 6;
  const isHoliday = holidays.has(dateKey);

  const assessed = assessDay([...windows]);
  const merged = assessed.merged;

  let night25Sec = 0;
  let night40Sec = 0;
  let sundaySec = 0;
  let holidaySec = 0;
  for (const m of merged) {
    const lohnart = computeLohnartSeconds(m.startMs, m.endMs, holidays);
    night25Sec += lohnart.night25Sec;
    night40Sec += lohnart.night40Sec;
    sundaySec += lohnart.sundaySec;
    holidaySec += lohnart.holidaySec;
  }

  const workedMinutes = Math.round(assessed.dayMinutes);
  const sonntagMinutesCumulated = minutesFromSeconds(sundaySec);
  const feiertagMinutes = minutesFromSeconds(holidaySec);

  const compressedWindows = compressToThree(merged);

  return {
    dateKey,
    weekday: WEEKDAY_SHORT_DE[weekdayIndex],
    isSaturday,
    isSunday,
    isHoliday,
    shifts: merged.map(m => toPlanDayShift(m, 1)),
    displayShifts: compressedWindows.map(c => toPlanDayShift(c, countCovered(c, merged))),
    compressed: merged.length > 3,
    workedMinutes,
    nachtarbeitMinutes: minutesFromSeconds(night25Sec),
    nacht0bis4Minutes: minutesFromSeconds(night40Sec),
    // The column rule all three existing builders use: Feiertag wins, so a
    // holiday Sunday is not paid twice on the sheet. The unsuppressed figure is
    // kept beside it rather than thrown away.
    sonntagMinutes: isHoliday ? 0 : sonntagMinutesCumulated,
    sonntagMinutesCumulated,
    feiertagMinutes,
    weihnachtenMinutes: isWeihnachtenOrErsterMai(dayMs) && workedMinutes > 0 ? workedMinutes : 0,
    samstagMinutes: isSaturday ? workedMinutes : 0,
    longestShiftMinutes: Math.round(assessed.longestShiftMinutes),
    exceedsDayLimit: assessed.exceedsDayLimit,
    exceedsShiftLimit: assessed.exceedsShiftLimit,
  };
}

/**
 * Notes the sheet prints verbatim.
 *
 * They go in `notes` and not in `warnings` on purpose: the renderer passes
 * `warnings` through `categorizeWarnings`, which prints only a **count** for the
 * `shift` and `transfer` categories — so a compression statement routed there
 * would appear as "3 Schichtregeln" and never name a day. `notes` is printed
 * date, type and text, for every entry. The alternative, wording each line to
 * hit a category whose text is printed, would mean bending document text to a
 * discriminator, which is the fragile half of `warningCategories`.
 */
function buildNotes(days: readonly PlanDayHours[], carryOver: readonly PlanCarryOver[]): PdfNote[] {
  const notes: PdfNote[] = [];

  for (const day of days) {
    if (day.compressed) {
      notes.push({
        note_date: day.dateKey,
        note_type: 'Zusammengefasste Schichten',
        note_text: `${day.shifts.length} Zeiträume in drei Spalten zusammengefasst. `
          + `Die Summen enthalten alle ${day.shifts.length}; die angezeigten Zeiten `
          + 'sind die zusammengefassten Zeitfenster.',
      });
    }
    if (day.exceedsDayLimit) {
      notes.push({
        note_date: day.dateKey,
        note_type: 'Arbeitszeit über Tagesgrenze',
        note_text: `${(day.workedMinutes / 60).toFixed(2).replace('.', ',')} Stunden `
          + `geplant, Grenze ${Math.floor(MAX_DAY_MINUTES / 60)}:`
          + `${String(MAX_DAY_MINUTES % 60).padStart(2, '0')}.`,
      });
    }
    if (day.exceedsShiftLimit) {
      notes.push({
        note_date: day.dateKey,
        note_type: 'Schicht über Einzelgrenze',
        note_text: `Längste Schicht ${(day.longestShiftMinutes / 60).toFixed(2).replace('.', ',')} `
          + `Stunden, Grenze ${Math.floor(MAX_SHIFT_MINUTES / 60)}:`
          + `${String(MAX_SHIFT_MINUTES % 60).padStart(2, '0')}.`,
      });
    }
  }

  for (const c of carryOver) {
    notes.push({
      note_date: c.dateKey,
      note_type: 'Außerhalb des Planmonats',
      note_text: `${c.startLabel}–${c.endLabel} (${c.minutes} Min.) liegt nach dem `
        + 'Planmonat und ist in den Summen dieses Monats nicht enthalten.',
    });
  }

  return notes;
}

function buildOneDriver(
  work: DriverWork,
  plan: StoredMonthlyPlan,
  snapshot: StoredPlanDriver | undefined,
  holidays: Set<string>,
  noticeLine: string,
): MonthlyPlanStundennachweis {
  // Merge the driver's block windows across the whole month before splitting, so
  // two blocks that overlap (which §7 rule 2 forbids, and a broken plan could
  // still hold) contribute their minutes once rather than twice.
  const monthMerged = assessDay(work.windows).merged;

  const byDay = new Map<string, DayWindow[]>();
  const carryOver: PlanCarryOver[] = [];
  const problems = [...work.problems];

  for (const span of monthMerged) {
    for (const piece of splitAtLocalMidnight(span)) {
      const d = new Date(piece.startMs);
      const inMonth = d.getFullYear() === plan.year && d.getMonth() === plan.month - 1;
      if (!inMonth) {
        // §11 forbids dropping a period. A monthly form has no row outside its
        // month, so the period is named on the sheet instead of vanishing —
        // which is what the existing builder does, its `byDate.get(key)` simply
        // missing it. It is excluded from this month's totals because it belongs
        // to the next month's sheet.
        const shift = toPlanDayShift(piece, 1);
        const entry: PlanCarryOver = {
          dateKey: dateKeyOf(piece.startMs),
          startLabel: shift.startLabel,
          endLabel: shift.endLabel,
          minutes: shift.minutes,
        };
        carryOver.push(entry);
        problems.push({
          kind: 'period_outside_month',
          detail: `${germanDate(piece.startMs)} ${entry.startLabel}–${entry.endLabel} `
            + `(${entry.minutes} Min.) liegt außerhalb des Planmonats.`,
          driverId: work.driverId,
          dateKey: entry.dateKey,
          blocking: false,
        });
        continue;
      }
      const key = dateKeyOf(piece.startMs);
      const list = byDay.get(key);
      if (list) list.push(piece);
      else byDay.set(key, [piece]);
    }
  }

  const daysInMonth = new Date(plan.year, plan.month, 0).getDate();
  const days: PlanDayHours[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const dayMs = new Date(plan.year, plan.month - 1, day).getTime();
    days.push(measureDay(dayMs, byDay.get(dateKeyOf(dayMs)) ?? [], holidays));
  }

  // Totals are the sum of the printed rows, so a reader adding a column up gets
  // the printed total. Rounding once per day and summing is what makes that true.
  const totals: PlanHoursTotals = {
    grundlohn: days.reduce((s, d) => s + d.workedMinutes, 0),
    nachtarbeit: days.reduce((s, d) => s + d.nachtarbeitMinutes, 0),
    nacht04: days.reduce((s, d) => s + d.nacht0bis4Minutes, 0),
    sonntag: days.reduce((s, d) => s + d.sonntagMinutes, 0),
    feiertag: days.reduce((s, d) => s + d.feiertagMinutes, 0),
    weihnachten: days.reduce((s, d) => s + d.weihnachtenMinutes, 0),
    samstag: days.reduce((s, d) => s + d.samstagMinutes, 0),
  };

  const rows: PdfDayRow[] = days.map(day => {
    const [s1, s2, s3] = day.displayShifts;
    return {
      date: new Date(`${day.dateKey}T00:00:00`),
      weekday: day.weekday,
      isSat: day.isSaturday,
      isSun: day.isSunday,
      isHol: day.isHoliday,
      von1: s1 ? s1.startLabel : '',
      bis1: s1 ? s1.endLabel : '',
      von2: s2 ? s2.startLabel : '',
      bis2: s2 ? s2.endLabel : '',
      von3: s3 ? s3.startLabel : '',
      bis3: s3 ? s3.endLabel : '',
      grundlohn: formatPlanHours(day.workedMinutes),
      nachtarbeit: formatPlanHours(day.nachtarbeitMinutes),
      nachtarbeit04: formatPlanHours(day.nacht0bis4Minutes),
      sonntag: formatPlanHours(day.sonntagMinutes),
      feiertag: formatPlanHours(day.feiertagMinutes),
      weihnachten: formatPlanHours(day.weihnachtenMinutes),
      // The marker §11 asks for: the day's real period count, so three printed
      // pairs never read as the whole day.
      marker: day.compressed ? `(${day.shifts.length})` : '',
    };
  });

  const pdfTotals: PdfTotals = {
    grundlohn: totals.grundlohn,
    nachtarbeit: totals.nachtarbeit,
    nacht04: totals.nacht04,
    sonntag: totals.sonntag,
    feiertag: totals.feiertag,
    weihnachten: totals.weihnachten,
  };

  const exportable = !problems.some(p => p.blocking);

  return {
    driverId: work.driverId,
    driverName: work.driverName,
    isOwner: snapshot?.isOwner ?? false,
    days,
    totals,
    assignedBlockCount: work.blockCount,
    planBlockMinutes: work.spanMinutes,
    planRideMinutes: work.rideMinutes,
    carryOver,
    problems,
    exportable,
    exportData: {
      driver: {
        name: work.driverName,
        personalnummer: snapshot?.personalnummer ?? undefined,
      },
      month: plan.month,
      year: plan.year,
      rows,
      totals: pdfTotals,
      notes: buildNotes(days, carryOver),
      planningNotice: noticeLine,
      simulated: plan.simulated,
    },
    filename: monthlyPlanStundennachweisFilename(work.driverName, plan.month, plan.year),
  };
}

/**
 * Turns a confirmed plan into one Stundennachweis per driver.
 *
 * Deterministic: the same plan and the same `generatedAt` always produce the
 * same rows, in the same order.
 */
export function buildMonthlyPlanStundennachweise(
  plan: StoredMonthlyPlan,
  options: BuildPlanStundennachweisOptions = {},
): MonthlyPlanStundennachweisSet {
  const generatedAt = options.generatedAt ?? new Date();
  const dataComplete = options.dataComplete !== false;
  const monthLabel = `${monthNameDe(plan.month)} ${plan.year}`;
  const noticeLine = planningNoticeLine(generatedAt);

  if (!dataComplete) {
    return {
      year: plan.year,
      month: plan.month,
      monthLabel,
      noticeLine,
      drivers: [],
      unassignedBlockCount: 0,
      unassignedBlockMinutes: 0,
      problems: [{
        kind: 'source_incomplete',
        detail: 'Der Plan konnte nicht vollständig gelesen werden. '
          + 'Es wird kein Stundennachweis angezeigt oder exportiert.',
        blocking: true,
      }],
      withheld: true,
    };
  }

  const holidays = holidaysAround(plan.year);
  const setProblems: PlanDocumentProblem[] = [];

  const snapshot = new Map<string, StoredPlanDriver>();
  for (const d of plan.drivers) snapshot.set(d.driverId, d);

  const work = new Map<string, DriverWork>();
  let unassignedBlockCount = 0;
  let unassignedBlockMinutes = 0;

  // Every snapshot driver gets a document, including one the assigner gave no
  // block: an empty month is a true statement about a selected driver, and
  // leaving the driver out would read as an oversight.
  for (const d of plan.drivers) {
    work.set(d.driverId, {
      driverId: d.driverId,
      driverName: d.driverName,
      windows: [],
      blockCount: 0,
      spanMinutes: 0,
      rideMinutes: 0,
      problems: [],
    });
  }

  for (const block of plan.blocks) {
    if (!block.driverId) {
      unassignedBlockCount++;
      unassignedBlockMinutes += block.spanMinutes;
      setProblems.push({
        kind: 'block_without_driver',
        detail: `Block ohne Fahrer: ${block.blockKey} (${block.spanMinutes} Min., `
          + `${block.carIdentifier ?? block.carId ?? 'ohne Fahrzeug'}).`,
        blockKey: block.blockKey,
        blocking: false,
      });
      continue;
    }

    const startMs = Date.parse(block.startsAt);
    const endMs = Date.parse(block.endsAt);

    let target = work.get(block.driverId);
    if (!target) {
      // A block naming a driver the snapshot does not hold. §13's snapshot is
      // what a document reads, so this is an inconsistency worth reporting — but
      // the block carries its own `driver_name`, so no minute is lost by
      // building the sheet from it.
      target = {
        driverId: block.driverId,
        driverName: block.driverName ?? block.driverId,
        windows: [],
        blockCount: 0,
        spanMinutes: 0,
        rideMinutes: 0,
        problems: [],
      };
      work.set(block.driverId, target);
      const problem: PlanDocumentProblem = {
        kind: 'driver_not_in_snapshot',
        detail: `Fahrer ${target.driverName} steht in den Blöcken, aber nicht in den `
          + 'gespeicherten Fahrerwerten des Plans.',
        driverId: block.driverId,
        blocking: false,
      };
      setProblems.push(problem);
      target.problems.push(problem);
    }

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      // The table's CHECK forbids it, so this can only be a broken read. It
      // blocks that driver's document: minutes that cannot be placed must not be
      // quietly missing from a total.
      const problem: PlanDocumentProblem = {
        kind: 'block_ends_before_start',
        detail: `Block ${block.blockKey} hat keine verwendbaren Zeiten `
          + `(${block.startsAt} – ${block.endsAt}).`,
        driverId: block.driverId,
        blockKey: block.blockKey,
        blocking: true,
      };
      setProblems.push(problem);
      target.problems.push(problem);
      continue;
    }

    const spanFromInstants = Math.round((endMs - startMs) / MS_PER_MINUTE);
    if (spanFromInstants !== block.spanMinutes) {
      // The instants decide the calendar split, so they are the authority here;
      // the stored span is the cross-check. A disagreement is reported and never
      // repaired, because a confirmed plan's figures may not move under it.
      const problem: PlanDocumentProblem = {
        kind: 'block_minutes_disagree',
        detail: `Block ${block.blockKey}: gespeicherte Dauer ${block.spanMinutes} Min., `
          + `aus den Zeitstempeln ${spanFromInstants} Min.`,
        driverId: block.driverId,
        blockKey: block.blockKey,
        blocking: false,
      };
      setProblems.push(problem);
      target.problems.push(problem);
    }

    target.windows.push({ startMs, endMs });
    target.blockCount++;
    target.spanMinutes += block.spanMinutes;
    target.rideMinutes += block.rideMinutes;
  }

  const drivers = [...work.values()]
    .sort((a, b) =>
      a.driverName.localeCompare(b.driverName, 'de') || a.driverId.localeCompare(b.driverId))
    .map(w => buildOneDriver(w, plan, snapshot.get(w.driverId), holidays, noticeLine));

  return {
    year: plan.year,
    month: plan.month,
    monthLabel,
    noticeLine,
    drivers,
    unassignedBlockCount,
    unassignedBlockMinutes,
    problems: setProblems,
    withheld: false,
  };
}

// ── Downloading every driver ─────────────────────────────────────────────────

export interface PlanDownloadOutcome {
  driverId: string;
  driverName: string;
  filename: string;
  status: 'downloaded' | 'withheld' | 'failed';
  /** German, for the screen. Set for `withheld` and `failed`. */
  detail?: string;
}

export interface DownloadAllOptions {
  /**
   * Asked before anything is written when more than `confirmAbove` documents
   * would be saved, with the count. `false` cancels — nothing is downloaded.
   *
   * The existing multi-download in `MonatsplanungStundennachweisPreview` shows
   * "zu viele Downloads" **and then runs the loop anyway**, so the warning
   * arrives after the browser has already been handed 30 files. Asking first,
   * and honouring a no, is the whole difference.
   */
  confirm?: (count: number) => boolean | Promise<boolean>;
  /** Default 5, the number the existing screen warns at. */
  confirmAbove?: number;
  /**
   * Milliseconds between saves. Several `doc.save()` calls in one tick are
   * dropped by some browsers, which is how a "download all" silently produces
   * four files out of nine.
   */
  spacingMs?: number;
}

const DEFAULT_CONFIRM_ABOVE = 5;
const DEFAULT_SPACING_MS = 150;

function wait(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

/**
 * Saves one PDF per driver, and says per driver what happened.
 *
 * Three things it does that the existing multi-download does not: it **asks**
 * before writing many files and stops on a no; it **withholds** a document whose
 * figures are not trustworthy rather than exporting a sheet nobody should sign;
 * and it reports each outcome instead of one message for the whole batch.
 *
 * `jspdf` is imported here and nowhere else in this module, so the pure half
 * loads in a test without it.
 */
export async function downloadAllPlanStundennachweise(
  set: MonthlyPlanStundennachweisSet,
  options: DownloadAllOptions = {},
): Promise<PlanDownloadOutcome[]> {
  if (set.withheld) {
    return set.drivers.map(d => ({
      driverId: d.driverId,
      driverName: d.driverName,
      filename: d.filename,
      status: 'withheld' as const,
      detail: 'Die Plandaten sind unvollständig.',
    }));
  }

  const exportable = set.drivers.filter(d => d.exportable);
  const confirmAbove = options.confirmAbove ?? DEFAULT_CONFIRM_ABOVE;
  if (exportable.length > confirmAbove && options.confirm) {
    const go = await options.confirm(exportable.length);
    if (!go) return [];
  }

  const { exportStundennachweisAsPdf } = await import('./stundennachweisPdfExport');
  const spacing = options.spacingMs ?? DEFAULT_SPACING_MS;
  const outcomes: PlanDownloadOutcome[] = [];

  for (const doc of set.drivers) {
    if (!doc.exportable) {
      outcomes.push({
        driverId: doc.driverId,
        driverName: doc.driverName,
        filename: doc.filename,
        status: 'withheld',
        detail: doc.problems.filter(p => p.blocking).map(p => p.detail).join(' '),
      });
      continue;
    }
    try {
      exportStundennachweisAsPdf(doc.exportData, doc.filename);
      outcomes.push({
        driverId: doc.driverId,
        driverName: doc.driverName,
        filename: doc.filename,
        status: 'downloaded',
      });
    } catch (error) {
      outcomes.push({
        driverId: doc.driverId,
        driverName: doc.driverName,
        filename: doc.filename,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (spacing > 0) await wait(spacing);
  }

  return outcomes;
}
