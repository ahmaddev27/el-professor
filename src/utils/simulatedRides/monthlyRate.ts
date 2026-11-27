import { createRng } from './rng';

/**
 * The revenue share of the external audit: a rate of exactly 30, 31, 32 or 33 %
 * (Round 8, section 5), either fixed in the company settings or drawn by a
 * seeded PRNG once per month or once per day, applied in exact integer cents.
 *
 * Until Round 8 the draw was continuous over `[30.00 %, 33.00 %]` (3142 bp was
 * a possible rate). Section 5 allows four values and nothing between them, so
 * the same seed now gives a different rate, and every share computed from it
 * moves. That was announced in the Round 8 plan and is deliberate.
 *
 * ## What it is, and the three things it is not
 *
 * It is a **reported figure over revenue that already exists**. It is
 * computed from the month's own fares, tips and declined fees after the month
 * is generated, it is written into the report workbook, and it is returned by
 * a pure function that touches no table.
 *
 * - **It is not a tax and not a commission.** Section 4 forbids naming it
 *   either without documentation, and there is none, so nothing here calls it
 *   one. The field names say `share`, and `remainderCents` is offered only as
 *   "what is left if the share is treated as a deduction" — the audit's own
 *   conditional wording ("إذا كانت النسبة اقتطاعًا").
 * - **It is not a target the rides are bent towards.** Section 4 says "لا
 *   تعدّل أجور الرحلات للوصول إلى الهدف" — do not adjust fares to reach the
 *   figure — and `src/utils/shiftRecommendation/boundary.test.ts` already
 *   fails the build if the planner reaches for a ride or a fare to hit a
 *   revenue number, a direction the owner declined on 08.10.2026. The
 *   arithmetic runs strictly one way: rides → revenue → share. No function in
 *   this file takes a wanted amount, and none returns a fare.
 * - **It is not booked.** No salary, no invoice, no coverage row, no income
 *   row. A figure that changed money would be a billing model, and the owner
 *   has not asked for one.
 *
 * ## The rate's own random stream
 *
 * The rate is drawn from a PRNG **seeded separately** from the generator's.
 * Sharing the generator's stream would make every ride of the month move the
 * moment the share is switched on, because the draw would consume a number the
 * rides used to get — a behaviour change dressed as a report. The sub-seed
 * mixes the month seed with the year and month, so the same month reproduces
 * and two months of one seed do not share a rate.
 */

/** 30.00 %, in hundredths of a percent. */
export const MONTHLY_SHARE_MIN_BP = 3000;
/** 33.00 %, in hundredths of a percent. */
export const MONTHLY_SHARE_MAX_BP = 3300;

/**
 * The only rates section 5 admits, in basis points. "These are percentages,
 * not multipliers": 32 % is 3200 bp, never 32 x.
 */
export const SHARE_RATE_CHOICES_BP = [3000, 3100, 3200, 3300] as const;
export type ShareRateBp = (typeof SHARE_RATE_CHOICES_BP)[number];

/** The same four, as the whole percent a company setting stores. */
export const SHARE_PERCENT_CHOICES = [30, 31, 32, 33] as const;
export type SharePercent = (typeof SHARE_PERCENT_CHOICES)[number];

export function isShareRateAllowed(rateBasisPoints: number): rateBasisPoints is ShareRateBp {
  return (SHARE_RATE_CHOICES_BP as readonly number[]).includes(rateBasisPoints);
}

export function isSharePercentAllowed(percent: unknown): percent is SharePercent {
  return typeof percent === 'number' && (SHARE_PERCENT_CHOICES as readonly number[]).includes(percent);
}

/** Basis points per whole unit: 100 % = 10000 bp. */
const BP_PER_UNIT = 10_000;

/** The chosen rate, in the two forms a reader needs. */
export interface MonthlyShareRate {
  /** Hundredths of a percent: 3000, 3100, 3200 or 3300. The exact value; everything computes from this. */
  rateBasisPoints: number;
  /** The same rate as a percent, for display only: 32 for 3200 bp. */
  ratePercent: number;
  /** The seed the rate was drawn from, so the draw can be repeated. */
  seed: number;
  /** The sub-seed actually fed to the PRNG, printed so a reader can repeat the draw by hand. */
  streamSeed: number;
}

/**
 * The sub-seed for the rate's own stream. A plain mix, not a hash: it only has
 * to be stable, to differ between months of one seed, and not to be the
 * generator's seed itself.
 */
export function shareStreamSeed(seed: number, year: number, month: number): number {
  const mixed = (Math.trunc(seed) ^ 0x5f37_59df) + year * 10_000 + month * 101;
  return mixed >>> 0;
}

/**
 * The sub-seed for one day's draw. A different constant from the month's
 * stream, so a day's rate is not the month's rate by construction, and
 * `month * 101 + day * 7` cannot collide inside a year (101 is prime and a
 * collision would need two days 101 apart).
 */
