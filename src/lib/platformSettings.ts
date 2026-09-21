/**
 * Reading and writing `app_private.platform_settings` from the panel
 * (plan 3.E / 3.6c). Pure: the calls are in `platformSettingsClient.ts`.
 *
 * Twelve keys exist, and each has its own authority:
 *
 * - **reading** needs `settings.read` — but billing holds that capability for
 *   the prices alone, so for a billing account every other key is `forbidden`
 *   where a role with plain `settings.read` is merely told `not_found`;
 * - **saving `price_book`** needs `pricing.manage` (owner and billing);
 * - **saving anything else** needs `settings.manage`, owner only. That covers
 *   the feature map — which decides what every customer may open, and a feature
 *   it does not name reads as premium, so one wrong write would lock every
 *   gated screen for every non-trial company below premium — and it covers the
 *   keys of plan 3.10: the seller printed on every invoice, the length of every
 *   new company's trial, the invoice defaults, the sender name and the four
 *   code-mail templates; plan 3.11's feature flags; and the privacy policy
 *   published at /datenschutz (`legal.privacy`, migration 20260921120000).
 *
 * The invoice screen reads the seller through its own RPC
 * (`platform_invoice_seller`, `companies.read`), because the roles that
 * download invoices are not all roles that may read the settings.
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
 * 20260917120000, 20260919120000 and 20260921120000) so a typo is named on its own field rather
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
import {
  MAIL_TEMPLATE_DEFAULTS,
  MAIL_TEMPLATE_HAS_BUTTON,
  mailSenderProblem,
  mailTemplateProblem,
  type MailSender,
  type MailTemplateOverrides,
  type MailTemplatePurpose,
} from '../../supabase/functions/_shared/mail-template.ts';

export const SETTING_KEYS = [
  'price_book', 'plan_features', 'seller', 'trial', 'invoice',
  'mail.sender',
  'mail.template.signup_verify', 'mail.template.password_reset',
  'mail.template.invite_activate', 'mail.template.email_change',
  'feature_flags',
  'legal.privacy',
] as const;
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

/**
 * The announcements (plan 3.11) are not a settings key, but the list asks the
 * question `platform_settings_get` asks of a key that is not a price — so
 * owner and read_only, not billing — and a save or a delete needs
 * `settings.manage`, owner only.
 */
export function canReadAnnouncements(access: PlatformAccess): boolean {
  return platformAccessCan(access, 'settings.read') && access.role !== 'billing';
}

