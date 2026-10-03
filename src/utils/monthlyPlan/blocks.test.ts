import { describe, it, expect } from 'vitest';
import {
  buildBlocks,
  minutesToDecimalHours,
  type PlanTripInput,
} from './blocks';

/**
 * The cases here are requirement §16's, written out literally:
 *
 *   - a gap shorter than the switch duration keeps the rides in one block
 *   - a gap equal to or longer than it permits a split
 *   - different vehicles never mix
 *   - 08:23 → 09:44 = 81 minutes = 1.35 hours
 *
 * plus §14's edge cases for rides.
 *
 * `vitest.config.ts` pins TZ=Europe/Berlin, so the local-midnight arithmetic
 * these tests exercise means the same thing here as it does in production.
 */

let seq = 0;
function trip(p: Partial<PlanTripInput> & { startTime?: string; endTime?: string }): PlanTripInput {
  seq += 1;
  // `in` rather than `??` for the nullable fields: a test that passes
  // `vehicleId: null` on purpose means null, and `?? 'car-A'` would hand the
  // default straight back and make the assertion test nothing.
  return {
    id: p.id ?? `t${seq}`,
    vehicleId: 'vehicleId' in p ? p.vehicleId! : 'car-A',
    vehicleIdentifier: 'vehicleIdentifier' in p ? p.vehicleIdentifier! : 'B-AA-1',
    tripDate: p.tripDate ?? '2026-10-05',
    startTime: p.startTime,
    endTime: p.endTime,
    startAt: p.startAt,
    endAt: p.endAt,
    isCanceled: p.isCanceled,
    originalDriverName: p.originalDriverName,
    originalDriverId: p.originalDriverId,
  };
}

describe('buildBlocks — §3 and §16: the switch duration decides the boundary', () => {
  it('a gap shorter than the switch duration keeps two rides in one block', () => {
    const r = buildBlocks(
      [
        trip({ id: 'a', startTime: '08:00', endTime: '09:00' }),
        trip({ id: 'b', startTime: '09:20', endTime: '10:00' }), // 20-minute gap
      ],
      { switchMinutes: 30 },
    );
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].trips.map(t => t.tripId)).toEqual(['a', 'b']);
  });

  it('a gap equal to the switch duration permits a split', () => {
    const r = buildBlocks(
      [
        trip({ id: 'a', startTime: '08:00', endTime: '09:00' }),
        trip({ id: 'b', startTime: '09:30', endTime: '10:00' }), // exactly 30
      ],
      { switchMinutes: 30 },
    );
    expect(r.blocks).toHaveLength(2);
  });

  it('a gap longer than the switch duration splits', () => {
    const r = buildBlocks(
      [
        trip({ id: 'a', startTime: '08:00', endTime: '09:00' }),
        trip({ id: 'b', startTime: '11:00', endTime: '12:00' }),
      ],
      { switchMinutes: 30 },
    );
    expect(r.blocks).toHaveLength(2);
  });

  it('the boundary moves with the operator’s value, and only with it', () => {
    const rides = [
      trip({ id: 'a', startTime: '08:00', endTime: '09:00' }),
      trip({ id: 'b', startTime: '09:45', endTime: '10:30' }), // 45-minute gap
    ];
    // This is the property the existing pipeline loses: `monatsplanungPhase1`
    // splits on its own 60-minute separator and never reads the buffer at all,
    // and `monatsplanungRepairPass` discards the operator's value outright.
    expect(buildBlocks(rides, { switchMinutes: 30 }).blocks).toHaveLength(2);
    expect(buildBlocks(rides, { switchMinutes: 60 }).blocks).toHaveLength(1);
  });

  it('a switch duration of 0 splits at every gap', () => {
    const r = buildBlocks(
      [
        trip({ id: 'a', startTime: '08:00', endTime: '09:00' }),
        trip({ id: 'b', startTime: '09:00', endTime: '10:00' }), // zero gap
        trip({ id: 'c', startTime: '10:01', endTime: '11:00' }),
      ],
      { switchMinutes: 0 },
    );
    // 0 means "split wherever allowed", and a gap of 0 is >= 0.
    expect(r.blocks).toHaveLength(3);
  });

  it('back-to-back rides stay together when the switch duration is positive', () => {
    const r = buildBlocks(
      [
        trip({ id: 'a', startTime: '08:00', endTime: '09:00' }),
        trip({ id: 'b', startTime: '09:00', endTime: '10:00' }),
      ],
      { switchMinutes: 30 },
    );
    expect(r.blocks).toHaveLength(1);
  });

  it('makes blocks as short as §3 allows, not as long as possible', () => {
    // Three rides, two splittable gaps: the answer is three blocks, not one.
    const r = buildBlocks(
      [
        trip({ id: 'a', startTime: '06:00', endTime: '07:00' }),
        trip({ id: 'b', startTime: '10:00', endTime: '11:00' }),
        trip({ id: 'c', startTime: '15:00', endTime: '16:00' }),
      ],
      { switchMinutes: 30 },
    );
    expect(r.blocks).toHaveLength(3);
  });
});

