/**
 * Reading and writing `app_private.platform_settings` from the panel
 * (plan 3.E / 3.6c). Pure: the calls are in `platformSettingsClient.ts`.
 *
 * Two keys exist today, `price_book` and `plan_features`, and each has its own
 * authority:
 *
 * - **reading** needs `settings.read` — but billing holds that capability for
 *   the prices alone, so for a billing account every other key is `forbidden`
 *   where a role with plain `settings.read` is merely told `not_found`;
 * - **saving `price_book`** needs `pricing.manage` (owner and billing);
 * - **saving `plan_features`** needs `settings.manage`, owner only. The feature
 *   map decides what every customer may open and a feature it does not name
 *   reads as premium, so one wrong write would lock every gated screen for
 *   every non-trial company below premium.
 *
 * ## The version is the whole point
 *
 * `platform_settings_put(key, value, expected_version)` refuses a stale version
 * with `version_conflict` and writes nothing. That refusal is a real answer to
 * show a person — somebody else saved in the meantime — never something to
 * retry with the version that came back, which would overwrite their change
 * unseen. The screen reloads and lets the owner look before saving again.
 */
import type { TranslationKey } from '../i18n';
import { formatCentsForInput, parseGermanAmountToCents } from '../utils/money';
import type { PriceBook } from '../utils/pricing';
import { parsePriceBook } from '../utils/pricing';
import type { PlanFeatureMap } from '../utils/planFeatures';
import { parsePlanFeatures } from '../utils/planFeatures';
import type { Plan } from '../contexts/PlanContext';
import type { PlatformAccess, PlatformCapability } from './platformAccess';
import { platformAccessCan } from './platformAccess';

export const SETTING_KEYS = ['price_book', 'plan_features'] as const;
export type SettingKey = typeof SETTING_KEYS[number];

// ─── Answers ─────────────────────────────────────────────────────────────────

