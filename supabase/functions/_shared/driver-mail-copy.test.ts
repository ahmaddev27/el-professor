import { describe, expect, it } from 'vitest';
import { DRIVER_MAIL_COPY, fillTemplate, localizePeriodLabel, tokensOf } from './driver-mail-copy.ts';
import { MAIL_LANGUAGES } from './mail-language.ts';

/** Every sentence of a table, with the path that names it. */
function sentences(copy: unknown, path = ''): Array<[string, string]> {
  if (typeof copy === 'string') return [[path, copy]];
  if (Array.isArray(copy)) return copy.flatMap((v, i) => sentences(v, `${path}[${i}]`));
  return Object.entries(copy as Record<string, unknown>)
    .flatMap(([k, v]) => sentences(v, path ? `${path}.${k}` : k));
}

describe('the copy tables', () => {
  it('have a table for every language', () => {
    expect(Object.keys(DRIVER_MAIL_COPY).sort()).toEqual([...MAIL_LANGUAGES].sort());
  });

  it('name the same sentences, and the same {tokens} in each, as German', () => {
    const de = sentences(DRIVER_MAIL_COPY.de);
    for (const code of MAIL_LANGUAGES) {
      const other = new Map(sentences(DRIVER_MAIL_COPY[code]));
      expect([...other.keys()].sort()).toEqual(de.map(([k]) => k).sort());
      for (const [path, template] of de) {
        expect(tokensOf(other.get(path) ?? ''), `${code} ${path}`).toEqual(tokensOf(template));
      }
    }
  });

  it('leave no sentence empty or copied from the German', () => {
    const de = new Map(sentences(DRIVER_MAIL_COPY.de));
    for (const code of ['en', 'ar', 'tr', 'ru'] as const) {
      for (const [path, text] of sentences(DRIVER_MAIL_COPY[code])) {
        expect(text.trim(), `${code} ${path}`).not.toBe('');
        // A bare time of day is the same in every language but German.
        if (path !== 'reminder.clock') expect(text, `${code} ${path}`).not.toBe(de.get(path));
      }
    }
  });

  it('no language but German leaks German words into a driver mail', () => {
    for (const code of ['en', 'ar', 'tr', 'ru'] as const) {
      for (const [path, text] of sentences(DRIVER_MAIL_COPY[code])) {
        expect(text, `${code} ${path}`).not.toMatch(/\b(Abrechnung|Guthaben|Woche|Uhr|Hallo|Belege|Bargeld)\b/);
      }
    }
  });
});

/**
 * The owner's correction of 02.11.2026: the reminder asks a driver to upload
 * receipts, and for nothing else. No Fahrtenbuch and no cash, in any language.
 */
describe('the reminder asks for receipts and nothing else', () => {
  const RECEIPT: Record<(typeof MAIL_LANGUAGES)[number], RegExp> = {
    de: /Belege/, en: /receipts/, ar: /إيصالات/, tr: /fiş/, ru: /чеки/,
  };
  const FORBIDDEN: Record<(typeof MAIL_LANGUAGES)[number], RegExp> = {
    de: /Fahrtenbuch|Bargeld|Barbeleg|abzugeben/,
    en: /Fahrtenbuch|\bcash\b|hand (it )?in/,
    ar: /Fahrtenbuch|نقد|تسلّم|سلّمت/,
    tr: /Fahrtenbuch|nakit|teslim/i,
    ru: /Fahrtenbuch|наличн|сдат|сдач/i,
  };

  it.each(MAIL_LANGUAGES)('%s: the ask and the way out both name receipts only', (code) => {
    const { handIn, ignore } = DRIVER_MAIL_COPY[code].reminder;
    for (const text of [handIn, ignore]) {
      expect(text, code).toMatch(RECEIPT[code]);
      expect(text, code).not.toMatch(FORBIDDEN[code]);
    }
  });
});

describe('fillTemplate', () => {
  it('escapes the literal parts and trusts the values', () => {
    const out = fillTemplate('a <b> {x}', { x: '<i>' }, (t) => t.replace(/</g, '&lt;'));
    expect(out).toBe('a &lt;b> <i>');
  });

  it('throws on a hole with no value rather than mailing a placeholder', () => {
    expect(() => fillTemplate('hi {name}', {}, (t) => t)).toThrow(/name/);
  });
});

describe('localizePeriodLabel', () => {
  it('leaves German exactly alone', () => {
    expect(localizePeriodLabel('Woche 5 - August 2026', 'de')).toBe('Woche 5 - August 2026');
  });

  it('translates the week word and the month, and keeps number and year', () => {
    expect(localizePeriodLabel('Woche 5 - März 2026', 'en')).toBe('Week 5 - March 2026');
    expect(localizePeriodLabel('Woche 1 - Oktober 2026', 'ar')).toBe('الأسبوع 1 - أكتوبر 2026');
    expect(localizePeriodLabel('Oktober 2026', 'en')).toBe('October 2026');
    expect(localizePeriodLabel('Woche 5 - März 2026', 'tr')).toBe('Hafta 5 - Mart 2026');
    expect(localizePeriodLabel('Woche 5 - August 2026', 'ru')).toBe('Неделя 5 - Август 2026');
  });

  it('returns a label of any other shape untouched', () => {
    expect(localizePeriodLabel('Wochenende', 'en')).toBe('Wochenende');
    expect(localizePeriodLabel('', 'ar')).toBe('');
  });

  it.each(['en', 'ar', 'tr', 'ru'] as const)('%s names all twelve months', (code) => {
    const names = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
    const out = names.map(name => localizePeriodLabel(`${name} 2026`, code));
    // Twelve different results, and none is the German word: a missing entry would
    // pass the German through. "April", "August" and "September" are shared with English.
    expect(new Set(out).size).toBe(12);
    if (code !== 'en') names.forEach((name, i) => expect(out[i]).not.toContain(name));
  });
});
