import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { generateFullMonth, type FullMonthInput, type FullMonthResult } from './fullMonth';
import { SIMULATED_FILE_PREFIX, SIMULATED_SHEET_NAME } from './marker';
import {
  SHEET_CHECKS, SHEET_DAYS, SHEET_DECLINED, SHEET_DRIVERS, SHEET_ORDER, SHEET_RIDES, SHEET_SOURCE,
  SHEET_VEHICLES, TOTAL_LABEL, buildMonthWorkbook, monthTotals, reconcile, totalsByDriver, totalsByVehicle,
  type Cell,
} from './monthWorkbook';
import type { PoolAddress } from './types';

/** Invented data only: no real name, address or plate. */
const POOL: PoolAddress[] = Array.from({ length: 25 }, (_, i) => ({
  label: `Musterweg ${i + 1}, 12345 Testburg, Deutschland`,
  lat: 50.0 + Math.floor(i / 5) * 0.0085,
  lon: 8.0 + (i % 5) * 0.0085,
}));

const WORKDAYS = [1, 2, 3, 4, 5];

function input(year: number, month: number): FullMonthInput {
  return {
    year,
    month,
    base: { lat: 50.01, lon: 8.01 },
    pool: POOL,
    vehicles: [
      { id: 'v1', plate: 'XX-TS 101', type: 'Testwagen' },
      { id: 'v2', plate: 'XX-TS 102', type: 'Testwagen' },
    ],
    // Weekdays only, so every weekend is a day with no ride and sheet B must still list it.
    drivers: [
      { id: 'd1', name: 'Fahrer Eins', allowed_weekdays: WORKDAYS },
      { id: 'd2', name: 'Fahrer Zwei', allowed_weekdays: WORKDAYS },
    ],
    driverNotesMap: new Map(),
    seed: 4711,
    settings: {
      declinedRidesEnabled: true,
      declinedShare: 0.5,
      monthlyRevenueShareEnabled: true,
    },
  };
}

function month(year: number, m: number): FullMonthResult {
  const out = generateFullMonth(input(year, m));
  if (!out.ok) throw new Error(`generation failed: ${JSON.stringify(out.failure)}`);
  return out.result;
}

function readBack(result: FullMonthResult): { names: string[]; sheet: (name: string) => Cell[][]; fileName: string } {
  const file = buildMonthWorkbook(result);
  const wb = XLSX.read(file.bytes, { type: 'array' });
  return {
    names: wb.SheetNames,
    fileName: file.fileName,
    sheet: name => XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name], { header: 1, defval: '' }),
  };
}

const cents = (cell: Cell): number => Math.round(Number(cell) * 100);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
/** The body of a breakdown sheet: header and the total row removed. */
const bodyOf = (rows: Cell[][]): Cell[][] => rows.slice(1).filter(r => r[0] !== TOTAL_LABEL);
const totalOf = (rows: Cell[][]): Cell[] => rows.find(r => r[0] === TOTAL_LABEL) as Cell[];

const CASES: Array<[string, number, number, number]> = [
  ['31-day month', 2026, 10, 31],
  ['30-day month', 2026, 9, 30],
  ['February of a leap year', 2024, 2, 29],
  ['February of a non-leap year', 2026, 2, 28],
];

