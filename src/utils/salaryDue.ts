/**
 * What a driver's salary is, what was paid against it, and therefore what is
 * still owed — in one place, because three components derived it separately and
 * a fourth read a stored word instead.
 *
 * ── The rules this module preserves, stated before anything was edited ───────
 *
 * 1. **The base is `COALESCE(netto_salary, amount_due)`.** A manual netto
 *    adjustment wins over the calculated amount; with no adjustment the
 *    calculated amount is the base. This is the same expression
 *    `confirm_salary_cash_payment` uses to decide what a cash payout may be
 *    (CLAUDE.md: "Due is `COALESCE(netto_salary, amount_due)`"), so the screen
 *    and the database must not spell it differently.
 * 2. **The salary formula is `(Umsatz + Aktionen) × salary_ratio + Trinkgeld ×
 *    100%`.** Trinkgeld is pass-through and belongs wholly to the driver; it is
 *    never multiplied by the ratio and never counts toward company profit.
 * 3. **The payment status is a function of what was paid against the base, not
 *    a stored word.** `SalariesManagement` recomputes the base live from the
 *    period's income rows but then read `existingSalary.payment_status ||
 *    derived`, so the stored status won whenever it existed — which is on every
 *    row. Measured on staging 28.09.2026: 28 of 53 rows carry a stored
 *    `amount_due` that no longer matches the live recomputation (25.201,26 €
 *    absolute) and **5 of them read "bezahlt" while money is owed**. The audit
 *    reports the same shape on production (26 of 58 rows, ~20.800 €, 6 reading
 *    "bezahlt"); that figure is theirs, the staging one was re-measured here.
 *
 *    Be exact about which comparison drifts, because it decides where the fix
 *    belongs: on **both** databases the stored `payment_status` agrees with the
 *    row's *own* stored figures — 0 rows disagree, measured on each. What has
 *    moved is the recomputation from the period's income rows, so the defect
 *    lives on the two screens that recompute and not in the column.
 * 4. **Nothing here is ever written back.** The derivation is for display only.
 *    An issued Gehaltsquittung's base is frozen by design — two production
 *    receipts already hang off drifted rows — so persisting the recomputation
 *    would retroactively change what a delivered receipt attests to. Whether
 *    the drifted rows should be corrected, and whether a Gehaltsquittung should
 *    be refused when the live figure differs from the stored base, are the
 *    owner's decisions and are not taken here.
 *
 * 5. **The salary is never negative; what a period's clawbacks exceed its
 *    earnings by is shown, not carried.** Negative Uber fares, promotions and
 *    tips are stored (`income_amount_check`, 20261016170000) and reduce the
 *    period's Umsatz/Trinkgeld like any other row. Before that they were refused
 *    and the totals overstated. The floor is applied to the TOTAL, so a reversed
 *    tip and a positive revenue share net against each other (all of it is the
 *    same driver's money). The shortfall is `unrecovered`; carrying it into the
 *    next period is a larger design and is deliberately not done here.
 *    A salary row that already exists is untouched: its stored `amount_due` and
 *    `netto_salary` are frozen, and this only changes the live recomputation
 *    the screens display (rule 4).
 *
 * Nothing in this module reads a clock, a locale or the database.
 */

export type PaymentStatus = 'unpaid' | 'partially_paid' | 'paid';

/**
 * Half a cent. German money carries two decimals, so a difference below this is
 * float noise and not a debt.
 *
 * It matters because the base and the payments are summed in binary floats:
 * three payments of 411,52 € sum to 1234.5599999999999, which the old exact
 * `totalPaid >= total` read as *not* fully paid and reported as a remaining
 * balance of about 10^-13 €. Measured on staging: no stored row's status turns
 * on this tolerance, so it corrects the float case without moving any row.
 */
export const MONEY_EPSILON = 0.005;

/** The default a driver with no `salary_ratio` is calculated at. */
export const DEFAULT_SALARY_RATIO = 0.5;

