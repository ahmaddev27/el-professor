import { describe, expect, it } from 'vitest';
import { de } from '../i18n/de';
import { en } from '../i18n/en';
import type { TranslationKey } from '../i18n';
import { assignBlocks, type PlanDriverInput } from './monthlyPlan/assign';
import { buildAvailability } from './monthlyPlan/availability';
import { buildBlocks, type PlanTripInput } from './monthlyPlan/blocks';
import {
  describePlanViolation,
  describePlanWarning,
  RANGE_PROBLEM_KEYS,
  REFUSAL_KEYS,
  TRIP_PROBLEM_KEYS,
  UNMET_REASON_KEYS,
  WARNING_KEYS,
  type PlanMessageContext,
} from './monthlyPlanMessages';
import { validatePlan, type PlanViolation, type PlanWarning } from './monthlyPlan/validate';

const BLOCK_ID = '0b5e2c1a-7d44-4a6e-9c11-3f2a8d9e1b77|1791878400000';
const DRIVER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER_DRIVER_ID = '16fd2706-8baf-433b-82eb-8c7fada847da';

const translator = (dictionary: Record<string, string | undefined>) =>
  (key: TranslationKey, vars: Record<string, string | number> = {}): string =>
    (dictionary[key] ?? de[key]).replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));

const context = (dictionary: Record<string, string | undefined>): PlanMessageContext => ({
  t: translator(dictionary),
  driverName: id => (id === DRIVER_ID ? 'Anna Beispiel' : id === OTHER_DRIVER_ID ? 'Bert Nachtfahrt' : 'unknown driver'),
  blockLabel: id => (id ? 'B-DEMO-1 · 05.10.2026 08:23' : 'unknown block'),
  vehicleLabel: id => (id ? 'B-DEMO-1' : null),
});

/** Every kind, each with every code its union has, so a code that reached a screen shows up here. */
const WARNINGS: PlanWarning[] = [
  { kind: 'unassigned_block', blockId: BLOCK_ID, detail: 'no selected driver was available', facts: { refusals: [] } },
  ...(Object.keys(REFUSAL_KEYS) as (keyof typeof REFUSAL_KEYS)[]).flatMap((refusal): PlanWarning[] => [
    { kind: 'unassigned_block', blockId: BLOCK_ID, detail: `${DRIVER_ID}: ${refusal}`, facts: { refusals: [{ driverId: DRIVER_ID, refusal }] } },
    { kind: 'pin_conflict', blockId: BLOCK_ID, driverId: DRIVER_ID, detail: refusal, facts: { brokenRule: refusal } },
  ]),
  ...(Object.keys(UNMET_REASON_KEYS) as (keyof typeof UNMET_REASON_KEYS)[]).map((unmetReason): PlanWarning => ({
    kind: 'unmet_mandatory_note', driverId: DRIVER_ID, detail: unmetReason, facts: { unmetReason },
  })),
  { kind: 'note_conflict', driverId: DRIVER_ID, detail: `exclusion ${OTHER_DRIVER_ID} overlaps mandatory ${DRIVER_ID}` },
  { kind: 'contested_block', blockId: BLOCK_ID, detail: `mandatory claims by ${DRIVER_ID}`, facts: { driverIds: [DRIVER_ID, OTHER_DRIVER_ID] } },
  ...(Object.keys(TRIP_PROBLEM_KEYS) as (keyof typeof TRIP_PROBLEM_KEYS)[]).map((tripProblem): PlanWarning => ({
    kind: 'rejected_trip', tripId: DRIVER_ID, detail: `${tripProblem}: 31.02.2026`, facts: { tripProblem, tripDate: '2026-10-05' },
  })),
  { kind: 'source_overlap', tripId: DRIVER_ID, detail: `${DRIVER_ID} overlaps ${OTHER_DRIVER_ID}`, facts: { vehicleId: BLOCK_ID, minutes: 12 } },
  { kind: 'driver_without_work', driverId: DRIVER_ID, detail: 'Anna Beispiel wurde kein Block zugeteilt.' },
  ...(Object.keys(RANGE_PROBLEM_KEYS) as (keyof typeof RANGE_PROBLEM_KEYS)[]).map((problem): PlanWarning => ({
    kind: 'driver_without_range', driverId: DRIVER_ID, detail: `Anna: ${problem}`, facts: { rangeProblems: [problem] },
  })),
];

const VIOLATIONS: PlanViolation[] = [
  { rule: 'block_assigned_twice', blockId: BLOCK_ID, driverId: DRIVER_ID, detail: `block ${BLOCK_ID} appears twice` },
  { rule: 'unknown_block', blockId: BLOCK_ID, driverId: DRIVER_ID, detail: 'x' },
  { rule: 'driver_not_in_pool', blockId: BLOCK_ID, driverId: DRIVER_ID, detail: 'x' },
  { rule: 'assigned_inside_exclusion', blockId: BLOCK_ID, driverId: DRIVER_ID, detail: `assigned inside note ${DRIVER_ID} (sick)` },
  { rule: 'vehicle_switch_gap', blockId: BLOCK_ID, driverId: DRIVER_ID, detail: 'x', facts: { otherBlockId: BLOCK_ID, minutes: 10, switchMinutes: 30 } },
  { rule: 'driver_overlap', blockId: BLOCK_ID, driverId: DRIVER_ID, detail: 'x', facts: { otherBlockId: BLOCK_ID } },
  { rule: 'exceeds_hours_cap', blockId: null, driverId: DRIVER_ID, detail: 'x', facts: { minutes: 700, capMinutes: 600 } },
  { rule: 'pin_ignored', blockId: BLOCK_ID, driverId: DRIVER_ID, detail: 'x', facts: { assignedDriverId: OTHER_DRIVER_ID } },
  { rule: 'pin_ignored', blockId: BLOCK_ID, driverId: DRIVER_ID, detail: 'x', facts: {} },
];

