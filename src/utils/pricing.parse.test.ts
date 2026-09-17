/**
 * `parsePriceBook` is the browser's door for the price book the database sends.
 *
 * The rule it enforces is the one `app_private.platform_settings_problem()`
 * enforces on save (migration 20260916150000): the price per car is **integer
 * cents** for exactly the three plans, the fleet discount tiers are sorted by
 * `min_cars` and strictly increasing with whole-percent discounts, and the
 * yearly discount is a whole percent. Anything else is **not a price book** —
 * it returns null and the caller keeps the book it is already showing, rather
 * than quoting a customer a price computed from a broken document.
 *
 * `pricing.parity.test.ts` pins what the numbers are; this pins what is let in.
 */
import { describe, expect, it } from 'vitest';
import { fleetDiscountBands, fleetDiscountPercent, parsePriceBook } from './pricing';
import { SEED_PRICE_BOOK } from '../lib/appConfigSeed';

/** The seeded book as a plain JSON answer, with one part replaced. */
const bookWith = (patch: Record<string, unknown>): unknown => ({
  ...JSON.parse(JSON.stringify(SEED_PRICE_BOOK)),
  ...patch,
});

const pricesWith = (patch: Record<string, unknown>): unknown =>
  bookWith({ price_per_car_cents: { ...SEED_PRICE_BOOK.price_per_car_cents, ...patch } });

describe('parsePriceBook accepts a book the database would have stored', () => {
  it('reads the seeded book unchanged', () => {
    expect(parsePriceBook(JSON.parse(JSON.stringify(SEED_PRICE_BOOK)))).toEqual(SEED_PRICE_BOOK);
  });

  it('accepts a book with no fleet discount at all', () => {
    const book = parsePriceBook(bookWith({ fleet_discount_tiers: [] }));
    expect(book?.fleet_discount_tiers).toEqual([]);
    expect(fleetDiscountPercent(book!, 100)).toBe(0);
  });

  it('accepts free plans and a zero yearly discount', () => {
    const book = parsePriceBook(bookWith({
      price_per_car_cents: { basic: 0, advanced: 0, premium: 0 },
      yearly_discount_percent: 0,
    }));
    expect(book?.price_per_car_cents.basic).toBe(0);
    expect(book?.yearly_discount_percent).toBe(0);
  });

  it('accepts twenty tiers and the largest allowed values', () => {
    const tiers = Array.from({ length: 20 }, (_, i) => ({ min_cars: i + 2, percent: i + 1 }));
    expect(parsePriceBook(bookWith({ fleet_discount_tiers: tiers }))?.fleet_discount_tiers)
      .toHaveLength(20);
    expect(parsePriceBook(pricesWith({ premium: 1_000_000 }))).not.toBeNull();
    expect(parsePriceBook(bookWith({ yearly_discount_percent: 100 }))).not.toBeNull();
  });

  it('keeps only the fields it knows, so an extra one cannot reach a price', () => {
    const book = parsePriceBook(bookWith({ vat_percent: 19, price_per_car_cents: { ...SEED_PRICE_BOOK.price_per_car_cents, gold: 5000 } }));
    expect(book).not.toBeNull();
    expect(Object.keys(book!).sort())
      .toEqual(['fleet_discount_tiers', 'price_per_car_cents', 'yearly_discount_percent']);
    expect(Object.keys(book!.price_per_car_cents).sort()).toEqual(['advanced', 'basic', 'premium']);
  });

  it('the tiers it returns are a copy, and read as consecutive bands', () => {
    const book = parsePriceBook(JSON.parse(JSON.stringify(SEED_PRICE_BOOK)))!;
    expect(fleetDiscountBands(book)).toEqual([
      { fromCars: 1, toCars: 5, percent: 0 },
      { fromCars: 6, toCars: 10, percent: 5 },
      { fromCars: 11, toCars: null, percent: 10 },
    ]);
  });
});

describe('a malformed database answer is not a price book', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [SEED_PRICE_BOOK]],
    ['a string', JSON.stringify(SEED_PRICE_BOOK)],
    ['a number', 20],
    ['an empty object', {}],
  ])('%s', (_label, value) => {
    expect(parsePriceBook(value)).toBeNull();
  });

  it.each([
    ['no price_per_car_cents', bookWith({ price_per_car_cents: undefined })],
    ['prices as an array', bookWith({ price_per_car_cents: [2000, 4000, 7000] })],
    ['a plan missing', { fleet_discount_tiers: [], yearly_discount_percent: 10, price_per_car_cents: { basic: 2000, advanced: 4000 } }],
    ['a price in euros, not cents', pricesWith({ basic: 20.5 })],
    ['a negative price', pricesWith({ premium: -1 })],
    ['a price above the cap', pricesWith({ premium: 1_000_001 })],
    ['a price as a string', pricesWith({ basic: '2000' })],
    ['a price that is NaN', pricesWith({ basic: Number.NaN })],
  ])('the prices are wrong: %s', (_label, value) => {
    expect(parsePriceBook(value)).toBeNull();
  });

  it.each([
    ['tiers as an object', bookWith({ fleet_discount_tiers: { 6: 5 } })],
    ['no tiers field', bookWith({ fleet_discount_tiers: undefined })],
    ['a tier that is not an object', bookWith({ fleet_discount_tiers: [6] })],
    ['min_cars below one', bookWith({ fleet_discount_tiers: [{ min_cars: 0, percent: 5 }] })],
    ['min_cars above the cap', bookWith({ fleet_discount_tiers: [{ min_cars: 100_001, percent: 5 }] })],
    ['a fractional min_cars', bookWith({ fleet_discount_tiers: [{ min_cars: 6.5, percent: 5 }] })],
    ['a discount above 100 %', bookWith({ fleet_discount_tiers: [{ min_cars: 6, percent: 101 }] })],
    ['a negative discount', bookWith({ fleet_discount_tiers: [{ min_cars: 6, percent: -5 }] })],
    ['tiers out of order', bookWith({ fleet_discount_tiers: [{ min_cars: 11, percent: 10 }, { min_cars: 6, percent: 5 }] })],
    ['two tiers at the same car count', bookWith({ fleet_discount_tiers: [{ min_cars: 6, percent: 5 }, { min_cars: 6, percent: 10 }] })],
    ['twenty-one tiers', bookWith({ fleet_discount_tiers: Array.from({ length: 21 }, (_, i) => ({ min_cars: i + 2, percent: 1 })) })],
  ])('the fleet discount is wrong: %s', (_label, value) => {
    expect(parsePriceBook(value)).toBeNull();
  });

  it.each([
    ['missing', bookWith({ yearly_discount_percent: undefined })],
    ['a fraction', bookWith({ yearly_discount_percent: 10.5 })],
    ['above 100', bookWith({ yearly_discount_percent: 101 })],
    ['negative', bookWith({ yearly_discount_percent: -10 })],
    ['a string', bookWith({ yearly_discount_percent: '10' })],
  ])('the yearly discount is wrong: %s', (_label, value) => {
    expect(parsePriceBook(value)).toBeNull();
  });
});
