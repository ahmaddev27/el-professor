import { describe, expect, it } from 'vitest';
import { compareFigures, monthFigures, type MonthResultLike } from './round8Figures.mts';

const H = 3_600_000;
const shift = (id: string, driver: string, day: string, hours: number) => ({
  id, operatingDay: day, startMs: Date.UTC(2026, 8, 1, 6), endMs: Date.UTC(2026, 8, 1, 6) + hours * H,
  vehicle: { plate: 'W-DE 1', id: 'car-1' }, driver: { name: `Fahrer ${driver}`, id: driver },
});
const ride = (status: string, km: number) => ({ status, shiftId: 's1', vehicle: { plate: 'W-DE 1', id: 'car-1' }, driver: { name: 'Fahrer a', id: 'a' }, startMs: 0, km });

const result = (over: Partial<MonthResultLike> = {}): MonthResultLike => ({
  month: {
    rides: [ride('completed', 4.25), ride('completed', 6), ride('cancelled', 0), ride('declined', 0)],
    shifts: [shift('s1', 'a', '2026-09-01', 3), shift('s2', 'a', '2026-09-01', 2), shift('s3', 'b', '2026-09-02', 6)],
    droppedShifts: 1,
  },
  revenue: { fareCents: 12_345, tipCents: 250, cancelledFeeCents: 500 },
  repositioningSummary: { legs: 5, roadKm: 12.34, byPurpose: { to_base: 3, between_rides: 2 } },
  refusals: [{}],
  violations: [],
  ...over,
});
const verification = { verdict: 'VALIDATED_FOR_EXPORT', routing: 'measured', checks: [{ code: 'rules', outcome: 'passed' }, { code: 'reconciliation', outcome: 'not_verified' }] };
const meta = { label: 'nachher', month: '2026-09', seed: 202609, base: 'gespeicherter Punkt' };

describe('monthFigures', () => {
  it('counts what both generators have, and names no driver, vehicle or address', () => {
    const f = monthFigures(meta, result(), verification);
    expect(f).toMatchObject({
      ridesByStatus: { completed: 2, cancelled: 1, declined: 1 }, completedKm: 10.3,
      shifts: 3, droppedShifts: 1, shiftMinutes: { min: 120, median: 180, max: 360 },
      driversWithShifts: 2, vehiclesWithShifts: 1, operatingDaysWithShifts: 2, maxShiftsPerDriverDay: 2,
      emptyLegs: 5, emptyRoadKm: 12.3, capacityRefusals: 1, violations: 0,
      checksNotPassed: ['reconciliation=not_verified'],
    });
    expect(JSON.stringify(f)).not.toMatch(/Fahrer|W-DE/);
  });

  it('a month without shifts has no spread rather than a zero one', () => {
    const f = monthFigures(meta, result({ month: { rides: [], shifts: [], droppedShifts: 0 } }), verification);
    expect(f.shiftMinutes).toBeNull();
    expect(f.maxShiftsPerDriverDay).toBe(0);
  });
});

describe('compareFigures', () => {
  const after = monthFigures(meta, result(), verification);
  const before = monthFigures({ ...meta, label: 'vorher', base: 'Mitte des Adresspools' }, result({ revenue: { fareCents: 10_000, tipCents: 250, cancelledFeeCents: 500 } }), { ...verification, checks: [] });

  it('writes one row per figure with the change, in German formatting', () => {
    const md = compareFigures(before, after, ['Vorher: Formular mit 1 Schicht je Fahrzeug und Tag']);
    expect(md).toContain('| Fahrpreise | 100,00 € | 123,45 € | 23,45 € |');
    expect(md).toContain('| Trinkgeld | 2,50 € | 2,50 € | gleich |');
    expect(md).toContain('| Startpunkt der Schichten | Mitte des Adresspools | gespeicherter Punkt | geändert |');
    expect(md).toContain('| Nicht bestandene Prüfungen | keine | reconciliation=not_verified | geändert |');
    expect(md).toContain('- Vorher: Formular mit 1 Schicht je Fahrzeug und Tag');
  });

  it('refuses to compare two different months', () => {
    expect(() => compareFigures({ ...before, month: '2026-10' }, after)).toThrow(/comparing 2026-10 with 2026-09/);
  });
});
