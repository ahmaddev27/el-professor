import { describe, expect, it } from 'vitest';
import { checkDriverShifts, generateFullMonth, type FullMonthDriver, type FullMonthInput, type FullMonthResult } from './fullMonth';
import { BREAK_MINUTES, MAX_DAY_WORK_MINUTES, MAX_PART_MINUTES, MAX_WEEK_WORK_MINUTES, isoWeekStart } from './driverMonthPlan';
import { checksSheetRows, shiftsSheetRows } from './monthClosing';
import { verifyMonth } from './monthVerification';
import { noRealTrips } from './realTrips';
import type { GeoPoint, PoolAddress, SimShift } from './types';

/**
 * Round 8: a day over 360 minutes is one duty of two parts with a 30-minute
 * break at the base (§ 3, § 4 ArbZG). Everything below is invented data.
 */

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
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
// 2400 EUR at 13 EUR/h: 185 h in a month of 22 weekdays asks for about 8:24 a day.
const FULL_TIME = { planning_min_salary: 2000, planning_max_salary: 2300, planning_hourly_rate: 13, allowed_weekdays: [1, 2, 3, 4, 5] } as const;
const DRIVERS: FullMonthDriver[] = [
  { id: ID_A, name: 'Fahrer Alpha', ...FULL_TIME },
  { id: ID_B, name: 'Fahrer Beta', ...FULL_TIME },
];

function run(over: Partial<FullMonthInput> = {}): FullMonthResult {
  const out = generateFullMonth({
    year: 2026, month: 9, base: BASE, pool: POOL, vehicles: VEHICLES, drivers: DRIVERS, driverNotesMap: new Map(),
    seed: 4242, shiftsPerVehicleDay: 3, realTrips: noRealTrips(), ...over,
  });
  if (!out.ok) throw new Error(`generation refused: ${JSON.stringify(out.failure)}`);
  return out.result;
}

const minutes = (ms: number) => (ms) / 60_000;
const recheck = (r: FullMonthResult, shifts: readonly SimShift[]) =>
  checkDriverShifts(shifts, r.driverPlans, r.vehicleUnavailability, r.provenance.options.minDriverRestMinutes);

const r = run();
const parts1 = r.month.shifts.filter(s => s.part === 1);
const partsOf = (s: SimShift) => r.month.shifts.filter(x => x.dutyId === s.dutyId);

describe('a duty over 360 minutes is two parts around a break at the base', () => {
  it('places two-part duties, and the read-back finds nothing wrong', () => {
    expect(parts1.length).toBeGreaterThan(10);
    expect(r.violations).toEqual([]);
    expect(recheck(r, r.month.shifts)).toEqual([]);
    expect(verifyMonth(r).checks.find(c => c.code === 'shift_limits')?.outcome).toBe('passed');
  });

  it('each part is at most 360 minutes, the duty at most 480, the break exactly 30 and on one vehicle', () => {
    for (const p1 of parts1) {
      const [a, b] = partsOf(p1);
      expect(b.part).toBe(2);
      expect(a.vehicle.plate).toBe(b.vehicle.plate);
      expect(a.operatingDay).toBe(b.operatingDay);
      expect(minutes(a.plannedEndMs! - a.startMs)).toBeLessThanOrEqual(MAX_PART_MINUTES);
      expect(minutes(b.plannedEndMs! - b.startMs)).toBeLessThanOrEqual(MAX_PART_MINUTES);
      const work = minutes(a.plannedEndMs! - a.startMs) + minutes(b.plannedEndMs! - b.startMs);
      expect(work).toBeGreaterThan(MAX_PART_MINUTES);
      expect(work).toBeLessThanOrEqual(MAX_DAY_WORK_MINUTES);
      expect(a.breakAfter).toEqual({ startMs: a.plannedEndMs, endMs: a.plannedEndMs! + BREAK_MINUTES * 60_000 });
      expect(b.startMs).toBe(a.breakAfter!.endMs);
    }
  });

  it('holds the vehicle through the break, so no other shift runs on it then', () => {
    for (const p1 of parts1) {
      const { startMs, endMs } = p1.breakAfter!;
      const others = r.month.shifts.filter(s => s.vehicle.plate === p1.vehicle.plate && s.dutyId !== p1.dutyId);
      expect(others.some(s => s.startMs < endMs && (s.plannedEndMs ?? s.endMs) > startMs)).toBe(false);
    }
  });

  it('part 1 ends with the car at the base although the company does not require it', () => {
    expect(r.provenance.returnToBase).toBe(false);
    const toBase = r.repositioning.filter(l => l.purpose === 'to_base').map(l => l.shiftId);
    expect(new Set(toBase)).toEqual(new Set(parts1.map(s => s.id)));
    for (const p1 of parts1) expect(p1.endMs).toBeLessThanOrEqual(p1.plannedEndMs!);
  });

  it('counts a duty as one shift of its vehicle and its driver, and the driver rests from part 2', () => {
    const day = r.days.find(d => d.shifts > 0)!;
    const onDay = r.month.shifts.filter(s => s.operatingDay === day.day);
    expect(day.shifts).toBe(new Set(onDay.map(s => s.dutyId ?? s.id)).size);
    const placed = r.driverOutcomes.find(o => o.driverId === ID_A)!;
    expect(placed.placedShifts).toBe(new Set(r.month.shifts.filter(s => s.driver.id === ID_A).map(s => s.dutyId ?? s.id)).size);
  });

  it('puts no more than 48 hours of work in any ISO week', () => {
    const weeks = new Map<string, number>();
    for (const s of r.month.shifts) {
      const key = `${s.driver.id}|${isoWeekStart(s.operatingDay)}`;
      weeks.set(key, (weeks.get(key) ?? 0) + minutes((s.plannedEndMs ?? s.endMs) - s.startMs));
    }
    for (const total of weeks.values()) expect(total).toBeLessThanOrEqual(MAX_WEEK_WORK_MINUTES);
  });

  it('is the same month for the same seed', () => {
    expect(run().provenance.runId).toBe(r.provenance.runId);
  });
});

