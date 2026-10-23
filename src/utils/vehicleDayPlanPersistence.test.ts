/**
 * Saving, confirming and reading a vehicle day plan.
 *
 * The migration (20261022140000) is the contract and the kit file
 * tests/rls/vehicle-day-plans.sql proves the database half. These assertions are
 * about the join: that the payload carries exactly what the RPC reads and the
 * moments the database will accept, that the hour is the profile's and nothing
 * else, that a refusal is reported as a refusal, and that a plan comes back with
 * its own hour and all of its shifts or not at all.
 *
 * The engine's output is REAL: hand-built demand profiles are planned by
 * `recommendShifts`, for several operating-day start hours and slot lengths, so a
 * change to how the engine names a moment or numbers a shift fails here and not
 * on the first save. The moments are checked against an arithmetic written out
 * again in this file, the one the database's shift guard uses, so the engine's
 * SlotClock and the guard are two instruments that must agree.
 *
 * The clients are stubs with the one method each needs, for the reason
 * `monthlyPlanPersistence.test.ts` states: importing `src/lib/supabase` reads
 * `window.location.origin` at module scope and the suite runs in `node`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PLAN_COLUMNS,
  SHIFT_COLUMNS,
  confirmVehicleDayPlan,
  loadVehicleDayPlan,
  loadVehicleDayPlanForMonth,
  notSavable,
  provenanceOf,
  reasonOf,
  saveAndConfirmVehicleDayPlan,
  saveVehicleDayPlan,
  shiftFromRow,
  shiftIndexes,
  toSavePayload,
  type PlanReadClient,
  type PlanReadQuery,
  type VehicleDayPlanSource,
} from './vehicleDayPlanPersistence';
import type { PlanRpcClient } from './monthlyPlanPersistence';
import {
  SHIFT_RECOMMENDATION_ALGORITHM_VERSION,
  SUPPORTED_SLOT_MINUTES,
  recommendShifts,
  validatePlanSettings,
  type DayType,
  type DemandCell,
  type DemandProfile,
  type PlanSettings,
} from './shiftRecommendation';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(HERE, '../../supabase/migrations/20261022140000_vehicle_day_plans.sql'), 'utf8')
  .replace(/\r\n/g, '\n');
const MODULE_SOURCE = readFileSync(join(HERE, 'vehicleDayPlanPersistence.ts'), 'utf8');

/** Strip comments, so a header that names a forbidden thing to forbid it does not trip the check. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// ── real engine output ──────────────────────────────────────────────────────

/**
 * A demand profile written by hand, for any slot length and any start hour.
 * `rate` answers cents per hour for a weekday and the clock hour a slot begins
 * in, or null for no rate. Position p begins at clock minute
 * (hour * 60 + p * slot) mod 1440.
 */
function handProfile(
  slotMinutes: number,
  operatingDayStartHour: number,
  rate: (day: DayType, clockHour: number) => number | null,
): DemandProfile {
  const positions = 1440 / slotMinutes;
  const cells: DemandCell[] = [];
  for (let day = 0; day < 7; day += 1) {
    for (let p = 0; p < positions; p += 1) {
      const clockHour = Math.floor(((operatingDayStartHour * 60 + p * slotMinutes) % 1440) / 60);
      const r = rate(day as DayType, clockHour);
      cells.push({
        dayType: day as DayType, position: p, revenueCents: r ?? 0, vehicleMinutes: slotMinutes,
        activeDays: 9, maxVehicles: 4, revenuePerHourCents: r,
      });
    }
  }
  return {
    algorithmVersion: 'test',
    status: 'ok',
    problems: [],
    settings: { slotMinutes, operatingDayStartHour, blockGapMinutes: 30, minEvidenceDays: 2 },
    historyMonths: [{ year: 2026, month: 8 }, { year: 2026, month: 9 }],
    positions,
    cells,
    vehicles: [],
    coverage: {
      rows: 0, usedRides: 0,
      excluded: { cancelled: 0, status_unknown: 0, missing_vehicle: 0, missing_start: 0, missing_end: 0, end_before_start: 0, implausible_duration: 0, ambiguous_local_time: 0, unpriced: 0 },
      usedRevenueCents: 0, unplacedRevenueCents: 0, cancelledRevenueCents: 0,
    },
    perMonth: { rides: 0, vehicleMinutes: 0, revenueCents: 0, revenuePerHourCents: null },
  };
}

/** Strong in the morning, and again from 22:00 to 03:00 so that shifts cross midnight. */
const nightAndMorning = (_day: DayType, hour: number): number =>
  (hour >= 8 && hour < 12) || hour >= 22 || hour < 3 ? 3000 : 800;

const PLAN: PlanSettings = {
  minShiftMinutes: 180, maxShiftMinutes: 240, minBreakMinutes: 60,
  maxShiftsPerVehiclePerDay: 2, minRevenuePerHourCents: 2000,
};

