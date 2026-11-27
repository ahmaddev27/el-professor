import { describe, expect, it } from 'vitest';
import { toCents } from '../money';
import { generateFullMonth, type FullMonthDriver, type FullMonthInput, type FullMonthResult } from './fullMonth';
import { verifyMonth } from './monthVerification';
import { noRealTrips } from './realTrips';
import {
  allocateImportedTips,
  checkTips,
  reconcileMonth,
  type ReconcileUber,
} from './reconciliation';
import { inExportScope } from './revenue';
import { ESTIMATE_TRAVEL_MODEL, type TravelModel } from './travelModel';
import type { UberDriverDay, UberFigures, UberPeriodTotal } from './uberImport';
import type { GeoPoint, PoolAddress, SimRide, SimShift } from './types';

/**
 * FleetBook round 8, section 5 and 6, test classes 13, 19 and 20: the tips are
 * Uber's, spread to the cent and labelled simulated; the share is computed on
 * the imported `umsatz` and never booked; the financial status is separate
 * from the export verdict and says FAILED or INCOMPLETE where it must.
 */

const ALPHA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BETA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const figures = (over: Partial<UberFigures> = {}): UberFigures =>
  ({ umsatzCents: 0, aktionenCents: 0, trinkgeldCents: 0, bargeldCents: 0, tripCount: null, ...over });

const uberDay = (driverId: string, date: string, over: Partial<UberFigures> = {}, extra: Partial<UberDriverDay> = {}): UberDriverDay => ({
  driverId,
  driverName: driverId === ALPHA ? 'Fahrer Alpha' : 'Fahrer Beta',
  date,
  figures: figures(over),
  identity: 'partner_link',
  rowIds: [`${driverId}-${date}`],
  negativeTypes: [],
  overlapsPeriod: false,
  ...extra,
});

const uberPeriod = (driverId: string, from: string, to: string, over: Partial<UberFigures> = {}, extra: Partial<UberPeriodTotal> = {}): UberPeriodTotal => ({
  driverId,
  driverName: driverId === ALPHA ? 'Fahrer Alpha' : 'Fahrer Beta',
  periodStart: from,
  periodEnd: to,
  days: 7,
  placement: 'inside_month',
  figures: figures(over),
  identity: 'partner_link',
  rowIds: [`${driverId}-${from}-${to}`],
  negativeTypes: [],
  overlappingDailyDates: [],
  ...extra,
});

// ── Hand-built rides: the allocation's arithmetic on its own ────────────────

const shift = (id: string, driverId: string, day: string): SimShift =>
  ({ id, driver: { id: driverId, name: driverId }, operatingDay: day } as unknown as SimShift);

let rideNo = 0;
const ride = (shiftId: string, driverId: string, status: SimRide['status'] = 'completed', tip = 2.5): SimRide =>
  ({ tripId: `F${++rideNo}`, shiftId, driver: { id: driverId, name: driverId }, status, fare: 12.4, tip } as unknown as SimRide);

function smallMonth() {
  const shifts = [shift('s1', ALPHA, '2026-09-08'), shift('s2', ALPHA, '2026-09-09'), shift('s3', BETA, '2026-09-08')];
  const rides = [
    ride('s1', ALPHA), ride('s1', ALPHA), ride('s1', ALPHA, 'cancelled'), ride('s1', ALPHA, 'declined'),
    ride('s2', ALPHA),
    ride('s3', BETA), ride('s3', BETA),
  ];
  return { shifts, rides };
}

const tipCentsOf = (rides: readonly SimRide[], pred: (r: SimRide) => boolean) =>
  rides.filter(pred).reduce((n, r) => n + toCents(r.tip), 0);

