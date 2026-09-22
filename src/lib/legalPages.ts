/**
 * The two legal pages, `/impressum` and `/datenschutz` (migration
 * 20260921120000). Pure: the call is in `legalPagesClient.ts`, the page in
 * `pages/LegalPage.tsx`, the document itself in `components/legal/`.
 *
 * ## Nothing here is invented
 *
 * Every fact on either page is one the owner entered under /admin →
 * Einstellungen, in the two keys `legal.impressum` and `legal.privacy`, read
 * through `get_legal_pages()`. A field nobody filled is not rendered, and an
 * Impressum without the provider's name is not an Impressum: the page then says
 * it is not provided yet, rather than print an address with no one it belongs
 * to. The invoice's sender (`seller`) is never read — its name was seeded with
 * the product name as a fallback — so a placeholder can never reach the page.
 *
 * ## German in both languages
 *
 * The Impressum and the privacy policy are German legal documents, on the
 * closed list in `src/i18n/index.ts`: their headings and labels live here,
 * never in the dictionaries. The English UI shows one line saying so.
 */

export type LegalPageKind = 'impressum' | 'privacy';

export const LEGAL_PATHS: Readonly<Record<LegalPageKind, string>> = {
  impressum: '/impressum',
  privacy: '/datenschutz',
};

/** The document's own name, German in both languages. */
export const LEGAL_TITLES: Readonly<Record<LegalPageKind, string>> = {
  impressum: 'Impressum',
  privacy: 'Datenschutzerklärung',
};

/** Which legal page a path is, or null. A trailing slash and the letter case do not matter. */
export function legalPageFor(pathname: string): LegalPageKind | null {
  const path = pathname.toLowerCase().replace(/\/+$/, '');
  if (path === LEGAL_PATHS.impressum) return 'impressum';
  if (path === LEGAL_PATHS.privacy) return 'privacy';
  return null;
}

// ─── The answer ──────────────────────────────────────────────────────────────

/**
 * The fields `legal.impressum` may hold and `get_legal_pages()` publishes, in
 * the order an Impressum reads — and the order the editor asks for them.
 * `src/lib/legalPages.test.ts` compares this list with the migration's, and
 * `tests/rls/legal-pages.sql` pins the database's answer key by key: which
 * fields go public is a data protection decision, not a convenience.
 */
export const IMPRESSUM_FIELDS = [
  'legal_name', 'legal_form',
  'street', 'house_number', 'postal_code', 'city',
  'represented_by',
  'contact_email', 'contact_phone',
  'register_court', 'register_number',
  'vat_id',
  'content_responsible_name', 'content_responsible_address',
] as const;
export type ImpressumField = typeof IMPRESSUM_FIELDS[number];
export type Impressum = Readonly<Record<ImpressumField, string>>;

export interface PrivacyContent {
  /** `YYYY-MM-DD`, the date the text is valid from; null when nothing is published. */
  readonly asOf: string | null;
  readonly paragraphs: readonly string[];
}

export interface LegalPages {
  readonly impressum: Impressum;
  readonly privacy: PrivacyContent;
}

export const NO_PRIVACY_TEXT: PrivacyContent = { asOf: null, paragraphs: [] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The privacy text as the answer carries it, or none at all. It is published
 * whole or not at all: a paragraph that is not text, or a text without its
 * date, means something is broken, and part of a legal text is not the text.
 */
function readPrivacy(value: Record<string, unknown>): PrivacyContent {
  const { as_of: asOf, paragraphs } = value;
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return NO_PRIVACY_TEXT;
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) return NO_PRIVACY_TEXT;
  if (!paragraphs.every(p => typeof p === 'string' && p.trim() !== '')) return NO_PRIVACY_TEXT;
  return { asOf, paragraphs: paragraphs as string[] };
}

/**
 * `get_legal_pages()`'s answer, or null when it is not one. A field the answer
 * does not carry as text reads as unfilled, and so is not rendered.
 */
