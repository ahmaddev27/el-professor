/**
 * What the four monthly-plan screens derive, as pure functions (§15).
 *
 * The screens add **no planning rule**. Every constraint, every hours figure
 * and every status comes from `src/utils/monthlyPlan/`. What is left over is
 * screen arithmetic, and it lives here rather than inside a component so it can
 * be tested without a renderer — which is §15's own requirement and the reason
 * the engine was split out in the first place.
 *
 * Five things only:
 *
 *   1. `plannableMonths` — which months screen 1 may offer.
 *   2. `notesQueryFromDate` — the one query bound that could drop a hard
 *      constraint if it were wrong, so it is derived and tested rather than
 *      guessed at the call site.
 *   3. `estimateSalaryCents` — the display inverse of §5's division.
 *   4. `buildPlanSummaryRows` — the engine's per-driver state, and the
 *      validator's findings, folded into §1's one row per driver.
 *   5. `groupWarnings` — the plan-wide findings, counted by kind.
 *
 * ## The rule `estimateSalaryCents` preserves
 *
 * §5 defines the salary↔hours relation once, in one direction:
 * `hours = salary ÷ hourlyRate`. The estimated salary on screen 3 is the exact
 * inverse of that, `salary = hours × hourlyRate`, against **the same rate the
 * range was computed from**. Any other form — a second rate, a rounded rate, a
 * different minute figure — would let the screen show a salary that contradicts
 * the status beside it, which is precisely the disagreement §15 separates the
 * engine to prevent.
 *
 * Two consequences that are deliberate:
 *
 *   - **A driver without a usable rate gets `null`, never 0.** A 0 € estimate
 *     reads as "this driver costs nothing"; `HistoricalWorkingHoursWizard.tsx`
 *     at :10121 turns a missing rate into 0 cents and that is the defect
 *     `hoursRange.ts` was written to avoid repeating. The usable-rate test here
 *     is the engine's own (finite and strictly positive), so a driver the
 *     engine reports as `no_range` for its rate can never be priced here.
 *   - **The minutes priced are `spanMinutes`**, the same figure the effective
 *     cap is enforced against (`assign.ts` accumulates `block.spanMinutes`) and
 *     the same figure `assessAgainstRange` judges. Pricing `rideMinutes`
 *     instead would put a salary next to a status derived from a different
 *     number. Whether idle time inside a block is paid is a question for the
 *     documents (`blocks.ts` keeps both figures so they can decide); it is not
 *     a question a summary row may answer on its own.
 */

import { toCents } from './money';
import type {
  AssignResult,
  DriverPlanState,
  HoursRangeProblem,
  RangePosition,
  ValidationResult,
} from './monthlyPlan';

// ── Screen 1: the months that can be planned ────────────────────────────────

/**
 * The `fahrtenbuch_imports` columns screen 1 reads. Everything is nullable,
 * because this is read straight off a query and a row that is not usable must
 * be reported rather than crash the screen (§14).
 */
export interface PlanImportRow {
  id: string;
  month: number | null;
  year: number | null;
  file_name: string | null;
  imported_at: string | null;
  row_count: number | null;
  status: string | null;
}

export interface PlannableImport {
  id: string;
  fileName: string;
  importedAt: string | null;
  rowCount: number;
  status: string;
}

export interface PlannableMonth {
  /** `YYYY-MM`, the value the month select carries. */
  key: string;
  year: number;
  /** 1–12, the calendar month as `fahrtenbuch_imports` stores it. */
  month: number;
  /** Newest import first. Never empty. */
  imports: PlannableImport[];
  /** Sum of `row_count` over this month's plannable imports. */
  rowCount: number;
}

export interface PlannableMonthsResult {
  months: PlannableMonth[];
  /** Ids of imports left out because they are archived. */
  archived: string[];
  /**
   * Ids of imports whose month or year could not be read. Shown, not dropped
   * silently (§14): an import with no readable month is a data error somebody
   * has to see, and it is the one case that could otherwise hide a whole month.
   */
  unreadable: string[];
}

