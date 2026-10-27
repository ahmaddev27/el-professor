import { noteExclusionIntervals, NOTE_TYPE_LABELS } from './driverNoteValidation';
import type { StructuredNote } from './monatsplanungPhase3';

/**
 * The constraint decision log of the external audit's section 5: for every
 * driver and vehicle event the planner can see, what the event was, where it
 * came from, how strong the evidence is, which window it covers, and what it
 * actually did to the plan.
 *
 * ## Why a log rather than a new rule
 *
 * Section 5's rules were already the planner's, bar one. Confirmed blocking
 * events are hard: `note_constraint` is one of the five constraints
 * `monatsplanungPhase3` can never bypass, and since 22.10.2026 the manual
 * resolver asks `checkStructuredNote` too, so a driver recorded sick is no
 * longer offered when a person assigns a block by hand. Matching is on UUID:
 * `driverNotesMap` is keyed by `drivers.id`, never by a name.
 *
 * What was missing is the **record**: nothing said which events were weighed,
 * which were believed, and which were silently ignored. This module is that
 * record, and it is a pure function of the same inputs the planner takes.
 *
 * ## The effect column is derived, never restated
 *
 * A second copy of "does this note block?" that drifts from the planner's would
 * be worse than no log at all — it would describe a plan that was not made.
 * So `effectOfNote` applies the one rule `findBlockingNote` and
 * `checkStructuredNote` apply (behaviour `exclude_from_plan`, and a window that
 * yields at least one interval), the window itself comes from
 * `noteExclusionIntervals` — the planner's own helper, not a copy — and
 * `constraintDecisionLog.test.ts` checks the column against `findBlockingNote`
 * over a grid of notes and probes rather than trusting that the two agree.
 *
 * ## The three certainties, and the one that is the real finding
 *
 * - `confirmed` — the note names its own window (`start_date`), so the
 *   constraint sits on the time of the **event**.
 * - `assumed_from_notice_date` — the note names no window, and
 *   `noteExclusionIntervals` falls back to `note_date`. **`note_date` defaults
 *   to `now()`**: it is the moment the notice was entered, editable but
 *   usually never edited. So such a note blocks the day it was *typed*, which
 *   is precisely what section 5 forbids ("على الزمن الصحيح للواقعة، وليس
 *   تاريخ تلقي الإشعار"). The behaviour is **left exactly as it is** — it is
 *   the only thing that makes an undated note do anything, and moving it would
 *   move a hard constraint, change a plan, and change a Stundennachweis that
 *   goes to a Steuerberater. It is reported instead, with
 *   `needsHumanReview` set, which is the audit's own remedy for an
 *   undocumented case ("ضع الحالات غير الموثقة ضمن تحذيرات المراجعة البشرية").
 * - `reported` — a past violation, an incident, or a rule read out of free
 *   text. Never a block on its own.
 *
 * ## What the data model cannot answer, stated rather than guessed
 *
 * A vehicle has **no out-of-service window anywhere in the schema**.
 * `werkstatt_checks` is a weekly check carrying `status`
 * (`positive`/`negative`/`repaired`), a `check_date` and free-text notes — it
 * says a check found something, never that the car is off the road from one
 * date to another. So a negative check is a `reported` event and a human-review
 * warning here, and it is **not** turned into a block: inventing a window would
 * be exactly the inference section 5 forbids. The one vehicle fact that is a
 * hard bar is an expired `tuev_gueltig_bis`, because operating the vehicle is
 * then unlawful rather than merely inadvisable.
 */

// ── The vocabulary ──────────────────────────────────────────────────────────

/** Where the event was read. */
export type ConstraintSource =
  | 'driver_note'
  /** The free-text `drivers.notes` column the legacy planner still matches on. */
  | 'legacy_driver_text'
  | 'vehicle_tuev'
  | 'vehicle_werkstatt_check';

/** How strong the evidence is. See the header for why the middle one matters. */
export type ConstraintCertainty = 'confirmed' | 'assumed_from_notice_date' | 'reported';

