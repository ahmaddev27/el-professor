/**
 * Draws a styled workbook with ExcelJS and hands the file to the browser.
 *
 * ── WHAT THIS MODULE IS NOW ──────────────────────────────────────────────────
 *
 * It used to be the writer of every operational list. It is not any more: those
 * lists (`exportTableToExcel`, `exportSheetsToExcel`, the Fahrtenanalyse report)
 * go to the Excel export service and come back written by openpyxl, plain,
 * through `serviceWorkbookDownload.ts`. Two callers are left on this ExcelJS
 * path, on purpose, until a follow-up moves them behind committed golden files:
 *
 *   - `fahreruebersichtExport.ts` (the Fahrerübersicht Stundennachweis sheet),
 *   - `monthlyPlanDocumentBuilders.ts` (the monthly plan's documents).
 *
 * Both are statutory or payroll paperwork, which is why they did not move with
 * the lists. The Fahrtenbuch exports still use `xlsx`'s own writer for the same
 * reason. The end state is ONE writer, the service, and when the last of these
 * moves this module and its ExcelJS dependency are deleted.
 *
 * ── THE OLD "DO NOT UNIFY" RULE, AND WHY IT NO LONGER HOLDS ──────────────────
 *
 * This comment used to say: DO NOT "unify" ExcelJS and xlsx, because xlsx
 * discards every cell style on write (`get_cell_style` reads only `cell.z` and
 * writes `fontId:0, fillId:0, borderId:0`; `write_ws_xml_sheetviews` emits no
 * `<pane>`), so the two libraries did different jobs: ExcelJS painted a readable
 * sheet, xlsx reproduced a prescribed one byte for byte. That reason is gone for
 * the lists, because nothing is painted any more: the owner decided on
 * 19.10.2026 that files are plain, and written by openpyxl. The reason that
 * remains for the two callers above is not styling but risk: they are the
 * highest-stakes exports and are moved separately. Unifying them is the plan,
 * not a hazard, as long as it happens behind goldens.
 *
 * ── HOW IT WORKS ─────────────────────────────────────────────────────────────
 *
 * `buildTableWorkbook`-style builders return an `XLSX.WorkBook` that is read as
 * the intermediate description of the file — the cell values, the `z` formats,
 * the `s` styles and the six `!` sheet settings — and this module translates it
 * into ExcelJS's model. Keeping the xlsx description is what keeps number
 * formats, the `asFiniteNumber` rule, the column-0 totals guard and the
 * sheet-name validation exactly the code they were.
 */
import * as XLSX from 'xlsx';
import { triggerDownload } from './browserDownload';

const SHEET_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ─── The ExcelJS surface this module drives ───────────────────────────────────
// Declared structurally and deliberately `unknown`-typed, for two reasons: the
// translator can be driven by a recording stub in a test, which is how "the
// styling still draws nothing" is caught without a browser; and ExcelJS's own
// far wider types stay out of the typecheck ratchet's way.

export interface ExcelJsCellLike {
  value?: unknown;
  numFmt?: unknown;
  font?: unknown;
  fill?: unknown;
  border?: unknown;
  alignment?: unknown;
}

export interface ExcelJsRowLike {
  height?: unknown;
}

export interface ExcelJsColumnLike {
  width?: unknown;
}

export interface ExcelJsWorksheetLike {
  /** 1-based, both arguments. */
  getCell(row: number, column: number): ExcelJsCellLike;
  /** 1-based. */
  getRow(row: number): ExcelJsRowLike;
  /** 1-based. */
  getColumn(column: number): ExcelJsColumnLike;
  /** 1-based and inclusive: top, left, bottom, right. */
  mergeCells(top: number, left: number, bottom: number, right: number): void;
  autoFilter?: unknown;
}

export interface ExcelJsWorkbookLike {
  creator?: unknown;
  lastModifiedBy?: unknown;
  created?: unknown;
  modified?: unknown;
  company?: unknown;
  title?: unknown;
  subject?: unknown;
  addWorksheet(name: string, options?: unknown): ExcelJsWorksheetLike;
}

// ─── The style shape `buildTableWorkbook` writes ──────────────────────────────
// xlsx types a cell's `s` as `any`, so the shape is spelled out here instead —
// otherwise every mistake in the translation below would be invisible to tsc.

interface RgbColor {
  rgb?: string;
}

interface SourceBorderSide {
  style?: string;
  color?: RgbColor;
}

