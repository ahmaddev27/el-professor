/**
 * §12 — the monthly payroll hours summary for the Steuerberater, built from a
 * confirmed monthly plan.
 *
 * ══ THE RULE THIS PRESERVES ═══════════════════════════════════════════════
 *
 * **Every total in this document comes from the plan, and this module is not a
 * second source for any payroll figure.** §12's own sentence: "the totals must
 * come from the same plan data used in the Stundennachweis" (acceptance
 * criterion 22). So `buildPayrollSummary` takes the per-driver hour totals as
 * an **argument** and does nothing to them but format them. It contains no
 * payroll arithmetic at all.
 *
 * That separation is the point. The product already has two independent
 * Stundennachweis builders and they disagree: `FinalizePlanningModal`'s hard-codes
 * `isHol: false` and so loses every holiday hour, while
 * `MonatsplanungStundennachweisPreview`'s counts them — and inside that one
 * component the toolbar total excludes the gap between merged shifts while the
 * PDF includes it, for 92.5% of driver-days. A third builder would make it
 * three. `computePlanDriverHours` below is a **fallback**, clearly separated, so
 * that swapping in `monthlyPlanStundennachweis.ts`'s per-driver totals is one
 * function call and not a rewrite. See "RECONCILIATION" at the bottom.
 *
 * ══ THE SECOND RULE: THIS PLANS A MONTH THAT HAS NOT HAPPENED ═════════════
 *
 * The output is a **proposal, never a record**. `PLANUNG / VORSCHAU — kein
 * Arbeitszeitnachweis` stands in the sheet's header with the date it was
 * generated, and the filename carries `_PLANUNG_`. A Steuerberater who mistakes
 * a forecast for the month's actuals pays wages that were never worked.
 *
 * This module writes nothing. It has no supabase import, it never names
 * `fahrtenbuch_trips`, and it never names `saved_stundennachweise` — that table
 * is the statutory archive, keyed per driver and month, and a proposal written
 * into it would overwrite a real record.
 *
 * ══ UNITS, BECAUSE A FACTOR OF 60 LOOKS ENTIRELY PLAUSIBLE ════════════════
 *
 * Every field of `PayrollDriverHours` is **seconds**, which is what
 * `computeLohnartSeconds` returns, and nothing here rounds to minutes on the
 * way in. Rounding once, at the cell, is what keeps the invariant below exact:
 * three buckets rounded to minutes independently need not sum to their own
 * total rounded to minutes. `fmtHours` takes minutes, so a cell is
 * `fmtHours(sec / 60)` and the division is the only conversion in the file.
 *
 * ══ THE DISJOINTNESS THE SHEET MUST NOT HIDE ══════════════════════════════
 *
 * `grundlohnSec + night2006Sec + night0004Sec === totalSec`, exactly. Those
 * three partition the clock (06–20, 20–24 plus 04–06, 00–04) and CLAUDE.md
 * states the middle pair as a rule: Lohnart 1500 and 1501 are mutually
 * exclusive, `1500 = nightSec − night0to4Sec` and `1501 = night0to4Sec`, never
 * double-counted. The test pins the identity.
 *
 * `saturdaySec`, `sundaySec`, `holidaySec` and `xmas150Sec` are **premium
 * classifications of those same seconds**, not further parts of the day. Adding
 * all seven would count a Sunday night twice over. `totalMins()` in
 * `stundennachweisArchiveExport.ts` does exactly that sum and calls it "every
 * recorded minute" — which is why `Std. Gesamt` here sits *before* the seven
 * breakdown columns rather than after them. A total in the last position reads
 * as the sum of what precedes it; a total in the fifth reads as what it is.
 *
 * ══ §3b EStG, AND THE "CORRECTION" NOT TO MAKE ════════════════════════════
 *
 * The column is called `Std. Weihnachten` and the live rule
 * (`MonatsplanungStundennachweisPreview.tsx`, `buildPdfDayRow`) counts 25.12,
 * 26.12 **and 01.05**. That looks like a bug and is not: §3b Abs. 3 EStG puts
 * the Weihnachtsfeiertage and the 1. Mai in the same 150% band, above the 125%
 * every other public holiday gets. The column name is a misnomer for a rate
 * band. It is reproduced here unchanged, deliberately.
 *
 * What the live rule does **not** cover, and this one does not either: §3b also
 * puts 24.12 and 31.12 from 14:00 in the 150% band. Adding them would change a
 * payroll figure, so it is named here and left to the §3b review that
 * `Docs/audit/REMEDIATION-PLAN.md` blocks the premium work on.
 */