describe('buildBlocks — vehicles never mix (§3, acceptance 7)', () => {
  it('two vehicles produce two blocks even when their rides interleave', () => {
    const r = buildBlocks(
      [
        trip({ id: 'a1', vehicleId: 'car-A', startTime: '08:00', endTime: '09:00' }),
        trip({ id: 'b1', vehicleId: 'car-B', startTime: '08:10', endTime: '09:10' }),
        trip({ id: 'a2', vehicleId: 'car-A', startTime: '09:05', endTime: '10:00' }),
      ],
      { switchMinutes: 30 },
    );
    expect(r.blocks).toHaveLength(2);
    const byVehicle = new Map(r.blocks.map(b => [b.vehicleId, b]));
    expect(byVehicle.get('car-A')!.trips.map(t => t.tripId)).toEqual(['a1', 'a2']);
    expect(byVehicle.get('car-B')!.trips.map(t => t.tripId)).toEqual(['b1']);
  });

  it('no block ever holds rides of two vehicles', () => {
    const rides: PlanTripInput[] = [];
    // Hours 4..23, so every clock value is valid. An earlier version of this
    // loop ran to 25:00 and the builder rejected those two rides — correctly,
    // since an hour above 23 is unreadable and must not become midnight.
    for (let i = 0; i < 20; i++) {
      rides.push(trip({
        id: `x${i}`,
        vehicleId: `car-${i % 3}`,
        startTime: `${String(4 + i).padStart(2, '0')}:00`,
        endTime: `${String(4 + i).padStart(2, '0')}:30`,
      }));
    }
    const r = buildBlocks(rides, { switchMinutes: 90 });
    for (const b of r.blocks) {
      expect(b.trips.length).toBeGreaterThan(0);
      expect(b.vehicleId).toBeTruthy();
    }
    // Reconstruct the mapping and check it is a partition by vehicle.
    const seen = new Map<string, string>();
    for (const b of r.blocks) {
      for (const t of b.trips) {
        expect(seen.has(t.tripId)).toBe(false); // no ride in two blocks
        seen.set(t.tripId, b.vehicleId);
      }
    }
    expect(seen.size).toBe(20);
  });

  it('falls back to the plate when car_id is absent', () => {
    const r = buildBlocks(
      [trip({ id: 'a', vehicleId: null, vehicleIdentifier: 'B-ZZ-9', startTime: '08:00', endTime: '09:00' })],
      { switchMinutes: 30 },
    );
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].vehicleId).toBe('B-ZZ-9');
  });
});

describe('buildBlocks — minutes, and the figure §16 pins', () => {
  it('08:23 to 09:44 is 81 minutes', () => {
    const r = buildBlocks(
      [trip({ id: 'a', startTime: '08:23', endTime: '09:44' })],
      { switchMinutes: 30 },
    );
    expect(r.blocks[0].spanMinutes).toBe(81);
    expect(r.blocks[0].rideMinutes).toBe(81);
    expect(r.blocks[0].trips[0].minutes).toBe(81);
  });

  it('81 minutes is 1.35 decimal hours, not 1.21', () => {
    expect(minutesToDecimalHours(81)).toBeCloseTo(1.35, 10);
    expect(minutesToDecimalHours(81)).not.toBeCloseTo(1.21, 2);
  });

  it('stores the ride sum apart from the span, which §3 asks for', () => {
    // Two 30-minute rides 20 minutes apart: span 80, rides 60, idle 20.
    const r = buildBlocks(
      [
        trip({ id: 'a', startTime: '08:00', endTime: '08:30' }),
        trip({ id: 'b', startTime: '08:50', endTime: '09:20' }),
      ],
      { switchMinutes: 30 },
    );
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].spanMinutes).toBe(80);
    expect(r.blocks[0].rideMinutes).toBe(60);
    // The difference is the idle time, and keeping the two apart is what stops a
    // document deciding silently whether it is paid.
    expect(r.blocks[0].spanMinutes - r.blocks[0].rideMinutes).toBe(20);
  });
});

