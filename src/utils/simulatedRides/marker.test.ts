import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import type { FahrtenbuchTrip } from '../../hooks/useFahrtenbuch';
import { exportFahrtenbuch, exportFahrtenbuchAudit } from '../fahrtenbuchExport';
import { SIMULATED_FILE_PREFIX, SIMULATED_NOTICE, SIMULATED_SHEET_NAME, hasSimulatedRides, simulatedFileName } from './marker';

const written: { wb: XLSX.WorkBook; name: string }[] = [];

vi.mock('xlsx', async importOriginal => {
  const real = await importOriginal<typeof import('xlsx')>();
  const writeFile = (wb: XLSX.WorkBook, name: string) => { written.push({ wb, name }); };
  return { ...real, default: { ...real, writeFile }, writeFile };
});

function trip(over: Partial<FahrtenbuchTrip> = {}): FahrtenbuchTrip {
  return {
    id: 't1', company_id: 'c', import_id: 'i', trip_date: '2026-09-01', start_time: '08:00', end_time: '08:30',
    duration_minutes: 30, original_driver_id: null, original_driver_name: 'A', assigned_driver_id: null,
    assigned_driver_name: 'A', car_id: null, car_identifier: 'SG-YA15', route_start: 'x', route_end: 'y',
    description: null, price_amount: 10, cash_amount: 0, online_amount: 10, tip_amount: 0, action_amount: 0,
    raw_data_json: { 'Datum der Fahrt': '2026-09-01', Fahrername: 'A' }, plausibility_status: 'pending',
    is_canceled: false, source_status: 'abgeschlossen', assignment_reason: null, assignment_note: null,
    confirmed_by: null, confirmed_at: null, source_row_index: 1, created_at: '2026-09-02T00:00:00Z',
    updated_at: '2026-09-02T00:00:00Z', start_at: null, end_at: null, time_zone: null, time_source: null,
    trip_status: null, needs_review: false, review_reasons: [], currency: 'EUR', currency_source: 'assumed',
    source_row_key: null, source_row_key_basis: null,
    ...over,
  } as unknown as FahrtenbuchTrip;
}

const firstColumn = (wb: XLSX.WorkBook, sheet: string): unknown[] =>
  XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1 }).flat();

beforeEach(() => { written.length = 0; });

describe('the marker in the Fahrtenbuch XLSX', () => {
  it('a file built from a simulated ride carries the notice: sheet first, a line under the data, the file name', () => {
    exportFahrtenbuch({ trips: [trip({ is_simulated: true })], month: 9, year: 2026, importFileName: 'Fahrtenbuch.xlsx', sourceSheetName: 'Sheet1' });
    const { wb, name } = written[0];
    expect(name).toBe(`${SIMULATED_FILE_PREFIX}Fahrtenbuch.xlsx`);
    expect(wb.SheetNames[0]).toBe(SIMULATED_SHEET_NAME);
    expect(firstColumn(wb, SIMULATED_SHEET_NAME)).toContain(SIMULATED_NOTICE);
    expect(firstColumn(wb, 'Sheet1')).toContain(SIMULATED_NOTICE);
  });

  it('the audit workbook says so too', () => {
    exportFahrtenbuchAudit({ trips: [trip({ is_simulated: true })], month: 9, year: 2026 });
    expect(written[0].wb.SheetNames[0]).toBe(SIMULATED_SHEET_NAME);
    expect(written[0].name.startsWith(SIMULATED_FILE_PREFIX)).toBe(true);
  });

  it('one simulated ride among real ones is enough', () => {
    exportFahrtenbuch({ trips: [trip(), trip({ id: 't2', is_simulated: true })], month: 9, year: 2026, sourceSheetName: 'Sheet1' });
    expect(written[0].wb.SheetNames[0]).toBe(SIMULATED_SHEET_NAME);
  });

  it('control: real rides are exported exactly as before, with no notice anywhere', () => {
    exportFahrtenbuch({ trips: [trip(), trip({ id: 't2', is_simulated: false })], month: 9, year: 2026, importFileName: 'Fahrtenbuch.xlsx', sourceSheetName: 'Sheet1' });
    const { wb, name } = written[0];
    expect(name).toBe('Fahrtenbuch.xlsx');
    expect(wb.SheetNames).toEqual(['Sheet1']);
    expect(firstColumn(wb, 'Sheet1')).not.toContain(SIMULATED_NOTICE);
  });
});

describe('marker helpers', () => {
  it('hasSimulatedRides is true only for an explicit true', () => {
    expect(hasSimulatedRides([{}, { is_simulated: null }, { is_simulated: false }])).toBe(false);
    expect(hasSimulatedRides([{}, { is_simulated: true }])).toBe(true);
  });

  it('the file name prefix is added once', () => {
    expect(simulatedFileName('a.xlsx')).toBe('SIMULIERT_a.xlsx');
    expect(simulatedFileName('SIMULIERT_a.xlsx')).toBe('SIMULIERT_a.xlsx');
  });
});
