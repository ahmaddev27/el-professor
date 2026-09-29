/**
 * Monthly plan — re-verification before the plan is confirmed (§1 screen 3,
 * acceptance criterion 15: a plan with unresolved hard conflicts cannot be
 * confirmed).
 *
 * ## Two kinds of finding, and the line between them is the requirement's own
 *
 * - **Violations** — an assignment in the plan breaks one of §7's hard rules.
 *   Confirmation is impossible while one exists. The assigner cannot produce
 *   these, so a violation here means the plan was edited, the data changed
 *   under it, or the engine has a defect — precisely what a second,
 *   independent check exists to catch. This module re-derives everything from
 *   the blocks and notes; it trusts no flag the assigner wrote.
 *
 * - **Warnings** — the plan is internally legal but incomplete: unassigned
 *   blocks (§8 says leave them and warn), unmet mandatory notes (§6 says show
 *   them as unmet), note contradictions and contested blocks (§6/§14 say show
 *   them). All of them appear on the summary screen, and none of them stops
 *   confirmation — §8 and §6 both name showing-and-proceeding as the correct
 *   handling, and blocking on them would force an operator to invent data to
 *   silence a warning, which §14 forbids more strongly.
 */

import type { PlanBlock } from './blocks';
import {
  findExclusion,
  type AvailabilityResult,
} from './availability';
import type { AssignResult, PlanDriverInput } from './assign';

const MS_PER_MINUTE = 60_000;

/** A broken hard rule found in the plan itself. Non-empty ⇒ no confirmation. */
export interface PlanViolation {
  rule:
    | 'block_assigned_twice'        // §7 rule 1
    | 'unknown_block'               // an assignment names a block not in the month
    | 'driver_not_in_pool'          // §7 rule 8
    | 'driver_overlap'              // §7 rule 2
    | 'exceeds_hours_cap'           // §7 rule 3
    | 'assigned_inside_exclusion'   // §7 rule 4
    | 'vehicle_switch_gap'          // the derived cross-vehicle check
    | 'pin_ignored';                // §7 rule 5: pinned block went to someone else
  blockId: string | null;
  driverId: string | null;
  detail: string;
}

export interface PlanWarning {
  kind:
    | 'unassigned_block'            // §8
    | 'unmet_mandatory_note'        // §6
    | 'note_conflict'               // §6: exclusion overlaps inclusion
    | 'contested_block'             // §14: two drivers' mandatory claims
    | 'pin_conflict'                // §7 rule 5: pin vs another hard rule
    | 'rejected_trip'               // §14: a ride that could not be blocked
    | 'source_overlap';             // §14: overlapping rides in the source data
  detail: string;
  blockId?: string;
  driverId?: string;
  noteId?: string;
  tripId?: string;
}

export interface ValidationResult {
  violations: PlanViolation[];
  warnings: PlanWarning[];
  /** criterion 15, as one boolean the confirm button reads. */
  confirmable: boolean;
}

export interface ValidateInput {
  blocks: PlanBlock[];
  drivers: PlanDriverInput[];
  availability: AvailabilityResult;
  result: AssignResult;
  switchMinutes: number;
  /** §14 diagnostics from the block builder, passed through as warnings. */
  rejectedTrips?: { tripId: string; problem: string; detail: string }[];
  sourceOverlaps?: { vehicleId: string; firstTripId: string; secondTripId: string; overlapMinutes: number }[];
}

/**
 * Re-verifies a finished plan against the hard rules, from the raw inputs.
 *
 * Deliberately re-implements the checks in the simplest possible form rather
 * than importing the assigner's `refusalFor`: a validator that shares its
 * subject's code inherits its subject's bugs, and this one exists for the day
 * the two disagree.
 */
