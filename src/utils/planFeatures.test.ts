/**
 * The plan feature map comes from the database (`plan_features` in
 * `app_private.platform_settings`), so the browser has to survive whatever it
 * is handed. Two rules carry that:
 *
 *  1. **Fail closed.** A feature the map does not name needs premium. A build
 *     that knows a screen the database has not heard of locks it rather than
 *     opening it to everyone.
 *  2. **A malformed map is not a map.** `parsePlanFeatures` returns null, and
 *     the caller keeps the map it already had.
 *
 * Since migration 20260917120000 the database also refuses to *store* a map
 * that does not name every feature this build knows, so rule 1 is the second
 * wall rather than the only one. The last test here is what keeps the two
 * lists in step.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { minPlanForFeature, parsePlanFeatures, planHasFeature, PLAN_RANK } from './planFeatures';
import { SEED_PLAN_FEATURES } from '../lib/appConfigSeed';
import type { FeatureKey, Plan } from '../contexts/PlanContext';

/** A feature key the map is never given, typed as one so the callers compile. */
const UNNAMED = 'gehaelter' as FeatureKey;

describe('fail closed: a feature the map does not name needs premium', () => {
  it('an empty map puts every feature behind premium', () => {
    expect(minPlanForFeature({}, UNNAMED)).toBe('premium');
    expect(planHasFeature({}, 'basic', UNNAMED)).toBe(false);
    expect(planHasFeature({}, 'advanced', UNNAMED)).toBe(false);
    expect(planHasFeature({}, 'premium', UNNAMED)).toBe(true);
  });

  it('a map missing one key locks only that one', () => {
    const map = { ...SEED_PLAN_FEATURES } as Record<string, Plan>;
    delete map.belege;

    expect(minPlanForFeature(map, 'belege' as FeatureKey)).toBe('premium');
    expect(planHasFeature(map, 'basic', 'belege' as FeatureKey)).toBe(false);
    // …and its neighbours are untouched.
    expect(planHasFeature(map, 'basic', 'fahrer' as FeatureKey)).toBe(true);
  });

  it('a value that is not one of the three plans counts as unnamed', () => {
    const map = { belege: 'gold' } as unknown as Record<string, Plan>;
    expect(minPlanForFeature(map, 'belege' as FeatureKey)).toBe('premium');
  });

  it('an inherited property is not a named feature', () => {
    // `{}.constructor` exists on every object; a plain lookup would read it.
    expect(minPlanForFeature({}, 'constructor' as FeatureKey)).toBe('premium');
    expect(minPlanForFeature({}, 'toString' as FeatureKey)).toBe('premium');
  });

  it('a named feature is unlocked from its own plan up', () => {
    expect(minPlanForFeature(SEED_PLAN_FEATURES, 'belege' as FeatureKey)).toBe('basic');
    expect(planHasFeature(SEED_PLAN_FEATURES, 'basic', 'belege' as FeatureKey)).toBe(true);
    expect(planHasFeature(SEED_PLAN_FEATURES, 'basic', 'werkstatt' as FeatureKey)).toBe(false);
    expect(planHasFeature(SEED_PLAN_FEATURES, 'advanced', 'werkstatt' as FeatureKey)).toBe(true);
    expect(planHasFeature(SEED_PLAN_FEATURES, 'advanced', 'gehaelter' as FeatureKey)).toBe(false);
    expect(planHasFeature(SEED_PLAN_FEATURES, 'premium', 'gehaelter' as FeatureKey)).toBe(true);
  });

  it('the plans rank basic < advanced < premium', () => {
    expect(PLAN_RANK.basic).toBeLessThan(PLAN_RANK.advanced);
    expect(PLAN_RANK.advanced).toBeLessThan(PLAN_RANK.premium);
  });
});