import {
  computeLohnartSeconds,
  getGermanNationalHolidays,
} from './historicalWorkingHoursCleanEngine';
import {
  ARBEITSTAGE_INDEX,
  FAHRERUEBERSICHT_COLUMNS,
  MONTHS_DE,
  fmtHours,
  type FahreruebersichtColumn,
} from './fahreruebersichtColumns';

// ── The columns ───────────────────────────────────────────────────────────────

/**
 * §12 requires the driver's name, the employee number if there is one, **the
 * total hours**, the payroll hour categories that are available, and the month.
 * The 25-column Fahrerübersicht carries all of those except the total, so one
 * column is inserted — right after `Arbeitstage`, for the reason in the header.
 */
const TOTAL_COLUMN: FahreruebersichtColumn = { label: 'Std. Gesamt', width: 13 };

export const PAYROLL_SUMMARY_COLUMNS: readonly FahreruebersichtColumn[] = [
  ...FAHRERUEBERSICHT_COLUMNS.slice(0, ARBEITSTAGE_INDEX + 1),
  TOTAL_COLUMN,
  ...FAHRERUEBERSICHT_COLUMNS.slice(ARBEITSTAGE_INDEX + 1),
];

/**
 * The first column with no source in the plan; everything from here is blank.
 * Located by the last computed column's own label rather than by a count, so a
 * column added to either list cannot silently shift the blanks by one.
 */
const FIRST_MANUAL_COLUMN =
  PAYROLL_SUMMARY_COLUMNS.findIndex(column => column.label === 'Std. Weihnachten') + 1;

// ── What the builder reads ────────────────────────────────────────────────────

/**
 * One row of `monthly_plan_drivers`, §13's snapshot.
 *
 * **`personalnummer` is not in that table.** The snapshot holds the driver's
 * name and §4's eight planning values and nothing else, so the employee number
 * is a live read from `public.drivers` by the caller, and for a driver deleted
 * since the plan was confirmed there is none. That is why it is
 * `string | null` here and why a missing one prints an **empty cell**: a UUID in
 * a column headed `Personalnr.` would be read as an employee number by the one
 * recipient least able to tell. `fahreruebersichtExport.ts` folds
 * `personalnummer ?? driver_id` into an `ID` column and does exactly that.
 */
export interface PayrollSummaryDriver {
  driverId: string;
  /** `monthly_plan_drivers.driver_name` — the snapshot's copy, never `drivers.name`. */
  driverName: string;
  /** From `public.drivers`; see above. `null` prints blank, never an id. */
  personalnummer: string | null;
}

/**
 * One row of `monthly_plan_blocks`. `starts_at` / `ends_at` arrive as epoch
 * milliseconds — absolute instants, never clock strings, which is the engine's
 * premise and the defect CLAUDE.md warns about twice.
 */
export interface PayrollSummaryBlock {
  /** `monthly_plan_blocks.driver_id`. An unassigned block has none and is skipped. */
  driverId: string | null;
  startMs: number;
  endMs: number;
  /**
   * `monthly_plan_blocks.ride_minutes` — the sum of the member rides, carried so
   * a preview can name the idle time §3 keeps separate from the span. It is
   * never a column and never enters an hour figure.
   */
  rideMinutes?: number;
}

/** Every figure the sheet prints for one driver. Seconds; see the header. */
export interface PayrollDriverHours {
  /** The span of the driver's blocks. Equals the three disjoint buckets' sum. */
  totalSec: number;
  /** Lohnart 1000 — 06:00–20:00. */
  grundlohnSec: number;
  /** Lohnart 1500 — 20:00–24:00 and 04:00–06:00, i.e. 20–06 without 00–04. */
  night2006Sec: number;
  /** Lohnart 1501 — 00:00–04:00. Mutually exclusive with the above. */
  night0004Sec: number;
  /** Any time on a Saturday. A classification, not a further part of the day. */
  saturdaySec: number;
  /** Lohnart 1510 — any time on a Sunday. */
  sundaySec: number;
  /** Any time on a German national public holiday. */
  holidaySec: number;
  /** The §3b 150% band: 25.12, 26.12 and 01.05. A subset of `holidaySec`. */
  xmas150Sec: number;
  /** Distinct local calendar days on which the driver has worked seconds. */
  workingDays: number;
  /** Carried from the blocks, never computed. See `PayrollSummaryBlock`. */
  rideMinutes: number;
  /** How many of the driver's blocks fed these figures. */
  blockCount: number;
}

