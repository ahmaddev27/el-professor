import { describe, expect, it } from 'vitest';
import {
  canReadSetting,
  canSaveSetting,
  invoiceFromForm,
  invoiceNumberExample,
  invoiceToForm,
  isVersionConflict,
  parseInvoice,
  parseSeller,
  parseSettingAnswer,
  parseTrial,
  planFeaturesFromForm,
  priceBookFromForm,
  priceBookToForm,
  sellerAddressBlock,
  sellerFromForm,
  sellerToForm,
  settingRefusalKey,
  trialFromForm,
  trialToForm,
  writeCapabilityFor,
  type Seller,
} from './platformSettings';
import { SEED_PLAN_FEATURES, SEED_PRICE_BOOK } from './appConfigSeed';
import { parsePlatformWhoami } from './platformAccess';

const access = (role: string, capabilities: string[]) => parsePlatformWhoami({ role, capabilities });

describe('parseSettingAnswer', () => {
  it('reads a stored value with its version', () => {
    expect(parseSettingAnswer({
      ok: true,
      key: 'price_book',
      value: SEED_PRICE_BOOK,
      version: 3,
      updated_at: '2026-09-16T10:00:00Z',
      updated_by: 'u1',
    })).toEqual({
      ok: true,
      key: 'price_book',
      value: SEED_PRICE_BOOK,
      version: 3,
      updatedAt: '2026-09-16T10:00:00Z',
      updatedBy: 'u1',
    });
  });

  it('is malformed without a usable version — a save needs one to pin against', () => {
    expect(parseSettingAnswer({ ok: true, key: 'price_book', value: {} }))
      .toEqual({ ok: false, reason: 'malformed' });
    expect(parseSettingAnswer({ ok: true, version: '3' }))
      .toEqual({ ok: false, reason: 'malformed' });
  });

  it('carries the current version of a stale save back', () => {
    expect(parseSettingAnswer({ ok: false, reason: 'version_conflict', current_version: 7 }))
      .toEqual({ ok: false, reason: 'version_conflict', currentVersion: 7 });
  });

  it('carries which feature keys an incomplete map failed to name', () => {
    expect(parseSettingAnswer({
      ok: false,
      reason: 'invalid_value',
      problem: 'plan_features.missing.abrechnung',
      missing_features: ['abrechnung', 'belege'],
    })).toEqual({
      ok: false,
      reason: 'invalid_value',
      problem: 'plan_features.missing.abrechnung',
      missingFeatures: ['abrechnung', 'belege'],
    });
  });

  it('reads anything unrecognisable as malformed', () => {
    for (const data of [null, 'ok', 42, []]) {
      expect(parseSettingAnswer(data)).toEqual({ ok: false, reason: 'malformed' });
    }
  });
});

describe('settingRefusalKey', () => {
  it('gives each refusal its own message', () => {
    expect(settingRefusalKey('version_conflict')).toBe('admin.settings.refusal.versionConflict');
    expect(settingRefusalKey('forbidden')).toBe('admin.settings.refusal.forbidden');
    expect(settingRefusalKey('rate_limited')).toBe('admin.settings.refusal.rateLimited');
    expect(settingRefusalKey('invalid_value')).toBe('admin.settings.refusal.invalidValue');
    expect(settingRefusalKey('unknown_key')).toBe('admin.settings.refusal.unknownKey');
    expect(settingRefusalKey('not_found')).toBe('admin.settings.refusal.notFound');
  });

  it('falls back for a reason this build does not know', () => {
    expect(settingRefusalKey('something_new')).toBe('admin.settings.refusal.failed');
  });
});

describe('isVersionConflict', () => {
  it('marks the one refusal that means somebody else saved first', () => {
    // Never retried with the version that came back: that would overwrite the
    // other person's change without anyone seeing it.
    expect(isVersionConflict({ ok: false, reason: 'version_conflict', currentVersion: 4 })).toBe(true);
    expect(isVersionConflict({ ok: false, reason: 'forbidden' })).toBe(false);
    expect(isVersionConflict({ ok: true, key: 'price_book', value: {}, version: 1, updatedAt: null, updatedBy: null }))
      .toBe(false);
  });
});

