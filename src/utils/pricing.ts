import type { Plan } from '../contexts/PlanContext';

export type BillingCycle = 'monthly' | 'yearly';

export interface DiscountResult {
  discount_code_id: string;
  usage_mode: 'once' | 'monthly';
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  discount_amount: number;
  final_price: number;
  german_message: string;
  code: string;
}

/** From `min_cars` cars on, `percent` off the monthly price. */
export interface FleetDiscountTier {
  readonly min_cars: number;
  readonly percent: number;
}

/**
 * The price book, as `app_private.platform_settings` holds it under the key
 * `price_book` (migration 20260916150000).
 *
 * Prices are integer cents per car per month and percentages whole numbers.
 * `first_month_cents`, when the book names it, is the flat price of a company's
 * first invoice (owner's decision, 15.10.2026; migration 20261015160000).
 * Tiers are sorted by `min_cars`, strictly increasing. The database validates
 * every book it saves; screens get the book from AppConfigContext, and
 * `compute_plan_price()` reads the same row, so the price a screen shows and the
 * price the database charges come from one place.
 */
export interface PriceBook {
  readonly price_per_car_cents: Readonly<Record<Plan, number>>;
  readonly fleet_discount_tiers: readonly FleetDiscountTier[];
  readonly yearly_discount_percent: number;
  /**
   * The flat price of a company's first invoice, in integer cents, whatever its
   * plan, car count or cycle. Absent: the book has no first month and every
   * invoice is priced per car, which is what every book saved before the
   * decision says.
   */
  readonly first_month_cents?: number;
}

/** The discount of the highest tier the car count reaches, or 0. */
export function fleetDiscountPercent(book: PriceBook, carLimit: number): number {
  let percent = 0;
  for (const tier of book.fleet_discount_tiers) {
    if (tier.min_cars <= carLimit) percent = tier.percent;
  }
  return percent;
}

export interface PriceBreakdown {
  pricePerCarCents: number;      // cents/car/month
  pricePerCar: number;           // EUR/car/month
  baseMonthly: number;           // carLimit * pricePerCar
  fleetDiscountPct: number;      // the tier's percent, 0 below the first tier
  monthlyAfterFleet: number;     // baseMonthly * (1 - fleet%)
  billingCycle: BillingCycle;
  yearlyDiscountPct: number;     // the book's yearly percent, 0 for monthly
  /** Final billed amount — monthly total if monthly, full year if yearly */
  finalTotal: number;
  /** Monthly equivalent (finalTotal / 12 for yearly, same as monthlyAfterFleet for monthly) */
  monthlyEquivalent: number;
  /** Annual total (monthlyAfterFleet * 12 * (1 - yearly%)) — useful for display even in monthly mode */
  yearlyTotal: number;
  /**
   * True when this is the figure of a company's first invoice and the book names
   * one: `finalTotal` and `monthlyEquivalent` are then the flat price, and every
   * other figure stays the per-car one, so a screen can print both.
   */
  firstInvoice: boolean;
}

/**
 * The full price of a plan, a car count and a billing cycle under one price
 * book. Amounts are euros, as the screens print them.
 *
 * The rule, the same as `app_private.price_book_price()` in SQL:
 *   baseMonthly        = carLimit * pricePerCar
 *   monthlyAfterFleet  = baseMonthly * (1 - fleet%)
 *   yearlyTotal        = monthlyAfterFleet * 12 * (1 - yearly%)
 *   finalTotal         = yearlyTotal for 'yearly', monthlyAfterFleet otherwise
 *
 * With `firstInvoice` and a book that names `first_month_cents`, `finalTotal` and
 * `monthlyEquivalent` are that flat figure, whatever the plan, the cars or the
 * cycle, exactly as `compute_plan_price(…, true)` answers.
 *
 * Computed on integers first (cents times whole percentages) with one division
 * at the end, so no binary rounding error builds up along the chain. Nothing is
 * rounded to cents: today's book always gives whole cents, and a book that did
 * not would be the owner's rounding decision (D9), in both engines at once.
 */
export function calcPricing(
  book: PriceBook,
  plan: Plan,
  carLimit: number,
  billingCycle: BillingCycle,
  firstInvoice = false
): PriceBreakdown {
  const pricePerCarCents  = book.price_per_car_cents[plan];
  const fleetDiscountPct  = fleetDiscountPercent(book, carLimit);
  const yearlyPct         = book.yearly_discount_percent;

  const baseMonthlyCents  = carLimit * pricePerCarCents;
  // euros × 10^4 and euros × 10^6: whole numbers for whole cents and percents
  const monthlyE4         = baseMonthlyCents * (100 - fleetDiscountPct);
  const yearlyE6          = monthlyE4 * 12 * (100 - yearlyPct);

  const monthlyAfterFleet = monthlyE4 / 10_000;
  const yearlyTotal       = yearlyE6 / 1_000_000;

  const flatCents = flatFirstMonthCents(book, firstInvoice);

  const finalTotal = flatCents !== null
    ? flatCents / 100
    : billingCycle === 'yearly' ? yearlyTotal : monthlyAfterFleet;
  const monthlyEquivalent = flatCents !== null
    ? flatCents / 100
    : billingCycle === 'yearly' ? yearlyE6 / 12_000_000 : monthlyAfterFleet;

  return {
    pricePerCarCents,
    pricePerCar: pricePerCarCents / 100,
    baseMonthly: baseMonthlyCents / 100,
    fleetDiscountPct,
    monthlyAfterFleet,
    billingCycle,
    yearlyDiscountPct: billingCycle === 'yearly' ? yearlyPct : 0,
    finalTotal,
    monthlyEquivalent,
    yearlyTotal,
    firstInvoice: flatCents !== null,
  };
}

