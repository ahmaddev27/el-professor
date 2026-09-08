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
  noteRange: string;
  reason: string;
  action: string;
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

/** Parse YYYY-MM-DD → UTC midnight ms. Returns NaN on failure. */
function parseDateUtcMs(d: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

/** Parse HH:MM → minutes. Returns null on failure. */
function parseTimeMin(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? +m[1] * 60 + +m[2] : null;
}

/** Build a human-readable date-range string for a note. */
function noteRangeLabel(note: StructuredNote): string {
  const start = note.start_date ?? (note.note_date ? note.note_date.slice(0, 10) : null);
  const end = note.end_date ?? start;
  if (!start) return '?';
  const fmt = (d: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : d;
  };
  const datePart = start === end ? fmt(start) : `${fmt(start)}–${fmt(end!)}`;
  const timePart = !note.is_full_day && note.start_time && note.end_time
    ? ` ${note.start_time}–${note.end_time}`
    : ' ganztägig';
  return `${datePart}${timePart}`;
}

/** Human label for note type. */
function noteTypeLabel(note: StructuredNote): string {
  const labels: Record<string, string> = {
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
  return labels[note.note_type] ?? note.note_text ?? note.note_type;
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

  const MS_PER_DAY = 86_400_000;

  for (const note of notes) {
    if (note.note_planning_behavior !== 'exclude_from_plan') continue;

    const noteStartDate = note.start_date ?? (note.note_date ? note.note_date.slice(0, 10) : null);
    const noteEndDate = note.end_date ?? noteStartDate;
    if (!noteStartDate) continue;

    const noteRangeStart = parseDateUtcMs(noteStartDate);
    // Inclusive end → exclusive: add one full day
    const noteRangeEndInclusive = parseDateUtcMs(noteEndDate!);
    if (isNaN(noteRangeStart) || isNaN(noteRangeEndInclusive)) continue;

    // Cap iteration at 366 days to prevent browser freeze with open-ended notes.
    const cappedRangeEnd = Math.min(noteRangeEndInclusive, noteRangeStart + 366 * MS_PER_DAY);

    let dateMs = noteRangeStart;
    while (dateMs <= cappedRangeEnd) {
      let noteIntervalStart: number;
      let noteIntervalEnd: number;

      if (note.is_full_day || !note.start_time || !note.end_time) {
        noteIntervalStart = dateMs;
        noteIntervalEnd = dateMs + MS_PER_DAY;
      } else {
        const sMin = parseTimeMin(note.start_time);
        const eMin = parseTimeMin(note.end_time);
        if (sMin == null || eMin == null) {
          noteIntervalStart = dateMs;
          noteIntervalEnd = dateMs + MS_PER_DAY;
        } else if (eMin > sMin) {
          noteIntervalStart = dateMs + sMin * 60_000;
          noteIntervalEnd = dateMs + eMin * 60_000;
        } else {
          // Cross-midnight
          noteIntervalStart = dateMs + sMin * 60_000;
          noteIntervalEnd = dateMs + MS_PER_DAY + eMin * 60_000;
        }
      }

      // Overlap: [startMs, endMs) ∩ [noteStart, noteEnd) ≠ ∅
      if (startMs < noteIntervalEnd && endMs > noteIntervalStart) {
        return note;
      }

      dateMs += MS_PER_DAY;
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
        action: 'Zur Neuverteilung freigegeben',
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
        action: 'Zur Neuverteilung freigegeben',
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
        noteRange: noteRangeLabel(blockingNote),
        reason: `Fahrer durch Notiz ausgeschlossen: ${noteTypeLabel(blockingNote)} (${noteRangeLabel(blockingNote)})`,
        action: 'Zur Neuverteilung freigegeben',
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
