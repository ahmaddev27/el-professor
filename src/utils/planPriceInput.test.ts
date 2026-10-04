/**
 * The monthly price of a subscription plan, as an administrator types it.
 *
 * **Half one — what must not move.** `subscription_plans.monthly_price` is euros
 * (`numeric`, no scale). Measured on staging on 28.09.2026: **1 row, priced 200,
 * and 0 rows carrying more than two decimals.** So the shipped body and this one
 * agree on every figure stored today, and the first `describe` below is what
 * keeps it that way — a plain `'200'` must stay 200, and a legitimate zero must
 * stay 0 rather than becoming a refusal.
 *
 * **Half two — the defect.** The shipped body was
 * `parseFloat(text.replace(',', '.'))`. A German price kept its grouping dot and
 * gained a second one, and `parseFloat` stops at the second:
 *
 *   '1.200,00' -> '1.200.00' -> **1.2**    a plan sold for 1,20 € instead of 1200
 *   '2.480,00' -> '2.480.00' -> **2.48**
 *   '1 200'    -> unchanged   -> **1**     the space stops parseFloat
 *   'abc'      -> **NaN**, which supabase-js serialises as `null`
 *
 * None of those occur in the one stored row, which is why this is latent and not
 * live — and why it would have been silent on the first plan priced above 999 €.
 *
 * Every assertion in the second describe carries the shipped figure beside the
 * correct one, so restoring the old body fails this file rather than being
 * reasoned about.
 */
import { describe, expect, it } from 'vitest';
import { parsePlanPriceInput } from './planPriceInput';

/** The body that shipped, so the difference can be seen rather than asserted. */
function parsePlanPriceAsShipped(raw: string): number {
  return parseFloat(raw.replace(',', '.'));
}

describe('parsePlanPriceInput — the prices in use today, which must not move', () => {
  const unchanged: Array<[string, number]> = [
    ['200', 200], // the one row on staging, and the field's own placeholder
    ['200,50', 200.5],
    ['0', 0], // a free plan: '0' passes the modal's required-field guard already
    ['99', 99],
    ['999,99', 999.99],
    ['200 €', 200], // a trailing euro sign, which a German admin types by habit
    ['  200  ', 200], // and the whitespace around it
  ];

  it.each(unchanged)('reads %p as %p', (input, expected) => {
    expect(parsePlanPriceInput(input)).toBe(expected);
  });

  it.each([
    ['200', 200],
    ['200,50', 200.5],
    ['0', 0],
    ['99', 99],
    ['999,99', 999.99],
  ] as Array<[string, number]>)(
    'agrees with the shipped body on %p, so no stored price changes',
    (input, expected) => {
      // The characterization half: these are the shapes that already worked.
      expect(parsePlanPriceAsShipped(input)).toBe(expected);
    },
  );

  it('round-trips a stored price through the edit form', () => {
    // `handleEdit` fills the field with `plan.monthly_price.toString()`, so
    // whatever the database holds has to read back as itself.
    for (const stored of [200, 0, 99.5, 1200, 2480, 15]) {
      expect(parsePlanPriceInput(stored.toString())).toBe(stored);
    }
  });
});

describe('parsePlanPriceInput — the German prices the shipped body got wrong', () => {
  const corrected: Array<[string, number, number]> = [
    // input,        correct,   what shipped
    ['1.200,00', 1200, 1.2],
    ['2.480,00', 2480, 2.48],
    ['10.000,50', 10000.5, 10],
    // 1.234, not 1.23: unlike `parseMoney`, the modal's body never rounded to
    // the cent, so it would have stored a third decimal in an unconstrained
    // `numeric` column.
    ['1.234.567,89', 1234567.89, 1.234],
    ['1 200', 1200, 1],
    ['1.200.000', 1200000, 1.2],
  ];

  it.each(corrected)('reads %p as %p, where the shipped body gave %p', (input, correct, shipped) => {
    expect(parsePlanPriceInput(input)).toBe(correct);
    // NEGATIVE CONTROL: the old body really did return the wrong figure, so this
    // file fails loudly if someone restores it.
    expect(parsePlanPriceAsShipped(input)).toBe(shipped);
    expect(shipped).not.toBe(correct);
  });
});

describe('parsePlanPriceInput — text that is not a price is refused, not stored', () => {
  const refused = ['', '   ', 'abc', 'zweihundert', '-5', '-200,00', '€', '200 abc', 'e5', '.', ','];

  it.each(refused)('refuses %p', input => {
    expect(parsePlanPriceInput(input)).toBeNull();
  });

  it('refuses garbage that the shipped body turned into NaN', () => {
    // NEGATIVE CONTROL for the other half of the defect: the old body did not
    // refuse, it produced NaN, which supabase-js serialises as `null` — so the
    // insert either failed with the database's own message or stored no price.
    expect(Number.isNaN(parsePlanPriceAsShipped('abc'))).toBe(true);
    expect(Number.isNaN(parsePlanPriceAsShipped(''))).toBe(true);
    expect(parsePlanPriceInput('abc')).toBeNull();
  });

  it('refuses a negative price rather than negating it', () => {
    // A monthly price below zero is a typo every time. The shipped body happily
    // read it, which is the second negative control.
    expect(parsePlanPriceAsShipped('-5')).toBe(-5);
    expect(parsePlanPriceInput('-5')).toBeNull();
  });

  it('refuses the one genuinely ambiguous shape rather than guessing it', () => {
    // '1.200' is either 1200 (a grouping dot, the German reading) or 1.2 (a
    // decimal point). `parseMoney` answers 1.2, deliberately, because 27273
    // stored ride amounts depend on a single dot being a decimal point. For a
    // plan price that reading keeps exactly the factor of 1000 this module
    // exists to remove, so the field asks for it again instead.
    expect(parsePlanPriceInput('1.200')).toBeNull();
    expect(parsePlanPriceInput('12.500')).toBeNull();

    // Both unambiguous spellings of the same price are accepted.
    expect(parsePlanPriceInput('1200')).toBe(1200);
    expect(parsePlanPriceInput('1.200,00')).toBe(1200);

    // And a dot with anything but three digits after it stays a decimal point,
    // which is what a `toString()` of a stored price produces.
    expect(parsePlanPriceInput('1.2')).toBe(1.2);
    expect(parsePlanPriceInput('99.5')).toBe(99.5);
    expect(parsePlanPriceInput('1200.5')).toBe(1200.5);
  });
});