export function validatePlan(input: ValidateInput): ValidationResult {
  const { blocks, drivers, availability, result, switchMinutes } = input;
  const violations: PlanViolation[] = [];
  const warnings: PlanWarning[] = [];

  const blockById = new Map(blocks.map(b => [b.id, b]));
  const driverById = new Map(drivers.map(d => [d.id, d]));

  // ── Rule 1: one driver per block, and every named block exists.
  const seenBlocks = new Set<string>();
  for (const a of result.assignments) {
    if (seenBlocks.has(a.blockId)) {
      violations.push({
        rule: 'block_assigned_twice',
        blockId: a.blockId,
        driverId: a.driverId,
        detail: `block ${a.blockId} appears in more than one assignment`,
      });
    }
    seenBlocks.add(a.blockId);

    if (!blockById.has(a.blockId)) {
      violations.push({
        rule: 'unknown_block',
        blockId: a.blockId,
        driverId: a.driverId,
        detail: `assignment names a block that is not part of this month`,
      });
    }
    if (!driverById.has(a.driverId)) {
      violations.push({
        rule: 'driver_not_in_pool',
        blockId: a.blockId,
        driverId: a.driverId,
        detail: `assignment names a driver who is not among the selected drivers`,
      });
    }
  }

  // ── Rules 2, 4 and the switch gap, per driver, from the intervals themselves.
  const perDriver = new Map<string, { block: PlanBlock }[]>();
  for (const a of result.assignments) {
    const block = blockById.get(a.blockId);
    if (!block || !driverById.has(a.driverId)) continue;

    // Rule 4 — re-derived from the notes, not from the assigner's verdict.
    const excluded = findExclusion(availability, a.driverId, block.startMs, block.endMs);
    if (excluded) {
      violations.push({
        rule: 'assigned_inside_exclusion',
        blockId: a.blockId,
        driverId: a.driverId,
        detail: `assigned inside note ${excluded.id} (${excluded.note_type})`,
      });
    }

    const list = perDriver.get(a.driverId);
    if (list) list.push({ block });
    else perDriver.set(a.driverId, [{ block }]);
  }

  for (const [driverId, list] of perDriver) {
    const sorted = [...list].sort((a, b) => a.block.startMs - b.block.startMs);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i].block;
        const b = sorted[j].block;
        if (b.startMs >= a.endMs) {
          // Sorted by start: once b starts at or after a ends, the overlap
          // window for a is over — but the switch gap may still bind.
          if (b.vehicleId !== a.vehicleId && b.startMs - a.endMs < switchMinutes * MS_PER_MINUTE) {
            violations.push({
              rule: 'vehicle_switch_gap',
              blockId: b.id,
              driverId,
              detail: `${Math.round((b.startMs - a.endMs) / MS_PER_MINUTE)} min between ${a.id} and ${b.id}, switch duration is ${switchMinutes}`,
            });
          }
          break;
        }
        violations.push({
          rule: 'driver_overlap',
          blockId: b.id,
          driverId,
          detail: `blocks ${a.id} and ${b.id} overlap`,
        });
      }
    }
  }

  // ── Rule 3: the cap, re-derived from the driver states' own ranges — which
  // were themselves computed from salary and rate, never from a stored target.
  for (const s of result.driverStates) {
    if (s.driver.isOwner) continue; // §8
    if (!s.range.usable || s.range.effectiveMaxHours == null) continue;
    const assigned = (perDriver.get(s.driver.id) ?? [])
      .reduce((sum, x) => sum + x.block.spanMinutes, 0);
    if (assigned > s.range.effectiveMaxHours * 60) {
      violations.push({
        rule: 'exceeds_hours_cap',
        blockId: null,
        driverId: s.driver.id,
        detail: `${assigned} assigned minutes exceed the cap of ${Math.round(s.range.effectiveMaxHours * 60)}`,
      });
    }
  }

  // ── Rule 5: every pin either reached its driver or is a reported conflict.
  const assignmentByBlock = new Map(result.assignments.map(a => [a.blockId, a]));
  const conflictedPins = new Set(result.pinConflicts.map(c => `${c.blockId}|${c.driverId}`));
  for (const pin of availability.pins) {
    if (!blockById.has(pin.blockId)) continue;
    if (conflictedPins.has(`${pin.blockId}|${pin.driverId}`)) continue; // reported, which rule 5 permits
    const a = assignmentByBlock.get(pin.blockId);
    if (!a || a.driverId !== pin.driverId) {
      violations.push({
        rule: 'pin_ignored',
        blockId: pin.blockId,
        driverId: pin.driverId,
        detail: a
          ? `pinned to ${pin.driverId} but assigned to ${a.driverId}`
          : `pinned to ${pin.driverId} but left unassigned with no reported conflict`,
      });
    }
  }

  // ── The warnings: everything the summary screen must show (§1 screen 3),
  // none of which blocks confirmation.
  for (const u of result.unassigned) {
    warnings.push({
      kind: 'unassigned_block',
      blockId: u.blockId,
      detail: u.refusals.length === 0
        ? 'no selected driver was available'
        : u.refusals.map(r => `${r.driverId}: ${r.refusal}`).join(', '),
    });
  }
  for (const u of availability.unmet) {
    warnings.push({
      kind: 'unmet_mandatory_note',
      noteId: u.note.id,
      driverId: u.note.driver_id,
      detail: u.reason,
    });
  }
  for (const c of availability.conflicts) {
    if (c.kind === 'exclusion_overlaps_inclusion') {
      warnings.push({
        kind: 'note_conflict',
        driverId: c.driverId,
        noteId: c.inclusionNoteId,
        detail: `exclusion ${c.exclusionNoteId} overlaps mandatory ${c.inclusionNoteId}`,
      });
    } else {
      warnings.push({
        kind: 'contested_block',
        blockId: c.blockId,
        detail: `mandatory claims by ${c.driverIds.join(' and ')}`,
      });
    }
  }
  for (const c of result.pinConflicts) {
    warnings.push({
      kind: 'pin_conflict',
      blockId: c.blockId,
      driverId: c.driverId,
      noteId: c.noteId,
      detail: c.brokenRule,
    });
  }
  for (const r of input.rejectedTrips ?? []) {
    warnings.push({ kind: 'rejected_trip', tripId: r.tripId, detail: `${r.problem}: ${r.detail}` });
  }
  for (const o of input.sourceOverlaps ?? []) {
    warnings.push({
      kind: 'source_overlap',
      tripId: o.firstTripId,
      detail: `${o.firstTripId} overlaps ${o.secondTripId} on ${o.vehicleId} by ${o.overlapMinutes} min`,
    });
  }

  return {
    violations,
    warnings,
    confirmable: violations.length === 0,
  };
}
