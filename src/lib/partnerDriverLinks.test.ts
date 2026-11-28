import { describe, expect, it } from 'vitest';
import { decisionReasonKey, fetchLinkRows, summariseLinks, type LinkRow } from './partnerDriverLinks';

const row = (over: Partial<LinkRow>): LinkRow => ({
  id: 'l', driver_id: null, status: 'pending', partner_removed_at: null, decision_reason: null, ...over,
});

describe('summariseLinks', () => {
  it('counts pending and marks linked and departed drivers', () => {
    const s = summariseLinks([
      row({ status: 'pending' }), row({ status: 'pending' }),
      row({ status: 'linked', driver_id: 'a' }),
      row({ status: 'linked', driver_id: 'b', partner_removed_at: '2026-11-01' }),
      row({ status: 'rejected', driver_id: 'c' }),
    ]);
    expect(s.pending).toBe(2);
    expect([...s.byDriver]).toEqual([['a', 'linked'], ['b', 'departed']]);
  });

  it('names the link row of every linked driver, and of no other', () => {
    const s = summariseLinks([
      row({ id: 'l-a', status: 'linked', driver_id: 'a' }),
      row({ id: 'l-b', status: 'linked', driver_id: 'b', partner_removed_at: '2026-11-01' }),
      row({ id: 'l-p', status: 'pending' }),
      row({ id: 'l-r', status: 'rejected', driver_id: 'c' }),
    ]);
    expect([...s.linkIdByDriver]).toEqual([['a', 'l-a'], ['b', 'l-b']]);
  });
});

describe('decisionReasonKey', () => {
  it('maps the five reasons and nothing else', () => {
    expect(decisionReasonKey('name_ambiguous')).toBe('partner.links.reason.nameAmbiguous');
    expect(decisionReasonKey('unlinked')).toBe('partner.links.reason.unlinked');
    expect(decisionReasonKey('whatever')).toBeNull();
    expect(decisionReasonKey(null)).toBeNull();
  });
});

describe('fetchLinkRows', () => {
  it('pages past 1000 rows', async () => {
    const ranges: number[] = [];
    const client = {
      from: () => {
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'order']) q[m] = () => q;
        q.range = async (from: number) => {
          ranges.push(from);
          const n = from === 0 ? 1000 : 3;
          return { data: Array.from({ length: n }, (_, i) => row({ id: `${from}-${i}` })), error: null };
        };
        return q;
      },
    };
    expect(await fetchLinkRows(client, 'c')).toHaveLength(1003);
    expect(ranges).toEqual([0, 1000]);
  });
});
