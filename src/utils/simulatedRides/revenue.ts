import { toCents } from './figures';
import type { SimRide, SimRideStatus } from './types';
import type { SimulationTenantSettings } from './tenantSettings';

/**
 * The month's money, counted once (external audit round 3, sections 3, 4 and 8).
 *
 * Everything here is **integer cents**. The generator stores fares and tips as
 * euro floats because that is what the export writes, and this is the one
 * boundary that converts them; nothing downstream adds a euro float to
 * another, so no sum drifts.
 *
 * ## No double counting, and why it is structural rather than checked
 *
 * A ride contributes to exactly one of three buckets, chosen by its status,
 * and the buckets are disjoint by construction:
 *
 * | status      | fare | tip | decline fee |
 * |-------------|------|-----|-------------|
 * | `completed` | yes  | yes | never       |
 * | `cancelled` | no   | no  | only if the tenant asks for it |
 * | `declined`  | no   | no  | yes         |
 *
 * The "no" cells are not a convention of this file: `figures.ts` zeroes the
 * fare and the tip of **every** ride that is not completed, so a declined
 * ride's fare is 0 before this function sees it. The fee lives in its own
 * field. So the only way a cent could be counted twice is for one ride to hold
 * two statuses, which the type forbids. `countRevenue` also returns the
 * per-status counts and the ride total, and section 8's workbook re-sums them
 * per day, per driver and per vehicle against this total.
 *
 * ## A figure that cannot be read is reported, never guessed
 *
 * `NaN`, `Infinity` and a fare that is not a decimal amount produce a
 * `finding`, and the ride is left out of the sums — it is not treated as zero.
 * A zero is a claim about the month; an unreadable figure is a claim about the
 * data, and the two must not look alike in a report an auditor reads.
 */

/** Why one ride could not be counted. */
export interface RevenueFinding {
  shiftId: string;
  status: SimRideStatus;
  field: 'fare' | 'tip' | 'declinedFee' | 'km';
  /** The offending value, as text, so `NaN` and `Infinity` survive the report. */
  value: string;
  code: 'unreadable_amount' | 'negative_amount' | 'fee_not_whole_cents';
}

export interface StatusCounts {
  completed: number;
  cancelled: number;
  declined: number;
  /** Every ride, whatever its status. Orders received. */
  total: number;
}

export interface RevenueBreakdown {
  counts: StatusCounts;
  /** Fares of completed rides. */
  fareCents: number;
  /** Tips of completed rides. */
  tipCents: number;
  /** Decline fees of declined rides. */
  declinedFeeCents: number;
  /** Decline fees charged on cancellations, when the tenant asks for it. Zero otherwise. */
  cancelledFeeCents: number;
  /**
   * What the sheet's `Fahrpreis` column holds for cancelled rides, summed.
   *
   * **It is reported and counted into nothing**, and the reason is worth
   * stating because it is the one place two numbers could have become one. The
   * generator has always drawn a cancelled ride's `Fahrpreis` from its own
   * `CANCELLATION_FEES` (6, 7.2 or 7.5 EUR) — a quantity that predates this
   * audit and that `figures.ts` zeroes again in the income-driven mode. The
   * audit's section 3 fee is a different quantity: a tenant setting, held in
   * `declinedFeeCents`, in a field of its own.
   *
   * Adding both would charge one cancellation twice. Silently dropping one
   * would leave a figure on the sheet that no total accounts for. So this one
   * is summed, shown, and excluded from every basis by construction —
   * `revenueBasis` cannot reach it, because it is not one of the four `parts`.
   */
  cancelledSheetFareCents: number;
  /** Fares of completed rides paid through the app. */
  appFareCents: number;
  /** Fares of completed rides paid in cash. */
  cashFareCents: number;
  /** Kilometres of completed rides, two decimals, as the sheet writes them. */
  km: number;
  findings: RevenueFinding[];
}

const EMPTY_BREAKDOWN: RevenueBreakdown = {
  counts: { completed: 0, cancelled: 0, declined: 0, total: 0 },
  fareCents: 0,
  tipCents: 0,
  declinedFeeCents: 0,
  cancelledFeeCents: 0,
  cancelledSheetFareCents: 0,
  appFareCents: 0,
  cashFareCents: 0,
  km: 0,
  findings: [],
};

/**
 * The fee one ride earns, in integer cents, or null when it earns none.
 *
 * A cancellation earns one **only** when the tenant has said so. Section 3:
 * "لا تفرض 6 € تلقائيًا على CANCELLED ما لم تنص سياسة الشركة على ذلك".
 */
export function declineFeeOf(ride: SimRide, settings: SimulationTenantSettings): number | null {
  if (ride.status === 'declined') {
    return ride.declinedFeeCents ?? settings.declinedFeeCents;
  }
  if (ride.status === 'cancelled' && settings.chargeDeclinedFeeOnCancelled) {
    return settings.declinedFeeCents;
  }
  return null;
}

