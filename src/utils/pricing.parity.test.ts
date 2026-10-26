import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { billedCars, calcPricing, fleetDiscountPercent, invoiceAmountCents, type BillingCycle, type PriceBook } from './pricing';
import { SEED_PRICE_BOOK } from '../lib/appConfigSeed';
import type { Plan } from '../contexts/PlanContext';

/**
 * The price is computed twice, and the two must not drift.
 *
 * `calcPricing()` here is what the landing page, the signup screen and the
 * platform dashboard show. `compute_plan_price()` is what the database charges
 * — it has to compute the price itself, because the browser used to send it and
 * a modified client could name its own.
 *
 * Since plan 3.9 both read the same price book from
 * `app_private.platform_settings`, so the numbers can no longer drift by
 * someone editing one constant. What can still drift is the *formula*, and that
 * is what this file pins, in two ways:
 *
 *  1. Today's book must still produce today's 42 numbers — the prices as they
 *     stood when they lived in the code. The migration's own self-check compares
 *     the same 42 combinations against 20260911120000's body in SQL.
 *  2. An alien book, one nobody would ship, must produce the numbers listed
 *     beside it. That list lives in `tests/rls/pricing.sql` and is read from
 *     there, so the SQL engine and this one are checked against one document: a
 *     formula that ignores the book (a constant left behind, a tier read the
 *     wrong way round) passes test 1 and fails test 2.
 *
 * The car counts are not arbitrary — they sit either side of each fleet
 * discount threshold, which is where an off-by-one shows up.
 */

// ─── 1. today's book, today's numbers ───────────────────────────────────────

