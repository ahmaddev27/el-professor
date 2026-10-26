/**
 * The plan catalogue, called (migration 20261026120000).
 *
 * `platform_plans_list` and `platform_plans_save` are the only door to
 * `public.plans`, the source of the price per car and of each plan's feature
 * set. Like the settings RPCs they answer with values: a refusal is
 * `{success: false, reason, error}`, and only a broken argument contract
 * arrives as a Supabase error.
 *
 * A save carries the version that was read. The database refuses a stale one
 * and writes nothing; the screen reloads and never retries with the newer
 * version, which would overwrite somebody else's change unseen.
 *
 * Money is integer cents throughout. Nothing here converts to euros.
 */
import { supabase } from './supabase';
import type { TranslationKey, TranslationVars } from '../i18n';

export interface PlanRow {
  slug: string;
  name: string;
  rank: number;
  price_per_car_cents: number;
  features: string[];
  is_active: boolean;
}

export interface PlanCatalogue {
  plans: PlanRow[];
  version: number;
  fixedSlugs: string[];
  featureKeys: string[];
}

export type SaveResult =
  | { ok: true; version: number; plans: PlanRow[] }
  | { ok: false; reason: string; error: string; problem?: string; currentVersion?: number };

type Translate = (key: TranslationKey, vars?: TranslationVars) => string;

// ─── Parsing ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** A plan row of exactly the documented shape, or null. */
export function parsePlanRow(raw: unknown): PlanRow | null {
  if (!isRecord(raw)) return null;
  const { slug, name, rank, price_per_car_cents: price, features, is_active: active } = raw;
  if (typeof slug !== 'string' || typeof name !== 'string') return null;
  if (typeof rank !== 'number' || !Number.isInteger(rank)) return null;
  if (typeof price !== 'number' || !Number.isSafeInteger(price) || price < 0) return null;
  if (!isStringArray(features) || typeof active !== 'boolean') return null;
  return { slug, name, rank, price_per_car_cents: price, features: [...features], is_active: active };
}

function parsePlans(raw: unknown): PlanRow[] | null {
  if (!Array.isArray(raw)) return null;
  const rows = raw.map(parsePlanRow);
  return rows.every((row): row is PlanRow => row !== null) ? rows : null;
}

/**
 * The catalogue out of a `platform_plans_list` answer. Throws for anything
 * else: an empty plan list is a claim ("no plan exists"), so an answer that is
 * not the documented shape must never become one.
 */
export function parseCatalogue(data: unknown): PlanCatalogue {
  if (!isRecord(data) || data.ok !== true) {
    const reason = isRecord(data) && typeof data.reason === 'string' ? data.reason : 'unreadable';
    throw new Error(`platform_plans_list refused: ${reason}`);
  }
  const plans = parsePlans(data.plans);
  const { version, fixed_slugs: fixed, feature_keys: keys } = data;
  if (!plans || plans.length === 0 || typeof version !== 'number' || !Number.isInteger(version)
      || !isStringArray(fixed) || !isStringArray(keys)) {
    throw new Error('platform_plans_list answered an unreadable catalogue');
  }
  return {
    plans: [...plans].sort((a, b) => a.rank - b.rank),
    version,
    fixedSlugs: fixed,
    featureKeys: keys,
  };
}

export function parseSaveResult(data: unknown): SaveResult {
  if (!isRecord(data)) throw new Error('platform_plans_save answered an unreadable result');
  if (data.success === true) {
    const plans = parsePlans(data.plans);
    if (!plans || typeof data.version !== 'number') {
      throw new Error('platform_plans_save answered an unreadable success');
    }
    return { ok: true, version: data.version, plans };
  }
  return {
    ok: false,
    reason: typeof data.reason === 'string' ? data.reason : 'unknown',
    error: typeof data.error === 'string' ? data.error : '',
    problem: typeof data.problem === 'string' ? data.problem : undefined,
    currentVersion: typeof data.current_version === 'number' ? data.current_version : undefined,
  };
}

// ─── Calls ───────────────────────────────────────────────────────────────────

export async function listPlans(): Promise<PlanCatalogue> {
  const { data, error } = await supabase.rpc('platform_plans_list');
  if (error) throw new Error(error.message);
  return parseCatalogue(data);
}