export function canWriteAnnouncements(access: PlatformAccess): boolean {
  return platformAccessCan(access, 'settings.manage');
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

/**
 * The nine fields an Impressum needs that the invoice does not (§ 5 DDG,
 * § 18 Abs. 2 MStV; migration 20260921120000), in the order the form shows
 * them. `/impressum` publishes them, with the invoice's address and VAT id.
 *
 * **Optional means may be absent.** The document every database held before is
 * still a seller, and a save writes one of these only once it holds a value, so
 * the stored document stays readable by the release before this one — whose
 * `parseSeller` accepts exactly the eleven — until the owner actually fills one.
 *
 * `legal_name` is deliberately not `name`. `name` was seeded with the fallback
 * 'El-Professor' wherever no row could be copied, which is a product name and
 * not a fact about who operates the site, so the Impressum never prints it.
 */
export const SELLER_IMPRESSUM_FIELDS = [
  'legal_name', 'legal_form', 'represented_by',
  'contact_email', 'contact_phone',
  'register_court', 'register_number',
  'content_responsible_name', 'content_responsible_address',
] as const;
export type SellerImpressumField = typeof SELLER_IMPRESSUM_FIELDS[number];

export type Seller =
  Readonly<Record<SellerField, string>> & Readonly<Partial<Record<SellerImpressumField, string>>>;

/** `app_private.platform_settings_problem_3_10`, c_max_field — every seller field's bound. */
export const SELLER_MAX_FIELD_LENGTH = 200;

/**
 * `platform_settings_problem_legal`'s checks on the two contact fields the page
 * links. `\s` is wider than the database's `[:space:]`, so the screen refuses
 * at least what the database refuses.
 */
export const SELLER_CONTACT_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SELLER_CONTACT_PHONE = /^\+?[0-9 ()/.-]+$/;
const SELLER_MIN_PHONE_DIGITS = 3;

/** Digits, spaces and `+ ( ) / . -`, with at least three digits. */
export function isContactPhone(text: string): boolean {
  return SELLER_CONTACT_PHONE.test(text) && text.replace(/[^0-9]/g, '').length >= SELLER_MIN_PHONE_DIGITS;
}

/**
 * The database refuses `[[:cntrl:]]` in a seller field: these strings are drawn
 * into a PDF line by line, and a newline or a tab would break that layout
 * silently on a document a customer receives. The range here is the wider one,
 * so the screen never sends something the database would refuse.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

const KNOWN_SELLER_FIELDS: ReadonlySet<string> = new Set([...SELLER_FIELDS, ...SELLER_IMPRESSUM_FIELDS]);

const hasOwn = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** The path the database names a field's text by, or null when it would accept it. */
function sellerFieldProblem(field: SellerField | SellerImpressumField, text: string): string | null {
  if (text.length > SELLER_MAX_FIELD_LENGTH || CONTROL_CHARACTERS.test(text)) return `seller.${field}`;
  const trimmed = text.trim();
  if (field === 'contact_email' && trimmed !== '' && !SELLER_CONTACT_EMAIL.test(trimmed)) return `seller.${field}`;
  if (field === 'contact_phone' && trimmed !== '' && !isContactPhone(trimmed)) return `seller.${field}`;
  return null;
}

export function parseSeller(value: unknown): Seller | null {
  if (!isRecord(value)) return null;
  // All eleven, any of the nine, and nothing else: the database compares the
  // eleven exactly and refuses a field it does not know.
  if (Object.keys(value).some(key => !KNOWN_SELLER_FIELDS.has(key))) return null;

  const seller: Partial<Record<SellerField | SellerImpressumField, string>> = {};
  for (const field of SELLER_FIELDS) {
    const text = value[field];
    if (typeof text !== 'string' || sellerFieldProblem(field, text)) return null;
    seller[field] = text;
  }
  for (const field of SELLER_IMPRESSUM_FIELDS) {
    if (!hasOwn(value, field)) continue;
    const text = value[field];
    if (typeof text !== 'string' || sellerFieldProblem(field, text)) return null;
    seller[field] = text;
  }
  // Every other field may be blank — not every seller has a VAT id — but a
  // nameless invoice has no sender at all.
  if (seller.name!.trim() === '') return null;
  return seller as Seller;
}

export type SellerForm = Record<SellerField | SellerImpressumField, string>;

export function sellerToForm(seller: Seller): SellerForm {
  const form = {} as SellerForm;
  for (const field of SELLER_FIELDS) form[field] = seller[field];
  for (const field of SELLER_IMPRESSUM_FIELDS) form[field] = seller[field] ?? '';
  return form;
}

/**
 * A typed form back into a seller, or the first field the database would
 * refuse. Each value is trimmed on the way out, as the migration's seed trimmed
 * the row it copied, so a stray space never becomes part of an address.
 *
 * An Impressum field is written only when it holds a value (see
 * `SELLER_IMPRESSUM_FIELDS`), so emptying all nine gives back the eleven-field
 * document the release before reads.
 */
export function sellerFromForm(form: SellerForm): { value: Seller } | { error: string } {
  const seller: Partial<Record<SellerField | SellerImpressumField, string>> = {};
  for (const field of SELLER_FIELDS) {
    const text = form[field].trim();
    const problem = sellerFieldProblem(field, text);
    if (problem) return { error: problem };
    seller[field] = text;
  }
  if (seller.name === '') return { error: 'seller.name' };

  for (const field of SELLER_IMPRESSUM_FIELDS) {
    const text = form[field].trim();
    const problem = sellerFieldProblem(field, text);
    if (problem) return { error: problem };
    if (text !== '') seller[field] = text;
  }
  return { value: seller as Seller };
}

/**
 * The four sender strings `generateSubscriptionPdf` prints, from the stored
 * seller — the composition `SubscriptionBillingPage.handleDownloadPdf` applied to
 * the `company_settings` row it used to read, kept character for character so a
 * seller with the same values prints the same invoice.
 *
 * One case is deliberately different: a seller with no address at all yields an
 * empty address, not the "\n " the old composition built from four blank
 * fields. That is the document both real databases hold — the migration found no
 * row to copy — and it is exactly what the PDF printed there before, when the
 * page had no row and fell back to 'El-Professor' with nothing under it.
 *
 * German in both languages: the labels are printed on a German payment record,
 * on the closed list in `src/i18n/index.ts`.
 */
export interface InvoiceSellerFields {
  sellerName: string;
  sellerAddress: string;
  sellerTaxInfo: string;
  sellerBank: string;
}

export function invoiceSellerFields(seller: Seller): InvoiceSellerFields {
  const hasAddress = [seller.street, seller.house_number, seller.postal_code, seller.city]
    .some(part => part.trim() !== '');
  return {
    sellerName: seller.name,
    sellerAddress: hasAddress
      ? [seller.street, seller.house_number].filter(Boolean).join(' ')
        + `\n${seller.postal_code || ''} ${seller.city || ''}`
      : '',
    sellerTaxInfo: [
      seller.vat_id ? `USt-IdNr: ${seller.vat_id}` : '',
      seller.tax_number ? `Steuernr: ${seller.tax_number}` : '',
    ].filter(Boolean).join(' | '),
    sellerBank: [
      seller.bank_name,
      seller.iban ? `IBAN: ${seller.iban}` : '',
      seller.bic ? `BIC: ${seller.bic}` : '',
    ].filter(Boolean).join(' | '),
  };
}

/**
 * The sender block as a reader of the invoice sees it, line by line, so the
 * editor's preview shows what a customer would actually read. The invoice PDF
 * prints the same strings through `invoiceSellerFields`.
 *
 * The two labels are German in both languages: they are printed on a German
 * payment record, which is on the closed list in `src/i18n/index.ts`.
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

// ─── The mail sender and the code-mail templates (plan 3.10) ─────────────────

/**
 * The display name every mail from the edge functions carries. The rules are
 * `mail-template.ts`'s, which the functions apply before they send; the address
 * is not a setting (it must sit on the domain the mail provider has verified).
 */
export interface MailSenderForm {
  name: string;
}

export function mailSenderToForm(sender: MailSender): MailSenderForm {
  return { name: sender.name };
}

export function mailSenderFromForm(form: MailSenderForm): { value: MailSender } | { error: string } {
  const value = { name: form.name.trim() };
  const problem = mailSenderProblem(value);
  return problem ? { error: problem } : { value };
}

/**
 * One mail's four editable fields as the editor holds them: always filled, the
 * default wherever the stored template leaves a field out. The editor shows the
 * text that will go out, not an empty box that means "whatever the default is".
 */
export interface MailTemplateForm {
  subject: string;
  heading: string;
  paragraphs: string[];
  /** '' for the one mail without a button. */
  button: string;
}

export function mailTemplateToForm(purpose: MailTemplatePurpose, overrides: MailTemplateOverrides): MailTemplateForm {
  const defaults = MAIL_TEMPLATE_DEFAULTS[purpose];
  return {
    subject: overrides.subject ?? defaults.subject,
    heading: overrides.heading ?? defaults.heading,
    paragraphs: [...(overrides.paragraphs ?? defaults.paragraphs)],
    button: MAIL_TEMPLATE_HAS_BUTTON[purpose] ? overrides.button ?? defaults.button ?? '' : '',
  };
}

const sameParagraphs = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((text, i) => text === b[i]);

/**
 * The template a save sends: **only the fields that differ from the default**,
 * each trimmed. A field left at its default is left out, so it keeps following
 * the code — a later correction of a default reaches every mail nobody
 * customised — and a form reset to the defaults saves `{}`, which is exactly
 * the seed. Or the first field the database would refuse, by its path.
 */
export function mailTemplateFromForm(
  purpose: MailTemplatePurpose,
  form: MailTemplateForm,
): { value: MailTemplateOverrides } | { error: string } {
  const defaults = MAIL_TEMPLATE_DEFAULTS[purpose];
  const value: { subject?: string; heading?: string; paragraphs?: string[]; button?: string } = {};

  const subject = form.subject.trim();
  if (subject !== defaults.subject) value.subject = subject;
  const heading = form.heading.trim();
  if (heading !== defaults.heading) value.heading = heading;
  const paragraphs = form.paragraphs.map(p => p.trim());
  if (!sameParagraphs(paragraphs, defaults.paragraphs)) value.paragraphs = paragraphs;
  if (MAIL_TEMPLATE_HAS_BUTTON[purpose]) {
    const button = form.button.trim();
    if (button !== defaults.button) value.button = button;
  }

  const problem = mailTemplateProblem(purpose, value);
  return problem ? { error: problem } : { value };
}

/** Which fields of a form still read as the default, for the editor's badges. */
export function mailTemplateDefaultsKept(purpose: MailTemplatePurpose, form: MailTemplateForm): {
  subject: boolean; heading: boolean; paragraphs: boolean; button: boolean;
} {
  const defaults = MAIL_TEMPLATE_DEFAULTS[purpose];
  return {
    subject: form.subject.trim() === defaults.subject,
    heading: form.heading.trim() === defaults.heading,
    paragraphs: sameParagraphs(form.paragraphs.map(p => p.trim()), defaults.paragraphs),
    button: !MAIL_TEMPLATE_HAS_BUTTON[purpose] || form.button.trim() === defaults.button,
  };
}

// ─── The privacy policy (legal.privacy, 20260921120000) ──────────────────────

/**
 * The privacy policy `/datenschutz` publishes: the lawyer's text as German
 * paragraphs of plain text, and the date it is valid from ("Stand"). `{}` means
 * nothing is published — the seed, and what an emptied editor saves.
 *
 * Every bound below is `app_private.platform_settings_problem_legal`'s. The
 * database refuses what breaks one regardless; the screen checks first only so
 * the owner is told which paragraph, rather than that the document was refused.
 */
export type PrivacyDocument =
  | { readonly as_of: string; readonly paragraphs: readonly string[] }
  | { readonly as_of?: undefined; readonly paragraphs?: undefined };

/**
 * The one exception to the 16384 bytes every other key may take: a lawyer's
 * text is longer. It cannot be raised freely — `audit_write` refuses a value
 * above 32768 bytes, and every save records the text before and after.
 */
export const PRIVACY_MAX_BYTES = 32000;
export const PRIVACY_MAX_PARAGRAPHS = 300;
export const PRIVACY_PARAGRAPH_MAX_LENGTH = 4000;
const PRIVACY_MIN_YEAR = 2000;
const PRIVACY_MAX_YEAR = 2100;

/** A calendar date as storage writes it, `YYYY-MM-DD`, between 2000 and 2100. */
export function isStorageDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < PRIVACY_MIN_YEAR || year > PRIVACY_MAX_YEAR || month < 1 || month > 12 || day < 1) return false;
  // Day 0 of the next month is the last day of this one; UTC, so no zone moves it.
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `21.09.2026` (or `1.9.2026`) as `2026-09-21`, or null for anything that is not a real date. */
export function parseGermanDate(text: string): string | null {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const iso = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  return isStorageDate(iso) ? iso : null;
}

