/**
 * The Stundennachweis archive: a read whose refusal said "nothing saved", and a
 * month that could not be handed to the Steuerberater as a spreadsheet.
 *
 * Two halves, because the two defects live in different kinds of code.
 *
 * A — THE WORKBOOK, built and inspected cell by cell. Every figure this sheet
 * writes has a unit that is invisible in the file: minutes rendered as hours
 * would be wrong by 60, and integer cents in a money cell by 100 — both look
 * entirely plausible to a reader. `#150` made a typed cell possible at all;
 * these tests are what stops the wrong type or the wrong unit shipping. The
 * number formats are written out literally, as `excelExportNumeric.test.ts`
 * does, so re-deriving them from the implementation's own constant cannot let a
 * wrong one pass.
 *
 * B — THE READ, as a source assertion on `pages/DocumentsPage.tsx`, in the style
 * of `moneyScreenFailures.test.ts`. There is no renderer in this suite and the
 * page is 800 lines; the fix is a handful of lines a later edit can drop with no
 * symptom at all. Each assertion carries its negative control — the shape the
 * code had before the fix — so a regression fails here instead of being reasoned
 * about. What it cannot check is that the screen then draws the right thing;
 * that is the design harness (`npm run harness`), not vitest.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildTableWorkbook } from './excelExport';
import {
  buildArchiveExportOptions,
  minsToDecimal,
  totalMins,
  type ArchiveExportLabels,
  type ArchiveExportRecord,
} from './stundennachweisArchiveExport';

// ── A — the workbook ─────────────────────────────────────────────────────────

const LABELS: ArchiveExportLabels = {
  sheetTitle: 'Gespeicherte Stundennachweise – Mai 2026',
  moduleName: 'Archiv',
  driver: 'Fahrer',
  personalnummer: 'Personalnr.',
  workingDays: 'Arbeitstage',
  grundlohn: 'Std. Grundlohn',
  nachtarbeit: 'Std. Nachtarbeit',
  nacht04: 'Std. Nacht 0–4 Uhr',
  samstag: 'Std. Samstag',
  sonntag: 'Std. Sonntag',
  feiertag: 'Std. Feiertag',
  weihnachten: 'Std. Weihn./1. Mai',
  totalHours: 'Gesamtstunden',
  hourlyRate: 'Stundensatz (€)',
  gross: 'Brutto erwartet',
  source: 'Quelle',
  sourceFahrtenbuch: 'Fahrtenbuch',
  sourceMonatsplanung: 'Planung',
  savedAt: 'Gespeichert am',
  updatedAt: 'Aktualisiert am',
  totalsRow: 'Gesamt (2 Stundennachweise)',
};

function record(over: Partial<ArchiveExportRecord> = {}): ArchiveExportRecord {
  return {
    driver_name: 'Ali Yilmaz',
    personalnummer: '0042',
    working_days: 21,
    grundlohn_min: 480,
    nachtarbeit_min: 0,
    nacht04_min: 0,
    samstag_min: 0,
    sonntag_min: 0,
    feiertag_min: 0,
    weihnachten_min: 0,
    saved_at: '2026-05-31T10:00:00.000Z',
    updated_at: '2026-06-01T09:30:00.000Z',
    generation_source: 'fahrtenbuch',
    hourly_rate: 12.5,
    calculated_salary: 2500.5,
    ...over,
  };
}

/** Rows 0–4 are the accent stripe, the title, the meta line, a spacer and the header. */
const FIRST_DATA_ROW = 5;
const SHEET = LABELS.moduleName;

function at(ws: XLSX.WorkSheet, r: number, c: number) {
  return ws[XLSX.utils.encode_cell({ r, c })];
}

function sheetOf(records: ArchiveExportRecord[], totalGross: number | null = null) {
  const opts = buildArchiveExportOptions({
    month: 5,
    year: 2026,
    records,
    totalMinutes: records.reduce((sum, rec) => sum + totalMins(rec), 0),
    totalGross,
    labels: LABELS,
  });
  return { opts, ws: buildTableWorkbook(opts).Sheets[SHEET] };
}

