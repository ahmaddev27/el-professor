/**
 * `parseAppConfig` reads the answer of `get_public_config()` (anyone) and
 * `get_app_config()` (signed in). It is the only place the browser turns a
 * database answer into prices and plan gates, so every part of a broken answer
 * has to fall back on its own: the public answer legitimately carries no
 * feature map, and a price book that does not parse must not price anything.
 *
 * `shouldRefreshAppConfig` is the staleness window `AppConfigProvider` applies
 * when the tab regains focus. It is here rather than in the component because
 * the rule — and not the event plumbing — is what must not drift.
 */
import { describe, expect, it } from 'vitest';
import {
  APP_CONFIG_MAX_AGE_MS,
  parseAppConfig,
  shouldRefreshAppConfig,
  SEED_APP_CONFIG,
  type AppConfig,
} from './appConfig';
import { SEED_PLAN_FEATURES, SEED_PRICE_BOOK, SEED_TRIAL_DAYS } from './appConfigSeed';

const ANOTHER_BOOK = {
  price_per_car_cents: { basic: 1250, advanced: 3300, premium: 9900 },
  fleet_discount_tiers: [{ min_cars: 4, percent: 25 }],
  yearly_discount_percent: 20,
};

/** A configuration that is nothing like the seed, to stand in as "what is already shown". */
const LOADED: AppConfig = {
  priceBook: ANOTHER_BOOK,
  planFeatures: { belege: 'premium' },
  trialDays: 30,
  featureFlags: {},
  announcements: [],
};

describe('parseAppConfig reads a full answer', () => {
  it('takes the price book, the feature map and the trial length', () => {
    const config = parseAppConfig({
      price_book: ANOTHER_BOOK,
      plan_features: { belege: 'advanced' },
      trial_days: 30,
    });

    expect(config.priceBook).toEqual(ANOTHER_BOOK);
    expect(config.planFeatures).toEqual({ belege: 'advanced' });
    expect(config.trialDays).toBe(30);
  });

  it('takes the feature flags and the announcements (plan 3.11), dropping an entry it cannot read', () => {
    const announcement = {
      id: 'a1', version: 2, tone: 'warning', title_de: 'Wartung', body_de: 'Heute Nacht.',
      title_en: '', body_en: '', starts_at: '2026-09-20T20:00:00+00:00', ends_at: null,
    };
    const config = parseAppConfig({
      price_book: SEED_PRICE_BOOK,
      plan_features: SEED_PLAN_FEATURES,
      trial_days: SEED_TRIAL_DAYS,
      feature_flags: { something: true, other: false, 'Bad Key': true, not_boolean: 'yes' },
      announcements: [announcement, { text: 'hello' }],
    });

    expect(config.featureFlags).toEqual({ something: true, other: false });
    expect(config.announcements).toEqual([{
      id: 'a1', version: 2, tone: 'warning', titleDe: 'Wartung', bodyDe: 'Heute Nacht.',
      titleEn: '', bodyEn: '', startsAt: '2026-09-20T20:00:00+00:00', endsAt: null,
    }]);
  });

  it('flags and announcements belong to the signed-in account: an answer without them has none', () => {
    const loaded: AppConfig = {
      ...LOADED,
      featureFlags: { something: true },
      announcements: [{
        id: 'a1', version: 1, tone: 'info', titleDe: 'x', bodyDe: 'y', titleEn: '', bodyEn: '',
        startsAt: '2026-09-20T00:00:00Z', endsAt: null,
      }],
    };
    // get_public_config(), after a sign-out: nothing of the last account stays.
    const visitor = parseAppConfig({ price_book: SEED_PRICE_BOOK, trial_days: 14 }, loaded);
    expect(visitor.featureFlags).toEqual({});
    expect(visitor.announcements).toEqual([]);

    // Present but malformed: the last good value stays, as for every other part.
    const broken = parseAppConfig({ feature_flags: 'on', announcements: { id: 'a1' } }, loaded);
    expect(broken.featureFlags).toEqual(loaded.featureFlags);
    expect(broken.announcements).toEqual(loaded.announcements);
  });

  it('a public answer without a feature map keeps the one already loaded', () => {
    // get_public_config() carries the price book and the trial length only.
    const config = parseAppConfig({ price_book: SEED_PRICE_BOOK, trial_days: 14 }, LOADED);

    expect(config.priceBook).toEqual(SEED_PRICE_BOOK);
    expect(config.planFeatures).toEqual(LOADED.planFeatures);
  });
});