describe('who may read and save a key', () => {
  it('asks pricing.manage for the prices and settings.manage for the feature map', () => {
    expect(writeCapabilityFor('price_book')).toBe('pricing.manage');
    expect(writeCapabilityFor('plan_features')).toBe('settings.manage');
  });

  it('lets billing save prices but never the feature map', () => {
    // One billing write of a short map would lock every gated screen for every
    // non-trial company below premium, so 3.A puts features under the
    // owner-only settings.manage.
    const billing = access('billing', ['pricing.manage', 'settings.read', 'billing.manage']);
    expect(canSaveSetting(billing, 'price_book')).toBe(true);
    expect(canSaveSetting(billing, 'plan_features')).toBe(false);
  });

  it('lets billing read the prices only', () => {
    const billing = access('billing', ['settings.read']);
    expect(canReadSetting(billing, 'price_book')).toBe(true);
    expect(canReadSetting(billing, 'plan_features')).toBe(false);
  });

  it('lets another role with settings.read read both', () => {
    const readOnly = access('read_only', ['settings.read']);
    expect(canReadSetting(readOnly, 'price_book')).toBe(true);
    expect(canReadSetting(readOnly, 'plan_features')).toBe(true);
  });

  it('refuses a role without settings.read entirely', () => {
    const support = access('support', ['business.read']);
    expect(canReadSetting(support, 'price_book')).toBe(false);
  });
});

describe('the price book form', () => {
  it('round-trips the seeded book', () => {
    const result = priceBookFromForm(priceBookToForm(SEED_PRICE_BOOK));
    expect('book' in result && result.book).toEqual(SEED_PRICE_BOOK);
  });

  it('shows whole-euro prices the German way and reads them back as cents', () => {
    const form = priceBookToForm(SEED_PRICE_BOOK);
    expect(form.pricePerCar.basic).toBe('20,00');

    form.pricePerCar.basic = '12,34';
    const result = priceBookFromForm(form);
    expect('book' in result && result.book.price_per_car_cents.basic).toBe(1234);
  });

  it('names the field a typo is in', () => {
    const form = priceBookToForm(SEED_PRICE_BOOK);
    form.pricePerCar.advanced = '40.00.5';
    expect(priceBookFromForm(form)).toEqual({ error: 'price_book.price_per_car_cents.advanced' });
  });

  it('refuses tiers that are not strictly increasing', () => {
    // The database requires it so the tier a car count reaches is never
    // ambiguous; naming the row here beats a whole-document refusal.
    const form = priceBookToForm(SEED_PRICE_BOOK);
    form.tiers = [{ minCars: '6', percent: '5' }, { minCars: '6', percent: '10' }];
    expect(priceBookFromForm(form)).toEqual({ error: 'price_book.fleet_discount_tiers.1' });
  });

  it('refuses a percentage above 100 and a price above the validator bound', () => {
    const form = priceBookToForm(SEED_PRICE_BOOK);
    form.yearlyDiscountPercent = '110';
    expect(priceBookFromForm(form)).toEqual({ error: 'price_book.yearly_discount_percent' });

    const pricey = priceBookToForm(SEED_PRICE_BOOK);
    pricey.pricePerCar.premium = '10001,00';
    expect(priceBookFromForm(pricey)).toEqual({ error: 'price_book.price_per_car_cents.premium' });
  });

  it('accepts a book with no fleet tiers at all', () => {
    const form = priceBookToForm(SEED_PRICE_BOOK);
    form.tiers = [];
    const result = priceBookFromForm(form);
    expect('book' in result && result.book.fleet_discount_tiers).toEqual([]);
  });
});

describe('planFeaturesFromForm', () => {
  it('changes only the values it was given', () => {
    const map = planFeaturesFromForm(SEED_PLAN_FEATURES, { werkstatt: 'premium' });
    expect(map?.werkstatt).toBe('premium');
    expect(map?.abrechnung).toBe('advanced');
    expect(Object.keys(map ?? {})).toHaveLength(Object.keys(SEED_PLAN_FEATURES).length);
  });

  it('keeps a key this build does not know', () => {
    // That is how a feature is seeded before the release that gates it; dropping
    // it would make the next save incomplete and be refused.
    const loaded = { ...SEED_PLAN_FEATURES, ankuendigungen: 'premium' as const };
    const map = planFeaturesFromForm(loaded, { belege: 'advanced' });
    expect(map?.ankuendigungen).toBe('premium');
    expect(map?.belege).toBe('advanced');
  });

  it('is null when a plan name is not one the database accepts', () => {
    expect(planFeaturesFromForm(SEED_PLAN_FEATURES, { belege: 'gold' as never })).toBeNull();
  });
});

// ─── plan 3.10: the seller, the trial and the invoice defaults ──────────────

/** The document 20260919120000 seeds where no company_settings row exists. */
const EMPTY_SELLER: Seller = {
  name: 'El-Professor',
  street: '', house_number: '', postal_code: '', city: '',
  vat_id: '', tax_number: '', bank_name: '', iban: '', bic: '', account_holder: '',
};