export interface BuildPayrollSummaryParams {
  /** 1-indexed, as `monthly_plans.month` stores it. */
  month: number;
  year: number;
  companyName: string;
  /** The plan's drivers, §13's snapshot. A driver with no blocks keeps its row. */
  drivers: readonly PayrollSummaryDriver[];
  /**
   * The per-driver totals, **already computed** — by
   * `monthlyPlanStundennachweis.ts` once it exists, or by
   * `computePlanDriverHours` below until then. This builder adds nothing to them.
   * A driver absent from the map has no assigned work and prints blank cells.
   */
  hoursByDriverId: ReadonlyMap<string, PayrollDriverHours>;
  /** The clock, injected so the sheet is reproducible in a test. */
  generatedAtMs: number;
}

export interface PayrollSummaryRow {
  driverId: string;
  /** One entry per `PAYROLL_SUMMARY_COLUMNS` entry, in that order. */
  cells: (string | number)[];
  /** The figures behind the cells. `null` when the driver has no assigned work. */
  hours: PayrollDriverHours | null;
}

export interface PayrollSummary {
  title: string;
  /** The PLANUNG warning and the generation date. Never omitted. */
  planungNotice: string;
  companyLine: string;
  periodLabel: string;
  columns: readonly FahreruebersichtColumn[];
  rows: PayrollSummaryRow[];
  footerNote: string;
  /** Carries `_PLANUNG_`, so a downloaded file says what it is. */
  fileName: string;
  /** Drivers in the plan with no assigned block — blank rows, never dropped (§23). */
  driversWithoutWork: number;
}

// ── The fallback computation ──────────────────────────────────────────────────

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * Holidays for every year a block touches.
 *
 * `computeLohnartSeconds` takes one set, and the clean engine's own call site
 * passes `getGermanNationalHolidays(startYear)` alone — so a block from 31.12
 * into 01.01 never sees Neujahr. Unioning the two years can only add dates in
 * the year the block actually reaches, so no within-year result moves.
 */
function holidaysFor(startMs: number, endMs: number): Set<string> {
  const startYear = new Date(startMs).getFullYear();
  const endYear = new Date(endMs).getFullYear();
  const set = getGermanNationalHolidays(startYear);
  if (endYear === startYear) return set;
  const merged = new Set(set);
  for (const day of getGermanNationalHolidays(endYear)) merged.add(day);
  return merged;
}

/**
 * Saturday seconds, the §3b 150% seconds, and the days worked.
 *
 * These three are the only figures this module derives, because
 * `computeLohnartSeconds` has no bucket for any of them. The walk is the shape
 * of that function's own loop — one local calendar day at a time, whole-day
 * overlap for a day class — so Saturday is computed exactly as Sunday is there.
 *
 * `MonatsplanungStundennachweisPreview` instead derives Saturday per shift from
 * `service_date`, which puts a Friday-night block's Saturday minutes under
 * Friday. Per-minute and per-service-day are different figures for every
 * cross-midnight shift; this is one of the items under RECONCILIATION.
 */
function walkDayClasses(startMs: number, endMs: number): {
  saturdaySec: number;
  xmas150Sec: number;
  dayKeys: string[];
} {
  if (endMs <= startMs) return { saturdaySec: 0, xmas150Sec: 0, dayKeys: [] };

  let saturdaySec = 0;
  let xmas150Sec = 0;
  const dayKeys: string[] = [];

  const first = new Date(startMs);
  let day = new Date(first.getFullYear(), first.getMonth(), first.getDate(), 0, 0, 0, 0);

  while (day.getTime() < endMs) {
    const dayMs = day.getTime();
    const nextDay = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0, 0, 0);
    const dayOverlapMs = overlapMs(startMs, endMs, dayMs, nextDay.getTime());

    if (dayOverlapMs > 0) {
      const month = day.getMonth();
      const date = day.getDate();
      // §3b Abs. 3 EStG's 150% band, exactly as the live Stundennachweis reads
      // it. The 1. Mai belongs here; see the header before "fixing" it.
      const isXmas150 =
        (month === 11 && (date === 25 || date === 26)) || (month === 4 && date === 1);

      if (day.getDay() === 6) saturdaySec += dayOverlapMs / 1000;
      if (isXmas150) xmas150Sec += dayOverlapMs / 1000;

      dayKeys.push(
        `${day.getFullYear()}-${String(month + 1).padStart(2, '0')}-${String(date).padStart(2, '0')}`,
      );
    }

    day = nextDay;
  }

  return { saturdaySec, xmas150Sec, dayKeys };
}

