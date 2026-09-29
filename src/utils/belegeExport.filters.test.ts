/**
 * The Belege export honours the filter on screen, and both export buttons write
 * the same rows.
 *
 * WHAT WAS WRONG. `BelegePage` held `filteredReceipts`, a copy of the rows the
 * operator was looking at, whose only writer was the `onExportFiltered` callback
 * — and `ReceiptList` never called it. So the copy stayed whatever an effect had
 * put there, a copy of the full `receipts` array, and:
 *
 *   1. the Excel button exported every Beleg the company had ever entered,
 *      whatever driver, month, week or search was set;
 *   2. it stamped the file `Gefilterte Auswahl` whenever the company had any
 *      Beleg at all, which is the only line in the workbook that tells the
 *      reader whether the file is complete;
 *   3. the summary PDF button beside it was correct — it took `sortedReceipts`
 *      as an argument — so one screen state produced two disagreeing files, and
 *      the wrong one was the file that goes to the Steuerberater.
 *
 * TWO KINDS OF ASSERTION, because the two halves fail differently.
 *
 * The workbook half is behavioural: `buildBelegeExportOptions` is pure, so the
 * cells can be inspected without a filesystem.
 *
 * The wiring half is a source assertion, and deliberately so. vitest runs with
 * `environment: 'node'` and the project has no jsdom and no testing-library, so
 * no test here can render `ReceiptList` and click its buttons. What broke was
 * not a value but a *reference* — one button reading a second expression for
 * "the rows the user is looking at" — and the property that stops it coming back
 * is that exactly one such expression exists and both call sites name it. That
 * is a fact about the source, so it is checked in the source, the way
 * `subscriptionDirectWrites.test.ts` and `planFeatures.test.ts` already do.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildTableWorkbook } from './excelExport';
import { translate } from '../i18n';
import type { TranslationKey, TranslationVars } from '../i18n';
import type { Receipt } from '../types/receipt';
import {
  buildBelegeExportOptions,
  belegeExportFilename,
  describeReceiptFilters,
  NO_RECEIPT_FILTERS,
  type ReceiptExportFilters,
} from './belegeExport';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** The real dictionaries, so the assertions are about shipped wording. */
const de = (key: TranslationKey, vars?: TranslationVars) => translate('de', key, vars);
const en = (key: TranslationKey, vars?: TranslationVars) => translate('en', key, vars);

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  id: 'r1',
  receiptNumber: 'BEL-1',
  date: '2026-09-01',
  description: 'Tanken',
  driverName: 'Ali',
  expense: 42.5,
  paymentMethod: 'bar',
  ...over,
});

/**
 * A state the screen can actually produce. The first draft of this fixture used
 * `week: 35` with the whole month's range, and it was neither: selecting a week
 * narrows `activeDateKeys` to that week's Monday–Sunday, and
 * `getBusinessWeeksForMonth` numbers the weeks of the month `index + 1`, so the
 * field runs 1..5 and can never hold 35. That mattered — `35` made the old
 * filename's `_KW35` read plausibly for late August and hid the fact that the
 * number is not a Kalenderwoche at all.
 *
 * Measured for August 2026: the Mondays are the 3rd, 10th, 17th, 24th and 31st,
 * so Woche 3 is 17.08.–23.08. — ISO calendar week 34, not 3.
 */
const AUGUST_WEEK_3: ReceiptExportFilters = {
  dateRange: { start: '2026-08-17', end: '2026-08-23' },
  week: 3,
  driver: 'Ali',
  search: 'Tanken',
};

/** The whole business month: `getBusinessMonthRange(7, 2026)`, measured. */
const AUGUST_MONTH: ReceiptExportFilters = {
  dateRange: { start: '2026-08-03', end: '2026-09-06' },
  week: null,
  driver: 'Ali',
  search: '',
};

const SHEET = 'Belege';
/**
 * Row 0 accent stripe, 1 title, 2 meta, 3 the filter band, 4 spacer, 5 the
 * column headers. This export always writes a filter band — it always states at
 * least the period and the driver — so its first data row is one lower than
 * `excelExportNumeric.test.ts`'s, which passes `filterSummary: []`.
 */
const FILTER_ROW = 3;
const FIRST_DATA_ROW = 6;

function sheetOf(rows: Receipt[], filters: ReceiptExportFilters) {
  const wb = buildTableWorkbook(buildBelegeExportOptions(rows, filters, de));
  return wb.Sheets[SHEET];
}
const at = (ws: XLSX.WorkSheet, r: number, c: number) => ws[XLSX.utils.encode_cell({ r, c })];
/** The column index of a key, so a reordered column list does not silently pass. */
const colOf = (key: string) =>
  buildBelegeExportOptions([], NO_RECEIPT_FILTERS, de).columns.findIndex(c => c.key === key);