/** What the event did. */
export type ConstraintEffect =
  /** A constraint the planner can never bypass. */
  | 'hard_block'
  /** Surfaced for a person to judge; the planner is not bound by it. */
  | 'human_review'
  /** Weighed and found to carry no constraint. */
  | 'none';

/** How the event was tied to a driver or a vehicle. */
export type IdentityMatch =
  /** Matched on the UUID, which is the only match section 5 accepts. */
  | 'uuid'
  /** The row names an id that is not in the pool: no automatic link is made. */
  | 'unresolved_id';

/** One row of the log. */
export interface ConstraintDecision {
  subject: 'driver' | 'vehicle';
  /** The UUID. Empty only for a row whose subject could not be resolved. */
  subjectId: string;
  /** For reading. Never used to match: section 5 forbids matching on a name or a plate. */
  subjectLabel: string;
  identityMatch: IdentityMatch;
  /** The event's own code — a note type, or the vehicle fact. */
  event: string;
  /** The German label the screens use for that event. */
  eventLabel: string;
  source: ConstraintSource;
  certainty: ConstraintCertainty;
  effect: ConstraintEffect;
  /** The window the constraint covers, `YYYY-MM-DD`, or null when the event names none. */
  windowStart: string | null;
  windowEnd: string | null;
  /** Clock times inside the window, when the event is not a whole day. */
  windowStartTime: string | null;
  windowEndTime: string | null;
  /** True when the window came from the notice's own timestamp rather than the event's. */
  windowFromNoticeDate: boolean;
  /** True when a person has to look at this row. */
  needsHumanReview: boolean;
  /** Why the effect is what it is. German, like every other operator-facing reason. */
  reason: string;
}

// ── Driver events ───────────────────────────────────────────────────────────

/** The minimum of a driver the log needs. A `PlanningDriver` satisfies it. */
export interface ConstraintSubjectDriver {
  id: string;
  name: string;
  notes?: string | null;
}

/**
 * Note types that record something that **already happened** — a speed-camera
 * ticket, an accident, an inspection, a breakdown, a wait. They carry
 * `must_include_in_plan` in `app_private.note_behavior_for`, so the planner
 * does not exclude the driver for them, and section 5 says a past violation
 * must not become a block. They are human-review warnings.
 */
const PAST_EVENT_NOTE_TYPES: ReadonlySet<string> = new Set(['blitzer', 'accident', 'kontrolle', 'breakdown', 'wait']);

const labelOf = (noteType: string, fallback: string): string =>
  NOTE_TYPE_LABELS[noteType] ?? (fallback.trim() === '' ? noteType : fallback);

/** The window a note covers, read with the planner's own helper. */
function windowOf(note: StructuredNote): { start: string | null; end: string | null; fromNotice: boolean; hasInterval: boolean } {
  const explicit = note.start_date;
  const fallback = note.note_date ? note.note_date.slice(0, 10) : null;
  const start = explicit ?? fallback;
  const end = note.end_date ?? start;
  return {
    start,
    end,
    fromNotice: explicit === null && fallback !== null,
    // The planner's own helper decides whether the note covers any time at all.
    hasInterval: noteExclusionIntervals(note).length > 0,
  };
}

/**
 * The effect and the certainty one note carries.
 *
 * The `hard_block` branch is the one rule `checkStructuredNote` and
 * `findBlockingNote` apply, and nothing else: behaviour `exclude_from_plan`
 * plus a window that yields an interval. Everything else is weighed and
 * reported.
 */
