/**
 * Monthly plan — building ride blocks per vehicle (requirement §3).
 *
 * ## The rule, and it is the whole of §3
 *
 * Blocks are built **independently for each vehicle**; two vehicles never share a
 * block. Within a vehicle, rides are ordered by their start and walked once. The
 * gap between one ride's end and the next ride's start decides the boundary:
 *
 *   - gap **>= switchMinutes** → a boundary *may* be created, and §3 also says
 *     "make the blocks as short as possible", so one *is* created;
 *   - gap **< switchMinutes** → the two rides **must** stay in the same block.
 *
 * That is the only splitting criterion. This is deliberately narrower than the
 * existing `monatsplanungPhase1.ts`, which splits on a separate 60-minute
 * `blockSeparatorGap` and then runs a min/max-duration merge pass — three knobs
 * where §3 specifies one. That module keeps its behaviour for its own pipeline;
 * this one implements the requirement.
 *
 * ## Minutes, and the figure §16 pins
 *
 * Every duration here is **integer minutes**, computed from absolute
 * milliseconds. §3's own example: 08:23 → 09:44 is 81 minutes, which is 1.35
 * decimal hours — not 1.21. The 1.21 error comes from reading `09:44 - 08:23` as
 * a decimal subtraction (1.21); nothing in this module can produce it, because
 * nothing here subtracts clock faces.
 *
 * Two durations are stored per block and they are **not** the same number:
 *
 *   - `spanMinutes` — end minus start, the wall-clock length of the block;
 *   - `rideMinutes` — the sum of the actual rides, which §3 asks for explicitly
 *     and the existing pipeline does not store at all.
 *
 * `spanMinutes - rideMinutes` is the idle time inside the block. Keeping them
 * apart is what lets a later document decide whether idle time is paid without
 * re-deriving it — the ambiguity that currently makes the Stundennachweis and the
 * on-screen total disagree for 92.5% of driver-days.
 *
 * ## Absolute instants, never clock strings
 *
 * Intervals are built from epoch milliseconds. A ride that starts at 23:40 and
 * ends at 00:20 crosses midnight, and comparing `"00:20" < "23:40"` as strings —
 * or parsing a bare `HH:MM:SS`, which yields 0 — is the defect CLAUDE.md warns
 * about twice. `start_at` is the ride's real start: `trip_date` is the file's
 * "Datum der Fahrt", which the Uber export dates a day early for a ride starting
 * just after midnight.
 */
import { localDateKey } from '../localDayWindow';

/**
 * The minimum block length the screen starts with, in minutes.
 *
 * 90, which is the figure the owner named on 01.10.2026 ("not shorter than
 * 1.5 hour"). It is a default and not a rule: the control on screen 2 sets it per
 * run, and 0 there means no minimum at all.
 */
export const DEFAULT_MIN_BLOCK_MINUTES = 90;

/** Where a ride's instants came from, so nothing is silently guessed. */
export type TripTimeSource = 'instants' | 'date_and_clock' | 'unusable';

/** The ride fields this module reads. A subset of `fahrtenbuch_trips`. */
export interface PlanTripInput {
  id: string;
  /** `car_id`, or `car_identifier` when the car is not in the fleet table. */
  vehicleId: string | null;
  vehicleIdentifier: string | null;
  /** `start_at` / `end_at` — the ride's real instants. Preferred. */
  startAt?: string | null;
  endAt?: string | null;
  /** `trip_date` (`YYYY-MM-DD`) plus `start_time` / `end_time` (`HH:MM[:SS]`). */
  tripDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  /** `is_canceled`. A cancelled ride is never counted and never blocked (§7). */
  isCanceled?: boolean | null;
  /** `original_driver_name`, kept for the pre-selection suggestion only (§2). */
  originalDriverName?: string | null;
  originalDriverId?: string | null;
}

/** Why a ride could not be placed. Each is surfaced, never swallowed (§14). */
export type TripProblem =
  | 'missing_vehicle'
  | 'missing_start'
  | 'missing_end'
  | 'end_before_start'
  | 'unparsable_time';

export interface RejectedTrip {
  tripId: string;
  problem: TripProblem;
  /** What was read, so the screen can show why it could not be used. */
  detail: string;
}

