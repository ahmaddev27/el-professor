import { describe, expect, it } from 'vitest';
import { calcPricing, type BillingCycle } from './pricing';
import type { Plan } from '../contexts/PlanContext';

/**
 * The price exists in two places, and they must not drift.
 *
 * `calcPricing()` here is what the signup screen shows. `compute_plan_price()`
 * in 20260911120000_redeem_discount_code_rpc.sql is what the database charges —
 * it has to compute the price itself, because the browser used to send it and a
 * modified client could name its own.
 *
 * Duplication is the cost of not trusting the client. This test is what keeps
 * the cost bounded: change one formula without the other and it fails, rather
 * than quietly putting a different number on the invoice than on the screen.
 *
 * EXPECTED is the output of, against the live schema:
 *
 *   SELECT p || '|' || c || '|' || b || '|' || round(compute_plan_price(p, c, b)::numeric, 4)
 *   FROM (VALUES ('basic'),('advanced'),('premium')) AS a(p),
 *        (VALUES (1),(3),(5),(6),(10),(11),(25))     AS d(c),
 *        (VALUES ('monthly'),('yearly'))             AS e(b);
 *
 * The car counts are not arbitrary: 5/6 and 10/11 sit either side of the fleet
 * discount thresholds, which is where an off-by-one in either formula shows up.
 */
const EXPECTED: Record<string, number> = {
  'basic|1|monthly': 20, 'basic|1|yearly': 216,
  'basic|3|monthly': 60, 'basic|3|yearly': 648,
  'basic|5|monthly': 100, 'basic|5|yearly': 1080,
  'basic|6|monthly': 114, 'basic|6|yearly': 1231.2,
  'basic|10|monthly': 190, 'basic|10|yearly': 2052,
  'basic|11|monthly': 198, 'basic|11|yearly': 2138.4,
  'basic|25|monthly': 450, 'basic|25|yearly': 4860,

  'advanced|1|monthly': 40, 'advanced|1|yearly': 432,
  'advanced|3|monthly': 120, 'advanced|3|yearly': 1296,
  'advanced|5|monthly': 200, 'advanced|5|yearly': 2160,
  'advanced|6|monthly': 228, 'advanced|6|yearly': 2462.4,
  'advanced|10|monthly': 380, 'advanced|10|yearly': 4104,
  'advanced|11|monthly': 396, 'advanced|11|yearly': 4276.8,
  'advanced|25|monthly': 900, 'advanced|25|yearly': 9720,

  'premium|1|monthly': 70, 'premium|1|yearly': 756,
  'premium|3|monthly': 210, 'premium|3|yearly': 2268,
  'premium|5|monthly': 350, 'premium|5|yearly': 3780,
  'premium|6|monthly': 399, 'premium|6|yearly': 4309.2,
  'premium|10|monthly': 665, 'premium|10|yearly': 7182,
  'premium|11|monthly': 693, 'premium|11|yearly': 7484.4,
  'premium|25|monthly': 1575, 'premium|25|yearly': 17010,
};

const PLANS: Plan[] = ['basic', 'advanced', 'premium'];
const CARS = [1, 3, 5, 6, 10, 11, 25];
const CYCLES: BillingCycle[] = ['monthly', 'yearly'];

describe('pricing parity between calcPricing() and compute_plan_price()', () => {
  for (const plan of PLANS) {
    for (const cars of CARS) {
      for (const cycle of CYCLES) {
        const key = `${plan}|${cars}|${cycle}`;
        it(key, () => {
          expect(calcPricing(plan, cars, cycle).finalTotal).toBeCloseTo(EXPECTED[key], 4);
        });
      }
    }
  }

  it('covers every combination the SQL query produced', () => {
    expect(Object.keys(EXPECTED)).toHaveLength(PLANS.length * CARS.length * CYCLES.length);
  });
});
