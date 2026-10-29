import { effectOfNote, type ConstraintCertainty } from '../constraintDecisionLog';
import { noteExclusionIntervals } from '../driverNoteValidation';
import type { StructuredNote } from '../monatsplanungPhase3';

/**
 * What a driver's notes and a vehicle's facts do to a SIMULATED shift
 * (external audit round 4, the owner's decision 5 of 29.10.2026).
 *
 * ## The rule, and why it is not the planner's
 *
 * "احترم القيود التشغيلية المؤكدة ... ولا تعتبر الملاحظات غير المؤكدة قيودًا
 * قطعية" — respect the confirmed constraints, and do not treat unconfirmed
 * notes as hard ones. So, for a generated month:
 *
 * | event                                             | effect on a simulated shift |
 * |---------------------------------------------------|-----------------------------|
 * | blocking note with its own window (`confirmed`)   | hard: no shift inside it    |
 * | blocking note whose window is only the notice date| review: the shift may run, and the decision says so |
 * | past event (Blitzer, accident, breakdown, …)      | review: never a block       |
 * | TÜV expired before the operating day              | hard: the vehicle stays off |
 * | no TÜV date recorded                              | review                      |
 * | negative Werkstatt check (no downtime window)     | review                      |
 *
 * The real planner (`monatsplanungPhase3`) still blocks on a notice-date
 * window, and this module does not change it: that rule moves a hard
 * constraint in a plan that becomes a Stundennachweis, and the owner's
 * decision is about the simulation. The certainty is read from
 * `effectOfNote`, the decision log's own classification, and the window from
 * `noteExclusionIntervals`, the planner's own helper — so "confirmed" here means
 * exactly what the log prints, and the window is exactly the planner's.
 */

export interface NoteVerdict {
  /** A confirmed blocking note the window falls into, or null. */
  blocking: StructuredNote | null;
  /** Blocking notes whose window is not confirmed and that the window falls into. They do not block. */
  review: StructuredNote[];
}

const overlaps = (note: StructuredNote, startMs: number, endMs: number): boolean =>
  noteExclusionIntervals(note).some(iv => startMs < iv.end && endMs > iv.start);

export function noteVerdict(
  driverId: string | undefined,
  startMs: number,
  endMs: number,
  notes: ReadonlyMap<string, readonly StructuredNote[]>,
): NoteVerdict {
  const out: NoteVerdict = { blocking: null, review: [] };
  if (!driverId) return out;
  for (const note of notes.get(driverId) ?? []) {
    if (note.note_planning_behavior !== 'exclude_from_plan') continue;
    if (!overlaps(note, startMs, endMs)) continue;
    const { certainty } = effectOfNote(note);
    if (certainty === 'confirmed') {
      if (!out.blocking) out.blocking = note;
    } else {
      out.review.push(note);
    }
  }
  return out;
}

export interface VehicleFacts {
  /** `YYYY-MM-DD`, or null/undefined when not recorded. */
  tuev_gueltig_bis?: string | null;
}

export type VehicleVerdict =
  | { kind: 'usable' }
  | { kind: 'review'; code: 'tuev_missing'; reason: string }
  | { kind: 'blocked'; code: 'tuev_expired'; reason: string; certainty: ConstraintCertainty };

/**
 * Whether a vehicle may carry a simulated shift on one operating day. The TÜV
 * date is the last day it is valid; both sides are `YYYY-MM-DD`, so the string
 * order is the calendar order and no zone enters the comparison.
 */
export function vehicleVerdict(vehicle: VehicleFacts, day: string): VehicleVerdict {
  const valid = vehicle.tuev_gueltig_bis;
  if (!valid) return { kind: 'review', code: 'tuev_missing', reason: 'Kein TÜV-Datum erfasst - Fahrzeug eingesetzt, bitte prüfen' };
  if (day > valid) {
    return { kind: 'blocked', code: 'tuev_expired', certainty: 'confirmed', reason: `TÜV am ${valid} abgelaufen - Fahrzeug nicht eingesetzt` };
  }
  return { kind: 'usable' };
}

/** One decision about one shift: placed, placed with something to review, or kept off with the reason. */
export interface ShiftDecision {
  day: string;
  plate: string;
  /** `cars.id`, when the caller knew it. */
  vehicleId: string | null;
  /** `drivers.id`, when the decision names a driver. Never a name: a name is not an identity. */
  driverId: string | null;
  outcome: 'accepted' | 'accepted_with_review' | 'excluded';
  /** Stable code: `accepted`, a capacity reason, or the review cause. */
  code: string;
  /** German, for the workbook. */
  reason: string;
  /** The note id, `tuev`, or null. */
  eventRef: string | null;
  certainty: ConstraintCertainty | null;
  /** The shift's window, for an accepted shift. */
  startMs: number | null;
  endMs: number | null;
  /** How many identical refusals this row stands for (a refusal is recorded per attempt). */
  count: number;
}

/** Collapse identical refusals (same day, vehicle, driver, code, event) into one row with a count. */
export function collapseDecisions(rows: readonly ShiftDecision[]): ShiftDecision[] {
  const out = new Map<string, ShiftDecision>();
  for (const row of rows) {
    if (row.outcome !== 'excluded') {
      out.set(`${out.size}|accepted`, { ...row });
      continue;
    }
    const key = [row.day, row.plate, row.driverId ?? '', row.code, row.eventRef ?? ''].join('|');
    const seen = out.get(key);
    if (seen) seen.count += row.count;
    else out.set(key, { ...row });
  }
  return [...out.values()];
}