/** Two rides of the same vehicle that overlap in the source data (§14). */
export interface VehicleOverlap {
  vehicleId: string;
  firstTripId: string;
  secondTripId: string;
  overlapMinutes: number;
}

export interface PlanBlockTrip {
  tripId: string;
  startMs: number;
  endMs: number;
  minutes: number;
  timeSource: TripTimeSource;
  originalDriverName: string | null;
}

export interface PlanBlock {
  /** Stable within one build: vehicle plus the block's start instant. */
  id: string;
  vehicleId: string;
  vehicleIdentifier: string | null;
  startMs: number;
  endMs: number;
  /** End minus start, in integer minutes. The block's wall-clock length. */
  spanMinutes: number;
  /** Sum of the member rides' own minutes. §3 asks for this explicitly. */
  rideMinutes: number;
  trips: PlanBlockTrip[];
  /**
   * Filled by the assignment step, not here. §3 lists it among a block's stored
   * fields, and keeping it on the block — rather than in a parallel map — is what
   * makes a block self-describing when a document reads it later.
   */
  driverId: string | null;
  driverName: string | null;
}

export interface BuildBlocksOptions {
  /**
   * The user's switch duration in minutes, from screen 2 (§1). A gap of exactly
   * this length may split; anything shorter may not.
   *
   * 0 is legal and means "split at every gap", which is the shortest possible
   * blocking. It is not treated as "unset" — the existing pipeline's migration
   * header records why that distinction matters: a default written for an omitted
   * value once disabled the gate it was meant to enforce.
   */
  switchMinutes: number;
  /**
   * The shortest block the screen may offer a driver, in minutes. Omitted or 0
   * means no minimum, which is what §3 alone produces.
   *
   * The owner asked for this on 01.10.2026: the gap rule alone cuts a quiet day
   * into fifteen-minute blocks, and a fifteen-minute block is not a shift anybody
   * can be sent out on. It is a control on screen 1, not a constant, because the
   * right figure is a fleet's own — the default is 90.
   *
   * **It merges; it never pads.** A short block is joined to a neighbouring block
   * of the SAME VEHICLE on the SAME LOCAL DAY, so no working time is invented and
   * no ride moves. What grows is the block's `spanMinutes` — the car is booked
   * across the gap it absorbed — while `rideMinutes` is the same sum it always
   * was. That is exactly the distinction §3 keeps the two figures apart for, and
   * the difference shows on screen as idle time.
   */
  minBlockMinutes?: number;
}

export interface BuildBlocksResult {
  blocks: PlanBlock[];
  rejected: RejectedTrip[];
  overlaps: VehicleOverlap[];
  /** Rides excluded because `is_canceled` — counted, not a problem. */
  canceledCount: number;
  /**
   * Blocks still under `minBlockMinutes` after the merge pass, with the length
   * they have. Surfaced rather than padded or dropped (§14): a car that drove
   * once for twelve minutes on a day it did nothing else has a twelve-minute
   * block, and there is nothing on that day to merge it with. The screen says so.
   */
  shortBlocks: { blockId: string; spanMinutes: number }[];
}

const MS_PER_MINUTE = 60_000;

/** Integer minutes between two instants. Rounds once, at the end. */
function minutesBetween(startMs: number, endMs: number): number {
  return Math.round((endMs - startMs) / MS_PER_MINUTE);
}

/**
 * Seconds since local midnight for an `HH:MM[:SS]` string, or null.
 *
 * Returns seconds rather than a Date so the caller adds them to a local midnight
 * it computed itself — building the instant from `date-midnight + secondOfDay`
 * is the pattern CLAUDE.md requires, and it is DST-correct because the midnight
 * is resolved per calendar day.
 */
function secondOfDay(clock: string | null | undefined): number | null {
  if (!clock) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(clock.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = m[3] ? Number(m[3]) : 0;
  if (h > 23 || min > 59 || s > 59) return null;
  return h * 3600 + min * 60 + s;
}

/** Local midnight of a `YYYY-MM-DD` date, as epoch ms, or null. */
function localMidnightMs(date: string | null | undefined): number | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date.trim());
  if (!m) return null;
  // `new Date(y, m, d)` is local time, which is what the payroll rules walk.
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

interface ResolvedTrip {
  trip: PlanTripInput;
  startMs: number;
  endMs: number;
  timeSource: TripTimeSource;
}

