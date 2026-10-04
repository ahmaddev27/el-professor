/**
 * Saving and confirming a monthly plan.
 *
 * The RPCs were shipped in `20260930100000` and called by nothing, so these
 * assertions are about the join: that the payload carries exactly what the
 * database reads, that a refusal is reported as a refusal rather than as a
 * success, and that a 200 whose body is not the contract is not treated as one.
 *
 * The client is a stub with one `rpc` method — the module takes the shape rather
 * than the Supabase client for the reason `backup.ts` already states: importing
 * `src/lib/supabase` reads `window.location.origin` at module scope, and the
 * whole suite runs in the `node` environment, so a file that imported it could
 * not be loaded at all.
 */

import { describe, it, expect } from 'vitest';
import {
  confirmPlan,
  savePlan,
  savePlanAndConfirm,
  toSavePayload,
  type PlanRpcClient,
} from './monthlyPlanPersistence';
import type { StoredMonthlyPlan } from './monthlyPlanDocuments';

// ── a plan, in the contract's own shape ─────────────────────────────────────

function plan(over: Partial<StoredMonthlyPlan> = {}): StoredMonthlyPlan {
  return {
    id: null,
    company_id: 'c0000000-0000-4000-8000-00000000000a',
    year: 2026,
    month: 10,
    import_id: 'i0000000-0000-4000-8000-00000000000a',
    status: 'draft',
    switch_minutes: 30,
    generation: 2,
    warnings: [{ kind: 'unassigned_block', detail: 'no selected driver was available' }],
    drivers: [
      {
        driver_id: 'd0000000-0000-4000-8000-000000000001',
        driver_name: 'Anna Beispiel',
        selected: true,
        is_owner: false,
        planning_min_salary: 1950,
        planning_max_salary: 2100,
        planning_hourly_rate: 14,
        planning_priority: 100,
        planning_enabled: true,
        can_cover_other_drivers: true,
        range_problems: [],
      },
      {
        driver_id: 'd0000000-0000-4000-8000-000000000002',
        driver_name: 'Inhaber Demo',
        selected: false,
        is_owner: true,
        planning_min_salary: null,
        planning_max_salary: null,
        planning_hourly_rate: null,
        planning_priority: null,
        planning_enabled: null,
        can_cover_other_drivers: null,
        range_problems: ['missing_hourly_rate'],
      },
    ],
    blocks: [
      {
        block_key: 'b1',
        car_id: 'ca000000-0000-4000-8000-000000000001',
        car_identifier: null,
        starts_at: '2026-10-05T06:23:00.000Z',
        ends_at: '2026-10-05T07:44:00.000Z',
        span_minutes: 81,
        ride_minutes: 81,
        driver_id: 'd0000000-0000-4000-8000-000000000001',
        driver_name: 'Anna Beispiel',
        assignment_reason: 'best_fit',
        assignment_note_id: null,
        trips: [{
          trip_id: 't0000000-0000-4000-8000-000000000001',
          starts_at: '2026-10-05T06:23:00.000Z',
          ends_at: '2026-10-05T07:44:00.000Z',
          minutes: 81,
          time_source: 'instants',
          original_driver_id: null,
          original_driver_name: 'Importierter Fahrer',
        }],
      },
      {
        block_key: 'b2',
        car_id: null,
        car_identifier: 'B-DEMO-2',
        starts_at: '2026-10-06T06:00:00.000Z',
        ends_at: '2026-10-06T07:00:00.000Z',
        span_minutes: 60,
        ride_minutes: 60,
        driver_id: null,
        driver_name: null,
        assignment_reason: null,
        assignment_note_id: null,
        trips: [],
      },
    ],
    ...over,
  };
}

/** Records what it was called with, and answers what the test tells it to. */
function stub(answers: { data?: unknown; error?: unknown }[]): PlanRpcClient & {
  calls: { fn: string; args: Record<string, unknown> }[];
} {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  let i = 0;
  return {
    calls,
    rpc(fn, args) {
      calls.push({ fn, args });
      const a = answers[Math.min(i++, answers.length - 1)] ?? {};
      return Promise.resolve({ data: a.data ?? null, error: (a.error ?? null) as never });
    },
  };
}

const okSave = {
  data: {
    success: true, plan_id: 'p0000000-0000-4000-8000-00000000000a',
    year: 2026, month: 10, driver_count: 2, block_count: 2, trip_count: 1,
    discarded_drafts: 1,
  },
};

