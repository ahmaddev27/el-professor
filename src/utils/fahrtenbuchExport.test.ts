import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  EXCEL_FORMAT_DATE,
  EXCEL_FORMAT_DATETIME,
  EXCEL_FORMAT_TIME,
  FAHRTENBUCH_ORIGINAL_COLUMNS,
  applySourceCellFormats,
  sourceCellNumberFormat,
} from './fahrtenbuchExport';

/**
 * The Fahrtenbuch the Steuerberater receives, and the one thing that decides
 * whether a cell reads as a date or as `46265`.
 *
 * **The defect.** `FahrtenbuchImportModal` reads the uploaded sheet with
 * `XLSX.read(bytes, { raw: true, cellDates: false })` and `sheet_to_json(ws,
 * { raw: true })`, so a cell Excel stores as a date arrives as its serial and
 * that serial is what `raw_data_json` keeps. Both exporters then wrote every
 * source cell back with no number format at all — `exportFahrtenbuch`'s
 * `return val`, and `monatsplanungXlsxExport`'s `cellValue` — so a date column
 * would have been delivered as `46265` and a time column as `0,3451`.
 *
 * **Measured on 28.09.2026, and this is why the fix must not disturb anything.**
 * 13,959 of 13,959 rows, on production *and* on staging, carry all six
 * date/time columns as JSON strings and exactly three columns as JSON numbers —
 * `Fahrpreis`, `Kilometer`, `Trinkgeld`. So the defect has never once fired, and
 * the sheets that round-trip today must come out byte for byte as they do now.
 * CLAUDE.md's rule for the `'original'` export mode outranks the fix.
 *
 * **What the rule may not key on.** The source cell's own format string is not
 * available at export time — the importer stores values, never a cell's `z` —
 * so the discriminator is the column. It cannot be the JS type: the three money
 * columns above are legitimately numeric, and a type-led rule would hand the
 * Steuerberater `Fahrpreis 12,94 €` as a date in 1900. The negative control
 * below is exactly that rule, pinned as forbidden.
 *
 * Nor can the *name* alone say which format: `Uhrzeit des Fahrtbeginns` holds
 * `2026-06-02 17:27:20.000` on staging — a full datetime, despite "Uhrzeit". So
 * the column decides *whether* to format and the serial decides *which* format.
 *
 * **Not verified here** (no node_modules in the worktree this was written in, so
 * the suite never ran): that these assertions pass. They are written against the
 * code as committed. `exportFahrtenbuch` and `exportAppliedRunXlsx` are not
 * exercised directly, because both end in `XLSX.writeFile` to disk and the
 * second reads Supabase — the rule they share is what is covered.
 */

/** The three columns an Uber Fahrtenbuch export legitimately carries as numbers. */
const MONEY_COLUMNS = ['Fahrpreis', 'Kilometer', 'Trinkgeld'] as const;

/** The six that carry a date, a time, or both. */
const DATE_TIME_COLUMNS = [
  'Datum/Uhrzeit Auftragseingang',
  'Uhrzeit der Auftragsuebermittlung',
  'Geplante Abholzeit',
  'Datum der Fahrt',
  'Uhrzeit des Fahrtbeginns',
  'Uhrzeit des Fahrtendes',
] as const;

/** Excel serials, verified against the 1899-12-30 epoch: 31.08.2026, and 08:16:56 on that day. */
const SERIAL_DATE_2026_08_31 = 46265;
const SERIAL_TIME_08_16_56 = 0.3451;
const SERIAL_DATETIME = 46265.3451;

