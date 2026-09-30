/**
 * Monthly plan — distributing blocks to drivers (requirements §7 and §8).
 *
 * ## The hard rules are a closed list
 *
 * §7 names nine constraints that may never be broken, and this module enforces
 * exactly those — no tenth is invented:
 *
 *   1. a block takes at most one driver          — by construction (one map)
 *   2. no two overlapping blocks for one driver  — checked per candidate
 *   3. a regular driver never exceeds the
 *      effective hours cap                       — checked per candidate;
 *                                                  the owner is exempt (§8)
 *   4. no assignment inside an exclusion window  — checked per candidate
 *   5. mandatory inclusion respected, or a
 *      conflict shown                            — pins are placed first, and a
 *                                                  pin that would break another
 *                                                  hard rule becomes a visible
 *                                                  conflict, never a silent drop
 *   6. trip times and order never change         — nothing here touches a trip
 *   7. no block is split against the switch
 *      duration                                  — nothing here splits a block
 *   8. no assignment to a non-selected driver    — the pool is the input
 *   9. regeneration relaxes nothing              — the seed reaches only the
 *                                                  tie-break between candidates
 *                                                  that already passed 1–8
 *
 * One derived check: a driver moving between two blocks on **different**
 * vehicles needs the switch duration between them. The screen-2 field is
 * literally "the duration for switching driver or car between blocks", and a
 * 10-minute hop between two cars when switching takes 30 is physically the same
 * impossibility as an overlap. Same-vehicle consecutive blocks already carry the
 * gap by construction (§3), so only the cross-vehicle case is checked.
 *
 * ## The owner is a fallback, not a participant with a quota (§8)
 *
 * The owner wins a block **only when no regular driver passes the hard rules**
 * for it. This is the deliberate difference from the existing engine, whose
 * owner has a 20% share target and scores 600k–1M — equal to a below-minimum
 * employee — and is sorted first in its coverage pass. §8 says the opposite
 * three times: no early use, surplus only, and an uncoverable block with no
 * owner stays unassigned with a warning rather than a broken constraint.
 *
 * ## No repair pass, deliberately
 *
 * The existing `repairFinalOverlaps` resolves conflicts by **moving blocks in
 * time**. Nothing here may do that (§7 rule 6, and the project's recorded
 * boundary of 22.09.2026: never an engine function that shifts a block's time).
 * A block this pass cannot place validly is reported unassigned — §8's own
 * instruction — and a person decides.
 */

import type { PlanBlock } from './blocks';
import {
  computeHoursRange,
  assessAgainstRange,
  type HoursRange,
  type HoursRangeInput,
  type RangeAssessment,
} from './hoursRange';
import {
  findExclusion,
  type AvailabilityResult,
  type PlanNote,
} from './availability';

/** The driver fields the assigner reads. §4: reuse what the model has. */
export interface PlanDriverInput {
  id: string;
  name: string;
  /** `employment_type === 'company_owner'` (§8). */
  isOwner: boolean;
  /** Inputs for `computeHoursRange` (§5). `target_monthly_hours` has no field here on purpose. */
  minSalary: number | null;
  maxSalary: number | null;
  hourlyRate: number | null;
  maxMonthlyHours?: number | null;
  /**
   * `drivers.planning_priority` (default 100). §7: "use the planning priority
   * as a deciding factor". The column has no documented direction anywhere in
   * the schema or the product, so this engine defines it once: **higher wins**,
   * and only between candidates that are equal on everything else.
   */
  planningPriority?: number | null;
  /**
   * `drivers.can_cover_other_drivers`. §4 lists it among the data to use; §7's
   * hard list does not include it, so it is a preference, never a refusal: a
   * non-covering driver is deprioritised for blocks that originally belonged to
   * a different selected driver, and still takes them when nobody else can.
   */
  canCoverOtherDrivers?: boolean | null;
}

/** Why a driver was refused a block. Only §7's reasons — the list is closed. */
export type AssignRefusal =
  | 'driver_overlap'          // rule 2
  | 'exceeds_hours_cap'       // rule 3
  | 'excluded_by_note'        // rule 4
  | 'vehicle_switch_gap'      // the derived cross-vehicle check
  | 'no_usable_range';        // §5/§14: rate or salary unusable — a config error, surfaced

export type AssignmentReason =
  | 'mandatory_note'   // rule 5 — pinned
  | 'only_candidate'   // exactly one driver passed the hard rules
  | 'best_fit'         // scored choice
  | 'seeded_tie'       // equal scores, the seed decided (the one flexible choice)
  | 'owner_fallback';  // §8 — no regular driver passed

