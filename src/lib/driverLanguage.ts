/**
 * The language a driver's e-mails are written in (`drivers.preferred_language`).
 *
 * Three languages and one default, **English**: the owner's decision of
 * 19.10.2026, deliberately not the UI's German fallback. The list is held in
 * three places that must agree (this file, `MAIL_LANGUAGES` in
 * `supabase/functions/_shared/mail-language.ts`, and the column's CHECK), and
 * `driverLanguage.test.ts` reads the other two and fails when they part.
 *
 * This is the language of the driver's *mail*, not of the screen the operator
 * is looking at, so the option labels below are each language's own name and are
 * not translated: an operator choosing Arabic for a driver must be able to find
 * it whatever the UI language is.
 */

export const DRIVER_LANGUAGES = ['ar', 'en', 'de'] as const;

export type DriverLanguage = (typeof DRIVER_LANGUAGES)[number];

export const DEFAULT_DRIVER_LANGUAGE: DriverLanguage = 'en';

/** Each language written in itself. */
export const DRIVER_LANGUAGE_NAMES: Record<DriverLanguage, string> = {
  ar: 'العربية',
  en: 'English',
  de: 'Deutsch',
};

export function isDriverLanguage(value: unknown): value is DriverLanguage {
  return DRIVER_LANGUAGES.some(code => code === value);
}

/** Whatever a row or a form holds, as a language we write: English when unknown. */
export function toDriverLanguage(value: unknown): DriverLanguage {
  return isDriverLanguage(value) ? value : DEFAULT_DRIVER_LANGUAGE;
}
