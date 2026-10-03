/**
 * Monthly plan â€” building ride blocks per vehicle (requirement آ§3).
 *
 * ## The rule, and it is the whole of آ§3
 *
 * Blocks are built **independently for each vehicle**; two vehicles never share a
 * block. Within a vehicle, rides are ordered by their start and walked once. The
 * gap between one ride's end and the next ride's start decides the boundary:
 *
 *   - gap **>= switchMinutes** â†’ a boundary *may* be created, and آ§3 also says
 *     "make the blocks as short as possible", so one *is* created;
 *   - gap **< switchMinutes** â†’ the two rides **must** stay in the same block.
 *
 * That is the only splitting criterion. This is deliberately narrower than the
 * existing `monatsplanungPhase1.ts`, which splits on a separate 60-minute
 * `blockSeparatorGap` and then runs a min/max-duration merge pass â€” three knobs
 * where آ§3 specifies one. That module keeps its behaviour for its own pipeline;
 * this one implements the requirement.
 *
 * ## Minutes, and the figure آ§16 pins
 *
 * Every duration here is **integer minutes**, computed from absolute
 * milliseconds. آ§3's own example: 08:23 â†’ 09:44 is 81 minutes, which is 1.35
 * decimal hours â€” not 1.21. The 1.21 error comes from reading `09:44 - 08:23` as
 * a decimal subtraction (1.21); nothing in this module can produce it, because
 * nothing here subtracts clock faces.
 *
 * Two durations are stored per block and they are **not** the same number:
 *
 *   - `spanMinutes` â€” end minus start, the wall-clock length of the block;
 *   - `rideMinutes` â€” the sum of the actual rides, which آ§3 asks for explicitly
 *     and the existing pipeline does not store at all.
 *
 * `spanMinutes - rideMinutes` is the idle time inside the block. Keeping them
 * apart is what lets a later document decide whether idle time is paid without
 * re-deriving it â€” the ambiguity that currently makes the Stundennachweis and the
 * on-screen total disagree for 92.5% of driver-days.
 *
 * ## Absolute instants, never clock strings
 *
 * Intervals are built from epoch milliseconds. A ride that starts at 23:40 and
 * ends at 00:20 crosses midnight, and comparing `"00:20" < "23:40"` as strings â€”
 * or parsing a bare `HH:MM:SS`, which yields 0 â€” is the defect CLAUDE.md warns
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

/**
 * The longest block the screen offers by default, in minutes.
 *
 * 360 â€” six hours, the figure the owner named on 01.10.2026. A default and not a
 * rule: the control on screen 2 sets it per run, and 0 there means no maximum.
 */
export const DEFAULT_MAX_BLOCK_MINUTES = 360;

/** Where a ride's instants came from, so nothing is silently guessed. */
export type TripTimeSource = 'instants' | 'date_and_clock' | 'unusable';

/** The ride fields this module reads. A subset of `fahrtenbuch_trips`. */
export interface PlanTripInput {
  id: string;
  /** `car_id`, or `car_identifier` when the car is not in the fleet table. */
  vehicleId: string | null;
  vehicleIdentifier: string | null;
  /** `start_at` / `end_at` â€” the ride's real instants. Preferred. */
  startAt?: string | null;
  endAt?: string | null;
  /** `trip_date` (`YYYY-MM-DD`) plus `start_time` / `end_time` (`HH:MM[:SS]`). */
  tripDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  /** `is_canceled`. A cancelled ride is never counted and never blocked (آ§7). */
  isCanceled?: boolean | null;
  /** `original_driver_name`, kept for the pre-selection suggestion only (آ§2). */
  originalDriverName?: string | null;
  originalDriverId?: string | null;
}

/** Why a ride could not be placed. Each is surfaced, never swallowed (آ§14). */
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

/** Two rides of the same vehicle that overlap in the source data (آ§14). */
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
  /** Sum of the member rides' own minutes. آ§3 asks for this explicitly. */
  rideMinutes: number;
  trips: PlanBlockTrip[];
  /**
   * Filled by the assignment step, not here. آ§3 lists it among a block's stored
   * fields, and keeping it on the block â€” rather than in a parallel map â€” is what
   * makes a block self-describing when a document reads it later.
   */
  driverId: string | null;
  driverName: string | null;
}