/**
 * Resolves a ride's absolute start and end.
 *
 * Prefers `start_at` / `end_at`. Falls back to `trip_date` plus the clock
 * columns, and records which was used. A ride whose end lands before its start
 * on the clock path is read as crossing midnight and moved to the next day —
 * that is the documented behaviour of this data and the reason absolute
 * instants are used everywhere downstream.
 */
function resolveTrip(trip: PlanTripInput): ResolvedTrip | RejectedTrip {
  const startAt = trip.startAt ? Date.parse(trip.startAt) : Number.NaN;
  const endAt = trip.endAt ? Date.parse(trip.endAt) : Number.NaN;

  if (Number.isFinite(startAt) && Number.isFinite(endAt)) {
    if (endAt < startAt) {
      // With real instants there is no midnight ambiguity to resolve, so this is
      // bad data and is reported rather than repaired.
      return {
        tripId: trip.id,
        problem: 'end_before_start',
        detail: `start_at ${trip.startAt} is after end_at ${trip.endAt}`,
      };
    }
    return { trip, startMs: startAt, endMs: endAt, timeSource: 'instants' };
  }

  const midnight = localMidnightMs(trip.tripDate);
  if (midnight == null) {
    return {
      tripId: trip.id,
      problem: 'unparsable_time',
      detail: `no usable start_at and no readable trip_date (${trip.tripDate ?? 'null'})`,
    };
  }

  const startSec = secondOfDay(trip.startTime);
  if (startSec == null) {
    return {
      tripId: trip.id,
      problem: 'missing_start',
      detail: `trip_date ${trip.tripDate} with start_time ${trip.startTime ?? 'null'}`,
    };
  }

  const endSec = secondOfDay(trip.endTime);
  if (endSec == null) {
    return {
      tripId: trip.id,
      problem: 'missing_end',
      detail: `trip_date ${trip.tripDate} with end_time ${trip.endTime ?? 'null'}`,
    };
  }

  const startMs = midnight + startSec * 1000;
  // A ride ending at or before its start crossed midnight. One day is added in
  // milliseconds rather than by mutating the date, which is correct here because
  // the shift is within a single ride and cannot span a DST boundary twice.
  const endMs = endSec > startSec
    ? midnight + endSec * 1000
    : midnight + endSec * 1000 + 24 * 60 * 60 * 1000;

  return { trip, startMs, endMs, timeSource: 'date_and_clock' };
}

/**
 * Builds the vehicle blocks for one month's rides.
 *
 * Deterministic: the same rides and the same `switchMinutes` always produce the
 * same blocks, in the same order.
 */
