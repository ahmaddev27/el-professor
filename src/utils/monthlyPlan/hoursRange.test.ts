import { describe, it, expect } from 'vitest';
import {
  computeHoursRange,
  assessAgainstRange,
  type HoursRangeInput,
} from './hoursRange';

/**
 * The figures in this file come from requirement §5 and §16 of
 * `تعليمات_كلود_لتنفيذ_التخطيط_الشهري.md` and are written out literally, not
 * derived from the implementation's own constants. §16 names three of them:
 *
 *   - 1950 ÷ 14 ≈ 139,29
 *   - 2100 ÷ 14 = 150
 *   - an hourly rate of zero must not cause a division by zero
 */

const base: HoursRangeInput = {
  minSalary: 1950,
  maxSalary: 2100,
  hourlyRate: 14,
};

describe('computeHoursRange — the arithmetic §16 names', () => {
  it('1950 € at 14 €/h is ≈139,29 h', () => {
    const r = computeHoursRange(base);
    expect(r.usable).toBe(true);
    // The requirement's own figure, to two decimals.
    expect(r.minHours!.toFixed(2)).toBe('139.29');
    // And the exact quotient, so a later refactor cannot round the bound early.
    expect(r.minHours).toBeCloseTo(1950 / 14, 10);
  });

  it('2100 € at 14 €/h is exactly 150 h', () => {
    const r = computeHoursRange(base);
    expect(r.maxHours).toBe(150);
  });

  it('keeps the bound precise rather than snapping it to whole minutes', () => {
    // 1950/14 h is 8357.142857… minutes. Rounding to 8357 would move the bound
    // to 139.2833 h, which displays as 139,28 and misses the stated figure.
    const r = computeHoursRange(base);
    expect(r.minHours).not.toBe(8357 / 60);
    expect((r.minHours! * 60).toFixed(4)).toBe('8357.1429');
  });
});

describe('computeHoursRange — an unusable hourly rate never divides', () => {
  it('a rate of zero yields no bounds and names the problem', () => {
    const r = computeHoursRange({ ...base, hourlyRate: 0 });
    expect(r.minHours).toBeNull();
    expect(r.maxHours).toBeNull();
    expect(r.usable).toBe(false);
    expect(r.problems).toContain('invalid_hourly_rate');
  });

  it('a rate of zero produces neither Infinity nor NaN anywhere in the result', () => {
    // The failure this guards is the one that looks fine: 1950/0 is Infinity,
    // which compares as "above every cap" and would silently starve the driver.
    const r = computeHoursRange({ ...base, hourlyRate: 0 });
    for (const v of [r.minHours, r.maxHours, r.effectiveMaxHours]) {
      expect(v === null || Number.isFinite(v)).toBe(true);
    }
  });

  it('a missing rate is a different problem from an invalid one', () => {
    expect(computeHoursRange({ ...base, hourlyRate: null }).problems)
      .toContain('missing_hourly_rate');
    expect(computeHoursRange({ ...base, hourlyRate: 0 }).problems)
      .toContain('invalid_hourly_rate');
  });

  it('a negative rate is refused, not used', () => {
    // The column has no CHECK, so the database permits it.
    const r = computeHoursRange({ ...base, hourlyRate: -14 });
    expect(r.usable).toBe(false);
    expect(r.problems).toContain('invalid_hourly_rate');
  });

  it('a NaN rate is refused', () => {
    const r = computeHoursRange({ ...base, hourlyRate: Number.NaN });
    expect(r.usable).toBe(false);
    expect(r.problems).toContain('invalid_hourly_rate');
  });
});

describe('computeHoursRange — §14 edge cases', () => {
  it('a minimum salary above the maximum is reported, never swapped', () => {
    const r = computeHoursRange({ ...base, minSalary: 2100, maxSalary: 1950 });
    expect(r.problems).toContain('min_salary_above_max');
    expect(r.usable).toBe(false);
    // A swap would hide a data-entry error behind a plan that looks correct.
    expect(r.minHours).toBeNull();
  });

  it('a missing minimum and a missing maximum are named separately', () => {
    expect(computeHoursRange({ ...base, minSalary: null }).problems)
      .toContain('missing_min_salary');
    expect(computeHoursRange({ ...base, maxSalary: null }).problems)
      .toContain('missing_max_salary');
  });

  it('equal salaries give a zero-width but usable range', () => {
    const r = computeHoursRange({ minSalary: 1400, maxSalary: 1400, hourlyRate: 14 });
    expect(r.usable).toBe(true);
    expect(r.minHours).toBe(100);
    expect(r.maxHours).toBe(100);
  });
});

