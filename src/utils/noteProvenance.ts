/**
 * What a driver note records about itself, and the rules the browser keeps in
 * step with the database (20261022150000).
 *
 * A note says when its event happened (`occurred_at`), when the source reported
 * it (`reported_at`) and, stamped by the database, when it arrived
 * (`received_at`); how it got in (`entry_source`); which document backs it
 * (`evidence_path`); whether anyone has checked it (`verification_status`); where
 * it was; and what has changed since. None of it is read by the planner (see
 * `noteProvenanceSafety.test.ts`), so nothing here may be imported by an engine.
 *
 * The values are stored vocabulary and are never translated. The database
 * refuses what this file refuses; the copy exists so the screen can say so
 * before a save is sent, and `noteProvenanceVocabulary.test.ts` reads the
 * migration and fails when the two part.
 */
import { format } from 'date-fns';
import type { TranslationKey } from '../i18n';
import { NOTE_TYPE_BEHAVIOR, isNoteType } from './noteRules';
import { parseCoordinate } from './returnCheckScreens';

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** How a row got in. Stamped by the database trigger; a client's value is overwritten. */
export const ENTRY_SOURCES = ['manual', 'driver_app', 'system', 'legacy'] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];

export const VERIFICATION_STATUSES = ['unverified', 'verified', 'rejected'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** The provenance columns as a read of `driver_notes` returns them. All optional: a row read before the migration lacks them. */
export interface NoteProvenance {
  occurred_at?: string | null;
  reported_at?: string | null;
  received_at?: string | null;
  entry_source?: string | null;
  evidence_path?: string | null;
  verification_status?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  rejected_reason?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  location_accuracy_m?: number | null;
  change_log?: unknown;
}

/** A value outside the vocabulary reads as the weakest claim, never as a stronger one. */
export function entrySourceOf(note: NoteProvenance): EntrySource {
  const value = note.entry_source;
  return (ENTRY_SOURCES as readonly string[]).includes(value ?? '') ? (value as EntrySource) : 'legacy';
}

export function verificationOf(note: NoteProvenance): VerificationStatus {
  const value = note.verification_status;
  return (VERIFICATION_STATUSES as readonly string[]).includes(value ?? '') ? (value as VerificationStatus) : 'unverified';
}

/**
 * Whether the event details (a moment, a place, a document) belong on a note of
 * this type. For sick, vacation and off the window IS the fact, and a document
 * would be a health record; the database allows both, the screen does not offer
 * them. `general` and `other` leave the effect to the operator and are offered.
 */
export function eventDetailsApply(type: string): boolean {
  return !(isNoteType(type) && NOTE_TYPE_BEHAVIOR[type] === 'exclude_from_plan');
}

// ── The document ─────────────────────────────────────────────────────────────

export const EVIDENCE_BUCKET = 'documents';
export const EVIDENCE_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'webp'] as const;
export type EvidenceExtension = (typeof EVIDENCE_EXTENSIONS)[number];
export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;

const EVIDENCE_CONTENT_TYPE: Readonly<Record<EvidenceExtension, string>> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_ONLY = new RegExp(`^${UUID}$`);

/** The key of a note's document: `<company>/driver-notes/<note>/<file>.<ext>`. A bucket key, never a URL. */
export function evidenceKey(companyId: string, noteId: string, fileId: string, ext: EvidenceExtension): string {
  return `${companyId}/driver-notes/${noteId}/${fileId}.${ext}`;
}

/** The browser's copy of `driver_notes_evidence_path_shape`. */
export function isEvidenceKey(key: string, companyId: string, noteId: string): boolean {
  if (!UUID_ONLY.test(companyId) || !UUID_ONLY.test(noteId)) return false;
  return new RegExp(`^${companyId}/driver-notes/${noteId}/${UUID}\\.(${EVIDENCE_EXTENSIONS.join('|')})$`).test(key);
}

export type EvidenceFileProblem = 'empty' | 'size' | 'type';