/** The two columns the base is read from. Either may be absent, null or a PostgREST numeric string. */
export interface SalaryBaseRow {
  amount_due?: number | string | null;
  netto_salary?: number | string | null;
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * `COALESCE(netto_salary, amount_due)`, and 0 when neither is readable.
 *
 * Deliberately `??` and not `||`: a manual adjustment **to zero** is a decision
 * the operator made, and `||` silently replaced it with the calculated amount.
 * No staging row carries `netto_salary = 0` today, so this is latent — but it
 * is the case the old spelling gets wrong by the full salary.
 */
export function salaryBase(row: SalaryBaseRow): number {
  const netto = toNumber(row.netto_salary);
  if (netto !== null) return netto;
  return toNumber(row.amount_due) ?? 0;
}

/** What is still owed against the base: never negative, so an overpayment reads as nothing owed. */
export function remainingDue(base: number, totalPaid: number): number {
  const remaining = base - totalPaid;
  return remaining > MONEY_EPSILON ? remaining : 0;
}

/**
 * The payment status the figures on screen imply.
 *
 * Read this instead of `salaries.payment_status`: the stored word was computed
 * against whatever the base was when the last payment was entered, and the
 * screens recompute the base from the period's income rows every time they
 * load.
 */
export function derivePaymentStatus(base: number, totalPaid: number): PaymentStatus {
  if (totalPaid <= MONEY_EPSILON) return 'unpaid';
  if (totalPaid >= base - MONEY_EPSILON) return 'paid';
  return 'partially_paid';
}

/** Everything a row's payment state consists of, from the base and the payments alone. */
export interface SalaryDueState {
  base: number;
  totalPaid: number;
  remaining: number;
  paymentStatus: PaymentStatus;
}

export function salaryDueState(row: SalaryBaseRow, totalPaid: number | string | null | undefined): SalaryDueState {
  const base = salaryBase(row);
  const paid = toNumber(totalPaid) ?? 0;
  return {
    base,
    totalPaid: paid,
    remaining: remainingDue(base, paid),
    paymentStatus: derivePaymentStatus(base, paid),
  };
}

/** The columns of an `income` row a salary sums. */
export interface IncomeAmountRow {
  type: string;
  amount: number | string;
}

/**
 * The sum of `amount` over the rows of the given types, in the same float
 * arithmetic the screen always used (`sum + Number(amount)`).
 *
 * **Every row counts, whatever its sign.** A negative Uber fare, promotion or
 * tip is a stored row since 20261016170000, and a total that skipped it would
 * overstate what the driver earned by exactly what Uber took back. Do not clamp
 * a row here, and do not clamp the sum: the floor belongs to the salary
 * (`calcSalaryFromIncome`), not to the revenue.
 */
export function sumIncomeAmount(rows: readonly IncomeAmountRow[], types: readonly string[]): number {
  return rows.filter(row => types.includes(row.type)).reduce((sum, row) => sum + Number(row.amount), 0);
}

/** The income side of one driver's period, already summed by type. */
export interface SalaryIncomeInput {
  /** Umsatz + Aktionen. */
  revenue: number;
  /** Trinkgeld, which is pass-through and belongs wholly to the driver. */
  tips: number;
  /** `drivers.salary_ratio`; absent means DEFAULT_SALARY_RATIO. */
  salaryRatio?: number | null;
}

export interface SalaryFromIncome {
  salaryRatio: number;
  revenueShare: number;
  /** `(Umsatz + Aktionen) × ratio + Trinkgeld`, and never below zero. */
  amountDue: number;
  /**
   * What the period's clawbacks took beyond what the period earned: the amount
   * that could not be taken off the salary, in salary euros, rounded to cents.
   * Zero when the salary is not floored. Display only (rule 5); not carried to
   * the next period.
   */
  unrecovered: number;
}

/**
 * Rule 2, as one function so it can be pinned by a test — and rule 5.
 *
 * Tips are added at 100 % and never scaled by the ratio — the one part of this
 * formula a plausible-looking refactor gets wrong.
 *
 * Negative Uber figures are stored since 16.10.2026, so `revenue` and `tips`
 * can be below zero and the formula can go below zero. German payroll has no
 * negative wage: the salary is floored at zero and the shortfall is reported in
 * `unrecovered`. The formula is exactly the old one wherever it is not
 * negative (no rounding is added to it); the floor and the remainder are the
 * only new behaviour. A result within half a cent of zero is float noise, not
 * a shortfall (MONEY_EPSILON).
 */
export function calcSalaryFromIncome(input: SalaryIncomeInput): SalaryFromIncome {
  const salaryRatio = input.salaryRatio ?? DEFAULT_SALARY_RATIO;
  const revenueShare = input.revenue * salaryRatio;
  const raw = revenueShare + input.tips;
  const unrecovered = raw < -MONEY_EPSILON ? Math.round(-raw * 100) / 100 : 0;
  return { salaryRatio, revenueShare, amountDue: raw > 0 ? raw : 0, unrecovered };
}