describe('allocateImportedTips: Uber tips, to the cent, on the driver\'s own rides of the day', () => {
  it('discards every drawn tip, so without Uber figures no ride carries a tip', () => {
    const { shifts, rides } = smallMonth();
    expect(rides.some(r => r.tip > 0)).toBe(true);
    const out = allocateImportedTips({ uber: null, rides, shifts, seed: 1 });
    expect(out).toEqual([]);
    expect(rides.every(r => r.tip === 0)).toBe(true);
  });

  it('spreads an indivisible amount exactly over completed rides only (class 13)', () => {
    const { shifts, rides } = smallMonth();
    const uber: ReconcileUber = { days: [uberDay(ALPHA, '2026-09-08', { trinkgeldCents: 1001 })], periods: [] };
    const [alloc] = allocateImportedTips({ uber, rides, shifts, seed: 7 });
    expect(alloc).toMatchObject({ outcome: 'allocated', importedCents: 1001, allocatedCents: 1001, completedRides: 2 });
    expect(tipCentsOf(rides, r => r.shiftId === 's1')).toBe(1001);
    // Never on a cancelled ride or a declined order.
    expect(rides.filter(r => r.status !== 'completed').every(r => r.tip === 0)).toBe(true);
    // Never moved to another day of the same driver, or to another driver.
    expect(tipCentsOf(rides, r => r.shiftId !== 's1')).toBe(0);
    // Whole cents on every ride.
    for (const r of rides) expect(Number.isInteger(Math.round(r.tip * 100)) && Math.abs(r.tip * 100 - Math.round(r.tip * 100)) < 1e-9).toBe(true);
    expect(checkTips(rides, shifts, [alloc])).toEqual([]);
  });

  it('spreads one cent, and many cents, without losing or inventing any', () => {
    for (const cents of [1, 2, 49, 50, 51, 299, 12_345]) {
      const { shifts, rides } = smallMonth();
      const uber: ReconcileUber = { days: [uberDay(BETA, '2026-09-08', { trinkgeldCents: cents })], periods: [] };
      allocateImportedTips({ uber, rides, shifts, seed: 3 });
      expect(tipCentsOf(rides, r => r.driver.id === BETA)).toBe(cents);
      expect(tipCentsOf(rides, r => r.driver.id === ALPHA)).toBe(0);
    }
  });

  it('is deterministic for one seed, and one driver-day does not move another', () => {
    const a = smallMonth();
    const b = smallMonth();
    const both: ReconcileUber = { days: [uberDay(ALPHA, '2026-09-08', { trinkgeldCents: 777 }), uberDay(BETA, '2026-09-08', { trinkgeldCents: 333 })], periods: [] };
    const alone: ReconcileUber = { days: [uberDay(BETA, '2026-09-08', { trinkgeldCents: 333 })], periods: [] };
    allocateImportedTips({ uber: both, rides: a.rides, shifts: a.shifts, seed: 11 });
    allocateImportedTips({ uber: alone, rides: b.rides, shifts: b.shifts, seed: 11 });
    const betaTips = (rides: SimRide[]) => rides.filter(r => r.driver.id === BETA).map(r => r.tip);
    expect(betaTips(a.rides)).toEqual(betaTips(b.rides));
  });

  it('leaves a tip with no simulated ride that day unallocated, and the month INCOMPLETE', () => {
    const { shifts, rides } = smallMonth();
    const uber: ReconcileUber = { days: [uberDay(BETA, '2026-09-09', { trinkgeldCents: 450, umsatzCents: 9000 })], periods: [] };
    const allocations = allocateImportedTips({ uber, rides, shifts, seed: 1 });
    expect(allocations[0]).toMatchObject({ outcome: 'no_simulated_ride', allocatedCents: 0 });
    expect(rides.every(r => r.tip === 0)).toBe(true);
    const fin = reconcileMonth({ uber, rides, shifts, allocations, shareSetting: { mode: 'fixed', percent: 31 } });
    expect(fin.status).toBe('INCOMPLETE');
    expect(fin.reasons).toContain('tip_no_simulated_ride');
    expect(fin.totals.tipsUnallocatedCents).toBe(450);
  });

  it('keeps a negative tip total as it is, unallocated and flagged', () => {
    const { shifts, rides } = smallMonth();
    const uber: ReconcileUber = { days: [uberDay(ALPHA, '2026-09-08', { trinkgeldCents: -120 }, { negativeTypes: ['trinkgeld'] })], periods: [] };
    const allocations = allocateImportedTips({ uber, rides, shifts, seed: 1 });
    expect(allocations[0]).toMatchObject({ outcome: 'negative', importedCents: -120 });
    const fin = reconcileMonth({ uber, rides, shifts, allocations, shareSetting: null });
    expect(fin.status).toBe('INCOMPLETE');
    expect(fin.days.find(d => d.driverId === ALPHA && d.day === '2026-09-08')!.notes).toContain('negative_figure');
  });

  it('reconciles a week inside the month per week, never by day', () => {
    const { shifts, rides } = smallMonth();
    const uber: ReconcileUber = { days: [], periods: [uberPeriod(ALPHA, '2026-09-07', '2026-09-13', { trinkgeldCents: 901, umsatzCents: 40_000 })] };
    const allocations = allocateImportedTips({ uber, rides, shifts, seed: 5 });
    expect(allocations[0]).toMatchObject({ scope: 'period', outcome: 'allocated', allocatedCents: 901, completedRides: 3 });
    expect(tipCentsOf(rides, r => r.driver.id === ALPHA)).toBe(901);
    const fin = reconcileMonth({ uber, rides, shifts, allocations, shareSetting: { mode: 'fixed', percent: 30 } });
    expect(fin.periods[0]).toMatchObject({ tipsImportedCents: 901, tipsAllocatedCents: 901, rateBasisPoints: 3000, shareCents: 12_000 });
    // No per-day row is invented for it.
    expect(fin.days.filter(d => d.driverId === ALPHA).every(d => d.umsatzCents === 0 && d.notes.includes('no_uber_row'))).toBe(true);
  });

  it('names a week across the month boundary as not attributable, and spreads none of it', () => {
    const { shifts, rides } = smallMonth();
    const uber: ReconcileUber = {
      days: [],
      periods: [uberPeriod(ALPHA, '2026-08-31', '2026-09-06', { trinkgeldCents: 500 }, { placement: 'crosses_month_boundary' })],
    };
    const allocations = allocateImportedTips({ uber, rides, shifts, seed: 5 });
    expect(allocations[0].outcome).toBe('not_attributable');
    expect(rides.every(r => r.tip === 0)).toBe(true);
    const fin = reconcileMonth({ uber, rides, shifts, allocations, shareSetting: { mode: 'fixed', percent: 30 } });
    expect(fin.status).toBe('INCOMPLETE');
    expect(fin.reasons).toContain('tip_week_across_boundary');
    expect(fin.periods[0].shareCents).toBeNull();
  });

  it('uses neither of a daily and a weekly row for the same day', () => {
    const { shifts, rides } = smallMonth();
    const uber: ReconcileUber = {
      days: [uberDay(ALPHA, '2026-09-08', { trinkgeldCents: 300 }, { overlapsPeriod: true })],
      periods: [uberPeriod(ALPHA, '2026-09-07', '2026-09-13', { trinkgeldCents: 900 }, { overlappingDailyDates: ['2026-09-08'] })],
    };
    const allocations = allocateImportedTips({ uber, rides, shifts, seed: 5 });
    expect(allocations.map(a => a.outcome)).toEqual(['conflict', 'conflict']);
    expect(rides.every(r => r.tip === 0)).toBe(true);
    expect(reconcileMonth({ uber, rides, shifts, allocations, shareSetting: null }).reasons).toContain('tip_conflict');
  });
});

