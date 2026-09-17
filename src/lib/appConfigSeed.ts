import type { FeatureKey, Plan } from '../contexts/PlanContext';
import type { PriceBook } from '../utils/pricing';

/**
 * The values migration 20260916150000 seeds into `app_private.platform_settings`,
 * and what the app shows until the database has answered.
 *
 * They are the prices of `src/utils/pricing.ts` and the `FEATURE_MIN_PLAN` of
 * `PlanContext.tsx` as they stood before the move. `appConfigSeed.test.ts`
 * fails when these documents and the migration's differ. No other module in
 * `src/` names a price or a feature's plan.
 */

export const SEED_PRICE_BOOK: PriceBook = {
  price_per_car_cents: { basic: 2000, advanced: 4000, premium: 7000 },
  fleet_discount_tiers: [
    { min_cars: 6, percent: 5 },
    { min_cars: 11, percent: 10 },
  ],
  yearly_discount_percent: 10,
};

/** Every feature the app gates, so a new FeatureKey without a seed fails to compile. */
export const SEED_PLAN_FEATURES: Readonly<Record<FeatureKey, Plan>> = {
  overview:           'basic',
  belege:             'basic',
  fahrer:             'basic',
  fahrzeuge:          'basic',
  umsaetze:           'basic',
  fixkosten:          'basic',
  bargeldbestand:     'basic',
  werkstatt:          'advanced',
  abrechnung:         'advanced',
  notizen:            'advanced',
  rollen_nutzer:      'advanced',
  benachrichtigungen: 'advanced',
  gehaelter:          'premium',
  dokumente:          'premium',
  trinkgeld_quittung: 'premium',
  stundennachweis:    'premium',
};

/**
 * The trial `app_private.signup_insert_company` gives a new company.
 *
 * Since 20260919120000 (plan 3.10) it is the `trial` setting, read through
 * `app_private.signup_trial_days()` by the signup and by `get_public_config()`
 * alike, so the number a visitor is quoted and the number a company is given
 * cannot come apart. This constant is the value that migration seeds, and the
 * fallback that function answers when the document is missing or malformed;
 * `appConfigSeed.test.ts` fails when the two differ.
 */
export const SEED_TRIAL_DAYS = 14;