export interface BlockAssignment {
  blockId: string;
  driverId: string;
  driverName: string;
  reason: AssignmentReason;
  /** The pin's note id when `reason === 'mandatory_note'`. */
  noteId?: string;
}

export interface UnassignedBlock {
  blockId: string;
  /** Every pool driver's refusal, so the screen can say why, per §14. */
  refusals: { driverId: string; refusal: AssignRefusal }[];
  /** §8: true when even the owner could not take it (or none exists). */
  ownerConsidered: boolean;
}

/** A pin that could not be placed without breaking another hard rule (§7.5). */
export interface PinConflict {
  blockId: string;
  driverId: string;
  noteId: string;
  brokenRule: AssignRefusal;
}

export interface DriverPlanState {
  driver: PlanDriverInput;
  range: HoursRange;
  assignedBlockIds: string[];
  minutes: number;       // integer span minutes, the figure the cap reads
  rideMinutes: number;   // integer ride minutes, reported beside it
  tripCount: number;
  assessment: RangeAssessment;
}

export interface AssignOptions {
  /** The operator's switch duration in minutes — the same value §3 built with. */
  switchMinutes: number;
  /**
   * Regeneration counter. 0 is the first plan; each "Neu generieren" passes the
   * next integer. Identical inputs and seed give an identical plan; a new seed
   * may swap only candidates whose scores tie (§7 rule 9, acceptance 14).
   */
  seed?: number;
}

export interface AssignResult {
  assignments: BlockAssignment[];
  unassigned: UnassignedBlock[];
  pinConflicts: PinConflict[];
  driverStates: DriverPlanState[];
}

const MS_PER_MINUTE = 60_000;

/**
 * FNV-1a over a string, for the seeded tie-break. A tiny stable hash rather
 * than `Math.random()`, because a plan must be reproducible from its seed —
 * the regenerate button's contract is "another valid alternative", not "a
 * different plan every render".
 */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface DriverWork {
  state: DriverPlanState;
  /** Assigned intervals, kept sorted by start, for rules 2 and the switch gap. */
  intervals: { startMs: number; endMs: number; vehicleId: string }[];
}

/** Hard rules 2–4 plus the cross-vehicle gap, in one place, in a fixed order. */
function refusalFor(
  work: DriverWork,
  block: PlanBlock,
  availability: AvailabilityResult,
  switchMinutes: number,
): AssignRefusal | null {
  const driver = work.state.driver;

  // Rule 4 first: an excluded driver is out regardless of arithmetic, and the
  // order fixes which reason a doubly-refused candidate reports.
  if (findExclusion(availability, driver.id, block.startMs, block.endMs)) {
    return 'excluded_by_note';
  }

  // §5/§14: a regular driver without a usable range has no cap to check, and
  // pretending the cap passed would hide the configuration error the range
  // module diagnosed. The owner needs no range to be assignable (§8).
  if (!driver.isOwner && !work.state.range.usable) {
    return 'no_usable_range';
  }

  for (const iv of work.intervals) {
    // Rule 2: half-open overlap.
    if (block.startMs < iv.endMs && block.endMs > iv.startMs) {
      return 'driver_overlap';
    }
    // The derived check: between blocks on different vehicles, the driver needs
    // the switch duration. Same vehicle needs nothing here — §3 already spaced
    // those blocks by at least the switch duration when it built them.
    if (iv.vehicleId !== block.vehicleId) {
      const gapMs = block.startMs >= iv.endMs
        ? block.startMs - iv.endMs
        : iv.startMs - block.endMs;
      if (gapMs >= 0 && gapMs < switchMinutes * MS_PER_MINUTE) {
        return 'vehicle_switch_gap';
      }
    }
  }

  // Rule 3: the effective cap, in minutes, against span minutes. The owner is
  // exempt — §8: "the owner has no monthly hours ceiling".
  if (!driver.isOwner) {
    const capHours = work.state.range.effectiveMaxHours;
    if (capHours != null) {
      const afterMinutes = work.state.minutes + block.spanMinutes;
      if (afterMinutes > capHours * 60) {
        return 'exceeds_hours_cap';
      }
    }
  }

  return null;
}

