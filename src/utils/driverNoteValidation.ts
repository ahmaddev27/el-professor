/**
 * Shared driver-note validation helper.
 *
 * Checks whether any ride/block assigned to a driver overlaps a "Von Planung
 * ausschließen" (exclude_from_plan) note for that driver.
 *
 * Used at every planning step and before export to enforce the invariant:
 *   no ride may be exported with a driver who is excluded during that interval.
 */

import type { StructuredNote } from './monatsplanungPhase3';
// Type-only: the validator names a dictionary key beside its German text.
import type { EngineMessageKey, EngineMessageVars } from '../i18n/engineMessageTypes';
import type { Phase1VehicleBlock } from './monatsplanungPhase1';
import type { PlanningDriver } from '../components/MonatsplanungDriverPool';

export interface NoteViolation {
  stepName: string;
  blockId?: string;
  vehicleIdentifier?: string;
  driverId: string;
  driverName: string;
  blockStart: Date;
  blockEnd: Date;
  noteType: string;
  /** Dictionary key for `noteType`, absent when it is the note's own free text. */
  noteTypeKey?: EngineMessageKey;
  noteRange: string;
  noteRangeKey?: EngineMessageKey;
  noteRangeVars?: EngineMessageVars;
  /** German, as the validator has always written it. The screens' fallback. */
  reason: string;
  reasonKey?: EngineMessageKey;
  reasonVars?: EngineMessageVars;
  action: string;
  actionKey?: EngineMessageKey;
}

export interface NoteValidationResult {
  ok: boolean;
  violations: NoteViolation[];
}

interface RideInterval {
  blockId?: string;
  vehicleIdentifier?: string;
  driverId: string;
  driverName: string;
  startMs: number;
  endMs: number;
}

/** Parse YYYY-MM-DD into its calendar parts. Returns null on failure. */
function parseDateParts(d: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
}

/** Parse HH:MM → minutes. Returns null on failure. */
function parseTimeMin(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? +m[1] * 60 + +m[2] : null;
}

/** Build a human-readable date-range string for a note. */
function noteRangeLabel(note: StructuredNote): string {
  const parts = noteRangeParts(note);
  if (!parts) return '?';
  return `${parts.dates}${parts.timed ? ` ${parts.from}–${parts.to}` : ' ganztägig'}`;
}

/**
 * The same range broken into its pieces, so the key can put them in another
 * order. Dates stay DD.MM.YYYY and times HH:MM in both languages.
 */
function noteRangeParts(
  note: StructuredNote,
): { dates: string; timed: boolean; from: string; to: string } | null {
  const start = note.start_date ?? (note.note_date ? note.note_date.slice(0, 10) : null);
  const end = note.end_date ?? start;
  if (!start) return null;
  const fmt = (d: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : d;
  };
  const dates = start === end ? fmt(start) : `${fmt(start)}–${fmt(end!)}`;
  const timed = !note.is_full_day && !!note.start_time && !!note.end_time;
  return { dates, timed, from: note.start_time ?? '', to: note.end_time ?? '' };
}

/** The key and vars for `noteRangeLabel`, or nothing when the note has no date. */
function noteRangeMessage(
  note: StructuredNote,
): { key: EngineMessageKey; vars: EngineMessageVars } | null {
  const parts = noteRangeParts(note);
  if (!parts) return null;
  return {
    key: parts.timed ? 'engine.noteRange.timed' : 'engine.noteRange.allDay',
    vars: { dates: parts.dates, from: parts.from, to: parts.to },
  };
}

/**
 * The German label of every structured note type. One table, because Phase 3's
 * rejection details and this validator both print it and used to hold their own
 * copy. Each entry has a dictionary key `engine.noteType.<type>`.
 */
export const NOTE_TYPE_LABELS: Readonly<Record<string, string>> = {
  sick: 'Krank',
  vacation: 'Urlaub',
  off: 'Nicht verfügbar',
  blitzer: 'Blitzer',
  accident: 'Unfall',
  kontrolle: 'Kontrolle',
  breakdown: 'Panne',
  wait: 'Wartezeit',
  other: 'Sonstiges',
  general: 'Allgemeine Notiz',
};

/** Human label for note type. */
function noteTypeLabel(note: StructuredNote): string {
  return NOTE_TYPE_LABELS[note.note_type] ?? note.note_text ?? note.note_type;
}

/** The key for that label, or undefined when it is the note's own free text. */
function noteTypeLabelKey(note: StructuredNote): EngineMessageKey | undefined {
  return NOTE_TYPE_LABELS[note.note_type] ? `engine.noteType.${note.note_type}` : undefined;
}

/** A note's active window on one calendar day, half-open: `[start, end)`. */
export interface NoteInterval {
  start: number;
  end: number;
}

