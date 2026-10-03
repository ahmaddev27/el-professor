import { describe, expect, it } from 'vitest';
import type { Income } from '../types/receipt';
import { tallyTrips } from './incomeTrips';

const row = (type: Income['type'], trip_count: number | null | undefined): Income =>
  ({ id: 'x', driver_name: 'Ali', type, amount: 1, description: '', date: '2026-10-01', trip_count } as Income);

describe('tallyTrips', () => {
  it('counts a batch once, not once per type', () => {
    const batch = [row('umsatz', 12), row('aktionen', 12), row('trinkgeld', 12), row('bargeld', 12)];
    expect(tallyTrips(batch)).toEqual({ trips: 12, missing: 0 });
  });
  it('NULL is not zero', () => {
    expect(tallyTrips([row('umsatz', null)])).toEqual({ trips: null, missing: 1 });
    expect(tallyTrips([row('umsatz', undefined)])).toEqual({ trips: null, missing: 1 });
  });
  it('a recorded 0 is a figure', () => {
    expect(tallyTrips([row('umsatz', 0)])).toEqual({ trips: 0, missing: 0 });
  });
  it('a mix reports the gap', () => {
    expect(tallyTrips([row('umsatz', 5), row('umsatz', null)])).toEqual({ trips: 5, missing: 1 });
  });
});
