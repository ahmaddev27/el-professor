import { describe, expect, it } from 'vitest';
import type { StructuredNote } from '../monatsplanungPhase3';
import { addDays, generateFromFigures, mondaysOfMonth, type FiguresInput, type IncomeRow } from './figures';
import type { PoolAddress } from './types';

/**
 * The business-weeks mode reads the same events the calendar month does
 * (decision 5 of 29.10.2026). Before this, it passed drivers by name and
 * vehicles without an id, so no note and no TÜV date ever reached it.
 */
const BASE = { lat: 51.12, lon: 7.05 };
const POOL: PoolAddress[] = Array.from({ length: 144 }, (_, i) => ({
  label: `Teststraße ${i + 1}, 40210 Demostadt, Deutschland`,
  lat: 51.1 + Math.floor(i / 12) * 0.006,
  lon: 7.0 + (i % 12) * 0.009,
}));
const DRIVER = { id: '22222222-2222-4222-8222-222222222201', name: 'Fahrer 1' };

function income(): IncomeRow[] {
  return mondaysOfMonth(2026, 9).flatMap(monday => {
    const date = addDays(monday, 6);
    return [
      { driver_name: DRIVER.name, type: 'umsatz', date, amount: 1400 },
      { driver_name: DRIVER.name, type: 'bargeld', date, amount: 420 },
      { driver_name: DRIVER.name, type: 'trinkgeld', date, amount: 20 },
    ];
  });
}

const input = (over: Partial<FiguresInput>): FiguresInput => ({
  year: 2026, month: 9, base: BASE, pool: POOL,
  vehicles: [{ id: '11111111-1111-4111-8111-111111111101', plate: 'XX-TEST-1', type: 'T', tuev_gueltig_bis: '2027-01-31' }, { id: '11111111-1111-4111-8111-111111111102', plate: 'XX-TEST-2', type: 'T', tuev_gueltig_bis: '2027-01-31' }],
  drivers: [DRIVER], income: income(), occupied: new Set(), seed: 77, ...over,
});

const sick: StructuredNote = {
  id: 'note-1', driver_id: DRIVER.id, note_type: 'vacation', note_text: '', note_planning_behavior: 'exclude_from_plan', is_full_day: true,
  start_date: '2026-09-14', end_date: '2026-09-20', note_date: '2026-09-01T08:00:00.000Z', start_time: null, end_time: null,
};

describe('the weeks mode reads the events before it plans', () => {
  it('places no shift inside a confirmed note of the driver, and records the refusal', () => {
    const out = generateFromFigures(input({ driverNotesMap: new Map([[DRIVER.id, [sick]]]) }));
    const inside = out.month.shifts.filter(s => s.operatingDay >= '2026-09-14' && s.operatingDay <= '2026-09-20');
    expect(inside).toEqual([]);
    expect(out.findings.some(f => f.weekMonday === '2026-09-14' && f.code === 'cannot_explain')).toBe(true);
    expect(out.decisions.some(d => d.code === 'driver_blocked_by_note' && d.eventRef === 'note-1')).toBe(true);
  });

  it('keeps a vehicle off from the day after its TÜV expired', () => {
    const vehicles = [{ id: '11111111-1111-4111-8111-111111111101', plate: 'XX-TEST-1', type: 'T', tuev_gueltig_bis: '2026-09-10' }, { id: '11111111-1111-4111-8111-111111111102', plate: 'XX-TEST-2', type: 'T', tuev_gueltig_bis: '2027-01-31' }];
    const out = generateFromFigures(input({ vehicles }));
    expect(out.month.shifts.filter(s => s.vehicle.plate === 'XX-TEST-1' && s.operatingDay > '2026-09-10')).toEqual([]);
    expect(out.month.shifts.length).toBeGreaterThan(0);
  });

  it('records every placed shift with its decision', () => {
    const out = generateFromFigures(input({}));
    const accepted = out.decisions.filter(d => d.outcome !== 'excluded');
    expect(accepted).toHaveLength(out.month.shifts.length);
    expect(accepted.every(d => d.driverId === DRIVER.id)).toBe(true);
  });
});