export interface SettingRecord {
  ok: true;
  key: string;
  value: unknown;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SettingRefusal {
  ok: false;
  reason: string;
  /** Which part of the value the validator rejected, e.g. `price_book.yearly_discount_percent`. */
  problem?: string;
  /** What the row's version actually is, after a `version_conflict`. */
  currentVersion?: number;
  /** Which feature keys a rejected `plan_features` map failed to name. */
  missingFeatures?: string[];
}

export type SettingResult = SettingRecord | SettingRefusal;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseSettingAnswer(data: unknown): SettingResult {
  if (!isRecord(data)) return { ok: false, reason: 'malformed' };

  if (data.ok === true) {
    const version = data.version;
    if (typeof version !== 'number' || !Number.isInteger(version)) {
      return { ok: false, reason: 'malformed' };
    }
    return {
      ok: true,
      key: typeof data.key === 'string' ? data.key : '',
      value: data.value ?? null,
      version,
      updatedAt: typeof data.updated_at === 'string' ? data.updated_at : null,
      updatedBy: typeof data.updated_by === 'string' ? data.updated_by : null,
    };
  }

  const refusal: SettingRefusal = {
    ok: false,
    reason: typeof data.reason === 'string' ? data.reason : 'malformed',
  };
  if (typeof data.problem === 'string') refusal.problem = data.problem;
  if (typeof data.current_version === 'number') refusal.currentVersion = data.current_version;
  if (Array.isArray(data.missing_features)) {
    refusal.missingFeatures = data.missing_features.filter((k): k is string => typeof k === 'string');
  }
  return refusal;
}

/**
 * The message a refusal reads as. Each of these is a real answer from the
 * database — the screen states it and stops, rather than retrying or showing an
 * empty form as if nothing had happened.
 */
export function settingRefusalKey(reason: string): TranslationKey {
  switch (reason) {
    case 'forbidden':        return 'admin.settings.refusal.forbidden';
    case 'rate_limited':     return 'admin.settings.refusal.rateLimited';
    case 'version_conflict': return 'admin.settings.refusal.versionConflict';
    case 'invalid_value':    return 'admin.settings.refusal.invalidValue';
    case 'unknown_key':      return 'admin.settings.refusal.unknownKey';
    case 'not_found':        return 'admin.settings.refusal.notFound';
    default:                 return 'admin.settings.refusal.failed';
  }
}

/** Whether a refusal means somebody else saved first, so the screen must reload. */
export function isVersionConflict(result: SettingResult): boolean {
  return !result.ok && result.reason === 'version_conflict';
}

// ─── Who may save what ───────────────────────────────────────────────────────

/**
 * The capability `platform_settings_put` will demand for a key, as
 * `app_private.platform_setting_write_capability()` decides it. Used to disable
 * a button the role cannot use; the database decides the outcome regardless.
 */
export function writeCapabilityFor(key: SettingKey): PlatformCapability {
  return key === 'price_book' ? 'pricing.manage' : 'settings.manage';
}

export function canSaveSetting(access: PlatformAccess, key: SettingKey): boolean {
  return platformAccessCan(access, writeCapabilityFor(key));
}

/**
 * Whether this role may even read a key. `settings.read` alone is not the whole
 * rule: billing holds it for the prices only, which no single capability can
 * express, so the screen asks the same question the database does.
 */
export function canReadSetting(access: PlatformAccess, key: SettingKey): boolean {
  if (!platformAccessCan(access, 'settings.read')) return false;
  return key === 'price_book' || access.role !== 'billing';
}

// ─── The price book, as a form ───────────────────────────────────────────────

export interface PriceBookForm {
  /** Per car per month, typed the German way: "20", "12,34". */
  pricePerCar: Record<Plan, string>;
  tiers: { minCars: string; percent: string }[];
  yearlyDiscountPercent: string;
}

export function priceBookToForm(book: PriceBook): PriceBookForm {
  return {
    pricePerCar: {
      basic: formatCentsForInput(book.price_per_car_cents.basic),
      advanced: formatCentsForInput(book.price_per_car_cents.advanced),
      premium: formatCentsForInput(book.price_per_car_cents.premium),
    },
    tiers: book.fleet_discount_tiers.map(tier => ({
      minCars: String(tier.min_cars),
      percent: String(tier.percent),
    })),
    yearlyDiscountPercent: String(book.yearly_discount_percent),
  };
}

const wholeNumber = (text: string): number | null => {
  const trimmed = text.trim();
  if (!/^\d{1,7}$/.test(trimmed)) return null;
  return Number(trimmed);
};

/**
 * A typed form back into a price book, or the first field that is not a number
 * the database would accept.
 *
 * Prices are **integer cents**: the amount is parsed once, here, by the same
 * reader the Gehaltsquittung uses, so "12,34" becomes 1234 and never travels
 * through a float. The bounds are the validator's own
 * (`app_private.platform_settings_problem`), checked here only so a typo is
 * named on the field rather than answered with a whole-document refusal.
 */
export function priceBookFromForm(form: PriceBookForm): { book: PriceBook } | { error: string } {
  const cents: Partial<Record<Plan, number>> = {};
  for (const plan of ['basic', 'advanced', 'premium'] as const) {
    const parsed = parseGermanAmountToCents(form.pricePerCar[plan]);
    if (parsed === null || parsed > 1_000_000) return { error: `price_book.price_per_car_cents.${plan}` };
    cents[plan] = parsed;
  }

  const tiers: { min_cars: number; percent: number }[] = [];
  for (let i = 0; i < form.tiers.length; i += 1) {
    const minCars = wholeNumber(form.tiers[i].minCars);
    const percent = wholeNumber(form.tiers[i].percent);
    if (minCars === null || minCars < 1 || minCars > 100_000 || percent === null || percent > 100) {
      return { error: `price_book.fleet_discount_tiers.${i}` };
    }
    // Strictly increasing, so the tier a car count reaches is never ambiguous.
    if (tiers.length > 0 && minCars <= tiers[tiers.length - 1].min_cars) {
      return { error: `price_book.fleet_discount_tiers.${i}` };
    }
    tiers.push({ min_cars: minCars, percent });
  }
  if (tiers.length > 20) return { error: 'price_book.fleet_discount_tiers' };

  const yearly = wholeNumber(form.yearlyDiscountPercent);
  if (yearly === null || yearly > 100) return { error: 'price_book.yearly_discount_percent' };

  const book = parsePriceBook({
    price_per_car_cents: { basic: cents.basic, advanced: cents.advanced, premium: cents.premium },
    fleet_discount_tiers: tiers,
    yearly_discount_percent: yearly,
  });
  return book ? { book } : { error: 'price_book' };
}

// ─── The feature map, as a form ──────────────────────────────────────────────

/**
 * The feature map a save would send: every key the screen showed, with the plan
 * chosen for it.
 *
 * The map must stay **complete**. `app_private.platform_settings_problem`
 * refuses one that fails to name a feature the application knows, precisely
 * because a missing key reads as premium and would lock that screen for every
 * non-trial company below premium. The editor therefore starts from the map the
 * database returned and only changes values — it never drops a key, including
 * one this build does not know, which is how a key gets seeded before the
 * release that gates it.
 */
export function planFeaturesFromForm(
  loaded: PlanFeatureMap,
  changes: Readonly<Record<string, Plan>>,
): PlanFeatureMap | null {
  return parsePlanFeatures({ ...loaded, ...changes });
}

/** The value a settings answer carries, read as a price book. */
export function priceBookFromAnswer(record: SettingRecord): PriceBook | null {
  return parsePriceBook(record.value);
}

/** The value a settings answer carries, read as a feature map. */
export function planFeaturesFromAnswer(record: SettingRecord): PlanFeatureMap | null {
  return parsePlanFeatures(record.value);
}