export function shareDayStreamSeed(seed: number, year: number, month: number, day: number): number {
  const mixed = (Math.trunc(seed) ^ 0x2545_f491) + year * 10_000 + month * 101 + day * 7;
  return mixed >>> 0;
}

function drawFromChoices(streamSeed: number): ShareRateBp {
  return createRng(streamSeed).pick(SHARE_RATE_CHOICES_BP);
}

/**
 * The month's rate. One draw, one value, the same for every trip of the month:
 * nothing in this module takes a trip, so there is no way to vary it per ride.
 */
export function selectMonthlyShareRate(seed: number, year: number, month: number): MonthlyShareRate {
  const streamSeed = shareStreamSeed(seed, year, month);
  const rateBasisPoints = drawFromChoices(streamSeed);
  return { rateBasisPoints, ratePercent: rateBasisPoints / 100, seed: Math.trunc(seed), streamSeed };
}

/** One day's rate, for the scope `day`: its own draw, stable for that date and seed. */
export function selectDailyShareRate(seed: number, year: number, month: number, day: number): MonthlyShareRate {
  const streamSeed = shareDayStreamSeed(seed, year, month, day);
  const rateBasisPoints = drawFromChoices(streamSeed);
  return { rateBasisPoints, ratePercent: rateBasisPoints / 100, seed: Math.trunc(seed), streamSeed };
}

/** Whether a random rate is drawn once for the month or once per day. Section 5 asks that it be stated. */
export type ShareScope = 'month' | 'day';

/**
 * The company's choice (section 5, "selectable through company settings").
 * `fixed` names the percent; `random` names the scope and the seed, and
 * nothing else, so the same setting always gives the same rates.
 */
export type ShareSetting =
  | { mode: 'fixed'; percent: SharePercent }
  | { mode: 'random'; scope: ShareScope; seed: number };

export type ShareSettingProblem = 'percent_not_allowed' | 'scope_missing' | 'seed_not_integer' | 'mode_unknown';

/**
 * Why a stored setting cannot be used, or null. A return value, never an
 * exception, because a setting is read from a row a person typed.
 */
export function shareSettingProblem(setting: ShareSetting): ShareSettingProblem | null {
  if (setting.mode === 'fixed') return isSharePercentAllowed(setting.percent) ? null : 'percent_not_allowed';
  if (setting.mode === 'random') {
    if (setting.scope !== 'month' && setting.scope !== 'day') return 'scope_missing';
    return Number.isSafeInteger(setting.seed) ? null : 'seed_not_integer';
  }
  return 'mode_unknown';
}

/** The rate applied on one date, and where it came from. */
export interface AppliedShareRate {
  rateBasisPoints: ShareRateBp;
  ratePercent: number;
  mode: 'fixed' | 'random';
  /** The draw's scope; null for a fixed rate, which has no draw. */
  scope: ShareScope | null;
  seed: number | null;
  streamSeed: number | null;
}

/**
 * The rate for one calendar date under a setting. A fixed rate is the same on
 * every date; a random one is the month's draw or that day's draw. The caller
 * passes a setting `shareSettingProblem` accepted.
 */
export function resolveShareRate(
  setting: ShareSetting,
  date: { year: number; month: number; day: number },
): AppliedShareRate {
  if (setting.mode === 'fixed') {
    const rateBasisPoints = (setting.percent * 100) as ShareRateBp;
    return { rateBasisPoints, ratePercent: setting.percent, mode: 'fixed', scope: null, seed: null, streamSeed: null };
  }
  const drawn = setting.scope === 'day'
    ? selectDailyShareRate(setting.seed, date.year, date.month, date.day)
    : selectMonthlyShareRate(setting.seed, date.year, date.month);
  return {
    rateBasisPoints: drawn.rateBasisPoints as ShareRateBp,
    ratePercent: drawn.ratePercent,
    mode: 'random',
    scope: setting.scope,
    seed: drawn.seed,
    streamSeed: drawn.streamSeed,
  };
}

/** A reason a share cannot be computed. A return value, never an exception. */
export type ShareProblem =
  | 'rate_out_of_range'
  | 'rate_not_allowed'
  | 'rate_not_whole_basis_points'
  | 'basis_not_whole_cents'
  | 'basis_too_large_for_exact_cents';

/**
 * The rate range a caller admits.
 *
 * There are **two sources for the rate and one computation**. The simulator
 * uses one of 30, 31, 32 or 33 %, fixed or drawn at random, because the audit
 * (section 4 of round 4, section 5 of Round 8) names exactly those and an
 * auditor needs a reproducible figure. The product
 * reads a rate an operator configured, and that one is free across
 * `[0 %, 100 %]` — measured on 27.10.2026, the 30–33 band is an artefact of the
 * audit scenario and not a rule of this product: the only revenue share the
 * product already has is `drivers.salary_ratio`, `numeric(5,4)` with
 * `CHECK (>= 0 AND <= 1)` and a default of 0.5000, and nothing anywhere in the
 * codebase uses a 30–33 band for anything.
 *
 * The range is therefore an argument, not a constant. It is **not** a licence
 * to vary the arithmetic: `applyMonthlyShare` is the only place a share is
 * computed, by either caller, so the two cannot drift.
 */
