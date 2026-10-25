/**
 * Reads an `XLSX.WorkBook` as the description of a file and answers the plain
 * payload the export service writes (`src/lib/workbookContract.ts`).
 *
 * `buildTableWorkbook` and its siblings still build their sheets with the xlsx
 * library, as they always did, and that is deliberate: it keeps the number
 * formats, the `asFiniteNumber` rule (an unreadable value is never 0), the
 * column-0 totals guard and the sheet-name validation exactly the code they
 * were, asserted cell by cell by the tests that read the sheets. xlsx is used
 * here as a data structure and never as a writer. Everything those builders say
 * about how a cell LOOKS — `s` styles, widths, row heights, merges, freeze,
 * filter — is not read at all, because the contract has nowhere to put it.
 *
 * What is kept is what is data: the value, whether it is a number, and the
 * number format when it is one the contract knows. A number stays a number so
 * an accountant can sum the column; a format the contract does not list is
 * dropped and the number kept, never the other way round.
 */
import * as XLSX from 'xlsx';
import {
  CONTRACT_VERSION,
  isNumberFormat,
  type PayloadCell,
  type PayloadSheet,
  type WorkbookPayload,
} from '../lib/workbookContract';

export interface PayloadOptions {
  /** Row 1 of every sheet is a header row; the service gives it Uber's one header style. */
  headerRow?: boolean;
}

export function workbookToPayload(source: XLSX.WorkBook, options: PayloadOptions = {}): WorkbookPayload {
  const sheets: PayloadSheet[] = [];
  for (const name of source.SheetNames) {
    const sheet = source.Sheets[name];
    if (!sheet) continue;
    const rows = sheetRows(sheet, name);
    sheets.push(options.headerRow ? { name, rows, header: true } : { name, rows });
  }
  return { version: CONTRACT_VERSION, sheets };
}

function sheetRows(sheet: XLSX.WorkSheet, name: string): PayloadCell[][] {
  const ref = (sheet as unknown as Record<string, unknown>)['!ref'];
  if (typeof ref !== 'string') return [];
  const range = XLSX.utils.decode_range(ref);
  const rows: PayloadCell[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: PayloadCell[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
      row.push(cell ? payloadCell(cell, name) : null);
    }
    rows.push(trimTrailingEmpty(row));
  }
  return rows;
}

function trimTrailingEmpty(row: PayloadCell[]): PayloadCell[] {
  let end = row.length;
  while (end > 0 && row[end - 1] === null) end--;
  return end === row.length ? row : row.slice(0, end);
}

function payloadCell(cell: XLSX.CellObject, sheet: string): PayloadCell {
  if (cell.t === 'n') return numberCell(cell);
  if (cell.t === 's') return typeof cell.v === 'string' && cell.v !== '' ? cell.v : null;
  if (cell.t === 'z') return null;
  // A boolean, a date or an error is not something any list export writes today.
  // Refusing is louder than guessing, and the builders' tests exercise them all.
  throw new Error(`workbookToPayload: sheet "${sheet}" has a cell of type "${cell.t}", which the export contract does not carry`);
}

function numberCell(cell: XLSX.CellObject): PayloadCell {
  const value = cell.v;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return isNumberFormat(cell.z) ? { t: 'n', v: value, fmt: cell.z } : value;
}
