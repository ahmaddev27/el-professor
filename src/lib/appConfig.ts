import { parsePlanFeatures, type PlanFeatureMap } from '../utils/planFeatures';
import { parsePriceBook, type PriceBook } from '../utils/pricing';
import { parseAnnouncements, type Announcement } from './announcements';
import { SEED_PLAN_FEATURES, SEED_PRICE_BOOK, SEED_TRIAL_DAYS } from './appConfigSeed';
import { parseFeatureFlags, type FeatureFlags } from './featureFlags';

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
  /**
   * The `feature_flags` setting (plan 3.11). A flag it does not name is off;
   * `useFlag(key)` is how a screen asks.
   */
  featureFlags: FeatureFlags;
  /**
   * The announcements that apply to the signed-in account's company now
   * (plan 3.11). The database has chosen them; `AnnouncementBanner` shows them.
   */
  announcements: readonly Announcement[];
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
 * How long a loaded configuration counts as current.
 *
 * A refresh triggered by the tab regaining focus does nothing while the last
 * answer is younger than this, so alt-tabbing cannot turn into one request per
 * switch. It is not a poll: a tab nobody touches asks nothing.
 */
export const APP_CONFIG_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Whether a configuration loaded at `lastLoadedAt` should be read again now.
 *
 * `null` means nothing has answered yet — the load that runs on mount and on a
 * change of account owns that first call, and a focus must not race it.
 */
export function shouldRefreshAppConfig(
  lastLoadedAt: number | null,
  now: number,
  maxAgeMs: number = APP_CONFIG_MAX_AGE_MS,
): boolean {
  if (lastLoadedAt === null) return false;
  // A clock that moved backwards makes the age meaningless; ask again rather
  // than wait out a window that may never end.
  if (now < lastLoadedAt) return true;
  return now - lastLoadedAt >= maxAgeMs;
}

/**
 * Reads a `get_public_config()` or `get_app_config()` answer. Each part that is
 * malformed keeps `fallback`'s value: a broken price book must not price
 * anything. The price book, the feature map and the trial length also keep it
 * when they are absent — the public answer carries no feature map.
 *
 * The flags and the announcements are different, because only
 * `get_app_config()` carries them and they belong to the signed-in account:
 * **absent means none**. A visitor's answer switches every flag off and shows no
 * announcement, so an account signed out of — or swapped for another — never
 * leaves its announcements on the next one's screen. Present but malformed, they
 * keep the last good value like everything else.
 *
 * Callers pass the configuration they are already showing as `fallback`, so a
 * refresh whose answer is missing a part keeps the last good one rather than
 * falling back to the seed.
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
    featureFlags: 'feature_flags' in body
      ? parseFeatureFlags(body.feature_flags) ?? fallback.featureFlags
      : SEED_APP_CONFIG.featureFlags,
    announcements: 'announcements' in body
      ? parseAnnouncements(body.announcements) ?? fallback.announcements
      : SEED_APP_CONFIG.announcements,
  };
}
