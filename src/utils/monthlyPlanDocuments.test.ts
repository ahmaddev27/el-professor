import { describe, it, expect } from 'vitest';
import {
  MONTH_NAMES_DE,
  PLANNING_MARKER,
  documentBlockReason,
  fileNamePart,
  monthlyPlanFileName,
  storedPlanFromGenerated,
  type DocumentSubject,
  type MonthlyPlanDocumentBuilder,
  type StoredMonthlyPlan,
  type StoredPlanProjection,
} from './monthlyPlanDocuments';
import { assignBlocks, buildBlocks, buildAvailability, validatePlan } from './monthlyPlan';
import type { PlanDriverInput, PlanTripInput } from './monthlyPlan';

/**
 * What these assert, and what each one would have caught.
 *
 * `storedPlanFromGenerated` is the single object the three documents read (§12,
 * criterion 22). Five ways of getting it wrong are each pinned, because each one
 * produces a plausible document that disagrees with the plan it claims to print:
 *
 *   1. **recomputing a minute figure** instead of copying the engine's. A
 *      document that re-derived `span_minutes` from the instants would round
 *      differently on any ride whose seconds are not zero, which is the shape of
 *      the defect the two existing Stundennachweis builders already have.
 *   2. **losing the `car_id` / `car_identifier` split.** `PlanBlock` carries one
 *      vehicle key holding either, so the projection has to recover the
 *      distinction the table's CHECK requires.
 *   3. **dropping an unassigned block.** §8 keeps it with a warning; a document
 *      built from a plan that silently lost it would understate the month, and
 *      criterion 23 forbids dropping anything silently.
 *   4. **letting `target_monthly_hours` into the snapshot.** §5 forbids it, and
 *      the guarantee is that there is no field to fill — asserted on the keys.
 *   5. **an unmarked filename.** Without `_PLANUNG_` a proposal filed next to a
 *      Stundennachweis is indistinguishable from a record of hours worked.
 *
 * `vitest.config.ts` pins TZ=Europe/Berlin, so the instants below mean in this
 * test what they mean in production.
 */

// ── fixtures ────────────────────────────────────────────────────────────────

const CAR_UUID = '11111111-2222-3333-4444-555555555555';

function trip(p: Partial<PlanTripInput> & { id: string }): PlanTripInput {
  return {
    id: p.id,
    vehicleId: 'vehicleId' in p ? p.vehicleId! : CAR_UUID,
    vehicleIdentifier: 'vehicleIdentifier' in p ? p.vehicleIdentifier! : 'B-AA-1',
    startAt: p.startAt,
    endAt: p.endAt,
    tripDate: p.tripDate,
    startTime: p.startTime,
    endTime: p.endTime,
    isCanceled: p.isCanceled,
    originalDriverName: p.originalDriverName ?? null,
    originalDriverId: p.originalDriverId ?? null,
  };
}

function driver(p: Partial<PlanDriverInput> & { id: string; name: string }): PlanDriverInput {
  return {
    id: p.id,
    name: p.name,
    isOwner: p.isOwner ?? false,
    minSalary: 'minSalary' in p ? p.minSalary! : 1000,
    maxSalary: 'maxSalary' in p ? p.maxSalary! : 2000,
    hourlyRate: 'hourlyRate' in p ? p.hourlyRate! : 20,
    planningPriority: p.planningPriority,
    canCoverOtherDrivers: p.canCoverOtherDrivers,
  };
}

/**
 * Runs the real engine, so the projection is tested against real engine output
 * rather than against a hand-written `AssignResult` that could agree with a wrong
 * projection.
 *
 * The two overrides are named rather than taken as a `Partial<…>`: spreading a
 * partial over a complete literal is where a required field quietly becomes
 * optional, and `selectedDriverIds` is the field whose absence the projection
 * reads as "the owner fallback".
 */