describe('a malformed database answer keeps what is already shown', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [{ price_book: SEED_PRICE_BOOK }]],
    ['a string', '{"price_book":null}'],
    ['a number', 1],
  ])('%s is no answer at all', (_label, value) => {
    expect(parseAppConfig(value, LOADED)).toBe(LOADED);
  });

  it('defaults to the seed when no fallback is given', () => {
    expect(parseAppConfig(null)).toBe(SEED_APP_CONFIG);
    expect(parseAppConfig({}).priceBook).toEqual(SEED_PRICE_BOOK);
    expect(parseAppConfig({}).planFeatures).toEqual(SEED_PLAN_FEATURES);
    expect(parseAppConfig({}).trialDays).toBe(SEED_TRIAL_DAYS);
  });

  it('a broken price book does not price anything: the loaded one stays', () => {
    const config = parseAppConfig(
      { price_book: { price_per_car_cents: { basic: 'free' } }, plan_features: { belege: 'basic' } },
      LOADED,
    );

    expect(config.priceBook).toEqual(LOADED.priceBook);
    // …and the parts that did parse are still taken.
    expect(config.planFeatures).toEqual({ belege: 'basic' });
  });

  it('a broken feature map leaves the gates where they were', () => {
    const config = parseAppConfig(
      { price_book: SEED_PRICE_BOOK, plan_features: { belege: 'gold' } },
      LOADED,
    );

    expect(config.planFeatures).toEqual(LOADED.planFeatures);
    expect(config.priceBook).toEqual(SEED_PRICE_BOOK);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['a fraction', 14.5],
    ['above ten years', 3651],
    ['a string', '14'],
    ['null', null],
  ])('a trial length that is %s is refused', (_label, value) => {
    expect(parseAppConfig({ trial_days: value }, LOADED).trialDays).toBe(LOADED.trialDays);
  });

  it('one day and ten years are accepted', () => {
    expect(parseAppConfig({ trial_days: 1 }, LOADED).trialDays).toBe(1);
    expect(parseAppConfig({ trial_days: 3650 }, LOADED).trialDays).toBe(3650);
  });
});

describe('shouldRefreshAppConfig: when a woken tab asks again', () => {
  const now = 1_700_000_000_000;

  it('does not ask before the first answer has arrived', () => {
    // The load on mount owns that call; a focus must not race it.
    expect(shouldRefreshAppConfig(null, now)).toBe(false);
  });

  it('does not ask again inside the window', () => {
    expect(shouldRefreshAppConfig(now, now)).toBe(false);
    expect(shouldRefreshAppConfig(now - (APP_CONFIG_MAX_AGE_MS - 1), now)).toBe(false);
  });

  it('asks once the answer is as old as the window', () => {
    expect(shouldRefreshAppConfig(now - APP_CONFIG_MAX_AGE_MS, now)).toBe(true);
    expect(shouldRefreshAppConfig(now - 24 * 60 * 60 * 1000, now)).toBe(true);
  });

  it('asks when the clock has moved backwards, rather than waiting out a window that may never end', () => {
    expect(shouldRefreshAppConfig(now + 60_000, now)).toBe(true);
  });

  it('takes the window as an argument, so a caller can say what stale means', () => {
    expect(shouldRefreshAppConfig(now - 1000, now, 500)).toBe(true);
    expect(shouldRefreshAppConfig(now - 1000, now, 5000)).toBe(false);
  });

  it('the window is five minutes', () => {
    expect(APP_CONFIG_MAX_AGE_MS).toBe(5 * 60 * 1000);
  });
});