describe('computeHoursRange — the cap has one source (§5)', () => {
  /**
   * The owner's decision of 01.10.2026: the plan works from **salaries**, not
   * hours. `max_monthly_hours` is gone, so the cap IS the salary-derived
   * maximum and there is no second bound to be more restrictive than. These
   * three assertions replace the three that measured the old two-source rule.
   */
  it('caps a usable range at max_salary / hourly_rate, and says so', () => {
    const r = computeHoursRange(base);
    expect(r.maxHours).toBe(150);
    expect(r.effectiveMaxHours).toBe(150);
    expect(r.effectiveMaxSource).toBe('salary');
  });

  it('is the same figure as maxHours, always, for a usable range', () => {
    // Above the base's own minimum of 1950, or the range is rightly refused for
    // `min_salary_above_max` and the assertion would be about that instead.
    for (const maxSalary of [1950, 2100, 3000, 9999]) {
      const r = computeHoursRange({ ...base, maxSalary });
      expect(r.usable).toBe(true);
      expect(r.effectiveMaxHours).toBe(r.maxHours);
      expect(r.effectiveMaxSource).toBe('salary');
    }
  });

  /**
   * An unusable range now has **no cap at all** rather than falling back to a
   * stored ceiling. That is the honest answer: nothing is known about this
   * driver's bounds, and `usable: false` is what the assigner reads to refuse
   * them — planning against a bound nobody set would be worse than refusing.
   */
  it('reports no ceiling when the range cannot be computed', () => {
    for (const bad of [{ hourlyRate: 0 }, { hourlyRate: null }, { minSalary: 2200, maxSalary: 1400 }]) {
      const r = computeHoursRange({ ...base, ...bad });
      expect(r.usable).toBe(false);
      expect(r.effectiveMaxHours).toBeNull();
      expect(r.effectiveMaxSource).toBe('none');
      expect(r.problems.length).toBeGreaterThan(0);
    }
  });
});

describe('computeHoursRange — the owner (§8)', () => {
  it('has no effective ceiling', () => {
    const r = computeHoursRange({ ...base, isOwner: true });
    expect(r.usable).toBe(true);
    expect(r.effectiveMaxHours).toBeNull();
    expect(r.effectiveMaxSource).toBe('none');
  });

  it('still reports the salary bounds, which the summary measures surplus against', () => {
    const r = computeHoursRange({ ...base, isOwner: true });
    expect(r.minHours!.toFixed(2)).toBe('139.29');
    expect(r.maxHours).toBe(150);
  });

  it('has no ceiling whatever the salary says', () => {
    for (const maxSalary of [1950, 2100, 9999]) {
      expect(computeHoursRange({ ...base, maxSalary, isOwner: true }).effectiveMaxHours).toBeNull();
    }
  });
});

describe('computeHoursRange — target_monthly_hours is ignored (§5, acceptance 12)', () => {
  it('an extra target_monthly_hours field changes nothing', () => {
    // The requirement forbids reading it. Passing it as an unknown extra key
    // must not reach the result — if a later edit adds it to the input type and
    // reads it, this assertion is what fails.
    const withTarget = { ...base, target_monthly_hours: 40 } as HoursRangeInput;
    expect(computeHoursRange(withTarget)).toEqual(computeHoursRange(base));
  });

  it('the module does not accept a target as a bound source', () => {
    // A driver with only a target and no salary has no range at all — the old
    // pipeline fell back to the target here (monatsplanungPhase3.ts:781).
    const r = computeHoursRange({
      minSalary: null,
      maxSalary: null,
      hourlyRate: 14,
      ...({ target_monthly_hours: 160 } as Record<string, unknown>),
    } as HoursRangeInput);
    expect(r.usable).toBe(false);
    expect(r.minHours).toBeNull();
  });
});

describe('assessAgainstRange', () => {
  const range = computeHoursRange(base); // 139.2857… – 150

  it('places a month inside the range', () => {
    expect(assessAgainstRange(145 * 60, range).position).toBe('in_range');
    expect(assessAgainstRange(145 * 60, range).deviationHours).toBe(0);
  });

  it('reports a month below the minimum with a negative deviation', () => {
    const a = assessAgainstRange(100 * 60, range);
    expect(a.position).toBe('below');
    expect(a.deviationHours!).toBeCloseTo(100 - 1950 / 14, 10);
    expect(a.deviationHours!).toBeLessThan(0);
  });

  it('reports a month above the cap with a positive deviation', () => {
    const a = assessAgainstRange(180 * 60 + 30, range);
    expect(a.position).toBe('above_cap');
    expect(a.deviationHours).toBeCloseTo(30.5, 10);
  });

  it('distinguishes no hours at all from merely below the minimum', () => {
    expect(assessAgainstRange(0, range).position).toBe('no_hours');
    expect(assessAgainstRange(1, range).position).toBe('below');
  });

  it('says so when there is no range, rather than calling it below target', () => {
    const noRange = computeHoursRange({ ...base, hourlyRate: null });
    const a = assessAgainstRange(120 * 60, noRange);
    expect(a.position).toBe('no_range');
    expect(a.deviationHours).toBeNull();
  });

  it('never reports the owner as above the cap', () => {
    const ownerRange = computeHoursRange({ ...base, isOwner: true });
    const a = assessAgainstRange(400 * 60, ownerRange, true);
    expect(a.position).toBe('owner');
    expect(a.deviationHours).toBeNull();
  });

  it('is exact at both boundaries', () => {
    // 150 h is inside the range, not above it.
    expect(assessAgainstRange(150 * 60, range).position).toBe('in_range');
    expect(assessAgainstRange(150 * 60 + 1, range).position).toBe('above_cap');
    // And the lower bound is fractional, so the minute either side matters.
    expect(assessAgainstRange(8357, range).position).toBe('below');   // 139.2833 h
    expect(assessAgainstRange(8358, range).position).toBe('in_range'); // 139.30 h
  });
});
