/**
 * Monthly plan — driver availability from notes (requirement §6).
 *
 * Two effects, and they are not symmetric:
 *
 *   - **Exclusion** (`exclude_from_plan`: illness, holiday, unavailable) — no
 *     block overlapping the note's window may be assigned to that driver. A hard
 *     constraint the assigner enforces per candidate.
 *   - **Mandatory inclusion** (`must_include_in_plan`: police check, accident,
 *     radar, inspection, breakdown, waiting time) — the driver **must** be on
 *     the block containing the event, when a suitable block exists. Resolved
 *     here, once, into pinned (block, driver) pairs the assigner starts from.
 *
 * The existing `new_month` pipeline loads only exclusions — its query filters
 * `.eq('note_planning_behavior', 'exclude_from_plan')` server-side — so
 * mandatory inclusions never reach it, and a conflict between the two kinds
 * cannot even be observed there. This module takes **all** planning notes and
 * models both, which is the gap §6 names.
 *
 * ## What is reused, and why
 *
 * The note→window arithmetic is `noteExclusionIntervals` from
 * `driverNoteValidation.ts`, unchanged, for both behaviours. Its window math
 * reads only the note's dates and times, not its behaviour, and it is the one
 * copy that is DST-correct: two earlier copies built windows at `Date.UTC`,
 * which in Europe/Berlin left every note's first 1–2 hours unprotected — 11
 * real rides on staging went to drivers marked sick. Writing a third copy here
 * would be re-creating exactly that defect.
 *
 * ## What is never done here
 *
 * No phantom hours (§6: a mandatory note with no matching block is reported as
 * unmet, never satisfied by inventing a block), no silent resolution of a
 * contradiction (an exclusion overlapping an inclusion for the same driver and
 * time is a named conflict, §6; two drivers' mandatory claims on one block is a
 * named conflict, §14), and no guessing which of two simultaneous vehicles the
 * driver was in — that is reported for a person to resolve.
 */

import type { StructuredNote } from '../monatsplanungPhase3';
import {
  noteExclusionIntervals,
  type NoteInterval,
} from '../driverNoteValidation';
import type { PlanBlock } from './blocks';

/**
 * A planning note. `StructuredNote` plus the car, which `driver_notes.car_id`
 * has stored since `20260928120000` and nothing read until now. When it is set,
 * a mandatory inclusion targets that car's blocks only — the note records which
 * vehicle the event happened on, and using it turns an ambiguous claim across
 * simultaneous vehicles into a precise one.
 */
export interface PlanNote extends StructuredNote {
  car_id?: string | null;
}

/** A note's window with its source, as the assigner and the screen consume it. */
export interface NoteWindow {
  note: PlanNote;
  intervals: NoteInterval[];
}

/** §6: an exclusion and a mandatory inclusion for the same driver overlap. */
export interface ExclusionInclusionConflict {
  kind: 'exclusion_overlaps_inclusion';
  driverId: string;
  exclusionNoteId: string;
  inclusionNoteId: string;
  /** The overlapping instants, for the screen to print. */
  overlapStartMs: number;
  overlapEndMs: number;
}

/** §14: mandatory claims by two different drivers on the same block. */
export interface ContestedBlockConflict {
  kind: 'block_contested';
  blockId: string;
  driverIds: string[];
  noteIds: string[];
}

export type AvailabilityConflict = ExclusionInclusionConflict | ContestedBlockConflict;

/** Why a mandatory inclusion could not be turned into a pin. All are visible. */
export type UnmetInclusionReason =
  /** §6: no block overlaps the note's window — and no hours are invented. */
  | 'no_matching_block'
  /** The window overlaps blocks of several vehicles and the note names no car. */
  | 'ambiguous_vehicles'
  /** §6: the same driver is excluded over the same instants. */
  | 'conflicts_with_exclusion'
  /** §14: another driver's mandatory note claims the same block. */
  | 'block_contested'
  /** §7 rule 8: the note's driver is not among the selected drivers. */
  | 'driver_not_selected';

export interface UnmetInclusion {
  note: PlanNote;
  reason: UnmetInclusionReason;
  /** The blocks involved, where the reason has any. */
  blockIds: string[];
}