function project(
  trips: PlanTripInput[],
  drivers: PlanDriverInput[],
  over: {
    selectedDriverIds?: ReadonlySet<string>;
    originalDriverIdByTrip?: ReadonlyMap<string, string | null>;
  } = {},
): StoredMonthlyPlan {
  const switchMinutes = 60;
  const built = buildBlocks(trips, { switchMinutes });
  const pool = new Set(drivers.map(d => d.id));
  const availability = buildAvailability([], built.blocks, pool);
  const result = assignBlocks(built.blocks, drivers, availability, { switchMinutes, seed: 0 });
  const validation = validatePlan({
    blocks: built.blocks,
    drivers,
    availability,
    result,
    switchMinutes,
    rejectedTrips: built.rejected,
    sourceOverlaps: built.overlaps,
  });
  const projection: StoredPlanProjection = {
    companyId: 'company-1',
    year: 2026,
    month: 10,
    importId: 'import-1',
    switchMinutes,
    generation: 0,
    blocks: built.blocks,
    drivers,
    result,
    warnings: validation.warnings,
    selectedDriverIds: over.selectedDriverIds ?? pool,
    simulated: false,
    originalDriverIdByTrip: over.originalDriverIdByTrip,
  };
  return storedPlanFromGenerated(projection);
}

// ── 1. the figures are copied, not recomputed ───────────────────────────────

