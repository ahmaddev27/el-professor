/**
 * The legal pages: what `get_legal_pages()` publishes, how the page reads the
 * answer, and what it renders. The migration's own text is the fixture for the
 * field lists, so the page and the database cannot come to disagree about
 * which facts are public.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  IMPRESSUM_FIELDS,
  NO_PRIVACY_TEXT,
  impressumIsPublished,
  impressumSections,
  legalPageFor,
  parseLegalPages,
  privacyAsOfLine,
  privacyIsPublished,
  telephoneHref,
  type Impressum,
} from './legalPages';
import { SELLER_FIELDS, SELLER_IMPRESSUM_FIELDS } from './platformSettings';

const MIGRATION = readFileSync(
  new URL('../../supabase/migrations/20260921120000_legal_pages.sql', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

/** The quoted names of one `c_… CONSTANT text[] := ARRAY[…]` inside one function of the migration. */
function constantList(functionName: string, constant: string): string[] {
  const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION ${functionName}(`);
  if (start < 0) throw new Error(`the migration does not define ${functionName}`);
  const body = MIGRATION.slice(start);
  const match = body.match(new RegExp(`${constant}\\s+CONSTANT text\\[\\]\\s*:=\\s*ARRAY\\[([\\s\\S]*?)\\]`));
  if (!match) throw new Error(`${functionName} has no ${constant}`);
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
}

const EMPTY: Impressum = Object.fromEntries(IMPRESSUM_FIELDS.map(field => [field, ''])) as Impressum;

const FILLED: Impressum = {
  legal_name: 'Muster Mobility GmbH',
  legal_form: 'GmbH',
  street: 'Hauptstraße',
  house_number: '12',
  postal_code: '42651',
  city: 'Solingen',
  represented_by: 'Erika Muster (Geschäftsführerin)',
  contact_email: 'info@example.com',
  contact_phone: '+49 (0)212 555-0101',
  register_court: 'Amtsgericht Wuppertal',
  register_number: 'HRB 12345',
  vat_id: 'DE123456789',
  content_responsible_name: 'Erika Muster',
  content_responsible_address: 'Hauptstraße 12, 42651 Solingen',
};

describe('what is public', () => {
  it('is exactly the list the migration publishes, in the same order', () => {
    expect([...IMPRESSUM_FIELDS]).toEqual(constantList('public.get_legal_pages', 'c_public_fields'));
  });

  it('never includes the bank details, the tax number or the invoice sender name', () => {
    for (const field of ['name', 'tax_number', 'bank_name', 'iban', 'bic', 'account_holder']) {
      expect(IMPRESSUM_FIELDS as readonly string[]).not.toContain(field);
    }
  });

  it('is drawn from the seller document and nothing else', () => {
    const seller = new Set<string>([...SELLER_FIELDS, ...SELLER_IMPRESSUM_FIELDS]);
    for (const field of IMPRESSUM_FIELDS) expect(seller.has(field)).toBe(true);
  });

  it('the seller form knows the same nine optional fields the database accepts', () => {
    expect([...SELLER_IMPRESSUM_FIELDS].sort())
      .toEqual(constantList('app_private.platform_settings_problem_legal', 'c_impressum_fields'));
  });
});

describe('legalPageFor', () => {
  it('knows the two paths, with or without a trailing slash, in any case', () => {
    expect(legalPageFor('/impressum')).toBe('impressum');
    expect(legalPageFor('/impressum/')).toBe('impressum');
    expect(legalPageFor('/Impressum')).toBe('impressum');
    expect(legalPageFor('/datenschutz')).toBe('privacy');
    expect(legalPageFor('/datenschutz/')).toBe('privacy');
  });

  it('is null for everything else, a path that merely starts the same way included', () => {
    for (const path of ['/', '', '/login', '/impressum-alt', '/datenschutz/x', '/admin/impressum']) {
      expect(legalPageFor(path)).toBeNull();
    }
  });
});

describe('parseLegalPages', () => {
  const answer = (impressum: Record<string, unknown>, privacy: Record<string, unknown>) => ({ impressum, privacy });

  it('reads the database answer field for field, trimmed', () => {
    const pages = parseLegalPages(answer(
      { ...FILLED, legal_form: '  GmbH ' },
      { as_of: '2026-09-21', paragraphs: ['Erster Absatz.', 'Zweiter\nAbsatz.'] },
    ));
    expect(pages).toEqual({
      impressum: FILLED,
      privacy: { asOf: '2026-09-21', paragraphs: ['Erster Absatz.', 'Zweiter\nAbsatz.'] },
    });
  });

  it('reads the empty answer as nothing published', () => {
    const pages = parseLegalPages(answer(EMPTY, { as_of: null, paragraphs: [] }));
    expect(pages?.impressum).toEqual(EMPTY);
    expect(pages?.privacy).toEqual(NO_PRIVACY_TEXT);
  });

  it('treats a field that is missing or not text as unfilled, and ignores a field it does not know', () => {
    const pages = parseLegalPages(answer(
      { legal_name: 'Muster GmbH', city: 42, iban: 'DE02 1203', unknown: 'x' },
      { as_of: null, paragraphs: [] },
    ));
    expect(pages?.impressum.legal_name).toBe('Muster GmbH');
    expect(pages?.impressum.city).toBe('');
    expect(pages?.impressum.street).toBe('');
    expect(Object.keys(pages!.impressum)).toEqual([...IMPRESSUM_FIELDS]);
  });

  it('publishes a privacy text whole or not at all', () => {
    const read = (privacy: Record<string, unknown>) => parseLegalPages(answer(EMPTY, privacy))?.privacy;
    expect(read({ as_of: '2026-09-21', paragraphs: ['Text.', 42] })).toEqual(NO_PRIVACY_TEXT);
    expect(read({ as_of: '2026-09-21', paragraphs: ['Text.', '  '] })).toEqual(NO_PRIVACY_TEXT);
    expect(read({ as_of: null, paragraphs: ['Text.'] })).toEqual(NO_PRIVACY_TEXT);
    expect(read({ as_of: '21.09.2026', paragraphs: ['Text.'] })).toEqual(NO_PRIVACY_TEXT);
    expect(read({ as_of: '2026-09-21', paragraphs: 'Text.' })).toEqual(NO_PRIVACY_TEXT);
  });

  it('is null for anything that is not the answer', () => {
    expect(parseLegalPages(null)).toBeNull();
    expect(parseLegalPages([])).toBeNull();
    expect(parseLegalPages({ impressum: EMPTY })).toBeNull();
    expect(parseLegalPages({ impressum: [], privacy: {} })).toBeNull();
  });
});

describe('the Impressum as rendered', () => {
  it('renders nothing while the provider is not named — not even an address filled for the invoices', () => {
    const withAddress = { ...EMPTY, street: 'Hauptstraße', house_number: '12', postal_code: '42651', city: 'Solingen' };
    expect(impressumIsPublished(withAddress)).toBe(false);
    expect(impressumSections(withAddress)).toEqual([]);
    expect(impressumSections(EMPTY)).toEqual([]);
  });

  it('renders every section of a complete Impressum, in the order an Impressum reads', () => {
    const sections = impressumSections(FILLED);
    expect(sections.map(s => s.heading)).toEqual([
      'Angaben gemäß § 5 DDG',
      'Vertreten durch',
      'Kontakt',
      'Registereintrag',
      'Umsatzsteuer-ID',
      'Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV',
    ]);
    expect(sections[0].lines).toEqual([
      { text: 'Muster Mobility GmbH' },
      { label: 'Rechtsform', text: 'GmbH' },
      { text: 'Hauptstraße 12' },
      { text: '42651 Solingen' },
    ]);
    expect(sections[2].lines).toEqual([
      { label: 'Telefon', text: '+49 (0)212 555-0101', href: 'tel:+492125550101' },
      { label: 'E-Mail', text: 'info@example.com', href: 'mailto:info@example.com' },
    ]);
    expect(sections[4].lines).toEqual([
      { label: 'Umsatzsteuer-Identifikationsnummer gemäß § 27a Umsatzsteuergesetz', text: 'DE123456789' },
    ]);
  });

  it('leaves out every field nobody filled, and every section that leaves empty', () => {
    const sections = impressumSections({ ...EMPTY, legal_name: 'Erika Muster', city: 'Solingen', contact_email: 'info@example.com' });
    expect(sections).toEqual([
      { heading: 'Angaben gemäß § 5 DDG', lines: [{ text: 'Erika Muster' }, { text: 'Solingen' }] },
      { heading: 'Kontakt', lines: [{ label: 'E-Mail', text: 'info@example.com', href: 'mailto:info@example.com' }] },
    ]);
    // Not one line anywhere is empty or carries a placeholder.
    for (const section of impressumSections({ ...EMPTY, legal_name: 'X' })) {
      for (const line of section.lines) expect(line.text.trim()).not.toBe('');
    }
  });

  it('joins a street without a number, and a town without a postcode, without stray spaces', () => {
    const [provider] = impressumSections({ ...EMPTY, legal_name: 'X', street: 'Hauptstraße', city: 'Solingen' });
    expect(provider.lines).toEqual([{ text: 'X' }, { text: 'Hauptstraße' }, { text: 'Solingen' }]);
  });
});

describe('telephoneHref', () => {
  it('dials the digits, keeping an international plus and dropping the trunk prefix after it', () => {
    expect(telephoneHref('+49 (0)212 555-0101')).toBe('tel:+492125550101');
    expect(telephoneHref('0212 / 555 01 01')).toBe('tel:02125550101');
    expect(telephoneHref('(0212) 555-0101')).toBe('tel:02125550101');
  });
});

describe('the privacy text as rendered', () => {
  it('is published only with its paragraphs and its date', () => {
    expect(privacyIsPublished(NO_PRIVACY_TEXT)).toBe(false);
    expect(privacyIsPublished({ asOf: '2026-09-21', paragraphs: ['Text.'] })).toBe(true);
  });

  it('dates it the German way, in both languages', () => {
    expect(privacyAsOfLine('2026-09-21')).toBe('Stand: 21.09.2026');
  });
});
