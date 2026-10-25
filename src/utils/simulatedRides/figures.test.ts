import { describe, expect, it } from 'vitest';
import { createRng } from './rng';
import { validateRides } from './generator';
import {
  addDays, allocateCents, figuresOf, generateFromFigures, mondayOf, mondaysOfMonth, toCents, weekKey,
  type FiguresInput, type IncomeRow,
} from './figures';
import { prepareSimulatedImport } from './importPath';
import { rideDate, ridesToRows } from './sheet';
import type { GeoPoint, PoolAddress } from './types';

const BASE: GeoPoint = { lat: 51.1657, lon: 7.0671 };
const POOL: PoolAddress[] = Array.from({ length: 400 }, (_, i) => ({
  label: `Teststraße ${i}, 42651 Solingen, Deutschland`,
  lat: 51.1 + Math.floor(i / 20) * 0.0055,
  lon: 7.0 + (i % 20) * 0.0085,
}));
const DRIVERS = ['Andrey Tanurkov', 'Alev Büyükay', 'Ferhat Erol'].map(name => ({ name }));
const VEHICLES = ['SG-YA15', 'SG-YA18', 'SG-YA20'].map(plate => ({ plate, type: 'Mietwagen' }));

interface Fig { umsatz: number; bargeld?: number; trinkgeld?: number; aktionen?: number }

function income(driver: string, monday: string, f: Fig): IncomeRow[] {
  const date = addDays(monday, 6);
  const rows: IncomeRow[] = [{ driver_name: driver, type: 'umsatz', date, amount: f.umsatz }];
  if (f.bargeld !== undefined) rows.push({ driver_name: driver, type: 'bargeld', date, amount: f.bargeld });
  if (f.trinkgeld !== undefined) rows.push({ driver_name: driver, type: 'trinkgeld', date, amount: f.trinkgeld });
  if (f.aktionen !== undefined) rows.push({ driver_name: driver, type: 'aktionen', date, amount: f.aktionen });
  return rows;
}

const MONDAYS = mondaysOfMonth(2026, 9);
const FIGS: [string, string, Fig][] = [
  ['Andrey Tanurkov', MONDAYS[0], { umsatz: 1647.08, bargeld: 523.37, trinkgeld: 41.5, aktionen: 30 }],
  ['Andrey Tanurkov', MONDAYS[1], { umsatz: 902.99, bargeld: 0, trinkgeld: 0 }],
  ['Alev Büyükay', MONDAYS[0], { umsatz: 1203.33, bargeld: 1203.33, trinkgeld: 12.07 }],
  ['Alev Büyükay', MONDAYS[2], { umsatz: 2210.01, bargeld: 811.11, trinkgeld: 59.99 }],
  ['Ferhat Erol', MONDAYS[3], { umsatz: 640.05, bargeld: 100.01, trinkgeld: 3 }],
];
const ROWS = FIGS.flatMap(([d, m, f]) => income(d, m, f));

const input = (over: Partial<FiguresInput> = {}): FiguresInput => ({
  year: 2026, month: 9, base: BASE, pool: POOL, vehicles: VEHICLES, drivers: DRIVERS,
  income: ROWS, occupied: new Set(), seed: 11, ...over,
});

const cents = (n: number | undefined) => Math.round((n ?? 0) * 100);

describe('exact cents', () => {
  it('reads cents without rounding a real fraction away', () => {
    expect(toCents(1647.08)).toBe(164708);
    expect(toCents('0.10')).toBe(10);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(10.005)).toBeNull();
  });

  it('allocateCents always adds up exactly, never under the minimum', () => {
    const rng = createRng(5);
    for (let i = 0; i < 2000; i++) {
      const n = rng.int(1, 14);
      const weights = Array.from({ length: n }, () => 1 + rng.next() * 40);
      const total = rng.int(n * 500, n * 500 + 300_000);
      const shares = allocateCents(weights, total, 500)!;
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      expect(Math.min(...shares)).toBeGreaterThanOrEqual(500);
    }
    expect(allocateCents([1, 1], 999, 500)).toBeNull();
  });

  it('business weeks follow the Monday', () => {
    expect(mondayOf('2026-09-13')).toBe('2026-09-07');
    expect(mondayOf('2026-09-07')).toBe('2026-09-07');
    expect(MONDAYS).toEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
  });
});

