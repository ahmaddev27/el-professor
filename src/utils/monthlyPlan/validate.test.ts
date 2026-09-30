import { describe, it, expect } from 'vitest';
import { buildBlocks, type PlanTripInput } from './blocks';
import { buildAvailability, type PlanNote } from './availability';
import { assignBlocks, type PlanDriverInput, type AssignResult } from './assign';
import { validatePlan } from './validate';

/**
 * Acceptance criterion 15: a plan with unresolved hard conflicts cannot be
 * confirmed. The validator re-derives every check from the raw inputs, so
 * these tests tamper with a finished plan and expect the tampering to be
 * caught — the case the assigner itself can never produce.
 */

let tripSeq = 0;
function trip(p: Partial<PlanTripInput> & { startTime: string; endTime: string }): PlanTripInput {
  tripSeq += 1;
  return {
    id: p.id ?? `t${tripSeq}`,
    vehicleId: p.vehicleId ?? 'car-A',
    vehicleIdentifier: p.vehicleIdentifier ?? 'B-AA-1',
    tripDate: p.tripDate ?? '2026-10-05',
    startTime: p.startTime,
    endTime: p.endTime,
  };
}

function driver(p: Partial<PlanDriverInput> & { id: string }): PlanDriverInput {
  return {
    id: p.id,
    name: p.name ?? p.id,
    isOwner: p.isOwner ?? false,
    minSalary: 'minSalary' in p ? p.minSalary! : 1950,
    maxSalary: 'maxSalary' in p ? p.maxSalary! : 2100,
    hourlyRate: 'hourlyRate' in p ? p.hourlyRate! : 14,
    maxMonthlyHours: p.maxMonthlyHours,
  };
}

let noteSeq = 0;
function note(p: Partial<PlanNote> & { driver_id: string }): PlanNote {
  noteSeq += 1;
  return {
    id: p.id ?? `n${String(noteSeq).padStart(3, '0')}`,
    driver_id: p.driver_id,
    note_type: p.note_type ?? 'sick',
    note_text: '',
    note_planning_behavior: p.note_planning_behavior ?? 'exclude_from_plan',
    is_full_day: p.is_full_day ?? false,
    start_date: 'start_date' in p ? p.start_date! : '2026-10-05',
    end_date: 'end_date' in p ? p.end_date! : '2026-10-05',
    note_date: null,
    start_time: 'start_time' in p ? p.start_time! : null,
    end_time: 'end_time' in p ? p.end_time! : null,
    car_id: p.car_id,
  };
}

function build(
  trips: PlanTripInput[],
  drivers: PlanDriverInput[],
  notes: PlanNote[] = [],
  switchMinutes = 30,
) {
  const built = buildBlocks(trips, { switchMinutes });
  const availability = buildAvailability(notes, built.blocks, new Set(drivers.map(d => d.id)));
  const result = assignBlocks(built.blocks, drivers, availability, { switchMinutes });
  return { built, availability, result, drivers, switchMinutes };
}

function validate(x: ReturnType<typeof build>, result?: AssignResult) {
  return validatePlan({
    blocks: x.built.blocks,
    drivers: x.drivers,
    availability: x.availability,
    result: result ?? x.result,
    switchMinutes: x.switchMinutes,
    rejectedTrips: x.built.rejected,
    sourceOverlaps: x.built.overlaps,
  });
}

