import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canReadAnnouncements,
  canReadSetting,
  canSaveSetting,
  canWriteAnnouncements,
  invoiceSellerFields,
  impressumFormWithSeller,
  impressumFromForm,
  impressumToForm,
  isContactPhone,
  isStorageDate,
  parseGermanDate,
  parseImpressumDocument,
  parsePrivacyDocument,
  privacyFromForm,
  privacyParagraphRefused,
  privacyProblemMessage,
  privacyStoredBytes,
  privacyToForm,
  splitPrivacyParagraphs,
  PRIVACY_MAX_BYTES,
  PRIVACY_MAX_PARAGRAPHS,
  PRIVACY_PARAGRAPH_MAX_LENGTH,
  mailSenderFromForm,
  mailSenderToForm,
  mailTemplateDefaultsKept,
  mailTemplateFromForm,
  mailTemplateToForm,
  invoiceFromForm,
  invoiceNumberExample,
  invoiceToForm,
  isVersionConflict,
  parseInvoice,
  parseSeller,
  parseSettingAnswer,
  planFeaturesFromForm,
  priceBookFromForm,
  priceBookToForm,
  sellerAddressBlock,
  sellerFromForm,
  sellerToForm,
  settingRefusalKey,
  writeCapabilityFor,
  type Seller,
} from './platformSettings';
import { SEED_PLAN_FEATURES, SEED_PRICE_BOOK } from './appConfigSeed';
import { parsePlatformWhoami } from './platformAccess';
import { MAIL_TEMPLATE_DEFAULTS } from '../../supabase/functions/_shared/mail-template.ts';

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

  it('shows the first month the German way, reads it back as cents, and keeps it through a save', () => {
    const form = priceBookToForm(SEED_PRICE_BOOK);
    expect(form.firstMonth).toBe('200,00');

    form.firstMonth = '149,50';
    const result = priceBookFromForm(form);
    expect('book' in result && result.book.first_month_cents).toBe(14950);
  });

  it('an empty first month is a book with none, and 0 is a free first month', () => {
    const form = priceBookToForm(SEED_PRICE_BOOK);
    form.firstMonth = '';
    const none = priceBookFromForm(form);
    expect('book' in none && 'first_month_cents' in none.book).toBe(false);

    form.firstMonth = '0';
    const free = priceBookFromForm(form);
    expect('book' in free && free.book.first_month_cents).toBe(0);
  });

  it('a book saved before the decision opens with an empty first month, and saves without one', () => {
    const { first_month_cents: _none, ...old } = SEED_PRICE_BOOK;
    const form = priceBookToForm(old);
    expect(form.firstMonth).toBe('');
    expect(priceBookFromForm(form)).toEqual({ book: old });
  });

  it('names the first month when it is not an amount the database would accept', () => {
    const form = priceBookToForm(SEED_PRICE_BOOK);
    form.firstMonth = '20x';
    expect(priceBookFromForm(form)).toEqual({ error: 'price_book.first_month_cents' });
    form.firstMonth = '10001,00';
    expect(priceBookFromForm(form)).toEqual({ error: 'price_book.first_month_cents' });
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

// ─── Plan 3.10, second half, and 3.11 ────────────────────────────────────────

describe('who may read and save the mail, flag and announcement settings', () => {
  const owner = access('owner', ['settings.read', 'settings.manage', 'pricing.manage', 'companies.read']);
  const billing = access('billing', ['pricing.manage', 'settings.read', 'billing.manage', 'companies.read']);
  const readOnly = access('read_only', ['settings.read', 'companies.read']);
  const support = access('support', ['companies.read', 'business.read']);
  const keys = ['mail.sender', 'mail.template.signup_verify', 'mail.template.email_change', 'feature_flags'] as const;

  it('asks the owner-only settings.manage for every one of them', () => {
    for (const key of keys) {
      expect(writeCapabilityFor(key)).toBe('settings.manage');
      expect(canSaveSetting(owner, key)).toBe(true);
      expect(canSaveSetting(billing, key)).toBe(false);
      expect(canSaveSetting(readOnly, key)).toBe(false);
    }
  });

  it('lets owner and read_only read them, and neither billing nor support', () => {
    for (const key of keys) {
      expect(canReadSetting(owner, key)).toBe(true);
      expect(canReadSetting(readOnly, key)).toBe(true);
      expect(canReadSetting(billing, key)).toBe(false);
      expect(canReadSetting(support, key)).toBe(false);
    }
  });

  it('announcements: the list for settings.read without billing, the writes for the owner alone', () => {
    expect(canReadAnnouncements(owner)).toBe(true);
    expect(canReadAnnouncements(readOnly)).toBe(true);
    expect(canReadAnnouncements(billing)).toBe(false);
    expect(canReadAnnouncements(support)).toBe(false);
    expect(canWriteAnnouncements(owner)).toBe(true);
    expect(canWriteAnnouncements(readOnly)).toBe(false);
    expect(canWriteAnnouncements(billing)).toBe(false);
  });
});

describe('invoiceSellerFields: the sender the invoice PDF prints', () => {
  const blank: Seller = {
    name: 'El-Professor', street: '', house_number: '', postal_code: '', city: '',
    vat_id: '', tax_number: '', bank_name: '', iban: '', bic: '', account_holder: '',
  };

  it('the seeded placeholder prints exactly what the PDF printed before: the name and nothing else', () => {
    // Both real databases hold this document, and before the invoice read it the
    // page had no company_settings row and printed 'El-Professor' with '' under it.
    expect(invoiceSellerFields(blank)).toEqual({
      sellerName: 'El-Professor', sellerAddress: '', sellerTaxInfo: '', sellerBank: '',
    });
  });

  it('a filled seller prints the old composition character for character', () => {
    const seller: Seller = {
      ...blank, name: 'Taxi Muster GmbH', street: 'Hauptstraße', house_number: '5', postal_code: '42651',
      city: 'Solingen', vat_id: 'DE123456789', tax_number: '128/5712/0815', bank_name: 'Sparkasse',
      iban: 'DE02120300000000202051', bic: 'BYLADEM1001',
    };
    // SubscriptionBillingPage's former expressions, applied to the same values.
    const s = seller;
    const oldAddress = [s.street, s.house_number].filter(Boolean).join(' ') + `\n${s.postal_code || ''} ${s.city || ''}`;
    const oldTax = [s.vat_id ? `USt-IdNr: ${s.vat_id}` : '', s.tax_number ? `Steuernr: ${s.tax_number}` : ''].filter(Boolean).join(' | ');
    const oldBank = [s.bank_name, s.iban ? `IBAN: ${s.iban}` : '', s.bic ? `BIC: ${s.bic}` : ''].filter(Boolean).join(' | ');
    expect(invoiceSellerFields(seller)).toEqual({
      sellerName: 'Taxi Muster GmbH', sellerAddress: oldAddress, sellerTaxInfo: oldTax, sellerBank: oldBank,
    });
    expect(oldAddress).toBe('Hauptstraße 5\n42651 Solingen');
  });

  it('only a city still prints the address line the old code built', () => {
    expect(invoiceSellerFields({ ...blank, city: 'Solingen' }).sellerAddress).toBe('\n Solingen');
  });
});

describe('the mail sender form', () => {
  it('trims and saves a plain name', () => {
    expect(mailSenderFromForm({ name: '  El-Professor Support ' })).toEqual({ value: { name: 'El-Professor Support' } });
    expect(mailSenderToForm({ name: 'El-Professor' })).toEqual({ name: 'El-Professor' });
  });

  it('refuses a name that could pass for an address', () => {
    expect(mailSenderFromForm({ name: 'support@bank.de' })).toEqual({ error: 'mail.sender.name' });
    expect(mailSenderFromForm({ name: '' })).toEqual({ error: 'mail.sender.name' });
  });
});

describe('the mail template form', () => {
  it('shows the default text wherever the stored template leaves a field out', () => {
    const form = mailTemplateToForm('signup_verify', { heading: 'Fast geschafft' });
    expect(form.subject).toBe(MAIL_TEMPLATE_DEFAULTS.signup_verify.subject);
    expect(form.heading).toBe('Fast geschafft');
    expect(form.paragraphs).toEqual([...MAIL_TEMPLATE_DEFAULTS.signup_verify.paragraphs]);
    expect(form.button).toBe(MAIL_TEMPLATE_DEFAULTS.signup_verify.button);
    expect(mailTemplateToForm('email_change', {}).button).toBe('');
  });

  it('saves only the fields that differ from the default, so a form at the defaults saves the seed', () => {
    const untouched = mailTemplateToForm('invite_activate', {});
    expect(mailTemplateFromForm('invite_activate', untouched)).toEqual({ value: {} });

    const changed = { ...untouched, subject: '  Willkommen im Team ', paragraphs: [...untouched.paragraphs, 'Bis bald!'] };
    expect(mailTemplateFromForm('invite_activate', changed)).toEqual({
      value: {
        subject: 'Willkommen im Team',
        paragraphs: [...MAIL_TEMPLATE_DEFAULTS.invite_activate.paragraphs, 'Bis bald!'],
      },
    });
  });

  it('names the field the database would refuse', () => {
    const form = mailTemplateToForm('signup_verify', {});
    expect(mailTemplateFromForm('signup_verify', { ...form, subject: 'Ihr Code {code}' }))
      .toEqual({ error: 'mail.template.signup_verify.subject.code' });
    expect(mailTemplateFromForm('signup_verify', { ...form, paragraphs: ['Bei {company}'] }))
      .toEqual({ error: 'mail.template.signup_verify.paragraphs.0' });
  });

  it('marks which fields still read as the default', () => {
    const form = mailTemplateToForm('password_reset', {});
    expect(mailTemplateDefaultsKept('password_reset', form))
      .toEqual({ subject: true, heading: true, paragraphs: true, button: true });
    expect(mailTemplateDefaultsKept('password_reset', { ...form, heading: 'Neu' }).heading).toBe(false);
  });
});

// ─── The legal pages (20260921120000) ────────────────────────────────────────

const LEGAL_MIGRATION = readFileSync(
  new URL('../../supabase/migrations/20260921120000_legal_pages.sql', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

/** One `c_name CONSTANT integer := N;` of the migration's legal validator. */
function legalConstant(name: string): number {
  const match = LEGAL_MIGRATION.match(new RegExp(`${name}\\s+CONSTANT integer\\s*:=\\s*(\\d+);`));
  if (!match) throw new Error(`the migration has no ${name}`);
  return Number(match[1]);
}

describe('the Impressum (legal.impressum)', () => {
  const SELLER: Seller = {
    name: 'El-Professor GmbH',
    street: 'Hauptstraße', house_number: '12', postal_code: '42651', city: 'Solingen',
    vat_id: 'DE123456789', tax_number: '123/456/78901',
    bank_name: 'Sparkasse', iban: 'DE02120300000000202051', bic: 'BYLADEM1001',
    account_holder: 'El-Professor GmbH',
  };
  const IMPRESSUM = {
    legal_name: 'Muster Mobility GmbH', legal_form: 'GmbH',
    street: 'Hauptstraße', house_number: '12', postal_code: '42651', city: 'Solingen',
    represented_by: 'Erika Muster',
    contact_email: 'info@example.com', contact_phone: '+49 (0)212 555-0101',
    register_court: 'Amtsgericht Wuppertal', register_number: 'HRB 12345',
    vat_id: 'DE123456789',
    content_responsible_name: 'Erika Muster', content_responsible_address: 'Hauptstraße 12, 42651 Solingen',
  };

  it('reads the seed as nothing published, and any of the fourteen fields as stored', () => {
    expect(parseImpressumDocument({})).toEqual({});
    expect(parseImpressumDocument(IMPRESSUM)).toEqual(IMPRESSUM);
    expect(parseImpressumDocument({ legal_name: 'Muster GmbH' })).toEqual({ legal_name: 'Muster GmbH' });
  });

  it('refuses a field it does not know — a bank detail above all — and a field the database would refuse', () => {
    expect(parseImpressumDocument([])).toBeNull();
    expect(parseImpressumDocument({ ...IMPRESSUM, iban: 'DE02120300000000202051' })).toBeNull();
    expect(parseImpressumDocument({ ...IMPRESSUM, name: 'El-Professor' })).toBeNull();
    expect(parseImpressumDocument({ legal_name: 42 })).toBeNull();
    expect(parseImpressumDocument({ represented_by: 'Erika\nMuster' })).toBeNull();
    expect(parseImpressumDocument({ register_number: 'x'.repeat(201) })).toBeNull();
    expect(parseImpressumDocument({ contact_email: 'info at example.com' })).toBeNull();
    expect(parseImpressumDocument({ contact_phone: 'auf Anfrage' })).toBeNull();
    // Empty is simply unfilled.
    expect(parseImpressumDocument({ contact_email: '', contact_phone: '' })).not.toBeNull();
  });

  it('shows all fourteen in the form, blank where nothing is stored, and saves only what holds a value', () => {
    const form = impressumToForm({});
    expect(Object.values(form).every(value => value === '')).toBe(true);
    expect(impressumFromForm(form)).toEqual({ value: {} });
    expect(impressumFromForm(impressumToForm(IMPRESSUM))).toEqual({ value: IMPRESSUM });
    expect(impressumFromForm({ ...form, legal_name: '  Muster GmbH ', city: ' ' }))
      .toEqual({ value: { legal_name: 'Muster GmbH' } });
  });

  it('names the field the database would refuse', () => {
    const form = impressumToForm(IMPRESSUM);
    expect(impressumFromForm({ ...form, contact_email: 'info@' })).toEqual({ error: 'legal.impressum.contact_email' });
    expect(impressumFromForm({ ...form, contact_phone: '+4' })).toEqual({ error: 'legal.impressum.contact_phone' });
    expect(impressumFromForm({ ...form, register_court: 'x'.repeat(201) })).toEqual({ error: 'legal.impressum.register_court' });
  });

  it('accepts a phone number the way people write one, with at least three digits', () => {
    expect(isContactPhone('+49 (0)212 555-0101')).toBe(true);
    expect(isContactPhone('0212 / 555.01.01')).toBe(true);
    expect(isContactPhone('12')).toBe(false);
    expect(isContactPhone('Tel. 0212')).toBe(false);
  });

  it('copies the invoice\'s name, address and VAT id only into empty fields, and never a bank detail', () => {
    const typed = { ...impressumToForm({}), legal_name: 'Muster Mobility GmbH', city: '  ' };
    const next = impressumFormWithSeller(typed, SELLER);
    expect(next.legal_name).toBe('Muster Mobility GmbH');
    expect(next).toMatchObject({
      street: 'Hauptstraße', house_number: '12', postal_code: '42651', city: 'Solingen', vat_id: 'DE123456789',
      represented_by: '', contact_email: '', register_number: '',
    });
    expect(Object.values(next)).not.toContain(SELLER.iban);
    expect(Object.values(next)).not.toContain(SELLER.tax_number);
    // The form it was given is not changed: nothing is saved by pressing the button.
    expect(typed.street).toBe('');
  });

  it('asks the owner-only settings.manage to save, and settings.read without billing to read', () => {
    const owner = access('owner', ['settings.read', 'settings.manage', 'pricing.manage']);
    const billing = access('billing', ['pricing.manage', 'settings.read', 'billing.manage']);
    const readOnly = access('read_only', ['settings.read']);
    for (const key of ['legal.impressum', 'legal.privacy'] as const) {
      expect(writeCapabilityFor(key)).toBe('settings.manage');
      expect(canSaveSetting(owner, key)).toBe(true);
      expect(canSaveSetting(billing, key)).toBe(false);
      expect(canSaveSetting(readOnly, key)).toBe(false);
      expect(canReadSetting(readOnly, key)).toBe(true);
      expect(canReadSetting(billing, key)).toBe(false);
    }
  });
});

describe('the privacy text', () => {
  const DOC = { as_of: '2026-09-21', paragraphs: ['Verantwortlich:\nMuster GmbH\nHauptstraße 12', 'Zweiter Absatz.'] };

  it('keeps the database\'s bounds', () => {
    expect(PRIVACY_MAX_BYTES).toBe(legalConstant('c_privacy_max_bytes'));
    expect(PRIVACY_MAX_PARAGRAPHS).toBe(legalConstant('c_max_paragraphs'));
    expect(PRIVACY_PARAGRAPH_MAX_LENGTH).toBe(legalConstant('c_paragraph_max'));
  });

  it('reads the seed as nothing published, and a stored text as it is', () => {
    expect(parsePrivacyDocument({})).toEqual({});
    expect(parsePrivacyDocument(DOC)).toEqual(DOC);
  });

  it('refuses a stored document the database would refuse', () => {
    expect(parsePrivacyDocument([])).toBeNull();
    expect(parsePrivacyDocument({ paragraphs: DOC.paragraphs })).toBeNull();
    expect(parsePrivacyDocument({ ...DOC, title: 'x' })).toBeNull();
    expect(parsePrivacyDocument({ ...DOC, as_of: '2026-02-30' })).toBeNull();
    expect(parsePrivacyDocument({ ...DOC, paragraphs: [] })).toBeNull();
    expect(parsePrivacyDocument({ ...DOC, paragraphs: ['<p>x</p>'] })).toBeNull();
  });

  it('knows a real date from one that only looks like it', () => {
    expect(isStorageDate('2026-09-21')).toBe(true);
    expect(isStorageDate('2028-02-29')).toBe(true);
    expect(isStorageDate('2026-02-29')).toBe(false);
    expect(isStorageDate('2026-13-01')).toBe(false);
    expect(isStorageDate('1999-12-31')).toBe(false);
    expect(parseGermanDate('21.09.2026')).toBe('2026-09-21');
    expect(parseGermanDate(' 1.9.2026 ')).toBe('2026-09-01');
    expect(parseGermanDate('31.09.2026')).toBeNull();
    expect(parseGermanDate('09/21/2026')).toBeNull();
    expect(parseGermanDate('2026-09-21')).toBeNull();
  });

  it('refuses markup, a stray control character, a blank line and an overlong paragraph', () => {
    expect(privacyParagraphRefused('Eine Zeile\nund die nächste')).toBe(false);
    expect(privacyParagraphRefused('<b>fett</b>')).toBe(true);
    expect(privacyParagraphRefused('a > b')).toBe(true);
    expect(privacyParagraphRefused('Tab\there')).toBe(true);
    expect(privacyParagraphRefused('Eins\n\nZwei')).toBe(true);
    expect(privacyParagraphRefused('   ')).toBe(true);
    expect(privacyParagraphRefused('x'.repeat(4001))).toBe(true);
  });

  it('splits pasted text into paragraphs at blank lines and changes nothing else', () => {
    expect(splitPrivacyParagraphs('Erster Absatz.\r\n\r\nZweiter\r\nAbsatz.  \n \n\n\tDritter.'))
      .toEqual(['Erster Absatz.', 'Zweiter\nAbsatz.', 'Dritter.']);
    expect(splitPrivacyParagraphs('  \n\n ')).toEqual([]);
  });

  it('round-trips a stored text through the form', () => {
    const form = privacyToForm(DOC);
    expect(form).toEqual({ asOf: '21.09.2026', text: 'Verantwortlich:\nMuster GmbH\nHauptstraße 12\n\nZweiter Absatz.' });
    expect(privacyFromForm(form)).toEqual({ value: DOC });
    expect(privacyToForm({})).toEqual({ asOf: '', text: '' });
  });

  it('saves an emptied form as {} — the text is taken down', () => {
    expect(privacyFromForm({ asOf: '', text: ' \n ' })).toEqual({ value: {} });
  });

  it('asks for the date with a text and for a text with a date', () => {
    expect(privacyFromForm({ asOf: '', text: 'Text.' })).toEqual({ error: 'legal.privacy.as_of' });
    expect(privacyFromForm({ asOf: '21.09.2026', text: '' })).toEqual({ error: 'legal.privacy.paragraphs' });
    expect(privacyFromForm({ asOf: '2026-09-21', text: 'Text.' })).toEqual({ error: 'legal.privacy.as_of' });
  });

  it('names the paragraph the database would refuse', () => {
    expect(privacyFromForm({ asOf: '21.09.2026', text: 'Gut.\n\n<script>x</script>' }))
      .toEqual({ error: 'legal.privacy.paragraphs.1' });
    expect(privacyFromForm({ asOf: '21.09.2026', text: Array.from({ length: 301 }, () => 'x').join('\n\n') }))
      .toEqual({ error: 'legal.privacy.paragraphs' });
  });

  it('tells the owner which paragraph, counting from one', () => {
    expect(privacyProblemMessage('legal.privacy.paragraphs.2'))
      .toEqual({ key: 'admin.settings.privacy.problem.paragraph', vars: { number: 3, max: 4000 } });
    expect(privacyProblemMessage('legal.privacy.as_of').key).toBe('admin.settings.privacy.problem.asOf');
    expect(privacyProblemMessage('value_size')).toEqual({ key: 'admin.settings.privacy.problem.size', vars: { max: 32000 } });
    expect(privacyProblemMessage('legal.privacy.paragraphs').key).toBe('admin.settings.privacy.problem.paragraphs');
  });

  it('counts bytes the way PostgreSQL prints the document', () => {
    // jsonb prints `{"as_of": "…", "paragraphs": ["a", "b"]}`: a space after
    // each colon and comma, umlauts as two bytes, a line break as \n.
    expect(privacyStoredBytes({})).toBe(2);
    expect(privacyStoredBytes({ as_of: '2026-09-21', paragraphs: ['a', 'b'] }))
      .toBe('{"as_of": "2026-09-21", "paragraphs": ["a", "b"]}'.length);
    expect(privacyStoredBytes({ as_of: '2026-09-21', paragraphs: ['ä\n"'] }))
      .toBe('{"as_of": "2026-09-21", "paragraphs": ["'.length + 2 + 2 + 2 + '"]}'.length);
  });

  it('refuses a text over the byte bound as a whole, and takes one just under it', () => {
    // 15 paragraphs of 1000 umlauts: some 30 KB, more than every other key may hold.
    const under = Array.from({ length: 15 }, () => 'ä'.repeat(1000)).join('\n\n');
    const accepted = privacyFromForm({ asOf: '21.09.2026', text: under });
    expect('value' in accepted && privacyStoredBytes(accepted.value)).toBeGreaterThan(16384);
    const over = Array.from({ length: 17 }, () => 'ä'.repeat(1000)).join('\n\n');
    expect(privacyFromForm({ asOf: '21.09.2026', text: over })).toEqual({ error: 'value_size' });
  });
});
