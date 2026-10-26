/**
 * FB-HIGH-001 — the order-transmission timestamp the generator writes.
 *
 * An external audit of a re-exported SIMULIERT month (fahrtenbuch234123.xlsx,
 * 255 rows, 2026-10-01 to 2026-10-04) found 52 cells of "Uhrzeit der
 * Auftragsuebermittlung" carrying two decimal points, among them
 *
 *   B2 (fine)  2026-10-01 18:30:00.146
 *   B3 (bad)   2026-10-01 18:49:25.441.665771484375
 *   B4 (bad)   2026-10-01 18:55:41.929.50390625
 *
 * Both halves of the cause are pinned here:
 *
 *   the producer  `approachDuringRide` measured `early` in fractional
 *                 milliseconds, so `orderTransmittedMs` was not a whole number
 *                 of milliseconds for the ~23 % of rides whose order reached
 *                 the car during the previous ride.
 *   the boundary  `formatStamp` printed `String(ms % 1000)`, which for a
 *                 fractional ms is "441.665771484375" where three digits
 *                 belong, and `padStart(3, '0')` leaves it.
 *
 * `DATETIME_RE` in fahrtenbuchImportParser is the one shape the importer
 * accepts and it admits exactly one fractional group of 1-9 digits. A second
 * dot is therefore not a question of precision: the value does not parse at
 * all. The row is still stored, so nothing downstream can read a time that
 * column is the key of.
 *
 * The old assertion on this shape (importPath.test.ts) checked `rows[0]` only,
 * and `generateFromFigures` sorts the rides by order-transmission time, so
 * row 0 is always the first ride of the earliest shift — the one ride that
 * takes `firstApproach`, whose transmit is a whole-millisecond offset from the
 * shift start. The assertion could not fail. Every test here reads every row.
 */
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import {
  DATETIME_RE, classifyTimestampCell, isMissingCell, wallAt, wallDate, wallTimeToInstant,
  SOURCE_TIME_ZONE, type RawRow,
} from '../fahrtenbuchImportParser';
import { FAHRTENBUCH_ORIGINAL_COLUMNS } from '../fahrtenbuchExport';
import { validateRides } from './generator';
import { addDays, generateFromFigures, mondaysOfMonth } from './figures';
import { prepareSimulatedImport } from './importPath';
import { ridesToRows } from './sheet';
import { formatStamp } from './time';
import type { GeneratedMonth, GeoPoint, PoolAddress, SimRide } from './types';

const BASE: GeoPoint = { lat: 51.1657, lon: 7.0671 };
const POOL: PoolAddress[] = Array.from({ length: 400 }, (_, i) => ({
  label: `Teststraße ${i}, 42651 Solingen, Deutschland`,
  lat: 51.1 + Math.floor(i / 20) * 0.0055,
  lon: 7.0 + (i % 20) * 0.0085,
}));
/** Seven names and four plates, as the audited file has. */
const DRIVERS = ['Timo Hahn', 'Lena Müller', 'Chris Muster', 'Dana Probe', 'Emil Test', 'Fritz Demo', 'Gerd Beispiel'];
const VEHICLES = [
  { plate: 'SG-YA12', type: 'Toyota Corolla Touring Sports' },
  { plate: 'SG-YA14', type: 'Toyota Corolla Touring Sports' },
  { plate: 'SG-YA15', type: 'Toyota Corolla Touring Sports' },
  { plate: 'SG-YA18', type: 'Toyota Corolla Touring Sports' },
];
const INCOME = mondaysOfMonth(2026, 9).flatMap((monday, w) => DRIVERS.flatMap((name, d) => [
  { driver_name: name, type: 'umsatz', date: addDays(monday, 6), amount: 1100 + w * 90 + d * 130 + 0.41 },
  { driver_name: name, type: 'bargeld', date: addDays(monday, 6), amount: 250 + d },
  { driver_name: name, type: 'trinkgeld', date: addDays(monday, 6), amount: 30 },
]));

const month: GeneratedMonth = generateFromFigures({
  year: 2026, month: 9, base: BASE, pool: POOL, seed: 7, income: INCOME, occupied: new Set(),
  vehicles: VEHICLES, drivers: DRIVERS.map(name => ({ name })),
}).month;
const rows: RawRow[] = ridesToRows(month.rides);