describe('buildBlocks — absolute instants, not clock strings', () => {
  it('a ride across midnight is 40 minutes, not negative', () => {
    const r = buildBlocks(
      [trip({ id: 'a', tripDate: '2026-10-05', startTime: '23:40', endTime: '00:20' })],
      { switchMinutes: 30 },
    );
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].spanMinutes).toBe(40);
    // And the block ends on the next calendar day.
    expect(new Date(r.blocks[0].endMs).getDate()).toBe(6);
  });

  it('prefers start_at over trip_date, because trip_date can be a day early', () => {
    // CLAUDE.md: the Uber export dates a ride starting just after midnight to the
    // previous day. `start_at` is the ride's real start.
    const realStart = new Date(2026, 9, 6, 0, 30).toISOString();
    const realEnd = new Date(2026, 9, 6, 1, 15).toISOString();
    const r = buildBlocks(
      [trip({ id: 'a', tripDate: '2026-10-05', startTime: '00:30', endTime: '01:15', startAt: realStart, endAt: realEnd })],
      { switchMinutes: 30 },
    );
    expect(r.blocks[0].trips[0].timeSource).toBe('instants');
    expect(new Date(r.blocks[0].startMs).getDate()).toBe(6);
  });

  it('records which time source was used for every ride', () => {
    const r = buildBlocks(
      [
        trip({ id: 'a', startTime: '08:00', endTime: '09:00' }),
        trip({
          id: 'b',
          startAt: new Date(2026, 9, 5, 12, 0).toISOString(),
          endAt: new Date(2026, 9, 5, 13, 0).toISOString(),
        }),
      ],
      { switchMinutes: 30 },
    );
    const sources = r.blocks.flatMap(b => b.trips).map(t => t.timeSource).sort();
    expect(sources).toEqual(['date_and_clock', 'instants']);
  });

  it('a gap across midnight is measured in real time, not by clock comparison', () => {
    // 23:00–23:30, then 00:40–01:00 the next day. The gap is 70 minutes.
    // A string comparison would read "00:40" as earlier and mis-order the rides.
    const r = buildBlocks(
      [
        trip({ id: 'a', tripDate: '2026-10-05', startTime: '23:00', endTime: '23:30' }),
        trip({ id: 'b', tripDate: '2026-10-06', startTime: '00:40', endTime: '01:00' }),
      ],
      { switchMinutes: 60 },
    );
    expect(r.blocks).toHaveLength(2);
    expect(buildBlocks(
      [
        trip({ id: 'a', tripDate: '2026-10-05', startTime: '23:00', endTime: '23:30' }),
        trip({ id: 'b', tripDate: '2026-10-06', startTime: '00:40', endTime: '01:00' }),
      ],
      { switchMinutes: 90 },
    ).blocks).toHaveLength(1);
  });
});

describe('buildBlocks — §14 edge cases, all surfaced', () => {
  it('a ride with no start is rejected and named', () => {
    const r = buildBlocks(
      [trip({ id: 'a', startTime: undefined, endTime: '09:00' })],
      { switchMinutes: 30 },
    );
    expect(r.blocks).toHaveLength(0);
    expect(r.rejected).toEqual([
      expect.objectContaining({ tripId: 'a', problem: 'missing_start' }),
    ]);
  });

  it('a ride with no end is rejected and named', () => {
    const r = buildBlocks(
      [trip({ id: 'a', startTime: '08:00', endTime: undefined })],
      { switchMinutes: 30 },
    );
    expect(r.rejected[0].problem).toBe('missing_end');
  });

  it('an end before its start on real instants is reported, not repaired', () => {
    const r = buildBlocks(
      [trip({
        id: 'a',
        startAt: new Date(2026, 9, 5, 10, 0).toISOString(),
        endAt: new Date(2026, 9, 5, 9, 0).toISOString(),
      })],
      { switchMinutes: 30 },
    );
    expect(r.blocks).toHaveLength(0);
    expect(r.rejected[0].problem).toBe('end_before_start');
  });

  it('a ride with no vehicle is rejected and named', () => {
    const r = buildBlocks(
      [trip({ id: 'a', vehicleId: null, vehicleIdentifier: null, startTime: '08:00', endTime: '09:00' })],
      { switchMinutes: 30 },
    );
    expect(r.rejected[0].problem).toBe('missing_vehicle');
  });

  it('an unreadable clock is rejected rather than read as midnight', () => {
    // A bare HH:MM:SS parsed by Date gives 0, which is the defect CLAUDE.md warns
    // about; an unparsable value must not become 00:00.
    const r = buildBlocks(
      [trip({ id: 'a', startTime: 'nonsense', endTime: '09:00' })],
      { switchMinutes: 30 },
    );
    expect(r.rejected[0].problem).toBe('missing_start');
    expect(r.blocks).toHaveLength(0);
  });

  it('overlapping rides of one vehicle are reported and still used', () => {
    const r = buildBlocks(
      [
        trip({ id: 'a', startTime: '08:00', endTime: '09:00' }),
        trip({ id: 'b', startTime: '08:30', endTime: '09:30' }),
      ],
      { switchMinutes: 30 },
    );
    expect(r.overlaps).toEqual([
      expect.objectContaining({ firstTripId: 'a', secondTripId: 'b', overlapMinutes: 30 }),
    ]);
    // Still blocked, because they are real rides — dropping them understates the
    // month, and the overlap is surfaced for someone to resolve.
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].trips).toHaveLength(2);
  });

  it('a block ends at its latest end, not at its last ride’s end', () => {
    // 'b' is fully contained in 'a'; the block must still end at 10:00.
    const r = buildBlocks(
      [
        trip({ id: 'a', startTime: '08:00', endTime: '10:00' }),
        trip({ id: 'b', startTime: '08:30', endTime: '09:00' }),
      ],
      { switchMinutes: 30 },
    );
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].spanMinutes).toBe(120);
  });

  it('cancelled rides are counted and never blocked', () => {
    const r = buildBlocks(
      [
        trip({ id: 'a', startTime: '08:00', endTime: '09:00' }),
        trip({ id: 'x', startTime: '08:10', endTime: '09:10', isCanceled: true }),
      ],
      { switchMinutes: 30 },
    );
    expect(r.canceledCount).toBe(1);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].trips.map(t => t.tripId)).toEqual(['a']);
    // A cancellation is not a data problem, so it is not in `rejected`.
    expect(r.rejected).toHaveLength(0);
  });

  it('no rides gives no blocks and no problems', () => {
    const r = buildBlocks([], { switchMinutes: 30 });
    expect(r).toEqual({
      blocks: [], rejected: [], overlaps: [], canceledCount: 0,
      // `shortBlocks` is empty for a build with no minimum asked for, which is
      // what `switchMinutes` alone means. An exact deep-equal is deliberate here:
      // it is what catches a key added to the result and left unreported.
      shortBlocks: [],
      longBlocks: [],
      handoverTrips: [],
    });
  });
});

