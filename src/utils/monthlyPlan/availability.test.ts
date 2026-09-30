import { describe, it, expect } from 'vitest';
import { buildAvailability, findExclusion, type PlanNote } from './availability';
import { buildBlocks, type PlanTripInput } from './blocks';

/**
 * Requirement §6 (exclusion, mandatory inclusion, and their conflict) and the
 * two §14 cases that involve notes: a mandatory claim contested between two
 * drivers, and a driver excluded for the whole month.
 *
 * The note→window arithmetic itself is `noteExclusionIntervals`, reused from
 * `driverNoteValidation.ts` and already covered there; these tests are about
 * what this module builds on top of it.
 *
 * TZ is pinned to Europe/Berlin by vitest.config.ts.
 */

let noteSeq = 0;
function note(p: Partial<PlanNote>): PlanNote {
  noteSeq += 1;
  return {
    id: p.id ?? `n${String(noteSeq).padStart(3, '0')}`,
    driver_id: p.driver_id ?? 'ali',
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

/** One block per call site: 2026-10-05, car per arg. */
function monthBlocks() {
  // car-A: 08:00–12:00 and 14:00–18:00; car-B: 09:00–13:00. 60-minute switch.
  return buildBlocks(
    [
      trip({ id: 'a1', vehicleId: 'car-A', startTime: '08:00', endTime: '12:00' }),
      trip({ id: 'a2', vehicleId: 'car-A', startTime: '14:00', endTime: '18:00' }),
      trip({ id: 'b1', vehicleId: 'car-B', startTime: '09:00', endTime: '13:00' }),
    ],
    { switchMinutes: 60 },
  ).blocks;
}

const POOL = new Set(['ali', 'sami', 'omar']);

describe('exclusion (§6, §7 rule 4)', () => {
  it('an illness note blocks the overlapping window and nothing else', () => {
    const blocks = monthBlocks();
    const av = buildAvailability(
      [note({ driver_id: 'ali', note_type: 'sick', start_time: '08:00', end_time: '13:00' })],
      blocks,
      POOL,
    );
    const dayStart = new Date(2026, 9, 5, 8, 0).getTime();
    const dayEnd = new Date(2026, 9, 5, 12, 0).getTime();
    expect(findExclusion(av, 'ali', dayStart, dayEnd)).not.toBeNull();
    // The afternoon block is outside the note's window.
    const pmStart = new Date(2026, 9, 5, 14, 0).getTime();
    const pmEnd = new Date(2026, 9, 5, 18, 0).getTime();
    expect(findExclusion(av, 'ali', pmStart, pmEnd)).toBeNull();
    // And another driver is untouched.
    expect(findExclusion(av, 'sami', dayStart, dayEnd)).toBeNull();
  });

  it('a full-day note covers the whole calendar day', () => {
    const av = buildAvailability(
      [note({ driver_id: 'ali', is_full_day: true })],
      monthBlocks(),
      POOL,
    );
    expect(findExclusion(
      av, 'ali',
      new Date(2026, 9, 5, 23, 0).getTime(),
      new Date(2026, 9, 5, 23, 30).getTime(),
    )).not.toBeNull();
    // The next day is free.
    expect(findExclusion(
      av, 'ali',
      new Date(2026, 9, 6, 8, 0).getTime(),
      new Date(2026, 9, 6, 9, 0).getTime(),
    )).toBeNull();
  });

  it('a month-long exclusion (§14) blocks every block of the month', () => {
    const blocks = monthBlocks();
    const av = buildAvailability(
      [note({ driver_id: 'ali', is_full_day: true, start_date: '2026-10-01', end_date: '2026-10-31' })],
      blocks,
      POOL,
    );
    for (const b of blocks) {
      expect(findExclusion(av, 'ali', b.startMs, b.endMs)).not.toBeNull();
    }
  });

  it('neutral notes have no effect at all', () => {
    const av = buildAvailability(
      [note({ driver_id: 'ali', note_type: 'general', note_planning_behavior: 'neutral', is_full_day: true })],
      monthBlocks(),
      POOL,
    );
    expect(av.byDriver.size).toBe(0);
    expect(av.pins).toHaveLength(0);
  });
});

describe('mandatory inclusion (§6)', () => {
  it('pins the block containing the event time to the note’s driver', () => {
    const av = buildAvailability(
      [note({
        driver_id: 'ali',
        note_type: 'kontrolle',
        note_planning_behavior: 'must_include_in_plan',
        start_time: '15:00',
        end_time: '15:30',
      })],
      monthBlocks(),
      POOL,
    );
    // 15:00 falls in car-A's afternoon block only.
    expect(av.pins).toHaveLength(1);
    expect(av.pins[0].driverId).toBe('ali');
    expect(av.pins[0].blockId).toMatch(/^car-A\|/);
    expect(av.unmet).toHaveLength(0);
  });

  it('reports an event with no matching block as unmet — no phantom hours', () => {
    const av = buildAvailability(
      [note({
        driver_id: 'ali',
        note_type: 'blitzer',
        note_planning_behavior: 'must_include_in_plan',
        start_time: '22:00',
        end_time: '22:15', // nothing drives at 22:00
      })],
      monthBlocks(),
      POOL,
    );
    expect(av.pins).toHaveLength(0);
    expect(av.unmet).toEqual([
      expect.objectContaining({ reason: 'no_matching_block' }),
    ]);
  });

  it('an event overlapping two vehicles with no car on the note is ambiguous, not guessed', () => {
    const av = buildAvailability(
      [note({
        driver_id: 'ali',
        note_type: 'kontrolle',
        note_planning_behavior: 'must_include_in_plan',
        start_time: '10:00',
        end_time: '10:30', // inside car-A 08–12 AND car-B 09–13
      })],
      monthBlocks(),
      POOL,
    );
    expect(av.pins).toHaveLength(0);
    const u = av.unmet[0];
    expect(u.reason).toBe('ambiguous_vehicles');
    expect(u.blockIds).toHaveLength(2);
  });

  it('the note’s car resolves the ambiguity — the first read car_id ever gets', () => {
    const av = buildAvailability(
      [note({
        driver_id: 'ali',
        note_type: 'kontrolle',
        note_planning_behavior: 'must_include_in_plan',
        start_time: '10:00',
        end_time: '10:30',
        car_id: 'car-B',
      })],
      monthBlocks(),
      POOL,
    );
    expect(av.unmet).toHaveLength(0);
    expect(av.pins).toHaveLength(1);
    expect(av.pins[0].blockId).toMatch(/^car-B\|/);
  });

  it('a car that has no overlapping block makes the claim unmet, not widened back', () => {
    const av = buildAvailability(
      [note({
        driver_id: 'ali',
        note_planning_behavior: 'must_include_in_plan',
        start_time: '10:00',
        end_time: '10:30',
        car_id: 'car-Z', // exists on no block
      })],
      monthBlocks(),
      POOL,
    );
    expect(av.pins).toHaveLength(0);
    expect(av.unmet[0].reason).toBe('no_matching_block');
  });

  it('a period note claims every overlapping block of one vehicle', () => {
    const av = buildAvailability(
      [note({
        driver_id: 'ali',
        note_type: 'wait',
        note_planning_behavior: 'must_include_in_plan',
        start_time: '08:00',
        end_time: '18:00',
        car_id: 'car-A',
      })],
      monthBlocks(),
      POOL,
    );
    // Both car-A blocks; same-vehicle blocks never overlap, so both are legal.
    expect(av.pins).toHaveLength(2);
    expect(av.pins.every(p => p.driverId === 'ali')).toBe(true);
  });

  it('a note for a driver outside the pool is unmet, per §7 rule 8', () => {
    const av = buildAvailability(
      [note({
        driver_id: 'ghost',
        note_planning_behavior: 'must_include_in_plan',
        start_time: '15:00',
        end_time: '15:30',
      })],
      monthBlocks(),
      POOL,
    );
    expect(av.pins).toHaveLength(0);
    expect(av.unmet[0].reason).toBe('driver_not_selected');
  });

  it('two notes of one driver on one block yield one pin, both satisfied', () => {
    const av = buildAvailability(
      [
        note({ id: 'n-a', driver_id: 'ali', note_planning_behavior: 'must_include_in_plan', start_time: '15:00', end_time: '15:15' }),
        note({ id: 'n-b', driver_id: 'ali', note_planning_behavior: 'must_include_in_plan', start_time: '16:00', end_time: '16:15' }),
      ],
      monthBlocks(),
      POOL,
    );
    expect(av.pins).toHaveLength(1);
    expect(av.unmet).toHaveLength(0);
    expect(av.conflicts).toHaveLength(0);
  });
});

describe('the two conflicts that must never be silent', () => {
  it('§6: exclusion and mandatory inclusion for one driver and one time', () => {
    const av = buildAvailability(
      [
        note({ id: 'n-sick', driver_id: 'ali', note_type: 'sick', is_full_day: true }),
        note({ id: 'n-kontrolle', driver_id: 'ali', note_type: 'kontrolle', note_planning_behavior: 'must_include_in_plan', start_time: '15:00', end_time: '15:30' }),
      ],
      monthBlocks(),
      POOL,
    );
    expect(av.conflicts).toEqual([
      expect.objectContaining({
        kind: 'exclusion_overlaps_inclusion',
        driverId: 'ali',
        exclusionNoteId: 'n-sick',
        inclusionNoteId: 'n-kontrolle',
      }),
    ]);
    // Neither side wins: no pin, and the inclusion is listed as unmet.
    expect(av.pins).toHaveLength(0);
    expect(av.unmet[0].reason).toBe('conflicts_with_exclusion');
  });

  it('does not report a conflict when the two notes do not overlap in time', () => {
    const av = buildAvailability(
      [
        note({ id: 'n-sick', driver_id: 'ali', start_time: '08:00', end_time: '12:00' }),
        note({ id: 'n-kontrolle', driver_id: 'ali', note_planning_behavior: 'must_include_in_plan', start_time: '15:00', end_time: '15:30' }),
      ],
      monthBlocks(),
      POOL,
    );
    expect(av.conflicts).toHaveLength(0);
    expect(av.pins).toHaveLength(1); // the afternoon pin stands
  });

  it('an exclusion for one driver never blocks another driver’s inclusion', () => {
    const av = buildAvailability(
      [
        note({ id: 'n-sick', driver_id: 'sami', is_full_day: true }),
        note({ id: 'n-kontrolle', driver_id: 'ali', note_planning_behavior: 'must_include_in_plan', start_time: '15:00', end_time: '15:30' }),
      ],
      monthBlocks(),
      POOL,
    );
    expect(av.conflicts).toHaveLength(0);
    expect(av.pins).toHaveLength(1);
  });

  it('§14: mandatory claims by two drivers on one block contest it, and neither wins', () => {
    const av = buildAvailability(
      [
        note({ id: 'n-ali', driver_id: 'ali', note_planning_behavior: 'must_include_in_plan', start_time: '15:00', end_time: '15:30' }),
        note({ id: 'n-sami', driver_id: 'sami', note_planning_behavior: 'must_include_in_plan', start_time: '16:00', end_time: '16:30' }),
      ],
      monthBlocks(),
      POOL,
    );
    const contested = av.conflicts.find(c => c.kind === 'block_contested');
    expect(contested).toBeDefined();
    expect((contested as { driverIds: string[] }).driverIds).toEqual(['ali', 'sami']);
    expect(av.pins).toHaveLength(0);
    expect(av.unmet.map(u => u.reason)).toEqual(['block_contested', 'block_contested']);
  });
});

describe('determinism', () => {
  it('note order does not change the result', () => {
    const notes = [
      note({ id: 'n-1', driver_id: 'ali', note_planning_behavior: 'must_include_in_plan', start_time: '15:00', end_time: '15:30' }),
      note({ id: 'n-2', driver_id: 'sami', start_time: '08:00', end_time: '12:00' }),
      note({ id: 'n-3', driver_id: 'omar', note_planning_behavior: 'must_include_in_plan', start_time: '09:30', end_time: '09:45', car_id: 'car-B' }),
    ];
    const blocks = monthBlocks();
    const forward = buildAvailability(notes, blocks, POOL);
    const reversed = buildAvailability([...notes].reverse(), blocks, POOL);
    expect(reversed.pins).toEqual(forward.pins);
    expect(reversed.unmet).toEqual(forward.unmet);
    expect(reversed.conflicts).toEqual(forward.conflicts);
  });
});