describe('checkTips: a cent nobody can account for is FAILED', () => {
  function allocated() {
    const { shifts, rides } = smallMonth();
    const uber: ReconcileUber = {
      days: [uberDay(ALPHA, '2026-09-08', { trinkgeldCents: 1001 }), uberDay(ALPHA, '2026-09-09', { trinkgeldCents: 200 }), uberDay(BETA, '2026-09-08', { trinkgeldCents: 640 })],
      periods: [],
    };
    const allocations = allocateImportedTips({ uber, rides, shifts, seed: 9 });
    return { shifts, rides, uber, allocations };
  }

  it('passes the allocation as made', () => {
    const { shifts, rides, uber, allocations } = allocated();
    expect(checkTips(rides, shifts, allocations)).toEqual([]);
    expect(reconcileMonth({ uber, rides, shifts, allocations, shareSetting: { mode: 'fixed', percent: 33 } }).status).toBe('CONFIGURATION_REQUIRED');
  });

  // Mutation controls: each forgery is one the allocation could plausibly make.
  const forgeries: [string, (rides: SimRide[]) => void][] = [
    ['one cent lost from the remainder', rides => { const r = rides.find(x => x.tip > 0)!; r.tip = Math.round(r.tip * 100 - 1) / 100; }],
    ['one cent invented', rides => { const r = rides.find(x => x.tip > 0)!; r.tip = Math.round(r.tip * 100 + 1) / 100; }],
    ['a tip on a cancelled ride', rides => { rides.find(x => x.status === 'cancelled')!.tip = 1; }],
    ['a tip on a declined order', rides => { rides.find(x => x.status === 'declined')!.tip = 1; }],
    ['a tip moved from Beta to Alpha', rides => {
      const from = rides.find(x => x.driver.id === BETA && x.tip > 0)!;
      const to = rides.find(x => x.shiftId === 's1' && x.status === 'completed')!;
      to.tip = Math.round((to.tip + from.tip) * 100) / 100;
      from.tip = 0;
    }],
    ['a tip moved to another day of the same driver', rides => {
      const from = rides.find(x => x.shiftId === 's1' && x.tip > 0)!;
      const to = rides.find(x => x.shiftId === 's2')!;
      to.tip = Math.round((to.tip + from.tip) * 100) / 100;
      from.tip = 0;
    }],
  ];
  for (const [name, forge] of forgeries) {
    it(`catches ${name}`, () => {
      const { shifts, rides, uber, allocations } = allocated();
      forge(rides);
      expect(checkTips(rides, shifts, allocations).length).toBeGreaterThan(0);
      const fin = reconcileMonth({ uber, rides, shifts, allocations, shareSetting: { mode: 'fixed', percent: 33 } });
      expect(fin.status).toBe('FAILED');
      expect(fin.reasons[0]).toBe('tip_mismatch');
    });
  }

  it('catches a tip on a driver-day Uber has no row for', () => {
    const { shifts, rides } = smallMonth();
    const allocations = allocateImportedTips({ uber: { days: [], periods: [] }, rides, shifts, seed: 1 });
    rides[0].tip = 2;
    expect(checkTips(rides, shifts, allocations)).toHaveLength(1);
  });
});