export function parseLegalPages(data: unknown): LegalPages | null {
  if (!isRecord(data) || !isRecord(data.impressum) || !isRecord(data.privacy)) return null;

  const impressum = {} as Record<ImpressumField, string>;
  for (const field of IMPRESSUM_FIELDS) {
    const text = data.impressum[field];
    impressum[field] = typeof text === 'string' ? text.trim() : '';
  }
  return { impressum, privacy: readPrivacy(data.privacy) };
}

/**
 * The Impressum a stored `legal.impressum` document (or the editor's form)
 * would publish: the fourteen fields, trimmed, '' where absent — the projection
 * `get_legal_pages()` applies, so the editor's preview shows the page.
 */
export function impressumFromDocument(doc: Readonly<Partial<Record<ImpressumField, string>>>): Impressum {
  const impressum = {} as Record<ImpressumField, string>;
  for (const field of IMPRESSUM_FIELDS) impressum[field] = (doc[field] ?? '').trim();
  return impressum;
}

// ─── What the Impressum page renders ─────────────────────────────────────────

export interface ImpressumLine {
  /** Printed before the value, e.g. `Telefon`. */
  readonly label?: string;
  readonly text: string;
  /** `mailto:` or `tel:`, for the two contact lines. */
  readonly href?: string;
}

export interface ImpressumSection {
  readonly heading: string;
  readonly lines: readonly ImpressumLine[];
}

/** Published once the provider is named; everything else hangs off that name. */
export function impressumIsPublished(impressum: Impressum): boolean {
  return impressum.legal_name !== '';
}

/**
 * A number a phone can dial: `+`, then digits. The German trunk prefix written
 * `+49 (0)212 …` is dropped, because dialled after the country code it reaches
 * the wrong number; everything else between the digits is presentation.
 */
export function telephoneHref(text: string): string {
  const international = text.trim().startsWith('+');
  const digits = (international ? text.replace(/\(0\)/g, '') : text).replace(/[^0-9]/g, '');
  return `tel:${international ? '+' : ''}${digits}`;
}

/**
 * The Impressum as sections of lines, leaving out every field nobody filled and
 * every section left empty by that. Nothing when the provider is not named.
 */
export function impressumSections(impressum: Impressum): ImpressumSection[] {
  if (!impressumIsPublished(impressum)) return [];

  const sections: ImpressumSection[] = [];
  const add = (heading: string, lines: (ImpressumLine | null)[]) => {
    const kept = lines.filter((line): line is ImpressumLine => line !== null);
    if (kept.length > 0) sections.push({ heading, lines: kept });
  };
  const line = (text: string, label?: string, href?: string): ImpressumLine | null =>
    text === '' ? null : { text, ...(label ? { label } : {}), ...(href ? { href } : {}) };

  add('Angaben gemäß § 5 DDG', [
    line(impressum.legal_name),
    line(impressum.legal_form, 'Rechtsform'),
    line([impressum.street, impressum.house_number].filter(Boolean).join(' ')),
    line([impressum.postal_code, impressum.city].filter(Boolean).join(' ')),
  ]);
  add('Vertreten durch', [line(impressum.represented_by)]);
  add('Kontakt', [
    line(impressum.contact_phone, 'Telefon', impressum.contact_phone && telephoneHref(impressum.contact_phone)),
    line(impressum.contact_email, 'E-Mail', impressum.contact_email && `mailto:${impressum.contact_email}`),
  ]);
  add('Registereintrag', [
    line(impressum.register_court, 'Registergericht'),
    line(impressum.register_number, 'Registernummer'),
  ]);
  add('Umsatzsteuer-ID', [
    line(impressum.vat_id, 'Umsatzsteuer-Identifikationsnummer gemäß § 27a Umsatzsteuergesetz'),
  ]);
  add('Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV', [
    line(impressum.content_responsible_name),
    line(impressum.content_responsible_address),
  ]);
  return sections;
}

// ─── What the privacy page renders ───────────────────────────────────────────

export function privacyIsPublished(privacy: PrivacyContent): boolean {
  return privacy.asOf !== null && privacy.paragraphs.length > 0;
}

/** `Stand: 21.09.2026` — German in both languages, like the text it dates. */
export function privacyAsOfLine(asOf: string): string {
  const [year, month, day] = asOf.split('-');
  return `Stand: ${day}.${month}.${year}`;
}