/** Round a kilometre sum to the two decimals the sheet carries. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The month's money, counted once per ride. */
export function countRevenue(
  rides: readonly SimRide[],
  settings: SimulationTenantSettings,
): RevenueBreakdown {
  const out: RevenueBreakdown = { ...EMPTY_BREAKDOWN, counts: { ...EMPTY_BREAKDOWN.counts }, findings: [] };
  let kmHundredths = 0;

  for (const ride of rides) {
    out.counts.total += 1;
    out.counts[ride.status] += 1;

    if (ride.status === 'completed') {
      const fare = readCents(out, ride, 'fare', ride.fare);
      const tip = readCents(out, ride, 'tip', ride.tip);
      if (fare !== null) {
        out.fareCents += fare;
        if (ride.payment === 'App') out.appFareCents += fare;
        else out.cashFareCents += fare;
      }
      if (tip !== null) out.tipCents += tip;
      const km = readCents(out, ride, 'km', ride.km);
      if (km !== null) kmHundredths += km;
      continue;
    }

    if (ride.status === 'cancelled') {
      // Reported, never counted. See `cancelledSheetFareCents`.
      const sheetFare = toCents(ride.fare);
      if (sheetFare !== null && sheetFare > 0) out.cancelledSheetFareCents += sheetFare;
    }

    const fee = declineFeeOf(ride, settings);
    if (fee === null) continue;
    if (!Number.isInteger(fee) || !Number.isFinite(fee)) {
      out.findings.push({ shiftId: ride.shiftId, status: ride.status, field: 'declinedFee', value: String(fee), code: 'fee_not_whole_cents' });
      continue;
    }
    if (fee < 0) {
      out.findings.push({ shiftId: ride.shiftId, status: ride.status, field: 'declinedFee', value: String(fee), code: 'negative_amount' });
      continue;
    }
    if (ride.status === 'declined') out.declinedFeeCents += fee;
    else out.cancelledFeeCents += fee;
  }
  out.km = round2(kmHundredths / 100);
  return out;
}

/**
 * One amount in cents, or null with a finding.
 *
 * `figures.ts`'s own `toCents` is the converter, reused rather than copied: it
 * answers null for anything that is not a finite decimal amount, where
 * `money.ts`'s throws. A throw here would stop the whole report on one bad
 * cell, and a report that stops says less than one that names the cell.
 */
function readCents(
  out: RevenueBreakdown,
  ride: SimRide,
  field: 'fare' | 'tip' | 'km',
  value: number,
): number | null {
  const cents = toCents(value);
  if (cents === null) {
    out.findings.push({ shiftId: ride.shiftId, status: ride.status, field, value: String(value), code: 'unreadable_amount' });
    return null;
  }
  if (cents < 0) {
    out.findings.push({ shiftId: ride.shiftId, status: ride.status, field, value: String(value), code: 'negative_amount' });
    return null;
  }
  return cents;
}

/** What the eligible-revenue basis is made of, named so a report can print it. */
export interface RevenueBasis {
  basisCents: number;
  includesTips: boolean;
  includesDeclinedFees: boolean;
  /** The parts, so the basis can be checked by addition rather than believed. */
  parts: { fareCents: number; tipCents: number; declinedFeeCents: number; cancelledFeeCents: number };
}

/**
 * The basis the monthly share is taken of.
 *
 * Section 4 asks that tips and decline fees be **configurable** members of it
 * ("عرّف بشكل قابل للضبط ما إذا كانت الإكراميات ورسوم DECLINED تدخل في أساس
 * الإيراد"), so both are flags and both are printed beside the figure. Fares of
 * completed rides are always in it; nothing in the audit suggests otherwise.
 *
 * A fee charged on a cancellation follows the same flag as a decline fee: it is
 * the same quantity under the tenant's own policy, and splitting the two flags
 * would let a tenant include one and exclude the other with no rule saying why.
 */
export function revenueBasis(
  breakdown: RevenueBreakdown,
  settings: SimulationTenantSettings,
): RevenueBasis {
  const parts = {
    fareCents: breakdown.fareCents,
    tipCents: breakdown.tipCents,
    declinedFeeCents: breakdown.declinedFeeCents,
    cancelledFeeCents: breakdown.cancelledFeeCents,
  };
  let basisCents = parts.fareCents;
  if (settings.basisIncludesTips) basisCents += parts.tipCents;
  if (settings.basisIncludesDeclinedFees) basisCents += parts.declinedFeeCents + parts.cancelledFeeCents;
  return {
    basisCents,
    includesTips: settings.basisIncludesTips,
    includesDeclinedFees: settings.basisIncludesDeclinedFees,
    parts,
  };
}