/** The flat figure of a first invoice, or null when this is not one or the book names none. */
function flatFirstMonthCents(book: PriceBook, firstInvoice: boolean): number | null {
  return firstInvoice && book.first_month_cents !== undefined ? book.first_month_cents : null;
}

/**
 * What one invoice costs, in integer cents: the twin of
 * `app_private.invoice_amount_cents()`, the single place the database decides an
 * amount.
 *
 *   - a first invoice and a book that names the figure: the figure;
 *   - otherwise a yearly company: the yearly price in twelve parts;
 *   - otherwise the monthly price per car.
 *
 * Rounded once, half up, on integers: the monthly price is euros x 10^4 and the
 * yearly one euros x 10^6, so the cents are an exact integer division and the
 * `+ half` before it is the rounding. Never a float on the way.
 */
export function invoiceAmountCents(
  book: PriceBook,
  plan: Plan,
  carLimit: number,
  billingCycle: BillingCycle,
  firstInvoice: boolean
): number {
  const flatCents = flatFirstMonthCents(book, firstInvoice);
  if (flatCents !== null) return flatCents;

  const monthlyE4 = Math.max(carLimit, 1) * book.price_per_car_cents[plan]
    * (100 - fleetDiscountPercent(book, carLimit));
  if (billingCycle === 'yearly') {
    const yearlyE6 = monthlyE4 * 12 * (100 - book.yearly_discount_percent);
    return Math.floor((yearlyE6 + 60_000) / 120_000);
  }
  return Math.floor((monthlyE4 + 50) / 100);
}

export function fmt(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * A per-car price the way the plan cards print it: whole euros without
 * decimals ("20"), any other amount with two ("12,34"). Today's prices are whole
 * euros, so the cards read as they did when the prices were constants.
 */
export function fmtPricePerCar(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : fmt(cents / 100);
}

/** One line of the fleet discount explanation: `fromCars` to `toCars` (or more, when null). */
export interface FleetDiscountBand {
  fromCars: number;
  toCars: number | null;
  percent: number;
}

/**
 * The fleet discount tiers as consecutive bands from one car on, including the
 * undiscounted band below the first tier. Today's book gives 1–5: 0 %, 6–10: 5 %,
 * 11+: 10 %.
 */
export function fleetDiscountBands(book: PriceBook): FleetDiscountBand[] {
  const tiers = book.fleet_discount_tiers;
  const bands: FleetDiscountBand[] = [];
  if (tiers.length === 0 || tiers[0].min_cars > 1) {
    bands.push({ fromCars: 1, toCars: tiers.length === 0 ? null : tiers[0].min_cars - 1, percent: 0 });
  }
  tiers.forEach((tier, index) => {
    const next = tiers[index + 1];
    bands.push({ fromCars: tier.min_cars, toCars: next ? next.min_cars - 1 : null, percent: tier.percent });
  });
  return bands;
}

// The bounds of app_private.platform_settings_problem() in 20260916150000.
const MAX_PRICE_CENTS = 1_000_000;
const MAX_TIERS = 20;
const MAX_TIER_MIN_CARS = 100_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isIntegerBetween = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/**
 * Reads a price book from a database answer. Anything that does not have the
 * shape the database validates on save is not a price book: the caller keeps
 * the one it already shows rather than pricing from a broken document.
 */
export function parsePriceBook(value: unknown): PriceBook | null {
  if (!isRecord(value) || !isRecord(value.price_per_car_cents) || !Array.isArray(value.fleet_discount_tiers)) {
    return null;
  }

  const { basic, advanced, premium } = value.price_per_car_cents;
  if (!isIntegerBetween(basic, 0, MAX_PRICE_CENTS)
      || !isIntegerBetween(advanced, 0, MAX_PRICE_CENTS)
      || !isIntegerBetween(premium, 0, MAX_PRICE_CENTS)) {
    return null;
  }

  if (value.fleet_discount_tiers.length > MAX_TIERS) return null;
  const tiers: FleetDiscountTier[] = [];
  for (const tier of value.fleet_discount_tiers) {
    if (!isRecord(tier)
        || !isIntegerBetween(tier.min_cars, 1, MAX_TIER_MIN_CARS)
        || !isIntegerBetween(tier.percent, 0, 100)) {
      return null;
    }
    if (tiers.length > 0 && tier.min_cars <= tiers[tiers.length - 1].min_cars) return null;
    tiers.push({ min_cars: tier.min_cars, percent: tier.percent });
  }

  if (!isIntegerBetween(value.yearly_discount_percent, 0, 100)) return null;

  // Optional: a book saved before 20261015160000 names no first month.
  const first = value.first_month_cents;
  if (first !== undefined && !isIntegerBetween(first, 0, MAX_PRICE_CENTS)) return null;

  return {
    price_per_car_cents: { basic, advanced, premium },
    fleet_discount_tiers: tiers,
    yearly_discount_percent: value.yearly_discount_percent,
    ...(first !== undefined ? { first_month_cents: first } : {}),
  };
}
