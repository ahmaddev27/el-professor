import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { toCents } from '../money';
import { generateFullMonth, type FullMonthDriver, type FullMonthInput, type FullMonthResult } from './fullMonth';
import { SIMULATED_SHEET_NAME, findSimulationMarker } from './marker';
import {
  AUDITOR_SHEET_NAME,
  CLOSING_SHEET_CALENDAR,
  CLOSING_SHEET_CHECKS,
  CLOSING_SHEET_ORDER,
  CLOSING_SHEET_PAY,
  CLOSING_SHEET_RIDES,
  CLOSING_SHEET_SHIFTS,
  CLOSING_SHEET_UBER,
  CLOSING_SHEET_VEHICLES,
  LABEL,
  NOT_READ_SALARIES,
  NO_ACTUAL_HOURS,
  NO_GROSS_WAGE,
  FARE_GAP_HEADER,
  FARE_GAP_TOTAL_LABEL,
  FARE_UNREADABLE,
  NO_UBER_ROW,
  SHARE_HEADER,
  UBER_NOT_READ,
  PURPOSE_WORD,
  WEEKS_ROW_LABEL,
  buildMonthClosing,
  commissionCents,
  shiftsSheetRows,
} from './monthClosing';
import { STATUS_WORD, TOTAL_LABEL, reportRides } from './monthWorkbook';
import { verifyMonth } from './monthVerification';
import { noRealTrips, readRealTrips, type RealTripDriverRef, type RealTripRow } from './realTrips';
import type { ReconcileUber } from './reconciliation';
import { ESTIMATE_TRAVEL_MODEL, type TravelModel } from './travelModel';
import type { UberDriverDay, UberFigures, UberPeriodTotal } from './uberImport';
import type { GeoPoint, PoolAddress } from './types';

/**
 * FleetBook round 8, section 10 and test class 26: the month's closing
 * workbook. Seven sheets that reconcile with each other, real trips printed
 * exactly as imported, every row labelled with where it came from, and the
 * negatives the auditor asked for (section 12): a month whose Uber figures
 * were not read, whose share is not set, or whose tip could not be placed says
 * INCOMPLETE or "nicht gelesen", never a fabricated zero.
 *
 * Everything below is invented: public repository, no real person, plate or address.
 */

const ALPHA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BETA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ZONE = 'Europe/Berlin';

const BASE: GeoPoint = { lat: 51.1657, lon: 7.0671 };
const POOL: PoolAddress[] = Array.from({ length: 40 }, (_, i) => ({
  label: `Teststraße ${i + 1}, 42651 Solingen, Deutschland`,
  lat: 51.1 + Math.floor(i / 8) * 0.0055,
  lon: 7.0 + (i % 8) * 0.0085,
}));
const VEHICLES = [
  { id: '11111111-1111-4111-8111-111111111111', plate: 'XX-TB1', type: 'Mietwagen' },
  { id: '22222222-2222-4222-8222-222222222222', plate: 'XX-TB2', type: 'Mietwagen' },
];
const RANGE = { planning_min_salary: 600, planning_max_salary: 1200, planning_hourly_rate: 13 } as const;
// Alpha has a commission rate, Beta none: the second is a negative of its own.
const DRIVERS: FullMonthDriver[] = [
  { id: ALPHA, name: 'Fahrer Alpha', salary_ratio: 0.45, ...RANGE },
  { id: BETA, name: 'Fahrer Beta', ...RANGE },
];
const DRIVER_REFS: RealTripDriverRef[] = DRIVERS.map(d => ({ id: d.id, name: d.name }));
const ROUTED: TravelModel = { source: 'test-router', measured: true, drive: ESTIMATE_TRAVEL_MODEL.drive, ride: ESTIMATE_TRAVEL_MODEL.ride };

const figures = (over: Partial<UberFigures> = {}): UberFigures =>
  ({ umsatzCents: 0, aktionenCents: 0, trinkgeldCents: 0, bargeldCents: 0, tripCount: null, ...over });
const uberDay = (driverId: string, date: string, over: Partial<UberFigures>): UberDriverDay => ({
  driverId, driverName: driverId === ALPHA ? 'Fahrer Alpha' : 'Fahrer Beta', date, figures: figures(over),
  identity: 'partner_link', rowIds: [`${driverId}-${date}`], negativeTypes: [], overlapsPeriod: false,
});
const uberPeriod = (driverId: string, from: string, to: string, placement: UberPeriodTotal['placement'], over: Partial<UberFigures>): UberPeriodTotal => ({
  driverId, driverName: 'Fahrer Beta', periodStart: from, periodEnd: to, days: 7, placement, figures: figures(over),
  identity: 'partner_link', rowIds: [`${driverId}-${from}-${to}`], negativeTypes: [], overlappingDailyDates: [],
});

