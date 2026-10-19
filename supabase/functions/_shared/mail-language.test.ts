import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAIL_LANGUAGE,
  MAIL_LANGUAGES,
  isRtl,
  ltrRunHtml,
  ltrRunText,
  nameRunHtml,
  resolveMailLanguage,
} from './mail-language.ts';

describe('resolveMailLanguage', () => {
  it("defaults to English, the owner's decision", () => {
    expect(DEFAULT_MAIL_LANGUAGE).toBe('en');
  });

  it('keeps the three languages we write', () => {
    for (const code of MAIL_LANGUAGES) expect(resolveMailLanguage(code)).toBe(code);
  });

  it('is forgiving about case and whitespace in a stored value', () => {
    expect(resolveMailLanguage(' AR ')).toBe('ar');
    expect(resolveMailLanguage('De')).toBe('de');
  });

  it.each([undefined, null, '', '  ', 'fr', 'ar-EG', 'deutsch', 7, {}, []])(
    'falls back to English for %j, never German and never a throw',
    (value) => {
      expect(resolveMailLanguage(value)).toBe('en');
    },
  );
});

describe('bidirectional helpers', () => {
  it('only Arabic is right-to-left', () => {
    expect(MAIL_LANGUAGES.filter(isRtl)).toEqual(['ar']);
  });

  it('leave left-to-right text byte for byte alone', () => {
    expect(ltrRunHtml('506,95 €', 'en')).toBe('506,95 €');
    expect(ltrRunHtml('506,95 €', 'de')).toBe('506,95 €');
    expect(nameRunHtml('Y&amp;A', 'de')).toBe('Y&amp;A');
    expect(ltrRunText('506,95 €', 'en')).toBe('506,95 €');
  });

  it('isolate a figure inside Arabic', () => {
    expect(ltrRunHtml('506,95 €', 'ar')).toContain('dir="ltr"');
    expect(ltrRunText('506,95 €', 'ar')).toBe('⁦506,95 €⁩');
  });
});