describe('reconcileMonth: the share on imported umsatz, computed and never booked (section 5, D1)', () => {
  it('takes the share of umsatz alone, per day, rounded half away from zero, with its sign', () => {
    const { shifts, rides } = smallMonth();
    const uber: ReconcileUber = {
      days: [
        uberDay(ALPHA, '2026-09-08', { umsatzCents: 10_050, aktionenCents: 1_500, trinkgeldCents: 0 }),
        uberDay(BETA, '2026-09-08', { umsatzCents: -1_050 }, { negativeTypes: ['umsatz'] }),
      ],
      periods: [],
    };
    const allocations = allocateImportedTips({ uber, rides, shifts, seed: 1 });
    const fin = reconcileMonth({ uber, rides, shifts, allocations, shareSetting: { mode: 'fixed', percent: 31 } });
    const alpha = fin.days.find(d => d.driverId === ALPHA && d.day === '2026-09-08')!;
    // 10 050 x 31 % = 3 115.5 -> 3 116; aktionen are beside the basis, not in it.
    expect(alpha).toMatchObject({ basisCents: 10_050, aktionenCents: 1_500, rateBasisPoints: 3100, shareCents: 3_116, formulaTotalCents: null });
    const beta = fin.days.find(d => d.driverId === BETA)!;
    // -1 050 x 31 % = -325.5 -> -326, kept with its sign and flagged.
    expect(beta.shareCents).toBe(-326);
    expect(beta.notes).toContain('negative_figure');
    // The month's share is the sum of the days, not a share of the month.
    expect(fin.totals.shareCents).toBe(3_116 - 326);
    expect(fin.share.meaning).toBe('CONFIGURATION_REQUIRED');
    expect(fin.status).toBe('CONFIGURATION_REQUIRED');
  });

  it('draws each day\'s rate from 30-33 only, with a random daily setting', () => {
    const { shifts, rides } = smallMonth();
    const days = Array.from({ length: 30 }, (_, i) => uberDay(ALPHA, `2026-09-${String(i + 1).padStart(2, '0')}`, { umsatzCents: 20_000 }));
    const uber: ReconcileUber = { days, periods: [] };
    const fin = reconcileMonth({ uber, rides, shifts, allocations: [], shareSetting: { mode: 'random', scope: 'day', seed: 42 } });
    const rates = new Set(fin.days.filter(d => d.umsatzCents > 0).map(d => d.rateBasisPoints));
    expect([...rates].every(r => r !== null && [3000, 3100, 3200, 3300].includes(r))).toBe(true);
    expect(rates.size).toBeGreaterThan(1);
  });

  it('applies no rate without a setting, and says so', () => {
    const { shifts, rides } = smallMonth();
    const uber: ReconcileUber = { days: [uberDay(ALPHA, '2026-09-08', { umsatzCents: 10_000 })], periods: [] };
    const fin = reconcileMonth({ uber, rides, shifts, allocations: [], shareSetting: null });
    expect(fin.days[0]).toMatchObject({ rateBasisPoints: null, shareCents: null });
    expect(fin.reasons).toContain('share_not_configured');
  });

  it('refuses a percent outside 30-33 as an invalid setting, applying nothing', () => {
    const { shifts, rides } = smallMonth();
    const uber: ReconcileUber = { days: [uberDay(ALPHA, '2026-09-08', { umsatzCents: 10_000 })], periods: [] };
    const fin = reconcileMonth({ uber, rides, shifts, allocations: [], shareSetting: { mode: 'fixed', percent: 35 as 30 } });
    expect(fin.share.settingProblem).toBe('percent_not_allowed');
    expect(fin.reasons).toContain('share_setting_invalid');
    expect(fin.days[0].shareCents).toBeNull();
  });

  it('is INCOMPLETE when no Uber figure was read, never a report of zeros', () => {
    const { shifts, rides } = smallMonth();
    const allocations = allocateImportedTips({ uber: null, rides, shifts, seed: 1 });
    const fin = reconcileMonth({ uber: null, rides, shifts, allocations, shareSetting: { mode: 'fixed', percent: 30 } });
    expect(fin.status).toBe('INCOMPLETE');
    expect(fin.reasons[0]).toBe('uber_not_read');
    expect(fin.uberRead).toBe(false);
  });

  it('is INCOMPLETE when Uber rows could not be read or were typed by hand', () => {
    const { shifts, rides } = smallMonth();
    const uber: ReconcileUber = {
      days: [uberDay(ALPHA, '2026-09-08', { umsatzCents: 10_000 })],
      periods: [],
      issues: [{ rowId: 'r9', issue: 'driver_unresolved', detail: 'Unbekannt' }],
      handRows: [],
    };
    const allocations = allocateImportedTips({ uber, rides, shifts, seed: 1 });
    const fin = reconcileMonth({ uber, rides, shifts, allocations, shareSetting: { mode: 'fixed', percent: 30 } });
    expect(fin.status).toBe('INCOMPLETE');
    expect(fin.reasons).toContain('uber_row_issues');
  });
});

