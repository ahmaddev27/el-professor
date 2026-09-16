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
  it('signup_trial_days() in the migration returns SEED_TRIAL_DAYS', () => {
    const body = SETTINGS_MIGRATION.match(
      /FUNCTION app_private\.signup_trial_days\(\)[\s\S]*?RETURN (\d+);/,
    );
    expect(body?.[1]).toBe(String(SEED_TRIAL_DAYS));
  });

  it('is the trial signup_insert_company actually gives a new company', () => {
    const constant = SIGNUP_MIGRATION.match(
      /c_trial_length\s+CONSTANT\s+interval\s*:=\s*interval\s*'(\d+) days'/,
    );
    expect(constant?.[1]).toBe(String(SEED_TRIAL_DAYS));
  });
});