/** Control characters, except the line break a paragraph may hold (an address block). */
const PRIVACY_CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/** Whether the database would refuse one paragraph. */
export function privacyParagraphRefused(text: string): boolean {
  return text.trim() === ''
    || text.length > PRIVACY_PARAGRAPH_MAX_LENGTH
    || PRIVACY_CONTROL_CHARACTERS.test(text)
    // a blank line belongs between two paragraphs, not inside one
    || /\n *\n/.test(text)
    // plain text: nothing that could be read as markup
    || /[<>]/.test(text);
}

/**
 * How many bytes PostgreSQL counts for the document — `octet_length(value::text)`,
 * the measure the validator bounds. jsonb prints a space after every `:` and
 * `,`, and sorts `as_of` before `paragraphs`; its string escapes are JSON's.
 */
export function privacyStoredBytes(doc: PrivacyDocument): number {
  const text = doc.paragraphs === undefined
    ? '{}'
    : `{"as_of": ${JSON.stringify(doc.as_of)}, "paragraphs": [${doc.paragraphs.map(p => JSON.stringify(p)).join(', ')}]}`;
  return new TextEncoder().encode(text).length;
}

export function parsePrivacyDocument(value: unknown): PrivacyDocument | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return {};
  if (keys.length !== 2 || keys[0] !== 'as_of' || keys[1] !== 'paragraphs') return null;

  const { as_of: asOf, paragraphs } = value;
  if (typeof asOf !== 'string' || !isStorageDate(asOf)) return null;
  if (!Array.isArray(paragraphs) || paragraphs.length < 1 || paragraphs.length > PRIVACY_MAX_PARAGRAPHS) return null;
  if (!paragraphs.every(p => typeof p === 'string' && !privacyParagraphRefused(p))) return null;

  const doc: PrivacyDocument = { as_of: asOf, paragraphs: paragraphs as string[] };
  return privacyStoredBytes(doc) > PRIVACY_MAX_BYTES ? null : doc;
}

