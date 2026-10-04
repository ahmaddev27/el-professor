/**
 * The phone number is stored in the one form that can become a link.
 *
 * The owner's next step for it is WhatsApp, and `wa.me` takes digits with no
 * plus, no trunk zero and no separators. These pin that the conversion happens on
 * the way IN — so the column never holds a number that cannot be addressed — and
 * that an unreadable input is refused rather than stored dead.
 *
 * The database CHECK (`drivers_phone_shape`) is the second wall and holds the
 * same shape; this is what stops an operator being told "no" with no explanation.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizePhone,
  formatPhone,
  whatsAppNumber,
  DEFAULT_COUNTRY_CODE,
} from './phoneNumber';

describe('normalizePhone — the three forms a German operator writes', () => {
  it('takes a national number and replaces the trunk zero with the country code', () => {
    // The 0 is dialling, not part of the number. This is the common case.
    expect(normalizePhone('0170 1234567').e164).toBe('+491701234567');
    expect(normalizePhone('0170/123 45 67').e164).toBe('+491701234567');
    expect(normalizePhone('0170-1234567').e164).toBe('+491701234567');
    expect(normalizePhone('(0170) 1234567').e164).toBe('+491701234567');
  });

  it('takes an international number as written', () => {
    expect(normalizePhone('+49 170 1234567').e164).toBe('+491701234567');
    expect(normalizePhone('+491701234567').e164).toBe('+491701234567');
  });

  it('takes the 00 prefix, which is how it is dialled from Germany', () => {
    expect(normalizePhone('0049 170 1234567').e164).toBe('+491701234567');
  });

  it('is not German-only: another country code survives untouched', () => {
    expect(normalizePhone('+90 532 1234567').e164).toBe('+905321234567');
    expect(normalizePhone('00905321234567').e164).toBe('+905321234567');
  });

  it('respects a different default country for the national form', () => {
    expect(normalizePhone('0532 1234567', '90').e164).toBe('+905321234567');
  });
});

describe('normalizePhone — what it refuses, and why that is the safer error', () => {
  it('refuses a bare number with no +, no 00 and no leading 0', () => {
    // "49170…" could be German written without its plus, or a national number
    // somewhere else. Guessing picks one, and guessing wrong sends a message to a
    // stranger — so the field asks instead.
    expect(normalizePhone('491701234567')).toEqual({ e164: null, problem: 'needs_country' });
    expect(normalizePhone('1701234567')).toEqual({ e164: null, problem: 'needs_country' });
  });

  it('refuses a country code that starts with zero, which no country has', () => {
    expect(normalizePhone('+0170123456').problem).toBe('needs_country');
    expect(normalizePhone('000170123456').problem).toBe('needs_country');
  });

  it('refuses anything that is not digits, including a plus in the middle', () => {
    // Dropping a stray plus silently would change which number is stored.
    expect(normalizePhone('0170+1234567').problem).toBe('not_a_number');
    expect(normalizePhone('0170 12a4567').problem).toBe('not_a_number');
    expect(normalizePhone('keine').problem).toBe('not_a_number');
  });

  it('holds the E.164 length bounds', () => {
    expect(normalizePhone('+4912').problem).toBe('too_short');
    expect(normalizePhone('+4917012345678901').problem).toBe('too_long');
    // 15 digits exactly is the maximum and is accepted.
    expect(normalizePhone('+491701234567890').e164).toBe('+491701234567890');
  });

  it('tells an empty input apart from an unreadable one', () => {
    // The column is nullable and a driver with no number is ordinary, so "nothing
    // was entered" must not read as "this is wrong".
    expect(normalizePhone('')).toEqual({ e164: null, problem: 'empty' });
    expect(normalizePhone('   ')).toEqual({ e164: null, problem: 'empty' });
    expect(normalizePhone(null)).toEqual({ e164: null, problem: 'empty' });
    expect(normalizePhone(undefined)).toEqual({ e164: null, problem: 'empty' });
  });

  it('is idempotent: normalising its own output changes nothing', () => {
    // The form re-reads what it loaded, so a round trip must not drift.
    const once = normalizePhone('0170 1234567').e164;
    expect(normalizePhone(once).e164).toBe(once);
  });
});

describe('what the stored number is used for', () => {
  it('formats for reading without becoming a second source of truth', () => {
    expect(formatPhone('+491701234567')).toBe('+49 170 1234567');
    expect(formatPhone('+905321234567')).toBe('+905321234567');
    expect(formatPhone(null)).toBe('');
  });

  it('gives wa.me exactly what it takes: digits, no plus', () => {
    expect(whatsAppNumber('+491701234567')).toBe('491701234567');
    // Anything not in E.164 yields no link rather than a broken one.
    expect(whatsAppNumber('0170 1234567')).toBeNull();
    expect(whatsAppNumber(null)).toBeNull();
  });

  it('every normalised number can become a wa.me link — the point of the column', () => {
    for (const typed of ['0170 1234567', '+49 170 1234567', '0049 170 1234567',
                         '+90 532 1234567', '0151/22233344']) {
      const stored = normalizePhone(typed).e164;
      expect(stored, `${typed} did not normalise`).not.toBeNull();
      expect(whatsAppNumber(stored), `${typed} stored but not linkable`).not.toBeNull();
    }
  });

  it('and matches the database CHECK, so the two walls cannot disagree', () => {
    // `drivers_phone_shape` is `^\+[1-9][0-9]{6,14}$`. Anything this module stores
    // must pass it, or an operator meets a constraint error with no explanation.
    const CHECK = /^\+[1-9][0-9]{6,14}$/;
    for (const typed of ['0170 1234567', '+49 170 1234567', '0049 170 1234567',
                         '+90 532 1234567', '+491701234567890']) {
      const stored = normalizePhone(typed).e164!;
      expect(CHECK.test(stored), `${typed} → ${stored} fails the database CHECK`).toBe(true);
    }
  });

  it('Germany is the default and is named once', () => {
    expect(DEFAULT_COUNTRY_CODE).toBe('49');
  });
});
