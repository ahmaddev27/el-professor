import type { FeatureKey, Plan } from '../contexts/PlanContext';

/**
 * Feature key → the lowest plan that unlocks it, as `app_private.platform_settings`
 * holds it under the key `plan_features` (migration 20260916150000).
 *
 * The database may name features this build does not know, and may leave out
 * ones it does: a feature the map does not name needs premium.
 */
export type PlanFeatureMap = Readonly<Record<string, Plan>>;

export const PLAN_RANK: Readonly<Record<Plan, number>> = { basic: 0, advanced: 1, premium: 2 };

const isPlan = (value: unknown): value is Plan =>
  value === 'basic' || value === 'advanced' || value === 'premium';

/** The plan a feature needs; premium when the map does not name it. */
export function minPlanForFeature(map: PlanFeatureMap, feature: FeatureKey): Plan {
  const plan: unknown = Object.prototype.hasOwnProperty.call(map, feature) ? map[feature] : undefined;
  return isPlan(plan) ? plan : 'premium';
}

export function planHasFeature(map: PlanFeatureMap, userPlan: Plan, feature: FeatureKey): boolean {
  return PLAN_RANK[userPlan] >= PLAN_RANK[minPlanForFeature(map, feature)];
}

// The bounds of app_private.platform_settings_problem() in 20260916150000.
const MAX_FEATURES = 200;
const FEATURE_KEY = /^[a-z][a-z0-9_]{0,59}$/;

/**
 * Reads a feature map from a database answer, or null when it does not have the
 * shape the database validates on save.
 */
export function parsePlanFeatures(value: unknown): PlanFeatureMap | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_FEATURES) return null;
  const map: Record<string, Plan> = {};
  for (const [feature, plan] of entries) {
    if (!FEATURE_KEY.test(feature) || !isPlan(plan)) return null;
    map[feature] = plan;
  }
  return map;
}
