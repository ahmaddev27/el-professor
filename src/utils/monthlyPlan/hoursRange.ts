/**
 * Monthly plan — the driver's target hours range (requirement §5).
 *
 * The range has exactly one source: the driver's minimum salary, maximum salary
 * and hourly rate.
 *
 *     minHours = planning_min_salary / planning_hourly_rate
 *     maxHours = planning_max_salary / planning_hourly_rate
 *
 * `drivers.target_monthly_hours` is **deliberately not read here, and must never
 * be.** The requirement states it twice: the field is ignored entirely in this
 * feature — not as a target, not as a constraint, not as a sort key, and not in
 * anything shown as part of a planning decision. The existing
 * `monatsplanungPhase3.ts` does use it (as the fallback sort key at :781 and in
 * the persisted `assignment_reason` at :1395); that pipeline is untouched and
 * this module is not built from it.
 *
 * ## Why the bounds are decimal hours and not integer minutes
 *
 * Everything this engine *measures* — a block, a day, a month — is integer
 * minutes, because decimal hours accumulate rounding error. A target is not a
 * measurement. 1950 € / 14 €/h is 139.285714… h, and forcing that into whole
 * minutes (8357) would move the bound to 139.283 h and make the requirement's
 * own figure (≈139,29) unreachable. So the bounds keep full precision and the
 * comparison converts at the point of use: `minutes >= minHours * 60`.
 *
 * ## Why an unusable rate is a result and not an exception
 *
 * `drivers.planning_hourly_rate` is a bare nullable `numeric` with no CHECK, so
 * the database permits NULL, 0 and a negative rate. Three places in the existing
 * browser code disagree about what to do with that — one refuses, one ignores it,
 * and `HistoricalWorkingHoursWizard.tsx:10121` silently turns a missing rate into
 * 0 cents. Requirement §5 calls it a configuration error and forbids an invalid
 * division; §14 asks for it to be handled visibly. So this returns a named
 * problem the screen can print, rather than throwing (which would take down a
 * whole plan for one misconfigured driver) or returning 0 (which would quietly
 * price the driver at nothing).
 */

/** Why a driver has no usable hours range. Each maps to a sentence on screen. */
export type HoursRangeProblem =
  | 'missing_hourly_rate'
  | 'invalid_hourly_rate'
  | 'missing_min_salary'
  | 'missing_max_salary'
  | 'min_salary_above_max';

/** The figures this module reads. A subset of `drivers`, and deliberately small. */
export interface HoursRangeInput {
  /** `drivers.planning_min_salary` — euros per month. */
  minSalary: number | null;
  /** `drivers.planning_max_salary` — euros per month. */
  maxSalary: number | null;
  /** `drivers.planning_hourly_rate` — euros per hour. */
  hourlyRate: number | null;
  /**
   * `drivers.max_monthly_hours` — an explicit ceiling, when the company sets one.
   * §5: "use the more restrictive of the two as the effective cap".
   */
  maxMonthlyHours?: number | null;
  /**
   * `drivers.employment_type === 'company_owner'`. §8: the owner has no monthly
   * ceiling, so the owner gets a range with no cap at all.
   */
  isOwner?: boolean;
}

export interface HoursRange {
  /** Lower bound in decimal hours, or null when it could not be computed. */
  minHours: number | null;
  /** Upper bound from the salary, in decimal hours, or null. */
  maxHours: number | null;
  /**
   * The ceiling actually enforced: the more restrictive of `maxHours` and
   * `maxMonthlyHours`. `null` means no ceiling — which for the owner is the
   * intended state, and for anybody else means the range is unusable.
   */
  effectiveMaxHours: number | null;
  /** Which of the two produced `effectiveMaxHours`, for the screen to explain it. */
  effectiveMaxSource: 'salary' | 'explicit_cap' | 'none';
  /** Empty when the range is usable. */
  problems: HoursRangeProblem[];
  /** True when both bounds exist and can be compared against worked minutes. */
  usable: boolean;
}

/** A finite, positive number, or null. Rejects NaN, Infinity, 0 and negatives. */
function positiveOrNull(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return null;
  return value;
}

/**
 * Computes the driver's target hours range from salary and hourly rate.
 *
 * Never throws and never divides by an unusable rate: when the rate is missing,
 * zero, negative or not finite, both bounds come back null with the reason named.
 */
