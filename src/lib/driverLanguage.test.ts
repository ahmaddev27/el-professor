import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DRIVER_LANGUAGE,
  DRIVER_LANGUAGES,
  DRIVER_LANGUAGE_NAMES,
  toDriverLanguage,
} from './driverLanguage';
import { mapDriverRow } from './driverRow';
import { DEFAULT_MAIL_LANGUAGE, MAIL_LANGUAGES } from '../../supabase/functions/_shared/mail-language';

const ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

/** The CHECK of the newest migration that names the column. */
function migrationLanguages(): string[] {
  const dir = path.join(ROOT, 'supabase/migrations');
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort().reverse();
  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), 'utf8');
    const check = /CHECK\s*\(\s*preferred_language\s+IN\s*\(([^)]*)\)\s*\)/.exec(sql);
    if (check) return [...check[1].matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  }
  throw new Error('no migration defines the preferred_language CHECK');
}

describe('the three lists of driver languages', () => {
  it('are the same: the UI, the mail and the column', () => {
    expect([...DRIVER_LANGUAGES].sort()).toEqual([...MAIL_LANGUAGES].sort());
    expect(migrationLanguages().sort()).toEqual([...DRIVER_LANGUAGES].sort());
  });

  it('default to English everywhere, the owner\'s decision', () => {
    expect(DEFAULT_DRIVER_LANGUAGE).toBe('en');
    expect(DEFAULT_MAIL_LANGUAGE).toBe('en');
    expect(read('supabase/migrations/20261019100000_driver_preferred_language.sql'))
      .toMatch(/preferred_language text NOT NULL DEFAULT 'en'/);
  });

  it('name each language in itself', () => {
    expect(Object.keys(DRIVER_LANGUAGE_NAMES).sort()).toEqual([...DRIVER_LANGUAGES].sort());
    expect(DRIVER_LANGUAGE_NAMES.ar).toBe('العربية');
  });
});

describe('toDriverLanguage / mapDriverRow', () => {
  it('falls back to English for anything unknown', () => {
    for (const value of [undefined, null, '', 'fr', 3]) expect(toDriverLanguage(value)).toBe('en');
    expect(toDriverLanguage('ar')).toBe('ar');
  });

  it('carries the stored language onto the driver, English when the row has none', () => {
    const base = { id: '1', name: 'A', salary_ratio: 0.5 };
    expect(mapDriverRow({ ...base, preferred_language: 'de' }).preferred_language).toBe('de');
    expect(mapDriverRow(base).preferred_language).toBe('en');
  });
});

describe('the mail path reads the column', () => {
  it('send-document selects it and resolves it before rendering', () => {
    const source = read('supabase/functions/send-document/index.ts');
    expect(source).toMatch(/\.select\("id, name, email, preferred_language"\)/);
    expect(source).toMatch(/language: resolveMailLanguage\(driver\.preferred_language\)/);
  });

  it('the scheduled job reads it for every driver mail and every reminder', () => {
    const source = read('supabase/functions/_shared/abrechnung-delivery.ts');
    expect(source).toMatch(/\.select\('id, preferred_language'\)/);
    expect((source.match(/language: resolveMailLanguage\(languages\.get\(target\.driverId\)\)/g) ?? []).length)
      .toBe(2);
  });

  it('every renderer of a driver mail demands a language', () => {
    const source = read('supabase/functions/_shared/abrechnung-mail.ts');
    for (const name of ['AbrechnungMailInput', 'ReminderMailInput']) {
      const start = source.indexOf(`export interface ${name} {`);
      const block = source.slice(start, source.indexOf('\n}', start));
      expect(start, name).toBeGreaterThanOrEqual(0);
      expect(block, name).toContain('\n  language: MailLanguage;');
    }
  });
});