function emptyHours(): PayrollDriverHours {
  return {
    totalSec: 0,
    grundlohnSec: 0,
    night2006Sec: 0,
    night0004Sec: 0,
    saturdaySec: 0,
    sundaySec: 0,
    holidaySec: 0,
    xmas150Sec: 0,
    workingDays: 0,
    rideMinutes: 0,
    blockCount: 0,
  };
}

/**
 * The fallback: per-driver totals computed from the plan's blocks with the clean
 * engine's `computeLohnartSeconds`, the same function the Stundennachweis
 * builder was told to use.
 *
 * No month filter. The plan's blocks are the plan's — dropping a block because
 * its start falls outside the plan's month would lose minutes a driver worked,
 * and §23 forbids dropping anything silently. A block a plan should not contain
 * is a defect for `validatePlan` to report, not for a document to hide.
 *
 * An unassigned block (`driverId === null`) belongs to nobody and is skipped;
 * `validatePlan`'s warnings are where an unassigned block is surfaced.
 */
export function computePlanDriverHours(
  blocks: readonly PayrollSummaryBlock[],
): Map<string, PayrollDriverHours> {
  const byDriver = new Map<string, PayrollDriverHours>();
  // Days are collected as a set per driver: two blocks on one day are one
  // working day, and a block crossing midnight is two.
  const daysByDriver = new Map<string, Set<string>>();

  for (const block of blocks) {
    if (!block.driverId) continue;
    if (!(block.endMs > block.startMs)) continue;

    const hours = byDriver.get(block.driverId) ?? emptyHours();
    const days = daysByDriver.get(block.driverId) ?? new Set<string>();

    const lohnart = computeLohnartSeconds(
      block.startMs,
      block.endMs,
      holidaysFor(block.startMs, block.endMs),
    );
    const classes = walkDayClasses(block.startMs, block.endMs);

    hours.totalSec += lohnart.totalSec;
    hours.grundlohnSec += lohnart.baseSec;
    hours.night2006Sec += lohnart.night25Sec;
    hours.night0004Sec += lohnart.night40Sec;
    hours.sundaySec += lohnart.sundaySec;
    hours.holidaySec += lohnart.holidaySec;
    hours.saturdaySec += classes.saturdaySec;
    hours.xmas150Sec += classes.xmas150Sec;
    hours.rideMinutes += block.rideMinutes ?? 0;
    hours.blockCount += 1;
    for (const key of classes.dayKeys) days.add(key);

    byDriver.set(block.driverId, hours);
    daysByDriver.set(block.driverId, days);
  }

  for (const [driverId, hours] of byDriver) {
    hours.workingDays = daysByDriver.get(driverId)?.size ?? 0;
  }

  return byDriver;
}

// ── The sheet ─────────────────────────────────────────────────────────────────