describe('buildBlocks — determinism', () => {
  it('produces identical output for the same input in any order', () => {
    const rides = [
      trip({ id: 'a', vehicleId: 'car-B', startTime: '08:00', endTime: '09:00' }),
      trip({ id: 'b', vehicleId: 'car-A', startTime: '10:00', endTime: '11:00' }),
      trip({ id: 'c', vehicleId: 'car-B', startTime: '14:00', endTime: '15:00' }),
    ];
    const forward = buildBlocks(rides, { switchMinutes: 30 });
    const reversed = buildBlocks([...rides].reverse(), { switchMinutes: 30 });
    expect(reversed).toEqual(forward);
  });

  it('carries the original driver name for the pre-selection suggestion only (§2)', () => {
    const r = buildBlocks(
      [trip({ id: 'a', startTime: '08:00', endTime: '09:00', originalDriverName: 'Ali' })],
      { switchMinutes: 30 },
    );
    expect(r.blocks[0].trips[0].originalDriverName).toBe('Ali');
    // §2: the planning copy starts with no driver assigned.
    expect(r.blocks[0].driverId).toBeNull();
    expect(r.blocks[0].driverName).toBeNull();
  });
});

// ─── The minimum block length (owner, 01.10.2026) ─────────────────────────
//
// The gap rule alone cuts a quiet day into fifteen-minute blocks, and a
// fifteen-minute block is not a shift. `minBlockMinutes` joins a short block to a
// neighbour of the SAME VEHICLE on the SAME LOCAL DAY — it never pads, never moves
// a ride and never mixes vehicles, so no working time is invented.
//
// The figure that must survive every one of these: `rideMinutes`. A merge absorbs
// a gap into `spanMinutes` and the rides are unchanged, which is the distinction
// §3 keeps the two numbers apart for.