interface SourceStyle {
  font?: {
    bold?: boolean;
    italic?: boolean;
    sz?: number;
    name?: string;
    color?: RgbColor;
  };
  fill?: { fgColor?: RgbColor };
  alignment?: {
    horizontal?: string;
    vertical?: string;
    wrapText?: boolean;
    indent?: number;
  };
  border?: Partial<Record<BorderSide, SourceBorderSide | undefined>>;
}

type BorderSide = 'top' | 'bottom' | 'left' | 'right';

const BORDER_SIDES: readonly BorderSide[] = ['top', 'bottom', 'left', 'right'];

/**
 * xlsx writes a colour as six hex digits with no alpha; ExcelJS wants eight,
 * alpha first. A value that already carries alpha, or a stray `#`, is accepted
 * so a caller's own token cannot silently produce a transparent cell.
 */
function toArgb(rgb: string): string {
  const hex = rgb.replace('#', '').toUpperCase();
  return hex.length === 8 ? hex : `FF${hex}`;
}

/**
 * xlsx's default maximum digit width, in pixels (`DEF_MDW` in its source). It is
 * a module-level mutable there, and `find_mdw_colw` moves it while PARSING a
 * workbook — so xlsx's own column widths depend on whether the page happened to
 * import a Fahrtenbuch first. Pinning it makes this writer's widths
 * deterministic, which xlsx's were not.
 */
const XLSX_DEFAULT_MAX_DIGIT_WIDTH = 6;

/**
 * The width xlsx would have written for a `wch`, so the swap does not narrow
 * every column of every export by five pixels.
 *
 * xlsx does not write `wch` through: `col_obj_w` passes it to `char2width`,
 *
 *   function char2width(chr) { return (Math.round((chr * MDW + 5)/MDW*256))/256; }
 *
 * which adds the 5-pixel cell padding — `wch: 20` reaches the file as
 * `width="20.832"`. ExcelJS writes `column.width` straight into the attribute,
 * so handing it the bare 20 would make every column 0.83 characters tighter
 * than the one the user has today, on a change whose whole point is that the
 * file reads better.
 */
function wchToSheetWidth(wch: number): number {
  const mdw = XLSX_DEFAULT_MAX_DIGIT_WIDTH;
  return Math.round(((wch * mdw + 5) / mdw) * 256) / 256;
}

/**
 * ExcelJS's vertical alignment vocabulary is `top | middle | bottom |
 * distributed | justify`, and OOXML's is `top | center | bottom | …` — ExcelJS
 * maps `middle` onto `center` itself. So the `'center'` this exporter has always
 * written is NOT in ExcelJS's list and is dropped by its validator: every
 * vertically centred cell in the file would quietly lose its centring, which is
 * the exact class of silent loss this module exists to end.
 */
function toExcelJsVertical(vertical: string): string {
  return vertical === 'center' ? 'middle' : vertical;
}

/**
 * Applies one cell's number format and style. Absent parts are left unset.
 *
 * `numberFormat` is xlsx's `z`, which the library types as `string | number` —
 * a number there is a built-in format ID, which this exporter has never written
 * and ExcelJS's `numFmt` does not take. Only a format string is carried over.
 */
function applyCellStyle(
  target: ExcelJsCellLike,
  style: SourceStyle | undefined,
  numberFormat: string | number | undefined,
): void {
  if (typeof numberFormat === 'string' && numberFormat !== '') target.numFmt = numberFormat;
  if (!style) return;

  const { font, fill, alignment, border } = style;

  if (font) {
    target.font = {
      name: font.name,
      size: font.sz,
      bold: font.bold,
      italic: font.italic,
      color: font.color?.rgb ? { argb: toArgb(font.color.rgb) } : undefined,
    };
  }

  // A solid pattern fill is what every band in this export is; ExcelJS refuses a
  // fill that names no type.
  if (fill?.fgColor?.rgb) {
    target.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: toArgb(fill.fgColor.rgb) },
    };
  }

  if (alignment) {
    target.alignment = {
      horizontal: alignment.horizontal,
      vertical: alignment.vertical ? toExcelJsVertical(alignment.vertical) : undefined,
      wrapText: alignment.wrapText,
      indent: alignment.indent,
    };
  }

  if (border) {
    // The exporter writes `left: undefined` where a row has no left edge, so the
    // sides are collected rather than copied — ExcelJS reads a side it is handed
    // and an explicit undefined would be a side with no style.
    const sides: Partial<Record<BorderSide, { style: string; color?: { argb: string } }>> = {};
    for (const side of BORDER_SIDES) {
      const spec = border[side];
      if (!spec?.style) continue;
      sides[side] = {
        style: spec.style,
        color: spec.color?.rgb ? { argb: toArgb(spec.color.rgb) } : undefined,
      };
    }
    if (Object.keys(sides).length > 0) target.border = sides;
  }
}

