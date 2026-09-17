/**
 * Reading and writing `app_private.platform_settings` from the panel
 * (plan 3.E / 3.6c). Pure: the calls are in `platformSettingsClient.ts`.
 *
 * Five keys exist, and each has its own authority:
 *
 * - **reading** needs `settings.read` — but billing holds that capability for
 *   the prices alone, so for a billing account every other key is `forbidden`
 *   where a role with plain `settings.read` is merely told `not_found`;
 * - **saving `price_book`** needs `pricing.manage` (owner and billing);
 * - **saving anything else** needs `settings.manage`, owner only. That covers
 *   the feature map — which decides what every customer may open, and a feature
 *   it does not name reads as premium, so one wrong write would lock every
 *   gated screen for every non-trial company below premium — and it covers the
 *   three keys of plan 3.10: the seller printed on every invoice, the length of
 *   every new company's trial, and the invoice defaults.
 *
 * ## The version is the whole point
 *
 * `platform_settings_put(key, value, expected_version)` refuses a stale version
 * with `version_conflict` and writes nothing. That refusal is a real answer to
 * show a person — somebody else saved in the meantime — never something to
 * retry with the version that came back, which would overwrite their change
 * unseen. The screen reloads and lets the owner look before saving again.
 *
 * ## Every bound here is the database's
 *
 * The parsers and the form validators below mirror
 * `app_private.platform_settings_problem` (migrations 20260916150000,
 * 20260917120000 and 20260919120000) so a typo is named on its own field rather
 * than answered with a whole-document refusal. They decide nothing: the
 * database validates every value it stores, and refuses what it will not.
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

export const SETTING_KEYS = ['price_book', 'plan_features', 'seller', 'trial', 'invoice'] as const;
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
 * `app_private.platform_setting_write_capability()` decides it: `price_book` is
 * the one pricing key, everything else is the owner-only `settings.manage`.
 * Used to disable a button the role cannot use; the database decides the
 * outcome regardless.
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

// ─── The seller printed on invoices (plan 3.10) ──────────────────────────────

/**
 * Exactly the `company_settings` columns `SubscriptionBillingPage` selects for
 * the invoice PDF, with `company_name` under the name `name`. The migration
 * seeded them from that very row.
 *
 * The list is closed on purpose: each field is printed on a document that goes
 * to a customer, and two of them are our bank details, so adding one is a data
 * protection decision rather than a convenience. `tests/rls/settings.sql` pins
 * it key by key.
 */
export const SELLER_FIELDS = [
  'name', 'street', 'house_number', 'postal_code', 'city',
  'vat_id', 'tax_number', 'bank_name', 'iban', 'bic', 'account_holder',
] as const;
export type SellerField = typeof SELLER_FIELDS[number];
export type Seller = Readonly<Record<SellerField, string>>;

/** `app_private.platform_settings_problem_3_10`, c_max_field. */
export const SELLER_MAX_FIELD_LENGTH = 200;

/**
 * The database refuses `[[:cntrl:]]` in a seller field: these strings are drawn
 * into a PDF line by line, and a newline or a tab would break that layout
 * silently on a document a customer receives. The range here is the wider one,
 * so the screen never sends something the database would refuse.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export function parseSeller(value: unknown): Seller | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).length !== SELLER_FIELDS.length) return null;

  const seller: Partial<Record<SellerField, string>> = {};
  for (const field of SELLER_FIELDS) {
    const text = value[field];
    if (typeof text !== 'string'
        || text.length > SELLER_MAX_FIELD_LENGTH
        || CONTROL_CHARACTERS.test(text)) {
      return null;
    }
    seller[field] = text;
  }
  // Every other field may be blank — not every seller has a VAT id — but a
  // nameless invoice has no sender at all.
  if (seller.name!.trim() === '') return null;
  return seller as Seller;
}

export type SellerForm = Record<SellerField, string>;

export function sellerToForm(seller: Seller): SellerForm {
  const form = {} as SellerForm;
  for (const field of SELLER_FIELDS) form[field] = seller[field];
  return form;
}

/**
 * A typed form back into a seller, or the first field the database would
 * refuse. Each value is trimmed on the way out, as the migration's seed trimmed
 * the row it copied, so a stray space never becomes part of an address.
 */
export function sellerFromForm(form: SellerForm): { value: Seller } | { error: string } {
  const seller: Partial<Record<SellerField, string>> = {};
  for (const field of SELLER_FIELDS) {
    const text = form[field].trim();
    if (text.length > SELLER_MAX_FIELD_LENGTH || CONTROL_CHARACTERS.test(text)) {
      return { error: `seller.${field}` };
    }
    seller[field] = text;
  }
  if (seller.name === '') return { error: 'seller.name' };
  return { value: seller as Seller };
}

/**
 * The sender block as the invoice PDF composes it today
 * (`SubscriptionBillingPage.handleDownloadPdf` plus `generateSubscriptionPdf`),
 * so the editor's preview shows what a customer would actually read.
 *
 * The two labels are German in both languages: they are printed on a German
 * payment record, which is on the closed list in `src/i18n/index.ts`. This
 * function only lays the stored strings out — the PDF is not changed here, and
 * moving it onto this setting is a later step.
 */