describe('a clean plan is confirmable', () => {
  it('no violations, no warnings, confirmable', () => {
    const x = build(
      [
        trip({ id: 'a', startTime: '08:00', endTime: '12:00' }),
        trip({ id: 'b', tripDate: '2026-10-06', startTime: '08:00', endTime: '12:00' }),
      ],
      [driver({ id: 'ali' }), driver({ id: 'sami' })],
    );
    const v = validate(x);
    expect(v.violations).toHaveLength(0);
    expect(v.warnings).toHaveLength(0);
    expect(v.confirmable).toBe(true);
  });

  it('everything the assigner produces validates clean, across seeds', () => {
    const trips = [
      trip({ id: 'a', vehicleId: 'car-A', startTime: '06:00', endTime: '10:00' }),
      trip({ id: 'b', vehicleId: 'car-B', startTime: '07:00', endTime: '11:00' }),
      trip({ id: 'c', vehicleId: 'car-A', startTime: '14:00', endTime: '18:00' }),
      trip({ id: 'd', vehicleId: 'car-B', startTime: '15:00', endTime: '19:00' }),
    ];
    const drivers = [driver({ id: 'ali' }), driver({ id: 'sami' }), driver({ id: 'boss', isOwner: true })];
    for (let seed = 0; seed < 5; seed++) {
      const built = buildBlocks(trips, { switchMinutes: 30 });
      const availability = buildAvailability([], built.blocks, new Set(drivers.map(d => d.id)));
      const result = assignBlocks(built.blocks, drivers, availability, { switchMinutes: 30, seed });
      const v = validatePlan({
        blocks: built.blocks, drivers, availability, result, switchMinutes: 30,
      });
      expect(v.violations).toHaveLength(0);
    }
  });
});

describe('tampering is caught — the checks are re-derived, not trusted', () => {
  const base = () => build(
    [
      trip({ id: 'a', vehicleId: 'car-A', startTime: '08:00', endTime: '12:00' }),
      trip({ id: 'b', vehicleId: 'car-B', startTime: '09:00', endTime: '13:00' }),
    ],
    [driver({ id: 'ali' }), driver({ id: 'sami' })],
  );

  it('an overlap smuggled into the assignments blocks confirmation', () => {
    const x = base();
    // Rewrite every assignment onto ali — a hand-edited plan.
    const tampered: AssignResult = {
      ...x.result,
      assignments: x.built.blocks.map(b => ({
        blockId: b.id, driverId: 'ali', driverName: 'ali', reason: 'best_fit' as const,
      })),
      unassigned: [],
    };
    const v = validate(x, tampered);
    expect(v.violations.some(t => t.rule === 'driver_overlap')).toBe(true);
    expect(v.confirmable).toBe(false);
  });

  it('an assignment inside an exclusion blocks confirmation', () => {
    const x = build(
      [trip({ id: 'a', startTime: '08:00', endTime: '12:00' })],
      [driver({ id: 'ali' })],
      [note({ driver_id: 'ali', is_full_day: true })],
    );
    const tampered: AssignResult = {
      ...x.result,
      assignments: [{ blockId: x.built.blocks[0].id, driverId: 'ali', driverName: 'ali', reason: 'best_fit' }],
      unassigned: [],
    };
    const v = validate(x, tampered);
    expect(v.violations.some(t => t.rule === 'assigned_inside_exclusion')).toBe(true);
    expect(v.confirmable).toBe(false);
  });

  it('a cap breach blocks confirmation', () => {
    const x = build(
      [
        trip({ id: 'a', tripDate: '2026-10-05', startTime: '08:00', endTime: '12:00' }),
        trip({ id: 'b', tripDate: '2026-10-06', startTime: '08:00', endTime: '12:00' }),
      ],
      [driver({ id: 'ali', minSalary: 50, maxSalary: 60 })], // cap ≈ 4.3 h
    );
    const tampered: AssignResult = {
      ...x.result,
      assignments: x.built.blocks.map(b => ({
        blockId: b.id, driverId: 'ali', driverName: 'ali', reason: 'best_fit' as const,
      })),
      unassigned: [],
    };
    const v = validate(x, tampered);
    expect(v.violations.some(t => t.rule === 'exceeds_hours_cap')).toBe(true);
  });

  it('a cross-vehicle hop under the switch duration blocks confirmation', () => {
    const x = build(
      [
        trip({ id: 'a', vehicleId: 'car-A', startTime: '08:00', endTime: '12:00' }),
        trip({ id: 'b', vehicleId: 'car-B', startTime: '12:10', endTime: '16:00' }),
      ],
      [driver({ id: 'ali' }), driver({ id: 'sami' })],
    );
    const tampered: AssignResult = {
      ...x.result,
      assignments: x.built.blocks.map(b => ({
        blockId: b.id, driverId: 'ali', driverName: 'ali', reason: 'best_fit' as const,
      })),
      unassigned: [],
    };
    const v = validate(x, tampered);
    expect(v.violations.some(t => t.rule === 'vehicle_switch_gap')).toBe(true);
  });

  it('a block assigned twice blocks confirmation', () => {
    const x = base();
    const b0 = x.built.blocks[0];
    const tampered: AssignResult = {
      ...x.result,
      assignments: [
        { blockId: b0.id, driverId: 'ali', driverName: 'ali', reason: 'best_fit' },
        { blockId: b0.id, driverId: 'sami', driverName: 'sami', reason: 'best_fit' },
      ],
    };
    const v = validate(x, tampered);
    expect(v.violations.some(t => t.rule === 'block_assigned_twice')).toBe(true);
  });

  it('an assignment to a driver outside the pool blocks confirmation (§7 rule 8)', () => {
    const x = base();
    const tampered: AssignResult = {
      ...x.result,
      assignments: [{ blockId: x.built.blocks[0].id, driverId: 'ghost', driverName: 'ghost', reason: 'best_fit' }],
    };
    const v = validate(x, tampered);
    expect(v.violations.some(t => t.rule === 'driver_not_in_pool')).toBe(true);
  });

  it('a pin quietly reassigned to someone else blocks confirmation (§7 rule 5)', () => {
    const x = build(
      [trip({ id: 'a', startTime: '08:00', endTime: '12:00' })],
      [driver({ id: 'ali' }), driver({ id: 'sami' })],
      [note({ driver_id: 'sami', note_planning_behavior: 'must_include_in_plan', start_time: '09:00', end_time: '09:15' })],
    );
    const tampered: AssignResult = {
      ...x.result,
      assignments: [{ blockId: x.built.blocks[0].id, driverId: 'ali', driverName: 'ali', reason: 'best_fit' }],
      pinConflicts: [],
    };
    const v = validate(x, tampered);
    expect(v.violations.some(t => t.rule === 'pin_ignored')).toBe(true);
  });
});