/** A block the assigner must give to this driver before anything else (§6). */
export interface MandatoryPin {
  blockId: string;
  driverId: string;
  noteId: string;
}

export interface DriverAvailability {
  driverId: string;
  /** Merged, sorted exclusion windows. Empty means always available. */
  exclusions: NoteWindow[];
  inclusions: NoteWindow[];
}

export interface AvailabilityResult {
  byDriver: Map<string, DriverAvailability>;
  pins: MandatoryPin[];
  unmet: UnmetInclusion[];
  conflicts: AvailabilityConflict[];
}

/** Half-open interval overlap. The engine's one overlap definition. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * The first exclusion note covering any part of `[startMs, endMs)`, or null.
 *
 * This is the assigner's hard check for §7 rule 4. It reads the prebuilt
 * windows rather than re-deriving them per candidate, so one plan computes each
 * note's intervals exactly once.
 */
export function findExclusion(
  availability: AvailabilityResult,
  driverId: string,
  startMs: number,
  endMs: number,
): PlanNote | null {
  const entry = availability.byDriver.get(driverId);
  if (!entry) return null;
  for (const w of entry.exclusions) {
    for (const iv of w.intervals) {
      if (overlaps(startMs, endMs, iv.start, iv.end)) return w.note;
    }
  }
  return null;
}

/**
 * Builds every driver's availability and resolves the mandatory inclusions
 * against the month's blocks.
 *
 * Deterministic: notes are processed in id order and blocks arrive already
 * sorted, so the same inputs always yield the same pins and the same conflicts
 * in the same order.
 */