/** Column index by key, so a reordering of the sheet does not silently move an assertion. */
function col(opts: ReturnType<typeof sheetOf>['opts'], key: string): number {
  const index = opts.columns.findIndex(c => c.key === key);
  if (index === -1) throw new Error(`no column keyed ${key}`);
  return index;
}

describe('the archive export declares a type on every numeric column', () => {
  /**
   * THE RULE #150 established: a column without `type` is written as TEXT, so
   * Excel neither sums nor sorts it and warns "number stored as text" on every
   * cell. The set is pinned exactly — a column added later without its `type`
   * fails here rather than reaching an accountant as a column of strings.
   */
  it('types exactly the eleven figure columns and leaves the other five text', () => {
    const { opts } = sheetOf([record()]);
    expect(opts.columns).toHaveLength(16);
    const typed = opts.columns.filter(c => c.type && c.type !== 'text').map(c => c.key);
    expect(typed).toEqual([
      'workingDays',
      'grundlohn', 'nachtarbeit', 'nacht04', 'samstag', 'sonntag', 'feiertag', 'weihnachten',
      'totalHours', 'hourlyRate', 'gross',
    ]);
    // The five text columns are text on purpose: a name, two dates, a word, and
    // an identifier whose leading zeros a number cell would eat.
    const untyped = opts.columns.filter(c => !c.type).map(c => c.key);
    expect(untyped).toEqual(['driver', 'personalnummer', 'source', 'savedAt', 'updatedAt']);
  });

  it('writes the hour columns in the German decimal format, the count as an integer', () => {
    const { opts, ws } = sheetOf([record()]);
    // Stored in en-US convention; Excel renders 1.234,56 for a German viewer.
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'grundlohn'))).toMatchObject({ t: 'n', z: '#,##0.00' });
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'totalHours'))).toMatchObject({ t: 'n', z: '#,##0.00' });
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'workingDays'))).toMatchObject({ t: 'n', v: 21, z: '#,##0' });
  });

  it('writes both money columns with the euro format', () => {
    const { opts, ws } = sheetOf([record()]);
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'hourlyRate')).z).toBe('#,##0.00\\ "€"');
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'gross')).z).toBe('#,##0.00\\ "€"');
  });
});

describe('the archive export writes each figure in the unit its column claims', () => {
  /**
   * The factor-of-60 control. `saved_stundennachweise.*_min` stores MINUTES;
   * the column is headed "Std." and must hold decimal hours. 480 minutes is 8
   * hours, and the wrong cell — 480 under "Std. Grundlohn" — is a plausible
   * monthly figure, which is exactly why it needs a test and not a reading.
   */
  it('converts minutes to decimal hours: 480 minutes is 8, never 480', () => {
    const { opts, ws } = sheetOf([record({ grundlohn_min: 480 })]);
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'grundlohn')).v).toBe(8);
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'grundlohn')).v).not.toBe(480);
  });

  it('sums every bucket into the total hours the same way', () => {
    const rec = record({ grundlohn_min: 480, nachtarbeit_min: 90, samstag_min: 30 });
    const { opts, ws } = sheetOf([rec]);
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'totalHours')).v).toBe(minsToDecimal(600));
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'totalHours')).v).toBe(10);
  });

  /**
   * The factor-of-100 controls. `calculated_salary` and `hourly_rate` are
   * `numeric` columns holding EUROS — written as `salaryInCents(...) / 100` and
   * rendered on screen by `formatEuro`, which takes a euro amount. Integer cents
   * in a `money` cell would print 250.050,00 € beside a real 2.500,50 €.
   */
  it('writes euros, not integer cents, in the gross and rate columns', () => {
    const { opts, ws } = sheetOf([record({ calculated_salary: 2500.5, hourly_rate: 12.5 })]);
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'gross')).v).toBe(2500.5);
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'gross')).v).not.toBe(250050);
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'hourlyRate')).v).toBe(12.5);
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'hourlyRate')).v).not.toBe(1250);
  });

  /**
   * A missing gross is the screen's "—", and an empty cell is the file's. A
   * 0,00 € would be a figure nobody recorded, in a document that reconciles
   * against a payroll.
   */
  it('leaves a missing gross or rate empty rather than writing 0,00 €', () => {
    const { opts, ws } = sheetOf([record({ calculated_salary: null, hourly_rate: null })]);
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'gross'))).toMatchObject({ t: 's', v: '' });
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'gross')).z).toBeUndefined();
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'hourlyRate'))).toMatchObject({ t: 's', v: '' });
  });

  it('keeps the Personalnummer a text cell, so its leading zeros survive', () => {
    const { opts, ws } = sheetOf([record({ personalnummer: '0042' })]);
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'personalnummer'))).toMatchObject({ t: 's', v: '0042' });
  });

  it('writes the dates day-first and never in a US order', () => {
    const { opts, ws } = sheetOf([record({ saved_at: '2026-05-31T10:00:00.000Z' })]);
    // TZ is pinned to Europe/Berlin by vitest.config.ts, so 10:00Z is the 31st.
    // The month is matched with an optional leading zero rather than a literal,
    // because the screen's own toLocaleDateString('de-DE') decides that and this
    // module must print exactly what the screen does. What is pinned is the
    // ORDER: 31 first, 2026 last, so 5/31/2026 fails.
    expect(at(ws, FIRST_DATA_ROW, col(opts, 'savedAt')).v).toMatch(/^31\.0?5\.2026$/);
  });
});

