import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider, useTranslation } from './LanguageContext';

/** The document's direction follows the language: rtl for Arabic, ltr otherwise. */
const root: { lang: string; dir: string } = { lang: '', dir: '' };
let stored: Record<string, string> = {};

beforeEach(() => {
  root.lang = '';
  root.dir = '';
  stored = {};
  vi.stubGlobal('document', { documentElement: root });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => { stored[k] = v; },
  });
});
afterEach(() => vi.unstubAllGlobals());

let setter: (l: 'de' | 'en' | 'ar') => void = () => {};
const Probe = () => {
  setter = useTranslation().setLanguage;
  return null;
};
const mount = () => {
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(createElement(LanguageProvider, null, createElement(Probe))); });
  return renderer;
};

describe('LanguageProvider and the document direction', () => {
  it('is ltr for German by default', () => {
    mount();
    expect(root).toEqual({ lang: 'de', dir: 'ltr' });
  });

  it('switches to rtl for Arabic and back to ltr for English', () => {
    mount();
    act(() => setter('ar'));
    expect(root).toEqual({ lang: 'ar', dir: 'rtl' });
    expect(stored['ya-language']).toBe('ar');
    act(() => setter('en'));
    expect(root).toEqual({ lang: 'en', dir: 'ltr' });
  });

  it('accepts Arabic from storage', () => {
    stored['ya-language'] = 'ar';
    mount();
    expect(root).toEqual({ lang: 'ar', dir: 'rtl' });
  });

  it('ignores an unknown stored language', () => {
    stored['ya-language'] = 'fr';
    mount();
    expect(root.lang).toBe('de');
  });
});