export type EvidenceFileCheck =
  | { ok: true; ext: EvidenceExtension; contentType: string }
  | { ok: false; problem: EvidenceFileProblem };

/**
 * The extension decides, and the content type sent to storage comes from it, not
 * from what the browser claimed: a file named `x.png` that the browser calls
 * `image/svg+xml` is refused, not stored as a PNG. No SVG and no HTML: a document
 * served inline from the API origin executes its script (20260928100000).
 */
export function checkEvidenceFile(file: { name: string; type: string; size: number }): EvidenceFileCheck {
  if (file.size <= 0) return { ok: false, problem: 'empty' };
  if (file.size > EVIDENCE_MAX_BYTES) return { ok: false, problem: 'size' };
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (!(EVIDENCE_EXTENSIONS as readonly string[]).includes(ext)) return { ok: false, problem: 'type' };
  const contentType = EVIDENCE_CONTENT_TYPE[ext as EvidenceExtension];
  if (file.type !== '' && file.type !== contentType) return { ok: false, problem: 'type' };
  return { ok: true, ext: ext as EvidenceExtension, contentType };
}

// ── The two moments ──────────────────────────────────────────────────────────

/** A `datetime-local` value (local time, no offset) as an instant with an explicit offset, or null when empty or unreadable. */
export function instantFromLocalInput(value: string): string | null {
  if (value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** An instant as a `datetime-local` value in the browser's zone, or '' for none. */
export function localInputFromInstant(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : format(date, "yyyy-MM-dd'T'HH:mm");
}

/** True when both are set and the event is dated after its report (`driver_notes_occurred_not_after_reported`). */
export function eventAfterReport(occurredLocal: string, reportedLocal: string): boolean {
  const occurred = instantFromLocalInput(occurredLocal);
  const reported = instantFromLocalInput(reportedLocal);
  return occurred !== null && reported !== null && new Date(occurred).getTime() > new Date(reported).getTime();
}

// ── The place ────────────────────────────────────────────────────────────────

export interface PositionText {
  latitude: string;
  longitude: string;
  accuracy: string;
}

export type PositionProblem = 'number' | 'pair' | 'range' | 'accuracy';

export type PositionRead =
  | { ok: true; latitude: number | null; longitude: number | null; accuracy: number | null }
  | { ok: false; problem: PositionProblem };

export const MAX_ACCURACY_M = 100000;

/** German decimals read ("51,5"); a filled field that is not a number is a problem, an empty one is none. */
export function readPosition(text: PositionText): PositionRead {
  const latFilled = text.latitude.trim() !== '';
  const lonFilled = text.longitude.trim() !== '';
  const accFilled = text.accuracy.trim() !== '';

  const latitude = latFilled ? parseCoordinate(text.latitude) : null;
  const longitude = lonFilled ? parseCoordinate(text.longitude) : null;
  if ((latFilled && latitude === null) || (lonFilled && longitude === null)) return { ok: false, problem: 'number' };
  if (latFilled !== lonFilled) return { ok: false, problem: 'pair' };
  if ((latitude !== null && (latitude < -90 || latitude > 90))
      || (longitude !== null && (longitude < -180 || longitude > 180))) {
    return { ok: false, problem: 'range' };
  }

  let accuracy: number | null = null;
  if (accFilled) {
    const trimmed = text.accuracy.trim().replace(',', '.');
    if (!/^\d{1,6}(\.\d+)?$/.test(trimmed)) return { ok: false, problem: 'number' };
    accuracy = Number(trimmed);
    if (latitude === null || accuracy > MAX_ACCURACY_M) return { ok: false, problem: 'accuracy' };
  }
  return { ok: true, latitude, longitude, accuracy };
}

// ── What the form sends ──────────────────────────────────────────────────────

/** The five fields the Notizen form edits, as the inputs hold them. */
export interface ProvenanceFormValues {
  occurred_at: string;
  reported_at: string;
  latitude: string;
  longitude: string;
  location_accuracy_m: string;
}

export const EMPTY_PROVENANCE_FORM: ProvenanceFormValues = {
  occurred_at: '',
  reported_at: '',
  latitude: '',
  longitude: '',
  location_accuracy_m: '',
};

export type ProvenancePayload = Partial<{
  occurred_at: string | null;
  reported_at: string | null;
  latitude: number | null;
  longitude: number | null;
  location_accuracy_m: number | null;
}>;

export type ProvenanceProblem = 'eventOrder' | PositionProblem;

export type ProvenanceRead =
  | { ok: true; payload: ProvenancePayload }
  | { ok: false; problem: ProvenanceProblem };

/** The form values of a stored note: what the inputs show when it is opened for editing. */
export function provenanceFormOf(note: NoteProvenance): ProvenanceFormValues {
  return {
    occurred_at: localInputFromInstant(note.occurred_at),
    reported_at: localInputFromInstant(note.reported_at),
    latitude: typeof note.latitude === 'number' ? String(note.latitude).replace('.', ',') : '',
    longitude: typeof note.longitude === 'number' ? String(note.longitude).replace('.', ',') : '',
    location_accuracy_m: typeof note.location_accuracy_m === 'number' ? String(note.location_accuracy_m).replace('.', ',') : '',
  };
}

/**
 * The columns a save adds to its payload.
 *
 * A new note sends only what was filled in, so a note that uses none of this
 * sends what it always sent. An edit sends only what the person changed: a value
 * read from the database and echoed back would not survive the round trip (a
 * time with seconds shown to the minute, a coordinate shown to five places), and
 * the database logs every change and takes a verification back for some of them.
 * The position travels as a unit, so the pair rule can hold.
 */
export function provenancePayload(current: ProvenanceFormValues, initial: ProvenanceFormValues | null): ProvenanceRead {
  if (eventAfterReport(current.occurred_at, current.reported_at)) return { ok: false, problem: 'eventOrder' };

  const position = readPosition({
    latitude: current.latitude,
    longitude: current.longitude,
    accuracy: current.location_accuracy_m,
  });
  if (!position.ok) return { ok: false, problem: position.problem };

  const was = initial ?? EMPTY_PROVENANCE_FORM;
  const payload: ProvenancePayload = {};
  if (current.occurred_at !== was.occurred_at) payload.occurred_at = instantFromLocalInput(current.occurred_at);
  if (current.reported_at !== was.reported_at) payload.reported_at = instantFromLocalInput(current.reported_at);
  if (current.latitude !== was.latitude || current.longitude !== was.longitude
      || current.location_accuracy_m !== was.location_accuracy_m) {
    payload.latitude = position.latitude;
    payload.longitude = position.longitude;
    payload.location_accuracy_m = position.accuracy;
  }
  return { ok: true, payload };
}

/** The sentence for a problem found before a save. */
export const PROVENANCE_PROBLEM_KEYS: Readonly<Record<ProvenanceProblem, TranslationKey>> = {
  eventOrder: 'notes.prov.err.eventOrder',
  number: 'notes.prov.err.number',
  pair: 'notes.prov.err.position',
  range: 'notes.prov.err.position',
  accuracy: 'notes.prov.err.accuracy',
};

/** The sentence for a constraint the database refused, found by its name in the error; null for any other error. */
const CONSTRAINT_KEYS: Readonly<Record<string, TranslationKey>> = {
  driver_notes_occurred_not_after_reported: 'notes.prov.err.eventOrder',
  driver_notes_location_pair: 'notes.prov.err.position',
  driver_notes_location_range: 'notes.prov.err.position',
  driver_notes_location_accuracy: 'notes.prov.err.accuracy',
  driver_notes_rejection_has_reason: 'notes.prov.err.rejectReason',
  driver_notes_evidence_path_shape: 'notes.prov.err.evidenceUpload',
};

export function provenanceErrorKey(error: unknown): TranslationKey | null {
  const text = [(error as { message?: unknown })?.message, (error as { details?: unknown })?.details]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  const hit = Object.keys(CONSTRAINT_KEYS).find(name => text.includes(name));
  return hit ? CONSTRAINT_KEYS[hit] : null;
}

// ── A review is of what was on the page ──────────────────────────────────────

/**
 * What the database's provenance guard takes a decision back for
 * (`c_reviewed` in 20261022150000): the facts of the note, not its planning
 * effect and not `note_date`.
 */
export const REVIEWED_COLUMNS = [
  'driver_id', 'car_id', 'note_type', 'is_full_day', 'start_date', 'end_date',
  'start_time', 'end_time', 'occurred_at', 'reported_at', 'latitude', 'longitude',
  'location_accuracy_m', 'evidence_path', 'note_text',
] as const;

/** The form's values for those columns (the document is not edited in the form, so it is not here). */
export interface ReviewedFormValues {
  driver_id: string;
  car_id: string;
  note_type: string;
  is_full_day: boolean;
  start_date: string;
  end_date: string;
  start_time: string;
  end_time: string;
  occurred_at: string;
  reported_at: string;
  latitude: string;
  longitude: string;
  location_accuracy_m: string;
  note_text: string;
}

/** Whether saving `current` over `initial` changes anything a review covered. Only a hint: the database decides. */
export function reviewedFieldsChanged(initial: ReviewedFormValues, current: ReviewedFormValues): boolean {
  return (Object.keys(initial) as (keyof ReviewedFormValues)[]).some(key => initial[key] !== current[key]);
}

// ── What changed ─────────────────────────────────────────────────────────────

export interface ChangeLogEntry {
  at: string;
  /** The account that made the change; null for a writer with no session. */
  by: string | null;
  changed: string[];
  /** The earlier values of the structured fields. Free text is named in `changed` and never kept. */
  previous: Record<string, unknown>;
  /** The trigger itself took a decision back. */
  verificationReset: boolean;
}

/** Reads the stored log defensively; an entry that does not parse is dropped, not guessed. Oldest first, as stored. */
export function readChangeLog(value: unknown): ChangeLogEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ChangeLogEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.at !== 'string' || !Array.isArray(entry.changed)) continue;
    entries.push({
      at: entry.at,
      by: typeof entry.by === 'string' ? entry.by : null,
      changed: entry.changed.filter((name): name is string => typeof name === 'string'),
      previous: typeof entry.previous === 'object' && entry.previous !== null ? (entry.previous as Record<string, unknown>) : {},
      verificationReset: entry.verification_reset === true,
    });
  }
  return entries;
}

export type HistoryField =
  | 'driver' | 'vehicle' | 'type' | 'planning' | 'window' | 'occurred' | 'reported'
  | 'place' | 'evidence' | 'text' | 'review' | 'company';

const HISTORY_FIELD_OF: Readonly<Record<string, HistoryField>> = {
  driver_id: 'driver',
  car_id: 'vehicle',
  note_type: 'type',
  note_planning_behavior: 'planning',
  is_full_day: 'window',
  start_date: 'window',
  end_date: 'window',
  start_time: 'window',
  end_time: 'window',
  occurred_at: 'occurred',
  reported_at: 'reported',
  latitude: 'place',
  longitude: 'place',
  location_accuracy_m: 'place',
  evidence_path: 'evidence',
  note_text: 'text',
  verification_status: 'review',
  reviewed_by: 'review',
  reviewed_at: 'review',
  rejected_reason: 'review',
  company_id: 'company',
};

/** The columns of one entry as the handful of things a person would name, each once, in order. */
export function historyFields(changed: readonly string[]): HistoryField[] {
  const fields: HistoryField[] = [];
  for (const column of changed) {
    const field = HISTORY_FIELD_OF[column];
    if (field && !fields.includes(field)) fields.push(field);
  }
  return fields;
}