/**
 * The editor holds the text as the lawyer delivered it — paragraphs separated
 * by a blank line — and the date the way a German reader writes it.
 */
export interface PrivacyForm {
  /** `TT.MM.JJJJ`; empty when nothing is published. */
  asOf: string;
  text: string;
}

export function privacyToForm(doc: PrivacyDocument): PrivacyForm {
  if (doc.paragraphs === undefined) return { asOf: '', text: '' };
  const [year, month, day] = doc.as_of.split('-');
  return { asOf: `${day}.${month}.${year}`, text: doc.paragraphs.join('\n\n') };
}

/**
 * Pasted text into paragraphs: Windows line ends become `\n` and a tab a space
 * (a word processor puts them in; neither means anything on a web page), each
 * line loses trailing blanks, and a blank line — even one holding spaces — ends
 * a paragraph. Nothing else is changed: no word, no character of the text.
 */
export function splitPrivacyParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.split('\n').map(line => line.trimEnd()).join('\n').trim())
    .filter(paragraph => paragraph !== '');
}

/**
 * The form back into the document a save sends, or the first path the database
 * would refuse. An empty form is `{}` — the text is taken down; a text needs its
 * date and a date needs its text.
 */
export function privacyFromForm(form: PrivacyForm): { value: PrivacyDocument } | { error: string } {
  const paragraphs = splitPrivacyParagraphs(form.text);
  const asOfText = form.asOf.trim();
  if (paragraphs.length === 0 && asOfText === '') return { value: {} };
  if (paragraphs.length === 0) return { error: 'legal.privacy.paragraphs' };

  const asOf = parseGermanDate(asOfText);
  if (!asOf) return { error: 'legal.privacy.as_of' };
  if (paragraphs.length > PRIVACY_MAX_PARAGRAPHS) return { error: 'legal.privacy.paragraphs' };

  const refused = paragraphs.findIndex(privacyParagraphRefused);
  if (refused >= 0) return { error: `legal.privacy.paragraphs.${refused}` };

  const value: PrivacyDocument = { as_of: asOf, paragraphs };
  if (privacyStoredBytes(value) > PRIVACY_MAX_BYTES) return { error: 'value_size' };
  return { value };
}

/**
 * A refusal path of `privacyFromForm` as the sentence the editor shows beside
 * the text, counting paragraphs from 1 the way a reader does.
 */
export function privacyProblemMessage(path: string): { key: TranslationKey; vars: Record<string, number> } {
  const paragraph = /^legal\.privacy\.paragraphs\.(\d+)$/.exec(path);
  if (paragraph) {
    return {
      key: 'admin.settings.privacy.problem.paragraph',
      vars: { number: Number(paragraph[1]) + 1, max: PRIVACY_PARAGRAPH_MAX_LENGTH },
    };
  }
  if (path === 'legal.privacy.as_of') return { key: 'admin.settings.privacy.problem.asOf', vars: {} };
  if (path === 'value_size') return { key: 'admin.settings.privacy.problem.size', vars: { max: PRIVACY_MAX_BYTES } };
  return { key: 'admin.settings.privacy.problem.paragraphs', vars: { max: PRIVACY_MAX_PARAGRAPHS } };
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
