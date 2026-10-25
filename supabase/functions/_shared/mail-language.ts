/**
 * The language a driver's mail is written in.
 *
 * Pure: no Deno, `npm:` or `jsr:` import, so vitest runs it in Node.
 *
 * Three languages, one default, and the default is the owner's decision of
 * 19.10.2026: **English**, even though the product's UI falls back to German. A
 * driver whose language is missing, empty, mistyped or one we do not write gets
 * English, never German by accident and never a crash. The database says the same
 * (`drivers.preferred_language` is NOT NULL DEFAULT 'en' with a CHECK), so this
 * fallback is the second wall: it covers a row read before the migration, a
 * response that omitted the column, and a future language added to the table
 * before it is added here.
 *
 * Only the prose is translated. Money (`506,95 €`), dates (`DD.MM.YYYY`) and the
 * driver's and company's names are never touched, because the figures map
 * one-to-one onto German payroll paperwork.
 */

export const MAIL_LANGUAGES = ['ar', 'en', 'de'] as const;

export type MailLanguage = (typeof MAIL_LANGUAGES)[number];

export const DEFAULT_MAIL_LANGUAGE: MailLanguage = 'en';

export function isMailLanguage(value: unknown): value is MailLanguage {
  return MAIL_LANGUAGES.some((code) => code === value);
}

/** The language to write in for whatever the database (or a caller) handed over. */
export function resolveMailLanguage(value: unknown): MailLanguage {
  if (typeof value !== 'string') return DEFAULT_MAIL_LANGUAGE;
  const code = value.trim().toLowerCase();
  return isMailLanguage(code) ? code : DEFAULT_MAIL_LANGUAGE;
}

export function isRtl(language: MailLanguage): boolean {
  return language === 'ar';
}

// ─── Bidirectional text ──────────────────────────────────────────────────────
//
// In a right-to-left paragraph a run of numbers and Latin text (`506,95 €`,
// `31.08.2026 – 06.09.2026`, a company called "Y&A Mobility") is reordered by the
// bidi algorithm: a trailing `€` jumps to the other end of the amount and a date
// range reads backwards. Each such run is therefore isolated and given its own
// direction. A left-to-right language gets the text back unchanged, so the
// English and German bytes are what they were.

const LRI = '⁦'; // left-to-right isolate
const FSI = '⁨'; // first-strong isolate
const PDI = '⁩'; // pop directional isolate

/** HTML: an amount, a date range or a time, kept left-to-right inside an Arabic line. */
export function ltrRunHtml(escaped: string, language: MailLanguage): string {
  return isRtl(language) ? `<span dir="ltr" style="unicode-bidi:isolate;">${escaped}</span>` : escaped;
}

/** HTML: a name whose own direction is unknown (a driver, a company). */
export function nameRunHtml(escaped: string, language: MailLanguage): string {
  return isRtl(language) ? `<bdi>${escaped}</bdi>` : escaped;
}

/** Plain text: the same two, with Unicode isolates instead of markup. */
export function ltrRunText(text: string, language: MailLanguage): string {
  return isRtl(language) ? `${LRI}${text}${PDI}` : text;
}

export function nameRunText(text: string, language: MailLanguage): string {
  return isRtl(language) ? `${FSI}${text}${PDI}` : text;
}