function sourceFor(slotMinutes: number, hour: number, over: Partial<VehicleDayPlanSource> = {}): VehicleDayPlanSource {
  const profile = handProfile(slotMinutes, hour, nightAndMorning);
  const recommendation = recommendShifts({
    profile,
    target: { year: 2026, month: 11 },
    vehicles: ['B-AB 111', 'B-CD 222'],
    // A holiday on a Wednesday: the engine reads it as a Sunday, day type 6.
    holidays: new Set(['2026-11-04']),
    settings: PLAN,
  });
  return { recommendation, profile, ...over };
}

const COMBOS: readonly (readonly [number, number])[] = [[15, 4], [30, 0], [60, 22], [15, 23], [60, 6], [30, 4]];

/** The shift guard's arithmetic, written out again: a wall-clock moment as minutes after the operating date's midnight. */
function wall(date: string, minutes: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d, 0, minutes));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

// ── the payload ─────────────────────────────────────────────────────────────

describe('toSavePayload', () => {
  it.each(COMBOS)('slot %i minutes, hour %i: the engine made shifts, so the checks below are not empty', (slot, hour) => {
    expect(sourceFor(slot, hour).recommendation.shifts.length).toBeGreaterThan(20);
  });

  it.each(COMBOS)('slot %i minutes, hour %i: carries the PROFILE\'s hour and slot length', (slot, hour) => {
    const payload = toSavePayload(sourceFor(slot, hour));
    expect(payload.operating_day_start_hour).toBe(hour);
    expect(payload.slot_minutes).toBe(slot);
    expect(payload.algorithm_version).toBe(SHIFT_RECOMMENDATION_ALGORITHM_VERSION);
    expect([payload.year, payload.month]).toEqual([2026, 11]);
  });

  it.each(COMBOS)('slot %i minutes, hour %i: every moment is the one the database will recompute from the stored hour', (slot, hour) => {
    const payload = toSavePayload(sourceFor(slot, hour));
    for (const s of payload.shifts) {
      expect(s.starts_local, JSON.stringify(s)).toBe(wall(s.operating_date, hour * 60 + s.start_position * slot));
      expect(s.ends_local, JSON.stringify(s)).toBe(wall(s.operating_date, hour * 60 + s.end_position * slot));
      expect(s.minutes).toBe((s.end_position - s.start_position) * slot);
      expect(s.end_position).toBeLessThanOrEqual(1440 / slot);
    }
  });

  it('crosses midnight for a night shift, in the payload as the database will see it', () => {
    const payload = toSavePayload(sourceFor(15, 4));
    const overnight = payload.shifts.filter(s => s.ends_local.slice(0, 10) !== s.starts_local.slice(0, 10));
    expect(overnight.length).toBeGreaterThan(0);
    for (const s of overnight) expect(s.ends_local > s.starts_local).toBe(true);
  });

  it('numbers a vehicle\'s shifts on a day by start, and that is the engine\'s own number', () => {
    const source = sourceFor(15, 4);
    const indexes = shiftIndexes(source.recommendation.shifts);
    expect(indexes.size).toBe(source.recommendation.shifts.length);
    for (const shift of source.recommendation.shifts) {
      // `id` is `${vehicle}|${operatingDate}|${index}`; the stored number is the rank, and the two must agree.
      expect(shift.id.slice(shift.id.lastIndexOf('|') + 1)).toBe(String(indexes.get(shift.id)));
    }
    const payload = toSavePayload(source);
    const keys = payload.shifts.map(s => `${s.operating_date}|${s.vehicle}|${s.shift_index}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Math.max(...payload.shifts.map(s => s.shift_index))).toBeGreaterThan(0);
  });

  it('keeps a holiday as the engine read it: a Sunday on a Wednesday', () => {
    const holiday = toSavePayload(sourceFor(15, 4)).shifts.filter(s => s.operating_date === '2026-11-04');
    expect(holiday.length).toBeGreaterThan(0);
    for (const s of holiday) expect([s.is_holiday, s.day_type]).toEqual([true, 6]);
  });

  it('records the settings and the history it was made with, as numbers, and nothing about a ride', () => {
    const summary = toSavePayload(sourceFor(15, 4, { targetRevenueCents: 500000 })).summary;
    expect(Object.keys(summary).sort()).toEqual([
      'block_gap_minutes', 'history_months', 'max_shift_minutes', 'max_shifts_per_vehicle_per_day',
      'min_break_minutes', 'min_evidence_days', 'min_revenue_per_hour_cents', 'min_shift_minutes',
      'target_revenue_cents',
    ]);
    expect(summary.target_revenue_cents).toBe(500000);
    // YYYYMM, the one shape the database accepts for a month: 202608 is August 2026.
    expect(summary.history_months).toEqual([202608, 202609]);
  });

  it('leaves the target out when the month was planned without one, and when it is not a number', () => {
    // A null is not a number, and the database refuses it: the key is absent instead.
    expect(provenanceOf(sourceFor(15, 4))).not.toHaveProperty('target_revenue_cents');
    expect(provenanceOf(sourceFor(15, 4, { targetRevenueCents: null }))).not.toHaveProperty('target_revenue_cents');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(provenanceOf(sourceFor(15, 4, { targetRevenueCents: bad })), String(bad)).not.toHaveProperty('target_revenue_cents');
    }
    expect(provenanceOf(sourceFor(15, 4, { targetRevenueCents: 0 })).target_revenue_cents).toBe(0);
  });
});

describe('the payload is joined to the migration', () => {
  /** The strings of a text[] constant the save RPC declares. */
  function rpcList(name: string): string[] {
    const found = new RegExp(`${name}\\s+CONSTANT text\\[\\] := ARRAY\\[([^\\]]*)\\]`).exec(MIGRATION);
    if (!found) throw new Error(`${name} not found in the migration`);
    return [...found[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  }

  /** The jsonb object a constant of the save RPC holds: every key a shift may carry, with its JSON type. */
  function rpcShape(name: string): Record<string, string> {
    const found = new RegExp(`${name}\\s+CONSTANT jsonb := '(\\{[^']*\\})'`).exec(MIGRATION);
    if (!found) throw new Error(`${name} not found in the migration`);
    return JSON.parse(found[1]) as Record<string, string>;
  }

  it('sends exactly the keys the RPC accepts, at the top and per shift', () => {
    const payload = toSavePayload(sourceFor(15, 4));
    expect(Object.keys(payload).sort()).toEqual([...rpcList('c_top_keys')].sort());
    expect(Object.keys(payload.shifts[0]).sort()).toEqual(Object.keys(rpcShape('c_shift_shape')).sort());
  });

  it.each(COMBOS)('slot %i minutes, hour %i: every field of every shift is the JSON type the RPC requires', (slot, hour) => {
    const shape = rpcShape('c_shift_shape');
    for (const shift of toSavePayload(sourceFor(slot, hour)).shifts) {
      for (const [key, value] of Object.entries(shift)) {
        expect(typeof value, `${key} of ${JSON.stringify(shift)}`).toBe(shape[key]);
      }
    }
  });

  it('sends a summary the database will accept: its keys, numbers only, the months as YYYYMM', () => {
    const allowed = rpcList('c_keys');
    // Pinned from the migration, so a widened ceiling or a longer list is a conversation and not a drift.
    expect(/c_ceiling\s+CONSTANT numeric := 1000000000000000;/.test(MIGRATION)).toBe(true);
    expect(/jsonb_array_length\(p_summary -> 'history_months'\) > 240/.test(MIGRATION)).toBe(true);
    for (const target of [undefined, 500000]) {
      const summary = toSavePayload(sourceFor(15, 4, { targetRevenueCents: target })).summary;
      for (const [key, value] of Object.entries(summary)) {
        expect(allowed, key).toContain(key);
        if (key === 'history_months') {
          const months = value as number[];
          expect(Array.isArray(months) && months.length <= 240).toBe(true);
          for (const month of months) {
            expect(Number.isInteger(month) && month >= 200001 && month <= 210012 && month % 100 >= 1 && month % 100 <= 12, String(month)).toBe(true);
          }
        } else {
          expect(typeof value, key).toBe('number');
          expect(Number.isFinite(value) && (value as number) >= 0 && (value as number) <= 1e15, key).toBe(true);
        }
      }
    }
  });

  it('agrees with the database about the version token the engine writes', () => {
    const found = /CHECK \(algorithm_version ~ '([^']+)'\)/.exec(MIGRATION);
    expect(found).not.toBeNull();
    const token = new RegExp(found![1]);
    expect(token.test(SHIFT_RECOMMENDATION_ALGORITHM_VERSION)).toBe(true);
    expect(token.test(toSavePayload(sourceFor(15, 4)).algorithm_version)).toBe(true);
    // ... and a sentence is not a version.
    expect(token.test('driver Max Mustermann')).toBe(false);
    expect(token.test('')).toBe(false);
    expect(token.test('a'.repeat(101))).toBe(false);
    expect(token.test('a'.repeat(100))).toBe(true);
  });

  it('sends no key that names a driver, a ride, an address or a fare', () => {
    const payload = toSavePayload(sourceFor(15, 4));
    const keys = [...Object.keys(payload), ...Object.keys(payload.shifts[0]), ...Object.keys(payload.summary)];
    expect(keys.filter(k => /(^|_)(driver|fahrer|ride|trip|address|adresse|fare|tip|passenger|customer|route|gps)(_|$)/.test(k))).toEqual([]);
  });

  it('agrees with the database about the slot lengths, the hours and how many shifts a vehicle has a day', () => {
    expect([...SUPPORTED_SLOT_MINUTES]).toEqual([15, 30, 60]);
    expect(/slot_minutes IN \(15, 30, 60\)/.test(MIGRATION)).toBe(true);
    expect(/operating_day_start_hour BETWEEN 0 AND 23/.test(MIGRATION)).toBe(true);
    // The engine allows 1 to 4 shifts per vehicle and day, so the index runs 0 to 3.
    expect(validatePlanSettings({ ...PLAN, maxShiftsPerVehiclePerDay: 4 }, 15)).toEqual([]);
    expect(validatePlanSettings({ ...PLAN, maxShiftsPerVehiclePerDay: 5 }, 15)).toContain('max_shifts_per_day_invalid');
    expect(/shift_index BETWEEN 0 AND 3/.test(MIGRATION)).toBe(true);
    // 96 positions is a day of 15-minute slots, the largest the engine makes.
    expect(1440 / Math.min(...SUPPORTED_SLOT_MINUTES)).toBe(96);
    expect(/end_position <= 96/.test(MIGRATION)).toBe(true);
  });

  it('agrees with the database about the confidence words the engine writes', () => {
    expect(/confidence IN \('high', 'medium', 'low'\)/.test(MIGRATION)).toBe(true);
    const words = new Set(toSavePayload(sourceFor(15, 4)).shifts.map(s => s.confidence));
    for (const word of words) expect(['high', 'medium', 'low']).toContain(word);
  });

  it('reads and writes only columns the migration defines', () => {
    const body = (table: string) => {
      const start = MIGRATION.indexOf(`CREATE TABLE IF NOT EXISTS public.${table} (`);
      return MIGRATION.slice(start, MIGRATION.indexOf('\n);', start));
    };
    const columns = (table: string) => [...body(table).matchAll(/^ {2}([a-z_]+)\s/gm)].map(m => m[1])
      .filter(name => name !== 'constraint');
    const planColumns = columns('vehicle_day_plans');
    const shiftColumns = columns('vehicle_day_shifts');
    expect(planColumns).toContain('operating_day_start_hour');
    for (const column of PLAN_COLUMNS.split(',').map(c => c.trim())) expect(planColumns, column).toContain(column);
    for (const column of SHIFT_COLUMNS.split(',').map(c => c.trim())) expect(shiftColumns, column).toContain(column);
    const payloadShiftKeys = Object.keys(toSavePayload(sourceFor(15, 4)).shifts[0]);
    for (const key of payloadShiftKeys) expect(shiftColumns, key).toContain(key);
  });
});