// ── The month generator: tips from Uber, labelled, exact ────────────────────

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
const DRIVERS: FullMonthDriver[] = [
  { id: ALPHA, name: 'Fahrer Alpha', ...RANGE },
  { id: BETA, name: 'Fahrer Beta', ...RANGE },
];
const ROUTED: TravelModel = { source: 'test-router', measured: true, drive: ESTIMATE_TRAVEL_MODEL.drive, ride: ESTIMATE_TRAVEL_MODEL.ride };

const SEPTEMBER_DAYS = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
// Uber reports both drivers on every weekday, with a tip on most days.
const UBER: ReconcileUber = {
  days: SEPTEMBER_DAYS.flatMap((date, i) => [
    uberDay(ALPHA, date, { umsatzCents: 18_000 + i * 37, trinkgeldCents: i % 4 === 0 ? 0 : 301 + i * 7, aktionenCents: 500, tripCount: 9 }),
    uberDay(BETA, date, { umsatzCents: 15_500 + i * 11, trinkgeldCents: i % 5 === 0 ? 0 : 199 + i, tripCount: 8 }),
  ]),
  periods: [],
  handRows: [],
  issues: [],
};

const monthInput = (over: Partial<FullMonthInput> = {}): FullMonthInput => ({
  year: 2026, month: 9, base: BASE, baseSource: 'saved_point', pool: POOL, vehicles: VEHICLES, drivers: DRIVERS,
  driverNotesMap: new Map(), seed: 2713, shiftsPerVehicleDay: 3, travel: ROUTED, realTrips: noRealTrips(), ...over,
});
function run(over: Partial<FullMonthInput> = {}): FullMonthResult {
  const out = generateFullMonth(monthInput(over));
  if (!out.ok) throw new Error(`generation refused: ${JSON.stringify(out.failure)}`);
  return out.result;
}
const tipsCheck = (r: FullMonthResult) => verifyMonth(r).checks.find(c => c.code === 'tips_backed')!;

