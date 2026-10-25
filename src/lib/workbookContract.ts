/**
 * The workbook description the browser sends to the export service, version 1.
 *
 * The service (deploy/export-service) writes every operational Excel file with
 * openpyxl, because the companies that receive those files check the writer.
 * This is its input, and the whole input: VALUES and number formats, nothing
 * else. There is deliberately no field for a font, a fill, a border, an
 * alignment, a column width, a freeze pane, a filter or a merge — formatting is
 * plain, and a contract that cannot carry it cannot be talked into it.
 *
 * `deploy/export-service/export_service/contract.json` is the other copy of the
 * number-format list and the limits; `workbookContract.test.ts` fails when the
 * two differ.
 *
 * A cell is `null` (nothing is written), a string (written as a string, never a
 * formula, whatever it starts with), a number, or a tagged object when it needs
 * a number format or is a date.
 */
export const CONTRACT_VERSION = 1;

export const NUMBER_FORMATS = [
  '#,##0.00',
  '#,##0.000',
  '#,##0',
  '#,##0.00\\ "€"',
  '#,##0\\ "km"',
  '0.0%',
  'dd.mm.yyyy',
  'dd.mm.yyyy\\ hh:mm',
  'hh:mm',
] as const;

export type NumberFormat = (typeof NUMBER_FORMATS)[number];

export const CONTRACT_LIMITS = {
  maxBodyBytes: 8388608,
  maxSheets: 20,
  maxRowsPerSheet: 100000,
  maxColumns: 256,
  maxCells: 400000,
  maxStringLength: 32767,
  maxSheetNameLength: 31,
} as const;

export type PayloadCell =
  | null
  | string
  | number
  | { t: 's'; v: string }
  | { t: 'n'; v: number; fmt?: NumberFormat }
  | { t: 'd'; v: string; fmt?: NumberFormat };

export interface PayloadSheet {
  name: string;
  rows: PayloadCell[][];
  /**
   * Row 1 is a header row. The one piece of styling the contract carries,
   * because Uber's own files have it: bold, thin border on all sides, centred.
   * Everything else stays unstyled.
   */
  header?: true;
}

export interface WorkbookPayload {
  version: typeof CONTRACT_VERSION;
  sheets: PayloadSheet[];
}

const KNOWN_FORMATS: ReadonlySet<string> = new Set(NUMBER_FORMATS);

export function isNumberFormat(value: unknown): value is NumberFormat {
  return typeof value === 'string' && KNOWN_FORMATS.has(value);
}
