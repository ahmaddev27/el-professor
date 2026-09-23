/**
 * The driver's monthly hour budget, derived from the salary band and the
 * hourly rate:
 *
 *   hoursMin = salaryMin / hourlyRate
 *   hoursMax = salaryMax / hourlyRate
 *   cap      = hoursMax − reservedHours      (automatic_plan_cap)
 *
 * Every input is read as the exact decimal it was written as (13.9 is 139/10,
 * not the double nearest to it) and the whole-minute figures are floored in
 * integer arithmetic. A float division would put 1000 / 13.9 × 60 a hair
 * either side of the true value, and a floor of a figure that should be whole
 * can then lose a minute. Floored, never rounded up: a budget of 71.942446… h
 * allows 4316 minutes, not 4317.
 *
 * A budget is a planning frame, not a measurement of work and not a legal
 * judgement. An invalid or missing input makes it "not computable"; it never
 * blocks the analysis, and a missing reserve is "not set", never 0.
 */
import type { BudgetInput, BudgetProblem, BudgetResult } from './types';

/** An exact rational number; the denominator is always positive. */
interface Fraction {
  readonly num: bigint;
  readonly den: bigint;
}

type Parsed = { readonly kind: 'missing' } | { readonly kind: 'invalid' } | { readonly kind: 'value'; readonly value: Fraction };

const ZERO = BigInt(0);
const SIXTY = BigInt(60);
const TEN = BigInt(10);

/**
 * A number or a decimal string ("1000", "13.9", "-5") as an exact fraction.
 * Exponent notation and German decimal commas are refused as invalid: the
 * inputs come from numeric columns, which never write either.
 */
function parseAmount(value: number | string | null | undefined): Parsed {
  if (value === null || value === undefined) return { kind: 'missing' };
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { kind: 'invalid' };
    text = String(value);
  } else {
    text = value.trim();
    if (text === '') return { kind: 'missing' };
  }
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return { kind: 'invalid' };
  const [, minus, whole, fraction = ''] = match;
  const magnitude = BigInt(whole + fraction);
  return {
    kind: 'value',
    value: { num: minus ? -magnitude : magnitude, den: TEN ** BigInt(fraction.length) },
  };
}

function divide(a: Fraction, b: Fraction): Fraction {
  // b is positive here (a validated hourly rate), so the denominator stays positive.
  return { num: a.num * b.den, den: a.den * b.num };
}

function subtract(a: Fraction, b: Fraction): Fraction {
  return { num: a.num * b.den - b.num * a.den, den: a.den * b.den };
}

function compare(a: Fraction, b: Fraction): number {
  const left = a.num * b.den;
  const right = b.num * a.den;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isNegative(a: Fraction): boolean {
  return a.num < ZERO;
}

/** The nearest double; only for display and for the comparisons in minutes. */
function toNumber(a: Fraction): number {
  return Number(a.num) / Number(a.den);
}

/** floor(a × 60) for a ≥ 0, exactly. */
function floorMinutes(a: Fraction): number {
  return Number((a.num * SIXTY) / a.den);
}

interface ProblemCodes {
  readonly missing: BudgetProblem;
  readonly invalid: BudgetProblem;
  /** Raised when the value is below the smallest one allowed. */
  readonly tooSmall: BudgetProblem;
}

/** The value, or null with its problem recorded. `allowZero` false demands a positive value. */
function checkAmount(
  raw: number | string | null | undefined,
  problems: BudgetProblem[],
  codes: ProblemCodes,
  allowZero: boolean,
): Fraction | null {
  const parsed = parseAmount(raw);
  if (parsed.kind !== 'value') {
    problems.push(parsed.kind === 'missing' ? codes.missing : codes.invalid);
    return null;
  }
  const tooSmall = allowZero ? parsed.value.num < ZERO : parsed.value.num <= ZERO;
  if (tooSmall) {
    problems.push(codes.tooSmall);
    return null;
  }
  return parsed.value;
}

/** Budget of one driver and month. Never throws: every defect is a listed problem. */
export function computeBudget(input: BudgetInput): BudgetResult {
  const problems: BudgetProblem[] = [];

  const salaryMin = checkAmount(
    input.salaryMin,
    problems,
    { missing: 'salary_min_missing', invalid: 'salary_min_invalid', tooSmall: 'salary_min_negative' },
    true,
  );
  const salaryMax = checkAmount(
    input.salaryMax,
    problems,
    { missing: 'salary_max_missing', invalid: 'salary_max_invalid', tooSmall: 'salary_max_negative' },
    true,
  );
  if (salaryMin && salaryMax && compare(salaryMin, salaryMax) > 0) problems.push('salary_min_above_max');
  const rate = checkAmount(
    input.hourlyRate,
    problems,
    { missing: 'hourly_rate_missing', invalid: 'hourly_rate_invalid', tooSmall: 'hourly_rate_not_positive' },
    false,
  );

  const rangeOk = problems.length === 0 && salaryMin !== null && salaryMax !== null && rate !== null;
  const hoursMin = rangeOk ? divide(salaryMin, rate) : null;
  const hoursMax = rangeOk ? divide(salaryMax, rate) : null;

  const reserveParsed = parseAmount(input.reservedHours);
  let reserve: Fraction | null = null;
  let reserveGiven: number | null = null;
  if (reserveParsed.kind === 'missing') {
    problems.push('reserve_not_set');
  } else if (reserveParsed.kind === 'invalid') {
    problems.push('reserve_invalid');
  } else if (isNegative(reserveParsed.value)) {
    problems.push('reserve_negative');
    reserveGiven = toNumber(reserveParsed.value);
  } else {
    reserveGiven = toNumber(reserveParsed.value);
    if (hoursMax && compare(reserveParsed.value, hoursMax) > 0) problems.push('reserve_above_hours_max');
    else reserve = reserveParsed.value;
  }

  const cap = hoursMin && hoursMax && reserve ? subtract(hoursMax, reserve) : null;

  return {
    status: rangeOk && cap ? 'ok' : 'not_computable',
    rangeStatus: rangeOk ? 'ok' : 'not_computable',
    capStatus: cap ? 'ok' : 'not_computable',
    problems,
    hoursMin: hoursMin ? toNumber(hoursMin) : null,
    hoursMax: hoursMax ? toNumber(hoursMax) : null,
    hoursMaxMinutes: hoursMax ? floorMinutes(hoursMax) : null,
    reservedHours: reserveGiven,
    capHours: cap ? toNumber(cap) : null,
    capMinutes: cap ? floorMinutes(cap) : null,
    capBelowHoursMin: cap && hoursMin ? compare(cap, hoursMin) < 0 : null,
  };
}

/** 4316 → { hours: 71, minutes: 56 }. 71,9 h is 71 h 54 min, never 71 h 9 min. */
export function splitMinutes(totalMinutes: number): { hours: number; minutes: number } {
  if (!Number.isInteger(totalMinutes) || totalMinutes < 0) {
    throw new RangeError('splitMinutes: a whole, non-negative number of minutes is required');
  }
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}