/** The sheet settings `buildTableWorkbook` puts on the worksheet. */
interface SheetSettings {
  freeze?: { xSplit?: number; ySplit?: number };
  autofilter?: { ref?: string | XLSX.Range };
  margins?: Record<string, number>;
  cols?: ({ wch?: number } | undefined)[];
  rows?: ({ hpt?: number } | undefined)[];
  merges?: XLSX.Range[];
}

function settingsOf(sheet: XLSX.WorkSheet): SheetSettings {
  const raw = sheet as unknown as Record<string, unknown>;
  return {
    freeze: raw['!freeze'] as SheetSettings['freeze'],
    autofilter: raw['!autofilter'] as SheetSettings['autofilter'],
    margins: raw['!margins'] as SheetSettings['margins'],
    cols: raw['!cols'] as SheetSettings['cols'],
    rows: raw['!rows'] as SheetSettings['rows'],
    merges: raw['!merges'] as SheetSettings['merges'],
  };
}

/**
 * Reproduces xlsx's own autofilter rule rather than the literal ref.
 * `write_ws_xml_autofilter` extends a single-row ref to the sheet's last row:
 *
 *   if(range.s.r == range.e.r) { range.e.r = decode_range(ws["!ref"]).e.r; … }
 *
 * so today's files carry `A5:<last column><last row>`, footer band included. A
 * header-row-only filter would give buttons that filter nothing, and narrowing
 * the range to the data rows is a change to what the file does — its own
 * decision, not this writer swap's.
 */
function autoFilterRange(ref: string | XLSX.Range, sheetRange: XLSX.Range): XLSX.Range {
  const range = typeof ref === 'string' ? XLSX.utils.decode_range(ref) : ref;
  const end = range.s.r === range.e.r ? sheetRange.e.r : range.e.r;
  return { s: { r: range.s.r, c: range.s.c }, e: { r: end, c: range.e.c } };
}

/**
 * Copies one xlsx workbook — values, number formats, styles and sheet settings
 * — onto an ExcelJS workbook.
 *
 * Exported so the translation can be driven by a recording stub: the defect this
 * module fixes is styling that is described and never drawn, and the only way to
 * catch a return of it without a browser is to assert that each cell was handed
 * a fill, a font, a border and an alignment.
 */
export function applyStyledWorkbook(source: XLSX.WorkBook, target: ExcelJsWorkbookLike): void {
  // Spelled out rather than `source.Props ?? {}`: the union with `{}` would put
  // every property below out of reach of the compiler.
  const props: {
    Title?: string;
    Subject?: string;
    Author?: string;
    Company?: string;
    CreatedDate?: Date;
  } = source.Props ?? {};
  // No fallback signature: `workbookProps` deliberately sets no Author, and a
  // default here would put the product's name back into every file's properties
  // — which is what the owner had removed on 01.10.2026.
  target.creator = props.Author ?? '';
  target.lastModifiedBy = target.creator;
  target.company = props.Company;
  target.title = props.Title;
  target.subject = props.Subject;
  target.created = props.CreatedDate ?? new Date();
  target.modified = target.created;

  for (const name of source.SheetNames) {
    const sheet = source.Sheets[name];
    if (!sheet) continue;
    applyStyledSheet(sheet, name, target);
  }
}