/** German date, `DD.MM.YYYY`. Never a US order. */
function germanDate(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/**
 * The header line that keeps a forecast from being read as a record. It names
 * what the document is, what it is not, and when it was produced.
 */
export function planungNotice(generatedAtMs: number): string {
  return `PLANUNG / VORSCHAU — kein Arbeitszeitnachweis · Erstellt: ${germanDate(generatedAtMs)}`;
}

/** `_PLANUNG_` in the name, so a file on a desk says what it is. */
export function payrollSummaryFileName(month: number, year: number): string {
  return `Lohn_Stundenuebersicht_PLANUNG_${String(month).padStart(2, '0')}_${year}.xlsx`;
}

/**
 * Builds the §12 sheet. Pure: no clock, no I/O, no arithmetic on the hours
 * beyond dividing seconds by 60 for the formatter.
 *
 * Drivers are ordered by name with German collation, so the sheet reads in the
 * order the Fahrer screen lists them and two runs of one plan are identical.
 */
export function buildPayrollSummary(params: BuildPayrollSummaryParams): PayrollSummary {
  const { month, year, companyName, drivers, hoursByDriverId, generatedAtMs } = params;

  // A month outside 1–12 is a broken argument, not a reason to print
  // "undefined 2026" on a document going to a tax adviser.
  const monthName = month >= 1 && month <= 12 ? MONTHS_DE[month - 1] : '';
  const periodLabel = `${monthName} ${year}`.trim();
  const blankCells = PAYROLL_SUMMARY_COLUMNS.length - FIRST_MANUAL_COLUMN;

  const ordered = [...drivers].sort((a, b) => a.driverName.localeCompare(b.driverName, 'de'));

  let driversWithoutWork = 0;

  const rows: PayrollSummaryRow[] = ordered.map((driver, index) => {
    const hours = hoursByDriverId.get(driver.driverId) ?? null;
    if (!hours || hours.blockCount === 0) driversWithoutWork += 1;

    // A driver with no assigned work gets empty cells, not zeros: nothing was
    // measured for them, and `fmtHours` cannot tell that from a worked zero.
    const figures: (string | number)[] = hours
      ? [
          hours.workingDays,
          fmtHours(hours.totalSec / 60),
          fmtHours(hours.grundlohnSec / 60),
          fmtHours(hours.night2006Sec / 60),
          fmtHours(hours.night0004Sec / 60),
          fmtHours(hours.saturdaySec / 60),
          fmtHours(hours.sundaySec / 60),
          fmtHours(hours.holidaySec / 60),
          fmtHours(hours.xmas150Sec / 60),
        ]
      : ['', '', '', '', '', '', '', '', ''];

    return {
      driverId: driver.driverId,
      cells: [
        index + 1,
        // Blank, never the driver id. See `PayrollSummaryDriver`.
        driver.personalnummer ?? '',
        driver.driverName,
        ...figures,
        ...Array<string>(blankCells).fill(''),
      ],
      hours,
    };
  });

  return {
    title: `Lohn-Stundenübersicht (Planung) — ${periodLabel}`,
    planungNotice: planungNotice(generatedAtMs),
    companyLine: `Unternehmen: ${companyName || '—'}`,
    periodLabel,
    columns: PAYROLL_SUMMARY_COLUMNS,
    rows,
    footerNote:
      'PLANUNG / VORSCHAU — kein Arbeitszeitnachweis. Die Stunden stammen aus dem ' +
      'bestätigten Monatsplan und beschreiben einen geplanten Monat, keine geleistete ' +
      'Arbeitszeit. Std. Gesamt ist die Summe aus Grundlohn, Nacht (20-06) und Nacht ' +
      '(00-04); Samstag, Sonntag, Feiertag und Weihnachten sind Zuschlagsarten derselben ' +
      'Stunden und dürfen nicht addiert werden. Felder ohne Quelle sind manuell zu befüllen.',
    fileName: payrollSummaryFileName(month, year),
    driversWithoutWork,
  };
}

/*
  ══ RECONCILIATION — what must be settled before this document is trusted ════

  `monthlyPlanStundennachweis.ts` did not exist on
  `feat/monthly-plan-doc-stundennachweis` when this was written (that branch was
  at staging's head), so the fallback above is what produces the figures today.
  Both documents must end up reading **one** per-driver total, and the two
  candidate sources do not agree. Measured, not assumed:

    1. **Grundlohn.** `computeLohnartSeconds` treats 06:00–20:00 as Lohnart 1000
       and the night windows as separate parts of the same day, so the three sum
       to the total. `MonatsplanungStundennachweisPreview` writes the day's
       **whole** time into `grundlohn` and pays the night buckets as a premium on
       top of it (`cents += nachtarbeit_minutes * rate * PREM_NIGHT / 60`). Under
       the first model a driver who works only nights has zero Grundlohn hours.
       Which is right is a §3b EStG question, and `Docs/audit/REMEDIATION-PLAN.md`
       blocks the premium work on establishing exactly that. It is not decided
       here.

    2. **The night window.** `computeLohnartSeconds`' 1500 bucket is 20:00–24:00
       plus 04:00–06:00, which with 00:00–04:00 covers 20–06 and matches the
       column heading. The live preview's `computeNightBuckets` uses 23:00–24:00
       plus 04:00–06:00 and writes it into the same `nachtarbeit_min` column —
       three hours a night narrower than the heading it is printed under.

    3. **Saturday.** Per-minute here, per-`service_date` in the live preview. See
       `walkDayClasses`.

  Until one source is chosen, this document and the Stundennachweis can differ,
  and acceptance criterion 22 is not met. The swap is one argument:
  `hoursByDriverId`.
*/
