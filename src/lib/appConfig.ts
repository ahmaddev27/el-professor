import { parsePlanFeatures, type PlanFeatureMap } from '../utils/planFeatures';
import { parsePriceBook, type PriceBook } from '../utils/pricing';
import { SEED_PLAN_FEATURES, SEED_PRICE_BOOK, SEED_TRIAL_DAYS } from './appConfigSeed';

/**
 * What the database says about the product, as `get_public_config()` (anyone)
 * and `get_app_config()` (signed in) return it (migration 20260916150000).
 *
 * The database is the authority. This module only reads its answer, and keeps
 * the seed wherever the answer is missing or malformed.
 */
export interface AppConfig {
  priceBook: PriceBook;
  planFeatures: PlanFeatureMap;
  trialDays: number;
  /** Always empty until plan 3.11 builds feature flags. */
  featureFlags: Readonly<Record<string, boolean>>;
  /** Always empty until plan 3.11 builds announcements. */
  announcements: readonly unknown[];
}

export const SEED_APP_CONFIG: AppConfig = {
  priceBook: SEED_PRICE_BOOK,
  planFeatures: SEED_PLAN_FEATURES,
  trialDays: SEED_TRIAL_DAYS,
  featureFlags: {},
  announcements: [],
};

const MAX_TRIAL_DAYS = 3650;

/**
 * Reads a `get_public_config()` or `get_app_config()` answer. Each part that is
 * absent or malformed keeps `fallback`'s value: the public answer carries no
 * feature map, and a broken price book must not price anything.
 */
export function parseAppConfig(data: unknown, fallback: AppConfig = SEED_APP_CONFIG): AppConfig {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return fallback;
  const body = data as Record<string, unknown>;
  const trialDays = body.trial_days;
  return {
    priceBook: parsePriceBook(body.price_book) ?? fallback.priceBook,
    planFeatures: parsePlanFeatures(body.plan_features) ?? fallback.planFeatures,
    trialDays: typeof trialDays === 'number' && Number.isInteger(trialDays) && trialDays >= 1 && trialDays <= MAX_TRIAL_DAYS
      ? trialDays
      : fallback.trialDays,
    featureFlags: fallback.featureFlags,
    announcements: fallback.announcements,
  };
}