export function effectOfNote(note: StructuredNote): {
  effect: ConstraintEffect;
  certainty: ConstraintCertainty;
  needsHumanReview: boolean;
  reason: string;
} {
  const { fromNotice, hasInterval } = windowOf(note);

  if (note.note_planning_behavior === 'exclude_from_plan') {
    if (!hasInterval) {
      return {
        effect: 'none',
        certainty: 'reported',
        needsHumanReview: true,
        reason: 'Sperrende Notiz ohne lesbaren Zeitraum - wird nicht angewendet, bitte Zeitraum nachtragen',
      };
    }
    return fromNotice
      ? {
          effect: 'hard_block',
          certainty: 'assumed_from_notice_date',
          needsHumanReview: true,
          reason: 'Sperre aus dem Eingangsdatum der Notiz abgeleitet, nicht aus dem Zeitpunkt des Ereignisses - bitte Zeitraum prüfen',
        }
      : {
          effect: 'hard_block',
          certainty: 'confirmed',
          needsHumanReview: false,
          reason: 'Bestätigtes sperrendes Ereignis mit eigenem Zeitraum',
        };
  }

  if (PAST_EVENT_NOTE_TYPES.has(note.note_type)) {
    return {
      effect: 'human_review',
      certainty: 'reported',
      needsHumanReview: true,
      reason: 'Vergangenes Ereignis - keine Sperre, nur zur menschlichen Prüfung',
    };
  }

  return {
    effect: 'none',
    certainty: 'reported',
    needsHumanReview: false,
    reason: 'Neutrale Notiz - keine Planungswirkung',
  };
}

/**
 * The legacy free-text rules of `drivers.notes` that `checkNote` still matches,
 * with the German label of each.
 *
 * They are **recurring availability rules, not events**: "keine Nachtschicht"
 * names no date. They are listed because they block today, and a log that left
 * them out would describe a planner that does not exist. Their certainty is
 * `reported` and they carry `needsHumanReview`, because a regular expression
 * over free text that an operator typed is the weakest evidence in the system
 * and it currently carries a hard constraint.
 *
 * The patterns are the same ten, in the same order, as `HARD_NOTE_TOKENS` in
 * `monatsplanungPhase3.ts`. They are duplicated rather than imported because
 * that constant is private to the planner, and `constraintDecisionLog.test.ts`
 * pins the two lists against each other by reading the planner's source.
 */
export const LEGACY_NOTE_RULES: ReadonlyArray<{ code: string; pattern: RegExp; label: string }> = [
  { code: 'no_night_shift', pattern: /keine\s+nachtschicht/i, label: 'Keine Nachtschicht' },
  { code: 'mornings_only', pattern: /nur\s+morgens/i, label: 'Nur morgens' },
  { code: 'weekend_only', pattern: /nur\s+wochenende/i, label: 'Nur Wochenende' },
  { code: 'not_monday', pattern: /nicht\s+montag/i, label: 'Nicht montags' },
  { code: 'not_tuesday', pattern: /nicht\s+dienstag/i, label: 'Nicht dienstags' },
  { code: 'not_wednesday', pattern: /nicht\s+mittwoch/i, label: 'Nicht mittwochs' },
  { code: 'not_thursday', pattern: /nicht\s+donnerstag/i, label: 'Nicht donnerstags' },
  { code: 'not_friday', pattern: /nicht\s+freitag/i, label: 'Nicht freitags' },
  { code: 'not_saturday', pattern: /nicht\s+samstag/i, label: 'Nicht samstags' },
  { code: 'not_sunday', pattern: /nicht\s+sonntag/i, label: 'Nicht sonntags' },
];

// ── Vehicle events ──────────────────────────────────────────────────────────

/** The minimum of a vehicle the log needs. */
export interface ConstraintSubjectVehicle {
  id: string;
  /** For reading only. */
  plate: string;
  /** `YYYY-MM-DD`, or null when the date is not recorded. */
  tuev_gueltig_bis?: string | null;
}

/** One weekly workshop check, as the log reads it. */
export interface WerkstattCheckRow {
  car_id: string;
  check_date: string;
  status: 'positive' | 'negative' | 'repaired' | string;
  notes?: string | null;
}

// ── Building the log ────────────────────────────────────────────────────────

export interface ConstraintLogInput {
  /** The driver pool the plan was made from. */
  drivers: readonly ConstraintSubjectDriver[];
  /** The structured notes, keyed by `drivers.id` — the UUID, never a name. */
  driverNotesMap: Map<string, readonly StructuredNote[]>;
  /** The vehicles the plan was made from. Optional: the driver half stands alone. */
  vehicles?: readonly ConstraintSubjectVehicle[];
  werkstattChecks?: readonly WerkstattCheckRow[];
  /**
   * The day the TÜV validity is judged against, `YYYY-MM-DD`. Passed in rather
   * than read from the clock: a log is about a period, and a function that asks
   * `new Date()` gives a different answer tomorrow for the same plan.
   */
  asOfDate?: string;
}