const SEPTEMBER_DAYS = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
// Alpha every day; Beta daily up to the 27th, then a week that runs into October.
const UBER: ReconcileUber = {
  days: SEPTEMBER_DAYS.flatMap((date, i) => [
    uberDay(ALPHA, date, { umsatzCents: 18_000 + i * 37, trinkgeldCents: i % 4 === 0 ? 0 : 301 + i * 7, aktionenCents: 500, tripCount: 9 }),
    ...(i < 27 ? [uberDay(BETA, date, { umsatzCents: 15_500 + i * 11, trinkgeldCents: i % 5 === 0 ? 0 : 199 + i, tripCount: 8 })] : []),
  ]),
  periods: [uberPeriod(BETA, '2026-09-28', '2026-10-04', 'crosses_month_boundary', { umsatzCents: 70_000, trinkgeldCents: 900 })],
  handRows: [],
  issues: [],
};

let nextId = 1;
const realRow = (over: Partial<RealTripRow> = {}): RealTripRow => ({
  id: `trip-${String(nextId++).padStart(4, '0')}`,
  import_id: 'import-2026-09',
  trip_date: '2026-09-08',
  start_at: '2026-09-08T08:00:00Z',
  end_at: '2026-09-08T08:25:00Z',
  start_time: '10:00:00',
  end_time: '10:25:00',
  original_driver_id: ALPHA,
  original_driver_name: 'Fahrer Alpha',
  car_identifier: 'XX-TB1',
  route_start: 'Teststraße 1, 42651 Solingen',
  route_end: 'Teststraße 9, 42651 Solingen',
  price_amount: '8.70',
  tip_amount: '1.30',
  cash_amount: '0.00',
  online_amount: '8.70',
  action_amount: '0.00',
  is_canceled: false,
  trip_status: 'completed',
  declined_fee_cents: null,
  source_row_key: 'uber:abc',
  is_simulated: false,
  ...over,
});
// Alpha drove real trips on Tuesday 8 September: two completed, one cancelled,
// and one order he declined, which is no ride of the book.
const REAL_ROWS = [
  realRow({ id: 'r-1', source_row_key: 'uber:r1' }),
  realRow({ id: 'r-2', start_at: '2026-09-08T09:10:00Z', end_at: '2026-09-08T09:40:00Z', price_amount: '19.80', source_row_key: 'uber:r2' }),
  realRow({ id: 'r-3', start_at: '2026-09-08T13:00:00Z', end_at: '2026-09-08T13:20:00Z', is_canceled: true, trip_status: 'cancelled', price_amount: '5.00', source_row_key: 'uber:r3' }),
  realRow({ id: 'r-4', start_at: '2026-09-08T15:00:00Z', end_at: '2026-09-08T15:00:00Z', trip_status: 'declined', price_amount: '0.00', declined_fee_cents: 600, source_row_key: 'uber:r4' }),
];
const realRead = readRealTrips({ year: 2026, month: 9, rows: REAL_ROWS, drivers: DRIVER_REFS, timeZone: ZONE, operatingDayStartHour: 4 });

const monthInput = (over: Partial<FullMonthInput> = {}): FullMonthInput => ({
  year: 2026, month: 9, base: BASE, baseSource: 'saved_point', baseLabel: 'Betriebssitz Test', pool: POOL, vehicles: VEHICLES,
  drivers: DRIVERS, driverNotesMap: new Map(), seed: 2713, shiftsPerVehicleDay: 3, travel: ROUTED, realTrips: realRead,
  uber: UBER, shareSetting: { mode: 'fixed', percent: 32 }, returnToBase: true,
  settings: { declinedRidesEnabled: true, declinedFeeCents: 600, cancellationFeeEnabled: true, cancellationFeeCents: 600 },
  options: { cancellationShare: 0.1 }, ...over,
});
function run(over: Partial<FullMonthInput> = {}): FullMonthResult {
  const out = generateFullMonth(monthInput(over));
  if (!out.ok) throw new Error(`generation refused: ${JSON.stringify(out.failure)}`);
  return out.result;
}

type Rows = (string | number | boolean | null)[][];
const sheetOf = (result: FullMonthResult, name: string): Rows =>
  buildMonthClosing(result).payload.sheets.find(s => s.name === name)!.rows as Rows;
const column = (rows: Rows, header: string): number => {
  const at = rows[0].indexOf(header);
  if (at === -1) throw new Error(`no column ${header}`);
  return at;
};
const cents = (v: unknown): number => toCents(Number(v));
const checkValue = (rows: Rows, what: string): unknown => rows.find(r => r[2] === what)?.[3];
const book = (rows: unknown[][]): XLSX.WorkBook => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return wb;
};

const month = run();
const closing = buildMonthClosing(month);
const rides = closing.payload.sheets.find(s => s.name === CLOSING_SHEET_RIDES)!.rows as Rows;
const calendar = sheetOf(month, CLOSING_SHEET_CALENDAR);
const totalRow = calendar[calendar.length - 1];