export interface BuildBlocksOptions {
  /**
   * The user's switch duration in minutes, from screen 2 (آ§1). A gap of exactly
   * this length may split; anything shorter may not.
   *
   * 0 is legal and means "split at every gap", which is the shortest possible
   * blocking. It is not treated as "unset" â€” the existing pipeline's migration
   * header records why that distinction matters: a default written for an omitted
   * value once disabled the gate it was meant to enforce.
   */
  switchMinutes: number;
  /**
   * The shortest block the screen may offer a driver, in minutes. Omitted or 0
   * means no minimum, which is what آ§3 alone produces.
   *
   * The owner asked for this on 01.10.2026: the gap rule alone cuts a quiet day
   * into fifteen-minute blocks, and a fifteen-minute block is not a shift anybody
   * can be sent out on. It is a control on screen 1, not a constant, because the
   * right figure is a fleet's own â€” the default is 90.
   *
   * **It merges; it never pads.** A short block is joined to a neighbouring block
   * of the SAME VEHICLE on the SAME LOCAL DAY, so no working time is invented and
   * no ride moves. What grows is the block's `spanMinutes` â€” the car is booked
   * across the gap it absorbed â€” while `rideMinutes` is the same sum it always
   * was. That is exactly the distinction آ§3 keeps the two figures apart for, and
   * the difference shows on screen as idle time.
   */
  minBlockMinutes?: number;
  /**
   * The longest block the merge may produce, in minutes. Omitted or 0 means no
   * maximum.
   *
   * It bounds the merge above as `minBlockMinutes` drives it below, and the two
   * are read together: a short block is joined to a neighbour only while the
   * result stays within this. Without it the merge produced a ten-hour block of
   * which six hours were idle, which is what the owner reported.
   *
   * **It never splits a block.** The gap rule has already split at every gap of at
   * least `switchMinutes`, so a block longer than this contains only gaps SHORTER
   * than the switch duration â€” there is no point in it where a driver or vehicle
   * could change, and a single ride cannot be cut at all. Such a block is reported
   * in `longBlocks` instead, which is the honest answer rather than a sheet that
   * claims a change of hands that could not happen.
   */
  maxBlockMinutes?: number;
  /**
   * Split a block that exceeds `maxBlockMinutes` by widening a gap it already
   * has, so two drivers can share it. Off unless asked for.
   *
   * It needs `maxBlockMinutes` to know which blocks are too long and
   * `switchMinutes` to know how wide the gap must be, so it does nothing without
   * both. The rides that fall inside the widened gap are **given up** â€” reported
   * in `handoverTrips`, assigned to nobody â€” because during a handover nobody is
   * driving. Measured on real data: exactly one ride per split, which is the floor
   * rather than a tuning choice.
   *
   * Off by default because giving up a ride is a decision about a month's revenue,
   * and a default that quietly does it is a default that decides for the operator.
   */
  splitLongBlocks?: boolean;
}

export interface BuildBlocksResult {
  blocks: PlanBlock[];
  rejected: RejectedTrip[];
  overlaps: VehicleOverlap[];
  /** Rides excluded because `is_canceled` â€” counted, not a problem. */
  canceledCount: number;
  /**
   * Blocks still under `minBlockMinutes` after the merge pass, with the length
   * they have, **and why each one stayed short**. Surfaced rather than padded or
   * dropped (آ§14).
   *
   * - `alone_on_day` â€” that vehicle has no other block on that day, so there is
   *   nothing to merge with. A car that drove once for twelve minutes has a
   *   twelve-minute block, and padding it would invent time.
   * - `ceiling` â€” there **is** a neighbour, and merging would run past
   *   `maxBlockMinutes`. The two bounds pull against each other here, and the
   *   operator's lever is the maximum, not the minimum.
   *
   * The distinction exists because the screen reported `alone_on_day` for every
   * short block, and on a real month that was wrong for 39 of 45 â€” an operator
   * told the wrong reason has no way to act on it.
   */
  shortBlocks: { blockId: string; spanMinutes: number; reason: 'alone_on_day' | 'ceiling' }[];
  /**
   * Blocks longer than `maxBlockMinutes`, with the length they have.
   *
   * Reported and never split, for the reason in `maxBlockMinutes` above. A block
   * is on this list only when the rides themselves run that long with no gap big
   * enough to part them.
   */
  longBlocks: { blockId: string; spanMinutes: number }[];
  /**
   * Rides given up so a long block could be split, with the block they came from.
   *
   * Named rather than silently absent: a ride that leaves the plan without being
   * accounted for is indistinguishable from a defect, and this is a deliberate
   * trade the operator agreed to by turning the option on. The screen lists them.
   */
  handoverTrips: {
    tripId: string;
    /** The block as it was before the split, by its id at that moment. */
    blockId: string;
    vehicleId: string;
    startMs: number;
    endMs: number;
  }[];
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
 * it computed itself â€” building the instant from `date-midnight + secondOfDay`
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
 * on the clock path is read as crossing midnight and moved to the next day â€”
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
  // nonsensical one falls back â€” to 0, "no minimum", never to the default 90. A
  // default written for an omitted value is how a gate gets disabled silently.
  const minBlockMinutes = Number.isFinite(options.minBlockMinutes ?? NaN)
    && (options.minBlockMinutes as number) > 0
    ? Math.floor(options.minBlockMinutes as number)
    : 0;
  const maxBlockMinutes = Number.isFinite(options.maxBlockMinutes ?? NaN)
    && (options.maxBlockMinutes as number) > 0
    ? Math.floor(options.maxBlockMinutes as number)
    : 0;
  // Needs both bounds to mean anything: the maximum says which block is too long,
  // the switch duration says how wide the gap has to be. Without either it is off,
  // whatever the flag says, rather than guessing one of them.
  const splitLongBlocks = options.splitLongBlocks === true
    && maxBlockMinutes > 0 && switchMinutes > 0;

