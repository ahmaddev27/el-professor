/**
 * What a driver note does to a Stundennachweis plan that the page generates.
 *
 * `generatePlan` and `generatePlanFromTotals` pre-fill the month from its notes
 * and only then spend the salary target on the days that are left. They used to
 * put a shift of "the note's time plus and minus an hour" on every day that
 * carried a note, without asking what the note meant, and they keyed that on the
 * single day in `note_date`. So a sick note over 10.-12.03. produced a working
 * hour on the 10th (00:00-01:00, the note's own timestamp) and left the 11th and
 * 12th to be planned as ordinary working days. All three behaviours produced
 * byte-identical rows.
 *
 * ## The rule, which is deliberately not symmetric
 *
 * It is the one `monthlyPlan/availability.ts` states for the Monatsplanung, and
 * this file follows its semantics rather than inventing a second model:
 *
 *   - `exclude_from_plan` (sick, vacation, off): **no shift at all** on any day
 *     the note covers. A time record that claims hours the driver did not work
 *     is a false statement in a document the Steuerberater books payroll from.
 *     The exclusion is a hard negative: those days are not candidates for the
 *     salary allocator either.
 *   - `must_include_in_plan` (blitzer, accident, kontrolle, breakdown, wait):
 *     **today's window stays**. The note is evidence the driver was at the
 *     wheel at that moment, and this is the class the old behaviour got right
 *     by accident.
 *   - anything else (`neutral`, or no behaviour at all): **the note puts nothing
 *     into the plan.** A free-text remark is not a work record and used to
 *     become a paid hour. The day is then exactly what it would be had the note
 *     not been written - an ordinary day the allocator may or may not use.
 *
 * ## A contradiction is reported, not resolved quietly
 *
 * A mandatory note that falls on a day an absence covers cannot be both. The
 * exclusion stays in force (it is the hard negative; the mandatory window is
 * not entered), and `findNoteConflicts` names the pair so the screen can tell a
 * person to correct one of the two notes. That is `availability.ts`'s own
 * outcome for the same contradiction (`conflicts_with_exclusion`).
 *
 * ## What is reused, and why
 *
 * The behaviour is `resolveNoteBehavior` - the one copy of the keyword rule,
 * stored value first - and the window is `noteExclusionIntervals`, the one
 * DST-correct copy of the note-to-instants arithmetic. Two earlier copies of
 * that arithmetic built windows at `Date.UTC` and 11 real rides went to drivers
 * marked sick; a fourth stepped a fixed 86 400 000 ms and broke on the 25-hour
 * day. This file therefore contains no day-stepping loop of its own: it asks,
 * for each row of the month, whether any of the note's half-open intervals
 * overlaps that row's local day, and both ends of a row's day are built from
 * calendar parts, never by adding 24 hours.
 *
 * ## One deliberate simplification
 *
 * A note that covers only part of a day (an `off` note from 08:00 to 12:00)
 * blocks the whole day here. The plan is a salary-target allocation of whole
 * days, not an assignment of rides to instants, so placing a shift around a
 * partial window would mean changing the allocator itself. Blocking the day can
 * only claim fewer hours than the driver could have worked, never more. No such
 * note exists on staging (all ten exclusion notes are whole-day ranges); the
 * choice is recorded here and pinned in the tests so it is a decision, not an
 * accident.
 */

import { resolveNoteBehavior, type NoteBehaviorSource } from './noteBehavior';
import { noteExclusionIntervals, type NoteWindowFields } from './driverNoteValidation';

/** The fields of a note that decide what it does to a plan. */
export interface PlanNote extends NoteBehaviorSource {
  note_date: string;
  is_full_day?: boolean;
  start_date?: string | null;
  end_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
}

/** What a note does to a plan: remove days, keep a window, or nothing. */
export type PlanNoteEffect = 'exclude' | 'window' | 'none';

/**
 * The effect of one note. `resolveNoteBehavior` returns a stored value as it is
 * (`'neutral'` included), so anything that is not one of the two behaviours the
 * planner acts on is `'none'` - an unknown stored value included, because a
 * value this build does not know must not be read as an instruction.
 */
export function planEffectOfNote(note: NoteBehaviorSource): PlanNoteEffect {
  switch (resolveNoteBehavior(note)) {
    case 'exclude_from_plan': return 'exclude';
    case 'must_include_in_plan': return 'window';
    default: return 'none';
  }
}

