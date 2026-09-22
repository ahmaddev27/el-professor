/**
 * Blocks: analytical groups of one driver's close trips on one vehicle.
 *
 * Over the driver's analysed trips, sorted by start and then id:
 *  - a trip joins the open block when it is on the same vehicle and its start
 *    lies at most `blockGapMinutes` after the block's running maximum end;
 *    a gap EQUAL to the setting stays in the block, a greater one opens a new one;
 *  - the gap is measured from the running maximum end, so a short trip inside
 *    a long one does not shorten the block;
 *  - another vehicle opens a new block (an unknown vehicle counts as a value of
 *    its own); that split never hides an overlap, which the sweep checks across
 *    all of a driver's trips;
 *  - a negative gap is an overlap: the trip joins, the overlap is reported by
 *    the sweep, and no time is changed;
 *  - a trip across midnight is one trip in one block, never split.
 *
 * A block is not a record of working time and no licence to reassign its trips.
 */
import { mergeIntervals, totalLength, uncoveredLength, type Interval } from './intervals';
import { priceSummary } from './prices';
import type { ClassifiedTrip } from './classify';
import type { BlockStartReason, PriceSummary, TimeMetrics } from './types';

const MINUTE_MS = 60_000;

export interface BuiltBlock {
  readonly id: string;
  readonly driverId: string;
  readonly index: number;
  readonly vehicleKey: string | null;
  readonly startReason: BlockStartReason;
  readonly gapBeforeMs: number | null;
  readonly members: readonly ClassifiedTrip[];
  readonly start: number;
  readonly end: number;
}

export function buildBlocks(driverId: string, sortedTrips: readonly ClassifiedTrip[], blockGapMinutes: number): BuiltBlock[] {
  const gapLimitMs = blockGapMinutes * MINUTE_MS;
  const blocks: BuiltBlock[] = [];
  let members: ClassifiedTrip[] = [];
  let open: Omit<BuiltBlock, 'members' | 'end' | 'id' | 'index'> | null = null;
  let runningEnd = Number.NEGATIVE_INFINITY;

  const close = () => {
    if (!open) return;
    const index = blocks.length;
    blocks.push({ ...open, id: `${driverId}#${index}`, index, members, end: runningEnd });
  };

  for (const trip of sortedTrips) {
    if (open) {
      const gapMs = trip.start - runningEnd;
      const sameVehicle = trip.vehicleKey === open.vehicleKey;
      if (sameVehicle && gapMs <= gapLimitMs) {
        members.push(trip);
        runningEnd = Math.max(runningEnd, trip.end);
        continue;
      }
      close();
      open = {
        driverId,
        vehicleKey: trip.vehicleKey,
        startReason: gapMs > gapLimitMs ? 'gap' : 'vehicle_change',
        gapBeforeMs: gapMs,
        start: trip.start,
      };
    } else {
      open = { driverId, vehicleKey: trip.vehicleKey, startReason: 'first', gapBeforeMs: null, start: trip.start };
    }
    members = [trip];
    runningEnd = trip.end;
  }
  close();
  return blocks;
}

export function intervalsOf(trips: readonly ClassifiedTrip[]): Interval[] {
  return trips.map(t => ({ start: t.start, end: t.end }));
}

/**
 * Metrics of a set of analysed trips. `spanMs` is supplied by the caller: a
 * block's own span, or the sum of a driver's block spans. `shifts` is the
 * merged list of valid shifts, or null when the driver has none.
 */
export function timeMetrics(trips: readonly ClassifiedTrip[], spanMs: number, shifts: readonly Interval[] | null): TimeMetrics {
  let durationSumMs = 0;
  for (const t of trips) durationSumMs += t.end - t.start;
  const union = mergeIntervals(intervalsOf(trips));
  return {
    durationSumMs,
    unionMs: totalLength(union),
    spanMs,
    outsideShiftMs: shifts ? uncoveredLength(union, shifts) : null,
  };
}

export function blockPrices(block: BuiltBlock): PriceSummary {
  return priceSummary(block.members.map(m => m.trip));
}
