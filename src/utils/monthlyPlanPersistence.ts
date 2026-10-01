/**
 * Saving a monthly plan, and confirming it.
 *
 * ## What this closes
 *
 * `20260930100000` shipped four tables, two RPCs, the partial unique index that
 * enforces one confirmed plan per month, and an advisory lock — and **nothing in
 * the browser called any of it**. The screen said *Planung fertig* over a
 * `monthly_plans` table holding zero rows, §10's planned Fahrtenbuch could never
 * be produced (it reads the import's original rows through a saved plan's id,
 * so its tab showed a refusal and a disabled download), and the one-plan-per-
 * month rule applied to nothing.
 *
 * ## Why the payload is a subset of the plan, and not the plan
 *
 * `monthly_plan_save` reads **only** the fields the database cannot derive:
 * from a driver it takes `driver_id` and `selected` and nothing else, and from a
 * block it takes no `driver_name`. The §13 snapshot — the name, the owner flag
 * and §4's eight planning values — is taken by `app_private.monthly_plan_driver_guard`
 * from `public.drivers` at write time, and anything the client sends for those
 * columns is discarded. So sending the whole `StoredMonthlyPlan` would not be
 * wrong, it would be **misleading**: it would read as if the browser decided the
 * snapshot. `toSavePayload` sends what is actually read, so the file says where
 * each figure comes from.
 *
 * ## The two outcomes are shaped differently, and deliberately
 *
 * `save` **raises** on a refusal: an unauthenticated caller, a company whose
 * state forbids it, a role without the Dokumente page, a payload that does not
 * parse, or rows that did not all reach the tables. `confirm` **returns** its
 * refusals as values, because §9 has to offer the operator a choice ("a plan
 * already exists — replace it?") and §14 has to name its reasons. This module
 * keeps both shapes rather than flattening them: `savePlan` turns a raised
 * refusal into the same `{ok:false, reason}` the confirm path uses, so a screen
 * has one shape to render, while the reason codes stay the database's own.
 */

import type { StoredMonthlyPlan } from './monthlyPlanDocuments';

/** The reason codes both RPCs can answer with. German is the screen's job. */
export type MonthlyPlanSaveReason =
  | 'unauthenticated'
  | 'no_company'
  | 'not_authorized'
  | 'invalid_payload'
  | 'monthly_plan_rows_lost'
  | 'network';

export type MonthlyPlanConfirmReason =
  | MonthlyPlanSaveReason
  | 'plan_not_found'
  | 'not_a_draft'
  | 'plan_empty'
  | 'driver_not_in_plan'
  | 'driver_overlap'
  | 'vehicle_switch_gap'
  | 'no_usable_range'
  | 'exceeds_hours_cap'
  | 'plan_exists';

export interface SaveOk {
  ok: true;
  planId: string;
  driverCount: number;
  blockCount: number;
  tripCount: number;
  /** Earlier drafts of the same month that this save replaced. */
  discardedDrafts: number;
}

export interface ConfirmOk {
  ok: true;
  planId: string;
  /** A plan this confirmation superseded, when the caller asked to replace. */
  supersededPlanId: string | null;
}

export interface Refused<R> {
  ok: false;
  reason: R;
  /** The database's own sentence where it gave one; never invented here. */
  detail: string | null;
}

export type SaveResult = SaveOk | Refused<MonthlyPlanSaveReason>;
export type ConfirmResult = ConfirmOk | Refused<MonthlyPlanConfirmReason>;

/** The one `rpc` shape this module needs, so a test needs no Supabase client. */
export interface PlanRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message?: string; hint?: string | null; code?: string | null } | null;
  }>;
}

// ── the payload ─────────────────────────────────────────────────────────────

/** A ride as `monthly_plan_block_trips` stores it. */
interface SaveTrip {
  trip_id: string;
  starts_at: string;
  ends_at: string;
  minutes: number;
  time_source: string;
  original_driver_id: string | null;
  original_driver_name: string | null;
}

interface SaveBlock {
  block_key: string;
  car_id: string | null;
  car_identifier: string | null;
  starts_at: string;
  ends_at: string;
  span_minutes: number;
  ride_minutes: number;
  driver_id: string | null;
  assignment_reason: string | null;
  assignment_note_id: string | null;
  trips: SaveTrip[];
}

export interface MonthlyPlanSavePayload {
  year: number;
  month: number;
  switch_minutes: number;
  import_id: string | null;
  generation: number;
  warnings: unknown[];
  summary: Record<string, unknown>;
  drivers: { driver_id: string; selected: boolean }[];
  blocks: SaveBlock[];
}

/**
 * The plan as `monthly_plan_save` reads it.
 *
 * `summary` is the screen's own counts, stored so a plan reopened later can say
 * what it was without re-running the engine. It carries no figure the tables do
 * not also hold — it is a convenience, never a source.
 */