export function buildBlocks(
  trips: PlanTripInput[],
  options: BuildBlocksOptions,
): BuildBlocksResult {
  const switchMinutes = Number.isFinite(options.switchMinutes) && options.switchMinutes >= 0
    ? Math.floor(options.switchMinutes)
    : 0;
  // Same rule as `switchMinutes`: a value is read as given, and only a missing or
  // nonsensical one falls back — to 0, "no minimum", never to the default 90. A
  // default written for an omitted value is how a gate gets disabled silently.
  const minBlockMinutes = Number.isFinite(options.minBlockMinutes ?? NaN)
    && (options.minBlockMinutes as number) > 0
    ? Math.floor(options.minBlockMinutes as number)
    : 0;

  const rejected: RejectedTrip[] = [];
  const overlaps: VehicleOverlap[] = [];
  let canceledCount = 0;

  // Group by vehicle. §3: "build the blocks independently for each vehicle" and
  // "do not merge different vehicles into one block". Grouping first makes that
  // true by construction rather than by a later check.
  const byVehicle = new Map<string, ResolvedTrip[]>();

  for (const trip of trips) {
    if (trip.isCanceled) {
      // §7: a cancelled ride is never counted. It is not a problem, so it is
      // counted separately rather than reported as rejected.
      canceledCount++;
      continue;
    }

    const vehicleId = trip.vehicleId ?? trip.vehicleIdentifier;
    if (!vehicleId) {
      rejected.push({
        tripId: trip.id,
        problem: 'missing_vehicle',
        detail: 'neither car_id nor car_identifier is set',
      });
      continue;
    }

    const resolved = resolveTrip(trip);
    if ('problem' in resolved) {
      rejected.push(resolved);
      continue;
    }

    const list = byVehicle.get(vehicleId);
    if (list) list.push(resolved);
    else byVehicle.set(vehicleId, [resolved]);
  }

  const blocks: PlanBlock[] = [];

  // Vehicle order is sorted so the output is stable across runs; a Map preserves
  // insertion order, which depends on the input order and would make two
  // identical plans differ in block ids.
  for (const vehicleId of [...byVehicle.keys()].sort()) {
    const list = byVehicle.get(vehicleId)!;

    // §3: "order the rides by their start". Ties broken by id, again for
    // determinism — two rides of one car starting at the same instant is itself
    // an overlap and is reported below.
    list.sort((a, b) => a.startMs - b.startMs || a.trip.id.localeCompare(b.trip.id));

    // §14: overlapping rides of the same vehicle. Reported, and the rides are
    // still used — they are real data, and dropping them would understate the
    // month. The block's `rideMinutes` therefore double-counts an overlap, which
    // is why the overlap is surfaced for someone to resolve.
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (cur.startMs < prev.endMs) {
        overlaps.push({
          vehicleId,
          firstTripId: prev.trip.id,
          secondTripId: cur.trip.id,
          overlapMinutes: minutesBetween(cur.startMs, Math.min(prev.endMs, cur.endMs)),
        });
      }
    }

    let current: ResolvedTrip[] = [];

    const flush = () => {
      if (current.length === 0) return;
      const startMs = current[0].startMs;
      // Not `current[current.length - 1].endMs`: an overlapping or fully
      // contained ride can end before an earlier one, and the block ends at the
      // latest end it holds.
      const endMs = current.reduce((max, r) => Math.max(max, r.endMs), current[0].endMs);

      const trips: PlanBlockTrip[] = current.map(r => ({
        tripId: r.trip.id,
        startMs: r.startMs,
        endMs: r.endMs,
        minutes: minutesBetween(r.startMs, r.endMs),
        timeSource: r.timeSource,
        originalDriverName: r.trip.originalDriverName ?? null,
      }));

      blocks.push({
        id: `${vehicleId}|${startMs}`,
        vehicleId,
        vehicleIdentifier: current[0].trip.vehicleIdentifier ?? null,
        startMs,
        endMs,
        spanMinutes: minutesBetween(startMs, endMs),
        rideMinutes: trips.reduce((sum, t) => sum + t.minutes, 0),
        trips,
        driverId: null,
        driverName: null,
      });
      current = [];
    };

    for (const resolved of list) {
      if (current.length === 0) {
        current.push(resolved);
        continue;
      }

      // The gap is measured from the block's latest end so far, not from the
      // previous ride's end: inside a block with an overlap, the previous ride
      // may end earlier than one before it, and using it would open a boundary
      // that the vehicle was not actually free for.
      const blockEndMs = current.reduce((max, r) => Math.max(max, r.endMs), current[0].endMs);
      const gapMinutes = minutesBetween(blockEndMs, resolved.startMs);

      if (gapMinutes >= switchMinutes) {
        // A boundary is permitted, and §3 asks for the shortest blocks, so take it.
        flush();
      }
      current.push(resolved);
    }
    flush();
  }

  const merged = minBlockMinutes > 0 ? mergeShortBlocks(blocks, minBlockMinutes) : blocks;

  // Chronological across vehicles, so the screen reads as a month rather than as
  // a list of cars. Tie-broken on the block id, which already carries the vehicle.
  merged.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));

  const shortBlocks = minBlockMinutes > 0
    ? merged
        .filter(block => block.spanMinutes < minBlockMinutes)
        .map(block => ({ blockId: block.id, spanMinutes: block.spanMinutes }))
    : [];

  return { blocks: merged, rejected, overlaps, canceledCount, shortBlocks };
}

