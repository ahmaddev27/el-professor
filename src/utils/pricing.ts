import { Plan } from '../contexts/PlanContext';

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

/** Price per car per month (EUR) by plan */
export const PRICE_PER_CAR: Record<Plan, number> = {
  basic:    20,
  advanced: 40,
  premium:  70,
};

/** Fleet discount percentage by car count */
export function fleetDiscountPercent(carLimit: number): number {
  if (carLimit >= 11) return 10;
  if (carLimit >= 6)  return 5;
  return 0;
}

/** Yearly billing discount (applied after fleet discount) */
export const YEARLY_DISCOUNT_PERCENT = 10;

export interface PriceBreakdown {
  pricePerCar: number;           // EUR/car/month
  baseMonthly: number;           // carLimit * pricePerCar
  fleetDiscountPct: number;      // 0, 5, or 10
  monthlyAfterFleet: number;     // baseMonthly * (1 - fleet%)
  billingCycle: BillingCycle;
  yearlyDiscountPct: number;     // 0 or 10
  /** Final billed amount — monthly total if monthly, full year if yearly */
  finalTotal: number;
  /** Monthly equivalent (finalTotal / 12 for yearly, same as monthlyAfterFleet for monthly) */
  monthlyEquivalent: number;
  /** Annual total (monthlyAfterFleet * 12 * 0.9) — useful for display even in monthly mode */
  yearlyTotal: number;
}

/**
 * Calculate full pricing breakdown.
 *
 * Formula:
 *   baseMonthly        = carLimit * pricePerCar
 *   monthlyAfterFleet  = baseMonthly * (1 - fleetDiscount)
 *   yearlyTotal        = monthlyAfterFleet * 12 * 0.90
 *   monthlyTotal       = monthlyAfterFleet
 */
export function calcPricing(
  plan: Plan,
  carLimit: number,
  billingCycle: BillingCycle
): PriceBreakdown {
  const pricePerCar       = PRICE_PER_CAR[plan];
  const baseMonthly       = carLimit * pricePerCar;
  const fleetDiscountPct  = fleetDiscountPercent(carLimit);
  const monthlyAfterFleet = baseMonthly * (1 - fleetDiscountPct / 100);
  const yearlyTotal       = monthlyAfterFleet * 12 * (1 - YEARLY_DISCOUNT_PERCENT / 100);

  const finalTotal =
    billingCycle === 'yearly' ? yearlyTotal : monthlyAfterFleet;
  const monthlyEquivalent =
    billingCycle === 'yearly' ? finalTotal / 12 : monthlyAfterFleet;

  return {
    pricePerCar,
    baseMonthly,
    fleetDiscountPct,
    monthlyAfterFleet,
    billingCycle,
    yearlyDiscountPct: billingCycle === 'yearly' ? YEARLY_DISCOUNT_PERCENT : 0,
    finalTotal,
    monthlyEquivalent,
    yearlyTotal,
  };
}

export function fmt(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