describe('the workbook as a whole', () => {
  it('is named with the month, seed and verdict, and holds the seven sheets in the auditor\'s order, the notice last', () => {
    const verdict = verifyMonth(month).verdict;
    expect(closing.fileName).toBe(`SIMULIERT_Monatsabschluss_2026-09_2713_${verdict}.xlsx`);
    expect(closing.payload.sheets.map(s => s.name)).toEqual(CLOSING_SHEET_ORDER);
    expect(CLOSING_SHEET_ORDER[CLOSING_SHEET_ORDER.length - 1]).toBe(SIMULATED_SHEET_NAME);
    expect(Object.keys(AUDITOR_SHEET_NAME)).toEqual(CLOSING_SHEET_ORDER.slice(0, 7));
  });

  it('labels every row of every data sheet with where it came from, in the first column', () => {
    for (const sheet of closing.payload.sheets.filter(s => s.name !== SIMULATED_SHEET_NAME)) {
      expect(sheet.rows[0][0], sheet.name).toBe('Kennzeichnung');
      for (const row of sheet.rows.slice(1)) expect(Object.values(LABEL), sheet.name).toContain(row[0]);
    }
  });

  it('an estimate-only month says so in its name and in sheet 7, never "0 routing errors"', () => {
    const estimate = run({ travel: undefined });
    const verification = verifyMonth(estimate);
    expect(verification.routing).toBe('estimate');
    expect(buildMonthClosing(estimate).fileName).toMatch(/_ESTIMATE_ONLY\.xlsx$/);
    expect(checkValue(sheetOf(estimate, CLOSING_SHEET_CHECKS), 'Routing')).toBe('nur Schaetzung');
  });

  it('a month too large for the export contract is refused here, with the reason, instead of failing at the service', () => {
    const leg = month.repositioning[0];
    const huge = { ...month, repositioning: Array.from({ length: 100_001 }, () => leg) };
    expect(() => buildMonthClosing(huge)).toThrow(/Zeilen|Zellen|rows|cells/);
  });
});

describe('sheet 1, the Fahrtenbuch: real trips unchanged, no declined order of either kind', () => {
  const status = column(rides, 'Status');
  const id = column(rides, 'Fahrt-ID');
  const fare = column(rides, 'Fahrpreis (EUR)');

  it('prints every real trip that is a ride, exactly as imported', () => {
    const imported = rides.filter(r => r[0] === LABEL.imported);
    expect(imported.map(r => r[id]).sort()).toEqual(['r-1', 'r-2', 'r-3']);
    for (const trip of realRead.trips.filter(t => t.status !== 'declined')) {
      const r = imported.find(x => x[id] === trip.tripId)!;
      expect(cents(r[fare])).toBe(trip.fareCents);
      expect(r[column(rides, 'Trinkgeld (EUR)')]).toBe((trip.tipCents as number) / 100);
      expect(r[column(rides, 'Abholort')]).toBe(trip.pickup);
      expect(r[column(rides, 'Zielort')]).toBe(trip.destination);
      expect(r[column(rides, 'Quellzeilen-Schluessel')]).toBe(trip.sourceRowKey);
      expect(r[column(rides, 'Import-ID')]).toBe('import-2026-09');
      expect(r[column(rides, 'Finanzstatus')]).toBe('wie importiert, unveraendert');
    }
    expect(imported.find(r => r[id] === 'r-3')![status]).toBe(STATUS_WORD.cancelled);
  });

  it('leaves the declined real order out and counts it in sheet 7; no simulated declined order either', () => {
    expect(rides.some(r => r[id] === 'r-4')).toBe(false);
    expect(rides.slice(1).some(r => r[status] === STATUS_WORD.declined || r[status] === 'declined')).toBe(false);
    expect(month.month.rides.some(r => r.status === 'declined')).toBe(true);
    expect(checkValue(sheetOf(month, CLOSING_SHEET_CHECKS), 'Abgelehnte echte Auftraege (nicht im Fahrtenbuch)')).toBe(1);
  });

  it('carries every simulated ride of the export scope, and none on the driver-day that was real', () => {
    const simulated = rides.filter(r => r[0] === LABEL.simulated);
    expect(simulated).toHaveLength(reportRides(month).length);
    const driver = column(rides, 'Fahrer-ID');
    const day = column(rides, 'Betriebstag');
    expect(simulated.some(r => r[driver] === ALPHA && r[day] === '2026-09-08')).toBe(false);
  });
});

