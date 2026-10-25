/**
 * The note types and the rules about them that are not display: an incident
 * note must name a vehicle, and a note's planning effect follows its type. This
 * is the driver app's `note-rules.ts`, restated because that repository cannot
 * be imported; the backend refuses an incident note with no vehicle too
 * (`vehicle_required`, 20261013130000) and refuses a type and an effect that
 * disagree (`driver_notes_behavior_follows_type`, 20261022143000).
 *
 * The values are stored vocabulary and are never translated.
 */

/** In the order the note form offers them. */
export const NOTE_TYPES = [
  'general', 'sick', 'vacation', 'off',
  'blitzer', 'accident', 'kontrolle', 'breakdown', 'wait', 'other',
] as const;

export type NoteType = (typeof NOTE_TYPES)[number];

/** What a note does to the plan. The planner reads this and nothing else. */
export type NotePlanningBehavior = 'neutral' | 'exclude_from_plan' | 'must_include_in_plan';

export const NOTE_PLANNING_BEHAVIORS: readonly NotePlanningBehavior[] = [
  'neutral', 'exclude_from_plan', 'must_include_in_plan',
];

/**
 * The effect each type carries. For `general` and `other` it is only the
 * starting point: see `FREE_BEHAVIOR_NOTE_TYPES`.
 *
 * Written a second time in `app_private.note_behavior_for` (what the partner
 * path derives) and in the CHECK `driver_notes_behavior_follows_type` (the
 * boundary), because a CHECK runs as the writing role and that role cannot call
 * the function. `noteTypeVocabulary.test.ts` reads both migrations and fails
 * when this table and they differ.
 */
export const NOTE_TYPE_BEHAVIOR: Readonly<Record<NoteType, NotePlanningBehavior>> = {
  general: 'neutral',
  sick: 'exclude_from_plan',
  vacation: 'exclude_from_plan',
  off: 'exclude_from_plan',
  blitzer: 'must_include_in_plan',
  accident: 'must_include_in_plan',
  kontrolle: 'must_include_in_plan',
  breakdown: 'must_include_in_plan',
  wait: 'must_include_in_plan',
  other: 'neutral',
};

/**
 * The two types that carry no meaning of their own, so the operator chooses
 * their effect: a `general` note that must appear in the plan is a real use
 * (measured on staging, 22.10.2026), and the five incident types, which could
 * say the same, require a vehicle. For every other type the database refuses a
 * different effect.
 */
export const FREE_BEHAVIOR_NOTE_TYPES: readonly NoteType[] = ['general', 'other'];

/** The five that plan around a vehicle, and so must name one. */
export const INCIDENT_NOTE_TYPES: readonly NoteType[] = [
  'blitzer', 'accident', 'kontrolle', 'breakdown', 'wait',
];

export function noteVehicleRequired(type: string): boolean {
  return (INCIDENT_NOTE_TYPES as readonly string[]).includes(type);
}

/** Whether `type` is one of the ten. Exact: no case folding, no trimming. */
export function isNoteType(type: string): type is NoteType {
  return (NOTE_TYPES as readonly string[]).includes(type);
}

/** The effect a type starts with, or null for a type that is not one of the ten. */
export function noteBehaviorFor(type: string): NotePlanningBehavior | null {
  return isNoteType(type) ? NOTE_TYPE_BEHAVIOR[type] : null;
}

/** Whether the operator chooses this type's effect (`general`, `other`). */
export function noteBehaviorIsFree(type: string): boolean {
  return (FREE_BEHAVIOR_NOTE_TYPES as readonly string[]).includes(type);
}

/**
 * Whether the database will accept this type with this effect: the type is one
 * of the ten, the effect is one of the three, and either the type leaves the
 * effect to the operator or the effect is the type's own. The browser's copy of
 * `driver_notes_note_type_known` and `driver_notes_behavior_follows_type`, so
 * the screen can say so before a save is sent.
 */
export function notePairAllowed(type: string, behavior: string): boolean {
  if (!isNoteType(type)) return false;
  if (!(NOTE_PLANNING_BEHAVIORS as readonly string[]).includes(behavior)) return false;
  return noteBehaviorIsFree(type) || NOTE_TYPE_BEHAVIOR[type] === behavior;
}

/**
 * Whether the note lacks the vehicle its type needs. `keepsLegacyGap` is a note
 * saved before this rule existed that is being edited without changing its
 * type: refusing it would block a harmless correction behind a car nobody
 * recorded. A new note, or one whose type changes, never has it.
 */
export function noteVehicleMissing(
  type: string,
  carId: string,
  keepsLegacyGap = false,
): boolean {
  return noteVehicleRequired(type) && carId.trim() === '' && !keepsLegacyGap;
}
