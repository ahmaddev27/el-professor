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
    expect(r).toEqual({ blocks: [], rejected: [], overlaps: [], canceledCount: 0 });
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
