import { formatCentsDe } from './money';
import { PRODUCT_RATE_RANGE, applyMonthlyShare, maxBasisCentsFor, type ShareResult } from './simulatedRides/monthlyRate';

/**
 * The product side of the monthly revenue share (external audit, section 4).
 *
 * Two sources for the rate, one computation. The simulator
 * (`simulatedRides/monthlyRate.ts`) draws a rate at random in 30.00 %..33.00 %
 * from a saved seed so an auditor can reproduce it. The product reads the rate
 * an operator configured for the company and the month
 * (`company_monthly_revenue_share`, migration 20261027150000). Both turn
 * `basis x rate` into cents with the same rule: integers only, one rounding,
 * halves away from zero.
 *
 * ## The range is the product's, not the audit's
 * The 30..33 % band is an artefact of the audit scenario. The stored rate is
 * free across 0 %..100 %, mirroring `drivers.salary_ratio` (numeric(5,4),
 * 0..1), and the table's CHECK says the same: 0..10000 basis points.
 *
 * ## There is exactly one copy of the arithmetic, and that is the point
 * `computeStoredShare` **calls** `applyMonthlyShare` with the product's range.
 * It does not restate the rounding. The first draft of this file did carry a
 * copy, because the shared function hard-coded the simulator's band; the band
 * is a parameter now, so the copy is gone. Two copies of money arithmetic
 * drift, and the one that drifts is found on a payslip rather than in a test —
 * which is why `monthlyRevenueShare.test.ts` still compares the two paths over
 * the simulator's whole range even though they are now the same code.
 */

/** 0.00 %, in hundredths of a percent. */
export const PRODUCT_RATE_MIN_BP = 0;
/** 100.00 %, in hundredths of a percent. */
export const PRODUCT_RATE_MAX_BP = 10_000;

/**
 * The largest basis the multiplication stays exact for at the widest rate:
 * `basisCents * rateBp` must stay inside the safe-integer range. Derived by the
 * shared helper, so the product's bound and the simulator's cannot part.
 */
export const PRODUCT_MAX_BASIS_CENTS = maxBasisCentsFor(PRODUCT_RATE_MAX_BP);

/** One row of `company_monthly_revenue_share`, as the screen reads it. */
export interface StoredMonthlyShareRate {
  id: string;
  company_id: string;
  year: number;
  /** 1..12, as stored (unlike weekCalculations, which is 0-indexed). */
  month: number;
  /** Whole hundredths of a percent, 0..10000. */
  rate_basis_points: number;
  basis_includes_tips: boolean;
  basis_includes_declined_fees: boolean;
  note: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

/** A reason a rate or a share cannot be used. A return value, never an exception. */
export type StoredShareProblem =
  | 'rate_not_whole_basis_points'
  | 'rate_below_minimum'
  | 'rate_above_maximum'
  | 'basis_not_whole_cents'
  | 'basis_too_large_for_exact_cents';

/** `null` when the rate is storable, otherwise the stable reason. */
export function rateProblem(rateBasisPoints: number): StoredShareProblem | null {
  if (!Number.isInteger(rateBasisPoints)) return 'rate_not_whole_basis_points';
  if (rateBasisPoints < PRODUCT_RATE_MIN_BP) return 'rate_below_minimum';
  if (rateBasisPoints > PRODUCT_RATE_MAX_BP) return 'rate_above_maximum';
  return null;
}

/**
 * `basis x configured rate`, to the cent, with the remainder beside it: what is
 * left if the share is treated as a deduction. A negative basis is computed, not
 * refused, exactly as the simulator does — because it is the same code.
 *
 * The rate is validated here first, so the caller gets the product's own three
 * reason codes (`rate_below_minimum`, `rate_above_maximum`,
 * `rate_not_whole_basis_points`) rather than the shared function's single
 * `rate_out_of_range`: a screen has to tell an operator which end they went off.
 */
export function computeStoredShare(
  basisCents: number,
  stored: Pick<StoredMonthlyShareRate, 'rate_basis_points'>,
): { ok: true; result: ShareResult } | { ok: false; problem: StoredShareProblem } {
  const bp = stored.rate_basis_points;
  const rateIssue = rateProblem(bp);
  if (rateIssue) return { ok: false, problem: rateIssue };
  const applied = applyMonthlyShare(basisCents, bp, PRODUCT_RATE_RANGE);
  if (applied.ok) return applied;
  // The rate is already known good, so the only problems left are the basis's.
  // `rate_out_of_range` cannot reach here; mapping it to the basis code would
  // be a lie, so it is named for what it would be: a broken invariant.
  return {
    ok: false,
    problem: applied.problem === 'basis_not_whole_cents' ? 'basis_not_whole_cents' : 'basis_too_large_for_exact_cents',
  };
}

/** 3142 -> "31,42 %". For a validated, non-negative rate. */
export function formatRateBasisPointsDe(rateBasisPoints: number): string {
  const whole = Math.trunc(rateBasisPoints / 100);
  const hundredths = String(rateBasisPoints % 100).padStart(2, '0');
  return `${whole},${hundredths} %`;
}

/** The four figures of the audit's example, formatted for display. */
export interface ShareDescription {
  basis: string;
  rate: string;
  amount: string;
  remainder: string;
}

export function describeShare(result: ShareResult): ShareDescription {
  return {
    basis: formatCentsDe(result.basisCents),
    rate: formatRateBasisPointsDe(result.rateBasisPoints),
    amount: formatCentsDe(result.amountCents),
    remainder: formatCentsDe(result.remainderCents),
  };
}
