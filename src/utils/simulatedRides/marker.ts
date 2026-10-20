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

/** Two rows under the data of a ride sheet: an empty one and the notice. */
export function appendSimulatedNoticeRows<T>(rows: T[][]): void {
  rows.push([] as unknown as T[], [SIMULATED_NOTICE as unknown as T]);
}