/** Records an accepted assignment on the driver's running state. */
function place(work: DriverWork, block: PlanBlock): void {
  work.state.assignedBlockIds.push(block.id);
  work.state.minutes += block.spanMinutes;
  work.state.rideMinutes += block.rideMinutes;
  work.state.tripCount += block.trips.length;
  work.intervals.push({ startMs: block.startMs, endMs: block.endMs, vehicleId: block.vehicleId });
  work.intervals.sort((a, b) => a.startMs - b.startMs);
}

/**
 * The optimisation of §7, as one comparable score. Higher is better. Everything
 * here is preference — every candidate scored already passed the hard rules.
 */
function scoreCandidate(
  work: DriverWork,
  block: PlanBlock,
  poolIds: ReadonlySet<string>,
): number {
  const { driver } = work.state;
  const range = work.state.range;
  let score = 0;

  // "Bring the driver's hours toward the range computed from salary and rate."
  // Urgency below the minimum dominates: the further below, the stronger the
  // pull, scaled so it stays comparable across drivers with different ranges.
  if (range.usable && range.minHours != null && range.minHours > 0) {
    const afterHours = (work.state.minutes + block.spanMinutes) / 60;
    if (afterHours <= range.minHours) {
      // Still below the minimum even with this block: the driver needs it.
      const deficit = (range.minHours - afterHours) / range.minHours;
      score += 100_000 + Math.round(deficit * 50_000);
    } else if (work.state.minutes / 60 < range.minHours) {
      // This block carries the driver across the minimum — the best single
      // outcome the objective names.
      score += 160_000;
    } else {
      // Already in range: acceptable, mildly preferred the lower they sit, so
      // hours spread instead of piling onto whoever crossed the line first.
      const cap = range.effectiveMaxHours ?? range.maxHours ?? afterHours;
      const room = cap > range.minHours
        ? (cap - afterHours) / (cap - range.minHours)
        : 0;
      score += 20_000 + Math.round(Math.max(0, Math.min(1, room)) * 10_000);
    }
  }

  // "Reduce driver switches and fragmentation": staying on the same vehicle as
  // an adjacent assigned block reads as one shift, not a zig-zag.
  for (const iv of work.intervals) {
    if (iv.vehicleId === block.vehicleId) {
      const touchesBefore = Math.abs(block.startMs - iv.endMs) <= 12 * 60 * MS_PER_MINUTE;
      const touchesAfter = Math.abs(iv.startMs - block.endMs) <= 12 * 60 * MS_PER_MINUTE;
      if (touchesBefore || touchesAfter) {
        score += 5_000;
        break;
      }
    }
  }

  // §4's coverage flag, as a preference (§7's hard list is closed): a driver
  // who does not cover others is steered away from a block that originally
  // belonged to a different selected driver.
  if (driver.canCoverOtherDrivers === false) {
    const originalDrivers = new Set(
      block.trips.map(t => t.originalDriverName).filter((n): n is string => !!n),
    );
    const foreign = [...originalDrivers].some(n => n && !nameMatches(n, driver.name));
    if (foreign && originalDrivers.size > 0) score -= 8_000;
  }
  void poolIds;

  return score;
}

/** Case- and whitespace-insensitive name equality, matching the pool's own matching. */
function nameMatches(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return norm(a) === norm(b);
}

/**
 * Distributes the blocks. Deterministic for a given (blocks, drivers, notes,
 * options) — including `seed`, whose only reach is the tie-break.
 */