export interface ShareRateRange {
  minBp: number;
  maxBp: number;
  /** When set, the only rates admitted inside the band. The product's range has none. */
  allowedBp?: readonly number[];
}

/** The simulator's rates: exactly the four Round 8's section 5 names. */
export const SIMULATOR_RATE_RANGE: ShareRateRange = {
  minBp: MONTHLY_SHARE_MIN_BP,
  maxBp: MONTHLY_SHARE_MAX_BP,
  allowedBp: SHARE_RATE_CHOICES_BP,
};

/** The product's band: a configured rate is any share of revenue. */
export const PRODUCT_RATE_RANGE: ShareRateRange = { minBp: 0, maxBp: BP_PER_UNIT };

/**
 * The largest basis the multiplication stays exact for, at a given maximum
 * rate. `basisCents * rateBp` must not leave the safe-integer range, or the
 * "exact decimal arithmetic" section 4 asks for is a float with a rounding
 * error in it. At the simulator's maximum rate the bound is about 27 trillion
 * euro, so no real month reaches it — the check exists so that a nonsense input
 * is refused by name instead of answering a wrong figure.
 */
export function maxBasisCentsFor(maxBp: number): number {
  return Math.floor(Number.MAX_SAFE_INTEGER / Math.max(1, maxBp));
}

/** The bound at the simulator's maximum rate. */
export const MAX_BASIS_CENTS = maxBasisCentsFor(MONTHLY_SHARE_MAX_BP);

export interface ShareResult {
  /** The eligible revenue the share was taken of, in integer cents. */
  basisCents: number;
  rateBasisPoints: number;
  /** basis x rate, rounded once to the cent. */
  amountCents: number;
  /** basis - amount. What is left **if** the share is treated as a deduction. */
  remainderCents: number;
}

/**
 * Round a fraction to the nearest integer, halves away from zero.
 *
 * One rule for every cent in this module, which is what section 4's "تقريبًا
 * موحدًا للسنت" asks for. It is done in integers, so no step passes through a
 * binary float: `Math.round(x * 0.3142)` is not the same function at every
 * magnitude, and two figures rounded by two rules do not add up to the total a
 * reader checks them against.
 *
 * It compares the **remainder** against half the denominator rather than
 * computing `(2n + d) / 2d`. That closed form is the textbook one and it was
 * written here first, but `n` is allowed up to `Number.MAX_SAFE_INTEGER` by
 * `MAX_BASIS_CENTS`, so `2n` leaves the exact range and the rounding this
 * function exists to make exact would have been the one step that was not.
 * The remainder is below `d`, so `2 * r` cannot overflow at any input the
 * bound admits.
 */
function divideRoundHalfAwayFromZero(numerator: number, denominator: number): number {
  const sign = numerator < 0 ? -1 : 1;
  const n = Math.abs(numerator);
  const quotient = Math.floor(n / denominator);
  const remainder = n - quotient * denominator;
  return sign * (2 * remainder >= denominator ? quotient + 1 : quotient);
}

/**
 * `basis x rate`, to the cent, with the remainder beside it.
 *
 * A negative basis is computed, not refused: a month whose refunds exceed its
 * fares has a negative eligible revenue, and answering nothing there would
 * hide it. The rounding is symmetric about zero, so the same magnitude gives
 * the same cent on either side.
 */
export function applyMonthlyShare(
  basisCents: number,
  rateBasisPoints: number,
  range: ShareRateRange = SIMULATOR_RATE_RANGE,
): { ok: true; result: ShareResult } | { ok: false; problem: ShareProblem } {
  if (!Number.isInteger(rateBasisPoints)) return { ok: false, problem: 'rate_not_whole_basis_points' };
  if (rateBasisPoints < range.minBp || rateBasisPoints > range.maxBp) {
    return { ok: false, problem: 'rate_out_of_range' };
  }
  if (range.allowedBp && !range.allowedBp.includes(rateBasisPoints)) return { ok: false, problem: 'rate_not_allowed' };
  if (!Number.isInteger(basisCents)) return { ok: false, problem: 'basis_not_whole_cents' };
  // The bound follows the range: a product rate of 100 % admits a third of the
  // basis the simulator's 33 % does, and taking the simulator's bound here
  // would have let the product multiply its way out of the exact range.
  if (Math.abs(basisCents) > maxBasisCentsFor(range.maxBp)) {
    return { ok: false, problem: 'basis_too_large_for_exact_cents' };
  }

  const amountCents = divideRoundHalfAwayFromZero(basisCents * rateBasisPoints, BP_PER_UNIT);
  return {
    ok: true,
    result: { basisCents, rateBasisPoints, amountCents, remainderCents: basisCents - amountCents },
  };
}
