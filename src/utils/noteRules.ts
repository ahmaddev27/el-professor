/**
 * The note types and the one rule about them that is not display: an incident
 * note must name a vehicle. This is the driver app's `note-rules.ts`, restated
 * because that repository cannot be imported; the backend refuses an incident
 * note with no vehicle too (`vehicle_required`, 20261013130000).
 *
 * The values are stored vocabulary and are never translated.
 */

/** In the order the note form offers them. */
export const NOTE_TYPES = [
  'general', 'sick', 'vacation', 'off',
  'blitzer', 'accident', 'kontrolle', 'breakdown', 'wait', 'other',
] as const;

export type NoteType = (typeof NOTE_TYPES)[number];

/** The five that plan around a vehicle, and so must name one. */
export const INCIDENT_NOTE_TYPES: readonly NoteType[] = [
  'blitzer', 'accident', 'kontrolle', 'breakdown', 'wait',
];

export function noteVehicleRequired(type: string): boolean {
  return (INCIDENT_NOTE_TYPES as readonly string[]).includes(type);
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