describe('the date/time column set is a subset of the real sheet, and excludes money', () => {
  it('names only columns the Uber export actually has', () => {
    for (const col of DATE_TIME_COLUMNS) {
      expect(FAHRTENBUCH_ORIGINAL_COLUMNS).toContain(col);
    }
  });

  it('never formats a money column, at any numeric value', () => {
    // The measured values, verbatim from staging.
    expect(sourceCellNumberFormat('Fahrpreis', 12.94)).toBeNull();
    expect(sourceCellNumberFormat('Kilometer', 3.89)).toBeNull();
    expect(sourceCellNumberFormat('Trinkgeld', 0)).toBeNull();
    // And at values that happen to sit inside the plausible-serial window, which
    // is what a type-led rule would have mangled.
    for (const col of MONEY_COLUMNS) {
      expect(sourceCellNumberFormat(col, SERIAL_DATE_2026_08_31)).toBeNull();
      expect(sourceCellNumberFormat(col, SERIAL_DATETIME)).toBeNull();
      expect(sourceCellNumberFormat(col, SERIAL_TIME_08_16_56)).toBeNull();
    }
  });

  it('is the money columns that the original column list also holds', () => {
    for (const col of MONEY_COLUMNS) {
      expect(FAHRTENBUCH_ORIGINAL_COLUMNS).toContain(col);
    }
  });
});

describe('sourceCellNumberFormat: the serial decides which format', () => {
  it('a whole serial in a date column is a date', () => {
    expect(sourceCellNumberFormat('Datum der Fahrt', SERIAL_DATE_2026_08_31)).toBe(EXCEL_FORMAT_DATE);
  });

  it('a fraction below 1 is a time of day', () => {
    expect(sourceCellNumberFormat('Geplante Abholzeit', SERIAL_TIME_08_16_56)).toBe(EXCEL_FORMAT_TIME);
  });

  it('a fraction above 1 is a date and a time', () => {
    expect(sourceCellNumberFormat('Uhrzeit des Fahrtbeginns', SERIAL_DATETIME)).toBe(EXCEL_FORMAT_DATETIME);
    // Measured: this column really does hold a full datetime, so "Uhrzeit" in
    // the header must not be read as "a time and nothing else".
    expect(sourceCellNumberFormat('Uhrzeit des Fahrtbeginns', SERIAL_DATE_2026_08_31)).toBe(EXCEL_FORMAT_DATE);
  });

  it('matches the column irrespective of case and inner whitespace', () => {
    expect(sourceCellNumberFormat('  datum DER   fahrt ', SERIAL_DATE_2026_08_31)).toBe(EXCEL_FORMAT_DATE);
  });

  it('leaves every column it does not recognise alone', () => {
    for (const col of ['Kennzeichen', 'Abholort', 'Wartezeit in Minuten', '']) {
      expect(sourceCellNumberFormat(col, SERIAL_DATE_2026_08_31)).toBeNull();
    }
  });
});

describe('sourceCellNumberFormat fails closed', () => {
  it('formats nothing that is not a finite number', () => {
    for (const v of ['2026-08-31', '', null, undefined, true, NaN, Infinity, -Infinity, {}, []]) {
      expect(sourceCellNumberFormat('Datum der Fahrt', v)).toBeNull();
    }
  });

  it('leaves exactly 0 alone, on purpose', () => {
    // Midnight and "the numeric cell was empty" are the same 0 here. A bare 0 in
    // the delivered sheet is visibly wrong; a spurious 00:00:00 would be
    // believed. Changing this is a decision, not a tidy-up.
    expect(sourceCellNumberFormat('Uhrzeit des Fahrtbeginns', 0)).toBeNull();
    expect(sourceCellNumberFormat('Uhrzeit des Fahrtbeginns', -0.5)).toBeNull();
  });

  it('leaves a number outside the 2000-2100 window alone', () => {
    expect(sourceCellNumberFormat('Datum der Fahrt', 36525)).toBeNull(); // 31.12.1999
    expect(sourceCellNumberFormat('Datum der Fahrt', 36526)).toBe(EXCEL_FORMAT_DATE); // 01.01.2000
    expect(sourceCellNumberFormat('Datum der Fahrt', 73050)).toBe(EXCEL_FORMAT_DATE); // 31.12.2099
    expect(sourceCellNumberFormat('Datum der Fahrt', 73051)).toBeNull(); // 01.01.2100
    expect(sourceCellNumberFormat('Datum der Fahrt', 12.5)).toBeNull(); // minutes, not a date
    expect(sourceCellNumberFormat('Datum der Fahrt', 1)).toBeNull();
  });
});