describe('the archive export totals row carries the screen figures, and no label', () => {
  /**
   * THE CONTRACT #152 added: the first column of the totals row is that row's
   * LABEL, and naming `columns[0].key` in `totals` THROWS. The count sentence
   * belongs in `labels.totalsRow`. Three call sites were silently losing their
   * wording to this.
   */
  it('puts no figure in the first column and its sentence in labels.totalsRow', () => {
    const { opts } = sheetOf([record(), record({ driver_name: 'Bea Klein' })]);
    expect(opts.columns[0].key).toBe('driver');
    expect(Object.keys(opts.totals ?? {})).not.toContain('driver');
    expect(opts.labels?.totalsRow).toBe('Gesamt (2 Stundennachweise)');
    // And it builds — the guard in excelExport.ts throws if it ever does not.
    expect(() => buildTableWorkbook(opts)).not.toThrow();
  });

  it('sums in minutes and converts once, so the sheet matches the month header', () => {
    // Two rows of 10 minutes. Summed in minutes and converted once: 20 min is
    // 0,33 h, which is what the screen's header prints. Converted first and then
    // added: 0,17 + 0,17 = 0,34. The two disagree, which is the point — the
    // order is the rule, and the screen's figure wins.
    const records = [
      record({ grundlohn_min: 10, working_days: 21 }),
      record({ driver_name: 'Bea Klein', grundlohn_min: 10, working_days: 21 }),
    ];
    const { opts, ws } = sheetOf(records);
    const totalsRow = FIRST_DATA_ROW + records.length + 1; // +1 for the accent row above it
    expect(at(ws, totalsRow, col(opts, 'grundlohn')).v).toBe(0.33);
    expect(at(ws, totalsRow, col(opts, 'grundlohn')).v).not.toBe(0.34);
    expect(at(ws, totalsRow, col(opts, 'grundlohn')).v).toBe(minsToDecimal(20));
    expect(at(ws, totalsRow, col(opts, 'totalHours')).v).toBe(minsToDecimal(20));
    expect(at(ws, totalsRow, col(opts, 'workingDays')).v).toBe(42);
    expect(at(ws, totalsRow, 0)).toMatchObject({ t: 's', v: 'Gesamt (2 Stundennachweise)' });
  });

  it('omits the gross total exactly where the screen omits it', () => {
    const records = [record(), record({ driver_name: 'Bea Klein', calculated_salary: null })];
    // The screen's own all-or-nothing rule: one record without a gross means the
    // month has no gross. The sheet must not total the rest and imply it does.
    const withoutGross = sheetOf(records, null);
    expect(Object.keys(withoutGross.opts.totals ?? {})).not.toContain('gross');
    const totalsRow = FIRST_DATA_ROW + records.length + 1;
    expect(at(withoutGross.ws, totalsRow, col(withoutGross.opts, 'gross'))).toMatchObject({ t: 's', v: '' });

    const withGross = sheetOf([record(), record({ driver_name: 'Bea Klein' })], 5001);
    expect(at(withGross.ws, totalsRow, col(withGross.opts, 'gross'))).toMatchObject({ t: 'n', v: 5001 });
  });

  it('never totals the hourly rate — a rate is not summable', () => {
    const { opts } = sheetOf([record(), record({ driver_name: 'Bea Klein' })]);
    expect(Object.keys(opts.totals ?? {})).not.toContain('hourlyRate');
  });
});