export function assignBlocks(
  blocks: PlanBlock[],
  drivers: PlanDriverInput[],
  availability: AvailabilityResult,
  options: AssignOptions,
): AssignResult {
  const seed = options.seed ?? 0;
  const switchMinutes = Number.isFinite(options.switchMinutes) && options.switchMinutes >= 0
    ? Math.floor(options.switchMinutes)
    : 0;

  const poolIds = new Set(drivers.map(d => d.id));

  const works = new Map<string, DriverWork>();
  for (const driver of [...drivers].sort((a, b) => a.id.localeCompare(b.id))) {
    const rangeInput: HoursRangeInput = {
      minSalary: driver.minSalary,
      maxSalary: driver.maxSalary,
      hourlyRate: driver.hourlyRate,
      maxMonthlyHours: driver.maxMonthlyHours,
      isOwner: driver.isOwner,
    };
    const range = computeHoursRange(rangeInput);
    works.set(driver.id, {
      state: {
        driver,
        range,
        assignedBlockIds: [],
        minutes: 0,
        rideMinutes: 0,
        tripCount: 0,
        assessment: assessAgainstRange(0, range, driver.isOwner),
      },
      intervals: [],
    });
  }

  const blockById = new Map(blocks.map(b => [b.id, b]));
  const assignments: BlockAssignment[] = [];
  const unassigned: UnassignedBlock[] = [];
  const pinConflicts: PinConflict[] = [];
  const taken = new Set<string>();

  // ── Rule 5 first: the mandatory pins. Placed before anything else so no
  // ordinary assignment can occupy a pinned block, and validated against the
  // other hard rules — "respected, or a conflict shown", never forced through.
  for (const pin of availability.pins) {
    const block = blockById.get(pin.blockId);
    const work = works.get(pin.driverId);
    if (!block || !work) continue; // availability already reported these cases
    if (taken.has(block.id)) continue;

    const refusal = refusalFor(work, block, availability, switchMinutes);
    if (refusal) {
      pinConflicts.push({
        blockId: block.id,
        driverId: pin.driverId,
        noteId: pin.noteId,
        brokenRule: refusal,
      });
      continue;
    }

    place(work, block);
    taken.add(block.id);
    assignments.push({
      blockId: block.id,
      driverId: pin.driverId,
      driverName: work.state.driver.name,
      reason: 'mandatory_note',
      noteId: pin.noteId,
    });
  }

  // ── The ordinary pass: chronological, regulars first, owner as fallback.
  const ordered = [...blocks].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));

  for (const block of ordered) {
    if (taken.has(block.id)) continue;

    const refusals: { driverId: string; refusal: AssignRefusal }[] = [];
    const candidates: { work: DriverWork; score: number }[] = [];
    let owner: DriverWork | null = null;
    let ownerRefusal: AssignRefusal | null = null;

    for (const work of works.values()) {
      const refusal = refusalFor(work, block, availability, switchMinutes);
      if (work.state.driver.isOwner) {
        // §8: the owner is held back, not scored against the regulars.
        owner = work;
        ownerRefusal = refusal;
        if (refusal) refusals.push({ driverId: work.state.driver.id, refusal });
        continue;
      }
      if (refusal) {
        refusals.push({ driverId: work.state.driver.id, refusal });
        continue;
      }
      candidates.push({ work, score: scoreCandidate(work, block, poolIds) });
    }

    if (candidates.length > 0) {
      // Highest score wins; equal scores fall to the priority (§7's deciding
      // factor), then to the seeded hash — the single flexible choice, so a
      // regeneration can land differently only where alternatives are equally
      // valid; then to the id, so the result is total and deterministic.
      candidates.sort((a, b) =>
        b.score - a.score
        || (b.work.state.driver.planningPriority ?? 100) - (a.work.state.driver.planningPriority ?? 100)
        || fnv1a(`${seed}|${block.id}|${b.work.state.driver.id}`)
           - fnv1a(`${seed}|${block.id}|${a.work.state.driver.id}`)
        || a.work.state.driver.id.localeCompare(b.work.state.driver.id),
      );

      const winner = candidates[0];
      const decidedBySeed =
        candidates.length > 1
        && candidates[1].score === winner.score
        && (candidates[1].work.state.driver.planningPriority ?? 100)
           === (winner.work.state.driver.planningPriority ?? 100);

      place(winner.work, block);
      taken.add(block.id);
      assignments.push({
        blockId: block.id,
        driverId: winner.work.state.driver.id,
        driverName: winner.work.state.driver.name,
        reason: candidates.length === 1
          ? 'only_candidate'
          : decidedBySeed ? 'seeded_tie' : 'best_fit',
      });
      continue;
    }

    // §8: only now — no regular driver passed — may the owner take it.
    if (owner && !ownerRefusal) {
      place(owner, block);
      taken.add(block.id);
      assignments.push({
        blockId: block.id,
        driverId: owner.state.driver.id,
        driverName: owner.state.driver.name,
        reason: 'owner_fallback',
      });
      continue;
    }

    // §8's last line: no owner, or even the owner refused — the block stays
    // unassigned, visibly, and no constraint is broken to cover it.
    unassigned.push({
      blockId: block.id,
      refusals,
      ownerConsidered: owner != null,
    });
  }

  // Final per-driver assessment, off the same range the cap enforced.
  const driverStates = [...works.values()].map(w => {
    w.state.assessment = assessAgainstRange(w.state.minutes, w.state.range, w.state.driver.isOwner);
    return w.state;
  });

  return { assignments, unassigned, pinConflicts, driverStates };
}

/** Re-exported so a caller of the assigner can type its notes without a second import path. */
export type { PlanNote };