describe('warnings show and do not block (§6, §8, §14)', () => {
  it('an unassigned block is a warning and the plan stays confirmable', () => {
    const x = build(
      [
        trip({ id: 'a', vehicleId: 'car-A', startTime: '08:00', endTime: '12:00' }),
        trip({ id: 'b', vehicleId: 'car-B', startTime: '09:00', endTime: '13:00' }),
      ],
      [driver({ id: 'ali' })], // no owner: one block must stay open
    );
    const v = validate(x);
    expect(v.warnings.some(w => w.kind === 'unassigned_block')).toBe(true);
    expect(v.confirmable).toBe(true);
  });

  it('an unmet mandatory note and its exclusion conflict both surface', () => {
    const x = build(
      [trip({ id: 'a', startTime: '08:00', endTime: '12:00' })],
      [driver({ id: 'ali' }), driver({ id: 'sami' })],
      [
        note({ id: 'n-sick', driver_id: 'ali', is_full_day: true }),
        note({ id: 'n-ctrl', driver_id: 'ali', note_planning_behavior: 'must_include_in_plan', start_time: '09:00', end_time: '09:15' }),
      ],
    );
    const v = validate(x);
    expect(v.warnings.some(w => w.kind === 'note_conflict')).toBe(true);
    expect(v.warnings.some(w => w.kind === 'unmet_mandatory_note')).toBe(true);
    expect(v.confirmable).toBe(true);
  });

  it('rejected trips and source overlaps pass through as data-error warnings (§14)', () => {
    const x = build(
      [
        trip({ id: 'a', startTime: '08:00', endTime: '12:00' }),
        trip({ id: 'bad', startTime: 'nonsense', endTime: '12:00' }),
        trip({ id: 'ov1', vehicleId: 'car-B', startTime: '08:00', endTime: '10:00' }),
        trip({ id: 'ov2', vehicleId: 'car-B', startTime: '09:00', endTime: '11:00' }),
      ],
      [driver({ id: 'ali' }), driver({ id: 'sami' })],
    );
    const v = validate(x);
    expect(v.warnings.some(w => w.kind === 'rejected_trip' && w.tripId === 'bad')).toBe(true);
    expect(v.warnings.some(w => w.kind === 'source_overlap')).toBe(true);
  });
});
