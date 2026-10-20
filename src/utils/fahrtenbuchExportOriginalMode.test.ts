import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

vi.mock('xlsx', async importOriginal => {
  const actual = await importOriginal<typeof import('xlsx')>();
  return { ...actual, writeFile: vi.fn() };
});

import { exportFahrtenbuch, FAHRTENBUCH_ORIGINAL_COLUMNS, tripDriverName } from './fahrtenbuchExport';

/*
  The 'original' mode reproduces the imported sheet's headers and cells. The
  expected literal below was taken from the code BEFORE `tripDriverName` was
  extracted (same test, run on the base commit), so it pins that the extraction
  changed nothing.
*/
describe("exportFahrtenbuch 'original' mode", () => {
  it('writes the 18 headers and the cells exactly, assigned driver else original', () => {
    const raw = (name: string) => Object.fromEntries(
      FAHRTENBUCH_ORIGINAL_COLUMNS.map(c => [c, c === 'Fahrername' ? name : c === 'Fahrpreis' ? 10.5 : `v:${c}`]),
    );
    const trip = (assigned: string, original: string, name: string) => ({
      raw_data_json: raw(name), assigned_driver_name: assigned, original_driver_name: original,
      source_row_index: null, created_at: '2026-09-01', is_simulated: false,
    });
    exportFahrtenbuch({
      trips: [trip('Cem', 'Ali', 'Ali'), trip('', 'Ben', 'Ben')] as never,
      month: 9, year: 2026, importFileName: 'x.xlsx', skipSort: true,
    });
    const wb = (XLSX.writeFile as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as XLSX.WorkBook;
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    expect(aoa[0]).toEqual([...FAHRTENBUCH_ORIGINAL_COLUMNS]);
    const di = FAHRTENBUCH_ORIGINAL_COLUMNS.indexOf('Fahrername');
    expect(aoa[1][di]).toBe('Cem');
    expect(aoa[2][di]).toBe('Ben');
    expect(aoa[1][FAHRTENBUCH_ORIGINAL_COLUMNS.indexOf('Fahrpreis')]).toBe(10.5);
    expect(aoa[1][0]).toBe('v:Datum/Uhrzeit Auftragseingang');
  });

  it('tripDriverName falls back and never throws on empties', () => {
    expect(tripDriverName({ assigned_driver_name: 'A', original_driver_name: 'B' })).toBe('A');
    expect(tripDriverName({ assigned_driver_name: '', original_driver_name: 'B' })).toBe('B');
    expect(tripDriverName({})).toBe('');
  });
});