describe('parsePlanFeatures reads what the database validates, and nothing else', () => {
  it('reads a well-formed map', () => {
    expect(parsePlanFeatures({ belege: 'basic', werkstatt: 'advanced', gehaelter: 'premium' }))
      .toEqual({ belege: 'basic', werkstatt: 'advanced', gehaelter: 'premium' });
  });

  it('reads the seeded map unchanged', () => {
    expect(parsePlanFeatures(SEED_PLAN_FEATURES)).toEqual(SEED_PLAN_FEATURES);
  });

  it('an empty object is still a map — the fail-closed rule then locks everything', () => {
    expect(parsePlanFeatures({})).toEqual({});
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [{ belege: 'basic' }]],
    ['a string', '{"belege":"basic"}'],
    ['a number', 42],
    ['a boolean', true],
  ])('a malformed answer (%s) is not a map', (_label, value) => {
    expect(parsePlanFeatures(value)).toBeNull();
  });

  it.each([
    ['a plan that does not exist', { belege: 'gold' }],
    ['a plan in the wrong case', { belege: 'Basic' }],
    ['a plan that is not a string', { belege: 1 }],
    ['a null plan', { belege: null }],
    ['a nested object', { belege: { min: 'basic' } }],
    ['a key with a capital', { Belege: 'basic' }],
    ['a key with a dot', { 'belege.neu': 'basic' }],
    ['a key starting with a digit', { '1belege': 'basic' }],
    ['an empty key', { '': 'basic' }],
  ])('%s makes the whole map unusable', (_label, value) => {
    expect(parsePlanFeatures(value)).toBeNull();
  });

  it('a key longer than 60 characters is refused, 60 is not', () => {
    expect(parsePlanFeatures({ ['a'.repeat(61)]: 'basic' })).toBeNull();
    expect(parsePlanFeatures({ ['a'.repeat(60)]: 'basic' })).not.toBeNull();
  });

  it('more than 200 features is refused, 200 is not', () => {
    const entries = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}`, 'basic']));
    expect(parsePlanFeatures(entries(201))).toBeNull();
    expect(parsePlanFeatures(entries(200))).not.toBeNull();
  });

  it('a feature this build does not know is kept, not a reason to refuse the map', () => {
    // How a key is seeded before the release that gates it.
    const parsed = parsePlanFeatures({ ...SEED_PLAN_FEATURES, a_feature_of_a_later_release: 'basic' });
    expect(parsed?.a_feature_of_a_later_release).toBe('basic');
  });

  it('the parsed map is a copy: changing it cannot change the answer it came from', () => {
    const answer: Record<string, string> = { belege: 'basic' };
    const parsed = parsePlanFeatures(answer) as Record<string, Plan>;
    parsed.belege = 'premium';
    expect(answer.belege).toBe('basic');
  });
});

describe('the keys the database requires are the keys this build gates', () => {
  /**
   * Since 20260917120000 a written `plan_features` map must name every key in
   * `app_private.plan_feature_keys()`. If that list and `FeatureKey` drift, one
   * of two things happens: a key the app gates is missing from the map and
   * every plan sees it as premium, or the database refuses every write of a map
   * this build would consider complete. The migration's own text is the fixture.
   *
   * The **newest** migration that defines the list is the live one — a later
   * release adding a feature replaces the function — so it is found by name
   * order rather than named here, the way the migration chain itself resolves.
   */
  const KEYS_IN_ARRAY = /FUNCTION app_private\.plan_feature_keys\(\)[\s\S]*?RETURN ARRAY\[([\s\S]*?)\];/;

  const keysInMigration = (): string[] => {
    const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
    const defining = readdirSync(dir)
      .filter(file => file.endsWith('.sql'))
      .sort()
      .map(file => readFileSync(dir + file, 'utf8'))
      .filter(sql => KEYS_IN_ARRAY.test(sql));

    if (defining.length === 0) throw new Error('no migration defines plan_feature_keys()');
    const body = defining[defining.length - 1].match(KEYS_IN_ARRAY);
    return [...body![1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map(m => m[1]);
  };

  it('plan_feature_keys() lists exactly the features the seed names', () => {
    expect(keysInMigration()).toEqual(Object.keys(SEED_PLAN_FEATURES).sort());
  });

  it('and lists them in byte order, as the database compares them', () => {
    const keys = keysInMigration();
    expect(keys).toEqual([...keys].sort());
  });

  it('there are sixteen of them', () => {
    expect(keysInMigration()).toHaveLength(16);
  });
});
