/**
 * Translation core.
 *
 * German is the source language and the fallback. Every key is defined in
 * `de`; `en` is a Partial, so a screen can be translated incrementally without
 * ever showing a raw key to a user — a missing English string renders the
 * German one.
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
 * says in one line that they are German. A
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
 * are kept in both languages. The figures on screen correspond one-to-one with
 * figures on German documents; switching the decimal separator with the UI
 * language would invite transcription errors.
 */

import { de } from './de';
import { en } from './en';

export type Language = 'de' | 'en';

export const LANGUAGES: { code: Language; label: string; flag: string }[] = [
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
];

/** The canonical key set, derived from the German dictionary. */
export type TranslationKey = keyof typeof de;

/** English may lag behind German; missing keys fall back. */
export type PartialDictionary = Partial<Record<TranslationKey, string>>;

const DICTIONARIES: Record<Language, PartialDictionary> = {
  de,
  en: en as PartialDictionary,
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
 * needed. A language with a different rule would need one.
 */
export const translatePlural = (
  language: Language,
  keys: { one: TranslationKey; other: TranslationKey },
  count: number,
  vars?: TranslationVars,
): string =>
  translate(language, count === 1 ? keys.one : keys.other, { count, ...vars });

export { de, en };