describe('storedPlanFromGenerated', () => {
  it('copies the engine\'s own minute figures, span and ride alike', () => {
    // Two rides 20 minutes apart, so the 60-minute switch keeps them in one
    // block: the span is 08:00 → 09:50 = 110 and the rides are 45 + 45 = 90.
    // A document that re-derived either from the instants would be computing a
    // second answer to a question the engine has already answered.
    const plan = project(
      [
        trip({ id: 't1', startAt: '2026-10-05T08:00:00+02:00', endAt: '2026-10-05T08:45:00+02:00' }),
        trip({ id: 't2', startAt: '2026-10-05T09:05:00+02:00', endAt: '2026-10-05T09:50:00+02:00' }),
      ],
      [driver({ id: 'd1', name: 'Anna Beispiel' })],
    );

    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0].span_minutes).toBe(110);
    expect(plan.blocks[0].ride_minutes).toBe(90);
    expect(plan.blocks[0].trips.map(t => t.minutes)).toEqual([45, 45]);
    // The two figures differ, which is the whole reason the table stores both.
    expect(plan.blocks[0].span_minutes).not.toBe(plan.blocks[0].ride_minutes);
  });

  it('writes the bounds as absolute instants, not clock text', () => {
    const plan = project(
      [trip({ id: 't1', startAt: '2026-10-05T23:40:00+02:00', endAt: '2026-10-06T00:20:00+02:00' })],
      [driver({ id: 'd1', name: 'Anna' })],
    );
    // A ride across midnight: 40 minutes, and the block's end is the next day.
    expect(plan.blocks[0].span_minutes).toBe(40);
    expect(plan.blocks[0].starts_at).toBe('2026-10-05T21:40:00.000Z');
    expect(plan.blocks[0].ends_at).toBe('2026-10-05T22:20:00.000Z');
  });

  // ── 2. the vehicle split ──────────────────────────────────────────────────

  it('recovers car_id from a uuid vehicle key', () => {
    const plan = project(
      [trip({ id: 't1', startAt: '2026-10-05T08:00:00+02:00', endAt: '2026-10-05T09:00:00+02:00' })],
      [driver({ id: 'd1', name: 'Anna' })],
    );
    expect(plan.blocks[0].car_id).toBe(CAR_UUID);
    expect(plan.blocks[0].car_identifier).toBe('B-AA-1');
  });

  it('keeps a plate as car_identifier and leaves car_id null', () => {
    // A car that is not in the fleet table: buildBlocks keys the block on the
    // plate, so `vehicleId` holds a plate and car_id must stay null — the table's
    // `monthly_plan_blocks_has_a_vehicle` CHECK is satisfied by the identifier.
    const plan = project(
      [
        trip({
          id: 't1',
          vehicleId: null,
          vehicleIdentifier: 'B-XY-99',
          startAt: '2026-10-05T08:00:00+02:00',
          endAt: '2026-10-05T09:00:00+02:00',
        }),
      ],
      [driver({ id: 'd1', name: 'Anna' })],
    );
    expect(plan.blocks[0].car_id).toBeNull();
    expect(plan.blocks[0].car_identifier).toBe('B-XY-99');
  });

  // ── 3. an unassigned block survives ───────────────────────────────────────

  it('keeps an unassigned block with a null driver rather than dropping it', () => {
    // No driver at all in the pool, so nothing can be assigned. §8: the block
    // stays, with a warning.
    const plan = project(
      [trip({ id: 't1', startAt: '2026-10-05T08:00:00+02:00', endAt: '2026-10-05T09:00:00+02:00' })],
      [],
    );
    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0].driver_id).toBeNull();
    expect(plan.blocks[0].driver_name).toBeNull();
    expect(plan.blocks[0].assignment_reason).toBeNull();
    expect(plan.blocks[0].assignment_note_id).toBeNull();
    expect(plan.warnings.some(w => w.kind === 'unassigned_block')).toBe(true);
  });

  it('gives an assigned block a driver, a name and a reason together', () => {
    const plan = project(
      [trip({ id: 't1', startAt: '2026-10-05T08:00:00+02:00', endAt: '2026-10-05T09:00:00+02:00' })],
      [driver({ id: 'd1', name: 'Anna Beispiel' })],
    );
    const block = plan.blocks[0];
    // The table's `driver_with_reason` CHECK: all three or none.
    expect(block.driver_id).toBe('d1');
    expect(block.driver_name).toBe('Anna Beispiel');
    expect(block.assignment_reason).not.toBeNull();
    // A note id only ever accompanies a mandatory pin.
    expect(block.assignment_note_id).toBeNull();
  });

  // ── 4. the driver snapshot, and what it may not contain ───────────────────

  it('snapshots the driver values and carries no target_monthly_hours', () => {
    const plan = project(
      [trip({ id: 't1', startAt: '2026-10-05T08:00:00+02:00', endAt: '2026-10-05T09:00:00+02:00' })],
      [driver({ id: 'd1', name: 'Anna', minSalary: 1200, maxSalary: 2400, hourlyRate: 15 })],
    );
    const snapshot = plan.drivers[0];
    expect(snapshot).toMatchObject({
      driver_id: 'd1',
      driver_name: 'Anna',
      selected: true,
      is_owner: false,
      planning_min_salary: 1200,
      planning_max_salary: 2400,
      planning_hourly_rate: 15,
    });
    // §5's prohibition, asserted structurally: no key of the snapshot names it.
    expect(Object.keys(snapshot).some(k => k.includes('target'))).toBe(false);
    // The engine's own words for an unusable range, here empty.
    expect(snapshot.range_problems).toEqual([]);
  });

  it('carries the engine\'s range problems rather than judging the figures again', () => {
    const plan = project(
      [trip({ id: 't1', startAt: '2026-10-05T08:00:00+02:00', endAt: '2026-10-05T09:00:00+02:00' })],
      [driver({ id: 'd1', name: 'Anna', hourlyRate: 0 })],
    );
    expect(plan.drivers[0].range_problems).toContain('invalid_hourly_rate');
  });

  it('marks a driver outside screen 2\'s selection as unselected', () => {
    // The owner fallback of §7 rule 8, which the table admits only for an owner.
    const plan = project(
      [trip({ id: 't1', startAt: '2026-10-05T08:00:00+02:00', endAt: '2026-10-05T09:00:00+02:00' })],
      [driver({ id: 'd1', name: 'Der Inhaber', isOwner: true })],
      { selectedDriverIds: new Set<string>() },
    );
    expect(plan.drivers[0].selected).toBe(false);
    expect(plan.drivers[0].is_owner).toBe(true);
  });

  it('fills original_driver_id from the caller\'s map and null without one', () => {
    const trips = [
      trip({
        id: 't1',
        startAt: '2026-10-05T08:00:00+02:00',
        endAt: '2026-10-05T09:00:00+02:00',
        originalDriverName: 'Bernd Alt',
      }),
    ];
    const withMap = project(trips, [driver({ id: 'd1', name: 'Anna' })], {
      originalDriverIdByTrip: new Map([['t1', 'old-driver-1']]),
    });
    expect(withMap.blocks[0].trips[0].original_driver_id).toBe('old-driver-1');
    expect(withMap.blocks[0].trips[0].original_driver_name).toBe('Bernd Alt');

    const withoutMap = project(trips, [driver({ id: 'd1', name: 'Anna' })]);
    expect(withoutMap.blocks[0].trips[0].original_driver_id).toBeNull();
  });

  it('is a draft: nothing has been stored', () => {
    const plan = project([], [driver({ id: 'd1', name: 'Anna' })]);
    expect(plan.status).toBe('draft');
    expect(plan.id).toBeNull();
  });
});

