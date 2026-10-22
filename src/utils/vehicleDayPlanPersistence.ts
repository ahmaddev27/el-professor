/**
 * Keeping the shift recommendation: saving a month's vehicle day plan,
 * confirming it, and reading it back (migration 20261022140000).
 *
 * ## Why this is not in `shiftRecommendation/`
 *
 * That folder is pure on purpose: `boundary.test.ts` fails it if it names a
 * table, reads the clock or imports outside a four-module allow-list, and its
 * header records why (the owner declined ride generation on 08.10.2026). This
 * module is the other side of that line, as `monthlyPlanPersistence.ts` is for
 * `monthlyPlan/`: it takes what the engine produced and moves it to and from
 * `vehicle_day_plans` / `vehicle_day_shifts`. It imports only the engine's
 * *types*.
 *
 * ## The three rules, from the client's side
 *
 * 1. **The operating day's start hour is the profile's, never a constant.**
 *    `toSavePayload` reads `profile.settings.operatingDayStartHour` and
 *    `.slotMinutes` and has no default for either: this file imports neither
 *    `DEFAULT_PROFILE_SETTINGS` nor any literal hour, and a test reads this
 *    source to keep it so. The database stores the hour on the plan, recomputes
 *    each shift's moments from it and refuses a contradiction, so a caller that
 *    passes a profile other than the one the plan was made from gets
 *    `shift_inconsistent`, not a wrong plan. Reading back works the same way:
 *    `loadVehicleDayPlan` returns the plan's own hour and the moments that were
 *    stored, and computes nothing from a constant.
 * 2. **No driver.** A shift is a vehicle, a day and a window. The payload's keys
 *    are a closed list (the RPC refuses any other), and a test compares it with
 *    the RPC's own list in the migration.
 * 3. **No ride, no address, no fare.** `expected_revenue_cents` is the engine's
 *    estimate for a window.
 *
 * ## The two outcomes are shaped differently, as the monthly plan's are
 *
 * `save` raises on a refusal and `confirm` answers some as values, because the
 * screen has to offer "replace the active plan" (`plan_exists`) and say why a
 * plan cannot be confirmed. This module turns both into one `{ ok, reason }`
 * shape, with the database's own reason words.
 *
 * ## Not wired to a screen yet
 *
 * `ShiftRecommendationPage` still writes nothing. The button that calls
 * `saveVehicleDayPlan` belongs to the slice that decides the copy and the
 * replace flow; it must ask `useCompanyScope().can('documents', 'edit')`, the
 * page both RPCs gate on. Until then nothing imports this file, and the tests
 * are what keep it joined to the migration.
 */

import { fetchAllPaginated } from './fetchAllPaginated';
import type { PlanRpcClient } from './monthlyPlanPersistence';
import type {
  Confidence,
  DayType,
  DemandProfile,
  RecommendedShift,
  ShiftRecommendation,
} from './shiftRecommendation';

// ── the payload ─────────────────────────────────────────────────────────────

/** One shift, as `vehicle_day_plan_save` reads it. A closed list of keys. */
export interface VehicleDayShiftPayload {
  operating_date: string;
  vehicle: string;
  shift_index: number;
  start_position: number;
  end_position: number;
  /** Wall-clock, 'YYYY-MM-DDTHH:MM', no offset: the engine's LocalMoment. */
  starts_local: string;
  ends_local: string;
  minutes: number;
  day_type: number;
  is_holiday: boolean;
  expected_revenue_cents: number;
  expected_revenue_per_hour_cents: number;
  confidence: Confidence;
  evidence_days: number;
}

export interface VehicleDayPlanSavePayload {
  year: number;
  month: number;
  operating_day_start_hour: number;
  slot_minutes: number;
  algorithm_version: string;
  summary: Record<string, unknown>;
  shifts: VehicleDayShiftPayload[];
}

export interface VehicleDayPlanSource {
  readonly recommendation: ShiftRecommendation;
  /** The profile the recommendation was planned from: the one place the hour and the slot length come from. */
  readonly profile: DemandProfile;
  /** Set when the month was planned towards a revenue target; kept in the summary and never read back as a rule. */
  readonly targetRevenueCents?: number | null;
}

export type NotSavable = 'recommendation_not_ok' | 'profile_not_ok';

/** Why a source cannot be saved at all, or null. A recommendation that is not 'ok' has no shifts worth keeping. */
export function notSavable(source: VehicleDayPlanSource): NotSavable | null {
  if (source.recommendation.status !== 'ok') return 'recommendation_not_ok';
  if (source.profile.status !== 'ok') return 'profile_not_ok';
  return null;
}