/**
 * Iteration cap, so an open-ended or far-future note cannot freeze the browser.
 * Counted inclusively as day 0…366, exactly as the two day loops this replaces
 * did with `Math.min(end, start + 366 * MS_PER_DAY)`.
 */
const NOTE_RANGE_DAY_CAP = 366;

/**
 * The instants an `exclude_from_plan` note covers — one half-open interval per
 * calendar day of its range. This is the one source for that window: Phase 3's
 * `checkStructuredNote` and `findBlockingNote` below both read it, because they
 * held a copy each and the copies are what drifted.
 *
 * **The base is LOCAL midnight.** The block instants these are compared against
 * are local: Phase 1 builds `actual_start_ms` with `new Date(y, m, d, h, min)`,
 * and `parseLocalDatetime` below parses the same wall clock. Both copies built
 * the note window at `Date.UTC` instead, which in Europe/Berlin put every window
 * one or two hours late — so a note's first day was unprotected until 01:00 or
 * 02:00 local. Measured on staging 28.09.2026 against the 9 live
 * `exclude_from_plan` notes: 53 rides fell inside the window as it was built, 64
 * inside the correct one, and the 11 in the gap were all 00:00–02:00 local on the
 * first day of a note's range — rides given to a driver marked sick or on
 * holiday, because this hard constraint failed open.
 *
 * **Every boundary is built from its own day's calendar parts**, never by adding
 * 86 400 000 ms to the day before. So the 23- and 25-hour days at a DST
 * transition still end exactly where the next day begins, and a note's 08:00 is
 * 08:00 on every day of its range rather than drifting an hour after March.
 *
 * Rules carried over unchanged: a note with `is_full_day`, or with a missing or
 * unparseable time on either side, covers the whole calendar day; an end time at
 * or before the start time crosses midnight into the next day; the range's end
 * date is inclusive; and a note with no date at all covers nothing.
 */
export function noteExclusionIntervals(note: StructuredNote): NoteInterval[] {
  const startDate = note.start_date ?? (note.note_date ? note.note_date.slice(0, 10) : null);
  const endDate = note.end_date ?? startDate;
  if (!startDate || !endDate) return [];

  const from = parseDateParts(startDate);
  const to = parseDateParts(endDate);
  if (!from || !to) return [];
  const lastDayStart = new Date(to.y, to.m, to.d).getTime();

  // A full day is the default, and an unreadable time falls back to it.
  const sMin = note.is_full_day ? null : parseTimeMin(note.start_time);
  const eMin = note.is_full_day ? null : parseTimeMin(note.end_time);

  const out: NoteInterval[] = [];
  for (let i = 0; i <= NOTE_RANGE_DAY_CAP; i++) {
    const dayStart = new Date(from.y, from.m, from.d + i).getTime();
    if (dayStart > lastDayStart) break;

    if (sMin == null || eMin == null) {
      out.push({ start: dayStart, end: new Date(from.y, from.m, from.d + i + 1).getTime() });
    } else if (eMin > sMin) {
      out.push({
        start: new Date(from.y, from.m, from.d + i, 0, sMin).getTime(),
        end: new Date(from.y, from.m, from.d + i, 0, eMin).getTime(),
      });
    } else {
      out.push({
        start: new Date(from.y, from.m, from.d + i, 0, sMin).getTime(),
        end: new Date(from.y, from.m, from.d + i + 1, 0, eMin).getTime(),
      });
    }
  }
  return out;
}

/**
 * Check whether a single [startMs, endMs) interval overlaps any exclude_from_plan
 * note for the given driver. Returns the first matching note or null.
 */
export function findBlockingNote(
  driverId: string,
  startMs: number,
  endMs: number,
  driverNotesMap: Map<string, StructuredNote[]>,
): StructuredNote | null {
  const notes = driverNotesMap.get(driverId);
  if (!notes || notes.length === 0) return null;

  for (const note of notes) {
    if (note.note_planning_behavior !== 'exclude_from_plan') continue;

    for (const iv of noteExclusionIntervals(note)) {
      // Overlap: [startMs, endMs) ∩ [iv.start, iv.end) ≠ ∅
      if (startMs < iv.end && endMs > iv.start) {
        return note;
      }
    }
  }
  return null;
}

/**
 * Validate a set of ride/block intervals against driver notes.
 *
 * Also catches:
 *   - empty driverName (exported row without a Fahrer)
 *   - driverName === 'Nicht zugewiesen'
 *   - driverId present in driverNotesMap with an exclude_from_plan overlap
 */
