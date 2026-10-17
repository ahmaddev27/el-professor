import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));

import { refusal } from './uberBackfillDeps';

describe('a refusal keeps the reason the edge function named', () => {
  it('carries the fixed problem code beside the sentence', () => {
    expect(refusal({ ok: false, reason: 'partner_malformed', problem: 'amount_invalid' }))
      .toEqual({ ok: false, reason: 'inc.uber.err.partnerMalformed', detail: 'amount_invalid' });
    expect(refusal({ ok: false, reason: 'partner_malformed', problem: 'driver_duplicated' }))
      .toMatchObject({ detail: 'driver_duplicated' });
  });

  it('shows a different code for a different cause, so the two can be told apart', () => {
    const a = refusal({ reason: 'partner_malformed', problem: 'amount_invalid' });
    const b = refusal({ reason: 'partner_malformed', problem: 'range_mismatch' });
    expect(a).not.toEqual(b);
  });

  it('drops a problem that is not a fixed code, and a refusal without one stays as it was', () => {
    expect(refusal({ reason: 'partner_malformed', problem: 'Bearer abc <script>' }))
      .toEqual({ ok: false, reason: 'inc.uber.err.partnerMalformed' });
    expect(refusal({ reason: 'partner_unavailable' }))
      .toEqual({ ok: false, reason: 'inc.uber.err.partnerUnavailable' });
  });
});