describe('rule 1 is kept by the source itself', () => {
  it('has no default hour, no default slot length and no constant for either', () => {
    const body = code(MODULE_SOURCE);
    expect(body).not.toMatch(/DEFAULT_PROFILE_SETTINGS|DEFAULT_PLAN_SETTINGS|OPERATING_DAY_START_HOUR/);
    expect(body).not.toMatch(/operatingDayStartHour\s*[:=]\s*\d|slotMinutes\s*[:=]\s*\d|operating_day_start_hour\s*:\s*\d|slot_minutes\s*:\s*\d/);
    expect(body).not.toMatch(/\?\?\s*(4|15)\b/);
  });

  it('imports only types from the engine and never the supabase client', () => {
    const imports = [...MODULE_SOURCE.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)';/gm)];
    const fromEngine = imports.filter(m => m[2] === './shiftRecommendation');
    expect(fromEngine.length).toBeGreaterThan(0);
    for (const m of fromEngine) expect(m[1], 'the engine is imported as a type').toBeTruthy();
    expect(code(MODULE_SOURCE)).not.toMatch(/supabase|Date\.now|Math\.random|new Date\(/);
  });

  it('names no driver, ride, address or fare', () => {
    expect(code(MODULE_SOURCE)).not.toMatch(/\bdriver|fahrer|\bride\b|address|adresse|\bfare\b|fahrtenbuch_trips/i);
  });

  it('puts the hour of a different profile into the payload, whichever it is', () => {
    const four = toSavePayload(sourceFor(15, 4));
    const zero = toSavePayload(sourceFor(15, 0));
    expect(four.operating_day_start_hour).toBe(4);
    expect(zero.operating_day_start_hour).toBe(0);
    // Every shift of each is its own hour's arithmetic (the test above), so two
    // hours cannot share a payload: the first shift's start differs by the hours.
    expect(four.shifts[0].starts_local).not.toBe(zero.shifts[0].starts_local);
  });
});

describe('what cannot be saved', () => {
  it('refuses a recommendation that is not ok, and a profile that is not ok, without calling the database', async () => {
    const ok = sourceFor(15, 4);
    const broken: VehicleDayPlanSource = { ...ok, recommendation: { ...ok.recommendation, status: 'no_vehicles', shifts: [] } };
    const unusable: VehicleDayPlanSource = { ...ok, profile: { ...ok.profile, status: 'no_history' } };
    expect(notSavable(broken)).toBe('recommendation_not_ok');
    expect(notSavable(unusable)).toBe('profile_not_ok');
    expect(notSavable(ok)).toBeNull();
    expect(() => toSavePayload(broken)).toThrow(/recommendation_not_ok/);
    const client = rpcStub([]);
    const result = await saveVehicleDayPlan(client, broken);
    expect(result).toMatchObject({ ok: false, reason: 'not_savable' });
    expect(client.calls).toHaveLength(0);
  });

  it('saves a month that plans nothing: an empty list is a legal draft', () => {
    const source = sourceFor(15, 4);
    const empty: VehicleDayPlanSource = { ...source, recommendation: { ...source.recommendation, shifts: [] } };
    expect(toSavePayload(empty).shifts).toEqual([]);
  });
});

// ── the two calls ───────────────────────────────────────────────────────────

function rpcStub(answers: { data?: unknown; error?: unknown }[]): PlanRpcClient & { calls: { fn: string; args: Record<string, unknown> }[] } {
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

const PLAN_ID = 'p0000000-0000-4000-8000-00000000000a';
const OTHER_ID = 'p0000000-0000-4000-8000-00000000000b';
const okSave = { data: { success: true, plan_id: PLAN_ID, year: 2026, month: 11, generation: 1, shift_count: 40, vehicle_count: 2, discarded_drafts: 1 } };

describe('saveVehicleDayPlan', () => {
  it('sends the payload to vehicle_day_plan_save and reads the answer', async () => {
    const client = rpcStub([okSave]);
    const source = sourceFor(15, 4);
    const result = await saveVehicleDayPlan(client, source);
    expect(client.calls).toEqual([{ fn: 'vehicle_day_plan_save', args: { p_payload: toSavePayload(source) } }]);
    expect(result).toEqual({ ok: true, planId: PLAN_ID, generation: 1, shiftCount: 40, vehicleCount: 2, discardedDrafts: 1 });
  });

  it.each([
    [{ hint: 'unauthenticated', code: '42501' }, 'unauthenticated'],
    [{ hint: 'no_company', code: '42501' }, 'no_company'],
    [{ hint: 'not_authorized', code: '42501' }, 'not_authorized'],
    [{ hint: 'vehicle_day_plan_rows_lost', code: 'P0001' }, 'rows_lost'],
    [{ hint: 'vehicle_day_plan_summary_invalid', code: 'P0001' }, 'invalid_payload'],
    [{ hint: 'vehicle_day_shift_moments_mismatch', code: 'P0001' }, 'shift_inconsistent'],
    [{ hint: 'vehicle_day_shift_minutes_mismatch', code: 'P0001' }, 'shift_inconsistent'],
    [{ hint: 'vehicle_day_shift_positions_invalid', code: 'P0001' }, 'shift_inconsistent'],
    [{ hint: 'vehicle_day_shift_outside_month', code: 'P0001' }, 'shift_inconsistent'],
    [{ hint: '', code: '22023' }, 'invalid_payload'],
    [{ hint: '', code: '23514' }, 'invalid_payload'],
    [{ hint: '', code: '23505' }, 'invalid_payload'],
    [{ hint: '', code: '23502' }, 'invalid_payload'],
    [{ hint: '', code: '' }, 'network'],
    [{ hint: null, code: 'PGRST301' }, 'network'],
  ])('maps %j to %s', async (error, reason) => {
    expect(reasonOf(error)).toBe(reason);
    const result = await saveVehicleDayPlan(rpcStub([{ error: { ...error, message: 'x' } }]), sourceFor(15, 4));
    expect(result).toMatchObject({ ok: false, reason, detail: 'x' });
  });

  it('does not take a 200 whose body is not the contract for a success', async () => {
    for (const data of [null, 'ok', [], { success: false }, { success: true }, { success: true, plan_id: 7 }]) {
      const result = await saveVehicleDayPlan(rpcStub([{ data }]), sourceFor(15, 4));
      expect(result, JSON.stringify(data)).toMatchObject({ ok: false, reason: 'network' });
    }
  });
});

describe('confirmVehicleDayPlan', () => {
  it('asks to replace only when told to', async () => {
    const client = rpcStub([{ data: { success: true, plan_id: PLAN_ID, superseded_plan_id: null } }]);
    expect(await confirmVehicleDayPlan(client, PLAN_ID)).toEqual({ ok: true, planId: PLAN_ID, supersededPlanId: null });
    await confirmVehicleDayPlan(client, PLAN_ID, { replace: true });
    expect(client.calls.map(c => c.args)).toEqual([
      { p_plan_id: PLAN_ID, p_replace: false },
      { p_plan_id: PLAN_ID, p_replace: true },
    ]);
    expect(client.calls.every(c => c.fn === 'vehicle_day_plan_confirm')).toBe(true);
  });

  it('names the plan it superseded', async () => {
    const result = await confirmVehicleDayPlan(rpcStub([{ data: { success: true, plan_id: PLAN_ID, superseded_plan_id: OTHER_ID } }]), PLAN_ID, { replace: true });
    expect(result).toEqual({ ok: true, planId: PLAN_ID, supersededPlanId: OTHER_ID });
  });

  it.each(['plan_not_found', 'not_a_draft', 'plan_empty', 'vehicle_overlap'] as const)('answers %s as a value, with the database\'s sentence', async reason => {
    const result = await confirmVehicleDayPlan(rpcStub([{ data: { success: false, reason, error: 'Satz.' } }]), PLAN_ID);
    expect(result).toEqual({ ok: false, reason, detail: 'Satz.', existingPlanId: null, existingConfirmedAt: null });
  });

  it('carries the active plan with plan_exists, so the screen can offer to replace it', async () => {
    const result = await confirmVehicleDayPlan(rpcStub([{ data: {
      success: false, reason: 'plan_exists', existing_plan_id: OTHER_ID, existing_confirmed_at: '2026-10-22T10:00:00+00:00', error: 'aktiv',
    } }]), PLAN_ID);
    expect(result).toEqual({ ok: false, reason: 'plan_exists', detail: 'aktiv', existingPlanId: OTHER_ID, existingConfirmedAt: '2026-10-22T10:00:00+00:00' });
  });

  it('maps a raised refusal like the save does, and a missing body to network', async () => {
    expect(await confirmVehicleDayPlan(rpcStub([{ error: { hint: 'not_authorized', code: '42501', message: 'm' } }]), PLAN_ID))
      .toMatchObject({ ok: false, reason: 'not_authorized' });
    expect(await confirmVehicleDayPlan(rpcStub([{ data: null }]), PLAN_ID)).toMatchObject({ ok: false, reason: 'network' });
    expect(await confirmVehicleDayPlan(rpcStub([{ data: { success: false } }]), PLAN_ID)).toMatchObject({ ok: false, reason: 'network' });
  });
});

describe('saveAndConfirmVehicleDayPlan', () => {
  const confirmOk = { data: { success: true, plan_id: PLAN_ID, superseded_plan_id: null } };

  it('saves, then confirms the draft it saved', async () => {
    const client = rpcStub([okSave, confirmOk]);
    const result = await saveAndConfirmVehicleDayPlan(client, sourceFor(15, 4));
    expect(result).toEqual({ ok: true, planId: PLAN_ID, supersededPlanId: null });
    expect(client.calls.map(c => c.fn)).toEqual(['vehicle_day_plan_save', 'vehicle_day_plan_confirm']);
    expect(client.calls[1].args).toEqual({ p_plan_id: PLAN_ID, p_replace: false });
  });

  it('stops at a refused save and never confirms', async () => {
    const client = rpcStub([{ error: { hint: 'not_authorized', code: '42501', message: 'm' } }]);
    expect(await saveAndConfirmVehicleDayPlan(client, sourceFor(15, 4))).toMatchObject({ ok: false, reason: 'not_authorized' });
    expect(client.calls).toHaveLength(1);
  });

  it('hands back the draft\'s id with a refused confirmation, so the screen offers to replace and saves nothing twice', async () => {
    const client = rpcStub([okSave, { data: { success: false, reason: 'plan_exists', existing_plan_id: OTHER_ID } }]);
    const result = await saveAndConfirmVehicleDayPlan(client, sourceFor(15, 4));
    expect(result).toMatchObject({ ok: false, reason: 'plan_exists', existingPlanId: OTHER_ID, draftPlanId: PLAN_ID });
  });

  it('forwards the replace flag to the confirmation only', async () => {
    const client = rpcStub([okSave, confirmOk]);
    await saveAndConfirmVehicleDayPlan(client, sourceFor(15, 4), { replace: true });
    expect(client.calls[0].args).not.toHaveProperty('p_replace');
    expect(client.calls[1].args).toEqual({ p_plan_id: PLAN_ID, p_replace: true });
  });
});

// ── reading a plan back ─────────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface Request { table: string; columns: string; filters: [string, unknown][]; order: string | null; range: [number, number] | null; limit: number | null }

/** A reader over in-memory tables: filters by eq, orders by one column, slices by range or limit. */
function reader(tables: Record<string, Row[]>, fail: (r: Request) => string | null = () => null): PlanReadClient & { requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    from(table) {
      return {
        select(columns) {
          const req: Request = { table, columns, filters: [], order: null, range: null, limit: null };
          const query: PlanReadQuery = {
            eq(column, value) { req.filters.push([column, value]); return query; },
            order(column, options) { req.order = `${column}:${options.ascending ? 'asc' : 'desc'}`; return query; },
            range(from, to) { req.range = [from, to]; return query; },
            limit(count) { req.limit = count; return query; },
            then(onfulfilled, onrejected) {
              requests.push(req);
              const failure = fail(req);
              let data = (tables[table] ?? []).filter(r => req.filters.every(([c, v]) => r[c] === v));
              if (req.order) {
                const [column, direction] = req.order.split(':');
                data = [...data].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (direction === 'asc' ? 1 : -1));
              }
              if (req.range) data = data.slice(req.range[0], req.range[1] + 1);
              if (req.limit !== null) data = data.slice(0, req.limit);
              const page = failure ? { data: null, error: { message: failure } } : { data, error: null };
              return Promise.resolve(page).then(onfulfilled, onrejected);
            },
          };
          return query;
        },
      };
    },
  };
}

