import { describe, expect, it } from 'vitest';
import { ar } from './ar';
import { de } from './de';
import { LANGUAGES, isRtl, textDirection, wordLocale, translate, translatePlural } from './index';

/**
 * The Arabic dictionary is held to the rules the English one lives by, and to
 * one more: it must be complete. The coverage test is strict on purpose and is
 * RED until the translations are imported with
 * `node scripts/i18n-merge.mjs --ar-import <dir>`; that is the checklist.
 */
const ARABIC_INDIC_DIGIT = /[٠-٩۰-۹]/;
const slots = (s: string): string => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

const deRecord = de as Record<string, string>;
const arRecord = ar as Record<string, string | undefined>;
const arEntries = Object.entries(arRecord) as [string, string][];

describe('the Arabic dictionary', () => {
  it('has no key that German lacks', () => {
    expect(arEntries.map(([key]) => key).filter(key => !(key in deRecord))).toEqual([]);
  });

  it('takes the same placeholders as German', () => {
    const mismatched = arEntries.filter(([key, value]) => slots(value) !== slots(deRecord[key] ?? ''));
    expect(mismatched.map(([key]) => key)).toEqual([]);
  });

  it('has no empty value', () => {
    expect(arEntries.filter(([, value]) => !value || !value.trim()).map(([key]) => key)).toEqual([]);
  });

  it('writes figures with Latin digits only', () => {
    expect(arEntries.filter(([, value]) => ARABIC_INDIC_DIGIT.test(value)).map(([key]) => key)).toEqual([]);
  });

  // STRICT, and expected to fail until the translations are imported.
  it('covers every German key', () => {
    const missing = Object.keys(deRecord).filter(key => arRecord[key] === undefined);
    expect(missing.slice(0, 20)).toEqual([]);
    expect(missing).toHaveLength(0);
  });
});

describe('the language table', () => {
  it('offers Arabic in its own script, without a flag', () => {
    const entry = LANGUAGES.find(l => l.code === 'ar');
    expect(entry?.label).toBe('العربية');
    expect(entry?.flag).toBe('ع');
  });

  it('is right-to-left for Arabic only', () => {
    expect(['de', 'en', 'ar'].map(code => textDirection(code as 'de'))).toEqual(['ltr', 'ltr', 'rtl']);
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('en')).toBe(false);
  });

  it('formats words in a locale that keeps the digits Latin', () => {
    expect(wordLocale('de')).toBe('de-DE');
    expect(wordLocale('en')).toBe('en-GB');
    const month = new Intl.DateTimeFormat(wordLocale('ar'), { month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(Date.UTC(2026, 10, 1));
    expect(month).toMatch(/2026/);
    expect(month).not.toMatch(ARABIC_INDIC_DIGIT);
  });

  it('falls back to German for a key Arabic does not have', () => {
    const key = Object.keys(deRecord).find(k => arRecord[k] === undefined);
    if (!key) return;
    expect(translate('ar', key as never)).toBe(deRecord[key]);
    expect(translatePlural('ar', { one: key as never, other: key as never }, 2)).toBe(deRecord[key]);
  });
});