/**
 * Every constraint decision, in a stable order: drivers by their position in
 * the pool, then vehicles. One row per event, plus one row per note whose
 * driver is not in the pool — those are the rows section 5 asks to refuse an
 * automatic link for.
 */
export function buildConstraintDecisionLog(input: ConstraintLogInput): ConstraintDecision[] {
  const out: ConstraintDecision[] = [];
  const known = new Set(input.drivers.map(d => d.id));

  for (const driver of input.drivers) {
    for (const note of input.driverNotesMap.get(driver.id) ?? []) {
      out.push(decisionForNote(driver, note, 'uuid'));
    }
    out.push(...decisionsForLegacyText(driver));
  }

  // A note whose driver is not in the pool. The planner never applies it —
  // `driverNotesMap.get(driver.id)` cannot reach it — and section 5 asks that
  // the absence of a confident match be refused rather than guessed at by name.
  for (const [driverId, notes] of input.driverNotesMap) {
    if (known.has(driverId)) continue;
    for (const note of notes) {
      out.push({
        ...decisionForNote({ id: driverId, name: '' }, note, 'unresolved_id'),
        effect: 'none',
        needsHumanReview: true,
        reason: 'Notiz verweist auf eine Fahrer-ID, die nicht im Planungspool ist - keine automatische Zuordnung',
      });
    }
  }

  for (const vehicle of input.vehicles ?? []) {
    const tuev = decisionForTuev(vehicle, input.asOfDate);
    if (tuev) out.push(tuev);
  }
  const vehicleById = new Map((input.vehicles ?? []).map(v => [v.id, v]));
  for (const check of input.werkstattChecks ?? []) {
    out.push(decisionForWerkstattCheck(check, vehicleById.get(check.car_id)));
  }

  return out;
}

function decisionForNote(
  driver: ConstraintSubjectDriver,
  note: StructuredNote,
  identityMatch: IdentityMatch,
): ConstraintDecision {
  const window = windowOf(note);
  const verdict = effectOfNote(note);
  const timed = !note.is_full_day && note.start_time !== null && note.end_time !== null;
  return {
    subject: 'driver',
    subjectId: driver.id,
    subjectLabel: driver.name,
    identityMatch,
    event: note.note_type,
    eventLabel: labelOf(note.note_type, note.note_text ?? ''),
    source: 'driver_note',
    certainty: verdict.certainty,
    effect: verdict.effect,
    windowStart: window.start,
    windowEnd: window.end,
    windowStartTime: timed ? note.start_time : null,
    windowEndTime: timed ? note.end_time : null,
    windowFromNoticeDate: window.fromNotice,
    needsHumanReview: verdict.needsHumanReview,
    reason: verdict.reason,
  };
}

function decisionsForLegacyText(driver: ConstraintSubjectDriver): ConstraintDecision[] {
  const text = driver.notes;
  if (!text || text.trim() === '') return [];
  const lower = text.toLowerCase();
  return LEGACY_NOTE_RULES.filter(rule => rule.pattern.test(lower)).map(rule => ({
    subject: 'driver' as const,
    subjectId: driver.id,
    subjectLabel: driver.name,
    identityMatch: 'uuid' as const,
    event: rule.code,
    eventLabel: rule.label,
    source: 'legacy_driver_text' as const,
    certainty: 'reported' as const,
    // It blocks today. Saying otherwise would describe a planner that does not exist.
    effect: 'hard_block' as const,
    windowStart: null,
    windowEnd: null,
    windowStartTime: null,
    windowEndTime: null,
    windowFromNoticeDate: false,
    needsHumanReview: true,
    reason: 'Wiederkehrende Regel aus dem freien Notizfeld - sperrt, ist aber nur aus Text erkannt',
  }));
}

/**
 * An expired TÜV. The one vehicle fact that is a hard bar: operating the
 * vehicle is unlawful, not merely inadvisable. A missing date is reported, not
 * assumed valid and not assumed expired.
 */