const COMPANY = 'c0000000-0000-4000-8000-00000000000a';

function planRow(over: Row = {}): Row {
  return {
    id: PLAN_ID, company_id: COMPANY, year: 2026, month: 11, status: 'confirmed',
    operating_day_start_hour: 4, slot_minutes: 15, algorithm_version: 'shift-recommendation/1.0.0', generation: 0,
    summary: { shift_count: 2 }, confirmed_at: '2026-10-22T09:00:00+00:00', confirmed_by: 'u1',
    superseded_at: null, replaced_by_plan_id: null, created_at: '2026-10-22T08:00:00+00:00', ...over,
  };
}

function shiftRow(i: number, over: Row = {}): Row {
  const day = String(1 + (i % 28)).padStart(2, '0');
  return {
    id: `s${String(i).padStart(6, '0')}`, plan_id: PLAN_ID, operating_date: `2026-11-${day}`, vehicle: `V${i % 3}`,
    shift_index: 0, start_position: 24, end_position: 36,
    starts_local: `2026-11-${day}T10:00:00`, ends_local: `2026-11-${day}T13:00:00`,
    minutes: 180, day_type: 1, is_holiday: false, expected_revenue_cents: 12345, expected_revenue_per_hour_cents: 4115,
    confidence: 'high', evidence_days: 9, ...over,
  };
}

