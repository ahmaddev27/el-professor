/**
 * The seed exists twice: in `src/lib/appConfigSeed.ts`, which the app shows
 * until the database answers, and in migration 20260916150000, which is what
 * the database actually holds.
 *
 * If the two drift, a screen prices a plan the database does not, and nobody
 * notices until a customer's invoice differs from what they were quoted. So the
 * migration's own text is the fixture here: these tests parse the seeds out of
 * it and compare them with the TypeScript constants, field for field.
 *
 * The trial length is pinned the same way, against the constant
 * `app_private.signup_insert_company` applies to a new company.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SEED_PLAN_FEATURES, SEED_PRICE_BOOK, SEED_TRIAL_DAYS } from './appConfigSeed';

const repoFile = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const SETTINGS_MIGRATION = repoFile('supabase/migrations/20260916150000_platform_settings_price_book.sql');
const SIGNUP_MIGRATION = repoFile('supabase/migrations/20260916100010_signup_insert_company.sql');
/** Plan 3.10, first half: the seller, the trial length and the invoice defaults. */
const TRIAL_MIGRATION = repoFile('supabase/migrations/20260919120000_platform_settings_seller_trial_invoice.sql');

/** The body of one `$tag$ … $tag$` dollar-quoted literal in a migration. */
function dollarQuoted(sql: string, tag: string): string {
  const match = sql.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`));
  if (!match) throw new Error(`the migration has no $${tag}$ block`);
  return match[1];
}

const seededJson = (tag: string): unknown => JSON.parse(dollarQuoted(SETTINGS_MIGRATION, tag));

describe('the seed the app shows and the seed the migration writes', () => {
  it('price_book: the same prices, tiers and yearly discount', () => {
    expect(seededJson('seed_price_book')).toEqual(SEED_PRICE_BOOK);
  });

  it('plan_features: the same feature map', () => {
    expect(seededJson('seed_plan_features')).toEqual(SEED_PLAN_FEATURES);
  });

  it('price_book names exactly the three plans, in integer cents', () => {
    expect(Object.keys(SEED_PRICE_BOOK.price_per_car_cents).sort()).toEqual(['advanced', 'basic', 'premium']);
    for (const cents of Object.values(SEED_PRICE_BOOK.price_per_car_cents)) {
      expect(Number.isInteger(cents)).toBe(true);
      expect(cents).toBeGreaterThan(0);
    }
  });

  it('the fleet discount tiers are sorted by min_cars, strictly increasing', () => {
    const tiers = SEED_PRICE_BOOK.fleet_discount_tiers;
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i].min_cars).toBeGreaterThan(tiers[i - 1].min_cars);
    }
  });

  it('every feature the app gates has a plan in the seed', () => {
    // SEED_PLAN_FEATURES is typed Record<FeatureKey, Plan>, so a new FeatureKey
    // without a seed fails to compile. This pins the count as well, so a key
    // deleted from both sides is noticed too.
    expect(Object.keys(SEED_PLAN_FEATURES)).toHaveLength(16);
  });
});

describe('the trial length', () => {
  /**
   * Plan 3.10 moved the trial out of `signup_insert_company`'s body and into the
   * `trial` setting. What has to stay true is that one number governs three
   * places at once — the setting, what a signup gives, and what
   * `get_public_config()` quotes — so the tests below pin the seed and the
   * wiring rather than a constant that no longer exists.
   *
   * `SIGNUP_MIGRATION` is still read: 20260916100010 is where the constant used
   * to live, and it must not come back there either.
   */
  it('the seeded trial is SEED_TRIAL_DAYS', () => {
    expect(JSON.parse(dollarQuoted(TRIAL_MIGRATION, 'seed_trial'))).toEqual({ days: SEED_TRIAL_DAYS });
  });

  it('signup_insert_company reads the setting instead of carrying a constant', () => {
    // The migration replaces the function; if it ever declares an interval of
    // its own again, the setting becomes a value nothing honours.
    expect(TRIAL_MIGRATION).toMatch(/v_trial_length\s+interval\s*:=\s*make_interval\(days => app_private\.signup_trial_days\(\)\)/);
    expect(TRIAL_MIGRATION).not.toMatch(/c_trial_length\s+CONSTANT/);
  });

  it('and signup_trial_days() falls back to SEED_TRIAL_DAYS when the document is missing', () => {
    // A single-row SELECT answers NULL when no row matches, and a NULL interval
    // would write a company whose trial never ends.
    const fallback = TRIAL_MIGRATION.match(/c_fallback\s+CONSTANT\s+integer\s*:=\s*(\d+);/);
    expect(fallback?.[1]).toBe(String(SEED_TRIAL_DAYS));
  });

  it('the migration that used to hold the constant no longer does', () => {
    expect(SIGNUP_MIGRATION.match(/c_trial_length\s+CONSTANT\s+interval\s*:=\s*interval\s*'(\d+) days'/)?.[1])
      .toBe(String(SEED_TRIAL_DAYS));
  });
});