/** A code (`invalid_hourly_rate`), an id, or a placeholder nobody filled in. */
const RAW = /[a-z]+_[a-z_]+|[0-9a-f]{8}-[0-9a-f]{4}-|\{\w+\}/;

describe.each([['German', de], ['English', en]] as const)('%s', (_, dictionary) => {
  const ctx = context(dictionary as Record<string, string | undefined>);

  it.each(WARNINGS.map(w => [w.kind, w] as const))('words the warning %s without a code or an id', (_kind, warning) => {
    expect(describePlanWarning(warning, ctx)).not.toMatch(RAW);
  });

  it.each(VIOLATIONS.map(v => [v.rule, v] as const))('words the violation %s without a code or an id', (_rule, violation) => {
    expect(describePlanViolation(violation, ctx)).not.toMatch(RAW);
  });

  it('still words a finding stored before the facts existed', () => {
    for (const { facts: _facts, ...stored } of WARNINGS) {
      expect(describePlanWarning(stored, ctx)).not.toMatch(RAW);
    }
    for (const { facts: _facts, ...stored } of VIOLATIONS) {
      expect(describePlanViolation(stored, ctx)).not.toMatch(RAW);
    }
  });

  it('has a heading for every kind', () => {
    for (const key of Object.values(WARNING_KEYS)) expect(ctx.t(key)).not.toMatch(RAW);
  });
});

describe('the real engine', () => {
  // One mutation dropped the date from one of these five paths and no test noticed, so each is walked.
  it.each([
    ['end_before_start', { startAt: '2026-10-05T10:00:00Z', endAt: '2026-10-05T08:00:00Z' }, 'Das Ende liegt vor dem Start (05.10.2026).'],
    ['missing_start', { startTime: null }, 'Fahrt ohne Startzeit (05.10.2026).'],
    ['missing_end', { endTime: null }, 'Fahrt ohne Endzeit (05.10.2026).'],
    ['missing_vehicle', { vehicleId: null, vehicleIdentifier: null }, 'Fahrt ohne Fahrzeug (05.10.2026).'],
    ['unparsable_time', { tripDate: null }, 'Die Zeit ist nicht lesbar.'],
  ] as const)('a ride rejected as %s reads as a sentence, with its date where it has one', (problem, change, sentence) => {
    const ride: PlanTripInput = {
      id: 't1', vehicleId: 'car-A', vehicleIdentifier: 'B-DEMO-1', tripDate: '2026-10-05', startTime: '08:00', endTime: '10:00', ...change,
    };
    const { rejected } = buildBlocks([ride], { switchMinutes: 30 });
    expect(rejected.map(r => r.problem)).toEqual([problem]);
    const warning = validatePlan({
      blocks: [], drivers: [], availability: buildAvailability([], [], new Set()),
      result: assignBlocks([], [], buildAvailability([], [], new Set()), { switchMinutes: 30 }),
      switchMinutes: 30, rejectedTrips: rejected,
    }).warnings.find(w => w.kind === 'rejected_trip');
    expect(describePlanWarning(warning!, context(de as unknown as Record<string, string | undefined>))).toBe(sentence);
  });

  it('fills the facts the screen reads, and leaves the stored detail as it was', () => {
    const trips: PlanTripInput[] = [{
      id: 't1', vehicleId: 'car-A', vehicleIdentifier: 'B-DEMO-1', tripDate: '2026-10-05',
      startTime: '08:00', endTime: '10:00',
    }];
    const drivers: PlanDriverInput[] = [
      { id: DRIVER_ID, name: 'Anna Beispiel', isOwner: false, minSalary: 1950, maxSalary: 2100, hourlyRate: 0 },
    ];
    const built = buildBlocks(trips, { switchMinutes: 30 });
    const availability = buildAvailability([], built.blocks, new Set([DRIVER_ID]));
    const result = assignBlocks(built.blocks, drivers, availability, { switchMinutes: 30 });
    const validation = validatePlan({
      blocks: built.blocks, drivers, availability, result, switchMinutes: 30,
      rejectedTrips: built.rejected, sourceOverlaps: built.overlaps,
    });

    const range = validation.warnings.find(w => w.kind === 'driver_without_range');
    expect(range?.detail).toContain('invalid_hourly_rate');
    expect(range?.facts?.rangeProblems).toContain('invalid_hourly_rate');
    expect(describePlanWarning(range!, context(de as unknown as Record<string, string | undefined>)))
      .toBe('Anna Beispiel wurde nicht eingeplant: Stundensatz ungültig.');

    // A ride the engine could not use: its detail names database columns, and they must not come through.
    const rejected = validatePlan({
      blocks: [], drivers, availability, result, switchMinutes: 30,
      rejectedTrips: buildBlocks([{ ...trips[0], startTime: null }], { switchMinutes: 30 }).rejected,
    }).warnings.find(w => w.kind === 'rejected_trip');
    expect(rejected?.detail).toContain('trip_date');
    expect(describePlanWarning(rejected!, context(de as unknown as Record<string, string | undefined>)))
      .toBe('Fahrt ohne Startzeit (05.10.2026).');

    // Every warning the run produced, and it must have produced at least the one above.
    expect(validation.warnings.length).toBeGreaterThan(0);
    for (const warning of validation.warnings) {
      expect(warning.detail).toBeTruthy();
      expect(describePlanWarning(warning, context(de as unknown as Record<string, string | undefined>))).not.toMatch(RAW);
    }
  });
});