describe('loadVehicleDayPlan', () => {
  it('returns the plan with ITS OWN hour and slot length and the moments that were stored', async () => {
    // Hour 0 and a moment no constant would produce: nothing is recomputed on the way back.
    const client = reader({
      vehicle_day_plans: [planRow({ operating_day_start_hour: 0, slot_minutes: 60 })],
      vehicle_day_shifts: [shiftRow(1, { starts_local: '2026-11-02T06:00:00', ends_local: '2026-11-02T09:00:00', start_position: 6, end_position: 9, operating_date: '2026-11-02' })],
    });
    const result = await loadVehicleDayPlan(client, PLAN_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([result.plan.operatingDayStartHour, result.plan.slotMinutes, result.plan.algorithmVersion]).toEqual([0, 60, 'shift-recommendation/1.0.0']);
    expect(result.plan.shifts[0]).toMatchObject({
      id: 'V1|2026-11-02|0', vehicle: 'V1', operatingDate: '2026-11-02', startPosition: 6, endPosition: 9, minutes: 180,
      start: { date: '2026-11-02', time: '06:00' }, end: { date: '2026-11-02', time: '09:00' }, dayType: 1, isHoliday: false,
      expectedRevenueCents: 12345, expectedRevenuePerHourCents: 4115, confidence: 'high', evidenceDays: 9,
    });
  });

  it('asks for the columns it maps, scoped to the plan, ordered by a unique key', async () => {
    const client = reader({ vehicle_day_plans: [planRow()], vehicle_day_shifts: [shiftRow(1)] });
    await loadVehicleDayPlan(client, PLAN_ID);
    expect(client.requests[0]).toMatchObject({ table: 'vehicle_day_plans', columns: PLAN_COLUMNS, filters: [['id', PLAN_ID]], limit: 1 });
    expect(client.requests[1]).toMatchObject({ table: 'vehicle_day_shifts', columns: SHIFT_COLUMNS, filters: [['plan_id', PLAN_ID]], order: 'id:asc', range: [0, 999] });
  });

  it('reads every shift when there are more than the 1000 a response is capped at', async () => {
    const rows = Array.from({ length: 2300 }, (_, i) => shiftRow(i, { shift_index: Math.floor(i / 84) % 4 }));
    const client = reader({ vehicle_day_plans: [planRow()], vehicle_day_shifts: rows });
    const result = await loadVehicleDayPlan(client, PLAN_ID);
    expect(result.ok && result.plan.shifts.length).toBe(2300);
    expect(client.requests.filter(r => r.table === 'vehicle_day_shifts').map(r => r.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('orders the shifts by day, vehicle and start whatever order they came in', async () => {
    const client = reader({
      vehicle_day_plans: [planRow()],
      vehicle_day_shifts: [
        shiftRow(3, { id: 'a3', operating_date: '2026-11-05', vehicle: 'B', start_position: 40, end_position: 52 }),
        shiftRow(1, { id: 'a1', operating_date: '2026-11-02', vehicle: 'B', start_position: 24, end_position: 36 }),
        shiftRow(2, { id: 'a2', operating_date: '2026-11-02', vehicle: 'A', start_position: 80, end_position: 90 }),
      ],
    });
    const result = await loadVehicleDayPlan(client, PLAN_ID);
    expect(result.ok && result.plan.shifts.map(s => `${s.operatingDate}|${s.vehicle}|${s.startPosition}`))
      .toEqual(['2026-11-02|A|80', '2026-11-02|B|24', '2026-11-05|B|40']);
  });

  it('says not_found for a plan that is not there, and read_failed for a read that failed', async () => {
    expect(await loadVehicleDayPlan(reader({ vehicle_day_plans: [] }), PLAN_ID)).toEqual({ ok: false, reason: 'not_found', detail: null });
    const failing = reader({ vehicle_day_plans: [planRow()], vehicle_day_shifts: [shiftRow(1)] }, r => (r.table === 'vehicle_day_plans' ? 'boom' : null));
    expect(await loadVehicleDayPlan(failing, PLAN_ID)).toEqual({ ok: false, reason: 'read_failed', detail: 'boom' });
  });

  it('never shows a plan with the shifts that could be read: a failed page is read_failed, not a short list', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => shiftRow(i));
    const client = reader({ vehicle_day_plans: [planRow()], vehicle_day_shifts: rows }, r => (r.range?.[0] === 1000 ? 'network down' : null));
    const result = await loadVehicleDayPlan(client, PLAN_ID);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, reason: 'read_failed' });
  });

  it('treats a row that is not in the migration\'s shape as a failed read, not as a plan', async () => {
    for (const bad of [{ starts_local: 'not a moment' }, { day_type: 9 }, { confidence: 'certain' }, { vehicle: null }]) {
      const client = reader({ vehicle_day_plans: [planRow()], vehicle_day_shifts: [shiftRow(1, bad)] });
      expect(await loadVehicleDayPlan(client, PLAN_ID), JSON.stringify(bad)).toMatchObject({ ok: false, reason: 'read_failed' });
    }
    const noHour = reader({ vehicle_day_plans: [planRow({ operating_day_start_hour: null })], vehicle_day_shifts: [] });
    expect(await loadVehicleDayPlan(noHour, PLAN_ID)).toMatchObject({ ok: false, reason: 'read_failed' });
  });

  it('reads a moment however PostgREST spells a timestamp without time zone', () => {
    expect(shiftFromRow(shiftRow(1, { starts_local: '2026-11-02 10:00:00', ends_local: '2026-11-02T13:00:00.000' }))).toMatchObject({
      start: { date: '2026-11-02', time: '10:00' }, end: { date: '2026-11-02', time: '13:00' },
    });
    expect(shiftFromRow(shiftRow(1, { starts_local: '2026-11-02T10:00:00+01:00' }))).toBeNull();
  });
});

describe('loadVehicleDayPlanForMonth', () => {
  const tables = (plans: Row[]) => ({ vehicle_day_plans: plans, vehicle_day_shifts: [shiftRow(1)] });

  it('goes by the confirmed plan, and by the newest draft only when there is none', async () => {
    const confirmed = planRow({ id: 'pc', status: 'confirmed', created_at: '2026-10-01T00:00:00+00:00' });
    const draft = planRow({ id: 'pd', status: 'draft', confirmed_at: null, confirmed_by: null, created_at: '2026-10-20T00:00:00+00:00' });
    const older = planRow({ id: 'po', status: 'draft', confirmed_at: null, confirmed_by: null, created_at: '2026-10-10T00:00:00+00:00' });
    const both = await loadVehicleDayPlanForMonth(reader(tables([draft, confirmed, older])), COMPANY, 2026, 11);
    expect(both.ok && both.plan?.id).toBe('pc');
    const onlyDrafts = await loadVehicleDayPlanForMonth(reader(tables([older, draft])), COMPANY, 2026, 11);
    expect(onlyDrafts.ok && onlyDrafts.plan?.id).toBe('pd');
  });

  it('does not offer a superseded plan, and says null for a month with no plan', async () => {
    const superseded = planRow({ id: 'ps', status: 'superseded', superseded_at: '2026-10-21T00:00:00+00:00' });
    expect(await loadVehicleDayPlanForMonth(reader(tables([superseded])), COMPANY, 2026, 11)).toEqual({ ok: true, plan: null });
    expect(await loadVehicleDayPlanForMonth(reader(tables([])), COMPANY, 2026, 11)).toEqual({ ok: true, plan: null });
  });

  it('asks for the company, year and month, and fails loudly rather than answering "no plan"', async () => {
    const client = reader(tables([planRow()]));
    await loadVehicleDayPlanForMonth(client, COMPANY, 2026, 11);
    expect(client.requests[0].filters).toEqual([['company_id', COMPANY], ['year', 2026], ['month', 11]]);
    const failing = reader(tables([planRow()]), () => 'offline');
    expect(await loadVehicleDayPlanForMonth(failing, COMPANY, 2026, 11)).toEqual({ ok: false, reason: 'read_failed', detail: 'offline' });
  });

  it('carries the confirmed plan\'s own hour, not the engine\'s default', async () => {
    const result = await loadVehicleDayPlanForMonth(reader(tables([planRow({ operating_day_start_hour: 22, slot_minutes: 60 })])), COMPANY, 2026, 11);
    expect(result.ok && result.plan && [result.plan.operatingDayStartHour, result.plan.slotMinutes]).toEqual([22, 60]);
  });
});

describe('a saved plan reads back as the engine made it', () => {
  it('maps every stored shift back to the shape the recommendation screens draw', async () => {
    const source = sourceFor(15, 4);
    const payload = toSavePayload(source);
    const rows = payload.shifts.map((s, i) => ({
      id: `r${i}`, plan_id: PLAN_ID, ...s, starts_local: `${s.starts_local}:00`, ends_local: `${s.ends_local}:00`,
    }));
    const client = reader({ vehicle_day_plans: [planRow({ status: 'draft' })], vehicle_day_shifts: rows });
    const result = await loadVehicleDayPlan(client, PLAN_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const key = (s: { id: string; startPosition: number; start: { date: string; time: string }; end: { date: string; time: string }; minutes: number; expectedRevenueCents: number }) =>
      `${s.id}|${s.startPosition}|${s.start.date}T${s.start.time}|${s.end.date}T${s.end.time}|${s.minutes}|${s.expectedRevenueCents}`;
    expect(result.plan.shifts.map(key).sort()).toEqual([...source.recommendation.shifts].map(key).sort());
  });
});