describe('buildBlocks — the minimum block length', () => {
  /** Total ride minutes across a build, the quantity a merge may never change. */
  const totalRideMinutes = (blocks: { rideMinutes: number }[]) =>
    blocks.reduce((sum, b) => sum + b.rideMinutes, 0);

  it('merges a short block into its nearer neighbour, and only the span grows', () => {
    // 08:00–09:00 (60), gap 40, 09:40–09:50 (10), gap 120, 11:50–13:30 (100).
    // With a 30-minute switch all three are separate blocks; the middle one is
    // 10 minutes and its nearer neighbour is the first. The THIRD is 100 minutes
    // on purpose — the first draft of this test made it 60, which is also under
    // the minimum, so the pass merged all three and the test proved nothing about
    // which neighbour was chosen.
    const rides = [
      trip({ id: 'a', startTime: '08:00', endTime: '09:00' }),
      trip({ id: 'b', startTime: '09:40', endTime: '09:50' }),
      trip({ id: 'c', startTime: '11:50', endTime: '13:30' }),
    ];
    const plain = buildBlocks(rides, { switchMinutes: 30 });
    expect(plain.blocks).toHaveLength(3);

    const r = buildBlocks(rides, { switchMinutes: 30, minBlockMinutes: 90 });
    expect(r.blocks).toHaveLength(2);

    // 08:00–09:50 is 110 minutes of span holding 70 minutes of rides — the 40
    // minutes it absorbed are idle, and visibly so.
    const first = r.blocks[0];
    expect(first.spanMinutes).toBe(110);
    expect(first.rideMinutes).toBe(70);
    expect(first.trips.map(t => t.tripId)).toEqual(['a', 'b']);

    // Nothing was invented and nothing was lost.
    expect(totalRideMinutes(r.blocks)).toBe(totalRideMinutes(plain.blocks));
    expect(r.shortBlocks).toEqual([]);
  });

  it('never merges two vehicles, however short the blocks are', () => {
    // §3's first rule. Two ten-minute runs an hour apart, different cars.
    const r = buildBlocks(
      [
        trip({ id: 'a', vehicleId: 'car-A', startTime: '08:00', endTime: '08:10' }),
        trip({ id: 'b', vehicleId: 'car-B', startTime: '09:00', endTime: '09:10' }),
      ],
      { switchMinutes: 30, minBlockMinutes: 90 },
    );
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks.map(b => b.vehicleId).sort()).toEqual(['car-A', 'car-B']);
    // Both stay short, and both are reported rather than padded.
    expect(r.shortBlocks.map(b => b.spanMinutes)).toEqual([10, 10]);
  });

  it('never merges across the local day boundary', () => {
    // Monday's last ten minutes and Tuesday's first, one car, a gap of hours.
    // Merging them would make a block that is not a shift, and across a DST
    // boundary the gap in hours would not even be the gap on the clock.
    const r = buildBlocks(
      [
        trip({ id: 'a', tripDate: '2026-10-05', startTime: '22:00', endTime: '22:10' }),
        trip({ id: 'b', tripDate: '2026-10-06', startTime: '06:00', endTime: '06:10' }),
      ],
      { switchMinutes: 30, minBlockMinutes: 90 },
    );
    expect(r.blocks).toHaveLength(2);
    expect(r.shortBlocks).toHaveLength(2);
  });

  it('leaves a lone short block short, and says so', () => {
    const r = buildBlocks(
      [trip({ id: 'a', startTime: '08:00', endTime: '08:12' })],
      { switchMinutes: 30, minBlockMinutes: 90 },
    );
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].spanMinutes).toBe(12);
    expect(r.shortBlocks).toEqual([{ blockId: r.blocks[0].id, spanMinutes: 12 }]);
  });

  it('asks for no minimum when none is given, and reports none', () => {
    // The negative control for the whole feature: without the option the build is
    // exactly §3's, which is what keeps every other test in this file meaningful.
    const rides = [
      trip({ id: 'a', startTime: '08:00', endTime: '08:10' }),
      trip({ id: 'b', startTime: '09:00', endTime: '09:10' }),
    ];
    for (const options of [
      { switchMinutes: 30 },
      { switchMinutes: 30, minBlockMinutes: 0 },
      { switchMinutes: 30, minBlockMinutes: undefined },
    ]) {
      const r = buildBlocks(rides, options);
      expect(r.blocks).toHaveLength(2);
      expect(r.shortBlocks).toEqual([]);
    }
  });

  it('keeps merging until nothing on the day is short, and terminates', () => {
    // Four ten-minute runs, twenty minutes apart, one car, one day. Each merge
    // makes the result longer, so the pass has to run more than once.
    const rides = ['08:00', '08:30', '09:00', '09:30'].map((from, i) =>
      trip({
        id: `r${i}`,
        startTime: from,
        endTime: `${from.slice(0, 2)}:${String(Number(from.slice(3)) + 10).padStart(2, '0')}`,
      }));
    const r = buildBlocks(rides, { switchMinutes: 20, minBlockMinutes: 90 });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].spanMinutes).toBe(100);   // 08:00 → 09:40
    expect(r.blocks[0].rideMinutes).toBe(40);    // four ten-minute rides
    expect(r.blocks[0].trips).toHaveLength(4);
    expect(r.shortBlocks).toEqual([]);
  });
});

// ─── The maximum block length (owner, 01.10.2026) ────────────────────────────
//
// The owner read the first screen the minimum produced and overruled the note in
// `mergeShortBlocks` that said there is no maximum. The block he saw was
// `06:00–16:00, 10,00 h, 4 Fahrten, davon Leerlauf 6,00` — ten hours of which six
// were waiting, built by the merge chaining short runs across a quiet day.
//
// So the ceiling is first of all a bound on the MERGE. It never splits: the gap
// rule has already split at every gap of at least `switchMinutes`, so a block
// longer than the maximum holds only gaps shorter than the switch duration, and
// cutting there would put a driver change into a gap too short for one.