// ── the payload ─────────────────────────────────────────────────────────────

describe('toSavePayload', () => {
  /**
   * The load-bearing assertion of the whole module: a driver entry carries
   * **only** the two fields `monthly_plan_save` reads. The §13 snapshot — the
   * name, the owner flag and §4's eight planning values — is taken by
   * `monthly_plan_driver_guard` from `public.drivers` at write time and anything
   * the client sends for those columns is discarded. Sending them anyway would
   * not be wrong, it would read as if the browser decided the snapshot.
   */
  it('sends a driver as driver_id and selected, and nothing else', () => {
    const p = toSavePayload(plan());
    expect(p.drivers).toEqual([
      { driver_id: 'd0000000-0000-4000-8000-000000000001', selected: true },
      { driver_id: 'd0000000-0000-4000-8000-000000000002', selected: false },
    ]);
    for (const d of p.drivers) {
      expect(Object.keys(d).sort()).toEqual(['driver_id', 'selected']);
    }
  });

  it('sends no driver_name on a block either, for the same reason', () => {
    for (const b of toSavePayload(plan()).blocks) {
      expect(b).not.toHaveProperty('driver_name');
    }
  });

  it('carries every column the block insert names, including a null car and an unassigned block', () => {
    const [b1, b2] = toSavePayload(plan()).blocks;
    expect(b1).toMatchObject({
      block_key: 'b1',
      car_id: 'ca000000-0000-4000-8000-000000000001',
      car_identifier: null,
      span_minutes: 81,
      ride_minutes: 81,
      driver_id: 'd0000000-0000-4000-8000-000000000001',
      assignment_reason: 'best_fit',
      assignment_note_id: null,
    });
    // A block with no driver is kept, not filtered: §8 says leave it and warn.
    expect(b2.driver_id).toBeNull();
    expect(b2.car_id).toBeNull();
    expect(b2.car_identifier).toBe('B-DEMO-2');
    expect(b2.trips).toEqual([]);
  });

  it('nests each block\'s rides with the seven columns the ride insert reads', () => {
    const [t] = toSavePayload(plan()).blocks[0].trips;
    expect(Object.keys(t).sort()).toEqual([
      'ends_at', 'minutes', 'original_driver_id', 'original_driver_name',
      'starts_at', 'time_source', 'trip_id',
    ]);
  });

  it('counts the summary from the plan it is given, never from a stored figure', () => {
    expect(toSavePayload(plan()).summary).toEqual({
      block_count: 2,
      assigned_block_count: 1,
      unassigned_block_count: 1,
      trip_count: 1,
      driver_count: 2,
      selected_driver_count: 1,
      warning_count: 1,
    });
  });

  it('passes the header through unchanged, import_id included when it is null', () => {
    const p = toSavePayload(plan({ import_id: null, generation: 0 }));
    expect(p).toMatchObject({ year: 2026, month: 10, switch_minutes: 30, import_id: null, generation: 0 });
  });
});

// ── saving ──────────────────────────────────────────────────────────────────

describe('savePlan', () => {
  it('calls the RPC once with the payload under p_payload', async () => {
    const c = stub([okSave]);
    const r = await savePlan(c, plan());
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].fn).toBe('monthly_plan_save');
    expect(c.calls[0].args.p_payload).toEqual(toSavePayload(plan()));
    expect(r).toEqual({
      ok: true, planId: 'p0000000-0000-4000-8000-00000000000a',
      driverCount: 2, blockCount: 2, tripCount: 1, discardedDrafts: 1,
    });
  });

  /**
   * The HINT is the contract — every refusal in the migration sets one — so the
   * message is never parsed. Parsing a message is how a German sentence becomes
   * a control flow that breaks when someone improves the wording.
   */
  it('reads the refusal off the HINT, for each one the migration can raise', async () => {
    for (const hint of ['unauthenticated', 'no_company', 'not_authorized', 'monthly_plan_rows_lost']) {
      const c = stub([{ error: { hint, message: 'eine deutsche Meldung' } }]);
      const r = await savePlan(c, plan());
      expect(r).toEqual({ ok: false, reason: hint, detail: 'eine deutsche Meldung' });
    }
  });

  it('maps a broken argument contract to invalid_payload, which carries no hint', async () => {
    const c = stub([{ error: { code: '22023', message: 'p_payload must be a JSON object' } }]);
    const r = await savePlan(c, plan());
    expect(r).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it('calls anything else a transport failure rather than inventing a reason', async () => {
    const c = stub([{ error: { message: 'Failed to fetch' } }]);
    expect(await savePlan(c, plan())).toMatchObject({ ok: false, reason: 'network' });
  });

  /**
   * A 200 whose body is not the contract is not a success. Without this the
   * screen would report a plan id it does not have, and the confirm that follows
   * would be called with `undefined`.
   */
  it('refuses a 200 whose body is not the contract', async () => {
    for (const data of [null, {}, { success: true }, { success: false, plan_id: 'x' }, [1, 2]]) {
      const r = await savePlan(stub([{ data }]), plan());
      expect(r.ok, JSON.stringify(data)).toBe(false);
    }
  });
});