describe('the sheets reconcile with each other (sheets 1, 4 and 6)', () => {
  const at = (header: string) => column(calendar, header);
  const fare = column(rides, 'Fahrpreis (EUR)');
  const status = column(rides, 'Status');

  it('one row per calendar day, then the weekly values, then the total; a day without activity says so', () => {
    expect(calendar).toHaveLength(1 + 30 + 2);
    expect(calendar[31][1]).toBe(WEEKS_ROW_LABEL);
    expect(totalRow[1]).toBe(TOTAL_LABEL);
    for (const r of calendar.slice(1, 31)) expect(['Ja', 'Nein']).toContain(r[at('Tag ohne Aktivitaet')]);
  });

  it('the simulated fares of sheet 1 are the calendar total and the day summaries', () => {
    const sheet1 = rides.filter(r => r[0] === LABEL.simulated && r[status] === STATUS_WORD.completed)
      .reduce((n, r) => n + cents(r[fare]), 0);
    expect(cents(totalRow[at('Fahrpreise simuliert (EUR)')])).toBe(sheet1);
    expect(sheet1).toBe(month.days.reduce((n, d) => n + d.fareCents, 0));
  });

  it('the real fares of sheet 1 are the calendar total, completed rides only', () => {
    const sheet1 = rides.filter(r => r[0] === LABEL.imported && r[status] === STATUS_WORD.completed)
      .reduce((n, r) => n + cents(r[fare]), 0);
    expect(sheet1).toBe(870 + 1980);
    expect(cents(totalRow[at('Fahrpreise echt (EUR, importiert)')])).toBe(sheet1);
  });

  it('Uber\'s Umsatz in sheet 4 is the calendar total and the reconciliation\'s, the week across the boundary excluded', () => {
    const uber = sheetOf(month, CLOSING_SHEET_UBER);
    const kind = column(uber, 'Zeilenart');
    const umsatz = column(uber, 'Umsatz (EUR, importiert)');
    const rows = uber.filter(r => r[kind] === 'Tag' || r[kind] === 'Woche im Monat');
    // A simulated driver-day Uber has no row for says so; it is not a zero.
    const absent = rows.filter(r => typeof r[umsatz] !== 'number');
    for (const r of absent) {
      expect(r[umsatz]).toBe(NO_UBER_ROW);
      expect(r[column(uber, 'Hinweise')]).toMatch(/kein Uber-Wert fuer diesen Fahrertag/);
    }
    const counted = rows.filter(r => typeof r[umsatz] === 'number').reduce((n, r) => n + cents(r[umsatz]), 0);
    expect(counted).toBe(month.financial.totals.umsatzCents);
    expect(cents(totalRow[at('Umsatz importiert (EUR)')])).toBe(counted);
    const across = uber.filter(r => String(r[kind]).startsWith('Woche ueber die Monatsgrenze'));
    expect(across).toHaveLength(1);
    expect(across[0][column(uber, 'Status')]).toBe('INCOMPLETE');
    // Every daily Uber row, and not the 700 EUR week that runs into October.
    expect(counted).toBe(UBER.days.reduce((n, d) => n + d.figures.umsatzCents, 0));
  });

  it('the tips placed on rides and the share are the reconciliation\'s figures', () => {
    expect(cents(totalRow[at('Trinkgeld simuliert (EUR)')])).toBe(month.financial.totals.tipsAllocatedCents);
    expect(cents(totalRow[at(SHARE_HEADER)])).toBe(month.financial.totals.shareCents);
    expect(month.financial.totals.shareCents).toBeGreaterThan(0);
  });
});