describe.each(CASES)('the month workbook, %s', (_label, year, m, dayCount) => {
  const result = month(year, m);
  const book = readBack(result);

  it('carries all seven sheets and the SIMULIERT notice, which is not first', () => {
    for (const name of SHEET_ORDER) expect(book.names).toContain(name);
    expect(book.names).toContain(SIMULATED_SHEET_NAME);
    expect(book.names[0]).toBe(SHEET_RIDES);
    expect(book.names.indexOf(SIMULATED_SHEET_NAME)).toBeGreaterThan(0);
    expect(book.fileName.startsWith(SIMULATED_FILE_PREFIX)).toBe(true);
    for (const name of book.names) expect(name.length).toBeLessThanOrEqual(31);
  });

  it('lists exactly one row per calendar day in sheet B, zero-ride days included', () => {
    const days = bodyOf(book.sheet(SHEET_DAYS));
    expect(days).toHaveLength(dayCount);
    expect(days.map(r => r[0])).toEqual(
      Array.from({ length: dayCount }, (_, i) => `${year}-${String(m).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`),
    );
    const empty = days.filter(r => r[13] === 'Ja');
    expect(empty.length).toBeGreaterThan(0);
    for (const row of empty) {
      expect(row[5]).toBe(0);
      expect(String(row[14]).length).toBeGreaterThan(0);
    }
  });

  it('reconciles the money per day, per driver and per vehicle with the total, in cents', () => {
    const total = result.revenue.fareCents;
    expect(total).toBeGreaterThan(0);
    const days = bodyOf(book.sheet(SHEET_DAYS));
    expect(sum(days.map(r => cents(r[9])))).toBe(total);
    expect(cents(totalOf(book.sheet(SHEET_DAYS))[9])).toBe(total);
    const drivers = bodyOf(book.sheet(SHEET_DRIVERS));
    expect(sum(drivers.map(r => cents(r[5])))).toBe(total);
    const vehicles = bodyOf(book.sheet(SHEET_VEHICLES));
    expect(sum(vehicles.map(r => cents(r[5])))).toBe(total);
  });

  it('reconciles every measure, with no difference, and says so on sheet F', () => {
    for (const row of reconcile(result)) expect(row.partsSum, row.label).toBe(row.total);
    const checks = book.sheet(SHEET_CHECKS).filter(r => r[4] === 'OK' || r[4] === 'ABWEICHUNG');
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every(r => r[4] === 'OK' && r[3] === 0)).toBe(true);
  });

  it('sums orders, tips, decline fees and kilometres without double counting', () => {
    const t = monthTotals(result);
    expect(sum(totalsByDriver(result.month.rides, result.provenance.settings).map(x => x.orders))).toBe(t.orders);
    expect(sum(totalsByVehicle(result.month.rides, result.provenance.settings).map(x => x.declinedFeeCents)))
      .toBe(t.declinedFeeCents);
    expect(sum(result.days.map(d => d.rides))).toBe(result.revenue.counts.total);
    expect(t.orders).toBe(t.completed + t.cancelled + t.declined);
    expect(t.appFareCents + t.cashFareCents).toBe(t.fareCents);
  });
});

describe('declined and cancelled rides on sheet E', () => {
  const result = month(2026, 10);
  const rows = readBack(result).sheet(SHEET_DECLINED).slice(1);

  it('writes a declined ride with the fee and no fare', () => {
    const declined = rows.filter(r => r[1] === 'abgelehnt');
    expect(declined.length).toBeGreaterThan(0);
    expect(declined).toHaveLength(result.revenue.counts.declined);
    for (const r of declined) {
      expect(cents(r[5])).toBe(result.provenance.settings.declinedFeeCents);
      expect(cents(r[6])).toBe(0);
    }
  });

  it('keeps a cancelled ride out of the declined count and charges it no fee', () => {
    const cancelled = rows.filter(r => r[1] === 'storniert');
    expect(cancelled.length).toBeGreaterThan(0);
    expect(cancelled).toHaveLength(result.revenue.counts.cancelled);
    for (const r of cancelled) expect(cents(r[5])).toBe(0);
    expect(result.revenue.cancelledFeeCents).toBe(0);
  });
});

describe('the revenue share and the source sheet', () => {
  const result = month(2026, 10);
  const book = readBack(result);

  it('prints basis, rate, amount and remainder, which add back to the basis', () => {
    const lines = new Map(book.sheet(SHEET_CHECKS).map(r => [r[0], r[1]]));
    const share = result.share;
    expect(share).not.toBeNull();
    expect(cents(lines.get('Betrag (EUR)') as Cell) + cents(lines.get('Rest, falls Abzug (EUR)') as Cell))
      .toBe(result.basis.basisCents);
    const rate = Number(lines.get('Satz (%)'));
    expect(rate).toBeGreaterThanOrEqual(30);
    expect(rate).toBeLessThanOrEqual(33);
  });

  it('names the seed, the generator version and the simulation marking', () => {
    const text = book.sheet(SHEET_SOURCE).map(r => r.join(' | ')).join('\n');
    expect(text).toContain(String(result.provenance.seed));
    expect(text).toContain(result.provenance.generatorVersion);
    expect(text).toContain('SIMULIERT');
    expect(text).toContain('simuliert');
    expect(text).toContain('kein Nachweis');
  });

  it('keeps numbers as numbers in the cells', () => {
    const rides = book.sheet(SHEET_RIDES);
    const done = rides.find(r => r[2] === 'abgeschlossen') as Cell[];
    expect(typeof done[9]).toBe('number');
    expect(typeof done[12]).toBe('number');
  });
});
