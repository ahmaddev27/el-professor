/**
 * The export styling used to be described and never drawn.
 *
 * `xlsx@0.20.3` writes exactly one cell property — `cell.z`, the number format.
 * `get_cell_style` sets `fontId:0, fillId:0, borderId:0` for every cell,
 * `write_sty_xml` emits one hard-coded font, two fills and one empty border for
 * the whole file, and `write_ws_xml_sheetviews` emits no `<pane>` at all. So the
 * navy header band, the sky column headers, the striped rows, the grid, the
 * totals cap and the frozen header row that `buildTableWorkbook` has always
 * described reached no file. The files came out plain.
 *
 * These tests assert that the translation into ExcelJS's model CARRIES all of
 * it, against a recording stub rather than against ExcelJS itself: what has to
 * be pinned is that each cell is handed a fill, a font, a border, an alignment
 * and its number format, and that the sheet is handed its frozen view, its
 * widths, its heights, its merges and its filter. Whether ExcelJS then writes
 * valid XML is ExcelJS's own business and not something a unit test can claim.
 *
 * Two traps are pinned by name, because both are silent:
 *
 *  - ExcelJS's vertical vocabulary is `top | middle | bottom | …`, not OOXML's
 *    `center`. Passing the `'center'` this exporter writes makes its validator
 *    drop the attribute, and every vertically centred cell loses its centring
 *    with no error.
 *  - the exporter writes `left: undefined` for a row with no left edge, and a
 *    side handed over as an explicit undefined is a side with no style.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTableWorkbook,
  type ExportColumn,
  type ExportOptions,
} from './excelExport';
import {
  applyStyledWorkbook,
  type ExcelJsCellLike,
  type ExcelJsColumnLike,
  type ExcelJsRowLike,
  type ExcelJsWorkbookLike,
  type ExcelJsWorksheetLike,
} from './styledWorkbookDownload';

// ─── A recording stub of the ExcelJS surface the translator drives ────────────

interface Recorder {
  workbook: ExcelJsWorkbookLike;
  worksheet: ExcelJsWorksheetLike;
  cells: Map<string, ExcelJsCellLike>;
  rows: Map<number, ExcelJsRowLike>;
  columns: Map<number, ExcelJsColumnLike>;
  merges: string[];
  sheet: () => { name: string; options: unknown };
}

function recorder(): Recorder {
  const cells = new Map<string, ExcelJsCellLike>();
  const rows = new Map<number, ExcelJsRowLike>();
  const columns = new Map<number, ExcelJsColumnLike>();
  const merges: string[] = [];
  let name = '';
  let options: unknown;

  const worksheet: ExcelJsWorksheetLike = {
    getCell(row, column) {
      const key = `${row}:${column}`;
      const existing = cells.get(key);
      if (existing) return existing;
      const created: ExcelJsCellLike = {};
      cells.set(key, created);
      return created;
    },
    getRow(row) {
      const existing = rows.get(row);
      if (existing) return existing;
      const created: ExcelJsRowLike = {};
      rows.set(row, created);
      return created;
    },
    getColumn(column) {
      const existing = columns.get(column);
      if (existing) return existing;
      const created: ExcelJsColumnLike = {};
      columns.set(column, created);
      return created;
    },
    mergeCells(top, left, bottom, right) {
      merges.push(`${top},${left},${bottom},${right}`);
    },
  };

  const workbook: ExcelJsWorkbookLike = {
    addWorksheet(sheetName, sheetOptions) {
      name = sheetName;
      options = sheetOptions;
      return worksheet;
    },
  };

  return { workbook, worksheet, cells, rows, columns, merges, sheet: () => ({ name, options }) };
}

function cellAt(cells: Map<string, ExcelJsCellLike>, row: number, column: number): ExcelJsCellLike {
  const cell = cells.get(`${row}:${column}`);
  if (!cell) throw new Error(`nothing was written at row ${row}, column ${column}`);
  return cell;
}

const asObject = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

// ─── The workbook these tests translate ──────────────────────────────────────
//
// Three columns and a filter line, so every block is present and no merge is
// degenerate. 0-based sheet rows: 0 accent, 1 title, 2 meta, 3 filter,
// 4 spacer, 5 column headers, 6 data, 7 totals cap, 8 totals, 9 spacer,
// 10 footer. ExcelJS counts from 1, so those are rows 1-11.

const COLUMNS: ExportColumn[] = [
  { key: 'plate', label: 'Kennzeichen', width: 20 },
  { key: 'driver', label: 'Fahrer' },
  { key: 'amount', label: 'Betrag', type: 'money', align: 'right' },
];

const MONEY_FORMAT = '#,##0.00\\ "€"';

const HEADER_ROW = 6;
const DATA_ROW = 7;
const TOTALS_ROW = 9;
const LAST_ROW = 11;

function translate(over: Partial<ExportOptions> = {}): Recorder {
  const options: ExportOptions = {
    filename: 'test',
    sheetTitle: 'Titel',
    moduleName: 'Test',
    columns: COLUMNS,
    rows: [{ plate: 'B-AB 1234', driver: 'Ali', amount: 1234.56 }],
    filterSummary: ['Jahr: 2026'],
    totals: { amount: 1234.56 },
    ...over,
  };
  const recording = recorder();
  applyStyledWorkbook(buildTableWorkbook(options), recording.workbook);
  return recording;
}

describe('the styling reaches the writer', () => {
  it('hands the column header its fill, its font and its borders', () => {
    const header = cellAt(translate().cells, HEADER_ROW, 1);

    // Under xlsx all four of these were dropped and the cell came out plain.
    expect(header.fill).toEqual({
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1D5F8A' },
    });
    expect(asObject(header.font)).toMatchObject({
      bold: true,
      size: 10,
      name: 'Calibri',
      color: { argb: 'FFFFFFFF' },
    });
    expect(asObject(header.border)).toMatchObject({
      top: { style: 'medium', color: { argb: 'FF0F2337' } },
      bottom: { style: 'medium', color: { argb: 'FF0F4C75' } },
    });
    expect(header.value).toBe('Kennzeichen');
  });

  it('paints the striped data row and the totals band', () => {
    const cells = translate().cells;

    expect(asObject(cellAt(cells, DATA_ROW, 1).fill).fgColor).toEqual({ argb: 'FFF7F9FC' });
    expect(asObject(cellAt(cells, TOTALS_ROW, 1).fill).fgColor).toEqual({ argb: 'FFE3EEF7' });
    expect(asObject(cellAt(cells, TOTALS_ROW, 1).font).bold).toBe(true);
  });

  it('turns a six-digit rgb into an eight-digit argb, alpha first', () => {
    // '1D5F8A' → 'FF1D5F8A'. Six digits read as argb would make the cell
    // transparent and the band would be invisible again.
    const fill = asObject(cellAt(translate().cells, HEADER_ROW, 2).fill);
    expect(asObject(fill.fgColor).argb).toBe('FF1D5F8A');
  });
});

describe("the two silent losses in ExcelJS's model", () => {
  it("maps OOXML's vertical 'center' onto ExcelJS's 'middle'", () => {
    const alignment = asObject(cellAt(translate().cells, HEADER_ROW, 1).alignment);
    expect(alignment.vertical).toBe('middle');
    expect(alignment.horizontal).toBe('left');
  });

  it('omits a border side the exporter left undefined rather than handing it over', () => {
    // The filter row draws a left edge on the first cell only, so the middle
    // cell has `left: undefined` and `right: undefined` in the source style.
    const border = asObject(cellAt(translate().cells, 4, 2).border);
    expect(Object.keys(border).sort()).toEqual(['bottom', 'top']);
  });
});

describe('the number formats survive, and an unreadable value is still blank', () => {
  it('carries the money format onto the data cell and the totals cell', () => {
    const cells = translate().cells;

    expect(cellAt(cells, DATA_ROW, 3).value).toBe(1234.56);
    expect(cellAt(cells, DATA_ROW, 3).numFmt).toBe(MONEY_FORMAT);
    expect(cellAt(cells, TOTALS_ROW, 3).value).toBe(1234.56);
    expect(cellAt(cells, TOTALS_ROW, 3).numFmt).toBe(MONEY_FORMAT);
  });

  it('leaves a text cell with no number format at all', () => {
    const plate = cellAt(translate().cells, DATA_ROW, 1);
    expect(plate.value).toBe('B-AB 1234');
    expect(plate.numFmt).toBeUndefined();
  });

  it('writes an unreadable money value as blank text, never as 0', () => {
    const cells = translate({ rows: [{ plate: 'B-AB 1', driver: 'Ali', amount: null }] }).cells;
    const amount = cellAt(cells, DATA_ROW, 3);
    expect(amount.value).toBe('');
    expect(amount.numFmt).toBeUndefined();
  });
});

describe('the sheet settings reach the writer', () => {
  it('freezes everything above and including the column-header row', () => {
    // xlsx has no `<pane>` in its writer, so this never reached a file before.
    expect(asObject(translate().sheet().options).views).toEqual([
      { state: 'frozen', xSplit: 0, ySplit: HEADER_ROW },
    ]);
  });

  it('passes the print margins in at creation, so ExcelJS keeps its defaults', () => {
    expect(asObject(translate().sheet().options).pageSetup).toEqual({
      margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
    });
  });

  it('carries the column widths and the row heights', () => {
    const recording = translate();
    expect(recording.columns.get(1)?.width).toBe(20);
    // No width given, so the exporter's floor of 18 applies.
    expect(recording.columns.get(2)?.width).toBe(18);
    expect(recording.rows.get(2)?.height).toBe(32);
    expect(recording.rows.get(HEADER_ROW)?.height).toBe(22);
  });

  it("extends the autofilter to the last row, as xlsx's own writer did", () => {
    // `write_ws_xml_autofilter` rewrites a single-row ref to the sheet's last
    // row. Reproducing it keeps today's file; narrowing it is its own decision.
    expect(translate().worksheet.autoFilter).toEqual({
      from: { row: HEADER_ROW, column: 1 },
      to: { row: LAST_ROW, column: 3 },
    });
  });

  it('merges the accent, title, meta, filter and footer bands', () => {
    expect(translate().merges.slice().sort()).toEqual(
      ['1,1,1,3', '2,1,2,3', '3,1,3,2', '4,1,4,3', '11,1,11,2'].sort(),
    );
  });

  it('names the sheet and fills the document properties', () => {
    const recording = translate();
    expect(recording.sheet().name).toBe('Test');
    expect(recording.workbook.title).toBe('Titel');
    expect(recording.workbook.subject).toBe('Test');
    expect(recording.workbook.company).toBe('El-Professor');
    expect(recording.workbook.creator).toBe('El-Professor Verwaltungssystem');
  });

  it('sends no degenerate merge for a single-column table', () => {
    // With one column the meta and footer bands end one column BEFORE they
    // start, which xlsx wrote out as a malformed ref and ExcelJS would
    // normalise into a different rectangle; the others are one cell wide and
    // draw nothing. None is worth sending.
    const single: ExportColumn[] = [{ key: 'plate', label: 'Kennzeichen' }];
    expect(translate({ columns: single, totals: {} }).merges).toEqual([]);
  });
});