  const rejected: RejectedTrip[] = [];
  const overlaps: VehicleOverlap[] = [];
  let canceledCount = 0;

  // Group by vehicle. آ§3: "build the blocks independently for each vehicle" and
  // "do not merge different vehicles into one block". Grouping first makes that
  // true by construction rather than by a later check.
  const byVehicle = new Map<string, ResolvedTrip[]>();

  for (const trip of trips) {
    if (trip.isCanceled) {
      // آ§7: a cancelled ride is never counted. It is not a problem, so it is
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

    // آ§3: "order the rides by their start". Ties broken by id, again for
    // determinism â€” two rides of one car starting at the same instant is itself
    // an overlap and is reported below.
    list.sort((a, b) => a.startMs - b.startMs || a.trip.id.localeCompare(b.trip.id));

    // آ§14: overlapping rides of the same vehicle. Reported, and the rides are
    // still used â€” they are real data, and dropping them would understate the
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
        // A boundary is permitted, and آ§3 asks for the shortest blocks, so take it.
        flush();
      }
      current.push(resolved);
    }
    flush();
  }

  const merged = minBlockMinutes > 0
    ? mergeShortBlocks(blocks, minBlockMinutes, maxBlockMinutes)
    : blocks;

  // Chronological across vehicles, so the screen reads as a month rather than as
  // a list of cars. Tie-broken on the block id, which already carries the vehicle.
  merged.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));

  // **Why** a short block stayed short, not merely that it did.
  //
  // The screen said "that vehicle has no other block on that day to merge with"
  // for every one of them, and on the owner's own August that sentence was wrong
  // for **39 of 45**: those blocks do have a same-day neighbour, and the merge was
  // refused because joining them would run past `maxBlockMinutes`. The two bounds
  // pull against each other â€” the minimum wants a merge, the maximum forbids it â€”
  // and an operator told the wrong reason reads a working pass as a broken one,
  // which is exactly what happened on 03.10.2026.
  //
  // Measured on 2209 real rides: 6 genuinely alone on their day, 39 blocked by the
  // ceiling. So the distinction is not hypothetical and it is not rare.
  const sameVehicleDay = new Map<string, number>();
  for (const block of merged) {
    const key = `${block.vehicleId}|${localDateKey(block.startMs)}`;
    sameVehicleDay.set(key, (sameVehicleDay.get(key) ?? 0) + 1);
  }
  const shortBlocks = minBlockMinutes > 0
    ? merged
        .filter(block => block.spanMinutes < minBlockMinutes)
        .map(block => ({
          blockId: block.id,
          spanMinutes: block.spanMinutes,
          reason: (sameVehicleDay.get(`${block.vehicleId}|${localDateKey(block.startMs)}`) ?? 0) > 1
            ? 'ceiling' as const
            : 'alone_on_day' as const,
        }))
    : [];

  const split = splitLongBlocks
    ? splitAtWidestGap(merged, maxBlockMinutes, switchMinutes, minBlockMinutes)
    : { blocks: merged, handoverTrips: [] as BuildBlocksResult['handoverTrips'] };

  split.blocks.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));

  // Reported AFTER the split, so a block the split dealt with is not also listed
  // as a problem. What stays on this list is what could not be split at all.
  const longBlocks = maxBlockMinutes > 0
    ? split.blocks
        .filter(block => block.spanMinutes > maxBlockMinutes)
        .map(block => ({ blockId: block.id, spanMinutes: block.spanMinutes }))
    : [];

  return {
    blocks: split.blocks,
    rejected,
    overlaps,
    canceledCount,
    shortBlocks,
    longBlocks,
    handoverTrips: split.handoverTrips,
  };
}

