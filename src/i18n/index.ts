/**
 * Translation core.
 *
 * German is the source language and the fallback. Every key is defined in
 * `de`; `en` is a Partial, so a screen can be translated incrementally without
 * ever showing a raw key to a user — a missing English string renders the
 * German one. `ar` (Arabic, right-to-left, added 27.11.2026) is a Partial in the
 * same way and falls back to German key by key.
 *
 * ## What is deliberately NOT translated
 *
 * **Generated documents.** Stundennachweis PDFs and the Fahrtenbuch XLSX go to
 * the Steuerberater and to German authorities. Their labels — Lohnart names,
 * Feiertagszuschlag, column headers — are statutory German text. The Fahrtenbuch
 * 'original' export mode additionally has to reproduce the imported sheet's
 * headers byte for byte. None of that text belongs in these dictionaries; it
 * stays hard-coded in the export modules.
 *
 * The list is closed, and it is shorter than it looks: the Stundennachweis PDF,
 * the Fahrtenbuch XLSX, the Trinkgeld-Quittung, the Gehaltsquittung (its text
 * is built in utils/salaryCashReceiptDocument.ts), the Mietwagenauftrag, and the
 * two legal pages — the Impressum and the Datenschutzerklärung, German legal
 * documents whose headings and labels live in lib/legalPages.ts; the English UI
 * says in one line that they are German (the Arabic UI says it too). A
 * `exportTableToExcel(...)` dump of vehicles, drivers, users, Fixkosten, the
 * Bargeldbestand or Werkstatt checks is **not** one of them — it is a
 * convenience export of an operational list, it satisfies no statutory form,
 * and its headers follow the UI language like any other label. Two independent
 * readings of this file disagreed on that point, so it is settled here rather
 * than per screen: if the artefact has a statutory shape, hard-code German in
 * the export module; otherwise translate it.
 *
 * **Domain vocabulary.** Stundennachweis, Fahrtenbuch, Abrechnung, Beleg,
 * Werkstatt, Lohnart, Bundesland and Gehaltsquittung stay German in the English
 * UI. Operators use these words daily and they must match what the documents
 * say, so the English dictionary names the document Gehaltsquittung and writes
 * the sentence around it in English, as it already does for the Trinkgeld
 * Quittung and the Mietwagenauftrag.
 *
 * That list is closed too. Trinkgeld joins it only because it is the subject of
 * the Quittung. **Kennzeichen, Fixkosten, Personalnummer and Inhaber are not on
 * it** — they are ordinary German words with exact English equivalents that
 * appear on no statutory form, and leaving them untranslated makes the English
 * UI read like a half-finished job rather than a considered choice.
 *
 * **Money and date formatting.** German conventions (decimal comma, DD.MM.YYYY)
 * and Latin digits are kept in every language, Arabic included (owner,
 * 27.11.2026: `41,47 €`, `27.11.2026`, never Arabic-Indic digits). The figures
 * on screen correspond one-to-one with figures on German documents; switching
 * the decimal separator or the digits with the UI language would invite
 * transcription errors. Only WORDS follow the language — weekday and month
 * names — and they go through `wordLocale()` below.
 *
 * **Arabic** is a full UI language, right-to-left (`<html dir="rtl">`, set by
 * LanguageContext). German domain terms appear as Arabic with the German in
 * brackets at their first mention in a string, e.g. "كشف الساعات (Stundennachweis)",
 * so the screen and the paperwork still agree. Anything a second consumer reads
 * stays German, as in English.
 */

import { de } from './de';
import { en } from './en';
import { ar } from './ar';

export type Language = 'de' | 'en' | 'ar';

export const LANGUAGES: { code: Language; label: string; flag: string }[] = [
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
  // Arabic is spoken in many countries, so no flag: the letter ع stands in.
  { code: 'ar', label: 'العربية', flag: 'ع' },
];

/** Whether a language is written right to left. */
export const isRtl = (language: Language): boolean => language === 'ar';

/** The `dir` attribute value for a language. */
export const textDirection = (language: Language): 'rtl' | 'ltr' => (isRtl(language) ? 'rtl' : 'ltr');

/**
 * The Intl locale for formatting WORDS (weekday and month names) in the UI
 * language. Never use it for a number, an amount or a date written in digits:
 * those stay German whatever the language. `-u-nu-latn` keeps the digits Latin
 * for Arabic, so even a month label with a year carries no Arabic-Indic digit.
 */
export const wordLocale = (language: Language): string =>
  language === 'en' ? 'en-GB' : language === 'ar' ? 'ar-u-nu-latn' : 'de-DE';

/** The canonical key set, derived from the German dictionary. */
export type TranslationKey = keyof typeof de;

/** English and Arabic may lag behind German; missing keys fall back. */
export type PartialDictionary = Partial<Record<TranslationKey, string>>;

const DICTIONARIES: Record<Language, PartialDictionary> = {
  de,
  en: en as PartialDictionary,
  ar,
};

/** Values substituted into `{placeholder}` slots. */
export type TranslationVars = Record<string, string | number>;

const interpolate = (template: string, vars?: TranslationVars): string => {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
};

/**
 * Resolve a key for a language, falling back to German and finally to the key
 * itself. The key is only ever returned if it is missing from German too, which
 * TypeScript prevents for literal keys.
 */
export const translate = (
  language: Language,
  key: TranslationKey,
  vars?: TranslationVars,
): string => {
  const template = DICTIONARIES[language]?.[key] ?? de[key] ?? key;
  return interpolate(template, vars);
};

/**
 * Pick a singular or plural key by count and interpolate `{count}`.
 * German and English share the same one/other rule, so no plural engine is
 * needed. Arabic has six plural categories, but we keep the one/other key pair
 * on purpose: its `.other` strings are phrased to read correctly for any count
 * (a numeral and a singular noun, or a form that needs no agreement). A
 * language that needed more than two forms would need an engine.
 */
export const translatePlural = (
  language: Language,
  keys: { one: TranslationKey; other: TranslationKey },
  count: number,
  vars?: TranslationVars,
): string =>
  translate(language, count === 1 ? keys.one : keys.other, { count, ...vars });

export { de, en, ar };