function decisionForTuev(
  vehicle: ConstraintSubjectVehicle,
  asOfDate: string | undefined,
): ConstraintDecision | null {
  const base = {
    subject: 'vehicle' as const,
    subjectId: vehicle.id,
    subjectLabel: vehicle.plate,
    identityMatch: 'uuid' as const,
    event: 'tuev',
    eventLabel: 'TÜV',
    source: 'vehicle_tuev' as const,
    windowStartTime: null,
    windowEndTime: null,
    windowFromNoticeDate: false,
  };
  const valid = vehicle.tuev_gueltig_bis;
  if (!valid) {
    return {
      ...base,
      certainty: 'reported',
      effect: 'human_review',
      windowStart: null,
      windowEnd: null,
      needsHumanReview: true,
      reason: 'Kein TÜV-Datum erfasst - weder gültig noch abgelaufen belegt',
    };
  }
  if (!asOfDate) {
    return {
      ...base,
      certainty: 'reported',
      effect: 'human_review',
      windowStart: valid,
      windowEnd: null,
      needsHumanReview: true,
      reason: 'TÜV-Datum erfasst, aber kein Stichtag übergeben - Gültigkeit nicht bewertet',
    };
  }
  // String comparison, because both are `YYYY-MM-DD`: no zone, no clock, and
  // the lexical order of that shape is the calendar order.
  if (valid >= asOfDate) {
    return {
      ...base,
      certainty: 'confirmed',
      effect: 'none',
      windowStart: valid,
      windowEnd: null,
      needsHumanReview: false,
      reason: 'TÜV am Stichtag gültig',
    };
  }
  return {
    ...base,
    certainty: 'confirmed',
    effect: 'hard_block',
    windowStart: valid,
    windowEnd: null,
    needsHumanReview: false,
    reason: 'TÜV am Stichtag abgelaufen - Fahrzeug darf nicht eingesetzt werden',
  };
}

/**
 * A weekly workshop check.
 *
 * **Never a block, and the reason is the data model.** `werkstatt_checks`
 * carries a status, a check date and free text — and no out-of-service window
 * anywhere. A negative check says an inspection found something; it does not
 * say the car is off the road, nor until when. Turning it into a block would
 * mean inventing the window, which is the inference section 5 forbids. So it
 * is a human-review warning with the check's own date as its only window.
 */
function decisionForWerkstattCheck(
  check: WerkstattCheckRow,
  vehicle: ConstraintSubjectVehicle | undefined,
): ConstraintDecision {
  const negative = check.status === 'negative';
  return {
    subject: 'vehicle',
    subjectId: check.car_id,
    subjectLabel: vehicle?.plate ?? '',
    identityMatch: vehicle ? 'uuid' : 'unresolved_id',
    event: `werkstatt_${check.status}`,
    eventLabel: negative ? 'Werkstatt-Prüfung negativ' : `Werkstatt-Prüfung ${check.status}`,
    source: 'vehicle_werkstatt_check',
    certainty: 'reported',
    effect: negative ? 'human_review' : 'none',
    windowStart: check.check_date,
    windowEnd: check.check_date,
    windowStartTime: null,
    windowEndTime: null,
    windowFromNoticeDate: false,
    needsHumanReview: negative,
    reason: negative
      ? 'Negative Werkstatt-Prüfung - keine Sperre, da kein Ausfallzeitraum erfasst ist'
      : 'Werkstatt-Prüfung ohne Befund - keine Planungswirkung',
  };
}

/** The counts a report prints above the table. */
export interface ConstraintLogSummary {
  rows: number;
  hardBlocks: number;
  humanReview: number;
  none: number;
  fromNoticeDate: number;
  unresolvedIdentity: number;
}

export function summariseConstraintLog(rows: readonly ConstraintDecision[]): ConstraintLogSummary {
  return {
    rows: rows.length,
    hardBlocks: rows.filter(r => r.effect === 'hard_block').length,
    humanReview: rows.filter(r => r.effect === 'human_review').length,
    none: rows.filter(r => r.effect === 'none').length,
    fromNoticeDate: rows.filter(r => r.windowFromNoticeDate).length,
    unresolvedIdentity: rows.filter(r => r.identityMatch === 'unresolved_id').length,
  };
}