const FULL_SELLER: Seller = {
  name: 'El-Professor GmbH',
  street: 'Hauptstraße', house_number: '12', postal_code: '42651', city: 'Solingen',
  vat_id: 'DE123456789', tax_number: '123/456/78901',
  bank_name: 'Sparkasse', iban: 'DE02120300000000202051', bic: 'BYLADEM1001',
  account_holder: 'El-Professor GmbH',
};

describe('who may read and save the three keys of 3.10', () => {
  it('asks the owner-only settings.manage for all three', () => {
    // The seller is printed on every invoice, the trial decides how long a
    // company gets the product for nothing, and the invoice defaults name every
    // document. Plan 3.A puts all of that under settings.manage, not under the
    // pricing.manage billing also holds.
    expect(writeCapabilityFor('seller')).toBe('settings.manage');
    expect(writeCapabilityFor('trial')).toBe('settings.manage');
    expect(writeCapabilityFor('invoice')).toBe('settings.manage');
  });

  it('refuses billing all three, on reading as well as saving', () => {
    const billing = access('billing', ['pricing.manage', 'settings.read', 'billing.manage']);
    for (const key of ['seller', 'trial', 'invoice'] as const) {
      expect(canReadSetting(billing, key)).toBe(false);
      expect(canSaveSetting(billing, key)).toBe(false);
    }
    // It keeps the prices, which is what settings.read means for that role.
    expect(canReadSetting(billing, 'price_book')).toBe(true);
  });

  it('lets read_only read them and save none of them', () => {
    const readOnly = access('read_only', ['settings.read']);
    for (const key of ['seller', 'trial', 'invoice'] as const) {
      expect(canReadSetting(readOnly, key)).toBe(true);
      expect(canSaveSetting(readOnly, key)).toBe(false);
    }
  });

  it('lets the owner save all three', () => {
    const owner = access('owner', ['settings.read', 'settings.manage', 'pricing.manage']);
    for (const key of ['seller', 'trial', 'invoice'] as const) {
      expect(canSaveSetting(owner, key)).toBe(true);
    }
  });
});

describe('the seller', () => {
  it('reads the document the migration seeds, and round-trips it through the form', () => {
    expect(parseSeller(EMPTY_SELLER)).toEqual(EMPTY_SELLER);
    const result = sellerFromForm(sellerToForm(FULL_SELLER));
    expect('value' in result && result.value).toEqual(FULL_SELLER);
  });

  it('refuses a document with a field missing or one too many', () => {
    // The database compares the key set exactly, so a screen that dropped a
    // field would send a document refused as a whole.
    const { bic, ...short } = FULL_SELLER;
    expect(bic).toBe('BYLADEM1001');
    expect(parseSeller(short)).toBeNull();
    expect(parseSeller({ ...FULL_SELLER, country: 'Deutschland' })).toBeNull();
  });

  it('refuses a nameless seller — an invoice with no sender', () => {
    expect(parseSeller({ ...FULL_SELLER, name: '   ' })).toBeNull();
    expect(sellerFromForm(sellerToForm({ ...FULL_SELLER, name: '  ' }))).toEqual({ error: 'seller.name' });
  });

  it('lets every other field be blank', () => {
    const result = sellerFromForm(sellerToForm(EMPTY_SELLER));
    expect('value' in result && result.value.vat_id).toBe('');
  });

  it('names the field a control character is in — these lines are drawn into a PDF', () => {
    expect(sellerFromForm({ ...sellerToForm(FULL_SELLER), street: 'Haupt\nstraße' }))
      .toEqual({ error: 'seller.street' });
    expect(parseSeller({ ...FULL_SELLER, iban: 'DE02\t1203' })).toBeNull();
  });

  it('names the field that is too long for the database', () => {
    expect(sellerFromForm({ ...sellerToForm(FULL_SELLER), city: 'x'.repeat(201) }))
      .toEqual({ error: 'seller.city' });
    expect(parseSeller({ ...FULL_SELLER, city: 'x'.repeat(201) })).toBeNull();
  });

  it('trims on the way out, as the migration trimmed the row it copied', () => {
    const result = sellerFromForm({ ...sellerToForm(FULL_SELLER), city: '  Solingen  ' });
    expect('value' in result && result.value.city).toBe('Solingen');
  });

  it('lays the sender block out the way the invoice PDF composes it', () => {
    // German labels in both languages: this block is printed on a German
    // payment record (src/i18n/index.ts).
    expect(sellerAddressBlock(FULL_SELLER)).toEqual([
      'El-Professor GmbH',
      'Hauptstraße 12',
      '42651 Solingen',
      'USt-IdNr: DE123456789 | Steuernr: 123/456/78901',
      'Sparkasse | IBAN: DE02120300000000202051 | BIC: BYLADEM1001',
    ]);
  });

  it('leaves out a line the seller has no values for', () => {
    expect(sellerAddressBlock(EMPTY_SELLER)).toEqual(['El-Professor']);
    expect(sellerAddressBlock({ ...EMPTY_SELLER, iban: 'DE02' }))
      .toEqual(['El-Professor', 'IBAN: DE02']);
  });
});