const withUber = run({ uber: UBER, shareSetting: { mode: 'fixed', percent: 32 } });
const withoutUber = run();

describe('generateFullMonth: the tips are Uber\'s, never drawn', () => {
  it('carries no tip at all when no Uber figure was read, and says the money is INCOMPLETE', () => {
    expect(withoutUber.month.rides.every(r => r.tip === 0)).toBe(true);
    expect(withoutUber.revenue.tipCents).toBe(0);
    expect(withoutUber.financial.status).toBe('INCOMPLETE');
    expect(withoutUber.financial.reasons).toContain('uber_not_read');
    // The export verdict does not depend on the money (D10).
    expect(tipsCheck(withoutUber).outcome).toBe('passed');
  });

  it('meets every daily tip total to the cent, on that driver\'s completed rides of that day (class 13)', () => {
    const dayOf = new Map(withUber.month.shifts.map(s => [s.id, s.operatingDay]));
    const allocated = withUber.financial.tips.filter(a => a.outcome === 'allocated');
    expect(allocated.length).toBeGreaterThan(20);
    for (const a of allocated) {
      const sum = withUber.month.rides
        .filter(r => r.status === 'completed' && r.driver.id === a.driverId && dayOf.get(r.shiftId) === a.from)
        .reduce((n, r) => n + toCents(r.tip), 0);
      expect(sum).toBe(a.importedCents);
    }
    // Every tip in the report is one of those, so the month's total is the allocated total.
    expect(withUber.revenue.tipCents).toBe(allocated.reduce((n, a) => n + a.importedCents, 0));
    expect(withUber.month.rides.filter(r => r.status !== 'completed').every(r => r.tip === 0)).toBe(true);
    expect(withUber.violations).toEqual([]);
    expect(tipsCheck(withUber).outcome).toBe('passed');
  });

  it('names each imported tip it could not place, instead of moving it', () => {
    const unplaced = withUber.financial.tips.filter(a => a.outcome !== 'allocated');
    for (const a of unplaced) expect(a.outcome).toBe('no_simulated_ride');
    expect(withUber.financial.totals.tipsImportedCents)
      .toBe(withUber.financial.totals.tipsAllocatedCents + withUber.financial.totals.tipsUnallocatedCents);
    expect(withUber.financial.status).toBe(unplaced.length > 0 ? 'INCOMPLETE' : 'CONFIGURATION_REQUIRED');
  });

  it('shows the share per driver-day of the imported umsatz, never booked', () => {
    const fin = withUber.financial;
    const d = fin.days.find(x => x.driverId === ALPHA && x.day === '2026-09-02')!;
    expect(d.basisCents).toBe(18_037);
    expect(d.rateBasisPoints).toBe(3200);
    expect(d.shareCents).toBe(Math.round(18_037 * 0.32));
    expect(d.formulaTotalCents).toBeNull();
    expect(fin.share).toMatchObject({ meaning: 'CONFIGURATION_REQUIRED', basis: 'umsatz' });
  });

  it('keeps the rides themselves where they were: only the tip column moves', () => {
    const strip = (r: FullMonthResult) => r.month.rides.map(x => [x.tripId, x.status, x.startMs, x.endMs, x.fare, x.km]);
    expect(strip(withUber).length).toBeGreaterThan(0);
    // The Uber days restrict the drivers to the days Uber reported, which is every day here.
    expect(strip(withUber)).toEqual(strip(run({ uber: UBER, shareSetting: null })));
  });

  it('puts the Uber figures and the share setting into the run id', () => {
    const other = run({ uber: UBER, shareSetting: { mode: 'fixed', percent: 30 } });
    expect(other.provenance.runId).not.toBe(withUber.provenance.runId);
    expect(withUber.provenance.financial.uberDigest).toMatch(/^[0-9a-f]{8}$/);
    expect(withoutUber.provenance.financial.uberDigest).toBeNull();
  });

  it('reads a forged tip back as NOT_VALIDATED, with the cent named', () => {
    const forged = structuredClone(withUber);
    const r = forged.month.rides.find(x => x.tip > 0)!;
    r.tip = Math.round(r.tip * 100 + 1) / 100;
    const v = verifyMonth(forged);
    expect(v.checks.find(c => c.code === 'tips_backed')!.outcome).toBe('failed');
    expect(v.verdict).toBe('NOT_VALIDATED');
  });
});