/**
 * Which of its vehicle's shifts on that operating day each shift is, by start.
 * The engine's `RecommendedShift.id` ends in the same number, but that id is a
 * display key; the rank is what is stored, and a test pins the two together.
 */
export function shiftIndexes(shifts: readonly RecommendedShift[]): Map<string, number> {
  const groups = new Map<string, RecommendedShift[]>();
  for (const shift of shifts) {
    const key = `${shift.operatingDate}\u0000${shift.vehicle}`;
    groups.set(key, [...(groups.get(key) ?? []), shift]);
  }
  const indexes = new Map<string, number>();
  for (const group of groups.values()) {
    [...group]
      .sort((a, b) => a.startPosition - b.startPosition)
      .forEach((shift, index) => indexes.set(shift.id, index));
  }
  return indexes;
}

function shiftPayload(shift: RecommendedShift, index: number): VehicleDayShiftPayload {
  return {
    operating_date: shift.operatingDate,
    vehicle: shift.vehicle,
    shift_index: index,
    start_position: shift.startPosition,
    end_position: shift.endPosition,
    starts_local: `${shift.start.date}T${shift.start.time}`,
    ends_local: `${shift.end.date}T${shift.end.time}`,
    minutes: shift.minutes,
    day_type: shift.dayType,
    is_holiday: shift.isHoliday,
    expected_revenue_cents: shift.expectedRevenueCents,
    expected_revenue_per_hour_cents: shift.expectedRevenuePerHourCents,
    confidence: shift.confidence,
    evidence_days: shift.evidenceDays,
  };
}

/**
 * What the plan was made with, for a reader who wants to know: settings and
 * counts only. The database writes five totals over it and refuses any value
 * over 16 KiB; it is a convenience, never a source.
 */
export function provenanceOf(source: VehicleDayPlanSource): Record<string, unknown> {
  const { recommendation, profile } = source;
  return {
    min_shift_minutes: recommendation.settings.minShiftMinutes,
    max_shift_minutes: recommendation.settings.maxShiftMinutes,
    min_break_minutes: recommendation.settings.minBreakMinutes,
    max_shifts_per_vehicle_per_day: recommendation.settings.maxShiftsPerVehiclePerDay,
    min_revenue_per_hour_cents: recommendation.settings.minRevenuePerHourCents,
    block_gap_minutes: profile.settings.blockGapMinutes,
    min_evidence_days: profile.settings.minEvidenceDays,
    history_months: profile.historyMonths.map(m => ({ year: m.year, month: m.month })),
    target_revenue_cents: source.targetRevenueCents ?? null,
  };
}

/** The plan as `vehicle_day_plan_save` reads it. Throws for a source `notSavable` names. */
export function toSavePayload(source: VehicleDayPlanSource): VehicleDayPlanSavePayload {
  const problem = notSavable(source);
  if (problem) throw new Error(`a vehicle day plan cannot be saved: ${problem}`);
  const { recommendation, profile } = source;
  const indexes = shiftIndexes(recommendation.shifts);
  return {
    year: recommendation.target.year,
    month: recommendation.target.month,
    operating_day_start_hour: profile.settings.operatingDayStartHour,
    slot_minutes: profile.settings.slotMinutes,
    algorithm_version: recommendation.algorithmVersion,
    summary: provenanceOf(source),
    shifts: recommendation.shifts.map(shift => shiftPayload(shift, indexes.get(shift.id) ?? 0)),
  };
}

// ── reading the answer ──────────────────────────────────────────────────────

/** The words both calls answer with. German is the screen's job. */
export type VehicleDaySaveReason =
  | 'unauthenticated'
  | 'no_company'
  | 'not_authorized'
  /** 22xxx (a broken contract) or 23xxx (a table check): the payload, not the operator, is wrong. */
  | 'invalid_payload'
  /** The guard: the moments, minutes or positions contradict the stored hour and slot length. */
  | 'shift_inconsistent'
  | 'rows_lost'
  | 'not_savable'
  | 'network';

export type VehicleDayConfirmReason =
  | VehicleDaySaveReason
  | 'plan_not_found'
  | 'not_a_draft'
  | 'plan_empty'
  | 'vehicle_overlap'
  | 'plan_exists';

export interface VehicleDaySaveOk {
  ok: true;
  planId: string;
  generation: number;
  shiftCount: number;
  vehicleCount: number;
  /** Earlier drafts of the same month that this save replaced. */
  discardedDrafts: number;
}