describe('sheets 2 and 5: shifts and empty drives', () => {
  const shifts = sheetOf(month, CLOSING_SHEET_SHIFTS);
  const vehicles = sheetOf(month, CLOSING_SHEET_VEHICLES);
  const kind = column(vehicles, 'Zeilenart');
  const shiftId = column(vehicles, 'Schicht-ID');
  const emptyKm = column(vehicles, 'Leer-km');

  it('one row per simulated shift, each starting at the company\'s base', () => {
    expect(shifts.length - 1).toBe(month.month.shifts.length);
    for (const r of shifts.slice(1)) expect(r[column(shifts, 'Startbasis')]).toBe('Betriebssitz Test');
  });

  it('a shift over six hours, or one that ran past its planned end, is flagged for checking, never passed', () => {
    const s0 = month.month.shifts[0];
    const minute = 60_000;
    const stretched = { ...month, month: { ...month.month, shifts: [{ ...s0, plannedEndMs: s0.startMs + 380 * minute, endMs: s0.startMs + 400 * minute }] } };
    const [header, row] = shiftsSheetRows(stretched);
    expect(row[header.indexOf('Pausen')]).toMatch(/^Pause erforderlich, nicht geplant/);
    expect(row[header.indexOf('Abweichung')]).toBe('Ende 20 Min nach dem geplanten Ende');
    expect(row[header.indexOf('Dienststunden (simuliert)')]).toBe(6.67);
    expect(row[header.indexOf('Status')]).toBe('zu pruefen');
    const ordinary = shifts.find(r => r[column(shifts, 'Schicht-ID')] === s0.id)!;
    expect(ordinary[column(shifts, 'Status')]).toBe('SIMULIERT - kein Arbeitszeitnachweis');
  });

  it('each shift\'s empty kilometres are the sum of its empty drives', () => {
    for (const summary of vehicles.filter(r => r[kind] === 'Schicht')) {
      const legs = vehicles.filter(r => r[kind] === 'Leerfahrt' && r[shiftId] === summary[shiftId]);
      expect(legs.length).toBeGreaterThan(0);
      expect(cents(summary[emptyKm])).toBe(legs.reduce((n, r) => n + cents(r[emptyKm]), 0));
    }
  });

  it('with the return to base on, every shift ends with a drive to the base, coordinates and all', () => {
    const purpose = column(vehicles, 'Zweck');
    const shiftsWithReturn = new Set(vehicles.filter(r => r[purpose] === PURPOSE_WORD.to_base).map(r => r[shiftId]));
    expect(shiftsWithReturn.size).toBe(month.month.shifts.length);
    for (const r of vehicles.filter(x => x[purpose] === PURPOSE_WORD.to_base)) {
      expect(r[column(vehicles, 'Ziel Breite')]).toBe(BASE.lat);
      expect(r[column(vehicles, 'Ziel Laenge')]).toBe(BASE.lon);
      expect(typeof r[column(vehicles, 'Start Breite')]).toBe('number');
    }
    const checks = sheetOf(month, CLOSING_SHEET_CHECKS);
    expect(checkValue(checks, 'Rueckkehr zum Betriebssitz am Schichtende')).toBe('Ja');
    // The file states the base it was checked against, so a reader re-derives the returns from its own bytes.
    expect([checkValue(checks, 'Betriebssitz Breite'), checkValue(checks, 'Betriebssitz Laenge')]).toEqual([BASE.lat, BASE.lon]);
  });

  it('with the return to base off, no shift has one', () => {
    const off = sheetOf(run({ returnToBase: false }), CLOSING_SHEET_VEHICLES);
    expect(off.some(r => r[column(off, 'Zweck')] === PURPOSE_WORD.to_base)).toBe(false);
  });
});

describe('sheet 3: pay and working time, with no figure called a salary', () => {
  const pay = sheetOf(month, CLOSING_SHEET_PAY);
  const driver = column(pay, 'Fahrer-ID');
  const commission = column(pay, 'Provision nach Regel (EUR, berechnet, nicht gebucht)');

  it('booked salaries, actual hours and a gross wage are named as unavailable, never filled in', () => {
    for (const r of pay.slice(1)) {
      expect(r[column(pay, 'Gebuchtes Gehalt')]).toBe(NOT_READ_SALARIES);
      expect(r[column(pay, 'Tatsaechliche Stunden')]).toBe(NO_ACTUAL_HOURS);
      expect(r[column(pay, 'Bruttolohn')]).toBe(NO_GROSS_WAGE);
    }
  });

  it('every money header about pay says whether it is configuration, simulated, or computed and not booked', () => {
    for (const sheet of closing.payload.sheets) {
      for (const header of sheet.rows[0] ?? []) {
        const h = String(header);
        if (!/(Lohn|Gehalt|Provision)/.test(h) || !/EUR/.test(h)) continue;
        expect(h, `${sheet.name}: ${h}`).toMatch(/Konfiguration|simuliert|nicht gebucht/);
      }
    }
  });

  it('the commission is the product\'s rule on Uber\'s figures; a driver without a rate gets none, and says why', () => {
    const alphaRows = [...month.financial.days, ...month.financial.periods.filter(p => p.placement === 'inside_month')]
      .filter(r => r.driverId === ALPHA);
    const expected = alphaRows.reduce((n, r) => n + (commissionCents(r, 4500) as number), 0);
    const alpha = pay.find(r => r[driver] === ALPHA)!;
    expect(cents(alpha[commission])).toBe(expected);
    const beta = pay.find(r => r[driver] === BETA)!;
    expect(beta[commission]).toBe('');
    expect(beta[column(pay, 'Offene Punkte')]).toMatch(/kein Provisionssatz/);
  });

  it('rounds the commission once per Uber row and adds the tip in full', () => {
    expect(commissionCents({ umsatzCents: 1001, aktionenCents: 0, tipsImportedCents: 250 }, 4500)).toBe(450 + 250);
    expect(commissionCents({ umsatzCents: 1000, aktionenCents: 0, tipsImportedCents: 0 }, null)).toBeNull();
  });
});

