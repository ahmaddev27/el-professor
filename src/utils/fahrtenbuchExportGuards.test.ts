import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  safeSheetName,
  FahrtenbuchExportBlockedError,
  exportFahrtenbuch,
} from './fahrtenbuchExport';

/**
 * Two defects on the statutory Fahrtenbuch export:
 *
 *  1. the uploaded workbook's own tab label reached `book_append_sheet`
 *     unvalidated, and `check_ws_name` **throws** on five different shapes —
 *     a throw inside an onClick with no boundary is a dead button;
 *  2. three conditions returned with no file and no signal at all.
 *
 * The decisive assertion is the last block: every name `safeSheetName` produces
 * is handed to the **real library** and must be accepted. That is what keeps the
 * helper honest if xlsx's own rules ever change — the test measures the library,
 * it does not restate my reading of it.
 */

describe('safeSheetName — the five things check_ws_name refuses', () => {
  it('replaces every forbidden character', () => {
    // : ] [ * ? / \
    expect(safeSheetName('Fahrten: 01/08 [Nachtrag]')).toBe('Fahrten_ 01_08 _Nachtrag_');
    expect(safeSheetName('a*b?c')).toBe('a_b_c');
  });

  it('caps at 31 characters', () => {
    const long = 'Fahrten 01.08.2026 bis 31.08.2026 Nachtrag';
    expect(long.length).toBeGreaterThan(31);
    expect(safeSheetName(long)).toHaveLength(31);
  });

  it('strips apostrophes at both ends, greedily', () => {
    expect(safeSheetName("'Fahrten'")).toBe('Fahrten');
    expect(safeSheetName("''Fahrten''")).toBe('Fahrten');
    // Only the ends: an inner apostrophe is legal and must survive, because the
    // tab label is the customer's and nothing gratuitously rewrites it.
    expect(safeSheetName("Ali's Fahrten")).toBe("Ali's Fahrten");
  });

  it('caps before stripping, so truncation cannot leave a trailing apostrophe', () => {
    // 31 characters ending in an apostrophe, then more after it.
    const name = 'x'.repeat(30) + "'" + 'yyyy';
    const out = safeSheetName(name);
    expect(out.endsWith("'")).toBe(false);
    expect(out).toBe('x'.repeat(30));
  });

  it('renames the reserved sheet name History, in any case', () => {
    expect(safeSheetName('History')).toBe('History_');
    expect(safeSheetName('history')).toBe('history_');
    expect(safeSheetName('HISTORY')).toBe('HISTORY_');
    // And only the exact name — a sheet merely containing it is fine.
    expect(safeSheetName('History 2026')).toBe('History 2026');
  });

  it('falls back for a name that is empty, blank, or nothing but apostrophes', () => {
    expect(safeSheetName(null)).toBe('Sheet1');
    expect(safeSheetName(undefined)).toBe('Sheet1');
    expect(safeSheetName('')).toBe('Sheet1');
    expect(safeSheetName('   ')).toBe('Sheet1');
    expect(safeSheetName("''''")).toBe('Sheet1');
  });

  it('leaves an ordinary name exactly as it was', () => {
    // The customer's label is reproduced unless the library would refuse it.
    expect(safeSheetName('Fahrtenbuch August')).toBe('Fahrtenbuch August');
    expect(safeSheetName('Sheet1')).toBe('Sheet1');
    expect(safeSheetName('Tabelle1 (2)')).toBe('Tabelle1 (2)');
  });
});

describe('safeSheetName — measured against the real library, not against my reading of it', () => {
  const hostile = [
    'Fahrten: 01.08.–31.08. (Nachtrag)',
    'Fahrten 01.08.2026 bis 31.08.2026 Nachtrag Teil 2',
    "'Fahrten'",
    "''",
    'History',
    'history',
    'a/b\\c:d*e?f[g]h',
    '',
    '   ',
    'x'.repeat(30) + "'" + 'yyyy',
    'x'.repeat(100),
    'Tabelle1',
  ];

  it('every produced name is accepted by xlsx book_append_sheet', () => {
    for (const raw of hostile) {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([['a']]);
      const safe = safeSheetName(raw);
      expect(() => XLSX.utils.book_append_sheet(wb, ws, safe)).not.toThrow();
    }
  });

  it('and the library really does refuse the raw ones — so the guard is not decoration', () => {
    const refused = hostile.filter(raw => {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([['a']]);
      try {
        XLSX.utils.book_append_sheet(wb, ws, raw);
        return false;
      } catch {
        return true;
      }
    });
    // A negative control: if this ever reaches zero, either the library changed
    // or the list stopped being hostile, and the suite above proves nothing.
    expect(refused.length).toBeGreaterThan(0);
  });
});

describe('the three silent returns now say what stopped them', () => {
  const trip = (raw: unknown) => ({
    id: 't1',
    raw_data_json: raw,
    assigned_driver_name: 'Ali',
    original_driver_name: 'Ali',
    created_at: '2026-10-05T08:00:00Z',
    source_row_index: 1,
  });

  const opts = { month: 10, year: 2026, importFileName: 'f.xlsx' };

  it('no trips', () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exportFahrtenbuch({ trips: [], ...opts } as any);
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FahrtenbuchExportBlockedError);
      expect((e as FahrtenbuchExportBlockedError).reason).toBe('no_trips');
    }
  });

  it('the first trip has no raw import row', () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exportFahrtenbuch({ trips: [trip(null)], ...opts } as any);
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as FahrtenbuchExportBlockedError).reason).toBe('no_raw_data');
    }
  });

  it('an empty raw row yields no columns — the reachable case', () => {
    // `raw_data_json` is `jsonb NOT NULL DEFAULT '{}'`, and since 20260922100000
    // an incomplete row is stored and flagged rather than dropped, so `{}` is a
    // value that reaches this export in production.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exportFahrtenbuch({ trips: [trip({})], ...opts } as any);
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FahrtenbuchExportBlockedError);
      expect((e as FahrtenbuchExportBlockedError).reason).toBe('no_columns');
    }
  });

  it('every message is a German sentence, since it is rendered as-is', () => {
    for (const trips of [[], [trip(null)], [trip({})]]) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exportFahrtenbuch({ trips, ...opts } as any);
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg.length).toBeGreaterThan(20);
        expect(msg.endsWith('.')).toBe(true);
        // `reason` is the stable half — a later translation keys off it, never
        // off this wording.
        expect((e as FahrtenbuchExportBlockedError).reason).toBeTruthy();
      }
    }
  });
});
