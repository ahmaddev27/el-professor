import { createRng } from './rng';

/**
 * The monthly revenue share of the external audit's section 4: one rate per
 * month, drawn in `[30.00 %, 33.00 %]` by a seeded PRNG, applied to the
 * month's eligible revenue in exact integer cents.
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

/** Basis points per whole unit: 100 % = 10000 bp. */
const BP_PER_UNIT = 10_000;

/** The chosen rate, in the two forms a reader needs. */
export interface MonthlyShareRate {
  /** Hundredths of a percent, 3000..3300 inclusive. The exact value; everything computes from this. */
  rateBasisPoints: number;
  /** The same rate as a percent, for display only: 31.42 for 3142 bp. */
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
 * The month's rate. One draw, one value, the same for every trip of the month:
 * nothing in this module takes a trip, so there is no way to vary it per ride.
 */
export function selectMonthlyShareRate(seed: number, year: number, month: number): MonthlyShareRate {
  const streamSeed = shareStreamSeed(seed, year, month);
  const rng = createRng(streamSeed);
  const rateBasisPoints = rng.int(MONTHLY_SHARE_MIN_BP, MONTHLY_SHARE_MAX_BP);
  return { rateBasisPoints, ratePercent: rateBasisPoints / 100, seed: Math.trunc(seed), streamSeed };
}

/** A reason a share cannot be computed. A return value, never an exception. */
export type ShareProblem =
  | 'rate_out_of_range'
  | 'rate_not_whole_basis_points'
  | 'basis_not_whole_cents'
  | 'basis_too_large_for_exact_cents';

/**
 * The rate range a caller admits.
 *
 * There are **two sources for the rate and one computation**. The simulator
 * draws the rate at random in `[30.00 %, 33.00 %]`, because the audit's section
 * 4 specifies that band and an auditor needs a reproducible figure. The product
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
}

/** The simulator's band: exactly what the audit's section 4 names. */
export const SIMULATOR_RATE_RANGE: ShareRateRange = { minBp: MONTHLY_SHARE_MIN_BP, maxBp: MONTHLY_SHARE_MAX_BP };

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