export async function savePlans(plans: PlanRow[], expectedVersion: number): Promise<SaveResult> {
  const { data, error } = await supabase.rpc('platform_plans_save', {
    p_plans: plans,
    p_expected_version: expectedVersion,
  });
  if (error) throw new Error(error.message);
  return parseSaveResult(data);
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * The lowest-rank ACTIVE plan that grants a feature, or null when none does.
 * This is the answer the old feature map stored per feature.
 */
export function derivedMinPlan(plans: PlanRow[], feature: string): string | null {
  const granting = plans
    .filter(plan => plan.is_active && plan.features.includes(feature))
    .sort((a, b) => a.rank - b.rank);
  return granting.length > 0 ? granting[0].slug : null;
}

/**
 * Ticks or unticks a feature the way the monotonic rule needs: granting it to a
 * plan grants it to every higher-rank active plan, and withdrawing it
 * withdraws it from every lower-rank active plan. A convenience for the
 * screen; the database refuses a violation regardless.
 */
export function setPlanFeature(plans: PlanRow[], slug: string, feature: string, on: boolean): PlanRow[] {
  const target = plans.find(plan => plan.slug === slug);
  if (!target) return plans;
  return plans.map(plan => {
    const affected = plan.slug === slug
      || (plan.is_active && (on ? plan.rank > target.rank : plan.rank < target.rank));
    if (!affected) return plan;
    const without = plan.features.filter(key => key !== feature);
    return { ...plan, features: on ? [...without, feature] : without };
  });
}

/** How a problem code names its plans and features on screen. */
export interface ProblemLabels {
  plan: (slug: string) => string;
  feature: (key: string) => string;
}

const RAW_LABELS: ProblemLabels = { plan: slug => slug, feature: key => key };

/**
 * A `problem` code from `invalid_value` as a sentence naming the plan and/or
 * feature. A code this build does not know is shown as the generic sentence
 * with the code itself, so nothing is hidden.
 */
export function planProblemMessage(problem: string, t: Translate, labels: ProblemLabels = RAW_LABELS): string {
  const parts = problem.split('.');
  const [head, kind, a, b, c] = parts;
  if (head !== 'plans') return t('admin.plans.problem.unknown', { problem });
  if (parts.length === 1) return t('admin.plans.problem.plans');

  switch (kind) {
    case 'entry': return t('admin.plans.problem.entry', { index: Number(a) + 1 });
    case 'slug':
      return a === 'duplicate' && b
        ? t('admin.plans.problem.slugDuplicate', { plan: labels.plan(b) })
        : t('admin.plans.problem.slug', { index: Number(a) + 1 });
    case 'name': return t('admin.plans.problem.name', { plan: labels.plan(a) });
    case 'rank':
      return a === 'duplicate'
        ? t('admin.plans.problem.rankDuplicate', { rank: b })
        : t('admin.plans.problem.rank', { plan: labels.plan(a) });
    case 'price': return t('admin.plans.problem.price', { plan: labels.plan(a) });
    case 'is_active': return t('admin.plans.problem.isActive', { plan: labels.plan(a) });
    case 'features':
      return b === 'key'
        ? t('admin.plans.problem.featuresKey', { plan: labels.plan(a) })
        : t('admin.plans.problem.features', { plan: labels.plan(a) });
    case 'required': return t('admin.plans.problem.required', { plan: labels.plan(a) });
    case 'extra': return t('admin.plans.problem.extra', { plan: labels.plan(a) });
    case 'monotonicity':
      return t('admin.plans.problem.monotonicity', {
        lower: labels.plan(a), higher: labels.plan(b), feature: labels.feature(c),
      });
    case 'missing': return t('admin.plans.problem.missing', { feature: labels.feature(a) });
    default: return t('admin.plans.problem.unknown', { problem });
  }
}

/** The sentence for a refused save: the problem when there is one, else the reason. */
export function saveRefusalMessage(result: Extract<SaveResult, { ok: false }>, t: Translate, labels?: ProblemLabels): string {
  switch (result.reason) {
    case 'denied': return t('admin.read.denied');
    case 'version_conflict': return t('admin.settings.refusal.versionConflict');
    case 'plan_in_use': return t('admin.plans.refusal.planInUse');
    case 'catalogue_missing': return t('admin.plans.refusal.catalogueMissing');
    case 'invalid_value':
      return result.problem ? planProblemMessage(result.problem, t, labels) : t('admin.settings.refusal.invalidValue');
    default: return t('admin.settings.refusal.failed');
  }
}
