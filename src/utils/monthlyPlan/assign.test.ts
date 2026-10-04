import { describe, it, expect } from 'vitest';
import { buildBlocks, type PlanTripInput } from './blocks';
import { buildAvailability, type PlanNote } from './availability';
import {
  assignBlocks,
  comparePlanQuality,
  planQuality,
  searchAssignments,
  qualityDelta,
  type PlanDriverInput,
  type AssignResult,
} from './assign';

/**
 * آ§7 and آ§8, with آ§16's assignment cases written out:
 * exclusion prevents آ· overlap prevents آ· exceeding the cap prevents آ· the
 * owner has no monthly ceiling آ· mandatory inclusion affects the assignment آ·
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
    // 1950â€“2100 â‚¬ at 14 â‚¬/h â†’ 139,29â€“150 h, the brief's own example.
    minSalary: 'minSalary' in p ? p.minSalary! : 1950,
    maxSalary: 'maxSalary' in p ? p.maxSalary! : 2100,
    hourlyRate: 'hourlyRate' in p ? p.hourlyRate! : 14,
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

describe('hard rule 4 â€” exclusion prevents assignment (آ§16)', () => {
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

describe('hard rule 2 â€” overlap prevents assignment (آ§16)', () => {
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

describe('hard rule 3 â€” the cap prevents assignment, and the owner is exempt (آ§16)', () => {
  it('a regular driver stops at the effective cap', () => {
    // Cap: 60 â‚¬ / 14 â‚¬/h â‰ˆ 4.29 h. Two 4-hour blocks: the second must be refused.
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

  /**
   * The cap still binds â€” it just has one source now. Since 01.10.2026 the plan
   * works from salaries, so a driver's ceiling is `max_salary / hourly_rate` and
   * `max_monthly_hours` is gone. 140 â‚¬ at 20 â‚¬/h is 7 hours, so the second
   * four-hour block is one hour too many.
   */
  it('the salary-derived cap binds, and the block past it is refused', () => {
    const r = plan(
      [
        dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00'),
        dayBlock('b', 'car-A', '2026-10-06', '08:00', '12:00'),
      ],
      [driver({ id: 'ali', minSalary: 20, maxSalary: 140, hourlyRate: 20 })],
    );
    expect(r.assignments).toHaveLength(1);
    expect(r.unassigned[0].refusals[0].refusal).toBe('exceeds_hours_cap');
  });

  it('the owner has no monthly ceiling (آ§8, آ§16)', () => {
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

describe('the derived check â€” the switch duration between vehicles', () => {
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

  it('needs no gap between consecutive blocks of the same vehicle beyond what آ§3 built', () => {
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

describe('rule 5 â€” mandatory inclusion affects the assignment (آ§16)', () => {
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
    // The conflicted day is then assigned normally â€” to sami.
    const day2 = r.assignments.find(a => a.reason !== 'mandatory_note');
    expect(day2?.driverId).toBe('sami');
  });
});

describe('آ§8 â€” the owner takes surplus only', () => {
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

  it('with no owner, an uncoverable block stays unassigned with the reasons listed (آ§8, آ§14)', () => {
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

  it('the owner respects overlap and exclusion like anyone (آ§7 rules 2 and 4)', () => {
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

describe('the optimisation â€” toward the salary range, and the tie-breakers', () => {
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

  it('planning priority decides an exact tie (آ§7: the deciding factor)', () => {
    const r = plan(
      [dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00')],
      [
        driver({ id: 'ali', planningPriority: 100 }),
        driver({ id: 'sami', planningPriority: 200 }),
      ],
    );
    expect(r.assignments[0].driverId).toBe('sami');
  });

  it('a non-covering driver is steered away from a colleagueâ€™s block, softly', () => {
    const r = plan(
      [trip({ id: 'a', vehicleId: 'car-A', startTime: '08:00', endTime: '12:00', originalDriverName: 'Sami' })],
      [
        driver({ id: 'ali', name: 'Ali', canCoverOtherDrivers: false }),
        driver({ id: 'omar', name: 'Omar' }),
      ],
    );
    expect(r.assignments[0].driverId).toBe('omar');
  });

  it('but still takes it when nobody else can â€” a preference, not a tenth hard rule', () => {
    const r = plan(
      [trip({ id: 'a', vehicleId: 'car-A', startTime: '08:00', endTime: '12:00', originalDriverName: 'Sami' })],
      [driver({ id: 'ali', name: 'Ali', canCoverOtherDrivers: false })],
    );
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0].driverId).toBe('ali');
  });
});

describe('regeneration (آ§7 rule 9, acceptance 14)', () => {
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
    // At least two distinct valid alternatives across six seeds â€” the button
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

describe('the driver states the summary screen reads (آ§1 screen 3)', () => {
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

// â”€â”€â”€ Regeneration as a search (owner, 01.10.2026) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// The block above tests regeneration on IDENTICAL TWINS, where every block is a
// genuine tie and the seeded tie-break alone moves the plan. That is why it
// passed while the owner reported the button as doing nothing, three times: on a
// real month the drivers have different salaries, so their scores never tie after
// the first block and the seed reached no decision at all.
//
// `searchAssignments` is the answer. It varies the ORDER blocks are offered to
// the greedy pass â€” a choice the requirement leaves open â€” scores each variant on
// figures the engine already computes, and keeps the best, with the plan on
// screen among the candidates so the answer is never worse than what it replaces.
//
// آ§7's nine hard rules are untouched: `refusalFor` is asked per (driver, block)
// pair whatever order the pairs arrive in. Every assertion below re-checks that.

describe('regeneration searches for a different plan (owner, 01.10.2026)', () => {
  /** A fortnight on two cars: enough blocks for the order to matter. */
  const fortnight = Array.from({ length: 14 }, (_, day) => [
    dayBlock(`a${day}`, 'car-A', `2026-10-${String(day + 5).padStart(2, '0')}`, '06:00', '14:00'),
    dayBlock(`b${day}`, 'car-B', `2026-10-${String(day + 5).padStart(2, '0')}`, '14:30', '22:00'),
  ]).flat();

  /**
   * Drivers who do NOT tie: three different salary ranges, so `scoreCandidate`
   * separates them on the first block and never produces an equal pair.
   */
  const distinct = [
    driver({ id: 'ali',   minSalary: 1950, maxSalary: 2100, hourlyRate: 14 }),
    driver({ id: 'sami',  minSalary: 1500, maxSalary: 1800, hourlyRate: 12 }),
    driver({ id: 'canan', minSalary: 2400, maxSalary: 2800, hourlyRate: 16 }),
  ];

  const built = () => {
    const { blocks } = buildBlocks(fortnight, { switchMinutes: 30 });
    const availability = buildAvailability([], blocks, new Set(distinct.map(d => d.id)));
    return { blocks, availability };
  };

  const fingerprint = (r: AssignResult) =>
    r.assignments.map(a => `${a.blockId}:${a.driverId}`).sort().join(',');

  it('the ordering does the work, not the tie-break â€” the control for this change', () => {
    // The first draft of this test asserted that `seeded_tie` NEVER fires on these
    // drivers. Measured, it fires once in 28 assignments: the scoring bands are
    // coarse enough that two different drivers can still land on the same figure.
    // So the control is not "no tie exists" but "the ties cannot account for the
    // difference" â€” which is the claim that matters, and it is far from marginal:
    // 24 of 28 blocks move between seed 0 and seed 1 against one single tie.
    const { blocks, availability } = built();
    const withSeed = (seed: number) =>
      assignBlocks(blocks, distinct, availability, { switchMinutes: 30, seed });

    const base = withSeed(0);
    const next = withSeed(1);
    const held = new Map(base.assignments.map(a => [a.blockId, a.driverId]));
    const moved = next.assignments.filter(a => held.get(a.blockId) !== a.driverId).length;
    const ties = base.assignments.filter(a => a.reason === 'seeded_tie').length
               + next.assignments.filter(a => a.reason === 'seeded_tie').length;

    expect(moved).toBeGreaterThan(ties);
    expect(moved).toBeGreaterThan(base.assignments.length / 2);
  });

  it('every seed gives a plan of the same quality â€” they are alternatives, not gambles', () => {
    // Measured: eight seeds, eight distinct plans, one quality. That is why the
    // search can always offer a different arrangement without trading anything
    // away, and it is the property the screen's wording rests on.
    const { blocks, availability } = built();
    const qualities = [0, 1, 2, 3, 4, 5, 6, 7].map(seed =>
      planQuality(assignBlocks(blocks, distinct, availability, { switchMinutes: 30, seed })));
    for (const quality of qualities) {
      expect(comparePlanQuality(quality, qualities[0])).toBe(0);
    }
  });

  it('finds a genuinely different plan, and every variant obeys every hard rule', () => {
    const { blocks, availability } = built();
    const first = assignBlocks(blocks, distinct, availability, { switchMinutes: 30, seed: 0 });

    const found = searchAssignments(blocks, distinct, availability, {
      switchMinutes: 30,
      current: { seed: 0, result: first },
    });

    expect(found.differs).toBe(true);
    expect(fingerprint(found.result)).not.toBe(fingerprint(first));

    // And it is a legal plan, not merely a different one.
    expect(found.result.pinConflicts).toHaveLength(0);
    for (const state of found.result.driverStates) {
      if (!state.driver.isOwner && state.range.effectiveMaxHours != null) {
        expect(state.minutes).toBeLessThanOrEqual(state.range.effectiveMaxHours * 60);
      }
    }
    // No driver holds two blocks at once â€” rule 2, re-checked on the result.
    for (const state of found.result.driverStates) {
      const held = state.assignedBlockIds
        .map(id => blocks.find(b => b.id === id)!)
        .sort((x, y) => x.startMs - y.startMs);
      for (let i = 1; i < held.length; i++) {
        expect(held[i].startMs).toBeGreaterThanOrEqual(held[i - 1].endMs);
      }
    }
  });

  it('never returns a plan worse than the one on screen', () => {
    const { blocks, availability } = built();
    const current = assignBlocks(blocks, distinct, availability, { switchMinutes: 30, seed: 0 });
    const before = planQuality(current);

    // Repeated, because the guarantee is about every reachable seed and not about
    // one lucky draw: each call starts from the previous winner's seed.
    let plan = { seed: 0, result: current };
    for (let round = 0; round < 5; round++) {
      const found = searchAssignments(blocks, distinct, availability, {
        switchMinutes: 30, current: plan,
      });
      expect(comparePlanQuality(found.quality, before)).toBeLessThanOrEqual(0);
      plan = { seed: found.seed, result: found.result };
    }
  });

  it('reports differs: false rather than pretending, when only one plan exists', () => {
    // One block, one driver: there is nothing to vary, and saying so is the honest
    // answer. A button that reports nothing is what looked broken in the first
    // place, so this case must be distinguishable from a failure.
    const { blocks } = buildBlocks(
      [dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00')],
      { switchMinutes: 30 },
    );
    const only = [driver({ id: 'ali' })];
    const availability = buildAvailability([], blocks, new Set(['ali']));
    const current = assignBlocks(blocks, only, availability, { switchMinutes: 30, seed: 0 });

    const found = searchAssignments(blocks, only, availability, {
      switchMinutes: 30, current: { seed: 0, result: current },
    });
    expect(found.differs).toBe(false);
    expect(found.result.assignments).toEqual(current.assignments);
    expect(found.tried).toBeGreaterThan(1);
  });

  it('the search never overrides a pin', () => {
    const { blocks } = buildBlocks(fortnight, { switchMinutes: 30 });
    const availability = buildAvailability(
      [note({
        driver_id: 'canan',
        note_planning_behavior: 'must_include_in_plan',
        start_date: '2026-10-07', end_date: '2026-10-07',
        start_time: '06:30', end_time: '06:40',
      })],
      blocks,
      new Set(distinct.map(d => d.id)),
    );
    const found = searchAssignments(blocks, distinct, availability, { switchMinutes: 30 });
    const pinned = found.result.assignments.find(a => a.reason === 'mandatory_note');
    expect(pinned?.driverId).toBe('canan');
  });

  it('seed 0 is still strictly chronological', () => {
    // The order at seed 0 must not move, or every month\u2019s first plan changes. A
    // driver capped at one block takes the EARLIEST one, which is observable.
    const { blocks } = buildBlocks(
      [
        dayBlock('late',  'car-A', '2026-10-20', '06:00', '14:00'),
        dayBlock('early', 'car-A', '2026-10-05', '06:00', '14:00'),
      ],
      { switchMinutes: 30 },
    );
    // 120 â‚¬ at 15 â‚¬/h is 8 hours: exactly one of these two blocks.
    const capped = [driver({ id: 'ali', minSalary: 60, maxSalary: 120, hourlyRate: 15 })];
    const availability = buildAvailability([], blocks, new Set(['ali']));
    const r = assignBlocks(blocks, capped, availability, { switchMinutes: 30, seed: 0 });
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0].blockId).toBe(blocks.find(b => b.startMs === Math.min(...blocks.map(x => x.startMs)))!.id);
  });

  it('the same seed still reproduces the identical plan, order and all', () => {
    const { blocks, availability } = built();
    const a = assignBlocks(blocks, distinct, availability, { switchMinutes: 30, seed: 9 });
    const b = assignBlocks(blocks, distinct, availability, { switchMinutes: 30, seed: 9 });
    expect(fingerprint(b)).toBe(fingerprint(a));
  });
});

// â”€â”€â”€ Unlimited retry (owner, 01.10.2026, the second report on this button) â”€â”€â”€â”€
//
// He pressed "Neu verteilen" a second time and was told "Nothing changed â€” and
// that is the correct answer. 13 variants examined." He asked for unlimited
// retries.
//
// The cause was NOT a small search space â€” measured on a sparse month of 16
// blocks, 39 distinct plans over 61 seeds. It was the ranking: quality first,
// with the plan on screen among the candidates, so once a press landed on a local
// optimum every later press correctly kept it. "Never worse than what it
// replaces" had become "never anything else".
//
// Both halves have to hold, so the answer has three states, and these pin them.

describe('regeneration always offers another plan, and names what it costs', () => {
  /** A month shaped like the owner's: sparse, with days far apart. */
  const sparse = [
    dayBlock('a', 'car-A', '2026-10-05', '08:00', '14:00'),
    dayBlock('b', 'car-B', '2026-10-05', '09:00', '12:00'),
    dayBlock('c', 'car-A', '2026-10-07', '06:00', '14:00'),
    dayBlock('d', 'car-B', '2026-10-09', '14:00', '20:00'),
    dayBlock('e', 'car-A', '2026-10-12', '06:00', '12:00'),
    dayBlock('f', 'car-B', '2026-10-14', '10:00', '18:00'),
    dayBlock('g', 'car-A', '2026-10-16', '07:00', '15:00'),
    dayBlock('h', 'car-B', '2026-10-19', '08:00', '16:00'),
  ];
  const three = [
    driver({ id: 'ali',   minSalary: 1950, maxSalary: 2100, hourlyRate: 14 }),
    driver({ id: 'sami',  minSalary: 1200, maxSalary: 1500, hourlyRate: 16 }),
    driver({ id: 'canan', minSalary: 1700, maxSalary: 2400, hourlyRate: 15 }),
  ];

  const prepared = () => {
    const { blocks } = buildBlocks(sparse, { switchMinutes: 30 });
    const availability = buildAvailability([], blocks, new Set(three.map(d => d.id)));
    return { blocks, availability };
  };

  const fingerprint = (r: AssignResult) =>
    r.assignments.map(a => `${a.blockId}:${a.driverId}`).sort().join(',');

  it('ten presses in a row each produce a different distribution', () => {
    // The owner's words were "unlimited retry". Ten is not unlimited, but a run
    // that never repeats its predecessor ten times over is the property he asked
    // for, and a dead end would show on the second.
    const { blocks, availability } = prepared();
    let plan = {
      seed: 0,
      result: assignBlocks(blocks, three, availability, { switchMinutes: 30, seed: 0 }),
    };

    for (let press = 1; press <= 10; press++) {
      const found = searchAssignments(blocks, three, availability, {
        switchMinutes: 30, current: plan,
      });
      expect(found.differs, `press ${press} returned the same plan`).toBe(true);
      expect(fingerprint(found.result), `press ${press} did not move`)
        .not.toBe(fingerprint(plan.result));
      plan = { seed: found.seed, result: found.result };
    }
  });

  it('a worse alternative is offered, and its cost is named rather than hidden', () => {
    // Walk until a press has to trade something away, then check the trade is
    // reported. On a month with this many equally good arrangements it may not
    // happen at all, which is itself fine â€” what must never happen is a worse
    // plan with `cost: null`.
    const { blocks, availability } = prepared();
    let plan = {
      seed: 0,
      result: assignBlocks(blocks, three, availability, { switchMinutes: 30, seed: 0 }),
    };

    for (let press = 1; press <= 12; press++) {
      const before = planQuality(plan.result);
      const found = searchAssignments(blocks, three, availability, {
        switchMinutes: 30, current: plan,
      });
      const worse = comparePlanQuality(found.quality, before) > 0;
      expect(worse ? found.cost !== null : true,
        `press ${press} returned a worse plan with no cost reported`).toBe(true);
      if (found.cost) {
        expect(found.cost.by, 'a reported cost is a real one').toBeGreaterThan(0);
        expect(worse, 'a cost is only reported for a plan that is actually worse').toBe(true);
      }
      plan = { seed: found.seed, result: found.result };
    }
  });

  it('differs: false now means there is genuinely no other plan', () => {
    // One block, one driver. Nothing can vary, and that is the one case where the
    // screen may say the constraints allow a single distribution.
    const { blocks } = buildBlocks(
      [dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00')],
      { switchMinutes: 30 },
    );
    const only = [driver({ id: 'ali' })];
    const availability = buildAvailability([], blocks, new Set(['ali']));
    const current = assignBlocks(blocks, only, availability, { switchMinutes: 30, seed: 0 });

    const found = searchAssignments(blocks, only, availability, {
      switchMinutes: 30, current: { seed: 0, result: current },
    });
    expect(found.differs).toBe(false);
    expect(found.cost, 'a plan that did not move costs nothing').toBeNull();
  });

  it('qualityDelta names the first figure that moved, and nothing when none did', () => {
    const base = {
      unassigned: 0, pinConflicts: 0, withoutHours: 0,
      belowMinimum: 2, shortfallHours: 10, excessHours: 0,
    };
    expect(qualityDelta(base, base)).toBeNull();
    expect(qualityDelta(base, { ...base, unassigned: 1 }))
      .toEqual({ field: 'unassigned', by: 1 });
    // Read in order, so the more serious figure wins when two moved.
    expect(qualityDelta(base, { ...base, unassigned: 1, shortfallHours: 99 }))
      .toEqual({ field: 'unassigned', by: 1 });
    // Hours below a tenth are float noise, not a difference.
    expect(qualityDelta(base, { ...base, shortfallHours: 10.05 })).toBeNull();
    expect(qualityDelta(base, { ...base, shortfallHours: 10.5 }))
      .toEqual({ field: 'shortfallHours', by: 0.5 });
  });
});

// â”€â”€â”€ The owner takes what a driver has already earned past their minimum â”€â”€â”€â”€â”€
//
// The owner's request of 03.10.2026, in his words: *"we need to move blocks to
// the owner as many as possible so each driver will have a bit more than the
// min-hours and the owner will have the rest"*.
//
// This is a deliberate change to آ§8, which as written makes the owner a last
// resort â€” "no early use, surplus only". `ownerTakesSurplus` turns that into
// "the owner goes first, once every regular has earned their minimum", and it is
// off by default so آ§8's shape is what every other caller still gets.
//
// **What it does NOT do, and the tests below pin it:** no block's time moves. A
// block that collides with the owner's own work stays unassigned, because the
// alternative â€” shifting it to a window where the owner happens to be free â€”
// would have the Fahrtenbuch state that a journey happened at a time it did not.
// That boundary is this module's own (see the header) and the owner set it on
// 22.09.2026.

describe('ownerTakesSurplus â€” the owner absorbs the surplus (owner, 03.10.2026)', () => {
  /** A month of one-a-day four-hour blocks on one car. */
  const days = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      dayBlock(`d${i}`, 'car-A', `2026-10-${String(5 + i).padStart(2, '0')}`, '08:00', '12:00'));

  const planWith = (
    trips: PlanTripInput[],
    drivers: PlanDriverInput[],
    ownerTakesSurplus: boolean,
  ): AssignResult => {
    const { blocks } = buildBlocks(trips, { switchMinutes: 30 });
    const availability = buildAvailability(notes([]), blocks, new Set(drivers.map(d => d.id)));
    return assignBlocks(blocks, drivers, availability, {
      switchMinutes: 30, seed: 0, ownerTakesSurplus,
    });
  };
  const notes = (n: PlanNote[]) => n;

  it('is off by default, so آ§8 keeps its shape for every existing caller', () => {
    // 10 â‚¬ min / 10 â‚¬/h â†’ a 1-hour minimum, so one block already earns it. With
    // the option off the regular keeps taking blocks and the owner gets none.
    const r = planWith(
      days(4),
      [
        driver({ id: 'ali', minSalary: 10, maxSalary: 10_000, hourlyRate: 10 }),
        driver({ id: 'chef', isOwner: true, minSalary: null, maxSalary: null, hourlyRate: 10 }),
      ],
      false,
    );
    expect(r.assignments.every(a => a.driverId === 'ali')).toBe(true);
    expect(r.assignments.some(a => a.reason === 'owner_surplus')).toBe(false);
  });

  it('hands the owner every block past the minimum, and names the reason', () => {
    const r = planWith(
      days(4),
      [
        driver({ id: 'ali', minSalary: 10, maxSalary: 10_000, hourlyRate: 10 }),
        driver({ id: 'chef', isOwner: true, minSalary: null, maxSalary: null, hourlyRate: 10 }),
      ],
      true,
    );
    // The length first, and deliberately: `slice(1).every(â€¦)` is **vacuously
    // true** on a one-element array, so without this the two assertions under it
    // would pass on a plan that placed a single block and gave up.
    expect(r.assignments).toHaveLength(4);
    // The first block earns Ali his 1-hour minimum and the 60-minute margin over
    // it in one go; from the second on, the owner takes them.
    expect(r.assignments[0].driverId).toBe('ali');
    expect(r.assignments.slice(1).every(a => a.driverId === 'chef')).toBe(true);
    expect(r.assignments.slice(1).every(a => a.reason === 'owner_surplus')).toBe(true);
    expect(r.unassigned).toHaveLength(0);
  });

  it('a driver still reaches their own minimum first â€” the owner does not starve them', () => {
    // 350 â‚¬ at 14 â‚¬/h = 25 h. Four 4-hour blocks is 16 h, under it throughout, so
    // the owner must take nothing at all.
    const r = planWith(
      days(4),
      [
        driver({ id: 'ali', minSalary: 350, maxSalary: 2100, hourlyRate: 14 }),
        driver({ id: 'chef', isOwner: true, minSalary: null, maxSalary: null, hourlyRate: 14 }),
      ],
      true,
    );
    expect(r.assignments.every(a => a.driverId === 'ali')).toBe(true);
  });

  it('a driver with no usable range is never displaced', () => {
    // آ§5: no salary and no rate means no range, so there is no minimum they could
    // have earned â€” and the owner must not take their work on a technicality.
    const r = planWith(
      days(3),
      [
        driver({ id: 'ali', minSalary: null, maxSalary: null, hourlyRate: null }),
        driver({ id: 'chef', isOwner: true, minSalary: null, maxSalary: null, hourlyRate: 10 }),
      ],
      true,
    );
    expect(r.assignments.some(a => a.reason === 'owner_surplus')).toBe(false);
  });

  it('NO block moves in time: a block colliding with the owner stays unassigned', () => {
    // The rule the whole feature rests on. Ali is past his minimum, so the owner
    // is offered the second block â€” but the owner already holds a block across
    // the same hours on another car, and nothing may shift to make room.
    const trips = [
      dayBlock('early', 'car-A', '2026-10-05', '08:00', '12:00'),
      dayBlock('mine', 'car-B', '2026-10-06', '08:00', '12:00'),
      dayBlock('clash', 'car-C', '2026-10-06', '09:00', '13:00'),
    ];
    const r = planWith(
      trips,
      [
        driver({ id: 'ali', minSalary: 10, maxSalary: 60, hourlyRate: 10 }),
        driver({ id: 'chef', isOwner: true, minSalary: null, maxSalary: null, hourlyRate: 10 }),
      ],
      true,
    );
    const all = [...r.assignments.map(a => a.blockId), ...r.unassigned.map(u => u.blockId)];
    // Every block is accounted for, and the colliding one was not quietly re-timed.
    expect(new Set(all).size).toBe(3);
    const clash = r.assignments.find(a => a.blockId.includes('car-C'));
    const unassignedClash = r.unassigned.find(u => u.blockId.includes('car-C'));
    expect(Boolean(clash) !== Boolean(unassignedClash)).toBe(true);
  });

  it('the owner is still the last resort when nobody has earned anything', () => {
    // آ§8's original branch has to survive: with the option ON and the only
    // regular excluded by a note, the owner takes it as `owner_fallback`, not as
    // `owner_surplus` â€” the two reasons must stay distinguishable.
    const blocksOnly = [dayBlock('a', 'car-A', '2026-10-05', '08:00', '12:00')];
    const drivers = [
      driver({ id: 'ali' }),
      driver({ id: 'chef', isOwner: true, minSalary: null, maxSalary: null, hourlyRate: 14 }),
    ];
    const { blocks } = buildBlocks(blocksOnly, { switchMinutes: 30 });
    const availability = buildAvailability(
      [note({ driver_id: 'ali', is_full_day: true })], blocks, new Set(drivers.map(d => d.id)));
    const r = assignBlocks(blocks, drivers, availability, {
      switchMinutes: 30, seed: 0, ownerTakesSurplus: true,
    });
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0].driverId).toBe('chef');
    expect(r.assignments[0].reason).toBe('owner_fallback');
  });
});
