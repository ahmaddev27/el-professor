import { describe, it, expect } from 'vitest';
import { buildBlocks, type PlanTripInput } from './blocks';
import { buildAvailability, type PlanNote } from './availability';
import { assignBlocks, type PlanDriverInput, type AssignResult } from './assign';

/**
 * §7 and §8, with §16's assignment cases written out:
 * exclusion prevents · overlap prevents · exceeding the cap prevents · the
 * owner has no monthly ceiling · mandatory inclusion affects the assignment ·
 * regeneration yields a valid alternative without relaxing anything.
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
    originalDriverName: p.originalDriverName,
  };
}

function driver(p: Partial<PlanDriverInput> & { id: string }): PlanDriverInput {
  return {
    id: p.id,
    name: p.name ?? p.id,
    isOwner: p.isOwner ?? false,
    // 1950–2100 € at 14 €/h → 139,29–150 h, the brief's own example.
    minSalary: 'minSalary' in p ? p.minSalary! : 1950,
    maxSalary: 'maxSalary' in p ? p.maxSalary! : 2100,
    hourlyRate: 'hourlyRate' in p ? p.hourlyRate! : 14,
    maxMonthlyHours: p.maxMonthlyHours,
    planningPriority: p.planningPriority,
    canCoverOtherDrivers: p.canCoverOtherDrivers,
  };
}

let noteSeq = 0;
function note(p: Partial<PlanNote> & { driver_id: string }): PlanNote {
  noteSeq += 1;
  return {
    id: p.id ?? `n${String(noteSeq).padStart(3, '0')}`,
    driver_id: p.driver_id,
    note_type: p.note_type ?? 'sick',
    note_text: p.note_text ?? '',
    note_planning_behavior: p.note_planning_behavior ?? 'exclude_from_plan',
    is_full_day: p.is_full_day ?? false,
    start_date: 'start_date' in p ? p.start_date! : '2026-10-05',
    end_date: 'end_date' in p ? p.end_date! : '2026-10-05',
    note_date: p.note_date ?? null,
    start_time: 'start_time' in p ? p.start_time! : null,
    end_time: 'end_time' in p ? p.end_time! : null,
    car_id: p.car_id,
  };
}

function plan(
  trips: PlanTripInput[],
  drivers: PlanDriverInput[],
  notes: PlanNote[] = [],
  switchMinutes = 30,
  seed = 0,
): AssignResult {
  const { blocks } = buildBlocks(trips, { switchMinutes });
  const availability = buildAvailability(notes, blocks, new Set(drivers.map(d => d.id)));
  return assignBlocks(blocks, drivers, availability, { switchMinutes, seed });
}

const dayBlock = (id: string, vehicleId: string, date: string, from: string, to: string) =>
  trip({ id, vehicleId, tripDate: date, startTime: from, endTime: to });

describe('hard rule 4 — exclusion prevents assignment (§16)', () => {
  it('a sick driver never receives an overlapping block, whoever else exists', () => {
    const r = plan(
      [dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00')],
      [driver({ id: 'ali' })],
      [note({ driver_id: 'ali', is_full_day: true })],
    );
    expect(r.assignments).toHaveLength(0);
    expect(r.unassigned).toHaveLength(1);
    expect(r.unassigned[0].refusals).toEqual([
      { driverId: 'ali', refusal: 'excluded_by_note' },
    ]);
  });
});

describe('hard rule 2 — overlap prevents assignment (§16)', () => {
  it('two simultaneous blocks on two cars never land on one driver', () => {
    const r = plan(
      [
        dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00'),
        dayBlock('b', 'car-B', '2026-10-05', '09:00', '13:00'),
      ],
      [driver({ id: 'ali' })],
    );
    expect(r.assignments).toHaveLength(1);
    expect(r.unassigned).toHaveLength(1);
    expect(r.unassigned[0].refusals[0].refusal).toBe('driver_overlap');
  });
});

describe('hard rule 3 — the cap prevents assignment, and the owner is exempt (§16)', () => {
  it('a regular driver stops at the effective cap', () => {
    // Cap: 60 € / 14 €/h ≈ 4.29 h. Two 4-hour blocks: the second must be refused.
    const r = plan(
      [
        dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00'),
        dayBlock('b', 'car-A', '2026-10-06', '08:00', '12:00'),
      ],
      [driver({ id: 'ali', minSalary: 50, maxSalary: 60 })],
    );
    expect(r.assignments).toHaveLength(1);
    expect(r.unassigned[0].refusals[0].refusal).toBe('exceeds_hours_cap');
  });

  it('the explicit monthly cap binds when it is the tighter one', () => {
    const r = plan(
      [
        dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00'),
        dayBlock('b', 'car-A', '2026-10-06', '08:00', '12:00'),
      ],
      [driver({ id: 'ali', maxMonthlyHours: 7 })], // salary cap is 150 h
    );
    expect(r.assignments).toHaveLength(1);
    expect(r.unassigned[0].refusals[0].refusal).toBe('exceeds_hours_cap');
  });

  it('the owner has no monthly ceiling (§8, §16)', () => {
    // 20 four-hour blocks = 80 h, far above the owner's own salary maximum.
    const trips: PlanTripInput[] = [];
    for (let d = 1; d <= 20; d++) {
      trips.push(dayBlock(`a${d}`, 'car-A', `2026-10-${String(d).padStart(2, '0')}`, '08:00', '12:00'));
    }
    const r = plan(trips, [driver({ id: 'boss', isOwner: true, minSalary: 100, maxSalary: 200 })]);
    expect(r.assignments).toHaveLength(20);
    expect(r.unassigned).toHaveLength(0);
  });

  it('a driver with an unusable rate is refused visibly, not capped at nothing', () => {
    const r = plan(
      [dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00')],
      [driver({ id: 'ali', hourlyRate: 0 })],
    );
    expect(r.assignments).toHaveLength(0);
    expect(r.unassigned[0].refusals[0].refusal).toBe('no_usable_range');
  });
});

describe('the derived check — the switch duration between vehicles', () => {
  it('refuses a hop between two cars shorter than the switch duration', () => {
    const r = plan(
      [
        dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00'),
        dayBlock('b', 'car-B', '2026-10-05', '12:10', '16:00'), // 10-minute hop
      ],
      [driver({ id: 'ali' })],
      [],
      30,
    );
    expect(r.assignments).toHaveLength(1);
    expect(r.unassigned[0].refusals[0].refusal).toBe('vehicle_switch_gap');
  });

  it('allows the hop once the gap reaches the switch duration', () => {
    const r = plan(
      [
        dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00'),
        dayBlock('b', 'car-B', '2026-10-05', '12:30', '16:00'),
      ],
      [driver({ id: 'ali' })],
      [],
      30,
    );
    expect(r.assignments).toHaveLength(2);
    expect(r.unassigned).toHaveLength(0);
  });

  it('needs no gap between consecutive blocks of the same vehicle beyond what §3 built', () => {
    // Same car, 30-minute gap, 30-minute switch: two blocks, one driver, legal.
    const r = plan(
      [
        dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00'),
        dayBlock('b', 'car-A', '2026-10-05', '12:30', '16:00'),
      ],
      [driver({ id: 'ali' })],
      [],
      30,
    );
    expect(r.assignments).toHaveLength(2);
  });
});

describe('rule 5 — mandatory inclusion affects the assignment (§16)', () => {
  it('the pinned driver gets the block even when another driver needs hours more', () => {
    const r = plan(
      [dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00')],
      [driver({ id: 'ali' }), driver({ id: 'sami' })],
      [note({
        driver_id: 'sami',
        note_type: 'kontrolle',
        note_planning_behavior: 'must_include_in_plan',
        start_time: '10:00',
        end_time: '10:15',
      })],
    );
    expect(r.assignments).toEqual([
      expect.objectContaining({ blockId: expect.any(String), driverId: 'sami', reason: 'mandatory_note' }),
    ]);
  });

  it('a pin that would breach the cap becomes a visible conflict, not a silent breach', () => {
    const r = plan(
      [
        dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00'),
        dayBlock('b', 'car-A', '2026-10-06', '08:00', '12:00'),
      ],
      [driver({ id: 'ali', minSalary: 50, maxSalary: 60 }), driver({ id: 'sami' })],
      [
        // Ali is pinned to both days, but his cap (~4.3 h) holds one block only.
        note({ id: 'n-1', driver_id: 'ali', note_planning_behavior: 'must_include_in_plan', start_date: '2026-10-05', end_date: '2026-10-05', start_time: '09:00', end_time: '09:15' }),
        note({ id: 'n-2', driver_id: 'ali', note_planning_behavior: 'must_include_in_plan', start_date: '2026-10-06', end_date: '2026-10-06', start_time: '09:00', end_time: '09:15' }),
      ],
    );
    expect(r.pinConflicts).toHaveLength(1);
    expect(r.pinConflicts[0]).toMatchObject({ driverId: 'ali', brokenRule: 'exceeds_hours_cap' });
    // The conflicted day is then assigned normally — to sami.
    const day2 = r.assignments.find(a => a.reason !== 'mandatory_note');
    expect(day2?.driverId).toBe('sami');
  });
});

describe('§8 — the owner takes surplus only', () => {
  it('never wins a block a regular driver can validly take', () => {
    const r = plan(
      [dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00')],
      [driver({ id: 'ali' }), driver({ id: 'boss', isOwner: true })],
    );
    expect(r.assignments[0].driverId).toBe('ali');
  });

  it('takes the block when every regular driver is validly refused', () => {
    const r = plan(
      [
        dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00'),
        dayBlock('b', 'car-B', '2026-10-05', '09:00', '13:00'), // overlaps a
      ],
      [driver({ id: 'ali' }), driver({ id: 'boss', isOwner: true })],
    );
    const byBlock = new Map(r.assignments.map(a => [a.blockId.split('|')[0], a]));
    expect(byBlock.get('car-A')!.driverId).toBe('ali');
    expect(byBlock.get('car-B')!.driverId).toBe('boss');
    expect(byBlock.get('car-B')!.reason).toBe('owner_fallback');
  });

  it('with no owner, an uncoverable block stays unassigned with the reasons listed (§8, §14)', () => {
    const r = plan(
      [
        dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00'),
        dayBlock('b', 'car-B', '2026-10-05', '09:00', '13:00'),
      ],
      [driver({ id: 'ali' })],
    );
    expect(r.unassigned).toHaveLength(1);
    expect(r.unassigned[0].ownerConsidered).toBe(false);
    expect(r.unassigned[0].refusals).toHaveLength(1);
  });

  it('the owner respects overlap and exclusion like anyone (§7 rules 2 and 4)', () => {
    const r = plan(
      [
        dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00'),
        dayBlock('b', 'car-B', '2026-10-05', '09:00', '13:00'),
        dayBlock('c', 'car-C', '2026-10-05', '10:00', '14:00'),
      ],
      [driver({ id: 'boss', isOwner: true })],
    );
    // One of the three overlapping blocks goes to the owner; two cannot.
    expect(r.assignments).toHaveLength(1);
    expect(r.unassigned).toHaveLength(2);
  });
});

describe('the optimisation — toward the salary range, and the tie-breakers', () => {
  it('prefers the driver further below their minimum', () => {
    // Two identical drivers; ali already has the first day, so the second day
    // goes to sami, who is further below his minimum.
    const r = plan(
      [
        dayBlock('a', 'car-A', '2026-10-05', '08:00', '16:00'),
        dayBlock('b', 'car-A', '2026-10-06', '08:00', '16:00'),
      ],
      [driver({ id: 'ali' }), driver({ id: 'sami' })],
    );
    const days = r.assignments.map(a => a.driverId).sort();
    expect(days).toEqual(['ali', 'sami']);
  });

  it('planning priority decides an exact tie (§7: the deciding factor)', () => {
    const r = plan(
      [dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00')],
      [
        driver({ id: 'ali', planningPriority: 100 }),
        driver({ id: 'sami', planningPriority: 200 }),
      ],
    );
    expect(r.assignments[0].driverId).toBe('sami');
  });

  it('a non-covering driver is steered away from a colleague’s block, softly', () => {
    const r = plan(
      [trip({ id: 'a', vehicleId: 'car-A', startTime: '08:00', endTime: '12:00', originalDriverName: 'Sami' })],
      [
        driver({ id: 'ali', name: 'Ali', canCoverOtherDrivers: false }),
        driver({ id: 'omar', name: 'Omar' }),
      ],
    );
    expect(r.assignments[0].driverId).toBe('omar');
  });

  it('but still takes it when nobody else can — a preference, not a tenth hard rule', () => {
    const r = plan(
      [trip({ id: 'a', vehicleId: 'car-A', startTime: '08:00', endTime: '12:00', originalDriverName: 'Sami' })],
      [driver({ id: 'ali', name: 'Ali', canCoverOtherDrivers: false })],
    );
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0].driverId).toBe('ali');
  });
});

describe('regeneration (§7 rule 9, acceptance 14)', () => {
  const trips = [
    dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00'),
    dayBlock('b', 'car-B', '2026-10-06', '08:00', '12:00'),
    dayBlock('c', 'car-A', '2026-10-07', '08:00', '12:00'),
    dayBlock('d', 'car-B', '2026-10-08', '08:00', '12:00'),
  ];
  // Identical twins, so every block is a genuine tie at the start.
  const twins = [driver({ id: 'ali' }), driver({ id: 'sami' })];

  it('the same seed reproduces the identical plan', () => {
    const r1 = plan(trips, twins, [], 30, 7);
    const r2 = plan(trips, twins, [], 30, 7);
    expect(r2.assignments).toEqual(r1.assignments);
  });

  it('a new seed changes only flexible choices, and every plan stays valid', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 6; seed++) {
      const r = plan(trips, twins, [], 30, seed);
      // Valid under the hard rules whatever the seed:
      expect(r.unassigned).toHaveLength(0);
      expect(r.pinConflicts).toHaveLength(0);
      for (const s of r.driverStates) {
        if (!s.driver.isOwner && s.range.effectiveMaxHours != null) {
          expect(s.minutes).toBeLessThanOrEqual(s.range.effectiveMaxHours * 60);
        }
      }
      seen.add(r.assignments.map(a => `${a.blockId}:${a.driverId}`).join(','));
    }
    // At least two distinct valid alternatives across six seeds — the button
    // does something, without any constraint moving.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('the seed never overrides a pin', () => {
    for (let seed = 0; seed < 4; seed++) {
      const r = plan(
        trips,
        twins,
        [note({ driver_id: 'ali', note_planning_behavior: 'must_include_in_plan', start_date: '2026-10-06', end_date: '2026-10-06', start_time: '09:00', end_time: '09:10' })],
        30,
        seed,
      );
      const pinned = r.assignments.find(a => a.reason === 'mandatory_note');
      expect(pinned?.driverId).toBe('ali');
    }
  });
});

describe('the driver states the summary screen reads (§1 screen 3)', () => {
  it('reports minutes, ride minutes, trips, and the position against the range', () => {
    const r = plan(
      [
        trip({ id: 'a', vehicleId: 'car-A', startTime: '08:00', endTime: '08:30' }),
        trip({ id: 'b', vehicleId: 'car-A', startTime: '08:50', endTime: '09:20' }),
      ],
      [driver({ id: 'ali' })],
    );
    const s = r.driverStates[0];
    expect(s.minutes).toBe(80);      // span
    expect(s.rideMinutes).toBe(60);  // the rides themselves
    expect(s.tripCount).toBe(2);
    expect(s.assessment.position).toBe('below'); // 80 min against 139,29 h
  });

  it('a selected driver with nothing keeps a state, so the summary shows the empty row', () => {
    const r = plan(
      [dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00')],
      [driver({ id: 'ali' }), driver({ id: 'sami' })],
    );
    expect(r.driverStates).toHaveLength(2);
    const idle = r.driverStates.find(s => s.assignedBlockIds.length === 0)!;
    expect(idle.assessment.position).toBe('no_hours');
  });
});