// ── confirming ──────────────────────────────────────────────────────────────

describe('confirmPlan', () => {
  it('passes the id and the replace flag, which defaults to false', async () => {
    const c = stub([{ data: { success: true, plan_id: 'p1', superseded_plan_id: null } }]);
    await confirmPlan(c, 'p1');
    expect(c.calls[0]).toEqual({
      fn: 'monthly_plan_confirm', args: { p_plan_id: 'p1', p_replace: false },
    });
    await confirmPlan(c, 'p1', { replace: true });
    expect(c.calls[1].args.p_replace).toBe(true);
  });

  it('reports the plan it superseded, which is what the screen tells the operator', async () => {
    const c = stub([{ data: { success: true, plan_id: 'p2', superseded_plan_id: 'p1' } }]);
    expect(await confirmPlan(c, 'p2', { replace: true }))
      .toEqual({ ok: true, planId: 'p2', supersededPlanId: 'p1' });
  });

  /**
   * `monthly_plan_confirm` answers its refusals as **values**, not exceptions,
   * because §9 has to offer the replace choice and §14 has to name its reasons.
   * Every reason the migration can return is carried through unchanged.
   */
  it('carries each refusal the migration returns as a value', async () => {
    const reasons = ['plan_not_found', 'not_a_draft', 'plan_empty', 'driver_not_in_plan',
                     'driver_overlap', 'vehicle_switch_gap', 'no_usable_range',
                     'exceeds_hours_cap', 'plan_exists'];
    for (const reason of reasons) {
      const c = stub([{ data: { success: false, reason, error: 'eine Begründung' } }]);
      expect(await confirmPlan(c, 'p1')).toEqual({ ok: false, reason, detail: 'eine Begründung' });
    }
  });

  it('still reads a raised refusal off its hint, so both shapes reach one place', async () => {
    const c = stub([{ error: { hint: 'not_authorized', message: 'Keine Berechtigung' } }]);
    expect(await confirmPlan(c, 'p1')).toMatchObject({ ok: false, reason: 'not_authorized' });
  });
});

// ── the screen's one action ─────────────────────────────────────────────────

describe('savePlanAndConfirm', () => {
  it('saves, then confirms the id the save returned', async () => {
    const c = stub([okSave, { data: { success: true, plan_id: 'p0000000-0000-4000-8000-00000000000a', superseded_plan_id: null } }]);
    const r = await savePlanAndConfirm(c, plan());
    expect(c.calls.map(x => x.fn)).toEqual(['monthly_plan_save', 'monthly_plan_confirm']);
    expect(c.calls[1].args.p_plan_id).toBe('p0000000-0000-4000-8000-00000000000a');
    expect(r).toMatchObject({ ok: true });
  });

  it('does not confirm when the save was refused', async () => {
    const c = stub([{ error: { hint: 'not_authorized' } }]);
    const r = await savePlanAndConfirm(c, plan());
    expect(c.calls.map(x => x.fn)).toEqual(['monthly_plan_save']);
    expect(r).toMatchObject({ ok: false, reason: 'not_authorized' });
  });

  /**
   * The draft exists even when the confirmation is refused, so its id travels
   * with the refusal: the screen offers "replace this month's plan" against
   * **this** draft rather than saving a second one, which the save would then
   * discard — leaving the operator pressing a button that appears to do nothing.
   */
  it('returns the draft id with a refused confirmation', async () => {
    const c = stub([okSave, { data: { success: false, reason: 'plan_exists' } }]);
    const r = await savePlanAndConfirm(c, plan());
    expect(r).toMatchObject({
      ok: false, reason: 'plan_exists', planId: 'p0000000-0000-4000-8000-00000000000a',
    });
  });
});