/**
 * Joins blocks shorter than `minBlockMinutes` to a neighbour, within one vehicle
 * and one local day.
 *
 * ## What bounds it, and why those bounds
 *
 * - **One vehicle.** آ§3's first rule: two vehicles never share a block. Grouping
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
 * ## The ceiling, added 01.10.2026
 *
 * This pass shipped with no maximum, on the argument that آ§7's daily maximum and
 * working-time window would refuse an absurd result per driver at assignment. The
 * owner read the first screen it produced and overruled it, rightly: the block
 * was `06:00-16:00, 10,00 h, 4 Fahrten, davon Leerlauf 6,00` â€” ten hours of which
 * six were waiting, which آ§7 would happily assign and no operator would send
 * anybody out on.
 *
 * So `maxBlockMinutes` bounds the join: a merge that would exceed it is not
 * available, and a short block with no neighbour that fits stays short and is
 * reported. The earlier argument was not wrong about آ§7 â€” it was wrong that a
 * refusal at assignment is the same thing as not building the block.
 *
 * Pure, and it returns new blocks rather than mutating: the ids of merged blocks
 * disappear, and a caller holding one would otherwise read a block that no longer
 * describes the month.
 */
function mergeShortBlocks(
  blocks: PlanBlock[],
  minBlockMinutes: number,
  maxBlockMinutes: number,
): PlanBlock[] {
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

    // Blocks that are short and have no neighbour the ceiling allows. They are
    // skipped rather than ending the pass: the first version of the ceiling broke
    // out of the loop on the first stuck block, which left every OTHER short block
    // on that day unmerged â€” a correct refusal for one block silently becoming a
    // refusal for all of them.
    const stuck = new Set<string>();

    // Each pass either merges one pair or marks one block stuck, so the loop
    // cannot run more times than twice the number of blocks in the group.
    for (let guard = current.length * 2; guard > 0 && current.length > 1; guard--) {
      let shortestIndex = -1;
      for (let i = 0; i < current.length; i++) {
        if (current[i].spanMinutes >= minBlockMinutes) continue;
        if (stuck.has(current[i].id)) continue;
        if (shortestIndex < 0 || current[i].spanMinutes < current[shortestIndex].spanMinutes) {
          shortestIndex = i;
        }
      }
      if (shortestIndex < 0) break; // nothing left that is short and still joinable

      const short = current[shortestIndex];
      const before = shortestIndex > 0 ? current[shortestIndex - 1] : null;
      const after = shortestIndex < current.length - 1 ? current[shortestIndex + 1] : null;

      // The ceiling, which is the whole of the owner's "not more than six hours":
      // a join whose result would exceed it is not available at all. Without this
      // the pass produced a ten-hour block of which six hours were idle, by
      // chaining short runs across a quiet day.
      const fits = (other: PlanBlock | null): boolean => {
        if (!other) return false;
        if (maxBlockMinutes <= 0) return true;
        const startMs = Math.min(short.startMs, other.startMs);
        const endMs = Math.max(short.endMs, other.endMs);
        return minutesBetween(startMs, endMs) <= maxBlockMinutes;
      };

      const gapBefore = fits(before) ? short.startMs - before!.endMs : Infinity;
      const gapAfter = fits(after) ? after!.startMs - short.endMs : Infinity;

      // Neither neighbour can take it without breaking the ceiling: it stays short
      // and is reported, which is better than a block nobody can be sent out on.
      // Marked rather than breaking, so the other short blocks of the day are
      // still considered.
      if (gapBefore === Infinity && gapAfter === Infinity) {
        stuck.add(short.id);
        continue;
      }

      // `<=` so a tie takes the earlier neighbour.
      const mergeWithBefore = gapBefore <= gapAfter;
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
 * Splits every block that is too long, at the widest gap it already has.
 *
 * Repeated until nothing can be split further, so a fourteen-hour block becomes
 * three shifts rather than one long one and one slightly shorter. The guard bounds
 * it at the number of blocks: each pass either splits one or marks it finished.
 */
function splitAtWidestGap(
  blocks: PlanBlock[],
  maxBlockMinutes: number,
  switchMinutes: number,
  minBlockMinutes: number,
): { blocks: PlanBlock[]; handoverTrips: BuildBlocksResult['handoverTrips'] } {
  let current = [...blocks];
  const handoverTrips: BuildBlocksResult['handoverTrips'] = [];
  // Blocks that are too long and cannot be parted. Marked so the loop moves on
  // rather than retrying them, and so they still reach `longBlocks`.
  const settled = new Set<string>();

  for (let guard = current.length * 4; guard > 0; guard--) {
    const index = current.findIndex(block =>
      block.spanMinutes > maxBlockMinutes && !settled.has(block.id));
    if (index < 0) break;

    const block = current[index];
    const result = splitOnce(block, switchMinutes, minBlockMinutes);
    if (!result) {
      settled.add(block.id);
      continue;
    }

    handoverTrips.push(...result.given.map(trip => ({
      tripId: trip.tripId,
      blockId: block.id,
      vehicleId: block.vehicleId,
      startMs: trip.startMs,
      endMs: trip.endMs,
    })));
    current = [...current.slice(0, index), ...result.parts, ...current.slice(index + 1)];
  }

  return { blocks: current, handoverTrips };
}

/**
 * One split of one block, or null when it cannot be parted.
 *
 * The gap is chosen from the **middle half**: the widest gap overall could sit ten
 * minutes from the start, and splitting there gives the second driver ten minutes
 * of work. A split that would leave either part under `minBlockMinutes` is refused
 * for the same reason â€” it would undo what the merge pass just did.
 */
function splitOnce(
  block: PlanBlock,
  switchMinutes: number,
  minBlockMinutes: number,
): { parts: PlanBlock[]; given: PlanBlockTrip[] } | null {
  const trips = [...block.trips].sort((a, b) => a.startMs - b.startMs);
  if (trips.length < 2) return null; // a single ride is never cut

  const span = block.endMs - block.startMs;
  const windowStart = block.startMs + span * 0.25;
  const windowEnd = block.startMs + span * 0.75;
  const gapMs = switchMinutes * MS_PER_MINUTE;

  let best: { atMs: number; gap: number } | null = null;
  let runningEnd = trips[0].endMs;
  for (let i = 1; i < trips.length; i++) {
    const gap = trips[i].startMs - runningEnd;
    // `runningEnd` and not the previous ride's end: inside a block with an
    // overlap an earlier ride can finish later, and the vehicle is not free until
    // the latest of them is done.
    if (gap > 0 && runningEnd >= windowStart && runningEnd <= windowEnd) {
      if (!best || gap > best.gap) best = { atMs: runningEnd, gap };
    }
    runningEnd = Math.max(runningEnd, trips[i].endMs);
  }
  if (!best) return null;

  const handoverEnd = best.atMs + gapMs;
  const before = trips.filter(trip => trip.startMs < best!.atMs);
  const given = trips.filter(trip => trip.startMs >= best!.atMs && trip.startMs < handoverEnd);
  const after = trips.filter(trip => trip.startMs >= handoverEnd);
  if (before.length === 0 || after.length === 0) return null;

  const first = blockFrom(block, before);
  const second = blockFrom(block, after);
  // Refused rather than done badly: a part under the minimum is the very thing the
  // merge pass exists to prevent, and producing one here would have the two passes
  // undoing each other.
  if (minBlockMinutes > 0
      && (first.spanMinutes < minBlockMinutes || second.spanMinutes < minBlockMinutes)) {
    return null;
  }

  return { parts: [first, second], given };
}

/** A block over a subset of another's rides. Keeps every rule `flush` applies. */
function blockFrom(source: PlanBlock, trips: PlanBlockTrip[]): PlanBlock {
  const startMs = trips[0].startMs;
  const endMs = trips.reduce((max, trip) => Math.max(max, trip.endMs), trips[0].endMs);
  return {
    ...source,
    id: `${source.vehicleId}|${startMs}`,
    startMs,
    endMs,
    spanMinutes: minutesBetween(startMs, endMs),
    rideMinutes: trips.reduce((sum, trip) => sum + trip.minutes, 0),
    trips,
    driverId: null,
    driverName: null,
  };
}

/**
 * Two blocks of one vehicle as one.
 *
 * The id is the earlier block's, which is `vehicleId|startMs` and still describes
 * the result. `rideMinutes` is the sum of the member rides and is therefore
 * unchanged by the join â€” only `spanMinutes` grows, by the gap absorbed.
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
 * Decimal hours for display only. Never feed this back into arithmetic â€”
 * `spanMinutes` and `rideMinutes` are the figures that add up.
 *
 * 81 minutes is 1.35 hours (آ§3, آ§16).
 */
export function minutesToDecimalHours(minutes: number): number {
  return minutes / 60;
}