/** Build the sheet the exporters build: header row, then one row per trip. */
function sheetOf(columns: readonly string[], rows: readonly unknown[][]): XLSX.WorkSheet {
  return XLSX.utils.aoa_to_sheet([[...columns], ...rows.map(r => [...r])]);
}

/** Every cell address the sheet actually holds. */
function cellAddresses(ws: XLSX.WorkSheet): string[] {
  return Object.keys(ws).filter(k => !k.startsWith('!'));
}

describe('applySourceCellFormats on a real worksheet', () => {
  const columns = [...DATE_TIME_COLUMNS, ...MONEY_COLUMNS, 'Fahrername'];

  it('gives a serial its format and leaves its value untouched', () => {
    const rows: unknown[][] = [[
      SERIAL_DATETIME, SERIAL_DATETIME, SERIAL_TIME_08_16_56,
      SERIAL_DATE_2026_08_31, SERIAL_DATETIME, SERIAL_DATETIME,
      12.94, 3.89, 0, 'Max Mustermann',
    ]];
    const ws = sheetOf(columns, rows);
    const formatted = applySourceCellFormats(ws, columns, rows);

    expect(formatted).toBe(6);

    // 'Datum der Fahrt' is column index 3 -> D, data row 1 -> D2.
    expect(ws['D2'].t).toBe('n');
    expect(ws['D2'].z).toBe(EXCEL_FORMAT_DATE);
    expect(ws['D2'].v).toBe(SERIAL_DATE_2026_08_31); // the serial itself is preserved

    // 'Geplante Abholzeit' is index 2 -> C2.
    expect(ws['C2'].z).toBe(EXCEL_FORMAT_TIME);
    // 'Datum/Uhrzeit Auftragseingang' is index 0 -> A2.
    expect(ws['A2'].z).toBe(EXCEL_FORMAT_DATETIME);

    // The three money cells (G, H, I) keep no format at all.
    for (const addr of ['G2', 'H2', 'I2']) {
      expect(ws[addr].z).toBeUndefined();
      expect(ws[addr].t).toBe('n');
    }
    expect(ws['G2'].v).toBe(12.94);
  });

  it('never touches the header row', () => {
    // A header is a string, so the rule refuses it anyway — but the offset is
    // what guarantees it, and Originalformat has to reproduce the headers byte
    // for byte.
    const rows: unknown[][] = [[SERIAL_DATE_2026_08_31, ...Array(columns.length - 1).fill('')]];
    const ws = sheetOf(columns, rows);
    applySourceCellFormats(ws, columns, rows);
    for (let c = 0; c < columns.length; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
      expect(cell.v).toBe(columns[c]);
      expect(cell.t).toBe('s');
      expect(cell.z).toBeUndefined();
    }
  });

  it('formats a serial on whichever row it sits', () => {
    const blank = () => Array(columns.length).fill('');
    const third = blank();
    third[3] = SERIAL_DATE_2026_08_31;
    const rows: unknown[][] = [blank(), blank(), third];
    const ws = sheetOf(columns, rows);
    expect(applySourceCellFormats(ws, columns, rows)).toBe(1);
    expect(ws['D4'].z).toBe(EXCEL_FORMAT_DATE); // third data row -> sheet row 4
    expect(ws['D2'].z).toBeUndefined();
  });

  it('survives a row shorter than the column list', () => {
    const rows: unknown[][] = [[SERIAL_DATE_2026_08_31]];
    const ws = sheetOf(columns, rows);
    expect(() => applySourceCellFormats(ws, columns, rows)).not.toThrow();
  });
});