function applyStyledSheet(
  sheet: XLSX.WorkSheet,
  name: string,
  target: ExcelJsWorkbookLike,
): void {
  const ref = (sheet as unknown as Record<string, unknown>)['!ref'];
  if (typeof ref !== 'string') return;
  const range = XLSX.utils.decode_range(ref);
  const settings = settingsOf(sheet);

  // Both go in at creation: ExcelJS merges `pageSetup` over its own defaults,
  // where assigning the property afterwards would replace them wholesale.
  const worksheet = target.addWorksheet(name, {
    views: settings.freeze
      ? [{ state: 'frozen', xSplit: settings.freeze.xSplit ?? 0, ySplit: settings.freeze.ySplit ?? 0 }]
      : undefined,
    pageSetup: settings.margins ? { margins: settings.margins } : undefined,
  });

  // Column widths, converted so the columns come out the width they are today.
  settings.cols?.forEach((col, index) => {
    if (col?.wch != null) worksheet.getColumn(index + 1).width = wchToSheetWidth(col.wch);
  });

  // Cells. Iterating the keys rather than the range keeps the sparse rows sparse
  // — the spacer above the footer holds no cell at all.
  for (const address of Object.keys(sheet)) {
    if (address.startsWith('!')) continue;
    const cell = sheet[address] as XLSX.CellObject | undefined;
    if (!cell) continue;
    const { r, c } = XLSX.utils.decode_cell(address);
    const destination = worksheet.getCell(r + 1, c + 1);
    destination.value = cell.v as unknown;
    applyCellStyle(destination, cell.s as SourceStyle | undefined, cell.z);
  }

  // Row heights, in points on both sides.
  settings.rows?.forEach((row, index) => {
    if (row?.hpt != null) worksheet.getRow(index + 1).height = row.hpt;
  });

  // Merges come AFTER the styles on purpose: ExcelJS copies the master cell's
  // style onto every cell it swallows, so a band merged before it was painted
  // would come out unpainted.
  for (const merge of settings.merges ?? []) {
    // A merge of one cell draws nothing, and an inverted one (which this export
    // produces for a single-column table, where the meta band's end column is
    // -1) is a malformed ref that xlsx wrote out unchecked and ExcelJS would
    // normalise into a different rectangle. Neither is worth sending.
    if (merge.e.r < merge.s.r || merge.e.c < merge.s.c) continue;
    if (merge.e.r === merge.s.r && merge.e.c === merge.s.c) continue;
    worksheet.mergeCells(merge.s.r + 1, merge.s.c + 1, merge.e.r + 1, merge.e.c + 1);
  }

  if (settings.autofilter?.ref != null) {
    const filter = autoFilterRange(settings.autofilter.ref, range);
    worksheet.autoFilter = {
      from: { row: filter.s.r + 1, column: filter.s.c + 1 },
      to: { row: filter.e.r + 1, column: filter.e.c + 1 },
    };
  }
}

// ─── The download ─────────────────────────────────────────────────────────────

type ExcelJsWorkbookCtor = new () => ExcelJsWorkbookLike & {
  xlsx: { writeBuffer(): Promise<ArrayBuffer | Uint8Array> };
};

/**
 * Writes `source` as a styled .xlsx and answers it as a Blob.
 *
 * Split out of `downloadStyledWorkbook` so a caller that must hand the bytes
 * somewhere other than the browser's download can — the monthly plan's
 * documents return a `{filename, blob}` pair, and building the workbook twice, or
 * writing a second unstyled one with `XLSX.write`, would give that one document a
 * different look from every other table export.
 *
 * ExcelJS is imported HERE, lazily, and not at the top of the module: it is
 * substantially larger than xlsx, and a user who never presses an export button
 * must never download it. Same shape as App.tsx's `lazy(() => import(…))` for
 * the design preview.
 */
export async function styledWorkbookBlob(source: XLSX.WorkBook): Promise<Blob> {
  // Typed as `unknown` so nothing here depends on exceljs's own .d.ts.
  const loaded: unknown = await import('exceljs');
  const candidate = loaded as { Workbook?: unknown; default?: { Workbook?: unknown } };
  // This fallback is load-bearing, not defensive noise. exceljs is CommonJS, and
  // its `browser` field — the entry Vite resolves — is a webpack UMD bundle that
  // assigns a whole object to `module.exports`. esbuild's and Rollup's CJS
  // interop can only offer `default` for that shape, where the Node entry gives
  // named exports. Reading one and not the other is "Workbook is not a
  // constructor" at the moment a user presses Export, in the browser only.
  const Workbook = (candidate.Workbook ?? candidate.default?.Workbook) as ExcelJsWorkbookCtor;

  const workbook = new Workbook();
  applyStyledWorkbook(source, workbook);
  const buffer = await workbook.xlsx.writeBuffer();
  // `writeBuffer` is declared as `ArrayBuffer | Uint8Array`, and `BlobPart`
  // accepts neither union member without narrowing — TypeScript rejects the
  // union itself, not either half of it. Narrowed rather than cast, so a future
  // exceljs that returns something else fails to compile here instead of
  // producing a Blob of "[object Object]" that downloads as a corrupt file.
  const part: BlobPart = buffer instanceof Uint8Array
    ? new Uint8Array(buffer).buffer
    : buffer;
  return new Blob([part], { type: SHEET_MIME });
}

/** Writes `source` as a styled .xlsx and offers it to the browser as `filename`. */
export async function downloadStyledWorkbook(
  source: XLSX.WorkBook,
  filename: string,
): Promise<void> {
  triggerDownload(await styledWorkbookBlob(source), filename);
}
