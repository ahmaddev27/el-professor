import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS_TAB, SETTINGS_TABS, parseSettingsTab } from './settingsTabs';

describe('parseSettingsTab', () => {
  it('accepts every tab it lists', () => {
    for (const tab of SETTINGS_TABS) expect(parseSettingsTab(tab)).toBe(tab);
  });

  it('falls back to the first tab when absent', () => {
    expect(parseSettingsTab(null)).toBe(DEFAULT_SETTINGS_TAB);
    expect(parseSettingsTab(undefined)).toBe(DEFAULT_SETTINGS_TAB);
    expect(parseSettingsTab('')).toBe(DEFAULT_SETTINGS_TAB);
  });

  it('falls back for an unknown value and is case- and space-exact', () => {
    expect(parseSettingsTab('billing')).toBe('company');
    expect(parseSettingsTab('LEGAL')).toBe('company');
    expect(parseSettingsTab(' legal')).toBe('company');
  });

  it('falls back for hostile values, including object keys', () => {
    const hostile = [
      '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'length',
      '<script>alert(1)</script>', '../../admin', 'legal,operations', 'legal\u0000',
      'x'.repeat(100_000),
    ];
    for (const value of hostile) expect(parseSettingsTab(value)).toBe('company');
  });
});