describe('the trial length', () => {
  it('reads the seeded document', () => {
    expect(parseTrial({ days: 14 })).toEqual({ days: 14 });
    expect(trialFromForm(trialToForm({ days: 14 }))).toEqual({ value: { days: 14 } });
  });

  it('refuses a document with any other key', () => {
    expect(parseTrial({ days: 14, weeks: 2 })).toBeNull();
    expect(parseTrial({})).toBeNull();
  });

  it('refuses a trial of no days, of half a day, or of more than a year', () => {
    // Below a day is not a trial; above a year is a typo that would give a
    // company free access for years.
    expect(parseTrial({ days: 0 })).toBeNull();
    expect(parseTrial({ days: 0.5 })).toBeNull();
    expect(parseTrial({ days: 366 })).toBeNull();
    expect(parseTrial({ days: '14' })).toBeNull();
    expect(trialFromForm({ days: '0' })).toEqual({ error: 'trial.days' });
    expect(trialFromForm({ days: '366' })).toEqual({ error: 'trial.days' });
    expect(trialFromForm({ days: '14,5' })).toEqual({ error: 'trial.days' });
    expect(trialFromForm({ days: '' })).toEqual({ error: 'trial.days' });
  });

  it('accepts both ends of the range the database allows', () => {
    expect(trialFromForm({ days: '1' })).toEqual({ value: { days: 1 } });
    expect(trialFromForm({ days: '365' })).toEqual({ value: { days: 365 } });
  });
});

describe('the invoice defaults', () => {
  const INVOICE = { number_prefix: 'INV', number_digits: 4, default_payment_method: 'cash' };

  it('reads the seeded document and round-trips it', () => {
    expect(parseInvoice(INVOICE)).toEqual(INVOICE);
    expect(invoiceFromForm(invoiceToForm(INVOICE))).toEqual({ value: INVOICE });
  });

  it('refuses a prefix with a dash — the dash separates the running number', () => {
    // generate_invoice_number reads the sequence back with
    // split_part(invoice_number, '-', 3).
    expect(invoiceFromForm({ ...invoiceToForm(INVOICE), numberPrefix: 'IN-V' }))
      .toEqual({ error: 'invoice.number_prefix' });
    expect(parseInvoice({ ...INVOICE, number_prefix: 'IN-V' })).toBeNull();
  });

  it('refuses a lower-case or empty prefix', () => {
    expect(invoiceFromForm({ ...invoiceToForm(INVOICE), numberPrefix: 'inv' }))
      .toEqual({ error: 'invoice.number_prefix' });
    expect(invoiceFromForm({ ...invoiceToForm(INVOICE), numberPrefix: '' }))
      .toEqual({ error: 'invoice.number_prefix' });
  });

  it('refuses a running number of no digits or of more than ten', () => {
    expect(invoiceFromForm({ ...invoiceToForm(INVOICE), numberDigits: '0' }))
      .toEqual({ error: 'invoice.number_digits' });
    expect(invoiceFromForm({ ...invoiceToForm(INVOICE), numberDigits: '11' }))
      .toEqual({ error: 'invoice.number_digits' });
    expect(parseInvoice({ ...INVOICE, number_digits: 0 })).toBeNull();
  });

  it('refuses a payment method that is not a plain identifier', () => {
    expect(invoiceFromForm({ ...invoiceToForm(INVOICE), defaultPaymentMethod: 'Bar zahlung' }))
      .toEqual({ error: 'invoice.default_payment_method' });
    expect(parseInvoice({ ...INVOICE, default_payment_method: 'Cash' })).toBeNull();
  });

  it('builds the example number the way generate_invoice_number builds it', () => {
    expect(invoiceNumberExample(INVOICE, 2026)).toBe('INV-2026-0001');
    expect(invoiceNumberExample({ ...INVOICE, number_digits: 6 }, 2026)).toBe('INV-2026-000001');
    expect(invoiceNumberExample({ ...INVOICE, number_prefix: 'RG', number_digits: 1 }, 2027))
      .toBe('RG-2027-1');
  });
});