export function sellerAddressBlock(seller: Seller): string[] {
  const lines: string[] = [];
  if (seller.name) lines.push(seller.name);

  const street = [seller.street, seller.house_number].filter(Boolean).join(' ');
  if (street) lines.push(street);

  const town = [seller.postal_code, seller.city].filter(Boolean).join(' ');
  if (town) lines.push(town);

  const tax = [
    seller.vat_id ? `USt-IdNr: ${seller.vat_id}` : '',
    seller.tax_number ? `Steuernr: ${seller.tax_number}` : '',
  ].filter(Boolean).join(' | ');
  if (tax) lines.push(tax);

  const bank = [
    seller.bank_name,
    seller.iban ? `IBAN: ${seller.iban}` : '',
    seller.bic ? `BIC: ${seller.bic}` : '',
  ].filter(Boolean).join(' | ');
  if (bank) lines.push(bank);

  return lines;
}

// ─── The trial length (plan 3.10) ────────────────────────────────────────────

/**
 * How long a company created from now on may use the product before it has to
 * pay. `app_private.signup_insert_company` reads this key through
 * `app_private.signup_trial_days()`, and `get_public_config()` quotes the same
 * number to a visitor.
 *
 * **Changing it moves no trial that already exists.** `trial_end` is written
 * once, on the row, when a company is created.
 */
export interface TrialSettings {
  readonly days: number;
}

/** The validator's bounds: below a day is not a trial, above a year is a typo. */
export const TRIAL_MIN_DAYS = 1;
export const TRIAL_MAX_DAYS = 365;

export function parseTrial(value: unknown): TrialSettings | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).length !== 1) return null;
  const days = value.days;
  if (typeof days !== 'number' || !Number.isInteger(days)
      || days < TRIAL_MIN_DAYS || days > TRIAL_MAX_DAYS) {
    return null;
  }
  return { days };
}

export interface TrialForm {
  days: string;
}

export function trialToForm(trial: TrialSettings): TrialForm {
  return { days: String(trial.days) };
}

export function trialFromForm(form: TrialForm): { value: TrialSettings } | { error: string } {
  const days = wholeNumber(form.days);
  if (days === null || days < TRIAL_MIN_DAYS || days > TRIAL_MAX_DAYS) {
    return { error: 'trial.days' };
  }
  return { value: { days } };
}

// ─── The invoice defaults (plan 3.10) ────────────────────────────────────────

/**
 * The values the invoice code holds today, one per line of code:
 * `number_prefix` and `number_digits` are the 'INV' and the 4 of
 * `public.generate_invoice_number`, and `default_payment_method` is the 'cash'
 * `GenerateInvoicesModal` writes onto every invoice it creates.
 *
 * A tax rate is deliberately absent — nothing in the invoice path computes or
 * prints one — and so is the due day, which is `billing_day` on each
 * subscription rather than a platform-wide value.
 */
export interface InvoiceSettings {
  readonly number_prefix: string;
  readonly number_digits: number;
  readonly default_payment_method: string;
}

/**
 * The prefix may not contain a dash: `generate_invoice_number` reads the
 * running number back with `split_part(invoice_number, '-', 3)`.
 */
export const INVOICE_NUMBER_PREFIX = /^[A-Z][A-Z0-9]{0,9}$/;
export const INVOICE_PAYMENT_METHOD = /^[a-z][a-z0-9_]{0,29}$/;
export const INVOICE_MAX_DIGITS = 10;

export function parseInvoice(value: unknown): InvoiceSettings | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).length !== 3) return null;

  const { number_prefix: prefix, number_digits: digits, default_payment_method: method } = value;
  if (typeof prefix !== 'string' || !INVOICE_NUMBER_PREFIX.test(prefix)) return null;
  if (typeof digits !== 'number' || !Number.isInteger(digits) || digits < 1 || digits > INVOICE_MAX_DIGITS) {
    return null;
  }
  if (typeof method !== 'string' || !INVOICE_PAYMENT_METHOD.test(method)) return null;

  return { number_prefix: prefix, number_digits: digits, default_payment_method: method };
}

export interface InvoiceForm {
  numberPrefix: string;
  numberDigits: string;
  defaultPaymentMethod: string;
}

export function invoiceToForm(invoice: InvoiceSettings): InvoiceForm {
  return {
    numberPrefix: invoice.number_prefix,
    numberDigits: String(invoice.number_digits),
    defaultPaymentMethod: invoice.default_payment_method,
  };
}

export function invoiceFromForm(form: InvoiceForm): { value: InvoiceSettings } | { error: string } {
  const prefix = form.numberPrefix.trim();
  if (!INVOICE_NUMBER_PREFIX.test(prefix)) return { error: 'invoice.number_prefix' };

  const digits = wholeNumber(form.numberDigits);
  if (digits === null || digits < 1 || digits > INVOICE_MAX_DIGITS) return { error: 'invoice.number_digits' };

  const method = form.defaultPaymentMethod.trim();
  if (!INVOICE_PAYMENT_METHOD.test(method)) return { error: 'invoice.default_payment_method' };

  return { value: { number_prefix: prefix, number_digits: digits, default_payment_method: method } };
}

/**
 * The first invoice number of a year under these settings, built exactly as
 * `public.generate_invoice_number` builds it:
 * `prefix || '-' || year || '-' || lpad(seq::text, digits, '0')`.
 *
 * Shown beside the fields so the format is visible before it is saved — that
 * function does not read this setting yet.
 */
export function invoiceNumberExample(invoice: InvoiceSettings, year: number): string {
  return `${invoice.number_prefix}-${year}-${'1'.padStart(invoice.number_digits, '0')}`;
}

// ─── Reading a stored value for one key ──────────────────────────────────────

/** The value a settings answer carries, read as a price book. */
export function priceBookFromAnswer(record: SettingRecord): PriceBook | null {
  return parsePriceBook(record.value);
}

/** The value a settings answer carries, read as a feature map. */
export function planFeaturesFromAnswer(record: SettingRecord): PlanFeatureMap | null {
  return parsePlanFeatures(record.value);
}