/**
 * The output of, against the live schema before 3.9:
 *
 *   SELECT p || '|' || c || '|' || b || '|' || round(compute_plan_price(p, c, b)::numeric, 4)
 *   FROM (VALUES ('basic'),('advanced'),('premium')) AS a(p),
 *        (VALUES (1),(3),(5),(6),(10),(11),(25))     AS d(c),
 *        (VALUES ('monthly'),('yearly'))             AS e(b);
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

describe("today's price book still prices what the constants priced", () => {
  for (const plan of PLANS) {
    for (const cars of CARS) {
      for (const cycle of CYCLES) {
        const key = `${plan}|${cars}|${cycle}`;
        it(key, () => {
          expect(calcPricing(SEED_PRICE_BOOK, plan, cars, cycle).finalTotal).toBeCloseTo(EXPECTED[key], 4);
        });
      }
    }
  }

  it('covers every combination the SQL query produced', () => {
    expect(Object.keys(EXPECTED)).toHaveLength(PLANS.length * CARS.length * CYCLES.length);
  });
});

// ─── 2. the alien book, shared with tests/rls/pricing.sql ───────────────────

/** The body of one `$tag$ … $tag$` block of the SQL suite. */
function dollarQuoted(tag: string): string {
  const sql = readFileSync(new URL('../../tests/rls/pricing.sql', import.meta.url), 'utf8');
  const match = sql.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`));
  if (!match) throw new Error(`tests/rls/pricing.sql has no $${tag}$ block`);
  return match[1];
}

const ALIEN_BOOK = JSON.parse(dollarQuoted('alien_book')) as PriceBook;
const ALIEN_EXPECTED = JSON.parse(dollarQuoted('alien_expected')) as Record<string, number>;

describe('an alien price book: both engines follow the data', () => {
  it('is nothing like the one we ship', () => {
    expect(ALIEN_BOOK.price_per_car_cents).not.toEqual(SEED_PRICE_BOOK.price_per_car_cents);
    expect(ALIEN_BOOK.yearly_discount_percent).not.toBe(SEED_PRICE_BOOK.yearly_discount_percent);
    expect(ALIEN_BOOK.fleet_discount_tiers).toHaveLength(3);
  });

  it('lists the same 42 combinations as the grid above', () => {
    expect(Object.keys(ALIEN_EXPECTED)).toHaveLength(42);
  });

  for (const [key, expected] of Object.entries(ALIEN_EXPECTED)) {
    it(key, () => {
      const [plan, cars, cycle] = key.split('|');
      expect(calcPricing(ALIEN_BOOK, plan as Plan, Number(cars), cycle as BillingCycle).finalTotal)
        .toBeCloseTo(expected, 6);
    });
  }
});

// ─── 3. the first month (owner's decision, 15.10.2026) ──────────────────────

/**
 * "First month has a price of 200 Euro ignoring the number of cars, then each
 * car according to the price list we have." One flat figure in the book, for a
 * company's first invoice only. The alien book names 317,00 so a formula that
 * hard-codes 200 fails, and tests/rls/pricing.sql checks the same figure in SQL.
 */
describe('the first invoice is one flat price, whatever the plan, the cars and the cycle', () => {
  it("today's book: 200,00 for every one of the 42 combinations", () => {
    for (const plan of PLANS) {
      for (const cars of CARS) {
        for (const cycle of CYCLES) {
          const first = calcPricing(SEED_PRICE_BOOK, plan, cars, cycle, true);
          expect([plan, cars, cycle, first.finalTotal]).toEqual([plan, cars, cycle, 200]);
          expect(first.monthlyEquivalent).toBe(200);
          expect(first.firstInvoice).toBe(true);
        }
      }
    }
  });

  it('the alien book: its own 317,00, never a constant', () => {
    expect(ALIEN_BOOK.first_month_cents).toBe(31700);
    for (const key of Object.keys(ALIEN_EXPECTED)) {
      const [plan, cars, cycle] = key.split('|');
      const first = calcPricing(ALIEN_BOOK, plan as Plan, Number(cars), cycle as BillingCycle, true);
      expect([key, first.finalTotal]).toEqual([key, 317]);
    }
  });

  it('every later invoice is the price per car, exactly as before the decision', () => {
    for (const plan of PLANS) {
      for (const cars of CARS) {
        for (const cycle of CYCLES) {
          const key = `${plan}|${cars}|${cycle}`;
          const later = calcPricing(SEED_PRICE_BOOK, plan, cars, cycle, false);
          expect(later.finalTotal).toBeCloseTo(EXPECTED[key], 4);
          expect(later.firstInvoice).toBe(false);
        }
      }
    }
    expect(calcPricing(SEED_PRICE_BOOK, 'premium', 5, 'monthly').finalTotal).toBe(350);
  });

  it('a book that names no first month has none: the flag changes nothing, on all 42 listed numbers', () => {
    const { first_month_cents: _dropped, ...withoutFirstMonth } = ALIEN_BOOK;
    for (const [key, expected] of Object.entries(ALIEN_EXPECTED)) {
      const [plan, cars, cycle] = key.split('|');
      const first = calcPricing(withoutFirstMonth, plan as Plan, Number(cars), cycle as BillingCycle, true);
      expect(first.finalTotal).toBeCloseTo(expected, 6);
      expect(first.firstInvoice).toBe(false);
    }
  });
});

describe('invoiceAmountCents is the twin of app_private.invoice_amount_cents', () => {
  const premiumFive = (book: PriceBook, cycle: BillingCycle, first: boolean) =>
    invoiceAmountCents(book, 'premium', 5, cycle, first);

  it("today's book: MoveNow's case, premium with five cars", () => {
    expect(premiumFive(SEED_PRICE_BOOK, 'monthly', true)).toBe(20000);   // the first invoice
    expect(premiumFive(SEED_PRICE_BOOK, 'monthly', false)).toBe(35000);  // the second
    expect(premiumFive(SEED_PRICE_BOOK, 'yearly', true)).toBe(20000);
    expect(premiumFive(SEED_PRICE_BOOK, 'yearly', false)).toBe(31500);   // 3780 / 12
    expect(invoiceAmountCents(SEED_PRICE_BOOK, 'basic', 6, 'yearly', false)).toBe(10260);
  });

  it('the alien book: the same numbers tests/rls/pricing.sql asserts in SQL', () => {
    expect(premiumFive(ALIEN_BOOK, 'monthly', true)).toBe(31700);
    expect(premiumFive(ALIEN_BOOK, 'yearly', true)).toBe(31700);
    expect(premiumFive(ALIEN_BOOK, 'monthly', false)).toBe(37125);
    expect(premiumFive(ALIEN_BOOK, 'yearly', false)).toBe(29700);
    const { first_month_cents: _dropped, ...withoutFirstMonth } = ALIEN_BOOK;
    expect(premiumFive(withoutFirstMonth, 'monthly', true)).toBe(37125);
  });

  it('agrees with calcPricing on every listed combination, in whole cents', () => {
    for (const book of [SEED_PRICE_BOOK, ALIEN_BOOK]) {
      for (const key of Object.keys(ALIEN_EXPECTED)) {
        const [plan, cars, cycle] = key.split('|');
        for (const first of [true, false]) {
          const quoted = calcPricing(book, plan as Plan, Number(cars), cycle as BillingCycle, first);
          expect([key, first, invoiceAmountCents(book, plan as Plan, Number(cars), cycle as BillingCycle, first)])
            .toEqual([key, first, Math.round(quoted.monthlyEquivalent * 100)]);
        }
      }
    }
  });
});

// ─── 5. the zero-car floor (20261026110000) ─────────────────────────────────

/**
 * `billedCars` is the one place either engine floors the quantity, and until
 * 20261026110000 it did not exist: `app_private.price_book_price` floored,
 * `invoiceAmountCents` floored, and `calcPricing` did not. No gate caught the
 * difference, because every grid above starts at one car.
 *
 * It starts to matter the day the invoice is quoted on the real fleet rather
 * than on `companies.subscription_car_limit`, which is what that migration
 * does: measured on production 26.10.2026, twelve of eighteen companies run no
 * cars at all, so without the floor twelve invoices would read 0,00 EUR.
 *
 * The numbers are the ones SQL already asserts, read out of the same alien book
 * `tests/rls/pricing.sql` prices from — so this block and that file cannot
 * drift, and a formula that ignored the book would fail here as well:
 *
 *   PERFORM _pr_ok('alien book: a NULL car count bills one car, a count below
 *                   one bills one at its own tier',
 *     public.compute_plan_price('basic', NULL, 'monthly') = 12.5
 *     AND public.compute_plan_price('basic', 0, 'monthly') = 12.5
 *     AND public.compute_plan_price('basic', -3, 'monthly') = 12.5);
 *
 * The asymmetry is the point and is asserted separately below: the AMOUNT is
 * floored to one car, the fleet TIER is looked up on the count as given. The
 * alien book's first tier is at two cars, so neither 0 nor -3 reaches one.
 */
describe('a car count below one bills one car, and reaches no fleet tier', () => {
  it('billedCars is the floor, and nothing else is', () => {
    for (const cars of [0, -3, null, undefined]) expect(billedCars(cars)).toBe(1);
    expect(billedCars(1)).toBe(1);
    expect(billedCars(5)).toBe(5);
    expect(billedCars(25)).toBe(25);
  });

  it('calcPricing bills one car for a count of none, under both books', () => {
    for (const cars of [0, -3]) {
      // basic, monthly: the figure SQL pins at 12,50 under the alien book.
      expect([cars, calcPricing(ALIEN_BOOK, 'basic', cars, 'monthly').finalTotal]).toEqual([cars, 12.5]);
      // and under the book we ship: one car on premium is 70,00, not 0,00.
      expect([cars, calcPricing(SEED_PRICE_BOOK, 'premium', cars, 'monthly').finalTotal]).toEqual([cars, 70]);
      expect([cars, calcPricing(SEED_PRICE_BOOK, 'premium', cars, 'monthly').baseMonthly]).toEqual([cars, 70]);
    }
  });

  it('invoiceAmountCents agrees with it, in whole cents, on every plan and cycle', () => {
    for (const book of [SEED_PRICE_BOOK, ALIEN_BOOK]) {
      for (const plan of PLANS) {
        for (const cycle of CYCLES) {
          const one = invoiceAmountCents(book, plan, 1, cycle, false);
          for (const cars of [0, -3]) {
            expect([plan, cycle, cars, invoiceAmountCents(book, plan, cars, cycle, false)])
              .toEqual([plan, cycle, cars, one]);
          }
        }
      }
    }
  });

  it('the floor does not buy a fleet discount: the tier is read on the count as given', () => {
    // The alien book's cheapest tier starts at two cars and takes 3% off.
    expect(fleetDiscountPercent(ALIEN_BOOK, 0)).toBe(0);
    expect(fleetDiscountPercent(ALIEN_BOOK, -3)).toBe(0);
    expect(fleetDiscountPercent(ALIEN_BOOK, 2)).toBe(3);
    // So 0 cars and 1 car cost the same, and 2 cars is not twice 1 car.
    expect(calcPricing(ALIEN_BOOK, 'basic', 0, 'monthly').finalTotal)
      .toBe(calcPricing(ALIEN_BOOK, 'basic', 1, 'monthly').finalTotal);
    expect(calcPricing(ALIEN_BOOK, 'basic', 2, 'monthly').fleetDiscountPct).toBe(3);
  });

  it('a first invoice is the flat figure even with no cars at all', () => {
    for (const cars of [0, -3]) {
      expect(calcPricing(SEED_PRICE_BOOK, 'premium', cars, 'monthly', true).finalTotal).toBe(200);
      expect(invoiceAmountCents(SEED_PRICE_BOOK, 'premium', cars, 'monthly', true)).toBe(20000);
    }
  });

  it('leaves all 42 of the listed numbers exactly where they were', () => {
    // The floor cannot reach a count of one or more, so this restates the grid
    // above on purpose: it is the assertion that this gate added a row rather
    // than moving one.
    for (const [key, expected] of Object.entries(EXPECTED)) {
      const [plan, cars, cycle] = key.split('|');
      expect([key, calcPricing(SEED_PRICE_BOOK, plan as Plan, Number(cars), cycle as BillingCycle).finalTotal])
        .toEqual([key, expected]);
    }
    expect(Object.keys(EXPECTED)).toHaveLength(42);
  });
});