export interface VehicleDayConfirmOk {
  ok: true;
  planId: string;
  /** The plan this confirmation superseded, when the caller asked to replace. */
  supersededPlanId: string | null;
}

export interface VehicleDayRefused<R> {
  ok: false;
  reason: R;
  /** The database's own sentence where it gave one; never invented here. */
  detail: string | null;
  /** Set with `plan_exists`: the month's active plan, so the screen can offer to replace it. */
  existingPlanId: string | null;
  existingConfirmedAt: string | null;
}

export type VehicleDaySaveResult = VehicleDaySaveOk | VehicleDayRefused<VehicleDaySaveReason>;
export type VehicleDayConfirmResult = VehicleDayConfirmOk | VehicleDayRefused<VehicleDayConfirmReason>;

interface RpcError {
  message?: string;
  hint?: string | null;
  code?: string | null;
}

const PLAIN_HINTS = new Set<string>(['unauthenticated', 'no_company', 'not_authorized']);

/**
 * The reason behind a PostgREST error. The HINT is the contract (every refusal
 * of the migration sets one) and the message is never parsed.
 */
export function reasonOf(error: RpcError): VehicleDaySaveReason {
  const hint = (error.hint ?? '').trim();
  if (PLAIN_HINTS.has(hint)) return hint as VehicleDaySaveReason;
  if (hint === 'vehicle_day_plan_rows_lost') return 'rows_lost';
  if (hint.startsWith('vehicle_day_shift_')) return 'shift_inconsistent';
  const code = error.code ?? '';
  if (code.startsWith('22') || code.startsWith('23')) return 'invalid_payload';
  return 'network';
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const asInt = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const asText = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function refused<R>(reason: R, detail: string | null = null, row: Record<string, unknown> | null = null): VehicleDayRefused<R> {
  return {
    ok: false,
    reason,
    detail,
    existingPlanId: asText(row?.existing_plan_id),
    existingConfirmedAt: asText(row?.existing_confirmed_at),
  };
}

// ── the two calls ───────────────────────────────────────────────────────────

/**
 * Writes the plan as a draft, replacing the month's earlier drafts. Replacing is
 * the RPC's own behaviour: it deletes the month's drafts under its advisory lock
 * before it inserts, so pressing the button twice leaves one draft. A confirmed
 * plan is never touched here; that is `confirmVehicleDayPlan`'s `replace`.
 */
export async function saveVehicleDayPlan(
  client: PlanRpcClient,
  source: VehicleDayPlanSource,
): Promise<VehicleDaySaveResult> {
  if (notSavable(source)) return refused('not_savable');
  const { data, error } = await client.rpc('vehicle_day_plan_save', { p_payload: toSavePayload(source) });
  if (error) return refused(reasonOf(error), error.message ?? null);
  const row = asRecord(data);
  // A 200 whose body is not the contract is not a success; saying so keeps the
  // screen from reporting a plan id it does not have.
  if (!row || row.success !== true || typeof row.plan_id !== 'string') return refused('network');
  return {
    ok: true,
    planId: row.plan_id,
    generation: asInt(row.generation),
    shiftCount: asInt(row.shift_count),
    vehicleCount: asInt(row.vehicle_count),
    discardedDrafts: asInt(row.discarded_drafts),
  };
}

/**
 * Confirms a saved draft, optionally superseding the month's confirmed plan. The
 * database's refusals come back as values, because the screen has to offer the
 * replacement and say why a plan cannot be confirmed; only the shared gates and
 * a broken contract raise, and those are mapped to the same shape here.
 */
export async function confirmVehicleDayPlan(
  client: PlanRpcClient,
  planId: string,
  options: { replace?: boolean } = {},
): Promise<VehicleDayConfirmResult> {
  const { data, error } = await client.rpc('vehicle_day_plan_confirm', {
    p_plan_id: planId,
    p_replace: options.replace === true,
  });
  if (error) return refused<VehicleDayConfirmReason>(reasonOf(error), error.message ?? null);
  const row = asRecord(data);
  if (!row) return refused<VehicleDayConfirmReason>('network');
  if (row.success === true) {
    return {
      ok: true,
      planId: asText(row.plan_id) ?? planId,
      supersededPlanId: asText(row.superseded_plan_id),
    };
  }
  const reason = (asText(row.reason) ?? 'network') as VehicleDayConfirmReason;
  return refused(reason, asText(row.error), row);
}

/**
 * Save and confirm as one action. Two calls and not one, because they are two
 * transactions by design: the confirm re-derives the vehicle rule from the
 * *stored* rows, not from whatever the browser still holds. The draft exists
 * either way, so its id travels with a refusal: the screen offers "replace"
 * against that id and does not save a second draft.
 */
export async function saveAndConfirmVehicleDayPlan(
  client: PlanRpcClient,
  source: VehicleDayPlanSource,
  options: { replace?: boolean } = {},
): Promise<VehicleDayConfirmResult & { draftPlanId?: string }> {
  const saved = await saveVehicleDayPlan(client, source);
  if (!saved.ok) return saved;
  const confirmed = await confirmVehicleDayPlan(client, saved.planId, options);
  return confirmed.ok ? confirmed : { ...confirmed, draftPlanId: saved.planId };
}

// ── reading a plan back ─────────────────────────────────────────────────────

export type VehicleDayPlanStatus = 'draft' | 'confirmed' | 'superseded';

/** A stored plan. The hour and the slot length are the row's own, never looked up. */
export interface StoredVehicleDayPlan {
  readonly id: string;
  readonly companyId: string;
  readonly year: number;
  readonly month: number;
  readonly status: VehicleDayPlanStatus;
  readonly operatingDayStartHour: number;
  readonly slotMinutes: number;
  readonly algorithmVersion: string;
  readonly generation: number;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly confirmedAt: string | null;
  readonly confirmedBy: string | null;
  readonly supersededAt: string | null;
  readonly replacedByPlanId: string | null;
  /** In the engine's own shape, so the components that draw a recommendation can draw a stored plan. */
  readonly shifts: readonly RecommendedShift[];
}

export type VehicleDayLoadResult =
  | { ok: true; plan: StoredVehicleDayPlan }
  | { ok: false; reason: 'not_found' | 'read_failed'; detail: string | null };

export type VehicleDayMonthResult =
  | { ok: true; plan: StoredVehicleDayPlan | null }
  | { ok: false; reason: 'read_failed'; detail: string | null };

interface ReadPage {
  data: unknown[] | null;
  error: { message: string } | null;
}

/** The query surface this module reads through: structural, so a test needs no supabase-js. */
export interface PlanReadQuery extends PromiseLike<ReadPage> {
  eq(column: string, value: string | number): PlanReadQuery;
  order(column: string, options: { ascending: boolean }): PlanReadQuery;
  range(from: number, to: number): PlanReadQuery;
  limit(count: number): PlanReadQuery;
}

export interface PlanReadClient {
  from(table: string): { select(columns: string): PlanReadQuery };
}

export const PLAN_COLUMNS =
  'id, company_id, year, month, status, operating_day_start_hour, slot_minutes, algorithm_version, generation, summary, confirmed_at, confirmed_by, superseded_at, replaced_by_plan_id';
export const SHIFT_COLUMNS =
  'id, operating_date, vehicle, shift_index, start_position, end_position, starts_local, ends_local, minutes, day_type, is_holiday, expected_revenue_cents, expected_revenue_per_hour_cents, confidence, evidence_days';

const MOMENT = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;

function momentOf(value: unknown): { date: string; time: string } | null {
  const match = typeof value === 'string' ? MOMENT.exec(value) : null;
  return match ? { date: match[1], time: match[2] } : null;
}

const CONFIDENCES: readonly string[] = ['high', 'medium', 'low'];

/** One stored shift in the engine's shape, or null when the row is not one. */
export function shiftFromRow(row: Record<string, unknown>): RecommendedShift | null {
  const start = momentOf(row.starts_local);
  const end = momentOf(row.ends_local);
  const vehicle = asText(row.vehicle);
  const operatingDate = asText(row.operating_date);
  const dayType = row.day_type;
  const confidence = asText(row.confidence);
  if (!start || !end || !vehicle || !operatingDate) return null;
  if (typeof dayType !== 'number' || dayType < 0 || dayType > 6) return null;
  if (!confidence || !CONFIDENCES.includes(confidence)) return null;
  return {
    id: `${vehicle}|${operatingDate}|${asInt(row.shift_index)}`,
    vehicle,
    operatingDate,
    dayType: dayType as DayType,
    isHoliday: row.is_holiday === true,
    startPosition: asInt(row.start_position),
    endPosition: asInt(row.end_position),
    start,
    end,
    minutes: asInt(row.minutes),
    expectedRevenueCents: asInt(row.expected_revenue_cents),
    expectedRevenuePerHourCents: asInt(row.expected_revenue_per_hour_cents),
    evidenceDays: asInt(row.evidence_days),
    confidence: confidence as Confidence,
  };
}

const STATUSES: readonly string[] = ['draft', 'confirmed', 'superseded'];

function planFromRow(row: Record<string, unknown>, shifts: readonly RecommendedShift[]): StoredVehicleDayPlan | null {
  const id = asText(row.id);
  const companyId = asText(row.company_id);
  const status = asText(row.status);
  const algorithmVersion = asText(row.algorithm_version);
  const hour = row.operating_day_start_hour;
  const slot = row.slot_minutes;
  if (!id || !companyId || !algorithmVersion || !status || !STATUSES.includes(status)) return null;
  if (typeof hour !== 'number' || typeof slot !== 'number') return null;
  return {
    id,
    companyId,
    year: asInt(row.year),
    month: asInt(row.month),
    status: status as VehicleDayPlanStatus,
    operatingDayStartHour: hour,
    slotMinutes: slot,
    algorithmVersion,
    generation: asInt(row.generation),
    summary: asRecord(row.summary) ?? {},
    confirmedAt: asText(row.confirmed_at),
    confirmedBy: asText(row.confirmed_by),
    supersededAt: asText(row.superseded_at),
    replacedByPlanId: asText(row.replaced_by_plan_id),
    shifts,
  };
}

function byDayVehicleIndex(a: RecommendedShift, b: RecommendedShift): number {
  if (a.operatingDate !== b.operatingDate) return a.operatingDate < b.operatingDate ? -1 : 1;
  if (a.vehicle !== b.vehicle) return a.vehicle < b.vehicle ? -1 : 1;
  return a.startPosition - b.startPosition;
}

/** Every shift of a plan, in pages of 1000 ordered by id (PostgREST caps a response silently). */
async function readShifts(client: PlanReadClient, planId: string): Promise<RecommendedShift[]> {
  const rows = await fetchAllPaginated<Record<string, unknown>>(
    (from, to) =>
      client
        .from('vehicle_day_shifts')
        .select(SHIFT_COLUMNS)
        .eq('plan_id', planId)
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>,
    { label: 'Schichten' },
  );
  const shifts = rows.map(shiftFromRow);
  if (shifts.some(s => s === null)) throw new Error('a stored shift is not in the shape the migration promises');
  return (shifts as RecommendedShift[]).sort(byDayVehicleIndex);
}

function describeThrown(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : 'unknown error';
}

async function attach(client: PlanReadClient, header: Record<string, unknown>): Promise<VehicleDayLoadResult> {
  try {
    const plan = planFromRow(header, await readShifts(client, asText(header.id) ?? ''));
    return plan ? { ok: true, plan } : { ok: false, reason: 'read_failed', detail: 'a stored plan is not in the shape the migration promises' };
  } catch (thrown) {
    // A plan whose shifts could not all be read is not shown with the ones that
    // were: an empty or short list is a claim about the month.
    return { ok: false, reason: 'read_failed', detail: describeThrown(thrown) };
  }
}

/** One plan with all its shifts. A read that fails is `read_failed`, never an empty plan. */
export async function loadVehicleDayPlan(client: PlanReadClient, planId: string): Promise<VehicleDayLoadResult> {
  const { data, error } = await client.from('vehicle_day_plans').select(PLAN_COLUMNS).eq('id', planId).limit(1);
  if (error) return { ok: false, reason: 'read_failed', detail: error.message };
  const header = asRecord(data?.[0]);
  return header ? attach(client, header) : { ok: false, reason: 'not_found', detail: null };
}

/**
 * The plan a month goes by: its confirmed plan, else its newest draft, else
 * null. A superseded plan is history and is not offered.
 */
export async function loadVehicleDayPlanForMonth(
  client: PlanReadClient,
  companyId: string,
  year: number,
  month: number,
): Promise<VehicleDayMonthResult> {
  const { data, error } = await client
    .from('vehicle_day_plans')
    .select(PLAN_COLUMNS)
    .eq('company_id', companyId)
    .eq('year', year)
    .eq('month', month)
    .order('created_at', { ascending: false });
  if (error) return { ok: false, reason: 'read_failed', detail: error.message };
  const rows = (data ?? []).map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
  const header = rows.find(r => r.status === 'confirmed') ?? rows.find(r => r.status === 'draft');
  if (!header) return { ok: true, plan: null };
  const loaded = await attach(client, header);
  return loaded.ok ? { ok: true, plan: loaded.plan } : { ok: false, reason: 'read_failed', detail: loaded.detail };
}
