import { describe, expect, it } from 'vitest';
import { blockerArea, blockerAreas, isReferenceRefusal, mayDeleteDriver, parseDeleteCheck } from './driverDelete';

describe('parseDeleteCheck', () => {
  it('reads deletable, blocked and refused answers', () => {
    expect(parseDeleteCheck({ ok: true, deletable: true, blockers: [] })).toEqual({ kind: 'deletable' });
    expect(parseDeleteCheck({ ok: true, deletable: false, blockers: [{ table: 'salaries', rows: 2 }, { bad: 1 }] }))
      .toEqual({ kind: 'blocked', blockers: [{ table: 'salaries', rows: 2 }] });
    expect(parseDeleteCheck({ ok: false, reason: 'not_authorized' })).toEqual({ kind: 'refused', reason: 'not_authorized' });
  });
  it('never reads an unreadable answer as deletable', () => {
    for (const bad of [null, 'x', {}, { ok: true }, { ok: true, deletable: 'yes', blockers: [] }]) {
      expect(parseDeleteCheck(bad)).toBeNull();
    }
  });
});

describe('blockers in words', () => {
  it('maps tables and prefixes to areas, unknown to other', () => {
    expect(blockerArea('fahrtenbuch_trips')).toBe('trips');
    expect(blockerArea('historical_time_adjustments')).toBe('reconciliation');
    expect(blockerArea('abrechnung_deliveries')).toBe('abrechnung');
    expect(blockerArea('fahrtenbuch_assignment_audit')).toBe('trips');
    expect(blockerArea('monthly_plan_block_trips')).toBe('planning');
    expect(blockerArea('monthly_planning_manual_exceptions')).toBe('planning');
    expect(blockerArea('zzz')).toBe('other');
  });
  it('sums rows per area in a fixed order', () => {
    expect(blockerAreas([{ table: 'salary_payments', rows: 1 }, { table: 'salaries', rows: 2 }, { table: 'fahrtenbuch_trips', rows: 5 }]))
      .toEqual([{ area: 'trips', rows: 5 }, { area: 'salaries', rows: 3 }]);
  });
});

describe('guards', () => {
  it('recognises the trigger hint only', () => {
    expect(isReferenceRefusal({ hint: 'driver_has_references' })).toBe(true);
    expect(isReferenceRefusal({ hint: 'other' })).toBe(false);
    expect(isReferenceRefusal(null)).toBe(false);
  });
  it('admin or support session, never read-only', () => {
    expect(mayDeleteDriver(true, { readOnly: false, kind: 'own' })).toBe(true);
    expect(mayDeleteDriver(false, { readOnly: false, kind: 'support' })).toBe(true);
    expect(mayDeleteDriver(false, { readOnly: false, kind: 'own' })).toBe(false);
    expect(mayDeleteDriver(true, { readOnly: true, kind: 'view' })).toBe(false);
  });
});