describe('classes 19 and 20: cancellations and declined orders', () => {
  it('charges a cancelled ride only the configured fee, and no tip (class 19)', () => {
    const cancelled = withUber.month.rides.filter(r => r.status === 'cancelled');
    expect(cancelled.length).toBeGreaterThan(0);
    for (const r of cancelled) expect([r.fare, r.tip]).toEqual([0, 0]);
    expect(withUber.revenue.cancelledFeeCents).toBe(0);

    const feeMonth = run({ uber: UBER, settings: { cancellationFeeEnabled: true, cancellationFeeCents: 500 } });
    const n = feeMonth.month.rides.filter(r => r.status === 'cancelled').length;
    expect(feeMonth.revenue.cancelledFeeCents).toBe(n * 500);
    expect(feeMonth.month.rides.filter(r => r.status === 'cancelled').every(r => r.tip === 0)).toBe(true);
  });

  it('keeps every declined order out of the Fahrtenbuch report (class 20)', () => {
    const declinedMonth = run({ uber: UBER, settings: { declinedRidesEnabled: true } });
    const declined = declinedMonth.month.rides.filter(r => r.status === 'declined');
    expect(declined.length).toBeGreaterThan(0);
    expect(declined.every(r => !inExportScope(r) && r.tip === 0)).toBe(true);
    expect(declinedMonth.month.rides.filter(inExportScope).some(r => r.status === 'declined')).toBe(false);
    expect(verifyMonth(declinedMonth).checks.find(c => c.code === 'declined_not_exported')!.outcome).toBe('passed');
  });
});
