/**
 * Feature flags (plan 3.11). The one rule that matters: a flag the map does not
 * name is off — unknown, malformed or missing alike — so a screen guarded by a
 * flag stays shut until somebody switches it on.
 */
import { describe, expect, it } from 'vitest';
import { flagEnabled, flagsFromRows, flagsToRows, parseFeatureFlags } from './featureFlags';

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

describe('the editor', () => {
  it('shows the flags sorted by name and saves them back as a map', () => {
    const rows = flagsToRows({ zeta: true, alpha: false });
    expect(rows).toEqual([{ key: 'alpha', enabled: false }, { key: 'zeta', enabled: true }]);
    expect(flagsFromRows(rows)).toEqual({ value: { alpha: false, zeta: true } });
  });

  it('refuses a name the database would refuse, and two rows with one name', () => {
    expect(flagsFromRows([{ key: 'New Flag', enabled: true }])).toEqual({ error: 'feature_flags.key' });
    expect(flagsFromRows([{ key: 'x', enabled: true }, { key: 'x', enabled: false }]))
      .toEqual({ error: 'feature_flags.key' });
  });

  it('refuses more flags than the database stores', () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({ key: `f${i}`, enabled: false }));
    expect(flagsFromRows(rows)).toEqual({ error: 'feature_flags' });
    expect(flagsFromRows(rows.slice(0, 100))).toHaveProperty('value');
  });

  it('an empty map is a valid save: every flag off', () => {
    expect(flagsFromRows([])).toEqual({ value: {} });
  });
});
