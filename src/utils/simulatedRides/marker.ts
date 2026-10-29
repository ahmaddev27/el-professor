import * as XLSX from 'xlsx';

/**
 * The marker of a simulated ride, in one place.
 *
 * Decision (owner, 20.10.2026): every ride the generator makes says so, in the
 * database (`is_simulated`, kept by triggers), on the screens that list rides,
 * and in every Fahrtenbuch file built from them. This is the condition on
 * which the generator exists, not a detail: a Fahrtenbuch is a statutory
 * record and a generated ride that could pass for an imported one is a forged
 * entry. Nothing here takes a flag to leave the marker out. Do not add one.
 *
 * The wording is German in both languages, like every generated document.
 */
export const SIMULATED_SHEET_NAME = 'SIMULIERT';
export const SIMULATED_FILE_PREFIX = 'SIMULIERT_';
export const SIMULATED_NOTICE =
  'SIMULIERT – Diese Fahrten wurden vom Fahrtengenerator erzeugt. Es sind keine echten Fahrten. '
  + 'Nicht als Nachweis, Fahrtenbuch oder Lohngrundlage verwenden.';

/** One line for a PDF margin: where the long notice does not fit. */
export const SIMULATED_SHORT_NOTICE = 'SIMULIERT - keine echten Fahrten, kein Arbeitszeitnachweis, nicht verwenden';

interface MaybeSimulated {
  is_simulated?: boolean | null;
}

export function hasSimulatedRides(items: readonly MaybeSimulated[]): boolean {
  return items.some(item => item.is_simulated === true);
}

export function simulatedFileName(fileName: string): string {
  return fileName.startsWith(SIMULATED_FILE_PREFIX) ? fileName : `${SIMULATED_FILE_PREFIX}${fileName}`;
}

/** The sheet that carries the notice, with the sentence in its first cell. */
export function simulatedNoticeSheet(): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet([[SIMULATED_NOTICE]]);
  ws['!cols'] = [{ wch: 120 }];
  return ws;
}

/**
 * Adds the notice sheet. `first` puts it where an importer that reads the first
 * sheet finds a sheet with no ride columns, so an exported file cannot be taken
 * back in as a real one by accident; `last` leaves the ride sheet first, for the
 * file the generator itself imports.
 */
export function addSimulatedNotice(wb: XLSX.WorkBook, position: 'first' | 'last'): void {
  if (wb.SheetNames.includes(SIMULATED_SHEET_NAME)) return;
  XLSX.utils.book_append_sheet(wb, simulatedNoticeSheet(), SIMULATED_SHEET_NAME);
  if (position === 'first') {
    wb.SheetNames = [SIMULATED_SHEET_NAME, ...wb.SheetNames.filter(n => n !== SIMULATED_SHEET_NAME)];
  }
  wb.Props = { ...(wb.Props ?? {}), Title: SIMULATED_NOTICE };
}

/**
 * Writes a workbook; if any ride behind it is simulated the file carries the
 * notice sheet first and the SIMULIERT_ file name. The one place the workbook
 * writers that cannot build their data themselves go through.
 */
export function writeMarkedWorkbook(wb: XLSX.WorkBook, fileName: string, simulated: boolean): void {
  if (simulated) addSimulatedNotice(wb, 'first');
  XLSX.writeFile(wb, simulated ? simulatedFileName(fileName) : fileName);
}

/** Two rows under the data of a ride sheet: an empty one and the notice. */
export function appendSimulatedNoticeRows<T>(rows: T[][]): void {
  rows.push([] as unknown as T[], [SIMULATED_NOTICE as unknown as T]);
}

/** The header of the label column every row of a simulated report carries. */
export const SIMULATED_LABEL_HEADER = 'Kennzeichnung';
export const SIMULATED_LABEL_VALUE = 'SIMULIERT';

export type SimulationMarkerKind = 'sheet' | 'label_column' | 'notice_text';

const norm = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Whether a workbook handed to the REAL Fahrtenbuch import says it is simulated.
 *
 * A simulated file must never be taken in as a real one, however it got there:
 * a Fahrtenbuch is a statutory record. Three independent signs, any of which
 * refuses the file, so removing one (renaming the notice sheet, deleting the
 * label column of a copied sheet) is not enough to launder it:
 *  - a sheet named `SIMULIERT`;
 *  - in the sheet that will be read, a `Kennzeichnung` header cell with a
 *    `SIMULIERT` cell below it in the same column;
 *  - any cell of the read sheet equal to the notice sentence.
 *
 * A real Uber export has none of them: its 18 headers (see `sheet.ts`) do not
 * include `Kennzeichnung` (the plate column is `Kennzeichen`). The generator's
 * own import (`importPath.ts`) reads rows itself and never calls this, so the
 * simulated path keeps working.
 */
export function findSimulationMarker(
  wb: Pick<XLSX.WorkBook, 'SheetNames' | 'Sheets'>,
  readSheetName: string | undefined,
): SimulationMarkerKind | null {
  if (wb.SheetNames.some(n => norm(n).toUpperCase() === SIMULATED_SHEET_NAME)) return 'sheet';
  const ws = readSheetName === undefined ? undefined : wb.Sheets[readSheetName];
  if (!ws) return null;
  const labelColumns = new Set<number>();
  const valueColumns = new Set<number>();
  for (const address of Object.keys(ws)) {
    if (address.startsWith('!')) continue;
    const text = norm((ws[address] as XLSX.CellObject).v);
    if (text === SIMULATED_NOTICE) return 'notice_text';
    const column = XLSX.utils.decode_cell(address).c;
    if (text === SIMULATED_LABEL_HEADER) labelColumns.add(column);
    else if (text.toUpperCase() === SIMULATED_LABEL_VALUE) valueColumns.add(column);
  }
  return [...labelColumns].some(c => valueColumns.has(c)) ? 'label_column' : null;
}
