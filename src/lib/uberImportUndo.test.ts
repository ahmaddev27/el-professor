import { describe, expect, it } from 'vitest';
import {
  blockerGroupKey,
  nothingToUndo,
  parseUndoPreview,
  parseUndoResult,
  summariseBlockers,
  undoErrorKey,
} from './uberImportUndo';

const good = () => ({
  ok: true, dry_run: true, company_name: 'Test A',
  income: { rows: 6, from: '2026-08-31', to: '2026-09-06', drivers: 6 },
  hand_typed_rows: 2,
  drivers: {
    delete: [{ id: 'd1', name: 'Ann' }, { id: 'd2', name: 'Eve' }],
    keep: [{ id: 'd3', name: 'Bob', blockers: { 'salaries.driver_id': 1 } }],
    untouched: 1,
  },
  cars: { delete: [{ id: 'c1', plate: 'AB-1' }], keep: [], untouched: 0 },
  salaries_affected: 1,
  expect: { income: 6, drivers: 2, cars: 1 },
});

describe('parseUndoPreview', () => {
  it('reads a complete answer', () => {
    const p = parseUndoPreview(good());
    expect(p?.expect).toEqual({ income: 6, drivers: 2, cars: 1 });
    expect(p?.drivers.keep[0]).toEqual({ id: 'd3', label: 'Bob', blockers: { 'salaries.driver_id': 1 } });
    expect(p?.cars.remove[0].label).toBe('AB-1');
  });

  it('treats an unreadable answer as a failure, never as "nothing to delete"', () => {
    expect(parseUndoPreview(null)).toBeNull();
    expect(parseUndoPreview({})).toBeNull();
    expect(parseUndoPreview({ ...good(), ok: false })).toBeNull();
    // A real run's answer is not a preview.
    expect(parseUndoPreview({ ...good(), dry_run: false })).toBeNull();
    const noIncome: Record<string, unknown> = good();
    delete noIncome.income;
    expect(parseUndoPreview(noIncome)).toBeNull();
  });

  it('refuses a preview whose counts disagree with its own lists', () => {
    expect(parseUndoPreview({ ...good(), expect: { income: 6, drivers: 3, cars: 1 } })).toBeNull();
    expect(parseUndoPreview({ ...good(), expect: { income: 5, drivers: 2, cars: 1 } })).toBeNull();
  });

  it('refuses a kept row that has no reason, and a negative or fractional count', () => {
    const noReason = { ...good(), drivers: { ...good().drivers, keep: [{ id: 'd3', name: 'Bob', blockers: {} }] } };
    expect(parseUndoPreview(noReason)).toBeNull();
    expect(parseUndoPreview({ ...good(), hand_typed_rows: -1 })).toBeNull();
    expect(parseUndoPreview({ ...good(), salaries_affected: 1.5 })).toBeNull();
  });

  it('refuses a period that is present without rows or rows without a period', () => {
    expect(parseUndoPreview({ ...good(), income: { rows: 0, from: '2026-08-31', to: '2026-09-06', drivers: 0 }, expect: { income: 0, drivers: 2, cars: 1 } })).toBeNull();
    expect(parseUndoPreview({ ...good(), income: { rows: 6, from: null, to: null, drivers: 6 } })).toBeNull();
  });
});

describe('nothingToUndo', () => {
  it('is true only when no income, driver or car is left to delete', () => {
    const empty = {
      ...good(), income: { rows: 0, from: null, to: null, drivers: 0 },
      drivers: { delete: [], keep: good().drivers.keep, untouched: 0 },
      cars: { delete: [], keep: [], untouched: 0 }, expect: { income: 0, drivers: 0, cars: 0 },
    };
    expect(nothingToUndo(parseUndoPreview(empty)!)).toBe(true);
    expect(nothingToUndo(parseUndoPreview(good())!)).toBe(false);
  });
});

describe('parseUndoResult', () => {
  it('needs every count', () => {
    const answer = { ok: true, dry_run: false, deleted: { income: 6, drivers: 2, cars: 1 }, kept: { drivers: 3, cars: 1 } };
    expect(parseUndoResult(answer)).toEqual({ income: 6, drivers: 2, cars: 1, keptDrivers: 3, keptCars: 1 });
    expect(parseUndoResult({ ...answer, kept: {} })).toBeNull();
    expect(parseUndoResult({ ...answer, dry_run: true })).toBeNull();
  });
});

describe('undoErrorKey', () => {
  it('maps the stable hints and falls back to a generic message that says nothing was deleted', () => {
    expect(undoErrorKey('platform_session_not_allowed')).toBe('import.error.platformSession');
    expect(undoErrorKey('plan_changed')).toBe('import.undo.err.planChanged');
    expect(undoErrorKey('confirmation_mismatch')).toBe('import.undo.err.mismatch');
    expect(undoErrorKey(undefined)).toBe('import.undo.err.generic');
  });
});

describe('summariseBlockers', () => {
  const label = (key: string) => key.split('.').pop()!;
  it('sums the columns of one group and sorts the groups', () => {
    expect(summariseBlockers({ 'salaries.driver_id': 1, 'receipts.driver_name': 2, 'income.driver_name': 3 }, label))
      .toBe('income (3), receipts (2), salaries (1)');
    expect(summariseBlockers({ 'fahrtenbuch_trips.assigned_driver_name': 2, 'fahrtenbuch_trips.original_driver_name': 3 }, label))
      .toBe('fahrtenbuch (5)');
  });
  it('prints a table nobody named as it is, so a new reference is never hidden', () => {
    expect(blockerGroupKey('brand_new_table.driver_id')).toBeNull();
    expect(summariseBlockers({ 'brand_new_table.driver_id': 4 }, label)).toBe('brand_new_table (4)');
  });
});