/** The five columns that hold a timestamp. "Datum der Fahrt" is a date alone. */
const TIMESTAMP_COLUMNS = [
  'Datum/Uhrzeit Auftragseingang',
  'Uhrzeit der Auftragsuebermittlung',
  'Geplante Abholzeit',
  'Uhrzeit des Fahrtbeginns',
  'Uhrzeit des Fahrtendes',
] as const;
const ORDER_COLUMN = 'Uhrzeit der Auftragsuebermittlung';

const dots = (s: string): number => (s.match(/\./g) ?? []).length;

/** The instant a Berlin wall-clock reading names, for building a fixture. */
function instant(year: number, month_: number, day: number, hour: number, minute: number, second: number): number {
  const result = wallTimeToInstant({ year, month: month_, day, hour, minute, second });
  if (result.kind !== 'ok') throw new Error('fixture wall time is not a unique instant');
  return result.ms;
}

describe('formatStamp writes a timestamp of whole milliseconds', () => {
  // The two cells the audit names, rebuilt from the fractional milliseconds
  // that produced them: 441.665771484375 and 929.50390625.
  const b3 = instant(2026, 10, 1, 18, 49, 25) + 441.665771484375;
  const b4 = instant(2026, 10, 1, 18, 55, 41) + 929.50390625;

  it('prints B3 of the evidence workbook as one fraction, not two', () => {
    expect(formatStamp(b3, true)).toBe('2026-10-01 18:49:25.441');
    expect(dots(formatStamp(b3, true))).toBe(1);
  });

  it('prints B4 of the evidence workbook as one fraction, not two', () => {
    expect(formatStamp(b4, true)).toBe('2026-10-01 18:55:41.929');
    expect(dots(formatStamp(b4, true))).toBe(1);
  });

  it('leaves a whole-millisecond instant exactly as it was, B2 included', () => {
    // B2 of the workbook: the 203 cells of the column that were already fine.
    expect(formatStamp(instant(2026, 10, 1, 18, 30, 0) + 146, true)).toBe('2026-10-01 18:30:00.146');
    expect(formatStamp(instant(2026, 9, 7, 7, 30, 0) + 534, true)).toBe('2026-09-07 07:30:00.534');
    expect(formatStamp(instant(2026, 9, 7, 7, 30, 0) + 5, true)).toBe('2026-09-07 07:30:00.005');
    expect(formatStamp(instant(2026, 9, 7, 7, 30, 0), true)).toBe('2026-09-07 07:30:00.000');
    expect(formatStamp(instant(2026, 9, 7, 7, 30, 0) + 534, false)).toBe('2026-09-07 07:30:00.000');
  });

  it('keeps the second it prints and the milliseconds it prints on the same instant', () => {
    // A fraction may not be rounded up into the next second: 999.7 ms is still
    // second 25, and a value printed as .000 of second 26 never happened.
    expect(formatStamp(instant(2026, 10, 1, 18, 49, 25) + 999.7, true)).toBe('2026-10-01 18:49:25.999');
  });

  it('writes what the published format accepts, for every value it can be given', () => {
    for (const ms of [b3, b4, instant(2026, 10, 1, 18, 30, 0) + 146, instant(2026, 3, 29, 5, 0, 0) + 0.5]) {
      const text = formatStamp(ms, true);
      expect(text).toMatch(DATETIME_RE);
      expect(classifyTimestampCell(text).kind).toBe('datetime');
    }
  });
});

describe('the published format, as the importer defines it', () => {
  it('accepts a longer fraction than the generator writes, up to nine digits', () => {
    expect(classifyTimestampCell('2026-10-01 18:49:25.441666').kind).toBe('datetime');
    expect(classifyTimestampCell('2026-10-01 18:49:25.441665771').kind).toBe('datetime');
  });

  it('does not accept the malformed value, so it was never a precision question', () => {
    expect('2026-10-01 18:49:25.441.665771484375').not.toMatch(DATETIME_RE);
    expect(classifyTimestampCell('2026-10-01 18:49:25.441.665771484375').kind).toBe('other');
    expect(classifyTimestampCell('2026-10-01 18:55:41.929.50390625').kind).toBe('other');
  });
});