export function computeHoursRange(input: HoursRangeInput): HoursRange {
  const problems: HoursRangeProblem[] = [];

  // The rate is checked before anything divides by it. `positiveOrNull` folds
  // 0, negatives, NaN and Infinity into one null so no division can be invalid.
  const rate = positiveOrNull(input.hourlyRate);
  if (input.hourlyRate == null) {
    problems.push('missing_hourly_rate');
  } else if (rate === null) {
    // Present but unusable: 0, negative, NaN or Infinity. A distinct problem
    // from "missing", because the fix is different — somebody typed something.
    problems.push('invalid_hourly_rate');
  }

  const minSalary = input.minSalary;
  const maxSalary = input.maxSalary;

  if (minSalary == null || !Number.isFinite(minSalary)) problems.push('missing_min_salary');
  if (maxSalary == null || !Number.isFinite(maxSalary)) problems.push('missing_max_salary');

  // §14: "the minimum salary is greater than the maximum". Reported rather than
  // silently swapped — a swap would hide a data-entry error behind a plan that
  // looks fine.
  if (
    minSalary != null && maxSalary != null &&
    Number.isFinite(minSalary) && Number.isFinite(maxSalary) &&
    minSalary > maxSalary
  ) {
    problems.push('min_salary_above_max');
  }

  const explicitCap = positiveOrNull(input.maxMonthlyHours);

  if (problems.length > 0 || rate === null || minSalary == null || maxSalary == null) {
    // No division happens on this path. The explicit cap is still reported when
    // there is one, so a driver with a ceiling but no salary is not shown as
    // entirely unconstrained.
    return {
      minHours: null,
      maxHours: null,
      effectiveMaxHours: input.isOwner ? null : explicitCap,
      effectiveMaxSource: input.isOwner ? 'none' : explicitCap != null ? 'explicit_cap' : 'none',
      problems,
      usable: false,
    };
  }

  const minHours = minSalary / rate;
  const maxHours = maxSalary / rate;

  // §8: the owner has no monthly ceiling. The salary-derived maximum is still
  // computed and shown — it is what the summary screen measures the owner's
  // surplus against — but nothing caps the owner's hours.
  if (input.isOwner) {
    return {
      minHours,
      maxHours,
      effectiveMaxHours: null,
      effectiveMaxSource: 'none',
      problems,
      usable: true,
    };
  }

  // §5: "use the more restrictive as the effective cap".
  const effectiveMaxHours = explicitCap != null ? Math.min(maxHours, explicitCap) : maxHours;
  const effectiveMaxSource: HoursRange['effectiveMaxSource'] =
    explicitCap != null && explicitCap < maxHours ? 'explicit_cap' : 'salary';

  return {
    minHours,
    maxHours,
    effectiveMaxHours,
    effectiveMaxSource,
    problems,
    usable: true,
  };
}

/**
 * Where a month's worked minutes sit relative to the range — the "Status" column
 * of the summary screen (§1, third screen).
 *
 * `no_range` is separate from `below` on purpose: a driver whose rate is missing
 * has an unknown position, and showing that as "below target" would invite
 * somebody to give them hours to fix a number that was never computed.
 */
export type RangePosition = 'no_hours' | 'below' | 'in_range' | 'above_cap' | 'no_range' | 'owner';

export interface RangeAssessment {
  position: RangePosition;
  /**
   * Signed difference from the nearest bound, in decimal hours. Negative below
   * the minimum, positive above the effective cap, 0 inside the range.
   * Null when there is no range to compare against.
   */
  deviationHours: number | null;
}

/**
 * Judges accumulated minutes against a range.
 *
 * `minutes` is integer minutes, as every duration in this engine is. The bounds
 * are decimal hours, so the comparison converts here and in exactly one place.
 */
export function assessAgainstRange(
  minutes: number,
  range: HoursRange,
  isOwner = false,
): RangeAssessment {
  if (isOwner) {
    // The owner absorbs the surplus by design (§8), so "above" is not a finding
    // for them and there is nothing to deviate from.
    return { position: 'owner', deviationHours: null };
  }

  if (!range.usable || range.minHours == null || range.effectiveMaxHours == null) {
    return { position: 'no_range', deviationHours: null };
  }

  if (minutes <= 0) {
    // Distinct from `below`: a driver with no hours at all is a coverage
    // problem, not a driver who is merely short of their minimum.
    return { position: 'no_hours', deviationHours: -range.minHours };
  }

  const hours = minutes / 60;

  if (hours < range.minHours) {
    return { position: 'below', deviationHours: hours - range.minHours };
  }
  if (hours > range.effectiveMaxHours) {
    return { position: 'above_cap', deviationHours: hours - range.effectiveMaxHours };
  }
  return { position: 'in_range', deviationHours: 0 };
}
