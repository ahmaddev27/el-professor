import { describe, expect, it } from 'vitest';
import {
  canReadSetting,
  canSaveSetting,
  isVersionConflict,
  parseSettingAnswer,
  planFeaturesFromForm,
  priceBookFromForm,
  priceBookToForm,
  settingRefusalKey,
  writeCapabilityFor,
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
