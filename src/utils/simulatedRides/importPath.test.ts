import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { FAHRTENBUCH_ORIGINAL_COLUMNS } from '../fahrtenbuchExport';
import { addDays, generateFromFigures, mondaysOfMonth } from './figures';
import { prepareSimulatedImport } from './importPath';
import { SIMULATED_NOTICE, SIMULATED_SHEET_NAME } from './marker';
import { formatPosition, ridesToRows } from './sheet';
import type { GeoPoint, PoolAddress } from './types';

const BASE: GeoPoint = { lat: 51.1657, lon: 7.0671 };
const POOL: PoolAddress[] = Array.from({ length: 400 }, (_, i) => ({
  label: `Teststraße ${i}, 42651 Solingen, Deutschland`,
  lat: 51.1 + Math.floor(i / 20) * 0.0055,
  lon: 7.0 + (i % 20) * 0.0085,
}));
const DRIVERS = ['Timo Hahn', 'Lena Müller', 'Chris Muster', 'Dana Probe', 'Emil Test', 'Fritz Demo'];
const INCOME = mondaysOfMonth(2026, 9).flatMap((monday, w) => DRIVERS.flatMap((name, d) => [
  { driver_name: name, type: 'umsatz', date: addDays(monday, 6), amount: 1100 + w * 90 + d * 130 + 0.41 },
  { driver_name: name, type: 'bargeld', date: addDays(monday, 6), amount: 250 + d },
  { driver_name: name, type: 'trinkgeld', date: addDays(monday, 6), amount: 30 },
]));
const month = generateFromFigures({
  year: 2026, month: 9, base: BASE, pool: POOL, seed: 7, income: INCOME, occupied: new Set(),
  vehicles: [{ plate: 'SG-YA15', type: 'Toyota Corolla Touring Sports' }, { plate: 'SG-YA18', type: 'Toyota Corolla Touring Sports' }],
  drivers: DRIVERS.map(name => ({ name })),
}).month;

describe('the generated sheet', () => {
  const rows = ridesToRows(month.rides);

  it('has exactly the 18 columns of the export, read from the one list that defines them', () => {
    for (const row of rows) expect(Object.keys(row)).toEqual([...FAHRTENBUCH_ORIGINAL_COLUMNS]);
  });

  it('writes the position as "lat lon" and empties as \\N, like the real file', () => {
    expect(formatPosition({ lat: 51.21507, lon: 7.01080 })).toBe('51.21507 7.0108');
    const cancelled = rows.find(r => r.Fahrtstatus === 'storniert')!;
    expect(cancelled['Uhrzeit des Fahrtbeginns']).toBe('\\N');
    expect(cancelled.Kilometer).toBe(0);
    expect(String(rows[0]['Standort des Fahrzeugs bei Auftragsuebermittlung'])).toMatch(/^-?\d+(\.\d+)? -?\d+(\.\d+)?$/);
    // Every row, not rows[0]. generateFromFigures sorts the rides by order
    // time, so row 0 is always the first ride of the earliest shift — the one
    // ride whose transmit is a whole-millisecond offset from the shift start.
    // Checking it alone could not see FB-HIGH-001's 23 % of malformed cells.
    for (const row of rows) {
      expect(String(row['Uhrzeit der Auftragsuebermittlung'])).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    }
  });
});

describe('the normal import path', () => {
  it('reads the generated file with the real parser: every ride has a real start, a key and a driver', async () => {
    const prepared = await prepareSimulatedImport({
      year: 2026, month: 9, seed: 7, rows: ridesToRows(month.rides),
      drivers: DRIVERS.map((name, i) => ({ id: `d${i}`, name })),
      cars: [{ id: 'c1', plate: 'SG-YA15' }, { id: 'c2', plate: 'SG-YA18' }],
    });
    expect(prepared.stats.heldBackNoDate).toBe(0);
    expect(prepared.inFileDuplicates).toBe(0);
    expect(prepared.trips.length).toBe(month.rides.length);
    const completed = prepared.trips.filter(t => !t.is_canceled);
    expect(completed.length).toBeGreaterThan(300);
    expect(completed.every(t => t.start_at !== null && t.time_source === 'source_start_end')).toBe(true);
    expect(completed.every(t => !t.needs_review)).toBe(true);
    expect(prepared.trips.every(t => t.source_row_key !== null)).toBe(true);
    expect(new Set(prepared.trips.map(t => t.source_row_key)).size).toBe(prepared.trips.length);
    expect(prepared.trips.every(t => t.original_driver_id !== null && t.car_id !== null)).toBe(true);
    expect(prepared.trips.some(t => t.is_canceled)).toBe(true);
  });

  it('keeps the real start in start_at when "Datum der Fahrt" is the day before', async () => {
    const prepared = await prepareSimulatedImport({
      year: 2026, month: 9, seed: 7, rows: ridesToRows(month.rides),
      drivers: DRIVERS.map((name, i) => ({ id: `d${i}`, name })), cars: [],
    });
    const early = prepared.trips.find(t => t.start_at && t.start_time && Number(t.start_time.slice(0, 2)) < 4);
    expect(early).toBeDefined();
    const startDay = new Date(early!.start_at!).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
    expect(startDay).not.toBe(early!.trip_date);
  });

  it('puts the ride sheet first and a sheet that says SIMULIERT second', async () => {
    const prepared = await prepareSimulatedImport({
      year: 2026, month: 9, seed: 7, rows: ridesToRows(month.rides.slice(0, 20)), drivers: [], cars: [],
    });
    const wb = XLSX.read(prepared.file.bytes, { type: 'array' });
    expect(wb.SheetNames).toEqual(['Sheet1', SIMULATED_SHEET_NAME]);
    expect(XLSX.utils.sheet_to_json<string[]>(wb.Sheets[SIMULATED_SHEET_NAME], { header: 1 })[0][0]).toBe(SIMULATED_NOTICE);
    expect(prepared.file.fileName.startsWith('SIMULIERT_')).toBe(true);
  });

  it('gives the same seed the same file hash, so generating twice is refused as a duplicate', async () => {
    const run = () => prepareSimulatedImport({ year: 2026, month: 9, seed: 7, rows: ridesToRows(month.rides), drivers: [], cars: [] });
    expect((await run()).fileSha256).toBe((await run()).fileSha256);
  });
});
