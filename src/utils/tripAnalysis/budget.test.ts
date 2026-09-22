/**
 * The budget figures of the spec: hours from the salary band and the hourly
 * rate, full precision for computing, floored whole minutes for a ceiling.
 */
import { describe, expect, it } from 'vitest';
import { formatNumber } from '../../components/ui/format';
import { computeBudget, splitMinutes } from './budget';

describe('computeBudget', () => {
  // The spec prints these figures truncated ("71.942446…"), so the tests match
  // the printed digits as a prefix of the full-precision value.
  it('1000 / 13.9 → 71.942446… h, displayed 71,9, 4316 whole minutes', () => {
    const budget = computeBudget({ salaryMin: 800, salaryMax: 1000, hourlyRate: 13.9 });
    expect(String(budget.hoursMax)).toMatch(/^71\.942446\d/);
    expect(formatNumber(budget.hoursMax as number, 1)).toBe('71,9');
    expect(budget.hoursMaxMinutes).toBe(4316);
    // 4316 minutes are 71 h 56 min; 71,9 h is 71 h 54 min, never 71 h 9 min.
    expect(splitMinutes(4316)).toEqual({ hours: 71, minutes: 56 });
    expect(splitMinutes(Math.round(71.9 * 60))).toEqual({ hours: 71, minutes: 54 });
  });

  it('a reserve of 5 → cap 66.942446… h, 4016 whole minutes', () => {
    const budget = computeBudget({ salaryMin: 800, salaryMax: 1000, hourlyRate: 13.9, reservedHours: 5 });
    expect(budget).toMatchObject({ status: 'ok', rangeStatus: 'ok', capStatus: 'ok', problems: [], reservedHours: 5 });
    expect(String(budget.capHours)).toMatch(/^66\.942446\d/);
    expect(budget.capMinutes).toBe(4016);
    // The reserve is taken off the hours only, never off the salary or the minimum.
    expect(String(budget.hoursMax)).toMatch(/^71\.942446\d/);
    expect(String(budget.hoursMin)).toMatch(/^57\.553956\d/);
  });

  it('800 / 1000 / 13.9 → 57.553956… to 71.942446… h', () => {
    const budget = computeBudget({ salaryMin: 800, salaryMax: 1000, hourlyRate: 13.9, reservedHours: 0 });
    expect(String(budget.hoursMin)).toMatch(/^57\.553956\d/);
    expect(String(budget.hoursMax)).toMatch(/^71\.942446\d/);
    // An explicit reserve of 0 is a choice, and a valid one.
    expect(budget).toMatchObject({ status: 'ok', reservedHours: 0, capMinutes: 4316 });
  });

  it('computes exactly where a float division loses a minute', () => {
    // 205 / 12.5 = 16.4 h = 984 min exactly, but the doubles give 983.999…
    expect(Math.floor((205 / 12.5) * 60)).toBe(983);
    expect(computeBudget({ salaryMin: 0, salaryMax: 205, hourlyRate: 12.5, reservedHours: 0 }).hoursMaxMinutes).toBe(984);
  });

  it('reads the decimal strings a numeric column returns', () => {
    const budget = computeBudget({ salaryMin: '800.00', salaryMax: '1000.00', hourlyRate: '13.9', reservedHours: '5' });
    expect(budget.capMinutes).toBe(4016);
    expect(computeBudget({ salaryMin: '800', salaryMax: '1000', hourlyRate: '13,9' }).problems).toContain('hourly_rate_invalid');
  });

  it.each([
    ['rate 0', { hourlyRate: 0 }, 'hourly_rate_not_positive'],
    ['a negative rate', { hourlyRate: -13.9 }, 'hourly_rate_not_positive'],
    ['a missing rate', { hourlyRate: undefined }, 'hourly_rate_missing'],
    ['min above max', { salaryMin: 1200 }, 'salary_min_above_max'],
    ['a negative salary', { salaryMin: -1 }, 'salary_min_negative'],
    ['a missing max', { salaryMax: null }, 'salary_max_missing'],
  ])('%s → the budget is not computable', (_label, change, problem) => {
    const budget = computeBudget({ salaryMin: 800, salaryMax: 1000, hourlyRate: 13.9, reservedHours: 5, ...change });
    expect(budget).toMatchObject({ status: 'not_computable', rangeStatus: 'not_computable', capStatus: 'not_computable' });
    expect(budget.problems).toContain(problem);
    expect(budget.hoursMin).toBeNull();
    expect(budget.hoursMax).toBeNull();
    expect(budget.capMinutes).toBeNull();
  });

  it('an undefined reserve is "not set", never 0: the range stands, the cap does not', () => {
    for (const reservedHours of [undefined, null, '']) {
      const budget = computeBudget({ salaryMin: 800, salaryMax: 1000, hourlyRate: 13.9, reservedHours });
      expect(budget).toMatchObject({
        status: 'not_computable',
        rangeStatus: 'ok',
        capStatus: 'not_computable',
        problems: ['reserve_not_set'],
        reservedHours: null,
        capHours: null,
        capMinutes: null,
      });
      expect(budget.hoursMaxMinutes).toBe(4316);
    }
  });

  it('a reserve above hoursMax, or a negative one, is refused and named', () => {
    const above = computeBudget({ salaryMin: 800, salaryMax: 1000, hourlyRate: 13.9, reservedHours: 72 });
    expect(above).toMatchObject({ capStatus: 'not_computable', problems: ['reserve_above_hours_max'], reservedHours: 72 });
    const negative = computeBudget({ salaryMin: 800, salaryMax: 1000, hourlyRate: 13.9, reservedHours: -1 });
    expect(negative.problems).toEqual(['reserve_negative']);
    // Exactly hoursMax is allowed: the cap is then zero.
    const whole = computeBudget({ salaryMin: 0, salaryMax: 556, hourlyRate: 13.9, reservedHours: 40 });
    expect(whole).toMatchObject({ status: 'ok', capMinutes: 0 });
  });

  it('knows when the reserve pushes the cap below the minimum', () => {
    expect(computeBudget({ salaryMin: 900, salaryMax: 1000, hourlyRate: 13.9, reservedHours: 10 }).capBelowHoursMin).toBe(true);
    expect(computeBudget({ salaryMin: 800, salaryMax: 1000, hourlyRate: 13.9, reservedHours: 5 }).capBelowHoursMin).toBe(false);
  });

  it('refuses a fractional or negative minute count in splitMinutes', () => {
    expect(() => splitMinutes(4316.5)).toThrow(RangeError);
    expect(() => splitMinutes(-1)).toThrow(RangeError);
  });
});