export function buildAvailability(
  notes: PlanNote[],
  blocks: PlanBlock[],
  selectedDriverIds: ReadonlySet<string>,
): AvailabilityResult {
  const byDriver = new Map<string, DriverAvailability>();
  const pins: MandatoryPin[] = [];
  const unmet: UnmetInclusion[] = [];
  const conflicts: AvailabilityConflict[] = [];

  // Sorted copies, so the output cannot depend on query order.
  const sortedNotes = [...notes].sort((a, b) => a.id.localeCompare(b.id));

  for (const note of sortedNotes) {
    if (note.note_planning_behavior === 'neutral') continue;

    const intervals = noteExclusionIntervals(note);
    if (intervals.length === 0) continue; // a note with no date covers nothing

    let entry = byDriver.get(note.driver_id);
    if (!entry) {
      entry = { driverId: note.driver_id, exclusions: [], inclusions: [] };
      byDriver.set(note.driver_id, entry);
    }

    if (note.note_planning_behavior === 'exclude_from_plan') {
      entry.exclusions.push({ note, intervals });
    } else {
      entry.inclusions.push({ note, intervals });
    }
  }

  // §6's conflict: the same driver excluded and mandatorily included over the
  // same instants. Detected on the windows themselves, before any block enters
  // the picture — the contradiction exists in the notes, not in the month.
  for (const entry of byDriver.values()) {
    for (const inc of entry.inclusions) {
      for (const exc of entry.exclusions) {
        for (const ii of inc.intervals) {
          for (const ei of exc.intervals) {
            if (overlaps(ii.start, ii.end, ei.start, ei.end)) {
              conflicts.push({
                kind: 'exclusion_overlaps_inclusion',
                driverId: entry.driverId,
                exclusionNoteId: exc.note.id,
                inclusionNoteId: inc.note.id,
                overlapStartMs: Math.max(ii.start, ei.start),
                overlapEndMs: Math.min(ii.end, ei.end),
              });
            }
          }
        }
      }
    }
  }
  const conflictedInclusionIds = new Set(
    conflicts
      .filter((c): c is ExclusionInclusionConflict => c.kind === 'exclusion_overlaps_inclusion')
      .map(c => c.inclusionNoteId),
  );

  // Resolve each mandatory inclusion into candidate blocks.
  interface Claim { note: PlanNote; driverId: string; blockIds: string[] }
  const claims: Claim[] = [];

  for (const entry of byDriver.values()) {
    for (const inc of entry.inclusions) {
      const note = inc.note;

      // A contradictory note is surfaced once, as the conflict — pinning it
      // anyway would enforce one side of a contradiction §6 says to show.
      if (conflictedInclusionIds.has(note.id)) {
        unmet.push({ note, reason: 'conflicts_with_exclusion', blockIds: [] });
        continue;
      }

      // §7 rule 8: the plan may not assign a driver who is not taking part.
      // Reported rather than silently dropped — the operator either selects the
      // driver or accepts the constraint as unmet.
      if (!selectedDriverIds.has(note.driver_id)) {
        unmet.push({ note, reason: 'driver_not_selected', blockIds: [] });
        continue;
      }

      let candidates = blocks.filter(b =>
        inc.intervals.some(iv => overlaps(b.startMs, b.endMs, iv.start, iv.end)),
      );

      // The note's car narrows the claim to that vehicle's blocks. `car_id` is
      // matched against both the fleet id and the plate, because a block's
      // vehicleId falls back to the plate when the car is not in the fleet.
      if (note.car_id) {
        const carScoped = candidates.filter(b => b.vehicleId === note.car_id);
        if (carScoped.length > 0) candidates = carScoped;
        // A car that matches no candidate block is not silently widened back:
        // if the note names a car and that car has no overlapping block, the
        // claim is unmet on that car, which is what `no_matching_block` says.
        else candidates = [];
      }

      if (candidates.length === 0) {
        // §6: "do not create phantom hours; show the constraint as unmet."
        unmet.push({ note, reason: 'no_matching_block', blockIds: [] });
        continue;
      }

      const vehicles = new Set(candidates.map(b => b.vehicleId));
      if (vehicles.size > 1) {
        // Simultaneous blocks on several vehicles, and no car on the note to
        // decide between them. Pinning all would breach §7 rule 2 (no two
        // overlapping blocks for one driver); picking one would be a guess
        // about which car the driver was in. Neither is this module's call.
        unmet.push({
          note,
          reason: 'ambiguous_vehicles',
          blockIds: candidates.map(b => b.id),
        });
        continue;
      }

      // One vehicle. Same-vehicle blocks never overlap by construction, so
      // claiming all of them (a period note spanning a boundary) is legal.
      claims.push({ note, driverId: note.driver_id, blockIds: candidates.map(b => b.id) });
    }
  }

  // §14: two mandatory claims by different drivers on one block. Both are
  // withdrawn and the contest is reported — a block takes one driver at most
  // (§7 rule 1), and choosing between two statutory events is not arithmetic.
  const claimsByBlock = new Map<string, Claim[]>();
  for (const claim of claims) {
    for (const blockId of claim.blockIds) {
      const list = claimsByBlock.get(blockId);
      if (list) list.push(claim);
      else claimsByBlock.set(blockId, [claim]);
    }
  }

  const contestedNoteIds = new Set<string>();
  for (const [blockId, list] of claimsByBlock) {
    const driverIds = [...new Set(list.map(c => c.driverId))];
    if (driverIds.length > 1) {
      conflicts.push({
        kind: 'block_contested',
        blockId,
        driverIds: driverIds.sort(),
        noteIds: [...new Set(list.map(c => c.note.id))].sort(),
      });
      for (const c of list) contestedNoteIds.add(c.note.id);
    }
  }

  for (const claim of claims) {
    if (contestedNoteIds.has(claim.note.id)) {
      unmet.push({ note: claim.note, reason: 'block_contested', blockIds: claim.blockIds });
      continue;
    }
    for (const blockId of claim.blockIds) {
      pins.push({ blockId, driverId: claim.driverId, noteId: claim.note.id });
    }
  }

  // One pin per block: the same driver may reach a block through two notes
  // (an accident and a police check in one shift), which is one obligation,
  // not two. First note in id order wins; both notes are satisfied either way.
  const seenBlocks = new Set<string>();
  const dedupedPins = pins.filter(p => {
    if (seenBlocks.has(p.blockId)) return false;
    seenBlocks.add(p.blockId);
    return true;
  });

  return { byDriver, pins: dedupedPins, unmet, conflicts };
}