// ── 5. the filename carries the marker ──────────────────────────────────────

describe('monthlyPlanFileName', () => {
  const plan = { year: 2026, month: 10 };

  it('puts PLANUNG right after the document name', () => {
    expect(monthlyPlanFileName('stundennachweis', plan, 'pdf', 'Anna Beispiel'))
      .toBe('Stundennachweis_PLANUNG_Anna_Beispiel_Oktober_2026.pdf');
  });

  it('names the whole-month documents without a subject', () => {
    expect(monthlyPlanFileName('fahrtenbuch', plan, 'xlsx')).toBe('Fahrtenbuch_PLANUNG_Oktober_2026.xlsx');
    expect(monthlyPlanFileName('payroll_summary', plan, 'xlsx'))
      .toBe('Stundenuebersicht_PLANUNG_Oktober_2026.xlsx');
  });

  it('always carries the marker, whatever the document', () => {
    for (const kind of ['stundennachweis', 'fahrtenbuch', 'payroll_summary'] as const) {
      expect(monthlyPlanFileName(kind, plan, 'pdf')).toContain(`_${PLANNING_MARKER}_`);
    }
  });

  it('uses the German month name and never a US date order', () => {
    expect(monthlyPlanFileName('fahrtenbuch', { year: 2026, month: 3 }, 'xlsx'))
      .toBe('Fahrtenbuch_PLANUNG_März_2026.xlsx');
    expect(MONTH_NAMES_DE).toHaveLength(12);
  });

  it('accepts an extension with or without its dot', () => {
    expect(monthlyPlanFileName('fahrtenbuch', plan, '.xlsx')).toMatch(/\.xlsx$/);
  });
});

describe('fileNamePart', () => {
  it('transliterates umlauts instead of stripping them', () => {
    // `Müller` and `Moller` must not collapse onto one name: the second
    // download would overwrite the first with no error anywhere.
    expect(fileNamePart('Müller')).toBe('Mueller');
    expect(fileNamePart('Groß Öz')).toBe('Gross_Oez');
  });

  it('collapses everything else to single underscores and trims them', () => {
    expect(fileNamePart('  a / b \\ c  ')).toBe('a_b_c');
  });
});

// ── 6. a document is withheld until its data is there ───────────────────────

describe('documentBlockReason', () => {
  const builder: MonthlyPlanDocumentBuilder = {
    kind: 'fahrtenbuch',
    preview: () => ({ header: [], sections: [] }),
    file: () => Promise.reject(new Error('not built in this test')),
  };
  const plan: StoredMonthlyPlan = project(
    [trip({ id: 't1', startAt: '2026-10-05T08:00:00+02:00', endAt: '2026-10-05T09:00:00+02:00' })],
    [driver({ id: 'd1', name: 'Anna' })],
  );
  const base = {
    plan,
    loadFailed: false,
    confirmable: true,
    builder,
    subjects: null as readonly DocumentSubject[] | null,
  };

  it('offers a document when the plan is there and confirmable', () => {
    expect(documentBlockReason(base)).toBeNull();
  });

  it('withholds it when a read failed, before anything else', () => {
    // The repo's rule: a figure whose load failed is not shown and not exported.
    // Reported ahead of a missing builder, because a plan nobody could load says
    // nothing about which documents this build can produce.
    expect(documentBlockReason({ ...base, loadFailed: true })).toBe('load_failed');
    expect(documentBlockReason({ ...base, loadFailed: true, builder: undefined, plan: null }))
      .toBe('load_failed');
  });

  it('withholds it for a plan with a broken hard rule', () => {
    expect(documentBlockReason({ ...base, confirmable: false })).toBe('plan_not_confirmable');
  });

  it('withholds it when this build has no builder for it', () => {
    expect(documentBlockReason({ ...base, builder: undefined })).toBe('builder_missing');
  });

  it('withholds a per-subject document with no subjects', () => {
    expect(documentBlockReason({ ...base, subjects: [] })).toBe('no_subject');
    expect(documentBlockReason({ ...base, subjects: [{ id: 'd1', label: 'Anna' }] })).toBeNull();
  });

  it('withholds it when there is no plan at all', () => {
    expect(documentBlockReason({ ...base, plan: null })).toBe('no_plan');
  });
});