// ── The wiring: one row set, named by both export call sites ──────────────────

describe('both export buttons write the same rows', () => {
  const RECEIPT_LIST = 'src/components/ReceiptList.tsx';
  const BELEGE_PAGE = 'src/pages/BelegePage.tsx';

  /**
   * Comments are stripped first, or the paragraphs that explain the old defect
   * would read as live references to it.
   */
  const code = (path: string) =>
    read(path)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

  it('the PDF and the Excel handler pass the identical binding', () => {
    const calls = [...code(RECEIPT_LIST).matchAll(/on(?:DownloadPdf|ExportExcel)\(\s*([A-Za-z_$][\w$]*)/g)]
      .map(m => m[1]);

    // Exactly two call sites, and they name one value. Before the fix there was
    // one (the PDF's); the Excel file was built in the page from a copy.
    expect(calls).toHaveLength(2);
    expect(new Set(calls).size).toBe(1);
    expect(calls[0]).toBe('exportRows');
  });

  it('nothing keeps a second copy of the filtered rows any more', () => {
    // The prop and the state that held the stale copy are gone, so the bug
    // cannot be reintroduced by "wiring the callback up".
    expect(code(RECEIPT_LIST)).not.toMatch(/onExportFiltered/);
    expect(code(BELEGE_PAGE)).not.toMatch(/onExportFiltered|filteredReceipts/);
  });

  it('the Excel button is withheld while the read has failed', () => {
    // CLAUDE.md: a figure whose load failed is not shown — and a workbook whose
    // totals row says 0,00 € for a read that never landed is such a figure.
    expect(code(BELEGE_PAGE)).toMatch(/setLoadFailed\(false\)/);
    expect(code(BELEGE_PAGE)).toMatch(/setLoadFailed\(true\)/);
    expect(code(BELEGE_PAGE)).toMatch(/exportDisabled=\{loadFailed\}/);
    expect(code(RECEIPT_LIST)).toMatch(/disabled=\{exportDisabled \|\| exportRows\.length === 0\}/);
  });
});

// ── The filter band: the file states the selection it holds ───────────────────

describe('the filter band states the filter that was applied', () => {
  it('names the period, the week, the driver and the search', () => {
    expect(describeReceiptFilters(AUGUST_WEEK_3, de)).toEqual([
      'Zeitraum: 17.08.2026 – 23.08.2026',
      'Woche 3',
      'Fahrer: Ali',
      'Suchen: Tanken',
    ]);
  });

  it('says so when nothing was filtered, instead of claiming a selection', () => {
    // The old band was `filteredReceipts.length > 0 ? ['Gefilterte Auswahl'] : []`
    // — true for every company with one Beleg, so every non-empty file claimed a
    // filter that had not been applied.
    const lines = describeReceiptFilters(NO_RECEIPT_FILTERS, de);
    expect(lines).toEqual(['Zeitraum: Alle', 'Fahrer: Alle Fahrer']);
    expect(lines.join(' ')).not.toContain('Gefilterte Auswahl');
  });

  it('omits the week and the search only when they are unset', () => {
    expect(describeReceiptFilters(AUGUST_MONTH, de)).toEqual([
      'Zeitraum: 03.08.2026 – 06.09.2026',
      'Fahrer: Ali',
    ]);
  });

  it('follows the UI language: this dump satisfies no statutory form', () => {
    expect(describeReceiptFilters(NO_RECEIPT_FILTERS, en)).toEqual(['Period: All', 'Driver: All drivers']);
  });

  it('reaches the workbook, in the filter row', () => {
    const ws = sheetOf([receipt()], AUGUST_WEEK_3);
    expect(at(ws, FILTER_ROW, 0).v).toContain('Zeitraum: 17.08.2026 – 23.08.2026');
    expect(at(ws, FILTER_ROW, 0).v).toContain('Fahrer: Ali');
  });
});

// ── The money column: euros, and a number Excel can sum ───────────────────────

describe('the amount column', () => {
  it('is a number cell in the German euro format, not text', () => {
    const ws = sheetOf([receipt({ expense: 1234.56 })], NO_RECEIPT_FILTERS);
    const cell = at(ws, FIRST_DATA_ROW, colOf('expense'));
    expect(cell.t).toBe('n');
    // Stored in en-US convention; Excel renders 1.234,56 € for a German viewer.
    expect(cell.z).toBe('#,##0.00\\ "€"');
  });

  it('holds euros, not integer cents', () => {
    // receipts.expense is numeric(10,2) and ReceiptModal stores
    // Math.round(amount * 100) / 100 — a euro amount. A cents value in a 'money'
    // cell is wrong by a factor of 100 and looks entirely plausible in the file,
    // which is why it is asserted on the exact number rather than on the display.
    const ws = sheetOf([receipt({ expense: 42.5 })], NO_RECEIPT_FILTERS);
    expect(at(ws, FIRST_DATA_ROW, colOf('expense')).v).toBe(42.5);
    expect(at(ws, FIRST_DATA_ROW, colOf('expense')).v).not.toBe(4250);
  });

  it('declares no `format`, because a formatted string is a text cell', () => {
    // PR #150: `type` and `format` are exclusive. A money column carrying both
    // renders as text again and Excel cannot sum it.
    const column = buildBelegeExportOptions([], NO_RECEIPT_FILTERS, de).columns
      .find(c => c.key === 'expense');
    expect(column?.type).toBe('money');
    expect(column?.format).toBeUndefined();
  });
});

describe('the totals row', () => {
  it('is a number in the column format, so it sums with the rows above', () => {
    const ws = sheetOf([receipt({ expense: 10 }), receipt({ id: 'r2', expense: 5.5 })], NO_RECEIPT_FILTERS);
    // Two data rows, then the accent cap, then the totals row.
    const totals = at(ws, FIRST_DATA_ROW + 3, colOf('expense'));
    expect(totals.t).toBe('n');
    expect(totals.v).toBe(15.5);
    expect(totals.z).toBe('#,##0.00\\ "€"');
  });

  it('is summed in integer cents, so it does not drift', () => {
    // Money goes through utils/money.ts (CLAUDE.md). The amounts are small on
    // purpose: theirs is the drift that makes the naive euro sum visible.
    const NAIVE = 0.1 + 0.2 + 0.3;
    expect(NAIVE).not.toBe(0.6); // if this ever holds, this test proves nothing

    const rows = [0.1, 0.2, 0.3].map((expense, i) => receipt({ id: `r${i}`, expense }));
    const ws = sheetOf(rows, NO_RECEIPT_FILTERS);
    expect(at(ws, FIRST_DATA_ROW + 4, colOf('expense')).v).toBe(0.6);
  });
});

// ── The date column and the filename ─────────────────────────────────────────

describe('dates', () => {
  it('are written DD.MM.YYYY, zero-padded', () => {
    // The column used to be `new Date(v).toLocaleDateString('de-DE')`, which does
    // not pad: it wrote "1.9.2026" where the screen writes "01.09.2026". Reading
    // the stored YYYY-MM-DD text also drops the UTC-midnight hazard that had
    // already cost this screen every receipt on a period's last day.
    const ws = sheetOf([receipt({ date: '2026-09-01' })], NO_RECEIPT_FILTERS);
    expect(at(ws, FIRST_DATA_ROW, colOf('date')).v).toBe('01.09.2026');
  });

  it('never appear in US order in the band or the rows', () => {
    // Scoped to the cells this module writes. The exporter's own meta and footer
    // rows carry `new Date().toLocaleString('de-DE')`, whose output depends on
    // the runner's ICU data, and they are not this module's to assert.
    const ws = sheetOf([receipt({ date: '2026-09-01' })], AUGUST_WEEK_3);
    const columns = buildBelegeExportOptions([], AUGUST_WEEK_3, de).columns.length;
    const ours: string[] = [];
    for (const r of [FILTER_ROW, FIRST_DATA_ROW]) {
      for (let c = 0; c < columns; c++) {
        const v = at(ws, r, c)?.v;
        if (typeof v === 'string') ours.push(v);
      }
    }
    expect(ours.join(' | ')).not.toMatch(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/);
  });
});

describe('the filename', () => {
  it('names the period the file holds, not the day it was written', () => {
    expect(belegeExportFilename(AUGUST_MONTH)).toBe('belege_2026-08-03_2026-09-06');
  });

  it('names the week the way the screen does, and never as a Kalenderwoche', () => {
    // `week` is the week WITHIN the month (getBusinessWeeksForMonth numbers them
    // `index + 1`), so it runs 1..5. `KW` means Kalenderwoche: `…_KW3` for the
    // third week of August 2026 — 17.08.–23.08., ISO calendar week 34 — names
    // mid-January to anyone who reads German. The screen's own word for this
    // number is "Woche", in both the week dropdown and the active-week band.
    expect(belegeExportFilename(AUGUST_WEEK_3)).toBe('belege_2026-08-17_2026-08-23_Woche3');
    expect(belegeExportFilename(AUGUST_WEEK_3)).not.toMatch(/KW/);
  });

  it('says so when the file holds everything', () => {
    expect(belegeExportFilename(NO_RECEIPT_FILTERS)).toBe('belege_alle');
  });
});