describe('buildBlocks — the maximum block length', () => {
  it('refuses a merge that would exceed the maximum, and reports what stays short', () => {
    // Three 20-minute runs at 06:00, 11:00 and 16:00 — one car, one day. With a
    // 90-minute minimum and no ceiling the pass chains all three into a
    // ten-hour-twenty block. With a six-hour ceiling it cannot.
    const rides = [
      trip({ id: 'a', startTime: '06:00', endTime: '06:20' }),
      trip({ id: 'b', startTime: '11:00', endTime: '11:20' }),
      trip({ id: 'c', startTime: '16:00', endTime: '16:20' }),
    ];

    const unbounded = buildBlocks(rides, { switchMinutes: 30, minBlockMinutes: 90 });
    expect(unbounded.blocks).toHaveLength(1);
    expect(unbounded.blocks[0].spanMinutes).toBe(620);   // 06:00 → 16:20
    expect(unbounded.longBlocks, 'no maximum asked for, so nothing is reported')
      .toEqual([]);

    const bounded = buildBlocks(rides, {
      switchMinutes: 30, minBlockMinutes: 90, maxBlockMinutes: 360,
    });
    // 06:00–11:20 is 320 minutes, which fits; adding 16:00 would make 620, which
    // does not. So two blocks, and the second is short with nowhere to go.
    expect(bounded.blocks).toHaveLength(2);
    expect(bounded.blocks[0].spanMinutes).toBe(320);
    expect(bounded.blocks[1].spanMinutes).toBe(20);
    expect(bounded.shortBlocks.map(b => b.spanMinutes)).toEqual([20]);
    expect(bounded.longBlocks, 'nothing exceeds the ceiling').toEqual([]);

    // And the rides are all still there, in both.
    const rideMinutes = (r: typeof bounded) =>
      r.blocks.reduce((sum, b) => sum + b.rideMinutes, 0);
    expect(rideMinutes(bounded)).toBe(rideMinutes(unbounded));
  });

  it('one stuck block does not stop the others from merging', () => {
    // The first version of the ceiling broke out of the loop on the first block it
    // could not place, which left every other short block of that day unmerged —
    // a correct refusal for one silently becoming a refusal for all.
    const rides = [
      trip({ id: 'a', startTime: '06:00', endTime: '06:20' }),  // far from the rest
      trip({ id: 'b', startTime: '14:00', endTime: '14:20' }),  // these two are
      trip({ id: 'c', startTime: '15:00', endTime: '15:20' }),  // joinable
    ];
    const r = buildBlocks(rides, {
      switchMinutes: 30, minBlockMinutes: 90, maxBlockMinutes: 360,
    });
    // 'a' cannot join 14:00 (that would be 8h20), but b+c become one 80-minute
    // block — still under the minimum, and reported, but they DID merge.
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks.map(b => b.spanMinutes).sort((x, y) => x - y)).toEqual([20, 80]);
  });

  it('reports a block that is genuinely too long, and never splits it', () => {
    // One continuous ride of seven hours. There is no gap to split at and a ride
    // is never cut, so the honest answer is to say so.
    const r = buildBlocks(
      [trip({ id: 'a', startTime: '06:00', endTime: '13:00' })],
      { switchMinutes: 30, maxBlockMinutes: 360 },
    );
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].spanMinutes).toBe(420);
    expect(r.blocks[0].trips).toHaveLength(1);
    expect(r.longBlocks).toEqual([{ blockId: r.blocks[0].id, spanMinutes: 420 }]);
  });

  it('asks for no maximum when none is given', () => {
    // The negative control: without the option the build is what it was, and a
    // long block is not reported as a problem.
    const r = buildBlocks(
      [trip({ id: 'a', startTime: '06:00', endTime: '20:00' })],
      { switchMinutes: 30 },
    );
    expect(r.blocks[0].spanMinutes).toBe(840);
    expect(r.longBlocks).toEqual([]);
  });
});


// ─── Splitting a long block at the gap it already has (owner, 02.10.2026) ────
//
// His problem, in his words: a driver works eight hours, ride after ride, with no
// gap anywhere long enough to part two blocks — so the eight hours is one block
// and one driver's, and he wants two drivers.
//
// The gap this creates is exactly the switch duration, which is the rule §3
// already holds: parting two blocks takes that long because **changing driver or
// car takes that long**. The rides inside the gap are the ones nobody can drive
// while the car is handed over, so they are given up and named — never moved.
//
// Measured on the owner's own data before this was written: 79 blocks over six
// hours with no natural break; splitting each at its midpoint gives up 94 rides,
// widening the gap already inside gives up 79 — one per block, which is the floor
// and not a tuning choice.