describe('negatives: a missing input is said, never a fabricated zero', () => {
  it('Uber not read: sheets 3, 4 and 6 say "nicht gelesen" where a figure would be, the financial status is INCOMPLETE', () => {
    const blind = run({ uber: undefined });
    expect(blind.financial.status).toBe('INCOMPLETE');
    const pay = sheetOf(blind, CLOSING_SHEET_PAY);
    for (const r of pay.slice(1)) {
      expect(r[column(pay, 'Umsatz importiert (EUR)')]).toBe('nicht gelesen');
      expect(r[column(pay, 'Provision nach Regel (EUR, berechnet, nicht gebucht)')]).toBe('');
      expect(r[column(pay, 'Offene Punkte')]).toMatch(/Uber-Zahlen nicht gelesen/);
    }
    const uber = sheetOf(blind, CLOSING_SHEET_UBER);
    const dayRows = uber.filter(r => r[column(uber, 'Zeilenart')] === 'Tag');
    expect(dayRows.length).toBeGreaterThan(0);
    for (const r of dayRows) {
      expect(r[column(uber, 'Umsatz (EUR, importiert)')]).toBe(UBER_NOT_READ);
      expect(r[column(uber, 'Trinkgeld importiert (EUR)')]).toBe(UBER_NOT_READ);
    }
    const calendar = sheetOf(blind, CLOSING_SHEET_CALENDAR);
    for (const r of calendar.slice(1)) {
      expect(r[column(calendar, 'Umsatz importiert (EUR)')]).toBe(UBER_NOT_READ);
      expect(r[column(calendar, SHARE_HEADER)]).toBe(UBER_NOT_READ);
    }
    const checks = sheetOf(blind, CLOSING_SHEET_CHECKS);
    expect(checkValue(checks, 'Finanzabgleich mit Uber (getrennt vom Exportstatus)')).toBe('INCOMPLETE');
    expect(checkValue(checks, 'Pruefsumme Uber-Zahlen')).toBe('nicht gelesen');
  });

  it('share not configured: no share is computed anywhere and sheet 7 says it is not set', () => {
    const unset = run({ shareSetting: null });
    const uber = sheetOf(unset, CLOSING_SHEET_UBER);
    const share = column(uber, SHARE_HEADER);
    for (const r of uber.slice(1)) expect(r[share]).toBe('');
    expect(checkValue(sheetOf(unset, CLOSING_SHEET_CHECKS), 'Einstellung')).toMatch(/^nicht festgelegt/);
  });

  it('sheet 7 names where the settings came from, and a typed-in rate never reads as the company\'s', () => {
    expect(checkValue(sheetOf(month, CLOSING_SHEET_CHECKS), 'Einstellung aus')).toBe('Firmeneinstellung (company_simulation_settings)');
    const typed = run({ settingsSource: 'script_arguments' });
    expect(checkValue(sheetOf(typed, CLOSING_SHEET_CHECKS), 'Einstellung aus')).toMatch(/^Skriptargumente \(--share-percent/);
    expect(typed.provenance.runId).not.toBe(month.provenance.runId);
  });

  it('a tip Uber reported on a day with no simulated ride is INCOMPLETE, not a difference of zero', () => {
    const uber = sheetOf(month, CLOSING_SHEET_UBER);
    const row = uber.find(r => r[column(uber, 'Zeilenart')] === 'Tag' && r[column(uber, 'Fahrer-ID')] === ALPHA && r[column(uber, 'Datum')] === '2026-09-08')!;
    expect(cents(row[column(uber, 'Trinkgeld importiert (EUR)')])).toBeGreaterThan(0);
    expect(cents(row[column(uber, 'Trinkgeld verteilt (EUR, simuliert)')])).toBe(0);
    expect(row[column(uber, 'Status')]).toBe('INCOMPLETE');
    expect(row[column(uber, 'Hinweise')]).toMatch(/Trinkgeld: keine simulierte Fahrt/);
  });

  it('real trips not read: sheet 7 says so instead of naming no import', () => {
    const checks = sheetOf(run({ realTrips: undefined }), CLOSING_SHEET_CHECKS);
    expect(checkValue(checks, 'Import-IDs der echten Fahrten')).toBe('nicht gelesen');
    expect(checkValue(checks, 'Abgelehnte echte Auftraege (nicht im Fahrtenbuch)')).toBe('nicht gelesen');
    const none = sheetOf(run({ realTrips: noRealTrips() }), CLOSING_SHEET_CHECKS);
    expect(checkValue(none, 'Import-IDs der echten Fahrten')).toBe('keine');
  });
});

describe('sheet 4: the month never reads better than its own rows (D1, owner 27.11.2026)', () => {
  const rowStatuses = (r: FullMonthResult): unknown[] => {
    const uber = sheetOf(r, CLOSING_SHEET_UBER);
    const kind = column(uber, 'Zeilenart');
    return uber.slice(1).filter(x => x[kind] === 'Tag' || String(x[kind]).startsWith('Woche')).map(x => x[column(uber, 'Status')]);
  };
  // Both drivers every day, no week; Alpha's real day carries no tip, so nothing is left unplaced.
  const fullUber: ReconcileUber = {
    days: SEPTEMBER_DAYS.flatMap((date, i) => [
      uberDay(ALPHA, date, { umsatzCents: 18_000 + i * 37, trinkgeldCents: date === '2026-09-08' ? 0 : 301 + i * 7, tripCount: 9 }),
      uberDay(BETA, date, { umsatzCents: 15_500 + i * 11, trinkgeldCents: 199 + i, tripCount: 8 }),
    ]),
    periods: [],
  };
  const reconciled = run({ uber: fullUber });

  it('reads RECONCILED on every row, on sheet 7 and as a month, when every figure is placed', () => {
    expect(reconciled.financial.reasons).toEqual([]);
    expect(reconciled.financial.status).toBe('RECONCILED');
    expect(new Set(rowStatuses(reconciled))).toEqual(new Set(['RECONCILED']));
    expect(checkValue(sheetOf(reconciled, CLOSING_SHEET_CHECKS), 'Finanzabgleich mit Uber (getrennt vom Exportstatus)')).toBe('RECONCILED');
  });

  it('reads INCOMPLETE on a week across the month boundary, which is not in the month at all, even with no tip', () => {
    const crossing = run({ uber: { ...fullUber, periods: [uberPeriod(BETA, '2026-09-28', '2026-10-04', 'crosses_month_boundary', { umsatzCents: 70_000 })] } });
    const uber = sheetOf(crossing, CLOSING_SHEET_UBER);
    const week = uber.filter(r => String(r[column(uber, 'Zeilenart')]).startsWith('Woche ueber die Monatsgrenze'));
    expect(week).toHaveLength(1);
    expect(week[0][column(uber, 'Status')]).toBe('INCOMPLETE');
    expect(crossing.financial.reasons).toEqual(['week_across_boundary']);
    expect(crossing.financial.status).toBe('INCOMPLETE');
  });

  it('reads CONFIGURATION_REQUIRED on every row and as a month with the same figures and no rate', () => {
    const unset = run({ uber: fullUber, shareSetting: null });
    expect(unset.financial.status).toBe('CONFIGURATION_REQUIRED');
    expect(new Set(rowStatuses(unset))).toEqual(new Set(['CONFIGURATION_REQUIRED']));
  });

  it('prints the company share as the formula\'s result and names it on sheet 7', () => {
    const uber = sheetOf(reconciled, CLOSING_SHEET_UBER);
    const formula = column(uber, 'Formelergebnis (EUR, Unternehmensanteil = Umsatz x Satz)');
    for (const r of uber.slice(1)) expect(r[formula]).toBe(r[column(uber, SHARE_HEADER)]);
    expect(checkValue(sheetOf(reconciled, CLOSING_SHEET_CHECKS), 'Anteil: Bedeutung')).toMatch(/^Unternehmensanteil \(D1/);
  });

  it.each<[string, () => FullMonthResult]>([
    ['the fixture month (a week across the boundary, a real day with a tip)', () => month],
    ['no share rate', () => run({ shareSetting: null })],
    ['Uber not read', () => run({ uber: undefined })],
    ['every figure placed', () => reconciled],
  ])('%s: a row that is not reconciled keeps the month from reading reconciled', (_name, get) => {
    const r = get();
    const rows = rowStatuses(r);
    if (rows.some(x => x !== 'RECONCILED')) expect(r.financial.status).not.toBe('RECONCILED');
    if (r.financial.status === 'RECONCILED') expect(rows.every(x => x === 'RECONCILED')).toBe(true);
  });
});

describe('sheet 4: the gap between Uber\'s turnover and the fares is shown, never closed (D1, owner 27.11.2026)', () => {
  const dayRows = (r: FullMonthResult): Rows => {
    const uber = sheetOf(r, CLOSING_SHEET_UBER);
    return uber.slice(1).filter(x => x[column(uber, 'Zeilenart')] === 'Tag');
  };
  const header = sheetOf(month, CLOSING_SHEET_UBER);
  const at = (h: string) => column(header, h);

  it('is Umsatz minus simulated and real fares on every day with figures, to the cent', () => {
    let checked = 0;
    for (const r of dayRows(month)) {
      const gap = r[at(FARE_GAP_HEADER)];
      if (typeof gap !== 'number') continue;
      const real = r[at('Echte Fahrpreise (EUR, importiert)')];
      expect(cents(gap)).toBe(cents(r[at('Umsatz (EUR, importiert)')]) - cents(r[at('Simulierte Fahrpreise (EUR, nicht tatsaechlich)')])
        - (real === '' ? 0 : cents(real)));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('counts the real fares of a day the driver drove for real', () => {
    const row = dayRows(month).find(r => r[at('Fahrer-ID')] === ALPHA && r[at('Datum')] === '2026-09-08')!;
    expect(row[at('Echte Fahrpreise (EUR, importiert)')]).toBe(28.5);
    expect(cents(row[at(FARE_GAP_HEADER)])).toBe(cents(row[at('Umsatz (EUR, importiert)')]) - cents(row[at('Simulierte Fahrpreise (EUR, nicht tatsaechlich)')]) - 2_850);
  });

  it('says why there is no gap instead of printing 0, and leaves weeks and open tips empty', () => {
    const blind = dayRows(run({ uber: undefined }));
    expect(new Set(blind.map(r => r[at(FARE_GAP_HEADER)]))).toEqual(new Set([UBER_NOT_READ]));
    const uber = sheetOf(month, CLOSING_SHEET_UBER);
    // A driver Uber reports nothing daily for is planned on every allowed day, with no figure to compare.
    const alphaOnly = dayRows(run({ uber: { days: UBER.days.filter(d => d.driverId === ALPHA), periods: [] } }));
    const betaDays = alphaOnly.filter(r => r[at('Fahrer-ID')] === BETA);
    expect(betaDays.length).toBeGreaterThan(5);
    for (const r of betaDays) expect(r[at(FARE_GAP_HEADER)]).toBe(NO_UBER_ROW);
    for (const r of uber.slice(1).filter(x => x[column(uber, 'Zeilenart')] !== 'Tag')) expect(r[column(uber, FARE_GAP_HEADER)]).toBe('');
  });

  it('marks a day whose real fare cannot be read, and the total leaves it out and says so', () => {
    const rows = [...REAL_ROWS.slice(0, 1), realRow({ id: 'r-2', start_at: '2026-09-08T09:10:00Z', end_at: '2026-09-08T09:40:00Z', price_amount: 'abc', source_row_key: 'uber:r2' })];
    const unreadable = run({ realTrips: readRealTrips({ year: 2026, month: 9, rows, drivers: DRIVER_REFS, timeZone: ZONE, operatingDayStartHour: 4 }) });
    const row = dayRows(unreadable).find(r => r[at('Fahrer-ID')] === ALPHA && r[at('Datum')] === '2026-09-08')!;
    expect(row[at(FARE_GAP_HEADER)]).toBe(FARE_UNREADABLE);
    expect(String(checkValue(sheetOf(unreadable, CLOSING_SHEET_CHECKS), FARE_GAP_TOTAL_LABEL))).toMatch(/nicht enthalten: .*1 mit unlesbarem Fahrpreis/);
  });

  it('totals on sheet 7 as the sum of the day gaps, and says "nicht gelesen" without Uber', () => {
    const gaps = dayRows(month).map(r => r[at(FARE_GAP_HEADER)]).filter((g): g is number => typeof g === 'number');
    const total = String(checkValue(sheetOf(month, CLOSING_SHEET_CHECKS), FARE_GAP_TOTAL_LABEL));
    expect(total.startsWith(`${gaps.reduce((n, g) => n + cents(g), 0) / 100} EUR ueber ${gaps.length} Fahrertage`)).toBe(true);
    expect(checkValue(sheetOf(run({ uber: undefined }), CLOSING_SHEET_CHECKS), FARE_GAP_TOTAL_LABEL)).toBe(UBER_NOT_READ);
  });

  it('fits no fare to Uber: doubling every day\'s Umsatz moves the gap and leaves every simulated ride as it was', () => {
    const doubled: ReconcileUber = { ...UBER, days: UBER.days.map(d => ({ ...d, figures: { ...d.figures, umsatzCents: d.figures.umsatzCents * 2 } })) };
    const other = run({ uber: doubled });
    const strip = (r: FullMonthResult) => r.month.rides.map(ride => ({ ...ride, tripId: undefined }));
    expect(strip(other)).toEqual(strip(month));
    const gapOf = (r: FullMonthResult) => dayRows(r).find(x => x[at('Fahrer-ID')] === ALPHA && x[at('Datum')] === '2026-09-10')![at(FARE_GAP_HEADER)];
    const umsatz = UBER.days.find(d => d.driverId === ALPHA && d.date === '2026-09-10')!.figures.umsatzCents;
    expect(cents(gapOf(other)) - cents(gapOf(month))).toBe(umsatz);
  });
});

describe('the closing cannot be taken back in as a real Fahrtenbuch', () => {
  const first = (wb: XLSX.WorkBook) => findSimulationMarker(wb, wb.SheetNames[0]);

  it('a Fahrtenbuch sheet holding only real trips is refused once the notice sheet is gone', () => {
    const realOnly = rides.filter((r, i) => i === 0 || r[0] === LABEL.imported);
    expect(realOnly.length).toBeGreaterThan(1);
    expect(first(book(realOnly))).toBe('label_column');
  });

  it('every sheet on its own is refused', () => {
    for (const sheet of closing.payload.sheets) {
      expect(first(book(sheet.rows as unknown[][])), sheet.name).not.toBeNull();
    }
  });
});