function windowFields(note: PlanNote): NoteWindowFields {
  return {
    is_full_day: note.is_full_day ?? false,
    start_date: note.start_date ?? null,
    end_date: note.end_date ?? null,
    note_date: note.note_date ?? null,
    start_time: note.start_time ?? null,
    end_time: note.end_time ?? null,
  };
}

/** One absence note and the days of the month it blocks (1-based day numbers). */
export interface AbsenceCoverage<N extends PlanNote> {
  note: N;
  days: ReadonlySet<number>;
}

/**
 * For every `exclude_from_plan` note, the days of `year`/`month` (month is
 * 1-based) that any part of its window touches. A note that touches none of
 * them, or has no readable date, is left out.
 */
export function absenceCoverage<N extends PlanNote>(
  notes: readonly N[],
  year: number,
  month: number,
): AbsenceCoverage<N>[] {
  const daysInMonth = new Date(year, month, 0).getDate();
  const out: AbsenceCoverage<N>[] = [];
  for (const note of notes) {
    if (planEffectOfNote(note) !== 'exclude') continue;
    const intervals = noteExclusionIntervals(windowFields(note));
    const days = new Set<number>();
    for (let day = 1; day <= daysInMonth; day++) {
      // Both ends are calendar parts, so the 23- and 25-hour days are exact.
      const dayStart = new Date(year, month - 1, day).getTime();
      const dayEnd = new Date(year, month - 1, day + 1).getTime();
      if (intervals.some(iv => iv.start < dayEnd && iv.end > dayStart)) days.add(day);
    }
    if (days.size > 0) out.push({ note, days });
  }
  return out;
}

/** The union of the days any absence note blocks. */
export function absenceDays<N extends PlanNote>(
  notes: readonly N[],
  year: number,
  month: number,
): Set<number> {
  const all = new Set<number>();
  for (const { days } of absenceCoverage(notes, year, month)) for (const d of days) all.add(d);
  return all;
}

/**
 * The day of the month a mandatory note's own timestamp falls on, or null when
 * it is not in this month or not a date. This is the day the old pre-fill used,
 * unchanged: a mandatory note is a point event at `note_date`.
 */
function noteDayInMonth(note: PlanNote, year: number, month: number): number | null {
  const nd = new Date(note.note_date);
  return nd.getFullYear() === year && nd.getMonth() === month - 1 ? nd.getDate() : null;
}

export interface NoteDayPlan<N extends PlanNote> {
  /**
   * The notes that put a window into the plan, grouped by day, in the order
   * they were given. Only mandatory notes, and none on an absence day.
   */
  windowNotesByDay: Record<number, N[]>;
  /** Days that must carry no shift and are no candidates for the allocator. */
  absence: Set<number>;
}

/** What the generators read: where windows go, and which days stay empty. */
export function planNoteDays<N extends PlanNote>(
  notes: readonly N[],
  year: number,
  month: number,
): NoteDayPlan<N> {
  const absence = absenceDays(notes, year, month);
  const windowNotesByDay: Record<number, N[]> = {};
  for (const note of notes) {
    if (planEffectOfNote(note) !== 'window') continue;
    const day = noteDayInMonth(note, year, month);
    if (day === null || absence.has(day)) continue;
    (windowNotesByDay[day] ??= []).push(note);
  }
  return { windowNotesByDay, absence };
}

/** A mandatory note that falls on a day an absence covers. */
export interface NoteConflict<N extends PlanNote> {
  /** Day of the month, 1-based. */
  day: number;
  mandatory: N;
  /** Every absence note that covers that day. */
  absences: N[];
}

/**
 * The contradictions in a month's notes, in the order the mandatory notes were
 * given. The plan enters nothing for such a day; this is what lets the screen
 * say why and ask a person to correct one of the two notes.
 */
export function findNoteConflicts<N extends PlanNote>(
  notes: readonly N[],
  year: number,
  month: number,
): NoteConflict<N>[] {
  const coverage = absenceCoverage(notes, year, month);
  const out: NoteConflict<N>[] = [];
  for (const note of notes) {
    if (planEffectOfNote(note) !== 'window') continue;
    const day = noteDayInMonth(note, year, month);
    if (day === null) continue;
    const absences = coverage.filter(c => c.days.has(day)).map(c => c.note);
    if (absences.length > 0) out.push({ day, mandatory: note, absences });
  }
  return out;
}