describe('buildBlocks — splitting a long block for a handover', () => {
  /** Eight hours of back-to-back rides, with one 22-minute lull in the middle. */
  const eightHours = () => [
    trip({ id: 'a', startTime: '06:00', endTime: '08:00' }),
    trip({ id: 'b', startTime: '08:10', endTime: '10:00' }),
    // The lull: 10:00 to 10:22. The widest gap, and in the middle half.
    trip({ id: 'c', startTime: '10:22', endTime: '12:00' }),
    trip({ id: 'd', startTime: '12:05', endTime: '14:00' }),
  ];

  it('does nothing unless it is asked for', () => {
    // Giving up a ride is a decision about a month's revenue, so it is never a
    // default. Off, the block stays whole and is merely reported as long.
    const r = buildBlocks(eightHours(), { switchMinutes: 30, maxBlockMinutes: 360 });
    expect(r.blocks).toHaveLength(1);
    expect(r.handoverTrips).toEqual([]);
    expect(r.longBlocks).toHaveLength(1);
  });

  it('splits at the widest gap and gives up the rides inside the handover', () => {
    const r = buildBlocks(eightHours(), {
      switchMinutes: 30, maxBlockMinutes: 360, splitLongBlocks: true,
    });

    expect(r.blocks).toHaveLength(2);
    // The handover runs 10:00 to 10:30, and 'c' starts at 10:22 — inside it, so it
    // is given up. 'd' at 12:05 is after it.
    expect(r.blocks[0].trips.map(t => t.tripId)).toEqual(['a', 'b']);
    expect(r.blocks[1].trips.map(t => t.tripId)).toEqual(['d']);
    expect(r.handoverTrips.map(t => t.tripId)).toEqual(['c']);
  });

  it('gives up exactly one ride — the floor, and it is arithmetic not tuning', () => {
    // A gap ends at the instant the next ride begins, so widening it must swallow
    // that ride. No arrangement gives up none without moving a ride to a time it
    // did not happen, which is the option the owner weighed and set aside.
    const r = buildBlocks(eightHours(), {
      switchMinutes: 30, maxBlockMinutes: 360, splitLongBlocks: true,
    });
    expect(r.handoverTrips).toHaveLength(1);
  });

  it('never moves a ride: every remaining time is the one that was imported', () => {
    // The assertion the whole design rests on. The owner's other option shifted
    // every later ride by half an hour; this one moves nothing.
    const before = buildBlocks(eightHours(), { switchMinutes: 30 });
    const after = buildBlocks(eightHours(), {
      switchMinutes: 30, maxBlockMinutes: 360, splitLongBlocks: true,
    });

    const stamp = (r: ReturnType<typeof buildBlocks>) =>
      r.blocks.flatMap(b => b.trips).map(t => `${t.tripId}:${t.startMs}-${t.endMs}`);
    const kept = new Set(after.blocks.flatMap(b => b.trips).map(t => t.tripId));
    const afterStamps = stamp(after);

    for (const entry of stamp(before)) {
      if (!kept.has(entry.split(':')[0])) continue;
      expect(afterStamps, `${entry} was moved`).toContain(entry);
    }
  });

  it('names what it gave up, with the block and the vehicle it came from', () => {
    // A ride that leaves the plan unaccounted for is indistinguishable from a
    // defect, so the trade the operator agreed to is written down.
    const r = buildBlocks(eightHours(), {
      switchMinutes: 30, maxBlockMinutes: 360, splitLongBlocks: true,
    });
    const given = r.handoverTrips[0];
    expect(given.vehicleId).toBe('car-A');
    expect(given.blockId).toContain('car-A|');
    expect(given.endMs).toBeGreaterThan(given.startMs);
  });

  it('never cuts a single ride, however long it runs', () => {
    // Nine hours in one ride. There is no gap at all, and a ride is never parted.
    const r = buildBlocks(
      [trip({ id: 'a', startTime: '06:00', endTime: '15:00' })],
      { switchMinutes: 30, maxBlockMinutes: 360, splitLongBlocks: true },
    );
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].trips).toHaveLength(1);
    expect(r.handoverTrips).toEqual([]);
    // And it is still reported, so the screen can say why it stayed long.
    expect(r.longBlocks).toHaveLength(1);
  });

  it('refuses a split that would leave a part under the minimum', () => {
    // Otherwise this pass and the merge pass undo each other.
    const r = buildBlocks(eightHours(), {
      switchMinutes: 30, maxBlockMinutes: 360, minBlockMinutes: 300, splitLongBlocks: true,
    });
    expect(r.blocks).toHaveLength(1);
    expect(r.handoverTrips).toEqual([]);
  });

  it('does nothing without a maximum or without a switch duration', () => {
    // Both are needed to mean anything: one says which block is too long, the
    // other how wide the gap must be. Neither is ever guessed.
    expect(buildBlocks(eightHours(), { switchMinutes: 30, splitLongBlocks: true })
      .handoverTrips).toEqual([]);
    expect(buildBlocks(eightHours(), {
      switchMinutes: 0, maxBlockMinutes: 360, splitLongBlocks: true,
    }).handoverTrips).toEqual([]);
  });

  it('splits again when a part is still too long', () => {
    // Fourteen hours becomes three shifts rather than one long and one slightly
    // shorter.
    // Seven rides, not five: the first draft of this fixture had too few, and the
    // second split was refused because giving up the one ride after the gap left
    // nothing on the far side. That refusal is correct — a split that empties one
    // half is not a split — so the fixture was corrected rather than the rule.
    const long = [
      trip({ id: 'a', startTime: '06:00', endTime: '08:00' }),
      trip({ id: 'b', startTime: '08:20', endTime: '10:00' }),
      trip({ id: 'c', startTime: '10:10', endTime: '12:00' }),
      trip({ id: 'd', startTime: '12:25', endTime: '14:00' }),
      trip({ id: 'e', startTime: '14:10', endTime: '16:00' }),
      trip({ id: 'f', startTime: '16:20', endTime: '18:00' }),
      trip({ id: 'g', startTime: '18:10', endTime: '20:00' }),
    ];
    const r = buildBlocks(long, {
      switchMinutes: 30, maxBlockMinutes: 300, splitLongBlocks: true,
    });
    expect(r.blocks.length).toBeGreaterThan(2);
    for (const block of r.blocks) {
      expect(block.spanMinutes).toBeLessThanOrEqual(300);
    }
  });
});