describe('the archive export names its file so no one mistakes it for the PDF', () => {
  it('uses the month as YYYY-MM and not the statutory PDF name', () => {
    const { opts } = sheetOf([record()]);
    expect(opts.filename).toBe('stundennachweise_2026-05');
    expect(opts.filename).not.toMatch(/^Stundennachweis_/);
  });
});

// ── B — the read that hid its error ──────────────────────────────────────────

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The text between two anchors, searching for `close` only after `open`. Brace
 * counting would have to know about braces inside strings, comments and JSX; an
 * anchor pair chosen per call does not.
 */
function between(source: string, open: string, close: string): string {
  const start = source.indexOf(open);
  // A plain throw, not expect(): this runs while the file is collected, not
  // inside a test. An anchor that moved is a failure worth reading as one.
  if (start === -1) throw new Error(`anchor not found: ${open}`);
  const end = source.indexOf(close, start + open.length);
  if (end === -1) throw new Error(`closing anchor not found after ${open}: ${close}`);
  return source.slice(start, end + close.length);
}

describe('DocumentsPage does not report a refused archive read as an empty archive', () => {
  const source = readFileSync(join(SRC, 'pages/DocumentsPage.tsx'), 'utf8');
  const loadArchive = between(source, 'const loadArchive = useCallback', '}, [companyId]);');
  const renderArchive = between(source, 'const renderArchive = () => {', 'expandedGroups.has(group.key)');

  /**
   * THE RULE: a figure whose load failed is not shown, and not exported. The
   * read discarded its `error` and fell through to `(data || [])`, and `data` is
   * null on a refusal — so a company whose read was refused was told its archive
   * was empty, on the screen it opens to find a document it knows it created.
   */
  it('reads the error off the archive query', () => {
    expect(loadArchive).toContain('const { data, error } = await supabase');
    // The negative control: the exact shape that produced the defect.
    expect(loadArchive).not.toContain('const { data } = await supabase');
  });

  it('sets the failure state and shows no records when the read is refused', () => {
    expect(loadArchive).toMatch(/if \(error\) \{[\s\S]*setArchiveFailed\(true\)/);
    // Cleared as well, or a previous company's archive stays under this one's name.
    expect(loadArchive).toMatch(/if \(error\) \{[\s\S]*setSavedRecords\(\[\]\)/);
  });

  it('clears the failure state where the load starts', () => {
    expect(loadArchive).toContain('setArchiveFailed(false)');
  });

  it('declares exactly one failure state for the archive', () => {
    const declarations = source.match(/const \[archiveFailed, setArchiveFailed\] = useState/g) ?? [];
    expect(declarations).toHaveLength(1);
  });

  it('draws the failure before the empty state, not instead of it', () => {
    const failure = renderArchive.indexOf('archiveFailed');
    const empty = renderArchive.indexOf('monthGroups.length === 0');
    expect(failure).toBeGreaterThan(-1);
    expect(empty).toBeGreaterThan(-1);
    // Ordered, because a failure reaching the empty state IS the defect.
    expect(failure).toBeLessThan(empty);
  });
});

describe('DocumentsPage withholds the Excel export while the archive read has failed', () => {
  const source = readFileSync(join(SRC, 'pages/DocumentsPage.tsx'), 'utf8');

  it('refuses in the handler', () => {
    const handler = between(source, 'const handleExportMonth = (group: MonthGroup) => {', 'exportArchiveMonthToExcel(');
    expect(handler).toContain('if (archiveFailed) return;');
  });

  it('disables the button as a second wall', () => {
    expect(source).toContain('disabled={archiveFailed}');
  });

  it('hands the export the month group figures the screen itself computed', () => {
    const call = between(source, 'exportArchiveMonthToExcel({', '});');
    expect(call).toContain('totalMinutes: group.totalMins');
    expect(call).toContain('totalGross: group.totalGross');
    expect(call).toContain('records: group.records');
  });
});