describe('NEGATIVE CONTROL: the 13,959 rows that work today must not move', () => {
  const columns = [...FAHRTENBUCH_ORIGINAL_COLUMNS];

  /** One row in the shape staging and production actually hold: dates as text, money as numbers. */
  const measuredRow: unknown[] = columns.map(col => {
    if (col === 'Fahrpreis') return 12.94;
    if (col === 'Kilometer') return 3.89;
    if (col === 'Trinkgeld') return 0;
    if (col === 'Datum der Fahrt') return '2026-08-31';
    if (col === 'Datum/Uhrzeit Auftragseingang') return '2026-06-26 07:15:24.000';
    if (col === 'Uhrzeit der Auftragsuebermittlung') return '2026-02-15 04:20:57.000';
    if (col === 'Uhrzeit des Fahrtbeginns') return '2026-06-02 17:27:20.000';
    if (col === 'Uhrzeit des Fahrtendes') return '2026-03-19 12:08:43.000';
    if (col === 'Geplante Abholzeit') return '2026-08-31 09:00:00.000';
    return 'Text';
  });

  it('formats not one cell, and leaves the sheet identical to the one built without it', () => {
    const rows: unknown[][] = [measuredRow, measuredRow];

    const before = sheetOf(columns, rows);
    const after = sheetOf(columns, rows);
    const formatted = applySourceCellFormats(after, columns, rows);

    expect(formatted).toBe(0);
    expect(cellAddresses(after)).toEqual(cellAddresses(before));
    for (const addr of cellAddresses(before)) {
      expect(after[addr].v).toEqual(before[addr].v);
      expect(after[addr].t).toBe(before[addr].t);
      expect(after[addr].z).toBeUndefined();
    }
  });

  it('a type-led rule is what this forbids', () => {
    // The rule the fix must NOT become. Embedded so a rewrite that keys on the
    // JS type fails here rather than being reasoned about: on the measured row
    // it would have date-formatted the three money cells and nothing else,
    // because every date/time cell is text.
    const typeLed = (value: unknown) => (typeof value === 'number' ? EXCEL_FORMAT_DATE : null);
    const typeLedHits = columns.filter((_col, i) => typeLed(measuredRow[i]) !== null);
    expect(typeLedHits).toEqual(['Fahrpreis', 'Trinkgeld', 'Kilometer']);

    const realHits = columns.filter((col, i) => sourceCellNumberFormat(col, measuredRow[i]) !== null);
    expect(realHits).toEqual([]);
  });
});

describe('the format reaches the written file', () => {
  it('a date column round-trips through a real xlsx as a date, money as a number', () => {
    const columns = ['Datum der Fahrt', 'Uhrzeit des Fahrtbeginns', 'Geplante Abholzeit', 'Fahrpreis'];
    const rows: unknown[][] = [[SERIAL_DATE_2026_08_31, SERIAL_DATETIME, SERIAL_TIME_08_16_56, 12.94]];
    const ws = sheetOf(columns, rows);
    applySourceCellFormats(ws, columns, rows);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const reread = XLSX.read(buf, { type: 'buffer', cellNF: true, cellDates: false, raw: true });
    const back = reread.Sheets['Sheet1'];

    // Asserted on what the format code means, not on its exact spelling: a
    // library free to escape the separators or to write `h` where we wrote `hh`
    // must not fail this.
    const z = (addr: string) => String(back[addr].z ?? '').toLowerCase();
    const hasDate = (addr: string) => /y/.test(z(addr));
    const hasTime = (addr: string) => /h/.test(z(addr));

    expect(hasDate('A2')).toBe(true);
    expect(hasTime('A2')).toBe(false);
    expect(hasDate('B2')).toBe(true);
    expect(hasTime('B2')).toBe(true);
    expect(hasTime('C2')).toBe(true);
    expect(hasDate('C2')).toBe(false);

    // The values themselves crossed unchanged, and the money column carries
    // neither a date nor a time format.
    expect(back['A2'].v).toBe(SERIAL_DATE_2026_08_31);
    expect(back['D2'].v).toBe(12.94);
    expect(hasDate('D2')).toBe(false);
    expect(hasTime('D2')).toBe(false);

    // And the header is still the header.
    expect(back['A1'].v).toBe('Datum der Fahrt');
  });
});