describe('a generated month', () => {
  it('was built from four vehicles and more than one driver', () => {
    expect(new Set(month.rides.map(r => r.vehicle.plate)).size).toBe(4);
    expect(new Set(month.rides.map(r => r.driver.name)).size).toBeGreaterThan(1);
    expect(month.rides.length).toBeGreaterThan(200);
  });

  it('carries every instant as a whole number of milliseconds', () => {
    const fractional = month.rides.filter(r => [
      r.orderReceivedMs, r.orderTransmittedMs, r.plannedPickupMs, r.startMs, r.endMs,
    ].some(ms => ms !== null && !Number.isInteger(ms)));
    expect(fractional.map(r => r.orderTransmittedMs)).toEqual([]);
  });

  it('writes every timestamp cell in the one shape the importer accepts', () => {
    const bad: string[] = [];
    for (const [i, row] of rows.entries()) {
      for (const column of TIMESTAMP_COLUMNS) {
        const value = row[column];
        if (isMissingCell(value)) continue;
        const text = String(value);
        if (!DATETIME_RE.test(text) || dots(text) !== 1) bad.push(`row ${i + 1} ${column}: ${text}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('writes "Datum der Fahrt" as a date alone', () => {
    for (const row of rows) expect(String(row['Datum der Fahrt'])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('keeps a cancelled ride without clock times and at zero kilometres', () => {
    const cancelled = rows.filter(r => r.Fahrtstatus === 'storniert');
    expect(cancelled.length).toBeGreaterThan(0);
    for (const row of cancelled) {
      expect(row['Uhrzeit des Fahrtbeginns']).toBe('\\N');
      expect(row['Uhrzeit des Fahrtendes']).toBe('\\N');
      expect(row.Kilometer).toBe(0);
      // Its order time is a real timestamp: that is what keys the row.
      expect(String(row[ORDER_COLUMN])).toMatch(DATETIME_RE);
    }
  });
});

describe('validateRides reads the whole-millisecond rule back from the output', () => {
  // The rule is checked where every other rule of the brief is checked, so the
  // next writer of a ride instant cannot lose it silently: SimulatedRidesPage
  // refuses to build a file when validateRides reports anything.
  it('finds nothing in a month the generator built', () => {
    expect(validateRides(month, BASE)).toEqual([]);
  });

  it('names a ride whose order time is not a whole number of milliseconds', () => {
    const broken: SimRide[] = month.rides.map(r => ({ ...r }));
    broken[3] = { ...broken[3], orderTransmittedMs: broken[3].orderTransmittedMs + 0.665771484375 };
    const findings = validateRides({ ...month, rides: broken }, BASE);
    expect(findings.some(f => f.includes('orderTransmittedMs'))).toBe(true);
  });

  it('names a ride whose start is not a whole number of milliseconds', () => {
    const broken: SimRide[] = month.rides.map(r => ({ ...r }));
    const i = broken.findIndex(r => r.startMs !== null);
    broken[i] = { ...broken[i], startMs: (broken[i].startMs as number) + 0.5 };
    expect(validateRides({ ...month, rides: broken }, BASE).some(f => f.includes('startMs'))).toBe(true);
  });
});

describe('the round trip: generate, write the file, read it back with the real importer', () => {
  it('parses every timestamp of every written cell, and keeps the rows as they were', async () => {
    const prepared = await prepareSimulatedImport({
      year: 2026, month: 9, seed: 7, rows,
      drivers: DRIVERS.map((name, i) => ({ id: `d${i}`, name })),
      cars: VEHICLES.map((v, i) => ({ id: `c${i}`, plate: v.plate })),
    });

    // The sheet as the file holds it, read the way an upload is read.
    const wb = XLSX.read(prepared.file.bytes, { type: 'array', raw: true, cellDates: false });
    const back = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null, raw: true }) as RawRow[];
    expect(back.length).toBe(rows.length);

    const bad: string[] = [];
    for (const [i, row] of back.entries()) {
      for (const column of TIMESTAMP_COLUMNS) {
        const value = row[column];
        if (isMissingCell(value)) continue;
        const text = String(value);
        if (classifyTimestampCell(text).kind !== 'datetime' || dots(text) !== 1) bad.push(`row ${i + 1} ${column}: ${text}`);
      }
    }
    expect(bad).toEqual([]);

    // Nothing the generator wrote changed on the way through the file.
    for (const [i, row] of back.entries()) {
      for (const column of FAHRTENBUCH_ORIGINAL_COLUMNS) {
        expect(String(row[column])).toBe(String(rows[i][column]));
      }
    }

    // And the importer reads them: a real instant for every completed ride,
    // a key for every row, four cars and seven drivers matched.
    const completed = prepared.trips.filter(t => !t.is_canceled);
    expect(completed.every(t => t.start_at !== null && t.time_source === 'source_start_end')).toBe(true);
    expect(prepared.trips.every(t => t.source_row_key !== null)).toBe(true);
    expect(prepared.trips.every(t => t.source_row_key_basis === 'derived_order_transmission')).toBe(true);
    expect(new Set(prepared.trips.map(t => t.source_row_key)).size).toBe(prepared.trips.length);
    expect(new Set(prepared.trips.map(t => t.car_id)).size).toBe(4);
    expect(prepared.trips.every(t => t.car_id !== null && t.original_driver_id !== null)).toBe(true);
    expect(prepared.stats.heldBackNoDate).toBe(0);
    expect(prepared.stats.unreadableOrderTransmission).toBe(0);
    // A cancelled ride keeps its zero kilometres and no clock times.
    const cancelled = prepared.trips.filter(t => t.is_canceled);
    expect(cancelled.length).toBeGreaterThan(0);
    expect(cancelled.every(t => t.start_time === null && t.end_time === null && t.cash_amount === 0)).toBe(true);
  });
});

describe('FB-WARN-001: "Datum der Fahrt" against the day the ride began', () => {
  // The audit found 42 of 255 rows where the two differ. They are the rides
  // that start between midnight and 04:00: the operating day begins at 04:00
  // and rideDate() dates such a ride to the day before. That is deliberate and
  // the fix above does not touch it.
  //
  // What it is NOT is a property of a real Uber file. The 04:00 rule lives in
  // this module only: the import path takes "Datum der Fahrt" verbatim
  // (`buildTripRows` -> `parseDate`), merely counting a start that falls on
  // another day, and the parser's own header puts the real export's window at
  // 00:00 to 00:30. `sheet.ts` says it dates a ride "the way the real export
  // dates it", and the two statements do not agree. Whoever reconciles them
  // decides what the simulator should imitate; this test pins what it does.
  it('differs exactly for the rides that start before 04:00, and for no others', () => {
    const differing: number[] = [];
    const early: number[] = [];
    for (const [i, ride] of month.rides.entries()) {
      if (ride.startMs === null) continue;
      const startDay = wallDate(wallAt(ride.startMs, SOURCE_TIME_ZONE));
      const hour = wallAt(ride.startMs, SOURCE_TIME_ZONE).hour;
      if (startDay !== String(rows[i]['Datum der Fahrt'])) differing.push(i);
      if (hour < 4) early.push(i);
    }
    expect(differing).toEqual(early);
    expect(differing.length).toBeGreaterThan(0);
  });
});

describe('FB-WARN-002: a prebooked ride and its planned pickup', () => {
  // The audit found 11 prebooked rides starting 32 to 287 seconds before their
  // scheduled pickup. The generator does not model a booking made in advance:
  // it derives the planned pickup from the realised start, rounded up to the
  // next five minutes, so such a ride starts at or before its planned pickup
  // by less than 300 seconds and never after it. That asymmetry is recorded
  // here as the behaviour it is; a real file would hold late starts too.
  it('puts the planned pickup on the five-minute mark at or after the start', () => {
    const prebooked = month.rides.filter(r => r.prebooked && r.plannedPickupMs !== null && r.startMs !== null);
    expect(prebooked.length).toBeGreaterThan(0);
    for (const ride of prebooked) {
      const planned = ride.plannedPickupMs as number;
      const diff = (planned - (ride.startMs as number)) / 1000;
      expect(planned % 300_000).toBe(0);
      expect(diff).toBeGreaterThanOrEqual(0);
      expect(diff).toBeLessThan(300);
    }
  });

  it('gives a ride that was not prebooked no planned pickup at all', () => {
    expect(month.rides.filter(r => !r.prebooked).every(r => r.plannedPickupMs === null)).toBe(true);
  });
});