/**
 * Joins blocks shorter than `minBlockMinutes` to a neighbour, within one vehicle
 * and one local day.
 *
 * ## What bounds it, and why those bounds
 *
 * - **One vehicle.** §3's first rule: two vehicles never share a block. Grouping
 *   by vehicle is how that stays true by construction rather than by a check.
 * - **One local day.** Without it the pass would join a car's last ride of Monday
 *   to its first of Tuesday across a nine-hour gap, which is not a shift, and it
 *   would do so across a DST boundary where the gap in hours is not the gap in
 *   clock time. The day is the local calendar day of the block's START, read from
 *   `localDateKey`, which is the same instant-to-day rule the rest of the engine
 *   uses. A block that itself crosses midnight belongs to the day it started.
 * - **The smaller gap first.** The shortest block is merged with whichever
 *   neighbour it sits closer to, so the absorbed idle time is the least available.
 *   A tie goes to the earlier neighbour, so the result does not depend on
 *   iteration order.
 *
 * ## No maximum, deliberately
 *
 * Merging can produce a long block — a quiet day whose three short runs are
 * hours apart becomes one long, mostly idle block. That is refused where it
 * should be: §7's daily maximum and working-time window are checked per driver
 * at assignment, where a refusal is shown with its reason. Capping it here would
 * hide the same outcome as a silently short block instead.
 *
 * Pure, and it returns new blocks rather than mutating: the ids of merged blocks
 * disappear, and a caller holding one would otherwise read a block that no longer
 * describes the month.
 */
function mergeShortBlocks(blocks: PlanBlock[], minBlockMinutes: number): PlanBlock[] {
  const byVehicleDay = new Map<string, PlanBlock[]>();
  for (const block of blocks) {
    const key = `${block.vehicleId}|${localDateKey(block.startMs)}`;
    const group = byVehicleDay.get(key);
    if (group) group.push(block);
    else byVehicleDay.set(key, [block]);
  }

  const out: PlanBlock[] = [];

  for (const group of byVehicleDay.values()) {
    let current = [...group].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));

    // Each pass merges exactly one pair, so the loop cannot run more times than
    // there are blocks in the group.
    for (let guard = current.length; guard > 0 && current.length > 1; guard--) {
      let shortestIndex = -1;
      for (let i = 0; i < current.length; i++) {
        if (current[i].spanMinutes >= minBlockMinutes) continue;
        if (shortestIndex < 0 || current[i].spanMinutes < current[shortestIndex].spanMinutes) {
          shortestIndex = i;
        }
      }
      if (shortestIndex < 0) break; // nothing left under the minimum

      const before = shortestIndex > 0 ? current[shortestIndex - 1] : null;
      const after = shortestIndex < current.length - 1 ? current[shortestIndex + 1] : null;
      const gapBefore = before ? current[shortestIndex].startMs - before.endMs : Infinity;
      const gapAfter = after ? after.startMs - current[shortestIndex].endMs : Infinity;

      // `<=` so a tie takes the earlier neighbour.
      const mergeWithBefore = before !== null && gapBefore <= gapAfter;
      const first = mergeWithBefore ? shortestIndex - 1 : shortestIndex;
      const second = mergeWithBefore ? shortestIndex : shortestIndex + 1;

      current = [
        ...current.slice(0, first),
        joinBlocks(current[first], current[second]),
        ...current.slice(second + 1),
      ];
    }

    out.push(...current);
  }

  return out;
}

/**
 * Two blocks of one vehicle as one.
 *
 * The id is the earlier block's, which is `vehicleId|startMs` and still describes
 * the result. `rideMinutes` is the sum of the member rides and is therefore
 * unchanged by the join — only `spanMinutes` grows, by the gap absorbed.
 */
function joinBlocks(first: PlanBlock, second: PlanBlock): PlanBlock {
  const startMs = Math.min(first.startMs, second.startMs);
  const endMs = Math.max(first.endMs, second.endMs);
  const trips = [...first.trips, ...second.trips].sort((a, b) => a.startMs - b.startMs);

  return {
    ...first,
    id: `${first.vehicleId}|${startMs}`,
    startMs,
    endMs,
    spanMinutes: minutesBetween(startMs, endMs),
    rideMinutes: trips.reduce((sum, trip) => sum + trip.minutes, 0),
    trips,
  };
}

/**
 * Decimal hours for display only. Never feed this back into arithmetic —
 * `spanMinutes` and `rideMinutes` are the figures that add up.
 *
 * 81 minutes is 1.35 hours (§3, §16).
 */
export function minutesToDecimalHours(minutes: number): number {
  return minutes / 60;
}