describe('generateFromFigures', () => {
  const result = generateFromFigures(input());

  it('explains every driver-week with figures, and finds nothing wrong', () => {
    expect(result.findings).toEqual([]);
    expect(result.explained).toHaveLength(FIGS.length);
  });

  it('makes umsatz, bargeld and trinkgeld match the books to the cent, each on its own', () => {
    const read = figuresOf(result.month.rides, rideDate);
    for (const [driver, monday, f] of FIGS) {
      const got = read.get(weekKey(driver, monday))!;
      expect(got.umsatz, `${driver} ${monday} umsatz`).toBe(cents(f.umsatz));
      expect(got.bargeld, `${driver} ${monday} bargeld`).toBe(cents(f.bargeld));
      expect(got.trinkgeld, `${driver} ${monday} trinkgeld`).toBe(cents(f.trinkgeld));
    }
    expect(read.size).toBe(FIGS.length);
  });

  it('stays exact for many seeds', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = generateFromFigures(input({ seed }));
      const read = figuresOf(r.month.rides, rideDate);
      for (const f of r.explained) {
        const got = read.get(weekKey(f.driver, f.weekMonday))!;
        expect([got.umsatz, got.bargeld, got.trinkgeld]).toEqual([f.umsatz, f.bargeld, f.trinkgeld]);
      }
    }
  });

  it('keeps every physical rule', () => {
    expect(validateRides(result.month, BASE)).toEqual([]);
  });

  it('survives the real parser: the imported trips carry the same sums', async () => {
    const prepared = await prepareSimulatedImport({
      year: 2026, month: 9, seed: 11, rows: ridesToRows(result.month.rides),
      drivers: DRIVERS.map((d, i) => ({ id: `d${i}`, name: d.name })), cars: [],
    });
    const sums = new Map<string, { price: number; cash: number; tip: number }>();
    for (const t of prepared.trips) {
      const key = weekKey(t.original_driver_name, mondayOf(t.trip_date));
      const s = sums.get(key) ?? { price: 0, cash: 0, tip: 0 };
      s.price += t.is_canceled ? 0 : cents(t.price_amount);
      s.cash += cents(t.cash_amount);
      s.tip += cents(t.tip_amount);
      sums.set(key, s);
    }
    for (const [driver, monday, f] of FIGS) {
      const s = sums.get(weekKey(driver, monday))!;
      expect(s.price).toBe(cents(f.umsatz));
      expect(s.cash).toBe(cents(f.bargeld));
      expect(s.tip).toBe(cents(f.trinkgeld));
    }
    expect(prepared.file.fileName.startsWith('SIMULIERT_')).toBe(true);
  });

  it('never touches the books it reads', () => {
    const before = JSON.stringify(ROWS);
    generateFromFigures(input());
    expect(JSON.stringify(ROWS)).toBe(before);
  });

  it('invents nothing: a driver with no income gets no rides', () => {
    const r = generateFromFigures(input({ income: income('Andrey Tanurkov', MONDAYS[0], { umsatz: 800 }) }));
    expect(new Set(r.month.rides.map(x => x.driver.name))).toEqual(new Set(['Andrey Tanurkov']));
    expect(generateFromFigures(input({ income: [] })).month.rides).toEqual([]);
  });
});

describe('contradictions are reported and refused, not smoothed over', () => {
  const run = (rows: IncomeRow[], extra: Partial<FiguresInput> = {}) => generateFromFigures(input({ income: rows, ...extra }));

  it('cash larger than revenue', () => {
    const r = run(income('Ferhat Erol', MONDAYS[0], { umsatz: 500, bargeld: 600 }));
    expect(r.findings.map(f => f.code)).toEqual(['cash_exceeds_revenue']);
    expect(r.month.rides).toEqual([]);
  });

  it('cash or tips with no revenue', () => {
    expect(run(income('Ferhat Erol', MONDAYS[0], { umsatz: 0, bargeld: 50 })).findings[0].code).toBe('cash_without_revenue');
    expect(run(income('Ferhat Erol', MONDAYS[0], { umsatz: 0, trinkgeld: 5 })).findings[0].code).toBe('tip_without_revenue');
  });

  it('a negative amount, a fraction of a cent, a driver the company does not have', () => {
    expect(run(income('Ferhat Erol', MONDAYS[0], { umsatz: -5 })).findings[0].code).toBe('negative_amount');
    expect(run(income('Ferhat Erol', MONDAYS[0], { umsatz: 100.005 })).findings[0].code).toBe('fractional_cent');
    expect(run(income('Nobody Known', MONDAYS[0], { umsatz: 100 })).findings[0].code).toBe('unknown_driver');
  });

  it('a revenue too small for even one fare', () => {
    expect(run(income('Ferhat Erol', MONDAYS[0], { umsatz: 3 })).findings[0].code).toBe('revenue_too_small');
  });

  it('a driver-week that already has real trips is refused, another week of the same driver is not', () => {
    const rows = [...income('Ferhat Erol', MONDAYS[0], { umsatz: 700 }), ...income('Ferhat Erol', MONDAYS[1], { umsatz: 700 })];
    const r = run(rows, { occupied: new Set([weekKey('Ferhat Erol', MONDAYS[0])]) });
    expect(r.findings.map(f => [f.code, f.weekMonday])).toEqual([['real_trips_exist', MONDAYS[0]]]);
    expect(r.explained.map(f => f.weekMonday)).toEqual([MONDAYS[1]]);
  });

  it('figures no shift rules can explain are refused with a reason', () => {
    const r = run(income('Ferhat Erol', MONDAYS[0], { umsatz: 90_000 }));
    expect(r.findings[0]).toMatchObject({ code: 'cannot_explain' });
    expect(r.month.rides).toEqual([]);
  });
});
