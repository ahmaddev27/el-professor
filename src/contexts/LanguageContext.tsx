import { DirectionProvider } from '@radix-ui/react-direction';
import React, { createContext, useContext, useLayoutEffect, useMemo, useState, useCallback } from 'react';
import {
  Language,
  TranslationKey,
  TranslationVars,
  translate,
  translatePlural,
  textDirection,
} from '../i18n';

const STORAGE_KEY = 'ya-language';
const DEFAULT_LANGUAGE: Language = 'de';

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  /** Translate a key, optionally interpolating `{placeholder}` values. */
  t: (key: TranslationKey, vars?: TranslationVars) => string;
  /** Pick between a singular and plural key by count; `{count}` is provided. */
  tPlural: (
    keys: { one: TranslationKey; other: TranslationKey },
    count: number,
    vars?: TranslationVars,
  ) => string;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: DEFAULT_LANGUAGE,
  setLanguage: () => {},
  t: key => translate(DEFAULT_LANGUAGE, key),
  tPlural: (keys, count) => translatePlural(DEFAULT_LANGUAGE, keys, count),
});

const readStoredLanguage = (): Language => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'de' || stored === 'en' || stored === 'ar') return stored;
  } catch {
    // Private mode or blocked storage — fall through to the default.
  }
  return DEFAULT_LANGUAGE;
};

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(readStoredLanguage);

  // A layout effect, so a stored Arabic choice is right-to-left from the first
  // painted frame instead of flipping one frame after it.
  useLayoutEffect(() => {
    // Keep the document language in step so screen readers and the browser's
    // own translation prompt behave correctly.
    document.documentElement.lang = language;
    // Arabic is right-to-left; the browser mirrors flow, and Tailwind's logical
    // utilities and Radix's DirectionProvider follow this attribute.
    document.documentElement.dir = textDirection(language);
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // Persistence is a convenience; the app works without it.
    }
  }, [language]);

  const setLanguage = useCallback((next: Language) => setLanguageState(next), []);

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      setLanguage,
      t: (key, vars) => translate(language, key, vars),
      tPlural: (keys, count, vars) => translatePlural(language, keys, count, vars),
    }),
    [language, setLanguage],
  );

  // Radix reads direction from this provider, not from the DOM, so Tabs arrow
  // keys, menus, selects and dialogs follow the language. It lives here so every
  // tree that mounts LanguageProvider (the app, the design preview, the harness)
  // gets it.
  return (
    <LanguageContext.Provider value={value}>
      <DirectionProvider dir={textDirection(language)}>{children}</DirectionProvider>
    </LanguageContext.Provider>
  );
};

export const useTranslation = () => useContext(LanguageContext);