/**
 * Groups a company's imports into the months screen 1 may offer.
 *
 * **Plannable means `status <> 'archived'`**, and that definition is load-bearing
 * in both directions. `fahrtenbuch_imports.status` has been on the table since
 * `20260605082259` with a default of `'pending'`, the import path writes
 * `'confirmed'`, and **nothing has ever read it** — so every row written before
 * that path existed is still `'pending'`. Accepting only `'confirmed'` would
 * therefore hide every legacy month, and accepting `'archived'` would offer a
 * month somebody withdrew. Nothing writes `'archived'` today; the value exists
 * so that withdrawing an import becomes possible without changing this rule.
 *
 * Deterministic: newest month first, and within a month the newest import
 * first, tie-broken on the id so two imports filed in the same second cannot
 * swap places between renders.
 */
export function plannableMonths(rows: readonly PlanImportRow[]): PlannableMonthsResult {
  const archived: string[] = [];
  const unreadable: string[] = [];
  const byKey = new Map<string, PlannableMonth>();

  for (const row of rows) {
    if (row.status === 'archived') {
      archived.push(row.id);
      continue;
    }

    const month = Number(row.month);
    const year = Number(row.year);
    const monthOk = Number.isInteger(month) && month >= 1 && month <= 12;
    // A four-digit year, which every month this product can plan has. A row
    // outside it is a data error, not a month to offer.
    const yearOk = Number.isInteger(year) && year >= 1000 && year <= 9999;
    if (!monthOk || !yearOk) {
      unreadable.push(row.id);
      continue;
    }

    const key = `${year}-${String(month).padStart(2, '0')}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { key, year, month, imports: [], rowCount: 0 };
      byKey.set(key, entry);
    }

    const parsedCount = Number(row.row_count);
    const rowCount = Number.isFinite(parsedCount) ? parsedCount : 0;
    entry.imports.push({
      id: row.id,
      fileName: row.file_name ?? '',
      importedAt: row.imported_at ?? null,
      rowCount,
      status: row.status ?? '',
    });
    entry.rowCount += rowCount;
  }

  const months = [...byKey.values()].sort((a, b) => b.key.localeCompare(a.key));
  for (const m of months) {
    m.imports.sort((a, b) => {
      // A missing `imported_at` sorts last rather than first: an import with no
      // timestamp is the least likely to be the one the operator just filed.
      const at = a.importedAt ?? '';
      const bt = b.importedAt ?? '';
      return bt.localeCompare(at) || a.id.localeCompare(b.id);
    });
  }
  return { months, archived, unreadable };
}

// ── The lower bound of the planning-notes query ─────────────────────────────

/**
 * The calendar day before a `YYYY-MM-DD` date, as `YYYY-MM-DD`, or null.
 *
 * Built from local calendar parts, which is how `noteExclusionIntervals` builds
 * its own day boundaries, and `new Date(y, m, d - 1)` rolls a month and a year
 * back correctly. Used only to widen a query bound by one day, never as an
 * instant.
 */
export function dayBefore(isoDate: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1);
  if (!Number.isFinite(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The lower bound for the planning-notes query: one day before the earliest ride
 * in the import, or the month's first day when there is no readable ride date.
 *
 * **Why it is not simply the month's first day.** An import may carry a ride
 * dated in the month before it — the Uber export dates a ride just after
 * midnight a day early, and `20260922100000`'s header says so — and a note whose
 * `end_date` falls on such a day would then be excluded by the query and its
 * exclusion would silently not be applied. A hard constraint that fails open is
 * the defect `noteExclusionIntervals` already carries the evidence for: 11 live
 * rides on staging went to drivers marked sick.
 *
 * The bound is safe in the other direction too, and that is why it exists at all
 * rather than fetching every note ever written: a note with an `end_date` set
 * ends its window there (`endDate = end_date ?? startDate`), so one that ended
 * before the first day a block can touch cannot overlap this month. A note with
 * no `end_date` is not bounded by this at all and is always fetched.
 */
export function notesQueryFromDate(
  tripDates: readonly (string | null | undefined)[],
  monthFirstDay: string,
): string {
  let earliest: string | null = null;
  for (const date of tripDates) {
    // Lexicographic comparison is calendar order for `YYYY-MM-DD`, and only
    // that shape is considered — a malformed date cannot lower the bound.
    if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) continue;
    const day = date.slice(0, 10);
    if (earliest == null || day < earliest) earliest = day;
  }
  if (earliest == null) return monthFirstDay;
  return dayBefore(earliest) ?? monthFirstDay;
}

// ── The estimated salary (§1 screen 3, "الراتب التقديري") ────────────────────

/** The engine's own usable-rate test: finite and strictly positive. */
function usableRate(rate: number | null | undefined): number | null {
  if (rate == null) return null;
  if (!Number.isFinite(rate)) return null;
  if (rate <= 0) return null;
  return rate;
}

/**
 * The salary those minutes earn at that rate, in integer cents, or null.
 *
 * `null` for an unusable rate — never 0. See the header for why.
 *
 * The product is rounded **once**, at the end, through `toCents`: the rate is a
 * euro-per-hour figure that may carry more precision than a cent (the column is
 * a bare `numeric`, so 14.005 €/h is storable), and rounding the rate to cents
 * first would misprice every single hour. An impossible input comes back null
 * rather than throwing, so one misconfigured driver cannot take the summary
 * screen down.
 */
export function estimateSalaryCents(minutes: number, hourlyRate: number | null | undefined): number | null {
  const rate = usableRate(hourlyRate);
  if (rate == null) return null;
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  const euros = (minutes / 60) * rate;
  // `toCents` throws above the safe-integer range; bound it here instead, so an
  // absurd rate is reported as "no estimate" rather than as an exception.
  if (!Number.isFinite(euros) || euros > 1e12) return null;
  return toCents(euros);
}

// ── Screen 3: one row per driver ────────────────────────────────────────────

/**
 * §1 names six statuses. `no_range` is a seventh, and it is not an oversight:
 * a driver whose hourly rate or salary bounds are unusable has an **unknown**
 * position, and `hoursRange.ts` keeps it apart from `below` on purpose — showing
 * it as "below target" would invite somebody to hand the driver hours to fix a
 * number that was never computed. §14 requires the configuration error to be
 * visible, so it gets its own word.
 *
 * `has_conflict` is the one status that does not come from the range: it comes
 * from the validator, and it outranks the range position because a conflict is
 * what §1 asks to be shown and what criterion 15 blocks confirmation on.
 */
export type PlanRowStatus = RangePosition | 'has_conflict';

export interface PlanSummaryRow {
  driverId: string;
  driverName: string;
  isOwner: boolean;
  /** Span minutes — the figure the cap, the range and the estimate all read. */
  assignedMinutes: number;
  /** The member rides' own minutes. Not priced here; see the header. */
  rideMinutes: number;
  blockCount: number;
  tripCount: number;
  minHours: number | null;
  maxHours: number | null;
  effectiveMaxHours: number | null;
  effectiveMaxSource: DriverPlanState['range']['effectiveMaxSource'];
  /** Signed hours from the nearest bound; 0 inside the range, null without one. */
  deviationHours: number | null;
  estimatedSalaryCents: number | null;
  status: PlanRowStatus;
  /**
   * True when a **violation** names this driver, so the row can say that the
   * conflict is what stops confirmation rather than merely something to read.
   */
  blocking: boolean;
  /** The findings that named this driver, violations first. For the detail cell. */
  conflicts: string[];
  /** §5/§14: why this driver has no usable range, when they have none. */
  rangeProblems: HoursRangeProblem[];
}

/** The warning kinds that belong to one driver rather than to the whole plan. */
const DRIVER_WARNING_KINDS: ReadonlySet<string> = new Set([
  'unmet_mandatory_note',
  'note_conflict',
  'pin_conflict',
]);

/**
 * Folds the engine's driver states and the validator's findings into §1's rows.
 *
 * Reads nothing else. In particular it never touches `target_monthly_hours`,
 * which §5 forbids this feature to use as a target, a constraint, a sort key or
 * a displayed figure — and which has no field on `PlanDriverInput` at all, so
 * the prohibition is structural rather than a convention.
 *
 * Ordered by driver name, then id, so the table is stable across regenerations.
 */
export function buildPlanSummaryRows(
  result: AssignResult,
  validation: ValidationResult,
): PlanSummaryRow[] {
  const violationsByDriver = new Map<string, string[]>();
  for (const v of validation.violations) {
    if (!v.driverId) continue;
    const list = violationsByDriver.get(v.driverId) ?? [];
    list.push(`${v.rule}: ${v.detail}`);
    violationsByDriver.set(v.driverId, list);
  }

  const warningsByDriver = new Map<string, string[]>();
  for (const w of validation.warnings) {
    if (!w.driverId || !DRIVER_WARNING_KINDS.has(w.kind)) continue;
    const list = warningsByDriver.get(w.driverId) ?? [];
    list.push(`${w.kind}: ${w.detail}`);
    warningsByDriver.set(w.driverId, list);
  }

  const rows = result.driverStates.map((state): PlanSummaryRow => {
    const violations = violationsByDriver.get(state.driver.id) ?? [];
    const warnings = warningsByDriver.get(state.driver.id) ?? [];
    const conflicts = [...violations, ...warnings];

    return {
      driverId: state.driver.id,
      driverName: state.driver.name,
      isOwner: state.driver.isOwner,
      assignedMinutes: state.minutes,
      rideMinutes: state.rideMinutes,
      blockCount: state.assignedBlockIds.length,
      tripCount: state.tripCount,
      minHours: state.range.minHours,
      maxHours: state.range.maxHours,
      effectiveMaxHours: state.range.effectiveMaxHours,
      effectiveMaxSource: state.range.effectiveMaxSource,
      deviationHours: state.assessment.deviationHours,
      estimatedSalaryCents: estimateSalaryCents(state.minutes, state.driver.hourlyRate),
      status: conflicts.length > 0 ? 'has_conflict' : state.assessment.position,
      blocking: violations.length > 0,
      conflicts,
      rangeProblems: state.range.problems,
    };
  });

  return rows.sort(
    (a, b) => a.driverName.localeCompare(b.driverName) || a.driverId.localeCompare(b.driverId),
  );
}

/** The plan-wide findings, grouped by kind with a count, for the warning panel. */
export interface WarningGroup {
  kind: string;
  count: number;
  /** The first few details, so a long list does not fill the screen. */
  samples: string[];
}

/**
 * Groups every warning by kind, driver-scoped ones included.
 *
 * A warning that also appears on a driver's row is deliberately counted here
 * too: the row says *which* driver has a problem, this panel says *how many* of
 * each kind the plan has, and dropping one from the other would make the two
 * totals disagree. Criterion 23 — nothing silently dropped.
 */
export function groupWarnings(validation: ValidationResult, sampleLimit = 5): WarningGroup[] {
  const byKind = new Map<string, WarningGroup>();
  for (const w of validation.warnings) {
    let group = byKind.get(w.kind);
    if (!group) {
      group = { kind: w.kind, count: 0, samples: [] };
      byKind.set(w.kind, group);
    }
    group.count += 1;
    if (group.samples.length < sampleLimit) group.samples.push(w.detail);
  }
  return [...byKind.values()].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}