describe('mutation controls: the read-back catches each broken rule', () => {
  const first = parts1[0];
  const [a, b] = partsOf(first);
  const rest = r.month.shifts.filter(s => s.dutyId !== first.dutyId);
  const swap = (x: SimShift, y: SimShift) => [...rest, x, y];

  it('a part of 361 minutes', () => {
    const found = recheck(r, swap({ ...a, plannedEndMs: a.startMs + 361 * 60_000 }, b));
    expect(found.some(v => v.includes('longer than 360'))).toBe(true);
  });

  it('a break of 29 minutes', () => {
    const found = recheck(r, swap(a, { ...b, startMs: a.plannedEndMs! + 29 * 60_000 }));
    expect(found.some(v => v.includes('less than 30'))).toBe(true);
  });

  it('parts on two vehicles', () => {
    const found = recheck(r, swap(a, { ...b, vehicle: { ...b.vehicle, plate: 'XX-OTHER' } }));
    expect(found.some(v => v.includes('two vehicles'))).toBe(true);
  });

  it('a duty of 481 minutes', () => {
    const longA = { ...a, plannedEndMs: a.startMs + 300 * 60_000 };
    const longB = { ...b, plannedEndMs: b.startMs + 181 * 60_000 };
    const found = recheck(r, swap(longA, longB));
    expect(found.some(v => v.includes('exceed 480'))).toBe(true);
  });

  it('part 1 not ending at the base', () => {
    const found = recheck(r, swap({ ...a, endsAtBase: false }, b));
    expect(found.some(v => v.includes('does not end at the base'))).toBe(true);
  });

  it('two duties on one day', () => {
    const twin = { ...a, id: 'S-twin', dutyId: undefined, part: undefined, breakAfter: undefined, endsAtBase: undefined, vehicle: VEHICLES[1] };
    const found = recheck(r, [...r.month.shifts, twin]);
    expect(found.some(v => v.includes(`two duties on ${a.operatingDay}`))).toBe(true);
  });

  it('a week over 2880 minutes', () => {
    // A full week in mid-month: the first and last weeks of September 2026 are short.
    const mid = parts1.find(s => s.operatingDay >= '2026-09-14')!;
    const week = isoWeekStart(mid.operatingDay);
    const forged = r.month.shifts.map(s => (
      s.driver.id === mid.driver.id && isoWeekStart(s.operatingDay) === week
        ? { ...s, plannedEndMs: s.startMs + 360 * 60_000 }
        : s
    ));
    const found = recheck(r, forged);
    expect(found.some(v => v.includes('in the week of'))).toBe(true);
  });

  it('a lone part without its sibling', () => {
    expect(recheck(r, [...rest, a]).some(v => v.includes('exactly parts 1 and 2'))).toBe(true);
  });
});

describe('the closing workbook says what the break is', () => {
  const rows = shiftsSheetRows(r);
  const header = rows[0] as string[];
  const col = (name: string) => header.indexOf(name);

  it('appends Dienst-ID and Teil, one row per part', () => {
    expect(header.slice(-2)).toEqual(['Dienst-ID', 'Teil']);
    expect(rows.length - 1).toBe(r.month.shifts.length);
  });

  it('writes the break on part 1 and the duty on part 2, and a placed break is not zu pruefen', () => {
    const body = rows.slice(1);
    const one = body.find(row => row[col('Teil')] === 1)!;
    const two = body.find(row => row[col('Teil')] === 2 && row[col('Dienst-ID')] === one[col('Dienst-ID')])!;
    expect(String(one[col('Pausen')])).toMatch(/^Ruhepause \d\d:\d\d-\d\d:\d\d am Betriebssitz \(30 Min, § 4 ArbZG\), danach Teil 2$/);
    expect(String(two[col('Pausen')])).toMatch(/^Teil 2 nach der Ruhepause; Arbeitszeit des Dienstes \d+,\d\d Std\. \(§ 3 ArbZG\)$/);
    expect(one[col('Status')]).toBe('SIMULIERT - kein Arbeitszeitnachweis');
  });

  it('still marks a single shift over 360 minutes without a break zu pruefen', () => {
    const [x] = r.month.shifts;
    const long = { ...x, dutyId: undefined, part: undefined, breakAfter: undefined, plannedEndMs: x.startMs + 400 * 60_000, endMs: x.startMs + 400 * 60_000 };
    const rows2 = shiftsSheetRows({ ...r, month: { ...r.month, shifts: [long] } });
    expect(rows2[1][col('Status')]).toBe('zu pruefen');
  });
});

describe('sheet 7 states the working-time rule', () => {
  it('has a Regeln row for 8 hours a day, the unused 10-hour extension, the break and 48 hours a week', () => {
    const row = checksSheetRows(r, verifyMonth(r)).find(x => x[1] === 'Regeln' && x[2] === 'Arbeitszeit');
    expect(row).toBeDefined();
    const text = String(row![3]);
    expect(text).toContain('8 Std. am Tag');
    expect(text).toContain('10 Std.');
    expect(text).toContain('zwei Teile mit 30 Minuten Ruhepause am Betriebssitz');
    expect(text).toContain('48 Std. je Woche');
  });
});
