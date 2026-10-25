/**
 * Feature flags (plan 3.11). The one rule that matters: a flag the map does not
 * name is off — unknown, malformed or missing alike — so a screen guarded by a
 * flag stays shut until somebody switches it on.
 */
import { describe, expect, it } from 'vitest';
import {
  FLAG_DEFINITIONS,
  KNOWN_FLAG_KEYS,
  flagDefinition,
  flagEnabled,
  flagsFromRows,
  flagsToRows,
  isFlagKey,
  isKnownFlag,
  parseFeatureFlags,
} from './featureFlags';

describe('flagEnabled: off unless the map says true', () => {
  it('reads a flag that is on or off', () => {
    const flags = { new_export: true, old_banner: false };
    expect(flagEnabled(flags, 'new_export')).toBe(true);
    expect(flagEnabled(flags, 'old_banner')).toBe(false);
  });

  it('an unknown flag is off', () => {
    expect(flagEnabled({}, 'new_export')).toBe(false);
    expect(flagEnabled({ other: true }, 'new_export')).toBe(false);
  });

  it('a name inherited from Object.prototype is not a flag', () => {
    expect(flagEnabled({}, 'constructor')).toBe(false);
    expect(flagEnabled({}, 'toString')).toBe(false);
  });
});

describe('parseFeatureFlags', () => {
  it('keeps booleans under valid names and drops the rest, so one bad entry switches nothing else off', () => {
    expect(parseFeatureFlags({ a: true, b_2: false, 'Bad Key': true, c: 'yes', d: 1, e: null }))
      .toEqual({ a: true, b_2: false });
  });

  it('anything that is not a map is no answer', () => {
    expect(parseFeatureFlags(null)).toBeNull();
    expect(parseFeatureFlags([])).toBeNull();
    expect(parseFeatureFlags('on')).toBeNull();
  });

  it('a name longer than the database allows is dropped', () => {
    expect(parseFeatureFlags({ ['a'.repeat(60)]: true, ['a'.repeat(61)]: true }))
      .toEqual({ ['a'.repeat(60)]: true });
  });
});

describe('the registry: the flags this build knows', () => {
  it('every definition has a key the database would store and two translation keys', () => {
    for (const flag of FLAG_DEFINITIONS) {
      expect(isFlagKey(flag.key)).toBe(true);
      expect(flag.label).toMatch(/^admin\.flags\.flag\./);
      expect(flag.description).toBe(`${flag.label}.desc`);
    }
  });

  it('no flag is listed twice', () => {
    expect(new Set(KNOWN_FLAG_KEYS).size).toBe(KNOWN_FLAG_KEYS.length);
  });

  it('isKnownFlag and flagDefinition answer for a listed flag and refuse everything else', () => {
    expect(isKnownFlag('travel_estimator')).toBe(true);
    expect(flagDefinition('travel_estimator')?.label).toBe('admin.flags.flag.travelEstimator');
    expect(isKnownFlag('not_a_flag_of_this_build')).toBe(false);
    expect(flagDefinition('not_a_flag_of_this_build')).toBeNull();
  });

  it('an inherited property is not a known flag', () => {
    // `KNOWN_FLAG_KEYS.includes` cannot read one, which is the point of using
    // it rather than a lookup in an object.
    expect(isKnownFlag('constructor')).toBe(false);
    expect(flagDefinition('toString')).toBeNull();
  });
});

describe('the editor', () => {
  it('draws every known flag, off when the stored map is silent about it', () => {
    const rows = flagsToRows({});
    expect(rows).toEqual(KNOWN_FLAG_KEYS.map(key => ({ key, enabled: false, known: true })));
  });

  it('draws a known flag with its stored value', () => {
    expect(flagsToRows({ travel_estimator: true }))
      .toContainEqual({ key: 'travel_estimator', enabled: true, known: true });
  });

  it('a stored flag this build does not know is drawn too, marked unknown, after the known ones', () => {
    const rows = flagsToRows({ zeta: true, alpha: false, travel_estimator: false });
    expect(rows.filter(row => row.known).map(row => row.key)).toEqual([...KNOWN_FLAG_KEYS]);
    expect(rows.filter(row => !row.known)).toEqual([
      { key: 'alpha', enabled: false, known: false },
      { key: 'zeta', enabled: true, known: false },
    ]);
  });

  it('the order does not depend on the stored map, so a save does not reorder the list', () => {
    const keys = (flags: Record<string, boolean>) => flagsToRows(flags).map(row => row.key);
    expect(keys({ zeta: true, alpha: false })).toEqual(keys({ alpha: false, zeta: true }));
  });

  it('saves the rows back as a map, so an absent known flag is written as an explicit false', () => {
    // Absent and false are the same state, so this changes no behaviour — it
    // leaves the stored document naming what the build knows.
    expect(flagsFromRows(flagsToRows({ zeta: true })))
      .toEqual({ value: { travel_estimator: false, zeta: true } });
  });

  it('a removed unknown row is gone from the saved map, which is the only way out for a stale flag', () => {
    const rows = flagsToRows({ stale_flag: true }).filter(row => row.key !== 'stale_flag');
    expect(flagsFromRows(rows)).toEqual({ value: { travel_estimator: false } });
  });

  it('refuses a name the database would refuse, and two rows with one name', () => {
    expect(flagsFromRows([{ key: 'New Flag', enabled: true, known: false }])).toEqual({ error: 'feature_flags.key' });
    expect(flagsFromRows([{ key: 'x', enabled: true, known: false }, { key: 'x', enabled: false, known: false }]))
      .toEqual({ error: 'feature_flags.key' });
  });

  it('refuses more flags than the database stores', () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({ key: `f${i}`, enabled: false, known: false }));
    expect(flagsFromRows(rows)).toEqual({ error: 'feature_flags' });
    expect(flagsFromRows(rows.slice(0, 100))).toHaveProperty('value');
  });

  it('an empty row list is a valid save: every flag off', () => {
    expect(flagsFromRows([])).toEqual({ value: {} });
  });
});