// ─── Conservation: the property a driver's pay rests on ────────────────────
//
// The owner put it together himself: the split changes who works which hours, so
// it changes what each of them earns. Every hour in this plan becomes a line on a
// Stundennachweis and a figure in a payroll summary.
//
// So the rule is not "the split looks right", it is arithmetic: **every ride is in
// exactly one block, or given up, and never both and never neither.** A ride
// counted twice pays somebody for work nobody did; a ride that vanishes with no
// entry anywhere is indistinguishable from a defect, and neither is visible by
// reading a screen.

describe('buildBlocks — every ride is accounted for exactly once', () => {
  const months = [
    {
      name: 'eight hours back to back with one lull',
      trips: [
        trip({ id: 'a', startTime: '06:00', endTime: '08:00' }),
        trip({ id: 'b', startTime: '08:10', endTime: '10:00' }),
        trip({ id: 'c', startTime: '10:22', endTime: '12:00' }),
        trip({ id: 'd', startTime: '12:05', endTime: '14:00' }),
      ],
    },
    {
      name: 'fourteen hours, several splits',
      trips: [
        trip({ id: 'a', startTime: '06:00', endTime: '08:00' }),
        trip({ id: 'b', startTime: '08:20', endTime: '10:00' }),
        trip({ id: 'c', startTime: '10:10', endTime: '12:00' }),
        trip({ id: 'd', startTime: '12:25', endTime: '14:00' }),
        trip({ id: 'e', startTime: '14:10', endTime: '16:00' }),
        trip({ id: 'f', startTime: '16:20', endTime: '18:00' }),
        trip({ id: 'g', startTime: '18:10', endTime: '20:00' }),
      ],
    },
    {
      name: 'two vehicles on one day',
      trips: [
        trip({ id: 'a', vehicleId: 'car-A', startTime: '06:00', endTime: '10:00' }),
        trip({ id: 'b', vehicleId: 'car-A', startTime: '10:15', endTime: '14:00' }),
        trip({ id: 'c', vehicleId: 'car-B', startTime: '07:00', endTime: '11:00' }),
        trip({ id: 'd', vehicleId: 'car-B', startTime: '11:20', endTime: '15:00' }),
      ],
    },
  ];

  for (const month of months) {
    it(`${month.name}: in one block or given up, never both, never neither`, () => {
      const r = buildBlocks(month.trips, {
        switchMinutes: 30, minBlockMinutes: 90, maxBlockMinutes: 360, splitLongBlocks: true,
      });

      const inBlocks = r.blocks.flatMap(b => b.trips.map(t => t.tripId));
      const givenUp = r.handoverTrips.map(t => t.tripId);
      const rejected = r.rejected.map(t => t.tripId);

      // No ride is in two blocks: that would pay two drivers for one journey.
      expect(new Set(inBlocks).size, 'a ride is in more than one block')
        .toBe(inBlocks.length);
      // No ride is both placed and given up.
      for (const id of givenUp) {
        expect(inBlocks, `${id} is both in a block and given up`).not.toContain(id);
      }
      // And every ride of the month is somewhere.
      const accounted = new Set([...inBlocks, ...givenUp, ...rejected]);
      for (const t of month.trips) {
        expect(accounted.has(t.id), `${t.id} is in no block, not given up and not rejected`)
          .toBe(true);
      }
      expect(accounted.size).toBe(month.trips.length);
    });

    it(`${month.name}: the ride minutes that stay are the ride minutes that were there`, () => {
      // `rideMinutes` is what a Stundennachweis reads. The spans change with the
      // split — that is the point — but the minutes actually driven must be the
      // imported ones minus exactly what was given up, to the minute.
      const whole = buildBlocks(month.trips, { switchMinutes: 30 });
      const split = buildBlocks(month.trips, {
        switchMinutes: 30, minBlockMinutes: 90, maxBlockMinutes: 360, splitLongBlocks: true,
      });

      const rideMinutes = (r: ReturnType<typeof buildBlocks>) =>
        r.blocks.reduce((sum, b) => sum + b.rideMinutes, 0);
      const givenUpMinutes = split.blocks.length === 0 ? 0 : split.handoverTrips
        .reduce((sum, t) => sum + Math.round((t.endMs - t.startMs) / 60000), 0);

      expect(rideMinutes(split) + givenUpMinutes).toBe(rideMinutes(whole));
    });
  }
});
