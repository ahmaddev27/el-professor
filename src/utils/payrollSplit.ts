/**
 * The payroll split: how one salary divides into a part run through payroll and
 * a cash remainder.
 *
 * ── The rule this module preserves, stated before anything was edited ────────
 *
 * One salary total is split in two. `payroll_gross_amount` (Brutto) is the part
 * declared to payroll, and `payroll_net_amount` is what the Steuerberater's
 * calculation pays out of it by bank transfer. Whatever the payroll part does
 * not cover is handed over in cash:
 *
 *     cash  = total − Brutto
 *     bank  = Netto
 *     payout = cash + bank
 *
 * **`cash` is therefore only defined once Brutto is known.** That is the defect
 * this module closes. `SalaryDetailsModal` computed `payrollGross = gross ?? 0`
 * and then treated "any payroll figure entered at all" as a complete split, so a
 * row with a Netto and no Brutto reported the *whole salary* as cash **and** the
 * Netto on top of it: a 2.000 € salary with a 1.000 € Netto and no Brutto
 * printed a 3.000 € payout and `DriverSalarySummaryCard` turned it into a
 * Restgehalt debt of 3.000 € minus what was paid. Measured 28.09.2026: **0 of 53
 * staging rows and 0 of 58 production rows** carry a Netto without a Brutto, so
 * no document already issued changes — the defect is armed by the next operator
 * who fills the Steuerberater's Netto before the Brutto.
 *
 * What is deliberately **not** changed: a Brutto larger than the salary stays a
 * warning and keeps producing a negative cash figure, because 7 of 53 staging
 * rows are in exactly that state and an operator is already reading those
 * numbers. Turning them into "–" would hide a discrepancy that is currently
 * flagged.
 *
 * Nothing here decides what a cash payout may be — it only declines to state a
 * figure the inputs do not determine. Whether a payout should be *refused* when
 * the split is incomplete is the owner's decision.
 */

export interface PayrollSplitInput {
  /** `COALESCE(netto_salary, amount_due)` — the salary the split divides. */
  total: number;
  /** `payroll_gross_amount`: the part declared to payroll. Null until entered. */
  gross: number | null | undefined;
  /** `payroll_net_amount`: what the bank transfer pays out of that Brutto. Null until entered. */
  net: number | null | undefined;
}

/**
 * The split with a known Brutto: every figure is a number, so a screen inside
 * `if (split.established)` may format them without a null check.
 */
export interface PayrollSplitEstablished {
  entered: true;
  established: true;
  /** The Brutto as entered. */
  gross: number;
  /** `total − Brutto`. May be negative; see `cashIsNegative`. */
  cash: number;
  /** The bank transfer: the Netto, or 0 while only the Brutto is known. */
  bank: number;
  /** `cash + bank`. */
  payout: number;
  /** Brutto is larger than the whole salary: a discrepancy to flag, not a reason to withhold the figures. */
  grossExceedsTotal: boolean;
  /** The cash remainder came out negative. Implies `grossExceedsTotal`. */
  cashIsNegative: boolean;
  problem: null;
}

/** No Brutto, so no cash figure and no payout. `bank` still carries a Netto that was entered. */
export interface PayrollSplitIncomplete {
  /** Any payroll figure has been entered, so the section is worth showing. */
  entered: boolean;
  established: false;
  gross: null;
  cash: null;
  bank: number | null;
  payout: null;
  grossExceedsTotal: false;
  cashIsNegative: false;
  /** Why the split states no cash figure, for the screen to say in words. */
  problem: 'gross_missing' | null;
}

/**
 * Discriminated on `established` on purpose: the point of this module is that a
 * cash figure exists only in one of the two cases, and the type says so.
 */
export type PayrollSplit = PayrollSplitEstablished | PayrollSplitIncomplete;

/** One cent; the tolerance the modal already used for both warnings. */
const EPSILON = 0.01;

export function payrollSplit(input: PayrollSplitInput): PayrollSplit {
  const gross = input.gross ?? null;
  const net = input.net ?? null;

  if (gross === null) {
    return {
      entered: net !== null,
      established: false,
      gross: null,
      cash: null,
      bank: net,
      payout: null,
      grossExceedsTotal: false,
      cashIsNegative: false,
      problem: net !== null ? 'gross_missing' : null,
    };
  }

  const cash = input.total - gross;
  const bank = net ?? 0;
  return {
    entered: true,
    established: true,
    gross,
    cash,
    bank,
    payout: cash + bank,
    grossExceedsTotal: gross > input.total + EPSILON,
    cashIsNegative: cash < -EPSILON,
    problem: null,
  };
}

/**
 * What is left of the payout after the payments already made — the Restgehalt.
 *
 * Null when the split states no payout, because "the whole salary minus what was
 * paid" is not the answer to "how much of the split is unpaid" when the split
 * itself is unknown. Unlike `remainingDue` this is **not** clamped at zero: an
 * overpayment of the agreed payout is something the operator has to see.
 */
export function payrollRemaining(split: PayrollSplit, alreadyPaid: number): number | null {
  if (split.payout === null) return null;
  return split.payout - alreadyPaid;
}