export function validateDriverNotesForPlanStep(opts: {
  stepName: string;
  rides: RideInterval[];
  driverNotesMap: Map<string, StructuredNote[]>;
  /** Optional driver pool for fallback name→id lookup. */
  driverProfiles?: PlanningDriver[];
}): NoteValidationResult {
  const { stepName, rides, driverNotesMap, driverProfiles } = opts;
  const violations: NoteViolation[] = [];

  // Build name→id fallback map for cases where driver_id might be missing
  const nameToId = new Map<string, string>();
  for (const d of (driverProfiles ?? [])) {
    nameToId.set(normalizeDriverName(d.name), d.id);
  }

  for (const ride of rides) {
    const driverName = ride.driverName ?? '';
    const normalizedName = normalizeDriverName(driverName);

    // 1. Empty Fahrername
    if (!driverName.trim()) {
      violations.push({
        stepName,
        blockId: ride.blockId,
        vehicleIdentifier: ride.vehicleIdentifier,
        driverId: ride.driverId,
        driverName: '(leer)',
        blockStart: new Date(ride.startMs),
        blockEnd: new Date(ride.endMs),
        noteType: '—',
        noteRange: '—',
        reason: 'Fahrername ist leer',
        reasonKey: 'engine.noteViolation.emptyDriverName',
        action: 'Zur Neuverteilung freigegeben',
        actionKey: 'engine.noteViolation.action.releasedForReassignment',
      });
      continue;
    }

    // 2. Nicht zugewiesen
    if (normalizedName === 'nicht zugewiesen') {
      violations.push({
        stepName,
        blockId: ride.blockId,
        vehicleIdentifier: ride.vehicleIdentifier,
        driverId: ride.driverId,
        driverName,
        blockStart: new Date(ride.startMs),
        blockEnd: new Date(ride.endMs),
        noteType: '—',
        noteRange: '—',
        reason: '"Nicht zugewiesen" ist kein gültiger Fahrer',
        reasonKey: 'engine.noteViolation.unassignedIsNotADriver',
        action: 'Zur Neuverteilung freigegeben',
        actionKey: 'engine.noteViolation.action.releasedForReassignment',
      });
      continue;
    }

    // 3. Note violation — first look up by ID, then by normalised name
    let resolvedId = ride.driverId || nameToId.get(normalizedName) || '';

    const blockingNote = resolvedId
      ? findBlockingNote(resolvedId, ride.startMs, ride.endMs, driverNotesMap)
      : null;

    if (blockingNote) {
      violations.push({
        stepName,
        blockId: ride.blockId,
        vehicleIdentifier: ride.vehicleIdentifier,
        driverId: resolvedId,
        driverName,
        blockStart: new Date(ride.startMs),
        blockEnd: new Date(ride.endMs),
        noteType: noteTypeLabel(blockingNote),
        noteTypeKey: noteTypeLabelKey(blockingNote),
        noteRange: noteRangeLabel(blockingNote),
        noteRangeKey: noteRangeMessage(blockingNote)?.key,
        noteRangeVars: noteRangeMessage(blockingNote)?.vars,
        reason: `Fahrer durch Notiz ausgeschlossen: ${noteTypeLabel(blockingNote)} (${noteRangeLabel(blockingNote)})`,
        reasonKey: 'engine.noteViolation.excludedByNote',
        // `label` is the note type's own key when the type is known, so
        // engineText() translates it inside the sentence; the range is not a
        // key, so it is passed as the text the engine already built.
        reasonVars: {
          label: noteTypeLabelKey(blockingNote) ?? noteTypeLabel(blockingNote),
          range: noteRangeLabel(blockingNote),
        },
        action: 'Zur Neuverteilung freigegeben',
        actionKey: 'engine.noteViolation.action.releasedForReassignment',
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

/** Normalise a driver name for fuzzy matching (trim, lowercase, collapse spaces). */
export function normalizeDriverName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Build RideInterval array from Phase 1 blocks + a driver assignment map. */
export function buildRideIntervalsFromBlocks(
  blocks: (Phase1VehicleBlock & { driver_id?: string; driver_name?: string })[],
): RideInterval[] {
  return blocks.map(b => ({
    blockId: b.block_id,
    vehicleIdentifier: b.vehicle_identifier,
    driverId: b.driver_id ?? '',
    driverName: b.driver_name ?? '',
    startMs: b.actual_start_ms && b.actual_start_ms > 0
      ? b.actual_start_ms
      : parseLocalDatetime(b.block_start_datetime),
    endMs: b.actual_end_ms && b.actual_end_ms > 0
      ? b.actual_end_ms
      : parseLocalDatetime(b.block_end_datetime),
  }));
}

/** Parse YYYY-MM-DDTHH:MM as local time → ms. */
export function parseLocalDatetime(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
}
