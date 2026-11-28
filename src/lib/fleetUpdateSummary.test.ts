import { describe, expect, it } from 'vitest';
import { updateFigures } from './fleetUpdateSummary';
import type { LegOutcome } from './partnerFleetImport';

type Done = Extract<LegOutcome, { status: 'done' }>;
const leg = (pull: Partial<Done['pull']>, result: Partial<Done['result']>): Done => ({
  scope: 'drivers', status: 'done', seen: 0,
  pull: { seen: null, new: null, departed: null, returned: null, truncated: false, ...pull },
  result: { created: 1, linked: 2, pending: null, skipped: [], ...result },
} as Done);

describe('updateFigures', () => {
  it('leaves out a figure the answer did not carry', () => {
    const keys = updateFigures('drivers', leg({}, {})).map(f => f.key);
    expect(keys).toEqual(['import.update.created', 'import.update.linked']);
  });
  it('lists every figure of a full driver answer in order', () => {
    const f = updateFigures('drivers', leg({ seen: 9, departed: 0 }, { pending: 3 }));
    expect(f.map(x => [x.key, x.count])).toEqual([
      ['import.update.seen', 9], ['import.update.created', 1], ['import.update.linked', 2],
      ['import.update.pending', 3], ['import.update.departed', 0],
    ]);
  });
  it('shows skipped for vehicles', () => {
    const f = updateFigures('vehicles', leg({}, { skipped: [{ linkId: 'x', label: 'y', reason: 'name_missing' }] } as never));
    expect(f[f.length - 1]).toEqual({ key: 'import.update.skipped', count: 1 });
  });
});