export function toSavePayload(plan: StoredMonthlyPlan): MonthlyPlanSavePayload {
  const assigned = plan.blocks.filter(b => b.driver_id !== null).length;
  return {
    year: plan.year,
    month: plan.month,
    switch_minutes: plan.switch_minutes,
    import_id: plan.import_id,
    generation: plan.generation,
    warnings: [...plan.warnings],
    summary: {
      block_count: plan.blocks.length,
      assigned_block_count: assigned,
      unassigned_block_count: plan.blocks.length - assigned,
      trip_count: plan.blocks.reduce((n, b) => n + b.trips.length, 0),
      driver_count: plan.drivers.length,
      selected_driver_count: plan.drivers.filter(d => d.selected).length,
      warning_count: plan.warnings.length,
    },
    // Only the two fields the database reads. The §13 snapshot is the trigger's.
    drivers: plan.drivers.map(d => ({ driver_id: d.driver_id, selected: d.selected })),
    blocks: plan.blocks.map(b => ({
      block_key: b.block_key,
      car_id: b.car_id,
      car_identifier: b.car_identifier,
      starts_at: b.starts_at,
      ends_at: b.ends_at,
      span_minutes: b.span_minutes,
      ride_minutes: b.ride_minutes,
      driver_id: b.driver_id,
      assignment_reason: b.assignment_reason,
      assignment_note_id: b.assignment_note_id,
      trips: b.trips.map(t => ({
        trip_id: t.trip_id,
        starts_at: t.starts_at,
        ends_at: t.ends_at,
        minutes: t.minutes,
        time_source: t.time_source,
        original_driver_id: t.original_driver_id,
        original_driver_name: t.original_driver_name,
      })),
    })),
  };
}

// ── reading the answer ──────────────────────────────────────────────────────

const SAVE_REASONS = new Set<string>([
  'unauthenticated', 'no_company', 'not_authorized', 'monthly_plan_rows_lost',
]);

/**
 * The reason behind a PostgREST error.
 *
 * The HINT is the contract — every refusal in the migration sets one — so it is
 * read first and the message is never parsed. A `22023` carries no hint because
 * it is a broken argument contract rather than a refusal, and it maps to
 * `invalid_payload`; anything else is a transport failure, which is `network`
 * and not a refusal the operator can act on.
 */
function reasonOf(error: { hint?: string | null; code?: string | null }): MonthlyPlanSaveReason {
  const hint = (error.hint ?? '').trim();
  if (SAVE_REASONS.has(hint)) return hint as MonthlyPlanSaveReason;
  if (error.code === '22023') return 'invalid_payload';
  return 'network';
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const asInt = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ── the two calls ───────────────────────────────────────────────────────────

/**
 * Writes the plan as a draft, replacing the month's earlier drafts.
 *
 * Replacing is the RPC's own behaviour, not this function's: it deletes the
 * month's `draft` rows under the advisory lock before inserting, so pressing the
 * button twice leaves one draft rather than two. A **confirmed** plan is never
 * touched here — that is `confirmPlan`'s `replace`, which supersedes rather than
 * deletes.
 */
export async function savePlan(
  client: PlanRpcClient,
  plan: StoredMonthlyPlan,
): Promise<SaveResult> {
  const { data, error } = await client.rpc('monthly_plan_save', {
    p_payload: toSavePayload(plan),
  });

  if (error) {
    return { ok: false, reason: reasonOf(error), detail: error.message ?? null };
  }
  const row = asRecord(data);
  if (!row || row.success !== true || typeof row.plan_id !== 'string') {
    // A 200 whose body is not the contract is not a success. Saying so is what
    // keeps the screen from reporting a plan id it does not have.
    return { ok: false, reason: 'network', detail: null };
  }
  return {
    ok: true,
    planId: row.plan_id,
    driverCount: asInt(row.driver_count),
    blockCount: asInt(row.block_count),
    tripCount: asInt(row.trip_count),
    discardedDrafts: asInt(row.discarded_drafts),
  };
}

/**
 * Confirms a saved draft, optionally superseding the month's confirmed plan.
 *
 * Its refusals come back as values because §9 has to offer the replace choice
 * and §14 has to name its reasons; only the four shared refusals and a broken
 * contract raise, and those are mapped to the same shape here.
 */
export async function confirmPlan(
  client: PlanRpcClient,
  planId: string,
  options: { replace?: boolean } = {},
): Promise<ConfirmResult> {
  const { data, error } = await client.rpc('monthly_plan_confirm', {
    p_plan_id: planId,
    p_replace: options.replace === true,
  });

  if (error) {
    return { ok: false, reason: reasonOf(error), detail: error.message ?? null };
  }
  const row = asRecord(data);
  if (!row) return { ok: false, reason: 'network', detail: null };

  if (row.success === true) {
    return {
      ok: true,
      planId: typeof row.plan_id === 'string' ? row.plan_id : planId,
      supersededPlanId: typeof row.superseded_plan_id === 'string' ? row.superseded_plan_id : null,
    };
  }
  return {
    ok: false,
    reason: (typeof row.reason === 'string' ? row.reason : 'network') as MonthlyPlanConfirmReason,
    detail: typeof row.detail === 'string' ? row.detail
          : typeof row.error === 'string' ? row.error
          : null,
  };
}

/**
 * Save and confirm as the screen's one action.
 *
 * Two calls and not one, because they are two transactions by design: the save
 * takes the month's advisory lock, writes and releases it, and the confirm takes
 * it again to re-derive §7's rules against the **stored** rows rather than
 * against whatever the browser still holds. A screen that saved without
 * confirming would leave a draft the operator cannot see.
 */
export async function savePlanAndConfirm(
  client: PlanRpcClient,
  plan: StoredMonthlyPlan,
  options: { replace?: boolean } = {},
): Promise<ConfirmResult & { planId?: string }> {
  const saved = await savePlan(client, plan);
  if (!saved.ok) return saved;

  const confirmed = await confirmPlan(client, saved.planId, options);
  // The draft exists either way, so its id travels with a refusal too: the
  // screen offers "replace" against this id rather than saving a second draft.
  return confirmed.ok ? confirmed : { ...confirmed, planId: saved.planId };
}
