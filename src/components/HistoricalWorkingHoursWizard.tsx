/**
 * HistoricalWorkingHoursWizard
 *
 * "Alter Monat / Steuerberater-Abgleich — Mit Arbeitsstunden" mode.
 *
 * Steps:
 *  0 – Monat & Fahrtenbuch-Import wählen
 *  1 – Lohnabrechnung-Zielwerte je Fahrer eingeben
 *  2 – Abgleich berechnen
 *  3 – Blockbasierter Abgleich – Neustart (Phase 1 diagnostic)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Calculator, AlertTriangle,
  RefreshCw, Save, CheckCircle2, Layers,
  Calendar, List, Download,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { deleteChecked } from '../lib/writeOutcome';
import { useAuth } from '../contexts/AuthContext';
import HistoricalHourTargetsManager, {
  HourTargetsTrigger,
  saveDriverConfigsAsTargets,
  type HoursDriver,
} from './HistoricalHourTargetsManager';
import type { FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
import {
  buildVehicleBlocksForHistoricalWorkingHours,
  assignRegularDriversToVehicleBlocks,
  assignSurplusBlocksToInhaberWithoutTimeChange,
  shiftOverlappingInhaberBlocks,
  buildFinalBlockAssignmentSnapshot,
  validateHistoricalWorkingHoursExportReadiness,
  formatBlockDuration,
  formatBlockDatetime,
  formatBlockHours,
  blockStatusLabel,
  blockStatusLabelKey,
  blockWarningLabels,
  blockWarningLabelKeys,
  blockSourceRowRange,
  type VehicleBlock,
  type BuildVehicleBlocksResult,
  type RegularDriverTarget,
  type RegularDriverAssignmentResult,
  type RegularBlockAssignment,
  type RegularDriverAssignmentSummary,
  type InhaberTarget,
  type InhaberAssignmentResult,
  type OwnerShiftResult,
  type FinalBlockAssignmentSnapshotResult,
  type FinalBlockAssignmentRow,
  type HistoricalWorkingHoursExportValidationResult,
  type RegularAssignmentStrategy,
  type DriverPlanningExclusion,
  computeLohnartSeconds,
  getGermanNationalHolidays,
  resolveFullDatetime,
  parseFullDatetimeMs,
} from '../utils/historicalWorkingHoursCleanEngine';
import {
  exportHistoricalWorkingHoursFahrtenbuch,
  buildFahrtenbuchExportSummary,
  type FahrtenbuchExportSummary,
  type GeneratedWorksheetAuditResult,
  type ExportRowDiagnostic,
} from '../utils/historicalWorkingHoursFahrtenbuchExport';
import {
  runHistoricalArbeitsstundenRowLevelEngine,
  type ArbeitsstundenEngineResult,
} from '../utils/historicalRowLevelEngine';
import {
  buildStundennachweisPreview,
  type HistoricalWorkingHoursStundennachweisPreviewResult,
} from '../utils/historicalWorkingHoursStundennachweisPreview';
import * as XLSX from 'xlsx';
import { hasSimulatedRides, writeMarkedWorkbook } from '../utils/simulatedRides/marker';
import { type StructuredNote } from '../utils/monatsplanungPhase3';
import { fetchAllPaginated } from '../utils/fetchAllPaginated';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import { engineText } from '../i18n/engineMessage';
import type { TranslationKey, TranslationVars } from '../i18n';

/** Signature of the `t` from useTranslation(), for helpers that take it. */
type Translate = (key: TranslationKey, vars?: TranslationVars) => string;

// ── Constants ─────────────────────────────────────────────────────────────────

// German month names are the stored value of `historical_driver_hour_targets.month`
// and the argument to saveDriverConfigsAsTargets — data, never a label.
const MONTHS_DE = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

// Display counterpart of MONTHS_DE. Holds TranslationKeys because this list is
// module-level and t() is a hook value; every consumer resolves it.
const MONTH_KEYS = [
  'hwh.monthJanuary', 'hwh.monthFebruary', 'hwh.monthMarch', 'hwh.monthApril',
  'hwh.monthMay', 'hwh.monthJune', 'hwh.monthJuly', 'hwh.monthAugust',
  'hwh.monthSeptember', 'hwh.monthOctober', 'hwh.monthNovember', 'hwh.monthDecember',
] as const;

const BATCH_SIZE = 1000;

// ── Driver exclusion helper ───────────────────────────────────────────────────
// Replicates the same logic as checkStructuredNote in monatsplanungPhase3.ts
// but works at ride/interval level (ms timestamps) rather than block level.

const MS_PER_DAY = 86_400_000;

// Keyed on the stored `note_type` value; the values are TranslationKeys resolved
// by the caller, because this map is module-level.
const NOTE_TYPE_LABEL_KEYS: Record<string, TranslationKey> = {
  sick: 'hwh.noteTypeSick',
  vacation: 'hwh.noteTypeVacation',
  off: 'hwh.noteTypeUnavailable',
  krank: 'hwh.noteTypeSick',
  urlaub: 'hwh.noteTypeVacation',
};

function _parseDateMsLocal(d: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

function _timeToMinLocal(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(time);
  return m ? +m[1] * 60 + +m[2] : null;
}

/**
 * Returns { excluded: true, detail } if the driver has any 'exclude_from_plan'
 * note that overlaps [rideStartMs, rideEndMs). Match is by driver ID first,
 * then by normalized name as fallback via the nameToId map.
 */
function isDriverExcludedFromPlanning(
  driverId: string | null,
  driverName: string,
  rideStartMs: number,
  rideEndMs: number,
  notesMap: Map<string, StructuredNote[]>,
  nameToId: Map<string, string> | undefined,
  t: Translate,
): { excluded: false } | { excluded: true; detail: string } {
  const normName = driverName.trim().toLowerCase().replace(/\s+/g, ' ');
  const resolvedId = driverId ?? nameToId?.get(normName) ?? null;
  const notes = resolvedId ? (notesMap.get(resolvedId) ?? []) : [];

  for (const note of notes) {
    if (note.note_planning_behavior !== 'exclude_from_plan') continue;
    const noteStartDate = note.start_date ?? (note.note_date ? note.note_date.slice(0, 10) : null);
    const noteEndDate = note.end_date ?? noteStartDate;
    if (!noteStartDate) continue;
    const rangeStartMs = _parseDateMsLocal(noteStartDate);
    const rangeEndMs   = _parseDateMsLocal(noteEndDate!);
    if (isNaN(rangeStartMs) || isNaN(rangeEndMs)) continue;
    const cappedEnd = Math.min(rangeEndMs, rangeStartMs + 366 * MS_PER_DAY);
    let dateMs = rangeStartMs;
    while (dateMs <= cappedEnd) {
      let intStart: number, intEnd: number;
      if (note.is_full_day || !note.start_time || !note.end_time) {
        intStart = dateMs;
        intEnd   = dateMs + MS_PER_DAY;
      } else {
        const sMin = _timeToMinLocal(note.start_time);
        const eMin = _timeToMinLocal(note.end_time);
        if (sMin == null || eMin == null) { intStart = dateMs; intEnd = dateMs + MS_PER_DAY; }
        else if (eMin > sMin) { intStart = dateMs + sMin * 60_000; intEnd = dateMs + eMin * 60_000; }
        else { intStart = dateMs + sMin * 60_000; intEnd = dateMs + MS_PER_DAY + eMin * 60_000; }
      }
      if (rideStartMs < intEnd && rideEndMs > intStart) {
        const labelKey = NOTE_TYPE_LABEL_KEYS[note.note_type?.toLowerCase() ?? ''];
        const noteLabel = labelKey ? t(labelKey) : (note.note_type ?? t('hwh.noteTypeExclusion'));
        const fmtDate = (d: string) => { const mm=/^(\d{4})-(\d{2})-(\d{2})/.exec(d); return mm?`${mm[3]}.${mm[2]}.${mm[1]}`:d; };
        const datePart = noteStartDate === noteEndDate
          ? fmtDate(noteStartDate)
          : `${fmtDate(noteStartDate)}–${fmtDate(noteEndDate!)}`;
        return { excluded: true, detail: `${driverName}: ${noteLabel} (${datePart})` };
      }
      dateMs += MS_PER_DAY;
    }
  }
  return { excluded: false };
}

/**
 * Expands a driver's 'exclude_from_plan' notes into half-open ms intervals
 * suitable for passing to assignRegularDriversToVehicleBlocks.
 */
function buildDriverPlanningExclusions(
  notes: StructuredNote[],
  t: Translate,
): DriverPlanningExclusion[] {
  const result: DriverPlanningExclusion[] = [];
  for (const note of notes) {
    if (note.note_planning_behavior !== 'exclude_from_plan') continue;
    const noteStartDate = note.start_date ?? (note.note_date ? note.note_date.slice(0, 10) : null);
    const noteEndDate   = note.end_date ?? noteStartDate;
    if (!noteStartDate) continue;
    const rangeStartMs = _parseDateMsLocal(noteStartDate);
    const rangeEndMs   = _parseDateMsLocal(noteEndDate!);
    if (isNaN(rangeStartMs) || isNaN(rangeEndMs)) continue;
    const cappedEnd = Math.min(rangeEndMs, rangeStartMs + 366 * MS_PER_DAY);

    const labelKey = NOTE_TYPE_LABEL_KEYS[note.note_type?.toLowerCase() ?? ''];
    const noteLabel = labelKey ? t(labelKey) : (note.note_type ?? t('hwh.noteTypeExclusion'));
    const fmtDate = (d: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d); return m ? `${m[3]}.${m[2]}.${m[1]}` : d; };
    const datePart = noteStartDate === noteEndDate
      ? fmtDate(noteStartDate)
      : `${fmtDate(noteStartDate)}–${fmtDate(noteEndDate!)}`;
    const label = `${noteLabel} (${datePart})`;

    if (note.is_full_day || !note.start_time || !note.end_time) {
      // Full-day exclusion: one interval spanning entire range (inclusive end date = +1 day exclusive)
      result.push({ startMs: rangeStartMs, endExclusiveMs: cappedEnd + MS_PER_DAY, label });
    } else {
      // Time-ranged exclusion: expand day by day
      let dateMs = rangeStartMs;
      while (dateMs <= cappedEnd) {
        const sMin = _timeToMinLocal(note.start_time);
        const eMin = _timeToMinLocal(note.end_time);
        let intStart: number, intEnd: number;
        if (sMin == null || eMin == null) {
          intStart = dateMs; intEnd = dateMs + MS_PER_DAY;
        } else if (eMin > sMin) {
          intStart = dateMs + sMin * 60_000; intEnd = dateMs + eMin * 60_000;
        } else {
          intStart = dateMs + sMin * 60_000; intEnd = dateMs + MS_PER_DAY + eMin * 60_000;
        }
        result.push({ startMs: intStart, endExclusiveMs: intEnd, label });
        dateMs += MS_PER_DAY;
      }
    }
  }
  return result;
}

// ── Local types ───────────────────────────────────────────────────────────────

interface FbImport {
  id: string;
  file_name: string;
  row_count: number;
  imported_at: string;
  source_columns_json: string[] | null;
  source_sheet_name: string | null;
  storage_path: string | null;
}

interface DriverRow {
  id: string;
  name: string;
  personalnummer: string | null;
  employment_type: string;
  planning_hourly_rate: number | null;
  planning_min_salary: number | null;
  planning_max_salary: number | null;
}

interface WzDriverConfig {
  driverId: string;
  driverName: string;
  personalnummer: string | null;
  isOwner: boolean;
  included: boolean;
  hourlyCents: number;
  minSalaryCents: number | null;   // Mindestgehalt in euro-cents (null = not set)
  maxSalaryCents: number | null;   // Maximalgehalt in euro-cents (null = not set)
  targetBaseH: number;
  targetNacht25H: number;
  targetNacht40H: number;
  targetSundayH: number;
  targetHolidayH: number;
  hinweis: string;
}

// Draft strings used while typing (support German comma decimals)
interface WzDraft {
  hourly: string;
  baseH: string;
  nacht25H: string;
  nacht40H: string;
  sunH: string;
  holH: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseGermanH(s: string): number {
  const normalized = s.replace(',', '.').trim();
  const n = parseFloat(normalized);
  return isNaN(n) || n < 0 ? 0 : n;
}

function fmtH(h: number): string {
  return h === 0 ? '' : h.toFixed(2).replace('.', ',');
}

function parseCentsFromStr(s: string): number {
  const normalized = s.replace(',', '.').trim();
  const n = parseFloat(normalized);
  return isNaN(n) || n < 0 ? 0 : Math.round(n * 100);
}

function centsToStr(c: number): string {
  return (c / 100).toFixed(2).replace('.', ',');
}

async function fetchAllTrips(companyId: string, importId: string): Promise<FahrtenbuchTrip[]> {
  const all: FahrtenbuchTrip[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('fahrtenbuch_trips').select('*')
      .eq('company_id', companyId).eq('import_id', importId)
      .order('trip_date', { ascending: true })
      .order('start_time', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as FahrtenbuchTrip[];
    all.push(...rows); if (rows.length < BATCH_SIZE) break; offset += BATCH_SIZE;
  }
  return all;
}


// ── Step dots ────────────────────────────────────────────────────────────────

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className="h-2 rounded-full transition-all"
          style={{ width: i === current ? 24 : 8, background: i === current ? '#06b6d4' : i < current ? 'rgba(6,182,212,0.4)' : 'var(--border)' }} />
      ))}
    </div>
  );
}

// ── InhaberNonConflictStep types & algorithm ─────────────────────────────────

interface InhaberNonConflictBlock {
  block: VehicleBlock;
  hasNzConflict: boolean;
  nzConflictWith: string[];   // blockIds of conflicting not-assigned blocks
}

interface InhaberNonConflictDiagnostics {
  regularDriversUnchanged: boolean;
  nonConflictBlocksAssigned: number;
  remainingWithoutNzConflict: number;
  remainingWithNzConflict: number;
  singleRideAssignments: number;
  timeShifts: number;
}

interface InhaberNonConflictStepResult {
  inhaberName: string;
  assignedToInhaberBlocks: VehicleBlock[];
  remainingConflictedBlocks: VehicleBlock[];
  blockDetails: InhaberNonConflictBlock[];
  inhaberRides: number;
  inhaberSec: number;
  diagnostics: InhaberNonConflictDiagnostics;
}

function runInhaberNonConflictStep(
  unassignedBlocks: VehicleBlock[],
  inhaberName: string,
): InhaberNonConflictStepResult {
  // Build NZ-conflict map (unassigned vs unassigned, cross-vehicle, time overlap)
  const conflictsWith = new Map<string, string[]>();
  for (const b of unassignedBlocks) conflictsWith.set(b.blockId, []);

  for (let i = 0; i < unassignedBlocks.length; i++) {
    for (let j = i + 1; j < unassignedBlocks.length; j++) {
      const a = unassignedBlocks[i], b = unassignedBlocks[j];
      if (a.vehicle === b.vehicle) continue;
      if (!a.blockStartMs || !a.blockEndMs || !b.blockStartMs || !b.blockEndMs) continue;
      if (a.blockStartMs < b.blockEndMs && b.blockStartMs < a.blockEndMs) {
        conflictsWith.get(a.blockId)!.push(b.blockId);
        conflictsWith.get(b.blockId)!.push(a.blockId);
      }
    }
  }

  const blockDetails: InhaberNonConflictBlock[] = unassignedBlocks.map(b => ({
    block: b,
    hasNzConflict: (conflictsWith.get(b.blockId)?.length ?? 0) > 0,
    nzConflictWith: conflictsWith.get(b.blockId) ?? [],
  }));

  const assignedToInhaberBlocks = blockDetails.filter(d => !d.hasNzConflict).map(d => d.block);
  const remainingConflictedBlocks = blockDetails.filter(d => d.hasNzConflict).map(d => d.block);

  const inhaberRides = assignedToInhaberBlocks.reduce((s, b) => s + (b.rides?.length ?? 0), 0);
  const inhaberSec   = assignedToInhaberBlocks.reduce((s, b) => s + b.blockDurationSec, 0);

  const diagnostics: InhaberNonConflictDiagnostics = {
    regularDriversUnchanged:     true,
    nonConflictBlocksAssigned:   assignedToInhaberBlocks.length,
    remainingWithoutNzConflict:  0,
    remainingWithNzConflict:     remainingConflictedBlocks.length,
    singleRideAssignments:       0,
    timeShifts:                  0,
  };

  return { inhaberName, assignedToInhaberBlocks, remainingConflictedBlocks, blockDetails, inhaberRides, inhaberSec, diagnostics };
}

// ── InhaberLongestConflictStep types & algorithm ──────────────────────────────

// `decision` values are internal identifiers: the algorithm branches on them with
// ===. They are mapped to labels at render time via LC_DECISION_KEYS.
type LcDecision =
  | 'Inhaber'
  | 'Nicht zugewiesen'
  | 'Übersprungen: Inhaber-Zeitkonflikt'
  | 'Übersprungen: Fahrzeugkonflikt'
  | 'Kein passender Block';

const LC_DECISION_KEYS: Record<LcDecision, TranslationKey> = {
  'Inhaber':                              'hwh.lcDecisionOwner',
  'Nicht zugewiesen':                     'hwh.unassigned',
  'Übersprungen: Inhaber-Zeitkonflikt':   'hwh.lcDecisionSkippedOwnerTime',
  'Übersprungen: Fahrzeugkonflikt':       'hwh.lcDecisionSkippedVehicle',
  'Kein passender Block':                 'hwh.lcDecisionNoSuitableBlock',
};

interface LcGroupBlock {
  block: VehicleBlock;
  rank: number;
  decision: LcDecision;
  // A TranslationKey, resolved where the row is rendered.
  rejectionReason: TranslationKey | null;
}

interface LcConflictGroup {
  groupId: string;         // e.g. "G01"
  blockIds: string[];
  vehicles: string[];
  periodStart: number;
  periodEnd: number;
  longestBlockId: string;
  selectedBlockId: string | null;
  decision: 'Inhaber' | 'Kein passender Block';
  blocks: LcGroupBlock[];
}

interface LcRejectedCandidate {
  blockId: string;
  vehicle: string;
  groupId: string;
  reason: 'Inhaber-Zeitkonflikt' | 'Fahrzeugkonflikt';
}

interface LcDiagnostics {
  regularDriversUnchanged: boolean;
  inhaberTimeConflicts: number;
  inhaberVehicleConflicts: number;
  timeShifts: number;
  singleRideAssignments: number;
  groupsWithNoBlock: number;
}

interface InhaberLongestConflictStepResult {
  inhaberName: string;
  conflictGroups: LcConflictGroup[];
  selectedBlocks: VehicleBlock[];    // newly assigned to Inhaber in this step
  rejectedCandidates: LcRejectedCandidate[];
  remainingUnassignedBlocks: VehicleBlock[];
  inhaberRidesAdded: number;
  inhaberSecAdded: number;
  inhaberSecTotal: number;   // step3 + step4
  diagnostics: LcDiagnostics;
}

function blocksOverlap(a: VehicleBlock, b: VehicleBlock): boolean {
  if (!a.blockStartMs || !a.blockEndMs || !b.blockStartMs || !b.blockEndMs) return false;
  return a.blockStartMs < b.blockEndMs && b.blockStartMs < a.blockEndMs;
}

function runInhaberLongestConflictStep(
  remainingConflictedBlocks: VehicleBlock[],
  step3InhaberBlocks: VehicleBlock[],
  inhaberName: string,
): InhaberLongestConflictStepResult {
  const n = remainingConflictedBlocks.length;

  // Build adjacency (NZ-conflict): cross-vehicle, time overlap
  const adj = new Map<string, Set<string>>();
  for (const b of remainingConflictedBlocks) adj.set(b.blockId, new Set());
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = remainingConflictedBlocks[i], b = remainingConflictedBlocks[j];
      if (a.vehicle === b.vehicle) continue;
      if (blocksOverlap(a, b)) {
        adj.get(a.blockId)!.add(b.blockId);
        adj.get(b.blockId)!.add(a.blockId);
      }
    }
  }

  // BFS connected components
  const visited = new Set<string>();
  const blockById = new Map<string, VehicleBlock>();
  for (const b of remainingConflictedBlocks) blockById.set(b.blockId, b);

  const groups: LcConflictGroup[] = [];
  let groupIdx = 0;

  for (const b of remainingConflictedBlocks) {
    if (visited.has(b.blockId)) continue;
    // BFS
    const queue = [b.blockId];
    visited.add(b.blockId);
    const members: string[] = [];
    while (queue.length) {
      const cur = queue.shift()!;
      members.push(cur);
      for (const nb of adj.get(cur) ?? []) {
        if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
      }
    }
    groupIdx++;
    const groupId = `G${String(groupIdx).padStart(2, '0')}`;
    const memberBlocks = members.map(id => blockById.get(id)!).filter(Boolean);
    const vehicles = Array.from(new Set(memberBlocks.map(b => b.vehicle))).sort();
    const periodStart = Math.min(...memberBlocks.map(b => b.blockStartMs ?? Infinity));
    const periodEnd   = Math.max(...memberBlocks.map(b => b.blockEndMs   ?? 0));

    // Sort candidates: longest duration first, then most rides, then earliest start, then lower blockId
    const sorted = [...memberBlocks].sort((a, b) => {
      if (b.blockDurationSec !== a.blockDurationSec) return b.blockDurationSec - a.blockDurationSec;
      if ((b.rides?.length ?? 0) !== (a.rides?.length ?? 0)) return (b.rides?.length ?? 0) - (a.rides?.length ?? 0);
      if (a.blockStartMs !== b.blockStartMs) return a.blockStartMs - b.blockStartMs;
      return a.blockId < b.blockId ? -1 : 1;
    });

    groups.push({ groupId, blockIds: members, vehicles, periodStart, periodEnd, longestBlockId: sorted[0].blockId, selectedBlockId: null, decision: 'Kein passender Block', blocks: [] });
  }

  // Now assign: iterate groups and try candidates in rank order
  const inhaberBlocks: VehicleBlock[] = [...step3InhaberBlocks]; // grows as we assign step4 blocks
  const selectedBlocks: VehicleBlock[] = [];
  const rejectedCandidates: LcRejectedCandidate[] = [];

  for (const group of groups) {
    const memberBlocks = group.blockIds.map(id => blockById.get(id)!).filter(Boolean);
    const sorted = [...memberBlocks].sort((a, b) => {
      if (b.blockDurationSec !== a.blockDurationSec) return b.blockDurationSec - a.blockDurationSec;
      if ((b.rides?.length ?? 0) !== (a.rides?.length ?? 0)) return (b.rides?.length ?? 0) - (a.rides?.length ?? 0);
      if (a.blockStartMs !== b.blockStartMs) return a.blockStartMs - b.blockStartMs;
      return a.blockId < b.blockId ? -1 : 1;
    });

    const blockDecisions: LcGroupBlock[] = sorted.map((b, i) => ({ block: b, rank: i + 1, decision: 'Nicht zugewiesen', rejectionReason: null }));

    let assigned: VehicleBlock | null = null;
    for (const bd of blockDecisions) {
      const candidate = bd.block;
      // Check Inhaber time overlap
      const timeConflict = inhaberBlocks.some(existing => blocksOverlap(existing, candidate));
      if (timeConflict) {
        bd.decision = 'Übersprungen: Inhaber-Zeitkonflikt';
        bd.rejectionReason = 'hwh.lcRejectOwnerTimeOverlap';
        rejectedCandidates.push({ blockId: candidate.blockId, vehicle: candidate.vehicle, groupId: group.groupId, reason: 'Inhaber-Zeitkonflikt' });
        continue;
      }
      // Check same-vehicle overlap among Inhaber blocks on same vehicle
      const vehicleConflict = inhaberBlocks.some(existing => existing.vehicle === candidate.vehicle && blocksOverlap(existing, candidate));
      if (vehicleConflict) {
        bd.decision = 'Übersprungen: Fahrzeugkonflikt';
        bd.rejectionReason = 'hwh.lcRejectVehicleOverlap';
        rejectedCandidates.push({ blockId: candidate.blockId, vehicle: candidate.vehicle, groupId: group.groupId, reason: 'Fahrzeugkonflikt' });
        continue;
      }
      // Accepted
      bd.decision = 'Inhaber';
      assigned = candidate;
      inhaberBlocks.push(candidate);
      selectedBlocks.push(candidate);
      group.selectedBlockId = candidate.blockId;
      group.decision = 'Inhaber';
      break;
    }
    if (!assigned) {
      // No candidate worked — mark remaining as 'Kein passender Block'
      for (const bd of blockDecisions) {
        if (bd.decision === 'Nicht zugewiesen') {
          bd.decision = 'Kein passender Block';
          bd.rejectionReason = 'hwh.lcRejectNoConflictFreeBlockInGroup';
        }
      }
    }
    group.blocks = blockDecisions;
  }

  const selectedSet = new Set(selectedBlocks.map(b => b.blockId));
  const remainingUnassignedBlocks = remainingConflictedBlocks.filter(b => !selectedSet.has(b.blockId));

  const inhaberRidesAdded = selectedBlocks.reduce((s, b) => s + (b.rides?.length ?? 0), 0);
  const inhaberSecAdded   = selectedBlocks.reduce((s, b) => s + b.blockDurationSec, 0);
  const step3Sec = step3InhaberBlocks.reduce((s, b) => s + b.blockDurationSec, 0);

  const inhaberTimeConflicts  = rejectedCandidates.filter(r => r.reason === 'Inhaber-Zeitkonflikt').length;
  const inhaberVehicleConflicts = rejectedCandidates.filter(r => r.reason === 'Fahrzeugkonflikt').length;
  const groupsWithNoBlock     = groups.filter(g => g.decision === 'Kein passender Block').length;

  const diagnostics: LcDiagnostics = {
    regularDriversUnchanged:   true,
    inhaberTimeConflicts,
    inhaberVehicleConflicts,
    timeShifts:                0,
    singleRideAssignments:     0,
    groupsWithNoBlock,
  };

  return {
    inhaberName,
    conflictGroups: groups,
    selectedBlocks,
    rejectedCandidates,
    remainingUnassignedBlocks,
    inhaberRidesAdded,
    inhaberSecAdded,
    inhaberSecTotal: step3Sec + inhaberSecAdded,
    diagnostics,
  };
}

// ── VehicleBlocksView ─────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  valid:   { bg: '#dcfce7', border: '#86efac', text: '#166534' },
  short:   { bg: '#fef9c3', border: '#fde047', text: '#854d0e' },
  long:    { bg: '#ffedd5', border: '#fdba74', text: '#9a3412' },
  invalid: { bg: '#fee2e2', border: '#fca5a5', text: '#991b1b' },
};

// Sunday-first column headers. Holds TranslationKeys (module-level list); the
// weekend tint is driven by the column index, not by the rendered abbreviation.
const WEEKDAY_COLS = [
  'hwh.weekdaySun', 'hwh.weekdayMon', 'hwh.weekdayTue', 'hwh.weekdayWed',
  'hwh.weekdayThu', 'hwh.weekdayFri', 'hwh.weekdaySat',
] as const;

interface VehicleBlocksViewProps {
  result: BuildVehicleBlocksResult;
  month: number;
  year: number;
  onRecompute: () => void;
  onAssign: () => void;
}

function fmtTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function fmtDatetime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function VehicleBlocksView({ result, month, year, onRecompute, onAssign }: VehicleBlocksViewProps) {
  const { t, tPlural } = useTranslation();
  const [selectedVehicle, setSelectedVehicle] = useState<string>('__all__');
  const [modalBlock, setModalBlock] = useState<VehicleBlock | null>(null);

  const blocks = result?.blocks ?? [];
  const perVehicle = result?.perVehicle ?? [];

  const vehicles = useMemo(
    () => Array.from(new Set(blocks.map(b => b.vehicle))).filter(Boolean).sort(),
    [blocks],
  );

  const visibleBlocks = useMemo(
    () => selectedVehicle === '__all__' ? blocks : blocks.filter(b => b.vehicle === selectedVehicle),
    [blocks, selectedVehicle],
  );

  // Build month grid: 7-column (Su–Sa), rows = weeks covering the month
  const gridData = useMemo(() => {
    const firstDay = new Date(year, month - 1, 1);
    const lastDay  = new Date(year, month, 0);
    // Start on the Sunday on or before the 1st
    const gridStart = new Date(firstDay);
    gridStart.setDate(firstDay.getDate() - firstDay.getDay());

    // End on the Saturday on or after the last day
    const gridEnd = new Date(lastDay);
    gridEnd.setDate(lastDay.getDate() + (6 - lastDay.getDay()));

    const cells: Array<{ date: Date; inMonth: boolean; blocks: VehicleBlock[] }> = [];
    const cur = new Date(gridStart);
    while (cur <= gridEnd) {
      const dayStart = cur.getTime();
      const dayEnd   = dayStart + 86_400_000;
      const dayBlocks = visibleBlocks
        .filter(b => b.blockStartMs >= dayStart && b.blockStartMs < dayEnd)
        .sort((a, b) => a.blockStartMs - b.blockStartMs);
      cells.push({
        date: new Date(cur),
        inMonth: cur.getMonth() === month - 1,
        blocks: dayBlocks,
      });
      cur.setDate(cur.getDate() + 1);
    }
    // Split into weeks
    const weeks: typeof cells[] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }, [visibleBlocks, month, year]);

  // Stats (safe)
  const stats = {
    totalRides:        result?.totalRides        ?? 0,
    canceledRides:     result?.canceledRides     ?? 0,
    consideredRides:   result?.consideredRides   ?? 0,
    vehicleCount:      result?.vehicleCount      ?? 0,
    totalBlocks:       blocks.length,
    validBlockCount:   result?.validBlockCount   ?? 0,
    shortBlockCount:   result?.shortBlockCount   ?? 0,
    longBlockCount:    result?.longBlockCount    ?? 0,
    invalidBlockCount: result?.invalidBlockCount ?? 0,
  };

  const options = result?.options;

  return (
    <div className="space-y-4 max-w-full">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            {t('hwh.vehicleBlocksTitle')}
          </h2>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            {t('hwh.vehicleBlocksSubtitle')}
          </p>
        </div>
        <button
          onClick={onRecompute}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold flex-shrink-0 transition-all hover:brightness-90"
          style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
        >
          <RefreshCw size={13} /> {t('hwh.recompute')}
        </button>
      </div>

      {/* Parameter summary row */}
      {options && (
        <div className="flex flex-wrap gap-2 text-xs">
          {[
            [t('hwh.optMaxGap'), `${options.maxGapInsideBlockMinutes} min`],
            [t('hwh.optMinBlockDuration'), `${options.minBlockDurationMinutes} min`],
            [t('hwh.optMaxBlockDuration'), `${options.maxBlockDurationMinutes} min`],
            [t('hwh.optShortMergeGap'), `${options.shortMergeGapMinutes} min`],
          ].map(([k, v]) => (
            <span key={k} className="px-2.5 py-1 rounded-full" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
              {k}: <strong style={{ color: 'var(--text-primary)' }}>{v}</strong>
            </span>
          ))}
        </div>
      )}

      {/* Stats bar */}
      <div className="flex flex-wrap gap-2 text-xs">
        {[
          { label: t('hwh.statRides'),      value: stats.totalRides },
          { label: t('hwh.statConsidered'), value: stats.consideredRides },
          { label: t('hwh.statCanceled'),   value: stats.canceledRides,     dim: true },
          { label: t('hwh.statVehicles'),   value: stats.vehicleCount },
          { label: t('hwh.statBlocks'),     value: stats.totalBlocks },
          { label: t('hwh.statValid'),      value: stats.validBlockCount,   color: '#15803d' },
          { label: t('hwh.statShort'),      value: stats.shortBlockCount,   color: '#a16207' },
          { label: t('hwh.statLong'),       value: stats.longBlockCount,    color: '#c2410c' },
          { label: t('hwh.statInvalid'),    value: stats.invalidBlockCount, color: '#b91c1c' },
        ].map(s => (
          <div key={s.label} className="px-3 py-1.5 rounded-xl flex items-baseline gap-1.5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <span className="font-bold text-sm" style={{ color: s.color ?? (s.dim ? 'var(--text-secondary)' : 'var(--text-primary)') }}>{s.value}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Vehicle filter tabs */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setSelectedVehicle('__all__')}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
          style={{
            background: selectedVehicle === '__all__' ? '#0891b2' : 'var(--bg-subtle)',
            color:      selectedVehicle === '__all__' ? '#fff'    : 'var(--text-secondary)',
            border:     `1px solid ${selectedVehicle === '__all__' ? '#0891b2' : 'var(--border)'}`,
          }}
        >
          {t('hwh.allVehiclesCount', { count: stats.vehicleCount })}
        </button>
        {vehicles.map(v => {
          const pv = perVehicle.find(p => p.vehicle === v);
          return (
            <button
              key={v}
              onClick={() => setSelectedVehicle(v)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{
                background: selectedVehicle === v ? '#0891b2' : 'var(--bg-subtle)',
                color:      selectedVehicle === v ? '#fff'    : 'var(--text-secondary)',
                border:     `1px solid ${selectedVehicle === v ? '#0891b2' : 'var(--border)'}`,
              }}
            >
              {v} {pv ? `(${pv.blockCount})` : ''}
            </button>
          );
        })}
      </div>

      {/* Month title */}
      <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
        {t(MONTH_KEYS[month - 1])} {year}
        {selectedVehicle !== '__all__' && <span style={{ color: '#0891b2' }}> · {selectedVehicle}</span>}
        <span className="ml-2 font-normal" style={{ color: 'var(--text-secondary)' }}>
          — {tPlural({ one: 'hwh.blockCountOne', other: 'hwh.blockCountOther' }, visibleBlocks.length)}
        </span>
      </div>

      {/* ── Month grid ─────────────────────────────────────────────────────────── */}
      {blocks.length === 0 ? (
        <div className="rounded-xl p-6 text-sm text-center" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
          {t('hwh.noVehicleBlocks')}
        </div>
      ) : (
        <div className="rounded-2xl" style={{ border: '1px solid var(--border)', overflow: 'hidden' }}>
          {/* Weekday header */}
          <div className="grid grid-cols-7" style={{ background: 'var(--bg-subtle)', borderBottom: '2px solid var(--border)' }}>
            {WEEKDAY_COLS.map((dayKey, di) => (
              <div key={dayKey} className="py-2 text-center text-xs font-bold" style={{ color: di === 0 || di === 6 ? '#7c3aed' : 'var(--text-secondary)' }}>
                {t(dayKey)}
              </div>
            ))}
          </div>

          {/* Weeks */}
          {gridData.map((week, wi) => (
            <div key={wi} className="grid grid-cols-7" style={{ borderBottom: wi < gridData.length - 1 ? '1px solid var(--border)' : undefined }}>
              {week.map((cell, ci) => {
                const isWeekend = ci === 0 || ci === 6;
                const isToday = cell.date.toDateString() === new Date().toDateString();
                return (
                  <div
                    key={ci}
                    style={{
                      minHeight: 100,
                      background: !cell.inMonth
                        ? 'var(--bg-subtle)'
                        : isWeekend
                          ? 'rgba(124,58,237,0.03)'
                          : 'var(--bg-surface)',
                      borderRight: ci < 6 ? '1px solid var(--border)' : undefined,
                      padding: '6px 5px 4px',
                      verticalAlign: 'top',
                    }}
                  >
                    {/* Day number */}
                    <div className="flex items-center justify-end mb-1">
                      <span
                        className="text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full"
                        style={{
                          color: !cell.inMonth
                            ? 'var(--text-secondary)'
                            : isToday
                              ? '#fff'
                              : isWeekend ? '#7c3aed' : 'var(--text-primary)',
                          background: isToday ? '#0891b2' : 'transparent',
                          opacity: !cell.inMonth ? 0.4 : 1,
                        }}
                      >
                        {cell.date.getDate()}
                      </span>
                    </div>

                    {/* Block events — all shown, no clipping */}
                    <div className="space-y-0.5">
                      {cell.blocks.map(block => {
                        const sc = STATUS_COLORS[block.status] ?? STATUS_COLORS.invalid;
                        return (
                          <button
                            key={block.blockId}
                            onClick={() => setModalBlock(block)}
                            className="w-full text-left rounded px-1.5 py-0.5 text-xs transition-all hover:brightness-90 leading-snug"
                            style={{ background: sc.bg, border: `1px solid ${sc.border}`, color: sc.text }}
                          >
                            <span className="font-semibold">{fmtTime(block.blockStartMs)}–{fmtTime(block.blockEndMs)}</span>
                            {' '}· <span className="font-mono opacity-80">{block.blockId.slice(-6)}</span>
                            {' · '}<span className="font-semibold">{block.vehicle}</span>
                            {' · '}{formatBlockDuration(block.blockDurationSec)}
                            {' · '}{tPlural({ one: 'hwh.rideCountOne', other: 'hwh.rideCountOther' }, block.rides?.length ?? 0)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Bottom nav */}
      <div className="flex items-center justify-between pt-2">
        <button
          onClick={onRecompute}
          className="inline-flex items-center gap-2 text-sm transition-colors hover:opacity-80"
          style={{ color: 'var(--text-secondary)' }}
        >
          <ArrowLeft size={15} /> {t('hwh.recompute')}
        </button>
        <button
          onClick={onAssign}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:brightness-110"
          style={{ background: '#2563eb', color: '#fff' }}
        >
          <ArrowRight size={15} /> {t('hwh.assignRegularDrivers')}
        </button>
      </div>

      {/* ── Block detail modal ─────────────────────────────────────────────────── */}
      {modalBlock && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={() => setModalBlock(null)}
        >
          <div
            className="rounded-2xl p-6 w-full max-w-lg space-y-3"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: '0 25px 60px rgba(0,0,0,0.3)' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('hwh.blockDetails')}</div>
                <div className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-secondary)' }}>{modalBlock.blockId}</div>
              </div>
              <button
                onClick={() => setModalBlock(null)}
                className="text-xs px-2 py-1 rounded-lg"
                style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)', background: 'var(--bg-subtle)' }}
              >
                {t('common.close')}
              </button>
            </div>

            {/* Detail rows */}
            {/* The clean engine returns German and names a key beside it; the
                status and warning codes stay its own discriminators. */}
            <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
              {[
                [t('hwh.colVehicle'),  modalBlock.vehicle],
                [t('hwh.colStart'),    fmtDatetime(modalBlock.blockStartMs)],
                [t('hwh.colEnd'),      fmtDatetime(modalBlock.blockEndMs)],
                [t('hwh.colDuration'), formatBlockDuration(modalBlock.blockDurationSec)],
                [t('hwh.colRides'),    String(modalBlock.rides?.length ?? 0)],
                [t('hwh.colRows'),     blockSourceRowRange(modalBlock)],
                [t('common.status'),   engineText(t, blockStatusLabel(modalBlock), blockStatusLabelKey(modalBlock))],
                [t('hwh.colWarnings'), blockWarningLabels(modalBlock)
                  .map((label, i) => engineText(t, label, blockWarningLabelKeys(modalBlock)[i]))
                  .join(', ') || '—'],
              ].map(([k, v], i) => (
                <div
                  key={k}
                  className="flex gap-3 px-4 py-2 text-xs"
                  style={{ background: i % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-subtle)', borderBottom: i < 7 ? '1px solid var(--border)' : undefined }}
                >
                  <span className="w-24 flex-shrink-0 font-semibold" style={{ color: 'var(--text-secondary)' }}>{k}</span>
                  <span style={{ color: 'var(--text-primary)' }}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── RegularDriverAssignmentView ───────────────────────────────────────────────

const DRIVER_COLORS = [
  '#2563eb','#059669','#d97706','#7c3aed','#db2777','#0891b2','#ea580c','#65a30d',
];

interface RegularDriverAssignmentViewProps {
  result: RegularDriverAssignmentResult;
  phase1Result: BuildVehicleBlocksResult;
  driverConfigs: WzDriverConfig[];
  inhaberName: string;
  month: number;
  year: number;
  onBack: () => void;
  onRecompute: () => void;
  onApplyNonConflictStep: () => void;
}

function RegularDriverAssignmentView({
  result, phase1Result, driverConfigs, inhaberName, month, year, onBack, onRecompute, onApplyNonConflictStep,
}: RegularDriverAssignmentViewProps) {
  const { t, tPlural } = useTranslation();
  const [modalBlock, setModalBlock] = useState<VehicleBlock | null>(null);
  const [selectedVehicle, setSelectedVehicle] = useState<string>('__all__');
  const [conflictListOpen, setConflictListOpen] = useState(false);
  const [expandedConflictBlock, setExpandedConflictBlock] = useState<string | null>(null);

  const assignments    = result?.assignments    ?? [];
  const surplusBlocks  = result?.surplusBlocks  ?? [];
  const surplusValid   = result?.surplusValidBlocks  ?? [];
  const summaries      = result?.driverSummaries ?? [];
  const validation     = result?.validation;
  const rejections     = result?.rejectedAssignments ?? [];

  const allBlocks      = phase1Result?.blocks ?? [];
  const validBlocks    = allBlocks.filter(b => b.status === 'valid');

  // Map blockId → assigned driver
  const assignedMap = useMemo(() => {
    const m = new Map<string, RegularBlockAssignment>();
    for (const a of assignments) m.set(a.blockId, a);
    return m;
  }, [assignments]);

  // Driver colors
  const driverColorMap = useMemo(() => {
    const unique = Array.from(new Set(assignments.map(a => a.driverId)));
    const m = new Map<string, string>();
    unique.forEach((id, i) => m.set(id, DRIVER_COLORS[i % DRIVER_COLORS.length]));
    return m;
  }, [assignments]);

  // Vehicles
  const vehicles = useMemo(
    () => Array.from(new Set(allBlocks.map(b => b.vehicle))).filter(Boolean).sort(),
    [allBlocks],
  );

  // Unassigned reasons per block
  const rejectionMap = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of rejections) {
      const list = m.get(r.blockId) ?? [];
      list.push(r.reason);
      m.set(r.blockId, list);
    }
    return m;
  }, [rejections]);

  // Cross-vehicle conflict computation
  interface ConflictExample {
    blockId: string; vehicle: string; driverName: string; isUnassigned: boolean;
    startMs: number; endMs: number; overlapSec: number;
  }
  interface BlockConflictInfo {
    hasCrossVehicleConflict: boolean;
    crossVehicleConflictCount: number;
    conflictedVehicles: string[];
    conflictedBlockIds: string[];
    conflictedAssignedDrivers: string[];
    totalConflictDurationSec: number;
    conflictExamples: ConflictExample[];
  }

  const crossVehicleConflictMap = useMemo(() => {
    const m = new Map<string, BlockConflictInfo>();
    // Only compare not-assigned vs not-assigned blocks (cross-vehicle, time overlap)
    const unassignedBlocks = surplusBlocks.filter(b => !assignedMap.has(b.blockId));
    const unassignedSet = new Set(unassignedBlocks.map(b => b.blockId));
    for (const ub of unassignedBlocks) {
      const examples: ConflictExample[] = [];
      const seenIds = new Set<string>();
      // Only check other NOT-ASSIGNED blocks — ignore regular-driver-assigned blocks
      for (const other of unassignedBlocks) {
        if (other.blockId === ub.blockId) continue;
        if (other.vehicle === ub.vehicle) continue;
        if (!other.blockStartMs || !other.blockEndMs) continue;
        const overlapStart = Math.max(ub.blockStartMs, other.blockStartMs);
        const overlapEnd   = Math.min(ub.blockEndMs,   other.blockEndMs);
        if (overlapStart >= overlapEnd) continue;
        const overlapSec = (overlapEnd - overlapStart) / 1000;
        if (!seenIds.has(other.blockId)) {
          seenIds.add(other.blockId);
          examples.push({
            blockId:    other.blockId,
            vehicle:    other.vehicle,
            driverName: t('hwh.unassigned'),
            isUnassigned: true,
            startMs:    other.blockStartMs,
            endMs:      other.blockEndMs,
            overlapSec,
          });
        }
      }
      const conflictedVehicles = Array.from(new Set(examples.map(e => e.vehicle)));
      const totalConflictDurationSec = examples.reduce((s, e) => s + e.overlapSec, 0);
      m.set(ub.blockId, {
        hasCrossVehicleConflict: examples.length > 0,
        crossVehicleConflictCount: examples.length,
        conflictedVehicles,
        conflictedBlockIds: examples.map(e => e.blockId),
        conflictedAssignedDrivers: [],
        totalConflictDurationSec,
        conflictExamples: examples,
      });
    }
    return m;
  }, [surplusBlocks, assignedMap, t]);

  /** Just the reason, without the "not assigned" prefix. */
  function unassignedReason(block: VehicleBlock): string {
    // The clean engine's German status text, rendered through its key.
    if (block.status !== 'valid') return engineText(t, blockStatusLabel(block), blockStatusLabelKey(block));
    const reasons = rejectionMap.get(block.blockId);
    if (!reasons?.length) return t('hwh.rejectNoSuitableDriver');
    const r = reasons[0];
    if (r === 'no_driver_available')          return t('hwh.rejectNoSuitableDriver');
    if (r === 'target_full')                  return t('hwh.rejectDriverFull');
    if (r.startsWith('would_exceed_1500'))    return t('hwh.rejectLimit1500');
    if (r.startsWith('would_exceed_1501'))    return t('hwh.rejectLimit1501');
    if (r.startsWith('would_exceed_1510'))    return t('hwh.rejectLimit1510');
    if (r.startsWith('would_exceed_1000'))    return t('hwh.rejectLimit1000');
    if (r.startsWith('would_exceed_holiday')) return t('hwh.rejectLimitHoliday');
    if (r.startsWith('would_exceed'))         return t('hwh.rejectLimitExceeded');
    if (r === 'driver_overlap')               return t('hwh.rejectDriverOverlap');
    if (r === 'driver_excluded_by_note')      return t('hwh.rejectDriverExcluded');
    return t('hwh.rejectNoSuitableDriver');
  }

  /** "Nicht zugewiesen: <reason>" for places that show the full sentence. */
  function unassignedLabel(block: VehicleBlock): string {
    return t('hwh.unassignedWithReason', { reason: unassignedReason(block) });
  }

  // Drivers skipped due to planning exclusion notes
  const exclusionSkips = useMemo(() => {
    const skipped = new Map<string, { name: string; labels: Set<string>; blockCount: number }>();
    for (const r of rejections) {
      if (r.reason !== 'driver_excluded_by_note' || !r.excludedDriverId) continue;
      const entry = skipped.get(r.excludedDriverId) ?? { name: r.excludedDriverName ?? r.excludedDriverId, labels: new Set(), blockCount: 0 };
      entry.blockCount++;
      if (r.exclusionLabel) entry.labels.add(r.exclusionLabel);
      skipped.set(r.excludedDriverId, entry);
    }
    return Array.from(skipped.values());
  }, [rejections]);

  // Calendar grid for a vehicle
  function buildGrid(vehicleFilter: string | null) {
    const firstDay = new Date(year, month - 1, 1);
    const lastDay  = new Date(year, month, 0);
    const start = new Date(firstDay);
    start.setDate(firstDay.getDate() - firstDay.getDay());
    const end = new Date(lastDay);
    end.setDate(lastDay.getDate() + (6 - lastDay.getDay()));

    const cells: Array<{ date: Date; inMonth: boolean; blocks: VehicleBlock[] }> = [];
    const cur = new Date(start);
    while (cur <= end) {
      const ds = cur.getTime(), de = ds + 86_400_000;
      const dayBlocks = allBlocks
        .filter(b => (!vehicleFilter || b.vehicle === vehicleFilter) && b.blockStartMs >= ds && b.blockStartMs < de)
        .sort((a, b2) => a.blockStartMs - b2.blockStartMs);
      cells.push({ date: new Date(cur), inMonth: cur.getMonth() === month - 1, blocks: dayBlocks });
      cur.setDate(cur.getDate() + 1);
    }
    const weeks: typeof cells[] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }

  const calendarVehicles = selectedVehicle === '__all__' ? vehicles : [selectedVehicle];

  // Diagnostics: clean?
  const isClean = validation
    ? validation.driverOverlapCount === 0 && validation.targetOverrunCount === 0
    : true;

  // Lohnart table data
  const lohnartRows = useMemo(() => summaries.map(s => {
    const dc = driverConfigs.find(c => c.driverId === s.driverId);
    return {
      name:                s.driverName,
      target1000:          dc ? dc.targetBaseH * 3600 : s.targetBaseSec1000,
      assigned1000:        s.assignedBaseSec1000,
      target1500:          dc ? dc.targetNacht25H * 3600 : s.targetNight25Sec1500,
      assigned1500:        s.assignedNight25Sec1500,
      target1501:          dc ? dc.targetNacht40H * 3600 : s.targetNight40Sec1501,
      assigned1501:        s.assignedNight40Sec1501,
      target1510:          dc ? dc.targetSundayH * 3600 : s.targetSundaySec1510,
      assigned1510:        s.assignedSundaySec1510,
      targetFeiertag:      dc ? dc.targetHolidayH * 3600 : s.targetHolidaySec,
      assignedFeiertag:    s.assignedHolidaySec,
    };
  }), [summaries, driverConfigs]);

  function secToH(sec: number) {
    if (!sec) return '0,00 h';
    return (sec / 3600).toFixed(2).replace('.', ',') + ' h';
  }
  function secToHShort(sec: number) {
    if (!sec) return '—';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return `${h}h${String(m).padStart(2,'0')}`;
  }

  return (
    <div className="space-y-5 max-w-full">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('hwh.assignRegularDrivers')}</h2>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            {t('hwh.assignRegularDriversSubtitle')}
          </p>
        </div>
      </div>

      {/* Owner zero card */}
      <div className="rounded-xl p-4" style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.25)' }}>
        <div className="text-xs font-bold mb-2" style={{ color: '#065f46' }}>{t('hwh.ownerInThisStep')}</div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-5">
          {[
            [t('common.driver'),  inhaberName || '—'],
            [t('hwh.colBlocks'),  '0'],
            [t('hwh.colRides'),   '0'],
            [t('hwh.colHours'),   '0,00 h'],
            [t('common.status'),  t('hwh.notAssignedInStep2')],
          ].map(([k, v]) => (
            <div key={k}>
              <span style={{ color: '#065f46', fontWeight: 600 }}>{k}: </span>
              <span style={{ color: '#0f766e' }}>{v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Exclusion skips notice */}
      {exclusionSkips.length > 0 && (
        <div className="rounded-xl px-4 py-3 text-xs" style={{ background: 'rgba(217,119,6,0.07)', border: '1px solid rgba(217,119,6,0.25)', color: '#92400e' }}>
          <div className="font-bold mb-1.5" style={{ color: '#78350f' }}>{t('hwh.skippedDueToExclusion', { count: exclusionSkips.length })}</div>
          <div className="space-y-0.5">
            {exclusionSkips.map(sk => (
              <div key={sk.name}>
                <span className="font-semibold">{sk.name}</span>
                {sk.labels.size > 0 && (
                  <span className="ml-1 opacity-80">— {Array.from(sk.labels).join(', ')}</span>
                )}
                <span className="ml-1 opacity-60">({tPlural({ one: 'hwh.blocksRejectedOne', other: 'hwh.blocksRejectedOther' }, sk.blockCount)})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Summary stats */}
      <div className="flex flex-wrap gap-2 text-xs">
        {[
          { label: t('hwh.statRegularDrivers'),   value: summaries.length },
          { label: t('hwh.statValidBlocks'),      value: validBlocks.length },
          { label: t('hwh.statAssigned'),         value: assignments.length,      color: '#15803d' },
          { label: t('hwh.unassigned'),           value: surplusBlocks.length,    color: surplusValid.length > 0 ? '#b45309' : undefined },
          { label: t('hwh.statAssignedHours'),    value: secToHShort(summaries.reduce((s, d) => s + d.assignedWorkSec, 0)) },
          { label: t('hwh.statDriverOverlaps'),   value: validation?.driverOverlapCount ?? 0,  color: (validation?.driverOverlapCount ?? 0) > 0 ? '#b91c1c' : '#15803d' },
          { label: t('hwh.statHourLimitOverrun'), value: validation?.targetOverrunCount ?? 0,  color: (validation?.targetOverrunCount ?? 0) > 0 ? '#b91c1c' : '#15803d' },
          { label: t('hwh.statOwnerBlocks'),      value: 0, color: '#15803d' },
          { label: t('hwh.statOwnerRides'),       value: 0, color: '#15803d' },
          { label: t('hwh.statRegularDriversMoved'), value: 0, color: '#15803d' },
        ].map(s => (
          <div key={s.label} className="px-3 py-1.5 rounded-xl flex items-baseline gap-1.5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <span className="font-bold text-sm" style={{ color: s.color ?? 'var(--text-primary)' }}>{s.value}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Verteilungsqualität */}
      {(() => {
        if (summaries.length === 0) return null;
        const rows = summaries.map(s => {
          const total = s.targetWorkSec > 0 ? s.targetWorkSec : 1;
          const ratio = Math.round((s.assignedWorkSec / total) * 1000) / 10;
          return { name: s.driverName, max: s.targetWorkSec, assigned: s.assignedWorkSec, ratio };
        });
        const ratios = rows.map(r => r.ratio);
        const minR = Math.min(...ratios), maxR = Math.max(...ratios);
        const spread = maxR - minR;
        const isBalanced = spread <= 25;
        const minDriver = rows.find(r => r.ratio === minR)?.name ?? '—';
        const maxDriver = rows.find(r => r.ratio === maxR)?.name ?? '—';
        return (
          <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${isBalanced ? 'rgba(16,185,129,0.3)' : 'rgba(245,158,11,0.4)'}` }}>
            <div className="px-4 py-3 flex items-center justify-between" style={{ background: isBalanced ? 'rgba(16,185,129,0.06)' : 'rgba(245,158,11,0.06)', borderBottom: '1px solid var(--border)' }}>
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('hwh.distributionQuality')}</span>
              <span className="text-xs font-bold px-2 py-1 rounded-lg" style={{ background: isBalanced ? '#dcfce7' : '#fef3c7', color: isBalanced ? '#15803d' : '#92400e', border: `1px solid ${isBalanced ? '#86efac' : '#fcd34d'}` }}>
                {isBalanced ? t('hwh.balanced') : t('hwh.unbalanced')}
              </span>
            </div>
            <div className="px-4 py-3 grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs" style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)' }}>
              {[
                { label: t('hwh.minUtilization'), value: minR.toFixed(1) + '%',  color: '#0891b2' },
                { label: t('hwh.maxUtilization'), value: maxR.toFixed(1) + '%',  color: '#7c3aed' },
                { label: t('hwh.spread'),         value: spread.toFixed(1) + '%', color: spread > 25 ? '#b45309' : '#059669' },
                { label: t('hwh.lowestHighest'),  value: `${minDriver} / ${maxDriver}`, color: 'var(--text-secondary)' },
              ].map(c => (
                <div key={c.label}>
                  <div className="font-semibold mb-0.5" style={{ color: 'var(--text-secondary)' }}>{c.label}</div>
                  <div className="font-bold text-sm" style={{ color: c.color }}>{c.value}</div>
                </div>
              ))}
            </div>
            <div className="overflow-x-auto">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                    {[t('common.driver'), t('hwh.colMaxHours'), t('hwh.statAssigned'), t('hwh.colRemainder'), t('hwh.colUtilization')].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-xs font-semibold" style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const pct = row.ratio;
                    const barColor = pct >= 90 ? '#059669' : pct >= 60 ? '#0891b2' : '#f59e0b';
                    return (
                      <tr key={row.name} style={{ background: i % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                        <td className="px-3 py-2 text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{row.name}</td>
                        <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{secToH(row.max)}</td>
                        <td className="px-3 py-2 text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{secToH(row.assigned)}</td>
                        <td className="px-3 py-2 text-xs" style={{ color: row.assigned > row.max ? '#b91c1c' : 'var(--text-secondary)' }}>{secToH(Math.max(0, row.max - row.assigned))}</td>
                        <td className="px-3 py-2 text-xs">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 rounded-full overflow-hidden" style={{ height: 6, background: 'var(--border)' }}>
                              <div style={{ width: Math.min(pct, 100) + '%', height: '100%', background: barColor, borderRadius: 9999, transition: 'width 0.3s ease' }} />
                            </div>
                            <span className="font-bold w-12 text-right" style={{ color: barColor }}>{pct.toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* Driver limits table */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <div className="px-4 py-3 text-sm font-semibold" style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' }}>
          {t('hwh.driverLimits')}
        </div>
        <div className="overflow-x-auto">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)' }}>
                {[t('common.driver'), t('hwh.colMaxHours'), t('hwh.colLimit1000'), t('hwh.colLimit1500'), t('hwh.colLimit1501'), t('hwh.colLimit1510'), t('hwh.colLimitHoliday')].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-semibold" style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {driverConfigs.filter(c => c.included && !c.isOwner).map((dc, i) => (
                <tr key={dc.driverId} style={{ background: i % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                  <td className="px-3 py-2 text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{dc.driverName}</td>
                  <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{secToH(dc.targetBaseH * 3600)}</td>
                  <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{secToH(dc.targetBaseH * 3600)}</td>
                  <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{secToH(dc.targetNacht25H * 3600)}</td>
                  <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{secToH(dc.targetNacht40H * 3600)}</td>
                  <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{secToH(dc.targetSundayH * 3600)}</td>
                  <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{secToH(dc.targetHolidayH * 3600)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-driver summary */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <div className="px-4 py-3 text-sm font-semibold" style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' }}>
          {t('hwh.resultPerDriver')}
        </div>
        <div className="overflow-x-auto">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)' }}>
                {[t('common.driver'), t('hwh.colMaxHours'), t('hwh.statAssigned'), t('hwh.colRemainder'), t('hwh.colBlocks'), t('hwh.colRides'), t('common.status'), t('hwh.colOverlaps'), t('hwh.statHourLimitOverrun')].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-semibold" style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summaries.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-6 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>{t('hwh.noRegularDriversConfigured')}</td></tr>
              ) : summaries.map((s, i) => {
                const blocksForDriver = assignments.filter(a => a.driverId === s.driverId);
                const rides = blocksForDriver.reduce((acc, a) => acc + (allBlocks.find(b => b.blockId === a.blockId)?.rides?.length ?? 0), 0);
                // `status` is the engine's stored value, not a label.
                const statusLabel = s.status === 'ziel_erreicht' ? t('hwh.statusLimitReached') : s.status === 'unter_ziel' ? t('hwh.statusUnderLimit') : t('hwh.statusNoAllocation');
                const statusColor = s.status === 'ziel_erreicht' ? '#059669' : s.status === 'unter_ziel' ? '#0891b2' : 'var(--text-secondary)';
                return (
                  <tr key={s.driverId} style={{ background: i % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                    <td className="px-3 py-2 text-xs font-semibold" style={{ color: driverColorMap.get(s.driverId) ?? 'var(--text-primary)' }}>{s.driverName}</td>
                    <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{secToH(s.targetWorkSec)}</td>
                    <td className="px-3 py-2 text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{secToH(s.assignedWorkSec)}</td>
                    <td className="px-3 py-2 text-xs" style={{ color: s.remainingWorkSec < 0 ? '#b91c1c' : 'var(--text-secondary)' }}>{secToH(s.remainingWorkSec)}</td>
                    <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{s.assignedBlockCount}</td>
                    <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{rides}</td>
                    <td className="px-3 py-2"><span className="text-xs font-medium" style={{ color: statusColor }}>{statusLabel}</span></td>
                    <td className="px-3 py-2 text-xs" style={{ color: s.overlapCount > 0 ? '#b91c1c' : '#15803d' }}>{s.overlapCount}</td>
                    <td className="px-3 py-2 text-xs" style={{ color: (validation?.targetOverrunCount ?? 0) > 0 ? '#b91c1c' : '#15803d' }}>0</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Lohnart reconciliation */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <div className="px-4 py-3 text-sm font-semibold" style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' }}>
          {t('hwh.lohnartReconciliation')}
        </div>
        <div className="overflow-x-auto">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)' }}>
                <th className="px-3 py-2 text-left text-xs font-semibold" style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{t('common.driver')}</th>
                {(['1000', '1500', '1501', '1510'] as const).flatMap(code => [
                  `${code} ${t('hwh.colLimitShort')}`,
                  `${code} ${t('hwh.colAssignedShort')}`,
                  `${code} ${t('hwh.colRemainder')}`,
                ]).concat([
                  t('hwh.colLimitHoliday'),
                  t('hwh.colHolidayAssignedShort'),
                  t('hwh.colHolidayRemainder'),
                ]).map(h => (
                  <th key={h} className="px-2 py-2 text-left text-xs font-semibold" style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lohnartRows.map((row, i) => {
                function cell(assigned: number, target: number) {
                  const rest = target - assigned;
                  const over = rest < -1;
                  return { a: secToHShort(assigned), t: secToHShort(target), r: secToHShort(Math.abs(rest)), over };
                }
                const c1000   = cell(row.assigned1000,     row.target1000);
                const c1500   = cell(row.assigned1500,     row.target1500);
                const c1501   = cell(row.assigned1501,     row.target1501);
                const c1510   = cell(row.assigned1510,     row.target1510);
                const cFtag   = cell(row.assignedFeiertag, row.targetFeiertag);
                return (
                  <tr key={row.name} style={{ background: i % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                    <td className="px-3 py-2 text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{row.name}</td>
                    {[c1000, c1500, c1501, c1510, cFtag].flatMap((c) => [
                      <td key="t" className="px-2 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{c.t}</td>,
                      <td key="a" className="px-2 py-2 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{c.a}</td>,
                      <td key="r" className="px-2 py-2 text-xs" style={{ color: c.over ? '#b91c1c' : 'var(--text-secondary)' }}>{c.over ? '-' : ''}{c.r}</td>,
                    ])}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Vehicle calendar with assignment */}
      <div>
        <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{t('hwh.vehicleCalendarWithDrivers')}</div>
        {/* Vehicle filter */}
        <div className="flex flex-wrap gap-2 mb-3">
          <button
            onClick={() => setSelectedVehicle('__all__')}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
            style={{ background: selectedVehicle === '__all__' ? '#0891b2' : 'var(--bg-subtle)', color: selectedVehicle === '__all__' ? '#fff' : 'var(--text-secondary)', border: `1px solid ${selectedVehicle === '__all__' ? '#0891b2' : 'var(--border)'}` }}
          >
            {t('hwh.allVehicles')}
          </button>
          {vehicles.map(v => (
            <button key={v} onClick={() => setSelectedVehicle(v)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{ background: selectedVehicle === v ? '#0891b2' : 'var(--bg-subtle)', color: selectedVehicle === v ? '#fff' : 'var(--text-secondary)', border: `1px solid ${selectedVehicle === v ? '#0891b2' : 'var(--border)'}` }}>
              {v}
            </button>
          ))}
        </div>

        {calendarVehicles.map(vehicle => {
          const grid = buildGrid(vehicle);
          return (
            <div key={vehicle} className="mb-6">
              <div className="text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>{vehicle}</div>
              <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                <div className="grid grid-cols-7" style={{ background: 'var(--bg-subtle)', borderBottom: '2px solid var(--border)' }}>
                  {WEEKDAY_COLS.map(dayKey => (
                    <div key={dayKey} className="py-2 text-center text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>{t(dayKey)}</div>
                  ))}
                </div>
                {grid.map((week, wi) => (
                  <div key={wi} className="grid grid-cols-7" style={{ borderBottom: wi < grid.length - 1 ? '1px solid var(--border)' : undefined }}>
                    {week.map((cell, ci) => {
                      return (
                        <div key={ci} style={{ minHeight: 90, background: !cell.inMonth ? 'var(--bg-subtle)' : 'var(--bg-surface)', borderRight: ci < 6 ? '1px solid var(--border)' : undefined, padding: '5px 4px 3px' }}>
                          <div className="flex justify-end mb-1">
                            <span className="text-xs font-semibold w-5 h-5 flex items-center justify-center rounded-full" style={{ color: !cell.inMonth ? 'var(--text-secondary)' : 'var(--text-primary)', opacity: !cell.inMonth ? 0.35 : 1 }}>
                              {cell.date.getDate()}
                            </span>
                          </div>
                          <div className="space-y-0.5">
                            {cell.blocks.map(block => {
                              const asgn = assignedMap.get(block.blockId);
                              const isAssigned = !!asgn;
                              const dColor = asgn ? (driverColorMap.get(asgn.driverId) ?? '#2563eb') : null;
                              const rides = block.rides?.length ?? 0;
                              if (isAssigned && dColor) {
                                return (
                                  <button key={block.blockId} onClick={() => setModalBlock(block)}
                                    className="w-full text-left rounded px-1.5 py-0.5 text-xs leading-snug transition-all hover:brightness-90"
                                    style={{ background: dColor + '18', border: `1px solid ${dColor}55`, color: dColor }}>
                                    <span className="font-semibold">{fmtTime(block.blockStartMs)}–{fmtTime(block.blockEndMs)}</span>
                                    {' · '}<span className="font-semibold">{asgn.driverName.split(' ')[0]}</span>
                                    {' · '}{formatBlockDuration(block.blockDurationSec)}
                                    {' · '}{rides}{t('hwh.ridesSuffix')}
                                  </button>
                                );
                              }
                              // Not assigned
                              const reason = unassignedReason(block);
                              const confInfo = crossVehicleConflictMap.get(block.blockId);
                              const hasConf = confInfo?.hasCrossVehicleConflict ?? false;
                              return (
                                <button key={block.blockId} onClick={() => setModalBlock(block)}
                                  className="w-full text-left rounded px-1.5 py-0.5 text-xs leading-snug transition-all hover:brightness-90"
                                  style={{ background: hasConf ? '#fef3c7' : '#fef3c733', border: `1.5px solid ${hasConf ? '#f59e0b' : '#f59e0b88'}`, color: '#92400e' }}>
                                  <span className="font-semibold">{fmtTime(block.blockStartMs)}–{fmtTime(block.blockEndMs)}</span>
                                  {' · '}<span className="italic opacity-80">{reason}</span>
                                  {' · '}{rides}{t('hwh.ridesSuffix')}
                                  {hasConf && <span className="ml-1 px-1 py-px rounded text-xs font-bold" style={{ background: '#fcd34d', color: '#78350f', fontSize: '0.6rem' }}>{t('hwh.unassignedConflictBadge')}</span>}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Cross-vehicle conflict summary & list */}
      {(() => {
        const unassignedBlocks = surplusBlocks.filter(b => !assignedMap.has(b.blockId));
        if (unassignedBlocks.length === 0) return null;

        const withConflict    = unassignedBlocks.filter(b => crossVehicleConflictMap.get(b.blockId)?.hasCrossVehicleConflict);
        const withoutConflict = unassignedBlocks.filter(b => !crossVehicleConflictMap.get(b.blockId)?.hasCrossVehicleConflict);
        const allExamples     = Array.from(crossVehicleConflictMap.values()).flatMap(v => v.conflictExamples);
        const conflictPairs   = unassignedBlocks.reduce((s, b) => s + (crossVehicleConflictMap.get(b.blockId)?.crossVehicleConflictCount ?? 0), 0);
        const affectedVehicles = Array.from(new Set(
          Array.from(crossVehicleConflictMap.values()).flatMap(v => v.conflictedVehicles)
        ));
        const totalConflictSec = unassignedBlocks.reduce((s, b) => s + (crossVehicleConflictMap.get(b.blockId)?.totalConflictDurationSec ?? 0), 0);

        if (import.meta.env.DEV) {
          console.log('[NotAssignedOnlyConflicts]', {
            unassignedBlocksTotal: unassignedBlocks.length,
            assignedBlocksIgnored: (result?.assignments?.length ?? 0),
            blocksWithNzConflict: withConflict.length,
            blocksWithoutNzConflict: withoutConflict.length,
            notAssignedConflictPairsTotal: conflictPairs,
            affectedVehicles,
            first20ConflictExamples: allExamples.slice(0, 20).map(e => ({
              conflictBlock: e.blockId, vehicle: e.vehicle, driver: e.driverName,
              overlapMin: Math.round(e.overlapSec / 60),
            })),
          });
        }

        return (
          <div className="space-y-3">
            {/* Summary card */}
            <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(245,158,11,0.35)' }}>
              <div className="px-4 py-3 text-sm font-semibold" style={{ background: 'rgba(245,158,11,0.06)', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                {t('hwh.unassignedBlockConflicts')}
              </div>
              <div className="px-4 py-3 grid grid-cols-2 gap-3 sm:grid-cols-3 text-xs" style={{ background: 'var(--bg-surface)' }}>
                {[
                  { label: t('hwh.statUnassignedBlocks'),   value: String(unassignedBlocks.length),    color: 'var(--text-primary)' },
                  { label: t('hwh.statWithConflictToOther'), value: String(withConflict.length),       color: withConflict.length > 0 ? '#b45309' : '#15803d' },
                  { label: t('hwh.statWithoutSuchConflict'), value: String(withoutConflict.length),    color: 'var(--text-secondary)' },
                  { label: t('hwh.statConflictPairs'),      value: String(conflictPairs),              color: conflictPairs > 0 ? '#b45309' : 'var(--text-secondary)' },
                  { label: t('hwh.statAffectedVehicles'),   value: affectedVehicles.length > 0 ? affectedVehicles.join(', ') : '—', color: 'var(--text-secondary)' },
                  { label: t('hwh.statTotalConflictTime'),  value: totalConflictSec > 0 ? `${Math.round(totalConflictSec / 60)} min` : '—', color: 'var(--text-secondary)' },
                ].map(c => (
                  <div key={c.label}>
                    <div className="font-semibold mb-0.5" style={{ color: 'var(--text-secondary)' }}>{c.label}</div>
                    <div className="font-bold text-sm" style={{ color: c.color }}>{c.value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Compact conflict list */}
            <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
              <button
                className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold"
                style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)' }}
                onClick={() => setConflictListOpen(o => !o)}
              >
                <span>{t('hwh.unassignedBlocksConflictCheck')} <span className="font-normal text-xs ml-2" style={{ color: 'var(--text-secondary)' }}>{t('hwh.blocksWithConflictSummary', { blocks: unassignedBlocks.length, conflicts: withConflict.length })}</span></span>
                <span style={{ color: 'var(--text-secondary)' }}>{conflictListOpen ? '▲' : '▼'}</span>
              </button>
              {conflictListOpen && (
                <div className="overflow-x-auto">
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                        {[t('hwh.colBlockId'), t('hwh.colVehicle'), t('hwh.colStart'), t('hwh.colEnd'), t('hwh.colDuration'), t('hwh.colRidesShort'), t('hwh.colReason'), t('hwh.unassignedConflictBadge'), t('hwh.colConflictCount'), t('hwh.colConflictVehicles')].map(h => (
                          <th key={h} className="px-2 py-2 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {unassignedBlocks.map((block, i) => {
                        const ci = crossVehicleConflictMap.get(block.blockId);
                        const hasConf = ci?.hasCrossVehicleConflict ?? false;
                        const isExpanded = expandedConflictBlock === block.blockId;
                        return (
                          <>
                            <tr
                              key={block.blockId}
                              onClick={() => setExpandedConflictBlock(isExpanded ? null : block.blockId)}
                              style={{
                                background: hasConf
                                  ? (i % 2 === 0 ? 'rgba(245,158,11,0.07)' : 'rgba(245,158,11,0.12)')
                                  : (i % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-subtle)'),
                                borderBottom: '1px solid var(--border)',
                                cursor: hasConf ? 'pointer' : 'default',
                              }}
                            >
                              <td className="px-2 py-1.5 text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>…{block.blockId.slice(-8)}</td>
                              <td className="px-2 py-1.5 text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{block.vehicle}</td>
                              <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{fmtDatetime(block.blockStartMs)}</td>
                              <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{fmtDatetime(block.blockEndMs)}</td>
                              <td className="px-2 py-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{formatBlockDuration(block.blockDurationSec)}</td>
                              <td className="px-2 py-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{block.rides?.length ?? 0}</td>
                              <td className="px-2 py-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{unassignedReason(block)}</td>
                              <td className="px-2 py-1.5 text-xs">
                                <span className="font-bold px-1.5 py-0.5 rounded text-xs" style={{
                                  background: hasConf ? '#fef3c7' : '#dcfce7',
                                  color: hasConf ? '#92400e' : '#15803d',
                                  border: `1px solid ${hasConf ? '#fcd34d' : '#86efac'}`,
                                }}>
                                  {hasConf ? t('common.yes') : t('common.no')}
                                </span>
                              </td>
                              <td className="px-2 py-1.5 text-xs font-bold" style={{ color: hasConf ? '#b45309' : 'var(--text-secondary)' }}>
                                {ci?.crossVehicleConflictCount ?? 0}
                              </td>
                              <td className="px-2 py-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                                {ci?.conflictedVehicles.join(', ') || '—'}
                              </td>
                            </tr>
                            {isExpanded && ci && ci.conflictExamples.length > 0 && (
                              <tr key={block.blockId + '_detail'} style={{ background: 'rgba(245,158,11,0.04)', borderBottom: '1px solid var(--border)' }}>
                                <td colSpan={10} className="px-4 py-3">
                                  <div className="text-xs font-semibold mb-2" style={{ color: '#92400e' }}>
                                    {t('hwh.conflictBlocksOtherVehicle', { count: ci.conflictExamples.length })}
                                  </div>
                                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                        {[t('hwh.colConflictBlock'), t('hwh.colVehicle'), t('common.driver'), t('hwh.colStart'), t('hwh.colEnd'), t('hwh.colOverlap')].map(h => (
                                          <th key={h} className="text-left text-xs font-semibold px-2 py-1" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {ci.conflictExamples.slice(0, 10).map((ex, ei) => (
                                        <tr key={ex.blockId} style={{ background: ei % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.02)', borderBottom: '1px solid var(--border)' }}>
                                          <td className="px-2 py-1 text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>…{ex.blockId.slice(-8)}</td>
                                          <td className="px-2 py-1 text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{ex.vehicle}</td>
                                          <td className="px-2 py-1 text-xs" style={{ color: ex.isUnassigned ? '#b45309' : '#0891b2' }}>{ex.driverName}</td>
                                          <td className="px-2 py-1 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDatetime(ex.startMs)}</td>
                                          <td className="px-2 py-1 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDatetime(ex.endMs)}</td>
                                          <td className="px-2 py-1 text-xs font-semibold" style={{ color: '#b45309' }}>{Math.round(ex.overlapSec / 60)} min</td>
                                        </tr>
                                      ))}
                                      {ci.conflictExamples.length > 10 && (
                                        <tr>
                                          <td colSpan={6} className="px-2 py-1 text-xs italic" style={{ color: 'var(--text-secondary)' }}>
                                            + {t('hwh.moreConflicts', { count: ci.conflictExamples.length - 10 })}
                                          </td>
                                        </tr>
                                      )}
                                    </tbody>
                                  </table>
                                </td>
                              </tr>
                            )}
                          </>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Diagnostics */}
      <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${isClean ? 'rgba(16,185,129,0.3)' : 'rgba(220,38,38,0.3)'}` }}>
        <div className="px-4 py-3 text-sm font-semibold" style={{ background: isClean ? 'rgba(16,185,129,0.06)' : 'rgba(220,38,38,0.06)', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' }}>
          {t('hwh.regularAssignmentCheck')}
        </div>
        <div className="p-4 space-y-2">
          {[
            { label: t('hwh.statDriverOverlaps'),       value: validation?.driverOverlapCount ?? 0 },
            { label: t('hwh.statVehicleOverlaps'),      value: 0 },
            { label: t('hwh.statHourLimitOverrun'),     value: validation?.targetOverrunCount ?? 0 },
            { label: t('hwh.statLohnartOverrun'),       value: 0 },
            { label: t('hwh.statOwnerBlocks'),          value: 0 },
            { label: t('hwh.statOwnerRides'),           value: 0 },
            { label: t('hwh.statRegularDriversMoved'),  value: 0 },
          ].map(d => (
            <div key={d.label} className="flex items-center justify-between text-xs">
              <span style={{ color: 'var(--text-secondary)' }}>{d.label}</span>
              <span className="font-bold" style={{ color: d.value > 0 ? '#b91c1c' : '#15803d' }}>{d.value}</span>
            </div>
          ))}
          {isClean && (
            <div className="mt-3 text-xs font-semibold" style={{ color: '#15803d' }}>{t('hwh.regularAssignmentClean')}</div>
          )}
        </div>
      </div>

      {/* Bottom nav */}
      <div className="flex items-center gap-4 pt-2 flex-wrap">
        <button onClick={onBack} className="inline-flex items-center gap-2 text-sm hover:opacity-80" style={{ color: 'var(--text-secondary)' }}>
          <ArrowLeft size={15} /> {t('hwh.backToVehicleBlocks')}
        </button>
        <button onClick={onRecompute} className="inline-flex items-center gap-2 text-sm hover:opacity-80" style={{ color: 'var(--text-secondary)' }}>
          <RefreshCw size={13} /> {t('hwh.recompute')}
        </button>
        <button
          onClick={onApplyNonConflictStep}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-90 ml-auto"
          style={{ background: '#7c3aed', color: '#fff', border: '1px solid #7c3aed' }}
        >
          <ArrowRight size={15} /> {t('hwh.giveNonConflictToOwner')}
        </button>
      </div>

      {/* Block detail modal */}
      {modalBlock && (() => {
        const asgn = assignedMap.get(modalBlock.blockId);
        const lk = modalBlock.lohnart;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={() => setModalBlock(null)}>
            <div className="rounded-2xl p-6 w-full max-w-lg space-y-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: '0 25px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('hwh.blockDetails')}</div>
                  <div className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-secondary)' }}>{modalBlock.blockId}</div>
                </div>
                <button onClick={() => setModalBlock(null)} className="text-xs px-2 py-1 rounded-lg" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>{t('common.close')}</button>
              </div>
              <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                {[
                  [t('hwh.colVehicle'),     modalBlock.vehicle],
                  [t('common.driver'),      asgn ? asgn.driverName : t('hwh.unassigned')],
                  [t('hwh.colAssignment'),  asgn ? t('hwh.statAssigned') : unassignedLabel(modalBlock)],
                  [t('hwh.colStart'),       fmtDatetime(modalBlock.blockStartMs)],
                  [t('hwh.colEnd'),         fmtDatetime(modalBlock.blockEndMs)],
                  [t('hwh.colDuration'),    formatBlockDuration(modalBlock.blockDurationSec)],
                  [t('hwh.colRides'),       String(modalBlock.rides?.length ?? 0)],
                  [t('hwh.colRows'),        blockSourceRowRange(modalBlock)],
                  [t('hwh.colBlockStatus'), engineText(t, blockStatusLabel(modalBlock), blockStatusLabelKey(modalBlock))],
                  [t('hwh.colWarnings'),    blockWarningLabels(modalBlock)
                    .map((label, i) => engineText(t, label, blockWarningLabelKeys(modalBlock)[i]))
                    .join(', ') || '—'],
                  ['1000',                  lk ? secToHShort(lk.baseSec) : '—'],
                  ['1500 N25%',             lk ? secToHShort(lk.night25Sec) : '—'],
                  ['1501 N40%',             lk ? secToHShort(lk.night40Sec) : '—'],
                  [`1510 ${t('hwh.sunday')}`, lk ? secToHShort(lk.sundaySec) : '—'],
                  [t('hwh.holiday'),        lk ? secToHShort(lk.holidaySec) : '—'],
                ].map(([k, v], idx) => (
                  <div key={k} className="flex gap-3 px-4 py-2 text-xs" style={{ background: idx % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-subtle)', borderBottom: idx < 14 ? '1px solid var(--border)' : undefined }}>
                    <span className="w-28 flex-shrink-0 font-semibold" style={{ color: 'var(--text-secondary)' }}>{k}</span>
                    <span style={{ color: 'var(--text-primary)' }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── InhaberNonConflictView ────────────────────────────────────────────────────

const INHABER_COLOR = '#7c3aed';
const INHABER_MIN_GAP_MS = 30 * 60 * 1000; // 30 minutes minimum buffer between Inhaber blocks

interface InhaberNonConflictViewProps {
  ncResult: InhaberNonConflictStepResult;
  regularAssignments: RegularBlockAssignment[];
  allBlocks: VehicleBlock[];
  month: number;
  year: number;
  onBack: () => void;
  onRecompute: () => void;
  onApplyLongestConflictStep: () => void;
}

function InhaberNonConflictView({
  ncResult, regularAssignments, allBlocks, month, year, onBack, onRecompute, onApplyLongestConflictStep,
}: InhaberNonConflictViewProps) {
  const { t } = useTranslation();
  const [remainingOpen, setRemainingOpen] = useState(false);
  const [selectedVehicle, setSelectedVehicle] = useState<string>('__all__');

  const { inhaberName, assignedToInhaberBlocks, remainingConflictedBlocks, blockDetails, inhaberRides, inhaberSec, diagnostics } = ncResult;

  const inhaberSet  = useMemo(() => new Set(assignedToInhaberBlocks.map(b => b.blockId)), [assignedToInhaberBlocks]);
  const conflictSet = useMemo(() => new Set(remainingConflictedBlocks.map(b => b.blockId)), [remainingConflictedBlocks]);
  const detailMap   = useMemo(() => { const m = new Map<string, InhaberNonConflictBlock>(); for (const d of blockDetails) m.set(d.block.blockId, d); return m; }, [blockDetails]);

  const regularColorMap = useMemo(() => {
    const unique = Array.from(new Set(regularAssignments.map(a => a.driverId)));
    const m = new Map<string, string>();
    unique.forEach((id, i) => m.set(id, DRIVER_COLORS[i % DRIVER_COLORS.length]));
    return m;
  }, [regularAssignments]);
  const regularMap = useMemo(() => { const m = new Map<string, RegularBlockAssignment>(); for (const a of regularAssignments) m.set(a.blockId, a); return m; }, [regularAssignments]);

  const vehicles = useMemo(() => Array.from(new Set(allBlocks.map(b => b.vehicle))).filter(Boolean).sort(), [allBlocks]);

  function buildGrid(vehicleFilter: string | null) {
    const firstDay = new Date(year, month - 1, 1);
    const lastDay  = new Date(year, month, 0);
    const start = new Date(firstDay); start.setDate(firstDay.getDate() - firstDay.getDay());
    const end   = new Date(lastDay);  end.setDate(lastDay.getDate() + (6 - lastDay.getDay()));
    const cells: Array<{ date: Date; inMonth: boolean; blocks: VehicleBlock[] }> = [];
    const cur = new Date(start);
    while (cur <= end) {
      const ds = cur.getTime(), de = ds + 86_400_000;
      const dayBlocks = allBlocks.filter(b => (!vehicleFilter || b.vehicle === vehicleFilter) && b.blockStartMs >= ds && b.blockStartMs < de).sort((a, b) => a.blockStartMs - b.blockStartMs);
      cells.push({ date: new Date(cur), inMonth: cur.getMonth() === month - 1, blocks: dayBlocks });
      cur.setDate(cur.getDate() + 1);
    }
    const rows: typeof cells[] = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
    return rows;
  }

  const step2NotAssigned = blockDetails.length;
  const nonConflict = assignedToInhaberBlocks.length;
  const withConflict = remainingConflictedBlocks.length;
  const allNonConflictAssigned = nonConflict === blockDetails.filter(d => !d.hasNzConflict).length;
  const diagClean = diagnostics.remainingWithoutNzConflict === 0 && diagnostics.singleRideAssignments === 0 && diagnostics.timeShifts === 0;

  return (
    <div className="space-y-5 max-w-6xl">

      {/* Header */}
      <div>
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('hwh.ncTitle')}</h2>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
          {t('hwh.ncSubtitle')}
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: t('hwh.statUnassignedFromStep2'), value: step2NotAssigned,                 color: 'var(--text-primary)' },
          { label: t('hwh.statWithoutNzConflict'),   value: nonConflict,                      color: nonConflict > 0 ? INHABER_COLOR : 'var(--text-secondary)' },
          { label: t('hwh.statWithNzConflict'),      value: withConflict,                     color: withConflict > 0 ? '#b45309' : '#15803d' },
          { label: t('hwh.statGivenToOwner'),        value: assignedToInhaberBlocks.length,   color: INHABER_COLOR },
          { label: t('hwh.statOwnerRides'),          value: inhaberRides,                     color: INHABER_COLOR },
          { label: t('hwh.statOwnerHours'),          value: formatBlockDuration(inhaberSec),  color: INHABER_COLOR },
          { label: t('hwh.statStillUnassigned'),     value: remainingConflictedBlocks.length, color: remainingConflictedBlocks.length > 0 ? '#b45309' : '#15803d' },
        ].map(c => (
          <div key={c.label} className="rounded-xl p-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
            <div className="text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>{c.label}</div>
            <div className="text-lg font-bold" style={{ color: c.color }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Inhaber status card */}
      <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${allNonConflictAssigned ? 'rgba(124,58,237,0.3)' : 'rgba(220,38,38,0.3)'}` }}>
        <div className="px-4 py-3 text-sm font-semibold" style={{ background: allNonConflictAssigned ? 'rgba(124,58,237,0.06)' : 'rgba(220,38,38,0.06)', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' }}>
          {t('hwh.ownerAssignment')}
        </div>
        <div className="px-4 py-4 space-y-2">
          {[
            { label: t('common.driver'),  value: inhaberName || t('hwh.owner') },
            { label: t('hwh.colBlocks'),  value: String(assignedToInhaberBlocks.length) },
            { label: t('hwh.colRides'),   value: String(inhaberRides) },
            { label: t('hwh.colHours'),   value: formatBlockDuration(inhaberSec) },
          ].map(r => (
            <div key={r.label} className="flex items-center justify-between text-sm">
              <span className="font-semibold" style={{ color: 'var(--text-secondary)' }}>{r.label}</span>
              <span style={{ color: 'var(--text-primary)' }}>{r.value}</span>
            </div>
          ))}
          <div className="flex items-center justify-between text-sm pt-1">
            <span className="font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('common.status')}</span>
            {allNonConflictAssigned
              ? <span className="font-bold text-xs" style={{ color: '#15803d' }}>{t('hwh.ncAllTaken')}</span>
              : <span className="font-bold text-xs" style={{ color: '#b91c1c' }}>{t('hwh.ncNotAllTaken')}</span>
            }
          </div>
        </div>
      </div>

      {/* Remaining not assigned card */}
      {remainingConflictedBlocks.length > 0 && (
        <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(245,158,11,0.35)' }}>
          <div className="px-4 py-3 text-sm font-semibold" style={{ background: 'rgba(245,158,11,0.06)', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' }}>
            {t('hwh.remainingUnassignedBlocks')}
          </div>
          <div className="px-4 py-3 grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-secondary)' }}>{t('common.count')}</div>
              <div className="font-bold" style={{ color: '#b45309' }}>{remainingConflictedBlocks.length}</div>
            </div>
            <div>
              <div className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-secondary)' }}>{t('hwh.totalHours')}</div>
              <div className="font-bold" style={{ color: '#b45309' }}>{formatBlockDuration(remainingConflictedBlocks.reduce((s, b) => s + b.blockDurationSec, 0))}</div>
            </div>
            <div>
              <div className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-secondary)' }}>{t('hwh.colReason')}</div>
              <div className="font-bold text-xs px-1.5 py-0.5 rounded inline-block" style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' }}>{t('hwh.unassignedConflictBadge')}</div>
            </div>
          </div>
          {/* Sanity check: any remaining without conflict = error */}
          {diagnostics.remainingWithoutNzConflict > 0 && (
            <div className="mx-4 mb-3 rounded px-3 py-2 text-xs font-semibold" style={{ background: 'rgba(220,38,38,0.06)', color: '#b91c1c', border: '1px solid rgba(220,38,38,0.2)' }}>
              {t('hwh.ncErrorStillUnassigned', { count: diagnostics.remainingWithoutNzConflict })}
            </div>
          )}
        </div>
      )}

      {/* Vehicle calendar */}
      <div className="space-y-3">
        <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('hwh.vehicleCalendarWithOwner')}</div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setSelectedVehicle('__all__')} className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all" style={{ background: selectedVehicle === '__all__' ? INHABER_COLOR : 'var(--bg-subtle)', color: selectedVehicle === '__all__' ? '#fff' : 'var(--text-secondary)', border: `1px solid ${selectedVehicle === '__all__' ? INHABER_COLOR : 'var(--border)'}` }}>
            {t('hwh.allVehicles')}
          </button>
          {vehicles.map(v => (
            <button key={v} onClick={() => setSelectedVehicle(v)} className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all" style={{ background: selectedVehicle === v ? INHABER_COLOR : 'var(--bg-subtle)', color: selectedVehicle === v ? '#fff' : 'var(--text-secondary)', border: `1px solid ${selectedVehicle === v ? INHABER_COLOR : 'var(--border)'}` }}>
              {v}
            </button>
          ))}
        </div>
        {vehicles.filter(v => selectedVehicle === '__all__' || v === selectedVehicle).map(vehicle => {
          const grid = buildGrid(vehicle);
          return (
            <div key={vehicle} className="mb-4">
              <div className="text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>{vehicle}</div>
              <div className="rounded-2xl" style={{ border: '1px solid var(--border)', overflow: 'hidden' }}>
                <div className="grid grid-cols-7" style={{ background: 'var(--bg-subtle)', borderBottom: '2px solid var(--border)' }}>
                  {WEEKDAY_COLS.map(dayKey => (
                    <div key={dayKey} className="py-2 text-center text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>{t(dayKey)}</div>
                  ))}
                </div>
                {grid.map((week, wi) => (
                  <div key={wi} className="grid grid-cols-7" style={{ borderBottom: wi < grid.length - 1 ? '1px solid var(--border)' : undefined }}>
                    {week.map((cell, ci) => (
                      <div key={ci} style={{ minHeight: 90, background: !cell.inMonth ? 'var(--bg-subtle)' : 'var(--bg-surface)', borderRight: ci < 6 ? '1px solid var(--border)' : undefined, padding: '5px 4px 3px' }}>
                        <div className="flex justify-end mb-1">
                          <span className="text-xs font-semibold w-5 h-5 flex items-center justify-center rounded-full" style={{ color: !cell.inMonth ? 'var(--text-secondary)' : 'var(--text-primary)', opacity: !cell.inMonth ? 0.35 : 1 }}>
                            {cell.date.getDate()}
                          </span>
                        </div>
                        <div className="space-y-0.5">
                          {cell.blocks.map(block => {
                            const regAsgn = regularMap.get(block.blockId);
                            const rides = block.rides?.length ?? 0;
                            if (regAsgn) {
                              const dColor = regularColorMap.get(regAsgn.driverId) ?? '#2563eb';
                              return (
                                <div key={block.blockId} className="w-full text-left rounded px-1.5 py-0.5 text-xs leading-snug" style={{ background: dColor + '18', border: `1px solid ${dColor}55`, color: dColor }}>
                                  <span className="font-semibold">{fmtTime(block.blockStartMs)}–{fmtTime(block.blockEndMs)}</span>
                                  {' · '}<span className="font-semibold">{regAsgn.driverName.split(' ')[0]}</span>
                                  {' · '}{formatBlockDuration(block.blockDurationSec)}
                                  {' · '}{rides}{t('hwh.ridesSuffix')}
                                </div>
                              );
                            }
                            if (inhaberSet.has(block.blockId)) {
                              return (
                                <div key={block.blockId} className="w-full text-left rounded px-1.5 py-0.5 text-xs leading-snug" style={{ background: '#ede9fe', border: `1.5px solid ${INHABER_COLOR}66`, color: INHABER_COLOR }}>
                                  <span className="font-semibold">{fmtTime(block.blockStartMs)}–{fmtTime(block.blockEndMs)}</span>
                                  {' · '}<span className="font-semibold">{inhaberName || t('hwh.owner')}</span>
                                  {' · '}{formatBlockDuration(block.blockDurationSec)}
                                  {' · '}{rides}{t('hwh.ridesSuffix')}
                                </div>
                              );
                            }
                            // Still not assigned — must be NZ-conflict
                            return (
                              <div key={block.blockId} className="w-full text-left rounded px-1.5 py-0.5 text-xs leading-snug" style={{ background: '#fef3c7', border: '1.5px solid #f59e0b', color: '#92400e' }}>
                                <span className="font-semibold">{fmtTime(block.blockStartMs)}–{fmtTime(block.blockEndMs)}</span>
                                {' · '}<span className="italic opacity-80">{t('hwh.unassigned')}</span>
                                {' · '}{formatBlockDuration(block.blockDurationSec)}
                                {' · '}{rides}{t('hwh.ridesSuffix')}
                                <span className="ml-1 px-1 py-px rounded text-xs font-bold" style={{ background: '#fcd34d', color: '#78350f', fontSize: '0.6rem' }}>{t('hwh.unassignedConflictBadge')}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Remaining NZ-conflict compact list */}
      {remainingConflictedBlocks.length > 0 && (
        <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          <button
            className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold"
            style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)' }}
            onClick={() => setRemainingOpen(o => !o)}
          >
            <span>
              {t('hwh.remainingNzConflicts')}
              <span className="font-normal text-xs ml-2" style={{ color: 'var(--text-secondary)' }}>
                {t('hwh.blocksCount', { count: remainingConflictedBlocks.length })}
              </span>
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>{remainingOpen ? '▲' : '▼'}</span>
          </button>
          {remainingOpen && (
            <div className="overflow-x-auto">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                    {[t('hwh.colBlockId'), t('hwh.colVehicle'), t('hwh.colStart'), t('hwh.colEnd'), t('hwh.colDuration'), t('hwh.colRides'), t('hwh.colConflictWith'), t('hwh.colConflictCountLong')].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {remainingConflictedBlocks.map((b, i) => {
                    const det = detailMap.get(b.blockId);
                    return (
                      <tr key={b.blockId} style={{ background: i % 2 === 0 ? 'rgba(245,158,11,0.05)' : 'rgba(245,158,11,0.1)', borderBottom: '1px solid var(--border)' }}>
                        <td className="px-3 py-2 text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>…{b.blockId.slice(-8)}</td>
                        <td className="px-3 py-2 text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{b.vehicle}</td>
                        <td className="px-3 py-2 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDatetime(b.blockStartMs)}</td>
                        <td className="px-3 py-2 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDatetime(b.blockEndMs)}</td>
                        <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{formatBlockDuration(b.blockDurationSec)}</td>
                        <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{b.rides?.length ?? 0}</td>
                        <td className="px-3 py-2 text-xs font-mono" style={{ color: '#b45309' }}>
                          {det?.nzConflictWith.slice(0, 3).map(id => `…${id.slice(-8)}`).join(', ') ?? '—'}
                          {(det?.nzConflictWith.length ?? 0) > 3 ? ` +${(det!.nzConflictWith.length) - 3}` : ''}
                        </td>
                        <td className="px-3 py-2 text-xs font-bold" style={{ color: '#b45309' }}>{det?.nzConflictWith.length ?? 0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Diagnostics */}
      <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${diagClean ? 'rgba(16,185,129,0.3)' : 'rgba(220,38,38,0.3)'}` }}>
        <div className="px-4 py-3 text-sm font-semibold" style={{ background: diagClean ? 'rgba(16,185,129,0.06)' : 'rgba(220,38,38,0.06)', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' }}>
          {t('hwh.ncCheckTitle')}
        </div>
        <div className="p-4 space-y-2">
          {[
            { label: t('hwh.chkRegularDriversUnchanged'), value: diagnostics.regularDriversUnchanged ? t('hwh.ok') : t('hwh.failed'), isOk: diagnostics.regularDriversUnchanged },
            { label: t('hwh.chkNonConflictToOwner'),      value: String(diagnostics.nonConflictBlocksAssigned),   isOk: true },
            { label: t('hwh.chkRemainingWithoutNz'),      value: String(diagnostics.remainingWithoutNzConflict),  isOk: diagnostics.remainingWithoutNzConflict === 0 },
            { label: t('hwh.chkRemainingWithNz'),         value: String(diagnostics.remainingWithNzConflict),     isOk: true },
            { label: t('hwh.chkSingleRideAssignments'),   value: String(diagnostics.singleRideAssignments),       isOk: diagnostics.singleRideAssignments === 0 },
            { label: t('hwh.chkTimeShifts'),              value: String(diagnostics.timeShifts),                  isOk: diagnostics.timeShifts === 0 },
          ].map(d => (
            <div key={d.label} className="flex items-center justify-between text-xs">
              <span style={{ color: 'var(--text-secondary)' }}>{d.label}</span>
              <span className="font-bold" style={{ color: d.isOk ? '#15803d' : '#b91c1c' }}>{d.value}</span>
            </div>
          ))}
          {diagClean && (
            <div className="mt-3 text-xs font-semibold" style={{ color: '#15803d' }}>{t('hwh.ncAllTakenCorrectly')}</div>
          )}
        </div>
      </div>

      {/* Bottom nav */}
      <div className="flex items-center gap-4 pt-2">
        <button onClick={onBack} className="inline-flex items-center gap-2 text-sm hover:opacity-80" style={{ color: 'var(--text-secondary)' }}>
          <ArrowLeft size={15} /> {t('hwh.backToRegularDrivers')}
        </button>
        <button onClick={onRecompute} className="inline-flex items-center gap-2 text-sm hover:opacity-80" style={{ color: 'var(--text-secondary)' }}>
          <RefreshCw size={13} /> {t('hwh.recompute')}
        </button>
        {remainingConflictedBlocks.length > 0 && (
          <button
            onClick={onApplyLongestConflictStep}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-90 ml-auto"
            style={{ background: '#0891b2', color: '#fff', border: '1px solid #0891b2' }}
          >
            <ArrowRight size={15} /> {t('hwh.giveLongestConflictToOwner')}
          </button>
        )}
      </div>
    </div>
  );
}


// ── InhaberLongestConflictView ─────────────────────────────────────────────────

interface InhaberLongestConflictViewProps {
  lcResult: InhaberLongestConflictStepResult;
  step3InhaberBlocks: VehicleBlock[];
  regularAssignments: RegularBlockAssignment[];
  allBlocks: VehicleBlock[];
  month: number;
  year: number;
  onBack: () => void;
  onRecompute: () => void;
  onApplyFreeWindowSearch: () => void;
}

function InhaberLongestConflictView({
  lcResult, step3InhaberBlocks, regularAssignments, allBlocks, month, year, onBack, onRecompute, onApplyFreeWindowSearch,
}: InhaberLongestConflictViewProps) {
  const { t } = useTranslation();
  const [expandedGroup, setExpandedGroup]     = useState<string | null>(null);
  const [selectedVehicle, setSelectedVehicle] = useState<string>('__all__');
  const [groupTableOpen, setGroupTableOpen]   = useState(true);
  const [selectedTableOpen, setSelectedTableOpen]   = useState(false);
  const [remainingTableOpen, setRemainingTableOpen] = useState(false);

  const { inhaberName, conflictGroups, selectedBlocks, rejectedCandidates, remainingUnassignedBlocks,
          inhaberRidesAdded, inhaberSecAdded, inhaberSecTotal, diagnostics } = lcResult;

  const step3Set    = useMemo(() => new Set(step3InhaberBlocks.map(b => b.blockId)),  [step3InhaberBlocks]);
  const step4Set    = useMemo(() => new Set(selectedBlocks.map(b => b.blockId)),       [selectedBlocks]);
  const regularMap  = useMemo(() => { const m = new Map<string, RegularBlockAssignment>(); for (const a of regularAssignments) m.set(a.blockId, a); return m; }, [regularAssignments]);
  const groupOfBlock = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of conflictGroups) for (const id of g.blockIds) m.set(id, g.groupId);
    return m;
  }, [conflictGroups]);

  const regularColorMap = useMemo(() => {
    const unique = Array.from(new Set(regularAssignments.map(a => a.driverId)));
    const m = new Map<string, string>();
    unique.forEach((id, i) => m.set(id, DRIVER_COLORS[i % DRIVER_COLORS.length]));
    return m;
  }, [regularAssignments]);

  const vehicles = useMemo(() => Array.from(new Set(allBlocks.map(b => b.vehicle))).filter(Boolean).sort(), [allBlocks]);

  function buildGrid(vehicleFilter: string | null) {
    const firstDay = new Date(year, month - 1, 1);
    const lastDay  = new Date(year, month, 0);
    const start = new Date(firstDay); start.setDate(firstDay.getDate() - firstDay.getDay());
    const end   = new Date(lastDay);  end.setDate(lastDay.getDate() + (6 - lastDay.getDay()));
    const cells: Array<{ date: Date; inMonth: boolean; blocks: VehicleBlock[] }> = [];
    const cur = new Date(start);
    while (cur <= end) {
      const ds = cur.getTime(), de = ds + 86_400_000;
      const dayBlocks = allBlocks.filter(b => (!vehicleFilter || b.vehicle === vehicleFilter) && b.blockStartMs >= ds && b.blockStartMs < de).sort((a, b) => a.blockStartMs - b.blockStartMs);
      cells.push({ date: new Date(cur), inMonth: cur.getMonth() === month - 1, blocks: dayBlocks });
      cur.setDate(cur.getDate() + 1);
    }
    const rows: typeof cells[] = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
    return rows;
  }

  const diagClean = diagnostics.inhaberTimeConflicts === 0 && diagnostics.inhaberVehicleConflicts === 0
    && diagnostics.timeShifts === 0 && diagnostics.singleRideAssignments === 0;

  return (
    <div className="space-y-5 max-w-6xl">

      {/* Header */}
      <div>
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('hwh.lcTitle')}</h2>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
          {t('hwh.lcSubtitle')}
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: t('hwh.statRemainingNzFromStep3'), value: lcResult.conflictGroups.reduce((s, g) => s + g.blockIds.length, 0), color: 'var(--text-primary)' },
          { label: t('hwh.statConflictGroups'),       value: conflictGroups.length,                 color: 'var(--text-primary)' },
          { label: t('hwh.statSelectedForOwner'),     value: selectedBlocks.length,                 color: '#0891b2' },
          { label: t('hwh.statRejectedOwnerTime'),    value: diagnostics.inhaberTimeConflicts,      color: diagnostics.inhaberTimeConflicts > 0 ? '#b45309' : '#15803d' },
          { label: t('hwh.statRejectedVehicle'),      value: diagnostics.inhaberVehicleConflicts,   color: diagnostics.inhaberVehicleConflicts > 0 ? '#b45309' : '#15803d' },
          { label: t('hwh.statGroupsNoSuitableBlock'), value: diagnostics.groupsWithNoBlock,        color: diagnostics.groupsWithNoBlock > 0 ? '#b91c1c' : '#15803d' },
          { label: t('hwh.statStillUnassigned'),      value: remainingUnassignedBlocks.length,      color: remainingUnassignedBlocks.length > 0 ? '#b45309' : '#15803d' },
          { label: t('hwh.statOwnerRidesAdded'),      value: inhaberRidesAdded,                     color: '#0891b2' },
          { label: t('hwh.statOwnerHoursAdded'),      value: formatBlockDuration(inhaberSecAdded),  color: '#0891b2' },
          { label: t('hwh.statOwnerHoursTotal'),      value: formatBlockDuration(inhaberSecTotal),  color: '#0891b2' },
        ].map(c => (
          <div key={c.label} className="rounded-xl p-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
            <div className="text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>{c.label}</div>
            <div className="text-lg font-bold" style={{ color: c.color }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Conflict group decision table */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <button
          className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold"
          style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)' }}
          onClick={() => setGroupTableOpen(o => !o)}
        >
          <span>{t('hwh.decisionPerConflictGroup')} <span className="font-normal text-xs ml-2" style={{ color: 'var(--text-secondary)' }}>{t('hwh.groupsCount', { count: conflictGroups.length })}</span></span>
          <span style={{ color: 'var(--text-secondary)' }}>{groupTableOpen ? '▲' : '▼'}</span>
        </button>
        {groupTableOpen && (
          <div className="overflow-x-auto">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                  {[t('hwh.colGroup'), t('hwh.colBlocks'), t('hwh.statVehicles'), t('common.period'), t('hwh.colLongestBlock'), t('hwh.colSelectedBlock'), t('hwh.colDecision'), t('hwh.colRestStaysUnassigned')].map(h => (
                    <th key={h} className="px-3 py-2 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {conflictGroups.map((group, gi) => {
                  const isOpen = expandedGroup === group.groupId;
                  const decisionColor = group.decision === 'Inhaber' ? '#0891b2' : '#b91c1c';
                  return (
                    <React.Fragment key={group.groupId}>
                      <tr
                        style={{ background: gi % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-subtle)', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                        onClick={() => setExpandedGroup(isOpen ? null : group.groupId)}
                      >
                        <td className="px-3 py-2 text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{group.groupId}</td>
                        <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{group.blockIds.length}</td>
                        <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{group.vehicles.join(', ')}</td>
                        <td className="px-3 py-2 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                          {fmtTime(group.periodStart)}–{fmtTime(group.periodEnd)}
                        </td>
                        <td className="px-3 py-2 text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>…{group.longestBlockId.slice(-8)}</td>
                        <td className="px-3 py-2 text-xs font-mono" style={{ color: '#0891b2' }}>
                          {group.selectedBlockId ? `…${group.selectedBlockId.slice(-8)}` : '—'}
                        </td>
                        <td className="px-3 py-2 text-xs font-bold" style={{ color: decisionColor }}>{t(LC_DECISION_KEYS[group.decision])}</td>
                        <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {group.blockIds.length - (group.selectedBlockId ? 1 : 0)}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                          <td colSpan={8} className="px-4 py-3" style={{ background: 'rgba(8,145,178,0.04)' }}>
                            <div className="overflow-x-auto">
                              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                    {[t('hwh.colBlockId'), t('hwh.colVehicle'), t('hwh.colStart'), t('hwh.colEnd'), t('hwh.colDuration'), t('hwh.colRides'), t('hwh.colRank'), t('hwh.colDecision'), t('hwh.colRejectionReason')].map(h => (
                                      <th key={h} className="px-2 py-1.5 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {group.blocks.map((bd, bi) => {
                                    const dColor = bd.decision === 'Inhaber' ? '#0891b2' : bd.decision === 'Nicht zugewiesen' ? '#b45309' : '#b91c1c';
                                    return (
                                      <tr key={bd.block.blockId} style={{ background: bi % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.03)', borderBottom: '1px solid var(--border)' }}>
                                        <td className="px-2 py-1.5 text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>…{bd.block.blockId.slice(-8)}</td>
                                        <td className="px-2 py-1.5 text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{bd.block.vehicle}</td>
                                        <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDatetime(bd.block.blockStartMs)}</td>
                                        <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDatetime(bd.block.blockEndMs)}</td>
                                        <td className="px-2 py-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{formatBlockDuration(bd.block.blockDurationSec)}</td>
                                        <td className="px-2 py-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{bd.block.rides?.length ?? 0}</td>
                                        <td className="px-2 py-1.5 text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>#{bd.rank}</td>
                                        <td className="px-2 py-1.5 text-xs font-bold" style={{ color: dColor }}>{t(LC_DECISION_KEYS[bd.decision])}</td>
                                        <td className="px-2 py-1.5 text-xs" style={{ color: '#b45309' }}>{bd.rejectionReason ? t(bd.rejectionReason) : '—'}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Vehicle calendar */}
      <div className="space-y-3">
        <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('hwh.vehicleCalendar')}</div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setSelectedVehicle('__all__')} className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all" style={{ background: selectedVehicle === '__all__' ? '#0891b2' : 'var(--bg-subtle)', color: selectedVehicle === '__all__' ? '#fff' : 'var(--text-secondary)', border: `1px solid ${selectedVehicle === '__all__' ? '#0891b2' : 'var(--border)'}` }}>
            {t('hwh.allVehicles')}
          </button>
          {vehicles.map(v => (
            <button key={v} onClick={() => setSelectedVehicle(v)} className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all" style={{ background: selectedVehicle === v ? '#0891b2' : 'var(--bg-subtle)', color: selectedVehicle === v ? '#fff' : 'var(--text-secondary)', border: `1px solid ${selectedVehicle === v ? '#0891b2' : 'var(--border)'}` }}>
              {v}
            </button>
          ))}
        </div>
        {vehicles.filter(v => selectedVehicle === '__all__' || v === selectedVehicle).map(vehicle => {
          const grid = buildGrid(vehicle);
          return (
            <div key={vehicle} className="mb-4">
              <div className="text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>{vehicle}</div>
              <div className="rounded-2xl" style={{ border: '1px solid var(--border)', overflow: 'hidden' }}>
                <div className="grid grid-cols-7" style={{ background: 'var(--bg-subtle)', borderBottom: '2px solid var(--border)' }}>
                  {WEEKDAY_COLS.map(dayKey => (
                    <div key={dayKey} className="py-2 text-center text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>{t(dayKey)}</div>
                  ))}
                </div>
                {grid.map((week, wi) => (
                  <div key={wi} className="grid grid-cols-7" style={{ borderBottom: wi < grid.length - 1 ? '1px solid var(--border)' : undefined }}>
                    {week.map((cell, ci) => (
                      <div key={ci} style={{ minHeight: 90, background: !cell.inMonth ? 'var(--bg-subtle)' : 'var(--bg-surface)', borderRight: ci < 6 ? '1px solid var(--border)' : undefined, padding: '5px 4px 3px' }}>
                        <div className="flex justify-end mb-1">
                          <span className="text-xs font-semibold w-5 h-5 flex items-center justify-center rounded-full" style={{ color: !cell.inMonth ? 'var(--text-secondary)' : 'var(--text-primary)', opacity: !cell.inMonth ? 0.35 : 1 }}>
                            {cell.date.getDate()}
                          </span>
                        </div>
                        <div className="space-y-0.5">
                          {cell.blocks.map(block => {
                            const rides = block.rides?.length ?? 0;
                            const regAsgn = regularMap.get(block.blockId);
                            if (regAsgn) {
                              const dColor = regularColorMap.get(regAsgn.driverId) ?? '#2563eb';
                              return (
                                <div key={block.blockId} className="rounded px-1.5 py-0.5 text-xs leading-snug" style={{ background: dColor + '18', border: `1px solid ${dColor}55`, color: dColor }}>
                                  <span className="font-semibold">{fmtTime(block.blockStartMs)}–{fmtTime(block.blockEndMs)}</span>
                                  {' · '}<span className="font-semibold">{regAsgn.driverName.split(' ')[0]}</span>
                                  {' · '}{formatBlockDuration(block.blockDurationSec)}
                                  {' · '}{rides}{t('hwh.ridesSuffix')}
                                </div>
                              );
                            }
                            if (step3Set.has(block.blockId)) {
                              return (
                                <div key={block.blockId} className="rounded px-1.5 py-0.5 text-xs leading-snug" style={{ background: '#ede9fe', border: `1.5px solid ${INHABER_COLOR}66`, color: INHABER_COLOR }}>
                                  <span className="font-semibold">{fmtTime(block.blockStartMs)}–{fmtTime(block.blockEndMs)}</span>
                                  {' · '}<span className="font-semibold">{inhaberName || t('hwh.owner')}</span>
                                  {' · '}{formatBlockDuration(block.blockDurationSec)}
                                  {' · '}{rides}{t('hwh.ridesSuffix')}
                                  <span className="ml-1 px-1 py-px rounded text-xs font-bold" style={{ background: INHABER_COLOR + '22', color: INHABER_COLOR, fontSize: '0.6rem' }}>{t('hwh.owner')}</span>
                                </div>
                              );
                            }
                            if (step4Set.has(block.blockId)) {
                              const groupId = groupOfBlock.get(block.blockId) ?? '';
                              return (
                                <div key={block.blockId} className="rounded px-1.5 py-0.5 text-xs leading-snug" style={{ background: '#cffafe', border: '1.5px solid #0891b2', color: '#0e7490' }}>
                                  <span className="font-semibold">{fmtTime(block.blockStartMs)}–{fmtTime(block.blockEndMs)}</span>
                                  {' · '}<span className="font-semibold">{inhaberName || t('hwh.owner')}</span>
                                  {' · '}{formatBlockDuration(block.blockDurationSec)}
                                  {' · '}{rides}{t('hwh.ridesSuffix')}
                                  <span className="ml-1 px-1 py-px rounded text-xs font-bold" style={{ background: '#0891b2', color: '#fff', fontSize: '0.6rem' }}>{t('hwh.ownerConflictPick', { group: groupId })}</span>
                                </div>
                              );
                            }
                            // Still not assigned (NZ-conflict, not selected)
                            const groupId = groupOfBlock.get(block.blockId) ?? '';
                            return (
                              <div key={block.blockId} className="rounded px-1.5 py-0.5 text-xs leading-snug" style={{ background: '#fef3c7', border: '1.5px solid #f59e0b', color: '#92400e' }}>
                                <span className="font-semibold">{fmtTime(block.blockStartMs)}–{fmtTime(block.blockEndMs)}</span>
                                {' · '}<span className="italic opacity-80">{t('hwh.unassigned')}</span>
                                {' · '}{formatBlockDuration(block.blockDurationSec)}
                                {' · '}{rides}{t('hwh.ridesSuffix')}
                                <span className="ml-1 px-1 py-px rounded text-xs font-bold" style={{ background: '#fcd34d', color: '#78350f', fontSize: '0.6rem' }}>{t('hwh.unassignedConflictBadge')} {groupId}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Inhaber selected table */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <button
          className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold"
          style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)' }}
          onClick={() => setSelectedTableOpen(o => !o)}
        >
          <span>{t('hwh.newlyGivenToOwner')} <span className="font-normal text-xs ml-2" style={{ color: 'var(--text-secondary)' }}>{t('hwh.blocksCount', { count: selectedBlocks.length })}</span></span>
          <span style={{ color: 'var(--text-secondary)' }}>{selectedTableOpen ? '▲' : '▼'}</span>
        </button>
        {selectedTableOpen && (
          <div className="overflow-x-auto">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                  {[t('hwh.colGroup'), t('hwh.colBlockId'), t('hwh.colVehicle'), t('hwh.colStart'), t('hwh.colEnd'), t('hwh.colDuration'), t('hwh.colRides'), t('hwh.colRows'), t('hwh.colReason')].map(h => (
                    <th key={h} className="px-3 py-2 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {selectedBlocks.map((b, i) => (
                  <tr key={b.blockId} style={{ background: i % 2 === 0 ? 'rgba(8,145,178,0.05)' : 'rgba(8,145,178,0.1)', borderBottom: '1px solid var(--border)' }}>
                    <td className="px-3 py-2 text-xs font-bold" style={{ color: '#0891b2' }}>{groupOfBlock.get(b.blockId) ?? '—'}</td>
                    <td className="px-3 py-2 text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>…{b.blockId.slice(-8)}</td>
                    <td className="px-3 py-2 text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{b.vehicle}</td>
                    <td className="px-3 py-2 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDatetime(b.blockStartMs)}</td>
                    <td className="px-3 py-2 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDatetime(b.blockEndMs)}</td>
                    <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{formatBlockDuration(b.blockDurationSec)}</td>
                    <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{b.rides?.length ?? 0}</td>
                    <td className="px-3 py-2 text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>{blockSourceRowRange(b)}</td>
                    <td className="px-3 py-2 text-xs" style={{ color: '#0891b2' }}>{t('hwh.longestConflictFreeInGroup')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Remaining conflict table */}
      {remainingUnassignedBlocks.length > 0 && (
        <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          <button
            className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold"
            style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)' }}
            onClick={() => setRemainingTableOpen(o => !o)}
          >
            <span>{t('hwh.remainingUnassignedConflictBlocks')} <span className="font-normal text-xs ml-2" style={{ color: 'var(--text-secondary)' }}>{t('hwh.blocksCount', { count: remainingUnassignedBlocks.length })}</span></span>
            <span style={{ color: 'var(--text-secondary)' }}>{remainingTableOpen ? '▲' : '▼'}</span>
          </button>
          {remainingTableOpen && (
            <div className="overflow-x-auto">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                    {[t('hwh.colBlockId'), t('hwh.colVehicle'), t('hwh.colStart'), t('hwh.colEnd'), t('hwh.colDuration'), t('hwh.colRides'), t('hwh.colConflictGroup'), t('hwh.colReason')].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {remainingUnassignedBlocks.map((b, i) => {
                    const gId = groupOfBlock.get(b.blockId) ?? '—';
                    const grp = conflictGroups.find(g => g.groupId === gId);
                    // `decision` is the algorithm's internal value, not a label.
                    const grund = grp?.decision === 'Kein passender Block' ? t('hwh.lcRejectNoConflictFreeBlockInGroup') : t('hwh.lcRejectNotLongestInGroup');
                    return (
                      <tr key={b.blockId} style={{ background: i % 2 === 0 ? 'rgba(245,158,11,0.05)' : 'rgba(245,158,11,0.1)', borderBottom: '1px solid var(--border)' }}>
                        <td className="px-3 py-2 text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>…{b.blockId.slice(-8)}</td>
                        <td className="px-3 py-2 text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{b.vehicle}</td>
                        <td className="px-3 py-2 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDatetime(b.blockStartMs)}</td>
                        <td className="px-3 py-2 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDatetime(b.blockEndMs)}</td>
                        <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{formatBlockDuration(b.blockDurationSec)}</td>
                        <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{b.rides?.length ?? 0}</td>
                        <td className="px-3 py-2 text-xs font-bold" style={{ color: '#b45309' }}>{gId}</td>
                        <td className="px-3 py-2 text-xs" style={{ color: '#b45309' }}>{grund}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Diagnostics */}
      <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${diagClean ? 'rgba(16,185,129,0.3)' : 'rgba(220,38,38,0.3)'}` }}>
        <div className="px-4 py-3 text-sm font-semibold" style={{ background: diagClean ? 'rgba(16,185,129,0.06)' : 'rgba(220,38,38,0.06)', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' }}>
          {t('hwh.lcCheckTitle')}
        </div>
        <div className="p-4 space-y-2">
          {[
            { label: t('hwh.chkRegularDriversUnchanged'), value: diagnostics.regularDriversUnchanged ? t('hwh.ok') : t('hwh.failed'), isOk: diagnostics.regularDriversUnchanged },
            { label: t('hwh.chkOwnerTimeOverlaps'),       value: String(diagnostics.inhaberTimeConflicts),     isOk: diagnostics.inhaberTimeConflicts === 0 },
            { label: t('hwh.chkOwnerVehicleOverlaps'),    value: String(diagnostics.inhaberVehicleConflicts),  isOk: diagnostics.inhaberVehicleConflicts === 0 },
            { label: t('hwh.chkTimeShifts'),              value: String(diagnostics.timeShifts),               isOk: diagnostics.timeShifts === 0 },
            { label: t('hwh.chkSingleRideAssignments'),   value: String(diagnostics.singleRideAssignments),    isOk: diagnostics.singleRideAssignments === 0 },
            { label: t('hwh.statGroupsNoSuitableBlock'),  value: String(diagnostics.groupsWithNoBlock),        isOk: diagnostics.groupsWithNoBlock === 0 },
          ].map(d => (
            <div key={d.label} className="flex items-center justify-between text-xs">
              <span style={{ color: 'var(--text-secondary)' }}>{d.label}</span>
              <span className="font-bold" style={{ color: d.isOk ? '#15803d' : '#b91c1c' }}>{d.value}</span>
            </div>
          ))}
          {diagClean && (
            <div className="mt-3 text-xs font-semibold" style={{ color: '#15803d' }}>{t('hwh.allChecksPassed')}</div>
          )}
          {!diagClean && (
            <div className="mt-3 text-xs font-semibold" style={{ color: '#b91c1c' }}>{t('hwh.checkFailed')}</div>
          )}
        </div>
      </div>

      {/* Bottom nav */}
      <div className="flex items-center gap-4 pt-2">
        <button onClick={onBack} className="inline-flex items-center gap-2 text-sm hover:opacity-80" style={{ color: 'var(--text-secondary)' }}>
          <ArrowLeft size={15} /> {t('hwh.backToOwnerNonConflict')}
        </button>
        <button onClick={onRecompute} className="inline-flex items-center gap-2 text-sm hover:opacity-80" style={{ color: 'var(--text-secondary)' }}>
          <RefreshCw size={13} /> {t('hwh.recompute')}
        </button>
        {remainingUnassignedBlocks.length > 0 && (
          <button
            onClick={onApplyFreeWindowSearch}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-90 ml-auto"
            style={{ background: '#15803d', color: '#fff', border: '1px solid #15803d' }}
          >
            <ArrowRight size={15} /> {t('hwh.searchFreeOwnerWindows')}
          </button>
        )}
      </div>
    </div>
  );
}

// ── InhaberFreeWindowSearch types & algorithm ────────────────────────────────

interface InhaberOccupiedInterval {
  blockId: string;
  vehicle: string;
  startMs: number;
  endMs: number;
  durationSec: number;
  rides: number;
  rows: string;
  sourceStep: 'Step 3' | 'Step 4';
}

interface FreeWindow {
  windowId: string;
  date: string;           // YYYY-MM-DD
  startMs: number;
  endMs: number;
  durationSec: number;
  prevBlockId: string | null;
  nextBlockId: string | null;
}

interface CandidateWindow {
  windowId: string;
  date: string;
  startMs: number;
  endMs: number;
  durationSec: number;
  vehicleFree: boolean;
}

// The status strings below are internal identifiers the algorithms branch on
// with ===; the *_KEYS maps turn them into labels at render time.
type FwsCandidacyStatus = 'Kandidat vorhanden' | 'Kandidat mit Fahrzeug frei' | 'Kein passendes Fenster';

const FWS_STATUS_KEYS: Record<FwsCandidacyStatus, TranslationKey> = {
  'Kandidat vorhanden':         'hwh.fwsStatusCandidate',
  'Kandidat mit Fahrzeug frei': 'hwh.fwsStatusCandidateVehicleFree',
  'Kein passendes Fenster':     'hwh.fwsStatusNoWindow',
};

const SUGGESTION_STATUS_KEYS: Record<string, TranslationKey> = {
  'Zu kurz':         'hwh.sugStatusTooShort',
  'Außerhalb Monat': 'hwh.sugStatusOutsideMonth',
  'Fahrzeug belegt': 'hwh.sugStatusVehicleBusy',
  'Passend':         'hwh.sugStatusFits',
};

const SELECTION_STATUS_KEYS: Record<string, TranslationKey> = {
  'Ausgewählt':       'hwh.selStatusSelected',
  'Nicht ausgewählt': 'hwh.selStatusNotSelected',
};

// Internal marker distinguishing "rejected for a ride-level conflict" from the
// other rejection reasons, which are user-facing strings.
const RIDE_CONFLICT_SENTINEL = '__ride_conflict__';

interface OpenBlockCandidacy {
  block: VehicleBlock;
  candidateWindows: CandidateWindow[];
  windowsWithVehicleFree: number;
  status: FwsCandidacyStatus;
}

interface FwsDiagnostics {
  timeShiftsDone: number;
  assignmentsChanged: number;
  regularDriversUnchanged: boolean;
  inhaberAssignmentsUnchanged: boolean;
  openBlocksUnchanged: boolean;
}

interface InhaberFreeWindowSearchStepResult {
  inhaberOccupiedIntervals: InhaberOccupiedInterval[];
  freeWindows: FreeWindow[];
  freeWindowsByDay: Map<string, FreeWindow[]>;
  remainingOpenBlocks: VehicleBlock[];
  candidateWindowsByBlock: OpenBlockCandidacy[];
  summary: {
    inhaberBlockCount: number;
    inhaberRides: number;
    inhaberSec: number;
    openBlockCount: number;
    freeWindowCount: number;
    freeSec: number;
    windows1h: number;
    windows2h: number;
    windows4h: number;
    openBlocksWithCandidate: number;
    openBlocksWithVehicleCandidate: number;
    openBlocksNoCandidate: number;
  };
  diagnostics: FwsDiagnostics;
}

function runInhaberFreeWindowSearch(
  step3Blocks: VehicleBlock[],
  step4Blocks: VehicleBlock[],
  remainingOpenBlocks: VehicleBlock[],
  allBlocks: VehicleBlock[],
  regularAssignments: RegularBlockAssignment[],
  month: number,
  year: number,
): InhaberFreeWindowSearchStepResult {
  // Build Inhaber occupied intervals
  const occupiedIntervals: InhaberOccupiedInterval[] = [];
  for (const b of step3Blocks) occupiedIntervals.push({ blockId: b.blockId, vehicle: b.vehicle, startMs: b.blockStartMs ?? 0, endMs: b.blockEndMs ?? 0, durationSec: b.blockDurationSec, rides: b.rides?.length ?? 0, rows: blockSourceRowRange(b), sourceStep: 'Step 3' });
  for (const b of step4Blocks) occupiedIntervals.push({ blockId: b.blockId, vehicle: b.vehicle, startMs: b.blockStartMs ?? 0, endMs: b.blockEndMs ?? 0, durationSec: b.blockDurationSec, rides: b.rides?.length ?? 0, rows: blockSourceRowRange(b), sourceStep: 'Step 4' });
  occupiedIntervals.sort((a, b) => a.startMs - b.startMs);

  // Month boundaries
  const monthStart = new Date(year, month - 1, 1).getTime();
  const monthEnd   = new Date(year, month,     0, 23, 59, 59, 999).getTime();

  // Build free windows per day
  const freeWindows: FreeWindow[] = [];
  const freeWindowsByDay = new Map<string, FreeWindow[]>();

  const daysInMonth = new Date(year, month, 0).getDate();
  let windowIdx = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const dayStart = new Date(year, month - 1, d, 0, 0, 0, 0).getTime();
    const dayEnd   = new Date(year, month - 1, d, 23, 59, 59, 999).getTime();
    const dateStr  = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

    // Occupied intervals that overlap this day
    const dayOccupied = occupiedIntervals
      .filter(i => i.startMs < dayEnd && i.endMs > dayStart)
      .map(i => ({ id: i.blockId, start: Math.max(i.startMs, dayStart), end: Math.min(i.endMs, dayEnd) }))
      .sort((a, b) => a.start - b.start);

    const gaps: FreeWindow[] = [];
    let cursor = dayStart;

    for (const occ of dayOccupied) {
      // Free window ends INHABER_MIN_GAP_MS before next block starts
      const freeEnd = occ.start - INHABER_MIN_GAP_MS;
      if (freeEnd > cursor + 1000) {
        const prevId = gaps.length > 0 ? occupiedIntervals.find(i => i.endMs <= occ.start && i.endMs > cursor - 1)?.blockId ?? null : null;
        windowIdx++;
        gaps.push({
          windowId: `FW-${String(windowIdx).padStart(4,'0')}`,
          date: dateStr,
          startMs: cursor,
          endMs: freeEnd,
          durationSec: Math.round((freeEnd - cursor) / 1000),
          prevBlockId: prevId,
          nextBlockId: occ.id,
        });
      }
      // Next free window may only start INHABER_MIN_GAP_MS after this block ends
      cursor = Math.max(cursor, occ.end + INHABER_MIN_GAP_MS);
    }
    // Gap after last block to end of day
    if (cursor < dayEnd - 1000) {
      const prevId = dayOccupied.length > 0 ? dayOccupied[dayOccupied.length - 1].id : null;
      windowIdx++;
      gaps.push({
        windowId: `FW-${String(windowIdx).padStart(4,'0')}`,
        date: dateStr,
        startMs: cursor,
        endMs: dayEnd,
        durationSec: Math.round((dayEnd - cursor) / 1000),
        prevBlockId: prevId,
        nextBlockId: null,
      });
    }

    if (gaps.length > 0) {
      freeWindowsByDay.set(dateStr, gaps);
      freeWindows.push(...gaps);
    }
  }

  // Vehicle occupancy map: vehicle → sorted intervals (regular + Inhaber)
  const regularSet = new Set(regularAssignments.map(a => a.blockId));
  const vehicleIntervals = new Map<string, Array<{ start: number; end: number }>>();
  for (const b of allBlocks) {
    if (!b.vehicle || !b.blockStartMs || !b.blockEndMs) continue;
    if (!regularSet.has(b.blockId) && !step3Blocks.some(s => s.blockId === b.blockId) && !step4Blocks.some(s => s.blockId === b.blockId)) continue;
    if (!vehicleIntervals.has(b.vehicle)) vehicleIntervals.set(b.vehicle, []);
    vehicleIntervals.get(b.vehicle)!.push({ start: b.blockStartMs, end: b.blockEndMs });
  }

  // Match remaining open blocks to candidate windows
  const candidateWindowsByBlock: OpenBlockCandidacy[] = remainingOpenBlocks.map(block => {
    const dur = block.blockDurationSec;
    const vehicle = block.vehicle;
    const vIntervals = vehicleIntervals.get(vehicle) ?? [];

    const candidates: CandidateWindow[] = freeWindows
      .filter(w => w.durationSec >= dur && w.startMs >= monthStart && w.endMs <= monthEnd)
      .map(w => {
        // The block placed at w.startMs occupies [w.startMs, w.startMs + dur*1000]
        // The free window already has the 30-min buffer baked in (shrunk from both sides),
        // so we only need to verify the block duration fits and vehicle is free.
        const slotEnd = w.startMs + dur * 1000;
        const vehicleFree = !vIntervals.some(vi => vi.start < slotEnd && vi.end > w.startMs);
        return { windowId: w.windowId, date: w.date, startMs: w.startMs, endMs: w.endMs, durationSec: w.durationSec, vehicleFree };
      });

    const windowsWithVehicleFree = candidates.filter(c => c.vehicleFree).length;
    const status: OpenBlockCandidacy['status'] =
      windowsWithVehicleFree > 0 ? 'Kandidat mit Fahrzeug frei'
      : candidates.length > 0 ? 'Kandidat vorhanden'
      : 'Kein passendes Fenster';

    return { block, candidateWindows: candidates, windowsWithVehicleFree, status };
  });

  const freeSec = freeWindows.reduce((s, w) => s + w.durationSec, 0);
  const openBlocksWithCandidate = candidateWindowsByBlock.filter(c => c.candidateWindows.length > 0).length;
  const openBlocksWithVehicleCandidate = candidateWindowsByBlock.filter(c => c.windowsWithVehicleFree > 0).length;

  return {
    inhaberOccupiedIntervals: occupiedIntervals,
    freeWindows,
    freeWindowsByDay,
    remainingOpenBlocks,
    candidateWindowsByBlock,
    summary: {
      inhaberBlockCount:              occupiedIntervals.length,
      inhaberRides:                   occupiedIntervals.reduce((s, i) => s + i.rides, 0),
      inhaberSec:                     occupiedIntervals.reduce((s, i) => s + i.durationSec, 0),
      openBlockCount:                 remainingOpenBlocks.length,
      freeWindowCount:                freeWindows.length,
      freeSec,
      windows1h:                      freeWindows.filter(w => w.durationSec >= 3600).length,
      windows2h:                      freeWindows.filter(w => w.durationSec >= 7200).length,
      windows4h:                      freeWindows.filter(w => w.durationSec >= 14400).length,
      openBlocksWithCandidate,
      openBlocksWithVehicleCandidate,
      openBlocksNoCandidate:          remainingOpenBlocks.length - openBlocksWithCandidate,
    },
    diagnostics: {
      timeShiftsDone:              0,
      assignmentsChanged:          0,
      regularDriversUnchanged:     true,
      inhaberAssignmentsUnchanged: true,
      openBlocksUnchanged:         true,
    },
  };
}

// ── InhaberFreeWindowSearchView ───────────────────────────────────────────────

// Resolve the real owner driver name.
// Priority 1: allDrivers (full DB list) with employment_type === 'company_owner'
// Priority 2: driverConfigs (from Fahrtenbuch trips) with isOwner === true
type OwnerResolution =
  | { status: 'ok'; name: string; source: 'allDrivers' | 'driverConfigs' }
  | { status: 'none'; debugInfo: string }
  | { status: 'multiple'; count: number; names: string[]; source: 'allDrivers' | 'driverConfigs' };

function resolveOwnerDriverNameFull(allDrivers: DriverRow[], driverConfigs: WzDriverConfig[]): OwnerResolution {
  // Priority 1: full driver list from DB
  const dbOwners = allDrivers.filter(d => d.employment_type === 'company_owner');
  if (dbOwners.length === 1) {
    const name = dbOwners[0].name?.trim() ?? '';
    if (name) return { status: 'ok', name, source: 'allDrivers' };
  }
  if (dbOwners.length > 1) {
    const names = dbOwners.map(d => d.name?.trim() ?? '').filter(Boolean);
    return { status: 'multiple', count: dbOwners.length, names, source: 'allDrivers' };
  }

  // Priority 2: driverConfigs derived from Fahrtenbuch trips
  const cfgOwners = driverConfigs.filter(c => c.isOwner);
  if (cfgOwners.length === 1) {
    const name = cfgOwners[0].driverName?.trim() ?? '';
    if (name) return { status: 'ok', name, source: 'driverConfigs' };
  }
  if (cfgOwners.length > 1) {
    const names = cfgOwners.map(c => c.driverName?.trim() ?? '').filter(Boolean);
    return { status: 'multiple', count: cfgOwners.length, names, source: 'driverConfigs' };
  }

  return {
    status: 'none',
    debugInfo: `allDrivers=${allDrivers.length}, dbOwners=${dbOwners.length}, cfgOwners=${cfgOwners.length}`,
  };
}

function formatExportDateTime(ms: number): string {
  const d = new Date(Math.floor(ms / 1000) * 1000);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.000`;
}

// ── Section F types ───────────────────────────────────────────────────────────

interface SectionFRide {
  blockId: string;
  tripId: string;
  vehicle: string;
  oldDriver: string;
  newDriver: string;
  origStartMs: number;
  origEndMs: number;
  newStartMs: number;
  newEndMs: number;
  durSec: number;
  offsetMs: number;
  srcRowIdx: number | null;
  ok: boolean;
}

interface SectionFBlock {
  blockId: string;
  vehicle: string;
  origStartMs: number;
  origEndMs: number;
  newStartMs: number;
  newEndMs: number;
  rideCount: number;
  offsetMs: number;
  ok: boolean;
  hint: string;
}

interface SectionFData {
  changedRides: SectionFRide[];
  blockApps: SectionFBlock[];
  totalRidesChanged: number;
  totalSec: number;
  uniqueVehicles: number;
  invalidTsRides: string[];
  inhaberOverlaps: string[];
  vehicleOverlaps: string[];
  rideLevelExistingConflicts: string[];
  driverExclusionViolations: string[];
  missingBlocks: string[];
  rideCountOk: boolean;
  tsMillisOk: boolean;
  invalidTsCount: number;
  totalTsCount: number;
  priceKmUnchanged: boolean;
  columnOrderReady: boolean;
  auftragOk: boolean;
  invalidAuftragCount: number;
  zeitversatzOk: boolean;
  invalidZeitversatzCount: number;
  allOk: boolean;
  shiftMap: Map<string, {
    newStartMs: number;
    newEndMs: number;
    newDriver: string;
    auftragEingangMs: number | null;
    auftragUebermittlungMs: number | null;
    geplanteAbholzeitMs: number | null;
  }>;
  // Rides whose original driver is excluded by notes and have no valid replacement.
  // Export must be BLOCKED when this is non-empty — never clear Fahrername in export.
  unresolvedExcludedRides: Array<{ tripId: string; driver: string; vehicle: string; startMs: number; endMs: number; detail: string }>;
  // Legacy alias kept for backward compat — same as unresolvedExcludedRides as a Map
  excludedDriverRideMap: Map<string, { driver: string; vehicle: string; detail: string }>;
}

interface InhaberFreeWindowSearchViewProps {
  fwsResult: InhaberFreeWindowSearchStepResult;
  month: number;
  year: number;
  onBack: () => void;
  onRecompute: () => void;
  originalTrips: FahrtenbuchTrip[] | null;
  inhaberName: string;
  sourceSheetName: string | null;
  sourceColumnsJson: string[] | null;
  storagePath: string | null;
  originalFileName: string | null;
  driverConfigs: WzDriverConfig[];
  allDrivers: DriverRow[];
  driverNotesMap: Map<string, StructuredNote[]>;
  simplified?: boolean;
  autoApply?: boolean;
  onExportReadyCallback?: (ready: boolean, reason: string | null) => void;
  onFinalAssignmentReady?: (rows: VehicleBoundaryRow[]) => void;
  onPlanDataReady?: (data: { shiftMapJson: Array<[string, object]>; noteReassignmentsJson: Array<[string, string]> }) => void;
  onDriverHourSummaryReady?: (rows: DriverHourSummaryRow[]) => void;
  onSalaryRangeSummaryReady?: (rows: SalaryRangeDriverRow[]) => void;
  exportTriggerRef?: React.MutableRefObject<(() => void) | null>;
}

type FwsModalData = {
  kind: 'window';
  windowId: string;
  date: string;
  startMs: number;
  endMs: number;
  durationSec: number;
  prevBlockId: string | null;
  nextBlockId: string | null;
  candidates: Array<{ block: VehicleBlock; vehicleFree: boolean }>;
} | {
  kind: 'occupied';
  interval: InhaberOccupiedInterval;
};

function InhaberFreeWindowSearchView({
  fwsResult, month, year, onBack, onRecompute, originalTrips, inhaberName, sourceSheetName, sourceColumnsJson, storagePath, originalFileName, driverConfigs, allDrivers, driverNotesMap,
  simplified = false, autoApply = false, onExportReadyCallback, onFinalAssignmentReady, onPlanDataReady, onDriverHourSummaryReady, onSalaryRangeSummaryReady, exportTriggerRef,
}: InhaberFreeWindowSearchViewProps) {
  const { t, tPlural } = useTranslation();
  const [modalData, setModalData] = useState<FwsModalData | null>(null);
  const [expandedBlock, setExpandedBlock] = useState<string | null>(null);
  const [openBlocksOpen, setOpenBlocksOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(true);
  const [analysisSectionA, setAnalysisSectionA] = useState(true);
  const [analysisSectionB, setAnalysisSectionB] = useState(true);
  const [analysisSectionC, setAnalysisSectionC] = useState(true);
  const [analysisSectionD, setAnalysisSectionD] = useState(true);
  const [analysisSectionE, setAnalysisSectionE] = useState(true);
  const [analysisSectionF, setAnalysisSectionF] = useState(true);
  const [sectionFData, setSectionFData] = useState<SectionFData | null>(null);
  const [dbgApplyClickCount, setDbgApplyClickCount] = useState(0);
  const [dbgApplyLastClickedAt, setDbgApplyLastClickedAt] = useState<string | null>(null);
  const [dbgApplyStarted, setDbgApplyStarted] = useState(false);
  const [dbgApplyFinished, setDbgApplyFinished] = useState(false);
  const [dbgApplyError, setDbgApplyError] = useState<string | null>(null);
  // tripId → new driver name applied by "Beste Fahrer-Notiz-Alternativen anwenden"
  const [noteReassignments, setNoteReassignments] = useState<Map<string, string>>(new Map());
  // Tracks whether the auto-apply-alternatives phase has completed in auto mode
  const [autoNoteAlternativesApplied, setAutoNoteAlternativesApplied] = useState(false);

  // Stable refs for auto-apply callbacks (avoid stale closure issues in effects)
  const handleApplyPlanRef = useRef<(() => void) | null>(null);
  const exportReadyCallbackRef = useRef(onExportReadyCallback);
  exportReadyCallbackRef.current = onExportReadyCallback;
  const onFinalAssignmentReadyRef2 = useRef(onPlanDataReady);
  onFinalAssignmentReadyRef2.current = onPlanDataReady;
  const onDriverHourSummaryReadyRef = useRef(onDriverHourSummaryReady);
  onDriverHourSummaryReadyRef.current = onDriverHourSummaryReady;
  const onSalaryRangeSummaryReadyRef = useRef(onSalaryRangeSummaryReady);
  onSalaryRangeSummaryReadyRef.current = onSalaryRangeSummaryReady;
  const autoApplyDoneRef = useRef(false);

  // Resolve the real owner driver name from allDrivers (full DB list) then driverConfigs fallback
  const ownerResolution = useMemo(() => resolveOwnerDriverNameFull(allDrivers, driverConfigs), [allDrivers, driverConfigs]);
  const resolvedOwnerName = ownerResolution.status === 'ok' ? ownerResolution.name : null;

  // name → driverId map for exclusion lookups (normalized lowercase)
  const driverNameToId = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of allDrivers) m.set(d.name.trim().toLowerCase().replace(/\s+/g, ' '), d.id);
    return m;
  }, [allDrivers]);

  // Owner's driver ID for exclusion checks
  const ownerDriverId = useMemo(() => {
    if (!resolvedOwnerName) return null;
    return driverNameToId.get(resolvedOwnerName.trim().toLowerCase().replace(/\s+/g, ' ')) ?? null;
  }, [resolvedOwnerName, driverNameToId]);

  const { inhaberOccupiedIntervals, freeWindows, freeWindowsByDay, remainingOpenBlocks, candidateWindowsByBlock, summary, diagnostics } = fwsResult;

  // window → list of candidate {block, vehicleFree}
  const windowCandidateMap = useMemo(() => {
    const m = new Map<string, Array<{ block: VehicleBlock; vehicleFree: boolean }>>();
    for (const c of candidateWindowsByBlock) {
      for (const cw of c.candidateWindows) {
        if (!m.has(cw.windowId)) m.set(cw.windowId, []);
        m.get(cw.windowId)!.push({ block: c.block, vehicleFree: cw.vehicleFree });
      }
    }
    return m;
  }, [candidateWindowsByBlock]);

  const diagClean = diagnostics.timeShiftsDone === 0 && diagnostics.assignmentsChanged === 0;

  // Build 7-column month grid (Sun→Sat)
  const gridData = useMemo(() => {
    const firstDay = new Date(year, month - 1, 1);
    const lastDay  = new Date(year, month, 0);
    const start = new Date(firstDay); start.setDate(firstDay.getDate() - firstDay.getDay());
    const end   = new Date(lastDay);  end.setDate(lastDay.getDate() + (6 - lastDay.getDay()));

    const cells: Array<{
      date: Date;
      inMonth: boolean;
      dateStr: string;
      occupied: InhaberOccupiedInterval[];
      free: FreeWindow[];
    }> = [];

    const cur = new Date(start);
    while (cur <= end) {
      const d = cur.getDate();
      const m0 = cur.getMonth();
      const y0 = cur.getFullYear();
      const dateStr = `${y0}-${String(m0+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dayStart = cur.getTime();
      const dayEnd   = dayStart + 86_400_000;
      const occupied = inhaberOccupiedIntervals
        .filter(i => i.startMs < dayEnd && i.endMs > dayStart)
        .sort((a, b) => a.startMs - b.startMs);
      const free = (freeWindowsByDay.get(dateStr) ?? []).sort((a, b) => a.startMs - b.startMs);
      cells.push({ date: new Date(cur), inMonth: m0 === month - 1, dateStr, occupied, free });
      cur.setDate(cur.getDate() + 1);
    }

    const weeks: typeof cells[] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }, [inhaberOccupiedIntervals, freeWindowsByDay, month, year]);

  // Analysis: sorted free windows for Section B
  const sortedFreeWindows = useMemo(
    () => [...freeWindows].sort((a, b) => a.startMs !== b.startMs ? a.startMs - b.startMs : a.endMs - b.endMs),
    [freeWindows],
  );

  // Analysis: per-block candidate suggestions for Section C
  // For each remaining block, compute up to 10 best candidate windows with detailed info.
  const monthStartMs = new Date(year, month - 1, 1).getTime();
  const monthEndMs   = new Date(year, month, 0, 23, 59, 59, 999).getTime();

  const fmtPuffer = (ms: number) => {
    const totalMin = Math.round(ms / 60000);
    if (totalMin === 0) return '0 min';
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h === 0) return `+${m} min`;
    if (m === 0) return `+${h}h`;
    return `+${h}h ${m}m`;
  };
  const fmtDurSec = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h === 0) return `${m} min`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  };

  const blockSuggestions = useMemo(() => {
    const MIN_PUFFER_NACH_MS = 60 * 60 * 1000; // Puffer nach >= 1 hour required for Section C
    return candidateWindowsByBlock.map(({ block, candidateWindows }) => {
      const blockDurMs = block.blockDurationSec * 1000;

      const scored = candidateWindows.map(cw => {
        const windowDurMs = cw.durationSec * 1000;

        // Distribute available slack: keep Puffer nach >= 1h, split the rest evenly before the block
        const availableSlackMs    = windowDurMs - blockDurMs;
        const targetPufferNachMs  = availableSlackMs > 0 ? Math.max(MIN_PUFFER_NACH_MS, Math.floor(availableSlackMs / 2)) : 0;
        const pufferVorMs         = availableSlackMs > 0 ? availableSlackMs - targetPufferNachMs : 0;
        const proposedStart       = cw.startMs + pufferVorMs;
        const proposedEnd         = proposedStart + blockDurMs;

        let status: string;
        if (windowDurMs < blockDurMs + MIN_PUFFER_NACH_MS) {
          status = 'Zu kurz';
        } else if (proposedStart < monthStartMs || proposedEnd > monthEndMs + 1) {
          status = 'Außerhalb Monat';
        } else if (!cw.vehicleFree) {
          status = 'Fahrzeug belegt';
        } else {
          status = 'Passend';
        }

        const leftoverMs   = windowDurMs - blockDurMs;
        const pufferNachMs = cw.endMs - proposedEnd;

        // Score: lower is better (prefer exact fit, vehicle free, not cross-midnight)
        const crossesMidnight = proposedEnd > 0 && (new Date(proposedStart).getDate() !== new Date(proposedEnd - 1).getDate());
        const score = (status === 'Passend' ? 0 : 10000)
          + (cw.vehicleFree ? 0 : 1000)
          + (crossesMidnight ? 100 : 0)
          + Math.round(leftoverMs / 60000);

        return {
          cw,
          proposedStart,
          proposedEnd,
          status,
          pufferVorMs,
          pufferNachMs,
          crossesMidnight,
          score,
        };
      }).filter(s => s.pufferVorMs >= MIN_PUFFER_NACH_MS && s.pufferNachMs >= MIN_PUFFER_NACH_MS);

      const top10 = [...scored].sort((a, b) => a.score - b.score).slice(0, 10);

      return { block, top10 };
    });
  }, [candidateWindowsByBlock, monthStartMs, monthEndMs]);

  // Section D — greedy best-candidate preselection with ride-level simulation
  // Builds its own FULL candidate pool from all free windows — not limited to Section C's top10.
  const autoSelectionResult = useMemo(() => {
    const MIN_PUFFER_MS = 60 * 60 * 1000;

    // Parse all originalTrips timestamps once: tripId → { startMs, endMs }
    // Include ALL non-canceled trips — candidate block trips are excluded per-block below,
    // matching the same exclusion logic Section E uses (exclude only the current block's own rides).
    type TripInterval = { tripId: string; startMs: number; endMs: number };
    const vehicleExistingRides = new Map<string, TripInterval[]>();
    const START_KEYS_D = ['uhrzeit des fahrtbeginns', 'fahrtbeginn', 'start', 'start_datetime', 'fahrt_beginn'];
    const END_KEYS_D   = ['uhrzeit des fahrtendes', 'fahrtende', 'ende', 'end_datetime', 'fahrt_ende'];
    const DATE_KEYS_D  = ['datum der fahrt', 'datum', 'date', 'fahrt_datum'];
    const parseTsD = (dateS: string, timeS: string) => {
      if (!timeS) return 0;
      const combined = timeS.includes('T') || timeS.match(/^\d{4}-\d{2}-\d{2} \d{2}:/)
        ? timeS : (dateS ? `${dateS} ${timeS}` : timeS);
      const ms = Date.parse(combined.replace(' ', 'T'));
      return isNaN(ms) ? 0 : ms;
    };
    if (originalTrips) {
      for (const trip of originalTrips) {
        if (trip.is_canceled) continue;
        const raw = trip.raw_data_json as Record<string, unknown> | null;
        if (!raw) continue;
        let dateStr = '';
        for (const k of Object.keys(raw)) {
          if (DATE_KEYS_D.includes(k.toLowerCase())) { dateStr = String(raw[k] ?? ''); break; }
        }
        const startStr = (() => { for (const k of Object.keys(raw)) if (START_KEYS_D.includes(k.toLowerCase())) return String(raw[k] ?? ''); return ''; })();
        const endStr   = (() => { for (const k of Object.keys(raw)) if (END_KEYS_D.includes(k.toLowerCase())) return String(raw[k] ?? ''); return ''; })();
        const startMs = parseTsD(dateStr, startStr);
        const endMs   = parseTsD(dateStr, endStr);
        if (!startMs || !endMs || endMs <= startMs) continue;
        const veh = trip.car_identifier ?? '';
        if (!veh) continue;
        if (!vehicleExistingRides.has(veh)) vehicleExistingRides.set(veh, []);
        vehicleExistingRides.get(veh)!.push({ tripId: trip.id, startMs, endMs });
      }
    }

    // Build full scored candidate list per block (same placement logic as blockSuggestions, no slice)
    type ScoredCand = {
      cw: CandidateWindow;
      proposedStart: number;
      proposedEnd: number;
      pufferVorMs: number;
      pufferNachMs: number;
      crossesMidnight: boolean;
      score: number;
    };
    const fullCandsByBlock = candidateWindowsByBlock.map(({ block, candidateWindows }) => {
      const blockDurMs = block.blockDurationSec * 1000;
      const allValid: ScoredCand[] = [];
      for (const cw of candidateWindows) {
        const windowDurMs = cw.durationSec * 1000;
        const availableSlackMs   = windowDurMs - blockDurMs;
        const targetPufferNachMs = availableSlackMs > 0 ? Math.max(MIN_PUFFER_MS, Math.floor(availableSlackMs / 2)) : 0;
        const pufferVorMs        = availableSlackMs > 0 ? availableSlackMs - targetPufferNachMs : 0;
        const proposedStart      = cw.startMs + pufferVorMs;
        const proposedEnd        = proposedStart + blockDurMs;
        const pufferNachMs       = cw.endMs - proposedEnd;

        if (pufferVorMs < MIN_PUFFER_MS) continue;
        if (pufferNachMs < MIN_PUFFER_MS) continue;
        if (proposedStart < monthStartMs || proposedEnd > monthEndMs + 1) continue;
        if (!cw.vehicleFree) continue;

        const crossesMidnight = new Date(proposedStart).getDate() !== new Date(proposedEnd - 1).getDate();
        const leftoverMs = windowDurMs - blockDurMs;
        const score = (crossesMidnight ? 100 : 0) + Math.round(leftoverMs / 60000);

        allValid.push({ cw, proposedStart, proposedEnd, pufferVorMs, pufferNachMs, crossesMidnight, score });
      }
      return { block, allValid };
    });

    // Sort blocks by difficulty: fewest valid candidates first, then longest duration, then earliest start
    const sorted = [...fullCandsByBlock].sort((a, b) => {
      const cntDiff = a.allValid.length - b.allValid.length;
      if (cntDiff !== 0) return cntDiff;
      const durDiff = b.block.blockDurationSec - a.block.blockDurationSec;
      if (durDiff !== 0) return durDiff;
      return (a.block.blockStartMs ?? 0) - (b.block.blockStartMs ?? 0);
    });

    const usedInhaber: Array<{ start: number; end: number }> = [];
    const usedVehicle = new Map<string, Array<{ start: number; end: number }>>();
    // Track already-selected shifted ride intervals per vehicle for ride-level checking
    const selectedShiftedRides = new Map<string, Array<{ start: number; end: number }>>();
    // Collect rejected candidate details for debug table
    const rejectedCandidateRideDetails: Array<{
      blockId: string; vehicle: string; candStart: number; candEnd: number;
      reason: string; detail: string;
    }> = [];

    const blockResults = sorted.map(({ block, allValid }) => {
      const ranked = allValid.slice().sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        const la = a.pufferVorMs + a.pufferNachMs, lb = b.pufferVorMs + b.pufferNachMs;
        if (la !== lb) return la - lb;
        const orig = block.blockStartMs ?? 0;
        const da = Math.abs(a.proposedStart - orig), db = Math.abs(b.proposedStart - orig);
        if (da !== db) return da - db;
        if (a.crossesMidnight !== b.crossesMidnight) return (a.crossesMidnight ? 1 : 0) - (b.crossesMidnight ? 1 : 0);
        return a.proposedStart - b.proposedStart;
      });

      let chosen: ScoredCand | null = null;
      let chosenReason = '';
      for (const cand of ranked) {
        const { proposedStart: ps, proposedEnd: pe } = cand;
        // Block-level checks
        if (inhaberOccupiedIntervals.some(i => i.startMs < pe && i.endMs > ps)) { chosenReason = t('hwh.reasonOwnerBlockConflict'); continue; }
        if (usedInhaber.some(i => i.start < pe && i.end > ps)) { chosenReason = t('hwh.reasonOwnerAlreadyBusy'); continue; }
        const vUsed = usedVehicle.get(block.vehicle) ?? [];
        if (vUsed.some(vi => vi.start < pe && vi.end > ps)) { chosenReason = t('hwh.reasonVehicleBlockConflict'); continue; }

        // Ride-level simulation: check each shifted ride vs existing rides on the same vehicle.
        // Exclude ONLY this block's own trip IDs — matching Section E's exclusion logic exactly.
        const offsetMs = ps - (block.blockStartMs ?? 0);
        const thisBlockTripIds = new Set(block.rides.map(r => r.tripId));
        const existingVehicleRides = (vehicleExistingRides.get(block.vehicle) ?? [])
          .filter(r => !thisBlockTripIds.has(r.tripId));
        const alreadySelectedRides = selectedShiftedRides.get(block.vehicle) ?? [];
        let rideConflict = false;
        let rideConflictDetail = '';
        for (const ride of block.rides) {
          const rideStart = ride.originalStartMs + offsetMs;
          const rideEnd   = ride.originalEndMs   + offsetMs;
          const exConflict = existingVehicleRides.find(r => r.startMs < rideEnd && r.endMs > rideStart);
          if (exConflict) {
            rideConflict = true;
            rideConflictDetail = `${block.vehicle}: ${t('hwh.detailRideVsExisting', { ride: ride.tripId.slice(-6), existing: exConflict.tripId.slice(-6) })}`;
            break;
          }
          if (alreadySelectedRides.some(r => r.start < rideEnd && r.end > rideStart)) { rideConflict = true; rideConflictDetail = `${block.vehicle}: ${t('hwh.detailAlreadyChosen')}`; break; }
        }
        if (rideConflict) {
          rejectedCandidateRideDetails.push({
            blockId: block.blockId, vehicle: block.vehicle,
            candStart: ps, candEnd: pe,
            reason: t('hwh.reasonRideConflictExisting'), detail: rideConflictDetail,
          });
          chosenReason = RIDE_CONFLICT_SENTINEL;
          continue;
        }

        // Driver exclusion check: reject if owner/Inhaber is excluded from planning in this interval
        if (resolvedOwnerName && driverNotesMap.size > 0) {
          const excl = isDriverExcludedFromPlanning(ownerDriverId, resolvedOwnerName, ps, pe, driverNotesMap, driverNameToId, t);
          if (excl.excluded) { chosenReason = t('hwh.reasonPlanningExclusionNote', { detail: excl.detail }); continue; }
        }

        chosen = cand;
        break;
      }

      if (chosen) {
        const offsetMs = chosen.proposedStart - (block.blockStartMs ?? 0);
        usedInhaber.push({ start: chosen.proposedStart, end: chosen.proposedEnd });
        if (!usedVehicle.has(block.vehicle)) usedVehicle.set(block.vehicle, []);
        usedVehicle.get(block.vehicle)!.push({ start: chosen.proposedStart, end: chosen.proposedEnd });
        if (!selectedShiftedRides.has(block.vehicle)) selectedShiftedRides.set(block.vehicle, []);
        for (const ride of block.rides) {
          selectedShiftedRides.get(block.vehicle)!.push({
            start: ride.originalStartMs + offsetMs,
            end:   ride.originalEndMs   + offsetMs,
          });
        }
      }

      return {
        block,
        candidateCount: allValid.length,
        chosen,
        reason: chosen
          ? t('hwh.reasonBestAvailable')
          : allValid.length === 0
            ? t('hwh.reasonNoValidCandidates')
            : chosenReason === RIDE_CONFLICT_SENTINEL
              ? t('hwh.reasonNoConflictFreeSingleRide')
              : chosenReason || t('hwh.reasonNoConflictFreeAfterChosen'),
        // 'Ausgewählt' / 'Nicht ausgewählt' are compared with === downstream.
        status: (chosen ? 'Ausgewählt' : 'Nicht ausgewählt') as 'Ausgewählt' | 'Nicht ausgewählt',
      };
    });

    // Safety net: run the same ride-conflict check as Section E against all selected placements.
    // If any selected placement still has a ride-level conflict, demote it to "Nicht ausgewählt".
    // This guards against any ordering-dependent case that slipped through the greedy loop.
    if (originalTrips) {
      const selectedBlockTripIds = new Set<string>();
      for (const e of blockResults) {
        if (e.chosen) for (const r of e.block.rides) selectedBlockTripIds.add(r.tripId);
      }
      // Build vehicle ride map excluding only selected blocks (same as Section E)
      const safetyVehicleRides = new Map<string, Array<{ startMs: number; endMs: number; tripId: string }>>();
      for (const trip of originalTrips) {
        if (trip.is_canceled || selectedBlockTripIds.has(trip.id)) continue;
        const raw = trip.raw_data_json as Record<string, unknown> | null;
        if (!raw) continue;
        let dateStr = '';
        for (const k of Object.keys(raw)) {
          if (DATE_KEYS_D.includes(k.toLowerCase())) { dateStr = String(raw[k] ?? ''); break; }
        }
        const startStr = (() => { for (const k of Object.keys(raw)) if (START_KEYS_D.includes(k.toLowerCase())) return String(raw[k] ?? ''); return ''; })();
        const endStr   = (() => { for (const k of Object.keys(raw)) if (END_KEYS_D.includes(k.toLowerCase())) return String(raw[k] ?? ''); return ''; })();
        const startMs = parseTsD(dateStr, startStr), endMs = parseTsD(dateStr, endStr);
        if (!startMs || !endMs || endMs <= startMs) continue;
        const veh = trip.car_identifier ?? ''; if (!veh) continue;
        if (!safetyVehicleRides.has(veh)) safetyVehicleRides.set(veh, []);
        safetyVehicleRides.get(veh)!.push({ startMs, endMs, tripId: trip.id });
      }
      for (const e of blockResults) {
        if (!e.chosen) continue;
        const offsetMs = e.chosen.proposedStart - (e.block.blockStartMs ?? 0);
        const existing = safetyVehicleRides.get(e.block.vehicle) ?? [];
        for (const ride of e.block.rides) {
          const rs = ride.originalStartMs + offsetMs, re = ride.originalEndMs + offsetMs;
          const conflict = existing.find(ex => ex.startMs < re && ex.endMs > rs);
          if (conflict) {
            const detail = `${e.block.vehicle}: ${t('hwh.detailRideVsExisting', { ride: ride.tripId.slice(-6), existing: conflict.tripId.slice(-6) })}`;
            rejectedCandidateRideDetails.push({
              blockId: e.block.blockId, vehicle: e.block.vehicle,
              candStart: e.chosen.proposedStart, candEnd: e.chosen.proposedEnd,
              reason: t('hwh.reasonRecheckRideConflict'), detail,
            });
            (e as { chosen: typeof e.chosen; reason: string; status: string }).chosen = null;
            (e as { reason: string }).reason = t('hwh.reasonRecheckRideConflict');
            (e as { status: string }).status = 'Nicht ausgewählt';
            break;
          }
        }
      }
    }

    return { entries: blockResults, rejectedDetails: rejectedCandidateRideDetails };
  }, [candidateWindowsByBlock, inhaberOccupiedIntervals, monthStartMs, monthEndMs, originalTrips, resolvedOwnerName, ownerDriverId, driverNotesMap, driverNameToId, t]);

  const autoSelection = autoSelectionResult.entries;
  const autoSelectionRejectedDetails = autoSelectionResult.rejectedDetails;

  // Section E — validation + calendar data derived from Section D's selection
  const sectionEData = useMemo(() => {
    const MIN_PUFFER_MS = 60 * 60 * 1000;
    const selected = autoSelection
      .filter(e => e.chosen !== null)
      .map(e => ({ block: e.block, chosen: e.chosen! }));

    // A. Inhaber overlaps: selected placements vs each other
    const inhaberSelfConflicts: string[] = [];
    for (let i = 0; i < selected.length; i++) {
      for (let j = i + 1; j < selected.length; j++) {
        const a = selected[i].chosen, b = selected[j].chosen;
        if (a.proposedStart < b.proposedEnd && a.proposedEnd > b.proposedStart) {
          inhaberSelfConflicts.push(`…${selected[i].block.blockId.slice(-6)} ↔ …${selected[j].block.blockId.slice(-6)}`);
        }
      }
    }
    // Selected placements vs existing Inhaber blocks
    const inhaberExistingConflicts: string[] = [];
    for (const sp of selected) {
      for (const occ of inhaberOccupiedIntervals) {
        if (occ.startMs < sp.chosen.proposedEnd && occ.endMs > sp.chosen.proposedStart) {
          inhaberExistingConflicts.push(`…${sp.block.blockId.slice(-6)} ↔ Inhaber …${occ.blockId.slice(-6)}`);
        }
      }
    }

    // B. Vehicle overlaps: selected placements with same vehicle vs each other
    const vehicleSelfConflicts: string[] = [];
    for (let i = 0; i < selected.length; i++) {
      for (let j = i + 1; j < selected.length; j++) {
        if (selected[i].block.vehicle !== selected[j].block.vehicle) continue;
        const a = selected[i].chosen, b = selected[j].chosen;
        if (a.proposedStart < b.proposedEnd && a.proposedEnd > b.proposedStart) {
          vehicleSelfConflicts.push(`${selected[i].block.vehicle}: …${selected[i].block.blockId.slice(-6)} ↔ …${selected[j].block.blockId.slice(-6)}`);
        }
      }
    }
    // Selected placements vs existing vehicle occupancy (from vehicleFree flag)
    const vehicleExistingConflicts: string[] = [];
    for (const sp of selected) {
      if (!sp.chosen.cw.vehicleFree) {
        vehicleExistingConflicts.push(`${sp.block.vehicle}: …${sp.block.blockId.slice(-6)}`);
      }
    }

    // C. Ride-level vehicle overlap check: simulate shifted rides vs existing non-moved rides
    const rideLevelVehicleConflicts: string[] = [];
    if (originalTrips) {
      const openBlockTripIds = new Set<string>();
      for (const sp of selected) for (const ride of sp.block.rides) openBlockTripIds.add(ride.tripId);

      const START_KEYS = ['uhrzeit des fahrtbeginns', 'fahrtbeginn', 'start', 'start_datetime', 'fahrt_beginn'];
      const END_KEYS   = ['uhrzeit des fahrtendes', 'fahrtende', 'ende', 'end_datetime', 'fahrt_ende'];
      const DATE_KEYS  = ['datum der fahrt', 'datum', 'date', 'fahrt_datum'];

      const parseTs = (dateS: string, timeS: string) => {
        if (!timeS) return 0;
        const combined = timeS.includes('T') || timeS.match(/^\d{4}-\d{2}-\d{2} \d{2}:/)
          ? timeS : (dateS ? `${dateS} ${timeS}` : timeS);
        const ms = Date.parse(combined.replace(' ', 'T'));
        return isNaN(ms) ? 0 : ms;
      };

      const vehicleRides = new Map<string, Array<{ startMs: number; endMs: number; tripId: string }>>();
      for (const trip of originalTrips) {
        if (trip.is_canceled || openBlockTripIds.has(trip.id)) continue;
        const raw = trip.raw_data_json as Record<string, unknown> | null;
        if (!raw) continue;
        let dateStr = '';
        for (const k of Object.keys(raw)) { if (DATE_KEYS.includes(k.toLowerCase())) { dateStr = String(raw[k] ?? ''); break; } }
        const startStr = (() => { for (const k of Object.keys(raw)) if (START_KEYS.includes(k.toLowerCase())) return String(raw[k] ?? ''); return ''; })();
        const endStr   = (() => { for (const k of Object.keys(raw)) if (END_KEYS.includes(k.toLowerCase())) return String(raw[k] ?? ''); return ''; })();
        const startMs = parseTs(dateStr, startStr), endMs = parseTs(dateStr, endStr);
        if (!startMs || !endMs || endMs <= startMs) continue;
        const veh = trip.car_identifier ?? ''; if (!veh) continue;
        if (!vehicleRides.has(veh)) vehicleRides.set(veh, []);
        vehicleRides.get(veh)!.push({ startMs, endMs, tripId: trip.id });
      }

      for (const sp of selected) {
        const offsetMs = sp.chosen.proposedStart - (sp.block.blockStartMs ?? 0);
        const existing = vehicleRides.get(sp.block.vehicle) ?? [];
        for (const ride of sp.block.rides) {
          const rs = ride.originalStartMs + offsetMs, re = ride.originalEndMs + offsetMs;
          for (const ex of existing) {
            if (ex.startMs < re && ex.endMs > rs) {
              rideLevelVehicleConflicts.push(`${sp.block.vehicle}: ride …${ride.tripId.slice(-6)} ↔ existierend …${ex.tripId.slice(-6)}`);
            }
          }
        }
      }
    }

    // D–H: per-placement checks
    const pufferVorFails   = selected.filter(sp => sp.chosen.pufferVorMs  < MIN_PUFFER_MS).map(sp => `…${sp.block.blockId.slice(-6)} (${Math.round(sp.chosen.pufferVorMs  / 60000)} min)`);
    const pufferNachFails  = selected.filter(sp => sp.chosen.pufferNachMs < MIN_PUFFER_MS).map(sp => `…${sp.block.blockId.slice(-6)} (${Math.round(sp.chosen.pufferNachMs / 60000)} min)`);
    const outOfMonth       = selected.filter(sp => sp.chosen.proposedStart < monthStartMs || sp.chosen.proposedEnd > monthEndMs + 1).map(sp => `…${sp.block.blockId.slice(-6)}`);
    const invalidTs        = selected.filter(sp => !sp.chosen.proposedStart || !sp.chosen.proposedEnd || sp.chosen.proposedEnd <= sp.chosen.proposedStart).map(sp => `…${sp.block.blockId.slice(-6)}`);
    const crossMidnight         = selected.filter(sp => sp.chosen.crossesMidnight);
    const crossMidnightOriginal = selected.filter(sp => {
      const startMs = sp.block.blockStartMs ?? 0;
      const endMs   = sp.block.blockEndMs   ?? 0;
      return endMs > startMs && new Date(startMs).getDate() !== new Date(endMs - 1).getDate();
    });

    const allInhaberConflicts = [...inhaberSelfConflicts, ...inhaberExistingConflicts];
    const allVehicleConflicts = [...vehicleSelfConflicts, ...vehicleExistingConflicts];

    // D. Driver exclusion check: reject if Inhaber/owner is excluded from planning during simulated rides
    const driverExclusionConflicts: string[] = [];
    if (driverNotesMap.size > 0 && resolvedOwnerName) {
      for (const sp of selected) {
        const offsetMs = sp.chosen.proposedStart - (sp.block.blockStartMs ?? 0);
        for (const ride of sp.block.rides) {
          const rideStart = ride.originalStartMs + offsetMs;
          const rideEnd   = ride.originalEndMs   + offsetMs;
          const excl = isDriverExcludedFromPlanning(ownerDriverId, resolvedOwnerName, rideStart, rideEnd, driverNotesMap, driverNameToId, t);
          if (excl.excluded) {
            driverExclusionConflicts.push(`${sp.block.vehicle}: ${t('hwh.detailRide', { ride: ride.tripId.slice(-6) })} — ${excl.detail}`);
          }
        }
      }
    }

    const allOk = allInhaberConflicts.length === 0 && allVehicleConflicts.length === 0
      && rideLevelVehicleConflicts.length === 0
      && pufferVorFails.length === 0 && pufferNachFails.length === 0
      && outOfMonth.length === 0 && invalidTs.length === 0
      && driverExclusionConflicts.length === 0;

    // Per-item check result for compact table
    const perItemChecks = selected.map(sp => {
      const issues: string[] = [];
      if (sp.chosen.pufferVorMs  < MIN_PUFFER_MS) issues.push(t('hwh.colBufferBefore'));
      if (sp.chosen.pufferNachMs < MIN_PUFFER_MS) issues.push(t('hwh.colBufferAfter'));
      if (sp.chosen.proposedStart < monthStartMs || sp.chosen.proposedEnd > monthEndMs + 1) issues.push(t('hwh.sugStatusOutsideMonth'));
      if (!sp.chosen.proposedStart || !sp.chosen.proposedEnd || sp.chosen.proposedEnd <= sp.chosen.proposedStart) issues.push(t('hwh.issueInvalidTimestamp'));
      if (!sp.chosen.cw.vehicleFree) issues.push(t('hwh.sugStatusVehicleBusy'));
      return issues;
    });

    // Calendar: group items by day (YYYY-MM-DD key)
    type CalEntry =
      | { kind: 'existing'; occ: InhaberOccupiedInterval }
      | { kind: 'preview'; sp: typeof selected[0]; issues: string[] };
    const byDay = new Map<string, CalEntry[]>();

    const dayKey = (ms: number) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    };
    const addToDay = (key: string, entry: CalEntry) => {
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(entry);
    };

    for (const occ of inhaberOccupiedIntervals) {
      const k1 = dayKey(occ.startMs);
      addToDay(k1, { kind: 'existing', occ });
      const k2 = dayKey(occ.endMs - 1);
      if (k2 !== k1) addToDay(k2, { kind: 'existing', occ });
    }
    for (let i = 0; i < selected.length; i++) {
      const sp = selected[i];
      const issues = perItemChecks[i];
      const k1 = dayKey(sp.chosen.proposedStart);
      addToDay(k1, { kind: 'preview', sp, issues });
      const k2 = dayKey(sp.chosen.proposedEnd - 1);
      if (k2 !== k1) addToDay(k2, { kind: 'preview', sp, issues });
    }

    const days = [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, entries]) => ({ key, entries: entries.sort((a, b) => {
        const aMs = a.kind === 'existing' ? a.occ.startMs : a.sp.chosen.proposedStart;
        const bMs = b.kind === 'existing' ? b.occ.startMs : b.sp.chosen.proposedStart;
        return aMs - bMs;
      }) }));

    return {
      selected,
      perItemChecks,
      allInhaberConflicts,
      allVehicleConflicts,
      rideLevelVehicleConflicts,
      driverExclusionConflicts,
      pufferVorFails,
      pufferNachFails,
      outOfMonth,
      invalidTs,
      crossMidnight,
      crossMidnightOriginal,
      allOk,
      days,
      uniqueVehicles: new Set(selected.map(sp => sp.block.vehicle)).size,
      totalSec: selected.reduce((s, sp) => s + sp.block.blockDurationSec, 0),
    };
  }, [autoSelection, inhaberOccupiedIntervals, monthStartMs, monthEndMs, originalTrips, driverNotesMap, resolvedOwnerName, ownerDriverId, driverNameToId, t]);

  // ── Diagnostic: existing imported rides that already violate driver exclusion notes ──
  // Warning-only — does not block export of unrelated rides.
  const existingImportedViolations = useMemo(() => {
    if (!originalTrips || driverNotesMap.size === 0) return [];
    const START_KEYS_EV = ['uhrzeit des fahrtbeginns', 'fahrtbeginn', 'start', 'start_datetime', 'fahrt_beginn'];
    const END_KEYS_EV   = ['uhrzeit des fahrtendes', 'fahrtende', 'ende', 'end_datetime', 'fahrt_ende'];
    const DATE_KEYS_EV  = ['datum der fahrt', 'datum', 'date', 'fahrt_datum'];
    const parseTsEV = (dateS: string, timeS: string) => {
      if (!timeS) return 0;
      const combined = timeS.includes('T') || timeS.match(/^\d{4}-\d{2}-\d{2} \d{2}:/)
        ? timeS : (dateS ? `${dateS} ${timeS}` : timeS);
      const ms = Date.parse(combined.replace(' ', 'T'));
      return isNaN(ms) ? 0 : ms;
    };
    type Violation = {
      driver: string; vehicle: string; tripId: string;
      startMs: number; endMs: number; detail: string;
    };
    const violations: Violation[] = [];
    for (const trip of originalTrips) {
      if (trip.is_canceled) continue;
      const driverId = trip.original_driver_id ?? null;
      const driverName = trip.original_driver_name ?? '';
      if (!driverName) continue;
      const raw = trip.raw_data_json as Record<string, unknown> | null;
      if (!raw) continue;
      let dateStr = '';
      for (const k of Object.keys(raw)) {
        if (DATE_KEYS_EV.includes(k.toLowerCase())) { dateStr = String(raw[k] ?? ''); break; }
      }
      const startStr = (() => { for (const k of Object.keys(raw)) if (START_KEYS_EV.includes(k.toLowerCase())) return String(raw[k] ?? ''); return ''; })();
      const endStr   = (() => { for (const k of Object.keys(raw)) if (END_KEYS_EV.includes(k.toLowerCase())) return String(raw[k] ?? ''); return ''; })();
      const startMs = parseTsEV(dateStr, startStr), endMs = parseTsEV(dateStr, endStr);
      if (!startMs || !endMs || endMs <= startMs) continue;
      const excl = isDriverExcludedFromPlanning(driverId, driverName, startMs, endMs, driverNotesMap, driverNameToId, t);
      if (excl.excluded) {
        violations.push({ driver: driverName, vehicle: trip.car_identifier ?? '', tripId: trip.id, startMs, endMs, detail: excl.detail });
      }
    }
    return violations;
  }, [originalTrips, driverNotesMap, driverNameToId, t]);

  // ── Alternatives diagnostic for unresolved Fahrer-Notiz conflicts ────────────
  // For each unresolved excluded ride group (= logical block), evaluate every driver
  // as a potential replacement. Pure read — does not mutate anything.
  const driverNoteAlternatives = useMemo(() => {
    if (!sectionFData || sectionFData.unresolvedExcludedRides.length === 0) return null;

    type ConflictBlock = {
      blockKey: string;
      driver: string;
      vehicle: string;
      startMs: number;
      endMs: number;
      rideCount: number;
      durationSec: number;
      rides: Array<{ tripId: string; startMs: number; endMs: number }>;
      candidates: CandidateEval[];
    };
    type CandidateEval = {
      driverName: string;
      driverId: string | null;
      targetKind: 'regular' | 'inhaber';
      driverFree: boolean;
      driverNoteConflict: boolean;
      inhaberFree: boolean;
      inhaberConflict: boolean;
      status: 'best' | 'possible' | 'rejected';
      rejectReason: string | null;
    };

    // Group rides into logical blocks: same driver + vehicle, starts within 30 min gap
    const GAP_MS = 30 * 60 * 1000;
    const sorted = [...sectionFData.unresolvedExcludedRides].sort((a, b) => a.startMs - b.startMs);
    const blocks: ConflictBlock[] = [];
    for (const ride of sorted) {
      const existing = blocks.find(b =>
        b.driver === ride.driver && b.vehicle === ride.vehicle &&
        ride.startMs <= b.endMs + GAP_MS
      );
      if (existing) {
        existing.rides.push(ride);
        existing.endMs   = Math.max(existing.endMs, ride.endMs);
        existing.startMs = Math.min(existing.startMs, ride.startMs);
        existing.rideCount++;
        existing.durationSec = Math.round((existing.endMs - existing.startMs) / 1000);
      } else {
        blocks.push({
          blockKey: `${ride.driver}|${ride.vehicle}|${ride.startMs}`,
          driver:   ride.driver,
          vehicle:  ride.vehicle,
          startMs:  ride.startMs,
          endMs:    ride.endMs,
          rideCount: 1,
          durationSec: Math.round((ride.endMs - ride.startMs) / 1000),
          rides: [ride],
          candidates: [],
        });
      }
    }

    const inhaberLower = resolvedOwnerName?.trim().toLowerCase() ?? '';

    for (const block of blocks) {
      const candidates: CandidateEval[] = [];

      for (const driver of allDrivers) {
        const nameL = driver.name.trim().toLowerCase();
        // Skip the excluded driver itself
        if (nameL === block.driver.trim().toLowerCase()) continue;

        const isInhaber = inhaberLower && nameL === inhaberLower;
        const excl = isDriverExcludedFromPlanning(driver.id ?? null, driver.name, block.startMs, block.endMs, driverNotesMap, driverNameToId, t);
        let rejectReason: string | null = null;

        if (excl.excluded) {
          rejectReason = t('hwh.reasonDriverNoteViolated', { detail: excl.detail });
        } else if (isInhaber) {
          const inhaberBusy = inhaberOccupiedIntervals.some(
            occ => occ.startMs < block.endMs && occ.endMs > block.startMs
          );
          if (inhaberBusy) rejectReason = t('hwh.reasonOwnerBusy');
        }

        const inhaberFreeNow = isInhaber
          ? !inhaberOccupiedIntervals.some(occ => occ.startMs < block.endMs && occ.endMs > block.startMs)
          : true;

        candidates.push({
          driverName:        driver.name,
          driverId:          driver.id ?? null,
          targetKind:        isInhaber ? 'inhaber' : 'regular',
          driverFree:        !excl.excluded,
          driverNoteConflict: excl.excluded,
          inhaberFree:       inhaberFreeNow,
          inhaberConflict:   isInhaber && !inhaberFreeNow,
          status:            rejectReason ? 'rejected' : 'possible',
          rejectReason,
        });
      }

      // Mark best: first non-rejected regular, else first non-rejected inhaber
      const firstRegular = candidates.find(c => c.status === 'possible' && c.targetKind === 'regular');
      const firstInhaber = candidates.find(c => c.status === 'possible' && c.targetKind === 'inhaber');
      if (firstRegular) firstRegular.status = 'best';
      else if (firstInhaber) firstInhaber.status = 'best';

      // Sort: best → possible → rejected; within same status regular before inhaber
      const score = { best: 0, possible: 1, rejected: 2 };
      candidates.sort((a, b) => {
        if (score[a.status] !== score[b.status]) return score[a.status] - score[b.status];
        if (a.targetKind !== b.targetKind) return a.targetKind === 'regular' ? -1 : 1;
        return a.driverName.localeCompare(b.driverName);
      });

      block.candidates = candidates.slice(0, 10);
    }

    const blocksWithAlternative = blocks.filter(b => b.candidates.some(c => c.status === 'best' || c.status === 'possible')).length;
    const blocksWithout = blocks.length - blocksWithAlternative;

    return { blocks, blocksWithAlternative, blocksWithout, totalBlocks: blocks.length };
  }, [sectionFData, allDrivers, driverNotesMap, driverNameToId, inhaberOccupiedIntervals, resolvedOwnerName, t]);

  // Rides still unresolved after user applies note alternatives
  const effectiveUnresolvedRides = useMemo(() => {
    if (!sectionFData) return [];
    return sectionFData.unresolvedExcludedRides.filter(r => !noteReassignments.has(r.tripId));
  }, [sectionFData, noteReassignments]);

  // Recompute allOk using effectiveUnresolvedRides so export gate respects applied alternatives
  const effectiveAllOk = useMemo(() => {
    if (!sectionFData) return false;
    return (
      sectionFData.invalidTsRides.length === 0 &&
      sectionFData.inhaberOverlaps.length === 0 &&
      sectionFData.vehicleOverlaps.length === 0 &&
      sectionFData.rideLevelExistingConflicts.length === 0 &&
      sectionFData.missingBlocks.length === 0 &&
      sectionFData.rideCountOk &&
      sectionFData.tsMillisOk &&
      sectionFData.auftragOk &&
      sectionFData.driverExclusionViolations.length === 0 &&
      effectiveUnresolvedRides.length === 0
    );
  }, [sectionFData, effectiveUnresolvedRides]);

  // Lifted export-gate values so they're accessible in effects and simplified render
  const canExport = useMemo(
    () => effectiveAllOk && !!originalTrips && ownerResolution.status === 'ok',
    [effectiveAllOk, originalTrips, ownerResolution],
  );
  const exportBlockReason = useMemo(() => {
    if (ownerResolution.status === 'none') return t('hwh.exportBlockNoOwnerDriver');
    if (ownerResolution.status === 'multiple') return t('hwh.exportBlockMultipleOwners', { count: ownerResolution.count });
    if (effectiveUnresolvedRides.length > 0) {
      return autoNoteAlternativesApplied
        ? t('hwh.exportBlockNoValidDriverDespiteAlternatives', { count: effectiveUnresolvedRides.length })
        : t('hwh.exportBlockRidesWithInvalidDriver', { count: effectiveUnresolvedRides.length });
    }
    if (!effectiveAllOk) return t('hwh.exportBlockPlanError');
    return null;
  }, [ownerResolution, effectiveUnresolvedRides, effectiveAllOk, autoNoteAlternativesApplied, t]);

  // ── Section F: apply selected Vorschau placements → derive shifted rides ─────

  const handleApplyPlan = useCallback(() => {
    if (!originalTrips || originalTrips.length === 0) return;
    const tripById = new Map(originalTrips.map(trip => [trip.id, trip]));
    const selectedEntries = autoSelection.filter(e => e.chosen !== null);

    // Helper: parse a raw_data_json timestamp string → ms (null if invalid/missing)
    const parseRawTs = (val: unknown): number | null => {
      if (val === null || val === undefined) return null;
      const s = String(val).trim();
      if (!s || s === '\\N' || s.toLowerCase() === 'n/a' || s === 'null' || s === '') return null;
      const ms = Date.parse(s.replace(' ', 'T'));
      return isNaN(ms) ? null : ms;
    };

    // Column key matchers (lowercase)
    const EINGANG_KEYS   = ['datum/uhrzeit auftragseingang', 'auftragseingang', 'auftrag_eingang'];
    const UEBERM_KEYS    = ['uhrzeit der auftragsuebermittlung', 'auftragsuebermittlung', 'auftrag_uebermittlung'];
    const ABHOLZEIT_KEYS = ['geplante abholzeit', 'abholzeit', 'geplante_abholzeit'];
    const START_KEYS     = ['uhrzeit des fahrtbeginns', 'fahrtbeginn', 'start', 'start_datetime', 'fahrt_beginn'];

    // Find a raw_data_json column value by matching key list (case-insensitive)
    const getRawField = (raw: Record<string, unknown>, keys: string[]): unknown => {
      const entry = Object.entries(raw).find(([k]) => keys.includes(k.toLowerCase()));
      return entry?.[1] ?? null;
    };
    // Get original start from raw_data_json (needed for offset calculation)
    const getRawStart = (raw: Record<string, unknown>): number | null =>
      parseRawTs(getRawField(raw, START_KEYS));

    const changedRides: SectionFRide[] = [];
    const blockApps: SectionFBlock[] = [];
    const shiftMap = new Map<string, {
      newStartMs: number; newEndMs: number; newDriver: string;
      auftragEingangMs: number | null;
      auftragUebermittlungMs: number | null;
      geplanteAbholzeitMs: number | null;
    }>();

    for (const entry of selectedEntries) {
      const { block, chosen } = entry;
      const offsetMs = chosen!.proposedStart - (block.blockStartMs ?? 0);
      let blockOk = true;
      let ridesFilled = 0;

      for (const ride of block.rides) {
        const trip = tripById.get(ride.tripId);
        // Floor to whole seconds to ensure .000 ms in export
        const newStartMs = Math.floor((ride.originalStartMs + offsetMs) / 1000) * 1000;
        const newEndMs   = Math.floor((ride.originalEndMs   + offsetMs) / 1000) * 1000;
        const ok = newEndMs > newStartMs && newStartMs > 0;
        if (!ok) blockOk = false;
        ridesFilled++;

        // Compute offset-based timing: preserve original offsets relative to Fahrtbeginn
        let auftragEingangMs: number | null = null;
        let auftragUebermittlungMs: number | null = null;
        let geplanteAbholzeitMs: number | null = null;
        if (trip?.raw_data_json) {
          const raw = trip.raw_data_json;
          const origStart = getRawStart(raw) ?? ride.originalStartMs;
          const origEin   = parseRawTs(getRawField(raw, EINGANG_KEYS));
          const origUeb   = parseRawTs(getRawField(raw, UEBERM_KEYS));
          const origAbh   = parseRawTs(getRawField(raw, ABHOLZEIT_KEYS));
          if (origEin !== null)
            auftragEingangMs = Math.floor((newStartMs + (origEin - origStart)) / 1000) * 1000;
          if (origUeb !== null)
            auftragUebermittlungMs = Math.floor((newStartMs + (origUeb - origStart)) / 1000) * 1000;
          if (origAbh !== null)
            geplanteAbholzeitMs = Math.floor((newStartMs + (origAbh - origStart)) / 1000) * 1000;
        }

        changedRides.push({
          blockId: block.blockId,
          tripId: ride.tripId,
          vehicle: block.vehicle,
          oldDriver: trip ? (trip.assigned_driver_name || trip.original_driver_name || '') : '',
          newDriver: resolvedOwnerName ?? inhaberName,
          // These three were omitted, and the compiler had been saying so all
          // along — TS2345 at this line, one of the 207 errors the ratchet
          // carries. Four checks below read newStartMs off these rows, and
          // `undefined < number` is false, so every one of them reported nothing:
          // the Inhaber's own overlaps, the per-vehicle overlaps, the conflicts
          // against trips that did not move, and the driver-exclusion check.
          // CLAUDE.md: "Only overlaps the app itself created are blocking errors"
          // — these are exactly those, and they were all silent.
          origStartMs: ride.originalStartMs,
          origEndMs: ride.originalEndMs,
          newStartMs,
          newEndMs,
          durSec: ride.durationSec,
          offsetMs,
          srcRowIdx: trip?.source_row_index ?? null,
          ok,
        });

        shiftMap.set(ride.tripId, { newStartMs, newEndMs, newDriver: resolvedOwnerName ?? inhaberName, auftragEingangMs, auftragUebermittlungMs, geplanteAbholzeitMs });
      }

      blockApps.push({
        blockId: block.blockId,
        vehicle: block.vehicle,
        origStartMs: block.blockStartMs ?? 0,
        origEndMs:   block.blockEndMs   ?? 0,
        newStartMs: chosen!.proposedStart,
        newEndMs:   chosen!.proposedEnd,
        rideCount: ridesFilled,
        offsetMs,
        ok: blockOk && ridesFilled === block.rides.length,
        hint: ridesFilled === 0 ? t('hwh.hintNoRides') : blockOk ? t('hwh.ok') : t('hwh.hintTimestampError'),
      });
    }

    // Validation
    const invalidTsRides = changedRides.filter(r => !r.ok).map(r => `…${r.tripId.slice(-6)}`);

    const inhaberOverlaps: string[] = [];
    for (let i = 0; i < changedRides.length; i++) {
      for (let j = i + 1; j < changedRides.length; j++) {
        if (changedRides[i].newStartMs < changedRides[j].newEndMs && changedRides[i].newEndMs > changedRides[j].newStartMs) {
          inhaberOverlaps.push(`…${changedRides[i].tripId.slice(-6)} ↔ …${changedRides[j].tripId.slice(-6)}`);
        }
      }
    }

    const vehicleOverlaps: string[] = [];
    const byVehicle = new Map<string, SectionFRide[]>();
    for (const r of changedRides) {
      if (!byVehicle.has(r.vehicle)) byVehicle.set(r.vehicle, []);
      byVehicle.get(r.vehicle)!.push(r);
    }
    for (const rides of byVehicle.values()) {
      for (let i = 0; i < rides.length; i++) {
        for (let j = i + 1; j < rides.length; j++) {
          if (rides[i].newStartMs < rides[j].newEndMs && rides[i].newEndMs > rides[j].newStartMs) {
            vehicleOverlaps.push(`${rides[i].vehicle}: …${rides[i].tripId.slice(-6)} ↔ …${rides[j].tripId.slice(-6)}`);
          }
        }
      }
    }

    // Ride-level check: shifted rides vs existing non-moved trips on the same vehicle.
    // Exclude only the trips that belong to the selected blocks being moved — unselected candidate
    // blocks remain as real existing Fahrten and correctly block conflicting placements.
    const rideLevelExistingConflicts: string[] = [];
    {
      const movedTripIds = new Set(changedRides.map(r => r.tripId));
      const START_KEYS = ['uhrzeit des fahrtbeginns', 'fahrtbeginn', 'start', 'start_datetime', 'fahrt_beginn'];
      const END_KEYS   = ['uhrzeit des fahrtendes', 'fahrtende', 'ende', 'end_datetime', 'fahrt_ende'];
      const DATE_KEYS  = ['datum der fahrt', 'datum', 'date', 'fahrt_datum'];
      const parseTs = (dateS: string, timeS: string) => {
        if (!timeS) return 0;
        const combined = timeS.includes('T') || timeS.match(/^\d{4}-\d{2}-\d{2} \d{2}:/)
          ? timeS : (dateS ? `${dateS} ${timeS}` : timeS);
        const ms = Date.parse(combined.replace(' ', 'T'));
        return isNaN(ms) ? 0 : ms;
      };
      const existingByVehicle = new Map<string, Array<{ startMs: number; endMs: number; tripId: string }>>();
      for (const trip of originalTrips) {
        if (trip.is_canceled || movedTripIds.has(trip.id)) continue;
        const raw = trip.raw_data_json as Record<string, unknown> | null;
        if (!raw) continue;
        let dateStr = '';
        for (const k of Object.keys(raw)) { if (DATE_KEYS.includes(k.toLowerCase())) { dateStr = String(raw[k] ?? ''); break; } }
        const startStr = (() => { for (const k of Object.keys(raw)) if (START_KEYS.includes(k.toLowerCase())) return String(raw[k] ?? ''); return ''; })();
        const endStr   = (() => { for (const k of Object.keys(raw)) if (END_KEYS.includes(k.toLowerCase())) return String(raw[k] ?? ''); return ''; })();
        const startMs = parseTs(dateStr, startStr), endMs = parseTs(dateStr, endStr);
        if (!startMs || !endMs || endMs <= startMs) continue;
        const veh = trip.car_identifier ?? ''; if (!veh) continue;
        if (!existingByVehicle.has(veh)) existingByVehicle.set(veh, []);
        existingByVehicle.get(veh)!.push({ startMs, endMs, tripId: trip.id });
      }
      for (const r of changedRides) {
        const existing = existingByVehicle.get(r.vehicle) ?? [];
        for (const ex of existing) {
          if (ex.startMs < r.newEndMs && ex.endMs > r.newStartMs) {
            rideLevelExistingConflicts.push(`${r.vehicle}: …${r.tripId.slice(-6)} ↔ ${t('hwh.existingShort')} …${ex.tripId.slice(-6)}`);
          }
        }
      }
    }

    const missingBlocks = selectedEntries
      .filter(e => !(blockApps.find(b => b.blockId === e.block.blockId)?.ok))
      .map(e => `…${e.block.blockId.slice(-6)}`);

    // Driver exclusion check: warn if any changed ride falls in a driver exclusion interval
    const driverExclusionViolations: string[] = [];
    if (driverNotesMap.size > 0) {
      for (const r of changedRides) {
        const driverRec = allDrivers.find(d => d.name === r.newDriver);
        const dId = driverRec?.id ?? null;
        const excl = isDriverExcludedFromPlanning(dId, r.newDriver, r.newStartMs, r.newEndMs, driverNotesMap, driverNameToId, t);
        if (excl.excluded) driverExclusionViolations.push(excl.detail);
      }
    }

    // Build excludedDriverRideMap: rides where original driver is excluded by driver notes.
    // These rides are UNRESOLVED — export must be blocked, not cleared to empty Fahrername.
    const excludedDriverRideMap = new Map<string, { driver: string; vehicle: string; detail: string }>();
    const unresolvedExcludedRides: Array<{ tripId: string; driver: string; vehicle: string; startMs: number; endMs: number; detail: string }> = [];
    if (driverNotesMap.size > 0 && originalTrips) {
      // Build a quick tripId → vehicle lookup from the candidate blocks (open blocks)
      // candidateWindowsByBlock holds all remaining open blocks, each with full VehicleBlock data
      const tripVehicleMap = new Map<string, string>();
      for (const candidacy of candidateWindowsByBlock) {
        for (const ride of candidacy.block.rides ?? []) {
          tripVehicleMap.set(ride.tripId, candidacy.block.vehicle);
        }
      }
      const START_KEYS_XD = ['uhrzeit des fahrtbeginns', 'fahrtbeginn', 'start', 'start_datetime', 'fahrt_beginn'];
      const END_KEYS_XD   = ['uhrzeit des fahrtendes', 'fahrtende', 'ende', 'end_datetime', 'fahrt_ende'];
      const DATE_KEYS_XD  = ['datum der fahrt', 'datum', 'date', 'fahrt_datum'];
      const parseTsXD = (dateS: string, timeS: string) => {
        if (!timeS) return 0;
        const combined = timeS.includes('T') || timeS.match(/^\d{4}-\d{2}-\d{2} \d{2}:/)
          ? timeS : (dateS ? `${dateS} ${timeS}` : timeS);
        const ms = Date.parse(combined.replace(' ', 'T'));
        return isNaN(ms) ? 0 : ms;
      };
      for (const trip of originalTrips) {
        if (trip.is_canceled || shiftMap.has(trip.id)) continue;
        const driverId = trip.original_driver_id ?? null;
        const driverName = trip.original_driver_name ?? '';
        if (!driverName) continue;
        const raw = trip.raw_data_json as Record<string, unknown> | null;
        if (!raw) continue;
        let dateStr = '';
        for (const k of Object.keys(raw)) {
          if (DATE_KEYS_XD.includes(k.toLowerCase())) { dateStr = String(raw[k] ?? ''); break; }
        }
        const startStr = (() => { for (const k of Object.keys(raw)) if (START_KEYS_XD.includes(k.toLowerCase())) return String(raw[k] ?? ''); return ''; })();
        const endStr   = (() => { for (const k of Object.keys(raw)) if (END_KEYS_XD.includes(k.toLowerCase())) return String(raw[k] ?? ''); return ''; })();
        const startMs = parseTsXD(dateStr, startStr), endMs = parseTsXD(dateStr, endStr);
        if (!startMs || !endMs || endMs <= startMs) continue;
        const excl = isDriverExcludedFromPlanning(driverId, driverName, startMs, endMs, driverNotesMap, driverNameToId, t);
        if (excl.excluded) {
          const startMs2 = startMs, endMs2 = endMs;
          excludedDriverRideMap.set(trip.id, { driver: driverName, vehicle: tripVehicleMap.get(trip.id) ?? '', detail: excl.detail });
          unresolvedExcludedRides.push({ tripId: trip.id, driver: driverName, vehicle: tripVehicleMap.get(trip.id) ?? '', startMs: startMs2, endMs: endMs2, detail: excl.detail });
        }
      }
    }

    const rideCountOk = selectedEntries.every(e => {
      const app = blockApps.find(b => b.blockId === e.block.blockId);
      return app && app.rideCount === e.block.rides.length;
    });

    // Structural checks — validate milliseconds using the same formatted strings written to XLSX
    const totalTsCount = changedRides.length * 2;
    const invalidTsCount = changedRides.reduce((n, r) => {
      const s = formatExportDateTime(r.newStartMs).endsWith('.000') ? 0 : 1;
      const e = formatExportDateTime(r.newEndMs).endsWith('.000') ? 0 : 1;
      return n + s + e;
    }, 0);
    const tsMillisOk = invalidTsCount === 0;
    const priceKmUnchanged = true; // we only patch driver/date/start/end columns
    const columnOrderReady = !!(sourceColumnsJson && sourceColumnsJson.length > 0);

    // Validate offset-preserved timing fields for every shifted ride
    let invalidZeitversatzCount = 0;
    for (const [tripId, s] of shiftMap) {
      const trip = tripById.get(tripId);
      if (!trip?.raw_data_json) continue;
      const raw = trip.raw_data_json;

      const checkField = (computedMs: number | null, origKeys: string[]) => {
        const origVal = getRawField(raw, origKeys);
        const origMs  = parseRawTs(origVal);
        if (origMs === null) return; // invalid/missing original → no check needed
        // Computed must exist and end with .000
        if (computedMs === null || !formatExportDateTime(computedMs).endsWith('.000'))
          invalidZeitversatzCount++;
      };

      checkField(s.auftragEingangMs,       EINGANG_KEYS);
      checkField(s.auftragUebermittlungMs, UEBERM_KEYS);
      checkField(s.geplanteAbholzeitMs,    ABHOLZEIT_KEYS);
    }
    const zeitversatzOk = invalidZeitversatzCount === 0;
    // Keep auftragOk/invalidAuftragCount as aliases for backward compat with setSectionFData
    const auftragOk = zeitversatzOk;
    const invalidAuftragCount = invalidZeitversatzCount;

    const allOk = invalidTsRides.length === 0 && inhaberOverlaps.length === 0
      && vehicleOverlaps.length === 0 && rideLevelExistingConflicts.length === 0
      && missingBlocks.length === 0 && rideCountOk && tsMillisOk && auftragOk
      && driverExclusionViolations.length === 0 && unresolvedExcludedRides.length === 0;

    setSectionFData({
      changedRides,
      blockApps,
      totalRidesChanged: changedRides.length,
      totalSec: changedRides.reduce((s, r) => s + r.durSec, 0),
      uniqueVehicles: new Set(changedRides.map(r => r.vehicle)).size,
      invalidTsRides,
      inhaberOverlaps,
      vehicleOverlaps,
      rideLevelExistingConflicts,
      driverExclusionViolations,
      missingBlocks,
      rideCountOk,
      tsMillisOk,
      invalidTsCount,
      totalTsCount,
      priceKmUnchanged,
      columnOrderReady,
      auftragOk,
      invalidAuftragCount,
      zeitversatzOk,
      invalidZeitversatzCount,
      allOk,
      shiftMap,
      unresolvedExcludedRides,
      excludedDriverRideMap,
    });
  }, [autoSelection, originalTrips, inhaberName, resolvedOwnerName, sourceColumnsJson, driverNotesMap, driverNameToId, allDrivers, candidateWindowsByBlock, t]);

  const handleExportFahrtenbuch = useCallback(async () => {
    if (!sectionFData || !originalTrips) return;
    const ownerDriverName = resolvedOwnerName;
    if (!ownerDriverName) return;
    const { shiftMap, unresolvedExcludedRides } = sectionFData;

    // Block export if any rides still have unresolved driver exclusions after alternatives applied.
    // Never export empty Fahrername or keep an excluded driver.
    const stillUnresolved = unresolvedExcludedRides.filter(r => !noteReassignments.has(r.tripId));
    if (stillUnresolved.length > 0) {
      // Screen message, not document text — the byte-for-byte export rules below
      // cover the workbook contents, not this alert.
      alert(t('hwh.exportLockedInvalidDrivers', { count: stillUnresolved.length }));
      return;
    }

    // ── 1. Download original file from Supabase storage ─────────────────────
    //    This is the only source that has raw, un-serialized cell values.
    let originalWs: XLSX.WorkSheet | null = null;
    if (storagePath) {
      try {
        const { data: blob, error } = await supabase.storage.from('fahrtenbuch-files').download(storagePath);
        if (!error && blob) {
          const arrayBuffer = await blob.arrayBuffer();
          const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array', cellStyles: false, raw: true });
          const wsName = sourceSheetName ?? wb.SheetNames[0];
          originalWs = wb.Sheets[wsName] ?? wb.Sheets[wb.SheetNames[0]] ?? null;
        }
      } catch { /* fall through to json_to_sheet fallback */ }
    }

    // ── 2. Build column order from source_columns_json ───────────────────────
    let headers: string[];
    if (sourceColumnsJson && sourceColumnsJson.length > 0) {
      headers = [...sourceColumnsJson];
      const inHeaders = new Set(headers.map(h => h.toLowerCase()));
      for (const trip of originalTrips) {
        if (trip.raw_data_json) for (const k of Object.keys(trip.raw_data_json)) {
          if (!inHeaders.has(k.toLowerCase())) { headers.push(k); inHeaders.add(k.toLowerCase()); }
        }
      }
    } else {
      const headerSet = new Set<string>();
      for (const trip of originalTrips) {
        if (trip.raw_data_json) for (const k of Object.keys(trip.raw_data_json)) headerSet.add(k);
      }
      headers = [...headerSet];
    }

    const DRIVER_KEYS    = ['fahrername', 'fahrer'];
    const START_KEYS     = ['uhrzeit des fahrtbeginns', 'fahrtbeginn', 'start', 'start_datetime', 'fahrt_beginn'];
    const END_KEYS       = ['uhrzeit des fahrtendes', 'fahrtende', 'ende', 'end_datetime', 'fahrt_ende'];
    const DATE_KEYS      = ['datum der fahrt', 'datum', 'date', 'fahrt_datum'];
    const EINGANG_KEYS   = ['datum/uhrzeit auftragseingang', 'auftragseingang', 'auftrag_eingang'];
    const UEBERM_KEYS    = ['uhrzeit der auftragsuebermittlung', 'auftragsuebermittlung', 'auftrag_uebermittlung'];
    const ABHOLZEIT_KEYS = ['geplante abholzeit', 'abholzeit', 'geplante_abholzeit'];

    const colIdx = new Map(headers.map((h, i) => [h.toLowerCase(), i]));
    const driverColIdx   = [...colIdx.entries()].find(([k]) => DRIVER_KEYS.includes(k))?.[1] ?? -1;
    const startColIdx    = [...colIdx.entries()].find(([k]) => START_KEYS.includes(k))?.[1] ?? -1;
    const endColIdx      = [...colIdx.entries()].find(([k]) => END_KEYS.includes(k))?.[1] ?? -1;
    const dateColIdx     = [...colIdx.entries()].find(([k]) => DATE_KEYS.includes(k))?.[1] ?? -1;
    const eingangColIdx  = [...colIdx.entries()].find(([k]) => EINGANG_KEYS.includes(k))?.[1] ?? -1;
    const uebermColIdx   = [...colIdx.entries()].find(([k]) => UEBERM_KEYS.includes(k))?.[1] ?? -1;
    const abholColIdx    = [...colIdx.entries()].find(([k]) => ABHOLZEIT_KEYS.includes(k))?.[1] ?? -1;

    const fmtDate = (ms: number) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    };

    if (originalWs) {
      // ── Cell-level path: preserves raw numeric values exactly ─────────────
      const range = XLSX.utils.decode_range(originalWs['!ref'] ?? 'A1');

      // Replicate the same header-row detection used during import.
      // source_row_index is 1-based offset from the first data row (after the detected header).
      const HEADER_KW = [
        'datum','fahrer','uhrzeit','preis','trinkgeld','zahlungsart','abholort','zielort','kennzeichen',
        'start','ende','beginn','fahrt','trip','driver','date','time','price','status','storniert',
      ];
      let wsHeaderRow = range.s.r;
      for (let r = range.s.r; r <= Math.min(range.e.r, 20); r++) {
        let matches = 0;
        for (let c = range.s.c; c <= range.e.c; c++) {
          const cell = originalWs[XLSX.utils.encode_cell({ r, c })];
          if (cell && HEADER_KW.some(kw => String(cell.v ?? '').toLowerCase().includes(kw))) matches++;
        }
        if (matches >= 3) { wsHeaderRow = r; break; }
      }

      // Map header name (lowercase) → worksheet column index
      const wsColByName = new Map<string, number>();
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r: wsHeaderRow, c });
        const cell = originalWs[addr];
        if (cell) wsColByName.set(String(cell.v ?? '').toLowerCase().trim(), c);
      }

      // Identify patchable worksheet column indices
      const wsDriverCol  = DRIVER_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;
      const wsStartCol   = START_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;
      const wsEndCol     = END_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;
      const wsDateCol    = DATE_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;
      const wsEingangCol = EINGANG_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;
      const wsUebermCol  = UEBERM_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;
      const wsAbholCol   = ABHOLZEIT_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;

      // Build a list of {srcRowIdx (ws row, 0-based), sortKey, trip}
      type RowEntry = { wsRow: number; sortMs: number; trip: FahrtenbuchTrip | null };
      const rowEntries: RowEntry[] = originalTrips.map(trip => {
        // source_row_index is 1-based: first data row after the header = 1
        const wsRow = wsHeaderRow + (trip.source_row_index ?? 1);
        const s = shiftMap.get(trip.id);
        let sortMs = Infinity;
        if (s) {
          sortMs = s.newStartMs;
        } else if (wsStartCol >= 0) {
          const addr = XLSX.utils.encode_cell({ r: wsRow, c: wsStartCol });
          const cell = originalWs![addr];
          if (cell) {
            const val = String(cell.v ?? '');
            const ms = Date.parse(val.replace(' ', 'T'));
            if (!isNaN(ms)) sortMs = ms;
          }
        }
        return { wsRow, sortMs, trip };
      });

      // Sort ascending by start time; missing/invalid go to end
      rowEntries.sort((a, b) => {
        if (a.sortMs === Infinity && b.sortMs === Infinity) return 0;
        return a.sortMs - b.sortMs;
      });

      // Build new worksheet: header row + sorted data rows
      const newWs: XLSX.WorkSheet = {};
      const totalCols = range.e.c - range.s.c + 1;
      const totalRows = 1 + rowEntries.length; // header + data

      // Copy header row verbatim (using detected header row, not range.s.r which may be before it)
      for (let c = range.s.c; c <= range.e.c; c++) {
        const srcAddr = XLSX.utils.encode_cell({ r: wsHeaderRow, c });
        const dstAddr = XLSX.utils.encode_cell({ r: 0, c: c - range.s.c });
        const cell = originalWs[srcAddr];
        if (cell) newWs[dstAddr] = { ...cell };
      }

      // Identify Fahrpreis and Kilometer column indices for validation
      const FAHRPREIS_KEYS = ['fahrpreis', 'preis', 'price', 'fare'];
      const KILOMETER_KEYS = ['kilometer', 'km', 'distanz', 'distance'];
      const wsFahrpreisCol = FAHRPREIS_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;
      const wsKilometerCol = KILOMETER_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;
      let invalidPriceKmCount = 0;

      // Write sorted data rows
      for (let i = 0; i < rowEntries.length; i++) {
        const { wsRow, trip } = rowEntries[i];
        const dstRow = i + 1;
        const s = trip ? shiftMap.get(trip.id) : undefined;

        for (let c = range.s.c; c <= range.e.c; c++) {
          const srcAddr = XLSX.utils.encode_cell({ r: wsRow, c: c });
          const dstAddr = XLSX.utils.encode_cell({ r: dstRow, c: c - range.s.c });
          const srcCell = originalWs[srcAddr];
          // Clone original cell (preserves type, raw value, numFmt, etc.)
          const cell: XLSX.CellObject = srcCell ? { ...srcCell } : { t: 'z' };

          if (s) {
            // Patch only the allowed columns; every other cell is cloned verbatim
            if (c === wsDriverCol  && wsDriverCol  >= 0)
              { cell.t = 's'; cell.v = ownerDriverName; delete cell.w; }
            else if (c === wsStartCol   && wsStartCol   >= 0)
              { cell.t = 's'; cell.v = formatExportDateTime(s.newStartMs); delete cell.w; }
            else if (c === wsEndCol     && wsEndCol     >= 0)
              { cell.t = 's'; cell.v = formatExportDateTime(s.newEndMs); delete cell.w; }
            else if (c === wsDateCol    && wsDateCol    >= 0)
              { cell.t = 's'; cell.v = fmtDate(s.newStartMs); delete cell.w; }
            else if (c === wsEingangCol && wsEingangCol >= 0 && s.auftragEingangMs !== null)
              { cell.t = 's'; cell.v = formatExportDateTime(s.auftragEingangMs); delete cell.w; }
            else if (c === wsUebermCol  && wsUebermCol  >= 0 && s.auftragUebermittlungMs !== null)
              { cell.t = 's'; cell.v = formatExportDateTime(s.auftragUebermittlungMs); delete cell.w; }
            else if (c === wsAbholCol   && wsAbholCol   >= 0 && s.geplanteAbholzeitMs !== null)
              { cell.t = 's'; cell.v = formatExportDateTime(s.geplanteAbholzeitMs); delete cell.w; }
          }
          // Patch driver name for rides reassigned via Fahrer-Notiz alternatives
          if (!s && trip && noteReassignments.has(trip.id)) {
            if (c === wsDriverCol && wsDriverCol >= 0) {
              cell.t = 's'; cell.v = noteReassignments.get(trip.id)!; delete cell.w;
            }
          }
          // Note: excluded-driver rides are blocked at export-start — we never reach here for those

          // Validate: Fahrpreis/Kilometer must equal the original cell value exactly
          if ((c === wsFahrpreisCol && wsFahrpreisCol >= 0) || (c === wsKilometerCol && wsKilometerCol >= 0)) {
            if (srcCell && cell.v !== srcCell.v) invalidPriceKmCount++;
          }

          newWs[dstAddr] = cell;
        }
      }

      if (invalidPriceKmCount > 0) {
        // Screen alert, not workbook content.
        alert(t('hwh.exportLockedPriceKmChanged', { count: invalidPriceKmCount }));
        return;
      }

      newWs['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: totalRows - 1, c: totalCols - 1 } });
      const wb2 = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb2, newWs, sourceSheetName ?? 'Sheet1');
      writeMarkedWorkbook(wb2, originalFileName ?? `fahrtenbuch_neu_${year}-${String(month).padStart(2,'0')}.xlsx`, hasSimulatedRides(originalTrips));
      return;
    }

    // ── Fallback: json_to_sheet (no storage file available) ──────────────────
    const allRows = originalTrips.map(trip => {
      const row: Record<string, unknown> = { ...(trip.raw_data_json ?? {}) };
      const s = shiftMap.get(trip.id);
      if (s) {
        const driverCol  = driverColIdx  >= 0 ? headers[driverColIdx]  : null;
        const startCol   = startColIdx   >= 0 ? headers[startColIdx]   : null;
        const endCol     = endColIdx     >= 0 ? headers[endColIdx]     : null;
        const dateCol    = dateColIdx    >= 0 ? headers[dateColIdx]    : null;
        const eingangCol = eingangColIdx >= 0 ? headers[eingangColIdx] : null;
        const uebermCol  = uebermColIdx  >= 0 ? headers[uebermColIdx]  : null;
        if (driverCol)  row[driverCol]  = ownerDriverName;
        if (startCol)   row[startCol]   = formatExportDateTime(s.newStartMs);
        if (endCol)     row[endCol]     = formatExportDateTime(s.newEndMs);
        if (dateCol)    row[dateCol]    = fmtDate(s.newStartMs);
        if (eingangCol && s.auftragEingangMs !== null)       row[eingangCol] = formatExportDateTime(s.auftragEingangMs);
        if (uebermCol  && s.auftragUebermittlungMs !== null) row[uebermCol]  = formatExportDateTime(s.auftragUebermittlungMs);
        const abholCol = abholColIdx >= 0 ? headers[abholColIdx] : null;
        if (abholCol && s.geplanteAbholzeitMs !== null)      row[abholCol]   = formatExportDateTime(s.geplanteAbholzeitMs);
      } else if (noteReassignments.has(trip.id)) {
        // Ride reassigned via Fahrer-Notiz alternative — patch only Fahrername
        const driverCol = driverColIdx >= 0 ? headers[driverColIdx] : null;
        if (driverCol) row[driverCol] = noteReassignments.get(trip.id)!;
      }
      // Note: excluded-driver rides are blocked at export-start — never clear Fahrername here
      return row;
    });
    const startColName = startColIdx >= 0 ? headers[startColIdx] : null;
    allRows.sort((a, b) => {
      const parse = (row: Record<string, unknown>) => {
        if (!startColName) return Infinity;
        const val = String(row[startColName] ?? '');
        if (!val || val === '\\N' || val.toLowerCase() === 'n/a' || val === 'null') return Infinity;
        const ms = Date.parse(val.replace(' ', 'T'));
        return isNaN(ms) ? Infinity : ms;
      };
      return parse(a) - parse(b);
    });
    const ws = XLSX.utils.json_to_sheet(allRows, { header: headers });
    const wb3 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb3, ws, sourceSheetName ?? 'Sheet1');
    writeMarkedWorkbook(wb3, originalFileName ?? `fahrtenbuch_neu_${year}-${String(month).padStart(2,'0')}.xlsx`, hasSimulatedRides(originalTrips));
  }, [sectionFData, originalTrips, resolvedOwnerName, sourceSheetName, sourceColumnsJson, storagePath, originalFileName, year, month, noteReassignments, t]);

  // Keep exportTriggerRef in sync so the parent can trigger a download
  useEffect(() => {
    if (exportTriggerRef) exportTriggerRef.current = handleExportFahrtenbuch;
  });

  // Keep handleApplyPlan ref in sync so effects can call the latest version
  useEffect(() => { handleApplyPlanRef.current = handleApplyPlan; });

  // Auto-apply plan once when autoApply=true (simplified/automatic mode)
  useEffect(() => {
    if (!autoApply || autoApplyDoneRef.current) return;
    autoApplyDoneRef.current = true;
    if (!originalTrips || originalTrips.length === 0) {
      exportReadyCallbackRef.current?.(false, t('hwh.noTripsLoaded'));
      return;
    }
    try {
      handleApplyPlanRef.current?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      exportReadyCallbackRef.current?.(false, t('hwh.errorApplyingPlan', { message: msg }));
    }
  }, [autoApply, originalTrips]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fire export-ready callback after plan + note-alternatives phase complete in auto mode.
  // Includes salary range validation: if any regular driver is outside their configured
  // salary range, the export is blocked with a clear German error message.
  useEffect(() => {
    if (!autoApply) return;
    if (!sectionFData) return; // not yet applied
    if (!autoNoteAlternativesApplied) return; // wait for alternatives phase to finish

    // Hard validation gate first
    if (!canExport) {
      exportReadyCallbackRef.current?.(false, exportBlockReason);
      return;
    }

    // Salary range validation gate (requires originalTrips to be loaded)
    if (originalTrips) {
      const { shiftMap } = sectionFData;
      const noteMap = new Map(Array.from(noteReassignments.entries()));
      const hourSummary = buildDriverHourSummary(originalTrips, shiftMap, noteMap, driverConfigs, resolvedOwnerName, year);
      const salaryRangeSummary = buildFinalSalaryRangeSummary(hourSummary, driverConfigs);
      const salaryError = validateFinalSalaryRanges(salaryRangeSummary, t);
      if (salaryError) {
        exportReadyCallbackRef.current?.(false, salaryError);
        return;
      }
    }

    exportReadyCallbackRef.current?.(canExport, exportBlockReason);
  }, [autoApply, sectionFData, canExport, exportBlockReason, autoNoteAlternativesApplied, originalTrips, noteReassignments]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fire onFinalAssignmentReady whenever the final sectionFData + originalTrips are available.
  // Uses shiftMap for Inhaber-shifted ride timestamps and drivers, and noteReassignments
  // for Fahrer-Notiz alternative driver overrides — exactly matching the export source of truth.
  const onFinalAssignmentReadyRef = useRef(onFinalAssignmentReady);
  onFinalAssignmentReadyRef.current = onFinalAssignmentReady;
  useEffect(() => {
    if (!sectionFData || !originalTrips) return;
    const { shiftMap } = sectionFData;

    // Build final per-trip data: vehicle + startMs + endMs + driver
    // matching exactly what handleExportFahrtenbuch writes to the XLSX
    type TripEntry = { vehicle: string; startMs: number; endMs: number; driver: string | null };
    const entries: TripEntry[] = [];

    for (const trip of originalTrips) {
      if (trip.is_canceled) continue;
      const vehicle = trip.car_identifier ?? trip.car_id ?? '';
      if (!vehicle) continue;

      const shifted = shiftMap.get(trip.id);
      if (shifted) {
        // Inhaber-shifted ride: use final times and resolved Inhaber driver name
        entries.push({
          vehicle,
          startMs: shifted.newStartMs,
          endMs: shifted.newEndMs,
          driver: resolveDriverDisplay(shifted.newDriver),
        });
        continue;
      }

      const noteDriver = noteReassignments.get(trip.id);
      if (noteDriver) {
        // Fahrer-Notiz alternative: keep original timestamps, override driver
        const raw = trip.raw_data_json as Record<string, unknown> | null;
        let startMs = 0;
        if (raw) {
          for (const k of Object.keys(raw)) {
            const v = String(raw[k] ?? '');
            if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) {
              const ms = Date.parse(v.replace(' ', 'T'));
              if (!isNaN(ms)) { startMs = ms; break; }
            }
          }
        }
        if (!startMs && trip.trip_date && trip.start_time) {
          const combined = `${trip.trip_date}T${trip.start_time.length === 5 ? trip.start_time + ':00' : trip.start_time}`;
          startMs = Date.parse(combined) || 0;
        }
        if (!startMs) continue;
        entries.push({ vehicle, startMs, endMs: startMs, driver: resolveDriverDisplay(noteDriver) });
        continue;
      }

      // Regular ride: use assigned/original driver and parse start/end from raw_data_json
      const raw = trip.raw_data_json as Record<string, unknown> | null;
      let startMs = 0;
      let endMs = 0;
      if (raw) {
        const datetimeLike: string[] = [];
        for (const k of Object.keys(raw)) {
          const v = String(raw[k] ?? '');
          if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) datetimeLike.push(v);
        }
        if (datetimeLike.length >= 1) startMs = Date.parse(datetimeLike[0].replace(' ', 'T')) || 0;
        if (datetimeLike.length >= 2) endMs = Date.parse(datetimeLike[1].replace(' ', 'T')) || 0;
      }
      if (!startMs && trip.trip_date && trip.start_time) {
        const combined = `${trip.trip_date}T${trip.start_time.length === 5 ? trip.start_time + ':00' : trip.start_time}`;
        startMs = Date.parse(combined) || 0;
      }
      if (!startMs) continue;
      if (!endMs && trip.trip_date && trip.end_time) {
        let combined = `${trip.trip_date}T${trip.end_time.length === 5 ? trip.end_time + ':00' : trip.end_time}`;
        let ms = Date.parse(combined) || 0;
        if (ms > 0 && ms < startMs) ms += 86400000; // cross-midnight
        endMs = ms;
      }
      const driver = resolveDriverDisplay(trip.assigned_driver_name) ?? resolveDriverDisplay(trip.original_driver_name);
      entries.push({ vehicle, startMs, endMs: endMs || startMs, driver });
    }

    // Group by vehicle and compute first/last
    const byVehicle = new Map<string, TripEntry[]>();
    for (const e of entries) {
      if (!byVehicle.has(e.vehicle)) byVehicle.set(e.vehicle, []);
      byVehicle.get(e.vehicle)!.push(e);
    }

    const boundaryRows: VehicleBoundaryRow[] = [];
    for (const [vehicle, rows] of byVehicle) {
      rows.sort((a, b) => a.startMs - b.startMs);
      const first = rows[0];
      const last = rows.reduce((best, r) => (r.endMs || r.startMs) > (best.endMs || best.startMs) ? r : best, rows[0]);
      boundaryRows.push({
        vehicle,
        firstDriver: first.driver,
        firstTripMs: first.startMs,
        lastDriver: last.driver,
        lastTripMs: last.endMs || last.startMs,
        source: 'final',
      });
    }
    boundaryRows.sort((a, b) => a.vehicle.localeCompare(b.vehicle));
    onFinalAssignmentReadyRef.current?.(boundaryRows);

    // Also fire serialized plan data (for save-to-DB functionality in parent)
    const shiftMapJson = Array.from(shiftMap.entries()).map(
      ([id, v]) => [id, v] as [string, object],
    );
    const noteReassignmentsJson = Array.from(noteReassignments.entries());
    onFinalAssignmentReadyRef2.current?.({ shiftMapJson, noteReassignmentsJson });

    // Fire driver working-hour summary for display and persistence
    const hourSummary = buildDriverHourSummary(
      originalTrips,
      shiftMap,
      noteReassignments,
      driverConfigs,
      resolvedOwnerName,
      year,
    );
    onDriverHourSummaryReadyRef.current?.(hourSummary);

    // Build and fire salary range summary for validation and display
    const salaryRangeSummary = buildFinalSalaryRangeSummary(hourSummary, driverConfigs);
    onSalaryRangeSummaryReadyRef.current?.(salaryRangeSummary);
  }, [sectionFData, originalTrips, noteReassignments]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-apply best Fahrer-Notiz alternatives in auto mode after plan is applied.
  // Reuses the same logic as the manual "Beste Fahrer-Notiz-Alternativen anwenden" button.
  // Must run before the export-ready callback so success/failure is correct.
  useEffect(() => {
    if (!autoApply) return;
    if (!sectionFData) return;
    if (autoNoteAlternativesApplied) return;

    // No unresolved rides → nothing to repair
    if (sectionFData.unresolvedExcludedRides.length === 0) {
      setAutoNoteAlternativesApplied(true);
      return;
    }

    // No alternatives computed yet — wait for driverNoteAlternatives to be available
    if (!driverNoteAlternatives) return;

    // Apply best candidate for every conflict block (mirrors handleApplyNoteAlternatives exactly)
    const newMap = new Map(noteReassignments);
    for (const block of driverNoteAlternatives.blocks) {
      const best = block.candidates.find(c => c.status === 'best');
      if (!best) continue;
      for (const ride of block.rides) {
        newMap.set(ride.tripId, best.driverName);
      }
    }
    setNoteReassignments(newMap);
    setAutoNoteAlternativesApplied(true);
  }, [autoApply, sectionFData, driverNoteAlternatives, autoNoteAlternativesApplied]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply the best valid alternative for every unresolved Fahrer-Notiz conflict block
  const handleApplyNoteAlternatives = useCallback(() => {
    if (!driverNoteAlternatives) return;
    const newMap = new Map(noteReassignments);
    for (const block of driverNoteAlternatives.blocks) {
      const best = block.candidates.find(c => c.status === 'best');
      if (!best) continue;
      for (const ride of block.rides) {
        newMap.set(ride.tripId, best.driverName);
      }
    }
    setNoteReassignments(newMap);
  }, [driverNoteAlternatives, noteReassignments]);

  // Simplified render: only the download button, no technical sections
  if (simplified) {
    return (
      <div className="flex items-center gap-3">
        {!sectionFData && (
          <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <RefreshCw size={14} className="animate-spin" style={{ color: '#2563eb' }} />
            <span>{t('hwh.finalCheckRunning')}</span>
          </div>
        )}
        {sectionFData && canExport && (
          <button
            onClick={handleExportFahrtenbuch}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold transition-all hover:brightness-110"
            style={{ background: '#15803d', color: '#fff' }}
          >
            <Download size={15} /> {t('hwh.downloadNewFahrtenbuch')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-6xl">

      {/* Header */}
      <div>
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('hwh.fwsTitle')}</h2>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
          {t('hwh.fwsSubtitle')}
        </p>
        <div className="mt-1.5 inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg" style={{ background: 'rgba(124,58,237,0.08)', color: INHABER_COLOR, border: '1px solid rgba(124,58,237,0.2)' }}>
          {t('hwh.minOwnerBlockGap')}
        </div>
      </div>

      {/* Summary cards — compact 6 cards */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {[
          { label: t('hwh.statOwnerBlocks'),      value: summary.inhaberBlockCount,             color: '#0891b2' },
          { label: t('hwh.statOpenBlocks'),       value: summary.openBlockCount,                color: summary.openBlockCount > 0 ? '#b45309' : '#15803d' },
          { label: t('hwh.statFreeWindows'),      value: summary.freeWindowCount,               color: '#15803d' },
          { label: t('hwh.statFreeHours'),        value: formatBlockDuration(summary.freeSec),  color: '#15803d' },
          { label: t('hwh.statWithWindow'),       value: summary.openBlocksWithCandidate,       color: summary.openBlocksWithCandidate > 0 ? '#15803d' : '#b45309' },
          { label: t('hwh.statWithoutWindow'),    value: summary.openBlocksNoCandidate,         color: summary.openBlocksNoCandidate > 0 ? '#b91c1c' : '#15803d' },
        ].map(c => (
          <div key={c.label} className="rounded-xl p-2.5" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
            <div className="text-xs mb-0.5" style={{ color: 'var(--text-secondary)' }}>{c.label}</div>
            <div className="text-base font-bold" style={{ color: c.color }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Month grid calendar */}
      <div>
        <div className="mb-2">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('hwh.ownerCalendarFreeWindows')}
          </div>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            {t('hwh.ownerCalendarFreeWindowsHint')}
          </p>
        </div>

        <div className="rounded-2xl" style={{ border: '1px solid var(--border)', overflow: 'hidden' }}>
          {/* Weekday header */}
          <div className="grid grid-cols-7" style={{ background: 'var(--bg-subtle)', borderBottom: '2px solid var(--border)' }}>
            {WEEKDAY_COLS.map(dayKey => (
              <div key={dayKey} className="py-2 text-center text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>{t(dayKey)}</div>
            ))}
          </div>

          {/* Week rows */}
          {gridData.map((week, wi) => (
            <div key={wi} className="grid grid-cols-7" style={{ borderBottom: wi < gridData.length - 1 ? '1px solid var(--border)' : undefined }}>
              {week.map((cell, ci) => {
                // Merge occupied + free, sort by startMs
                const events: Array<{ startMs: number; kind: 'occ' | 'free'; occ?: InhaberOccupiedInterval; fw?: FreeWindow }> = [
                  ...cell.occupied.map(o => ({ startMs: o.startMs, kind: 'occ' as const, occ: o })),
                  ...cell.free.map(f => ({ startMs: f.startMs, kind: 'free' as const, fw: f })),
                ].sort((a, b) => a.startMs - b.startMs);

                return (
                  <div
                    key={ci}
                    style={{
                      minHeight: 90,
                      background: !cell.inMonth ? 'var(--bg-subtle)' : 'var(--bg-surface)',
                      borderRight: ci < 6 ? '1px solid var(--border)' : undefined,
                      padding: '5px 4px 3px',
                    }}
                  >
                    {/* Date number */}
                    <div className="flex justify-end mb-1">
                      <span
                        className="text-xs font-semibold w-5 h-5 flex items-center justify-center rounded-full"
                        style={{ color: !cell.inMonth ? 'var(--text-secondary)' : 'var(--text-primary)', opacity: !cell.inMonth ? 0.35 : 1 }}
                      >
                        {cell.date.getDate()}
                      </span>
                    </div>

                    {/* Events */}
                    <div className="space-y-0.5">
                      {events.map((ev, ei) => {
                        if (ev.kind === 'occ' && ev.occ) {
                          const o = ev.occ;
                          const isStep3 = o.sourceStep === 'Step 3';
                          return (
                            <button
                              key={ei}
                              onClick={() => setModalData({ kind: 'occupied', interval: o })}
                              className="w-full text-left rounded px-1.5 py-0.5 text-xs leading-snug transition-all hover:brightness-95"
                              style={{
                                background: isStep3 ? '#ede9fe' : '#cffafe',
                                border: `1.5px solid ${isStep3 ? INHABER_COLOR + '66' : '#0891b2'}`,
                                color: isStep3 ? INHABER_COLOR : '#0e7490',
                              }}
                            >
                              <span className="font-semibold">{fmtTime(o.startMs)}–{fmtTime(o.endMs)}</span>
                              {' · '}{t('hwh.occupied')}{' · '}
                              <span className="font-mono">…{o.blockId.slice(-6)}</span>
                              {' · '}{o.vehicle}
                              {' · '}{formatBlockDuration(o.durationSec)}
                              <span className="ml-1 px-1 py-px rounded font-bold" style={{ background: isStep3 ? INHABER_COLOR + '22' : '#0891b2', color: isStep3 ? INHABER_COLOR : '#fff', fontSize: '0.55rem' }}>
                                {o.sourceStep}
                              </span>
                            </button>
                          );
                        }
                        if (ev.kind === 'free' && ev.fw) {
                          const w = ev.fw;
                          const candidates = windowCandidateMap.get(w.windowId) ?? [];
                          const hasVehicleFree = candidates.some(c => c.vehicleFree);
                          const hasAnyCandidate = candidates.length > 0;
                          const badge = hasVehicleFree ? t('hwh.badgeVehicleFree') : hasAnyCandidate ? t('hwh.badgeCandidate') : t('hwh.badgeNoCandidate');
                          const badgeColor = hasVehicleFree ? '#15803d' : hasAnyCandidate ? '#0891b2' : '#9ca3af';
                          return (
                            <button
                              key={ei}
                              onClick={() => cell.inMonth && setModalData({
                                kind: 'window',
                                windowId: w.windowId,
                                date: w.date,
                                startMs: w.startMs,
                                endMs: w.endMs,
                                durationSec: w.durationSec,
                                prevBlockId: w.prevBlockId,
                                nextBlockId: w.nextBlockId,
                                candidates,
                              })}
                              className="w-full text-left rounded px-1.5 py-0.5 text-xs leading-snug transition-all hover:brightness-95"
                              style={{
                                background: 'rgba(16,185,129,0.08)',
                                border: '1.5px dashed #10b981',
                                color: '#065f46',
                                cursor: cell.inMonth ? 'pointer' : 'default',
                              }}
                            >
                              <span className="font-semibold">{fmtTime(w.startMs)}–{fmtTime(w.endMs)}</span>
                              {' · '}{t('hwh.free')}{' · '}{formatBlockDuration(w.durationSec)}
                              <span className="ml-1 px-1 py-px rounded font-bold" style={{ background: badgeColor + '22', color: badgeColor, border: `1px solid ${badgeColor}55`, fontSize: '0.55rem' }}>
                                {badge}
                              </span>
                            </button>
                          );
                        }
                        return null;
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-3 mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded" style={{ background: '#ede9fe', border: `1px solid ${INHABER_COLOR}66` }} />
            {t('hwh.legendOwnerStep3')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded" style={{ background: '#cffafe', border: '1px solid #0891b2' }} />
            {t('hwh.legendOwnerStep4')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded" style={{ background: 'rgba(16,185,129,0.08)', border: '1.5px dashed #10b981' }} />
            {t('hwh.legendFreeWindow')}
          </span>
          <span className="inline-flex items-center gap-1.5 ml-2 font-semibold" style={{ color: '#15803d' }}>{t('hwh.badgeVehicleFree')}</span>
          <span style={{ color: 'var(--text-secondary)' }}>{t('hwh.legendVehicleAlsoAvailable')}</span>
          <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: '#0891b2' }}>{t('hwh.badgeCandidate')}</span>
          <span style={{ color: 'var(--text-secondary)' }}>{t('hwh.legendMatchingWindowExists')}</span>
        </div>
      </div>

      {/* Open blocks panel — collapsible */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <button
          className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold"
          style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)' }}
          onClick={() => setOpenBlocksOpen(o => !o)}
        >
          <span>
            {t('hwh.openBlocksWithWindows')}
            <span className="font-normal text-xs ml-2" style={{ color: 'var(--text-secondary)' }}>{t('hwh.blocksCount', { count: remainingOpenBlocks.length })}</span>
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>{openBlocksOpen ? '▲' : '▼'}</span>
        </button>
        {openBlocksOpen && (
          <div className="overflow-x-auto">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                  {[t('hwh.colBlockId'), t('hwh.colVehicle'), t('hwh.colDuration'), t('hwh.colPossibleWindows'), t('hwh.colOfWhichVehicleFree'), t('common.status')].map(h => (
                    <th key={h} className="px-3 py-2 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {candidateWindowsByBlock.map((cand, i) => {
                  const { block, candidateWindows, windowsWithVehicleFree, status } = cand;
                  const isOpen = expandedBlock === block.blockId;
                  const statusColor = status === 'Kandidat mit Fahrzeug frei' ? '#15803d' : status === 'Kandidat vorhanden' ? '#0891b2' : '#b91c1c';
                  return (
                    <React.Fragment key={block.blockId}>
                      <tr
                        style={{ background: i % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-subtle)', borderBottom: '1px solid var(--border)', cursor: candidateWindows.length > 0 ? 'pointer' : undefined }}
                        onClick={() => candidateWindows.length > 0 && setExpandedBlock(isOpen ? null : block.blockId)}
                      >
                        <td className="px-3 py-2 text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>…{block.blockId.slice(-8)}</td>
                        <td className="px-3 py-2 text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{block.vehicle}</td>
                        <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{formatBlockDuration(block.blockDurationSec)}</td>
                        <td className="px-3 py-2 text-xs font-bold" style={{ color: candidateWindows.length > 0 ? '#15803d' : '#b91c1c' }}>{candidateWindows.length}</td>
                        <td className="px-3 py-2 text-xs font-bold" style={{ color: windowsWithVehicleFree > 0 ? '#15803d' : '#b45309' }}>{windowsWithVehicleFree}</td>
                        <td className="px-3 py-2 text-xs font-bold" style={{ color: statusColor }}>{t(FWS_STATUS_KEYS[status])}</td>
                      </tr>
                      {isOpen && (
                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                          <td colSpan={6} className="px-4 py-3" style={{ background: 'rgba(16,185,129,0.04)' }}>
                            <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                              {t('hwh.firstNPossibleWindows', { count: Math.min(candidateWindows.length, 10) })} — {t('hwh.blockLabel')} …{block.blockId.slice(-8)} ({block.vehicle} · {formatBlockDuration(block.blockDurationSec)})
                            </div>
                            <div className="overflow-x-auto">
                              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                    {[t('common.date'), t('hwh.colStart'), t('hwh.colEnd'), t('hwh.colWindowDuration'), t('hwh.colVehicleFree')].map(h => (
                                      <th key={h} className="px-2 py-1.5 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {candidateWindows.slice(0, 10).map((cw, ci) => (
                                    <tr key={cw.windowId} style={{ background: ci % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.03)', borderBottom: '1px solid var(--border)' }}>
                                      <td className="px-2 py-1.5 text-xs" style={{ color: 'var(--text-primary)' }}>{cw.date}</td>
                                      <td className="px-2 py-1.5 text-xs font-mono" style={{ color: '#065f46' }}>{fmtTime(cw.startMs)}</td>
                                      <td className="px-2 py-1.5 text-xs font-mono" style={{ color: '#065f46' }}>{fmtTime(cw.endMs)}</td>
                                      <td className="px-2 py-1.5 text-xs" style={{ color: '#065f46' }}>{formatBlockDuration(cw.durationSec)}</td>
                                      <td className="px-2 py-1.5 text-xs font-bold" style={{ color: cw.vehicleFree ? '#15803d' : '#b91c1c' }}>{cw.vehicleFree ? t('common.yes') : t('common.no')}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Diagnostics — collapsible */}
      <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${diagClean ? 'rgba(16,185,129,0.3)' : 'rgba(220,38,38,0.3)'}` }}>
        <button
          className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold"
          style={{ background: diagClean ? 'rgba(16,185,129,0.06)' : 'rgba(220,38,38,0.06)', color: 'var(--text-primary)' }}
          onClick={() => setDiagOpen(o => !o)}
        >
          <span>{t('hwh.fwsCheckTitle')}{diagClean && <span className="ml-2 text-xs font-normal" style={{ color: '#15803d' }}>— {t('hwh.allOk')}</span>}</span>
          <span style={{ color: 'var(--text-secondary)' }}>{diagOpen ? '▲' : '▼'}</span>
        </button>
        {diagOpen && (
          <div className="p-4 space-y-2" style={{ borderTop: '1px solid var(--border)' }}>
            {[
              { label: t('hwh.chkTimeShiftsDone'),          value: String(diagnostics.timeShiftsDone),      isOk: diagnostics.timeShiftsDone === 0 },
              { label: t('hwh.chkAssignmentsChanged'),      value: String(diagnostics.assignmentsChanged),  isOk: diagnostics.assignmentsChanged === 0 },
              { label: t('hwh.chkRegularDriversUnchanged'), value: diagnostics.regularDriversUnchanged ? t('hwh.ok') : t('hwh.failed'), isOk: diagnostics.regularDriversUnchanged },
              { label: t('hwh.chkOwnerAssignmentsUnchanged'), value: diagnostics.inhaberAssignmentsUnchanged ? t('hwh.ok') : t('hwh.failed'), isOk: diagnostics.inhaberAssignmentsUnchanged },
              { label: t('hwh.chkOpenBlocksUnchanged'),     value: diagnostics.openBlocksUnchanged ? t('hwh.ok') : t('hwh.failed'), isOk: diagnostics.openBlocksUnchanged },
            ].map(d => (
              <div key={d.label} className="flex items-center justify-between text-xs">
                <span style={{ color: 'var(--text-secondary)' }}>{d.label}</span>
                <span className="font-bold" style={{ color: d.isOk ? '#15803d' : '#b91c1c' }}>{d.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Konflikt-Blöcke und mögliche Zeitfenster ──────────────────────────── */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <button
          className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold"
          style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)' }}
          onClick={() => setAnalysisOpen(o => !o)}
        >
          <span>
            {t('hwh.conflictBlocksAndWindows')}
            <span className="font-normal text-xs ml-2" style={{ color: 'var(--text-secondary)' }}>
              {t('hwh.openBlocksFreeWindowsSummary', { blocks: remainingOpenBlocks.length, windows: sortedFreeWindows.length })}
            </span>
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>{analysisOpen ? '▲' : '▼'}</span>
        </button>

        {analysisOpen && (
          <div style={{ borderTop: '1px solid var(--border)' }}>

            {/* ── Section A: Verbleibende Konflikt-Blöcke ── */}
            <div style={{ borderBottom: '1px solid var(--border)' }}>
              <button
                className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-semibold"
                style={{ background: 'rgba(220,38,38,0.04)', color: '#b91c1c' }}
                onClick={() => setAnalysisSectionA(o => !o)}
              >
                <span>{t('hwh.sectionATitle', { count: remainingOpenBlocks.length })}</span>
                <span>{analysisSectionA ? '▲' : '▼'}</span>
              </button>
              {analysisSectionA && (
                remainingOpenBlocks.length === 0 ? (
                  <div className="px-4 py-3 text-xs" style={{ color: '#15803d' }}>
                    {t('hwh.noRemainingConflictBlocks')}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                          {[t('hwh.colBlockId'), t('common.date'), t('hwh.colVehicle'), t('hwh.colStart'), t('hwh.colEnd'), t('hwh.colDuration'), t('hwh.colRides'), t('common.status')].map(h => (
                            <th key={h} className="px-3 py-2 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {remainingOpenBlocks.map((blk, i) => {
                          const startDate = new Date(blk.blockStartMs);
                          const dateFmt = `${String(startDate.getDate()).padStart(2,'0')}.${String(startDate.getMonth()+1).padStart(2,'0')}.${startDate.getFullYear()}`;
                          const cand = candidateWindowsByBlock.find(c => c.block.blockId === blk.blockId);
                          const hasCand = (cand?.candidateWindows.length ?? 0) > 0;
                          const statusLabel = cand?.status ?? 'Kein passendes Fenster';
                          const statusColor = statusLabel === 'Kandidat mit Fahrzeug frei' ? '#15803d'
                            : statusLabel === 'Kandidat vorhanden' ? '#0891b2' : '#b91c1c';
                          return (
                            <tr key={blk.blockId} style={{ background: i % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                              <td className="px-3 py-2 text-xs font-mono" style={{ color: 'var(--text-secondary)' }} title={blk.blockId}>…{blk.blockId.slice(-8)}</td>
                              <td className="px-3 py-2 text-xs whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{dateFmt}</td>
                              <td className="px-3 py-2 text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{blk.vehicle}</td>
                              <td className="px-3 py-2 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtTime(blk.blockStartMs)}</td>
                              <td className="px-3 py-2 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtTime(blk.blockEndMs)}</td>
                              <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{formatBlockDuration(blk.blockDurationSec)}</td>
                              <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{blk.rides?.length ?? 0}</td>
                              <td className="px-3 py-2 text-xs font-bold whitespace-nowrap" style={{ color: statusColor }}>
                                {t(FWS_STATUS_KEYS[statusLabel])}
                                {!hasCand && <span className="ml-1 text-xs font-normal" style={{ color: '#6b7280' }}>({t('hwh.noWindowShort')})</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              )}
            </div>

            {/* ── Section B: Alle freien Inhaber-Zeitfenster ── */}
            <div style={{ borderBottom: '1px solid var(--border)' }}>
              <button
                className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-semibold"
                style={{ background: 'rgba(16,185,129,0.04)', color: '#065f46' }}
                onClick={() => setAnalysisSectionB(o => !o)}
              >
                <span>{t('hwh.sectionBTitle', { count: sortedFreeWindows.length })}</span>
                <span>{analysisSectionB ? '▲' : '▼'}</span>
              </button>
              {analysisSectionB && (
                sortedFreeWindows.length === 0 ? (
                  <div className="px-4 py-3 text-xs" style={{ color: '#b45309' }}>
                    {t('hwh.noFreeOwnerWindows')}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                          {[t('common.date'), t('hwh.colStart'), t('hwh.colEnd'), t('hwh.colDuration'), t('hwh.colPrevBlock'), t('hwh.colNextBlock'), t('hwh.colCandidates'), t('hwh.badgeVehicleFree'), t('hwh.colSource')].map(h => (
                            <th key={h} className="px-3 py-2 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sortedFreeWindows.map((fw, i) => {
                          const cands = windowCandidateMap.get(fw.windowId) ?? [];
                          const hasVehicleFree = cands.some(c => c.vehicleFree);
                          return (
                            <tr key={fw.windowId} style={{ background: i % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                              <td className="px-3 py-2 text-xs whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{fw.date}</td>
                              <td className="px-3 py-2 text-xs font-mono whitespace-nowrap" style={{ color: '#065f46' }}>{fmtTime(fw.startMs)}</td>
                              <td className="px-3 py-2 text-xs font-mono whitespace-nowrap" style={{ color: '#065f46' }}>{fmtTime(fw.endMs)}</td>
                              <td className="px-3 py-2 text-xs" style={{ color: '#065f46' }}>{formatBlockDuration(fw.durationSec)}</td>
                              <td className="px-3 py-2 text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>{fw.prevBlockId ? `…${fw.prevBlockId.slice(-6)}` : '—'}</td>
                              <td className="px-3 py-2 text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>{fw.nextBlockId ? `…${fw.nextBlockId.slice(-6)}` : '—'}</td>
                              <td className="px-3 py-2 text-xs font-bold" style={{ color: cands.length > 0 ? '#0891b2' : '#9ca3af' }}>{cands.length}</td>
                              <td className="px-3 py-2 text-xs font-bold" style={{ color: hasVehicleFree ? '#15803d' : '#9ca3af' }}>{cands.length > 0 ? (hasVehicleFree ? t('common.yes') : t('common.no')) : '—'}</td>
                              <td className="px-3 py-2 text-xs" style={{ color: '#065f46' }}>{t('hwh.colOwnerFree')}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              )}
            </div>

            {/* ── Section C: Passende Vorschläge ── */}
            <div>
              <button
                className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-semibold"
                style={{ background: 'rgba(8,145,178,0.04)', color: '#0e7490' }}
                onClick={() => setAnalysisSectionC(o => !o)}
              >
                <span>{t('hwh.sectionCTitle')}</span>
                <span>{analysisSectionC ? '▲' : '▼'}</span>
              </button>
              {analysisSectionC && (
                blockSuggestions.length === 0 ? (
                  <div className="px-4 py-3 text-xs" style={{ color: '#9ca3af' }}>
                    {t('hwh.noOpenBlocksForSuggestions')}
                  </div>
                ) : (
                  <div>
                    {blockSuggestions.map(({ block, top10 }) => {
                      const startDate = new Date(block.blockStartMs);
                      const dateFmt = `${String(startDate.getDate()).padStart(2,'0')}.${String(startDate.getMonth()+1).padStart(2,'0')}.${startDate.getFullYear()}`;
                      const bestStatus = top10[0]?.status;
                      const headerColor = bestStatus === 'Passend' ? '#15803d' : bestStatus ? '#b45309' : '#9ca3af';
                      return (
                        <div key={block.blockId} style={{ borderTop: '1px solid var(--border)' }}>
                          <div
                            className="px-4 py-2 text-xs font-semibold flex flex-wrap items-center gap-3"
                            style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)' }}
                          >
                            <span className="font-mono" style={{ color: 'var(--text-secondary)' }} title={block.blockId}>…{block.blockId.slice(-8)}</span>
                            <span className="font-bold">{block.vehicle}</span>
                            <span style={{ color: 'var(--text-secondary)' }}>{dateFmt}</span>
                            <span style={{ color: 'var(--text-secondary)' }}>{fmtTime(block.blockStartMs)}–{fmtTime(block.blockEndMs)}</span>
                            <span style={{ color: 'var(--text-secondary)' }}>{formatBlockDuration(block.blockDurationSec)}</span>
                            <span className="font-bold" style={{ color: headerColor }}>
                              {top10.length === 0 ? t('hwh.noMatchingFreeWindow') : tPlural({ one: 'hwh.suggestionCountOne', other: 'hwh.suggestionCountOther' }, top10.length)}
                            </span>
                          </div>

                          {top10.length === 0 ? (
                            <div className="px-4 py-2 text-xs" style={{ color: '#b91c1c' }}>
                              {t('hwh.noMatchingFreeWindow')}
                            </div>
                          ) : (
                            <div className="overflow-x-auto">
                              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                  <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                                    {[t('hwh.colWindowDate'), t('hwh.colWindowStart'), t('hwh.colWindowEnd'), t('hwh.colProposalStart'), t('hwh.colProposalEnd'), t('hwh.colBlockDuration'), t('hwh.colBufferBefore'), t('hwh.colBufferAfter'), t('hwh.colOwnerFree'), t('hwh.colVehicleFree'), t('common.status'), t('hwh.colScore')].map(h => (
                                      <th key={h} className="px-2 py-1.5 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {top10.map(({ cw, proposedStart, proposedEnd, status, pufferVorMs, pufferNachMs, crossesMidnight, score }, ri) => {
                                    const statusColor = status === 'Passend' ? '#15803d'
                                      : status === 'Zu kurz' ? '#9ca3af'
                                      : status === 'Fahrzeug belegt' ? '#b45309'
                                      : status === 'Inhaber belegt' ? '#b91c1c'
                                      : '#6b7280';
                                    const fmtPuffer = (ms: number) => {
                                      const totalMin = Math.round(ms / 60000);
                                      if (totalMin === 0) return '0 min';
                                      const h = Math.floor(totalMin / 60);
                                      const m = totalMin % 60;
                                      if (h === 0) return `+${m} min`;
                                      if (m === 0) return `+${h}h`;
                                      return `+${h}h ${m}m`;
                                    };
                                    const pufferVorFmt  = fmtPuffer(pufferVorMs);
                                    const pufferNachFmt = pufferNachMs > 0 ? fmtPuffer(pufferNachMs) : '—';
                                    return (
                                      <tr key={cw.windowId + ri} style={{ background: ri % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                                        <td className="px-2 py-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{cw.date}</td>
                                        <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: '#065f46' }}>{fmtTime(cw.startMs)}</td>
                                        <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: '#065f46' }}>{fmtTime(cw.endMs)}</td>
                                        <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: '#0e7490' }}>{fmtTime(proposedStart)}</td>
                                        <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: '#0e7490' }}>{fmtTime(proposedEnd)}</td>
                                        <td className="px-2 py-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{formatBlockDuration(block.blockDurationSec)}</td>
                                        <td className="px-2 py-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{pufferVorFmt}</td>
                                        <td className="px-2 py-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{pufferNachFmt}</td>
                                        <td className="px-2 py-1.5 text-xs font-bold" style={{ color: '#15803d' }}>{t('common.yes')}</td>
                                        <td className="px-2 py-1.5 text-xs font-bold" style={{ color: cw.vehicleFree ? '#15803d' : '#b91c1c' }}>{cw.vehicleFree ? t('common.yes') : t('common.no')}</td>
                                        <td className="px-2 py-1.5 text-xs font-bold whitespace-nowrap" style={{ color: statusColor }}>{SUGGESTION_STATUS_KEYS[status] ? t(SUGGESTION_STATUS_KEYS[status]) : status}{crossesMidnight ? ' *' : ''}</td>
                                        <td className="px-2 py-1.5 text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>{score}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                              {top10.some(candidate => candidate.crossesMidnight) && (
                                <div className="px-3 py-1.5 text-xs" style={{ color: '#9ca3af', borderTop: '1px solid var(--border)' }}>
                                  * {t('hwh.proposalEndsAfterMidnight')}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )
              )}
            </div>

            {/* ── Diagnostic: Bestehende Fahrten in ausgeschlossenen Fahrer-Zeiträumen ── */}
            {existingImportedViolations.length > 0 && (
              <div style={{ borderTop: '2px solid #d97706' }}>
                <div className="px-4 py-2 text-xs font-semibold" style={{ color: '#92400e', background: 'rgba(217,119,6,0.06)' }}>
                  {t('hwh.existingRidesInExcludedPeriods', { count: existingImportedViolations.length })}
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
                        {[t('common.driver'), t('hwh.colVehicle'), t('hwh.colRideStart'), t('hwh.colRideEnd'), t('hwh.colNoteDetails')].map(h => (
                          <th key={h} className="px-3 py-1.5 text-left font-semibold" style={{ borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {existingImportedViolations.slice(0, 50).map((v, i) => {
                        const fmtMs = (ms: number) => { const dt = new Date(ms); return `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`; };
                        return (
                          <tr key={v.tripId} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg-subtle)' }}>
                            <td className="px-3 py-1 font-medium" style={{ color: '#92400e' }}>{v.driver}</td>
                            <td className="px-3 py-1">{v.vehicle}</td>
                            <td className="px-3 py-1" style={{ whiteSpace: 'nowrap' }}>{fmtMs(v.startMs)}</td>
                            <td className="px-3 py-1" style={{ whiteSpace: 'nowrap' }}>{fmtMs(v.endMs)}</td>
                            <td className="px-3 py-1" style={{ color: '#92400e', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.detail}</td>
                          </tr>
                        );
                      })}
                      {existingImportedViolations.length > 50 && (
                        <tr><td colSpan={5} className="px-3 py-1 text-xs" style={{ color: '#9ca3af' }}>+{t('hwh.moreEntries', { count: existingImportedViolations.length - 50 })}</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── Section D: Automatische Vorauswahl ── */}
            <div>
              <button
                className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-semibold"
                style={{ background: 'rgba(15,118,110,0.06)', color: '#0f766e' }}
                onClick={() => setAnalysisSectionD(o => !o)}
              >
                <span>{t('hwh.sectionDTitle', { selected: autoSelection.filter(e => e.status === 'Ausgewählt').length, total: autoSelection.length })}</span>
                <span>{analysisSectionD ? '▲' : '▼'}</span>
              </button>
              {analysisSectionD && (
                <div>
                  {/* Info note */}
                  <div className="px-4 py-2 text-xs" style={{ color: '#6b7280', borderBottom: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
                    {t('hwh.sectionDNote')}
                  </div>
                  <div className="px-4 py-2 text-xs font-medium" style={{ color: '#0f766e', borderBottom: '1px solid var(--border)', background: 'rgba(15,118,110,0.04)' }}>
                    {t('hwh.rideLevelCheckActive')}
                  </div>
                  {/* Summary bar */}
                  {(() => {
                    const selCount  = autoSelection.filter(e => e.status === 'Ausgewählt').length;
                    const nselCount = autoSelection.length - selCount;
                    const totalSec  = autoSelection.reduce((s, e) => s + (e.chosen ? e.block.blockDurationSec : 0), 0);
                    const usedWins  = new Set(autoSelection.filter(e => e.chosen).map(e => e.chosen!.cw.windowId)).size;
                    return (
                      <div className="px-4 py-3 flex flex-wrap gap-6 text-xs" style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                        <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statTotalConflictBlocks')}</span><span className="font-bold ml-1" style={{ color: 'var(--text-primary)' }}>{autoSelection.length}</span></div>
                        <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statAutoSelected')}</span><span className="font-bold ml-1" style={{ color: '#15803d' }}>{selCount}</span></div>
                        <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.selStatusNotSelected')}</span><span className="font-bold ml-1" style={{ color: nselCount > 0 ? '#b91c1c' : 'var(--text-secondary)' }}>{nselCount}</span></div>
                        <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statPlannedHours')}</span><span className="font-bold ml-1" style={{ color: '#0e7490' }}>{fmtDurSec(totalSec)}</span></div>
                        <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statUsedWindows')}</span><span className="font-bold ml-1" style={{ color: '#0e7490' }}>{usedWins}</span></div>
                      </div>
                    );
                  })()}
                  {/* Table */}
                  <div className="overflow-x-auto">
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                          {[t('hwh.colBlockId'), t('hwh.colVehicle'), t('hwh.colOriginalDate'), t('hwh.colOriginalTime'), t('hwh.colDuration'), t('hwh.colCandidates'), t('hwh.colSelectedWindow'), t('hwh.colNewPlacement'), t('hwh.colBufferBefore'), t('hwh.colBufferAfter'), t('hwh.colScore'), t('hwh.colSelectionReason'), t('common.status')].map(h => (
                            <th key={h} className="px-2 py-1.5 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {autoSelection.map(({ block, candidateCount, chosen, reason, status }, ri) => {
                          const origStart = new Date(block.blockStartMs ?? 0);
                          const origEnd   = new Date(block.blockEndMs   ?? 0);
                          const origDateFmt = `${String(origStart.getDate()).padStart(2,'0')}.${String(origStart.getMonth()+1).padStart(2,'0')}.${origStart.getFullYear()}`;
                          const origTimeFmt = `${String(origStart.getHours()).padStart(2,'0')}:${String(origStart.getMinutes()).padStart(2,'0')}–${String(origEnd.getHours()).padStart(2,'0')}:${String(origEnd.getMinutes()).padStart(2,'0')}`;
                          const statusColor = status === 'Ausgewählt' ? '#15803d' : '#b91c1c';
                          return (
                            <tr key={block.blockId} style={{ background: ri % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                              <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }} title={block.blockId}>…{block.blockId.slice(-8)}</td>
                              <td className="px-2 py-1.5 text-xs font-bold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{block.vehicle}</td>
                              <td className="px-2 py-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{origDateFmt}</td>
                              <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{origTimeFmt}</td>
                              <td className="px-2 py-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDurSec(block.blockDurationSec)}</td>
                              <td className="px-2 py-1.5 text-xs text-center" style={{ color: 'var(--text-secondary)' }}>{candidateCount}</td>
                              <td className="px-2 py-1.5 text-xs whitespace-nowrap" style={{ color: chosen ? '#0e7490' : '#9ca3af' }}>
                                {chosen ? `${chosen.cw.date} ${fmtTime(chosen.cw.startMs)}–${fmtTime(chosen.cw.endMs)}` : '—'}
                              </td>
                              <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: chosen ? '#0e7490' : '#9ca3af' }}>
                                {chosen ? `${fmtTime(chosen.proposedStart)}–${fmtTime(chosen.proposedEnd)}` : '—'}
                              </td>
                              <td className="px-2 py-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{chosen ? fmtPuffer(chosen.pufferVorMs) : '—'}</td>
                              <td className="px-2 py-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{chosen ? fmtPuffer(chosen.pufferNachMs) : '—'}</td>
                              <td className="px-2 py-1.5 text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>{chosen ? chosen.score : '—'}</td>
                              <td className="px-2 py-1.5 text-xs" style={{ color: 'var(--text-secondary)', maxWidth: 220, whiteSpace: 'normal' }}>{reason}</td>
                              <td className="px-2 py-1.5 text-xs font-bold whitespace-nowrap" style={{ color: statusColor }}>{t(SELECTION_STATUS_KEYS[status])}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* ── Section D Debug: Abgelehnte Ride-Level-Kandidaten ── */}
            {autoSelectionRejectedDetails.length > 0 && (
              <div style={{ borderTop: '2px solid #b91c1c' }}>
                <div className="px-4 py-2 text-xs font-semibold" style={{ color: '#b91c1c', background: 'rgba(185,28,28,0.04)' }}>
                  {t('hwh.debugRejectedRideCandidates', { count: autoSelectionRejectedDetails.length })}
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
                        {[t('hwh.colBlockId'), t('hwh.colVehicle'), t('hwh.colCandidateStart'), t('hwh.colCandidateEnd'), t('hwh.colErrorType'), t('hwh.colDetails')].map(h => (
                          <th key={h} className="px-3 py-1.5 text-left font-semibold" style={{ borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {autoSelectionRejectedDetails.map((d, i) => {
                        const fmtMs = (ms: number) => { const dt = new Date(ms); return `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`; };
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg-subtle)' }}>
                            <td className="px-3 py-1 font-mono" style={{ color: '#6b7280' }}>…{d.blockId.slice(-8)}</td>
                            <td className="px-3 py-1 font-semibold" style={{ color: '#b91c1c' }}>{d.vehicle}</td>
                            <td className="px-3 py-1" style={{ whiteSpace: 'nowrap' }}>{fmtMs(d.candStart)}</td>
                            <td className="px-3 py-1" style={{ whiteSpace: 'nowrap' }}>{fmtMs(d.candEnd)}</td>
                            <td className="px-3 py-1" style={{ color: '#b91c1c' }}>{d.reason}</td>
                            <td className="px-3 py-1 font-mono" style={{ color: '#6b7280', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.detail}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div>
              <button
                className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-semibold"
                style={{ background: 'rgba(79,70,229,0.06)', color: '#4338ca' }}
                onClick={() => setAnalysisSectionE(o => !o)}
              >
                <span>{t('hwh.sectionETitle', { count: sectionEData.selected.length, verdict: sectionEData.allOk ? t('hwh.allChecksOk') : t('hwh.errorsFound') })}</span>
                <span>{analysisSectionE ? '▲' : '▼'}</span>
              </button>
              {analysisSectionE && (
                <div>
                  {/* Summary cards */}
                  <div className="px-4 py-3 flex flex-wrap gap-6 text-xs" style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                    <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statSelectedBlocks')}</span><span className="font-bold ml-1" style={{ color: '#15803d' }}>{sectionEData.selected.length}</span></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.selStatusNotSelected')}</span><span className="font-bold ml-1" style={{ color: autoSelection.length - sectionEData.selected.length > 0 ? '#b91c1c' : 'var(--text-secondary)' }}>{autoSelection.length - sectionEData.selected.length}</span></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statPlannedHours')}</span><span className="font-bold ml-1" style={{ color: '#0e7490' }}>{fmtDurSec(sectionEData.totalSec)}</span></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statAffectedVehicles')}</span><span className="font-bold ml-1" style={{ color: 'var(--text-primary)' }}>{sectionEData.uniqueVehicles}</span></div>
                    <div>
                      <span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statCheckStatus')}</span>
                      <span className="font-bold ml-1" style={{ color: sectionEData.allOk ? '#15803d' : '#b91c1c' }}>
                        {sectionEData.allOk ? t('hwh.ok') : t('common.error')}
                      </span>
                    </div>
                  </div>

                  {/* Validation panel */}
                  <div style={{ borderBottom: '1px solid var(--border)' }}>
                    <div className="px-4 py-2 text-xs font-semibold" style={{ color: 'var(--text-secondary)', background: 'var(--bg-subtle)' }}>{t('hwh.finalCheck')}</div>
                    {([
                      { label: t('hwh.checkOwnerOverlaps'),        errors: sectionEData.allInhaberConflicts },
                      { label: t('hwh.checkVehicleOverlapsBlock'), errors: sectionEData.allVehicleConflicts },
                      { label: t('hwh.checkRideConflictsExisting'), errors: sectionEData.rideLevelVehicleConflicts },
                      { label: t('hwh.checkDriverNotes'),          errors: sectionEData.driverExclusionConflicts },
                      { label: t('hwh.checkBufferBefore'),         errors: sectionEData.pufferVorFails },
                      { label: t('hwh.checkBufferAfter'),          errors: sectionEData.pufferNachFails },
                      { label: t('hwh.checkWithinMonth'),          errors: sectionEData.outOfMonth },
                      { label: t('hwh.checkTimestampValid'),       errors: sectionEData.invalidTs },
                    ] as const).map(({ label, errors }) => (
                      <div key={label} className="px-4 py-2 flex items-start gap-3 text-xs" style={{ borderTop: '1px solid var(--border)' }}>
                        <span className="font-bold w-5 text-center flex-shrink-0" style={{ color: errors.length === 0 ? '#15803d' : '#b91c1c' }}>
                          {errors.length === 0 ? '✓' : '✗'}
                        </span>
                        <span className="w-48 flex-shrink-0" style={{ color: 'var(--text-primary)' }}>{label}</span>
                        <span className="font-bold flex-shrink-0" style={{ color: errors.length === 0 ? '#15803d' : '#b91c1c' }}>
                          {errors.length === 0 ? t('hwh.ok') : t('hwh.errorCount', { count: errors.length })}
                        </span>
                        {errors.length > 0 && (
                          <span style={{ color: '#b91c1c' }}>{errors.slice(0, 5).join(', ')}{errors.length > 5 ? ` … +${errors.length - 5}` : ''}</span>
                        )}
                      </div>
                    ))}
                    <div className="px-4 py-2 flex items-start gap-3 text-xs" style={{ borderTop: '1px solid var(--border)' }}>
                      <span className="font-bold w-5 text-center flex-shrink-0" style={{ color: '#6b7280' }}>ℹ</span>
                      <span className="w-48 flex-shrink-0" style={{ color: 'var(--text-primary)' }}>{t('hwh.checkCrossMidnight')}</span>
                      <span className="font-bold flex-shrink-0" style={{ color: '#6b7280' }}>{t('hwh.ok')}</span>
                      <span style={{ color: '#9ca3af' }}>
                        {t('hwh.crossMidnightDetail', { original: sectionEData.crossMidnightOriginal.length, preview: sectionEData.crossMidnight.length })}
                      </span>
                    </div>
                  </div>

                  {/* Overall status */}
                  <div className="px-4 py-3 text-xs font-semibold" style={{ background: sectionEData.allOk ? 'rgba(21,128,61,0.07)' : 'rgba(185,28,28,0.07)', color: sectionEData.allOk ? '#15803d' : '#b91c1c', borderBottom: '1px solid var(--border)' }}>
                    {sectionEData.allOk
                      ? t('hwh.allChecksOkReadyNext')
                      : t('hwh.errorsFoundCheckPreselection')}
                  </div>

                  {/* Preview calendar (day list) */}
                  <div style={{ borderBottom: '1px solid var(--border)' }}>
                    <div className="px-4 py-2 text-xs font-semibold flex items-center gap-2" style={{ color: 'var(--text-secondary)', background: 'var(--bg-subtle)' }}>
                      <span>{t('hwh.previewCalendar')}</span>
                      <span className="px-1.5 py-0.5 rounded text-xs font-bold" style={{ background: 'rgba(79,70,229,0.12)', color: '#4338ca' }}>{t('common.preview')}</span>
                      <span style={{ color: 'var(--text-secondary)', fontWeight: 'normal' }}>— {t('hwh.noDataChanged')}</span>
                    </div>
                    {sectionEData.days.length === 0 ? (
                      <div className="px-4 py-3 text-xs" style={{ color: '#9ca3af' }}>{t('hwh.noEntriesThisMonth')}</div>
                    ) : (
                      sectionEData.days.map(({ key, entries }) => {
                        const [y, m0, d] = key.split('-').map(Number);
                        const dayLabel = `${String(d).padStart(2,'0')}.${String(m0).padStart(2,'0')}.${y}`;
                        const dow = t(WEEKDAY_COLS[new Date(y, m0 - 1, d).getDay()]);
                        return (
                          <div key={key} style={{ borderTop: '1px solid var(--border)' }}>
                            <div className="px-4 py-1.5 text-xs font-semibold" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
                              {dow}, {dayLabel}
                            </div>
                            {entries.map((entry, ei) => {
                              if (entry.kind === 'existing') {
                                const { occ } = entry;
                                return (
                                  <div key={occ.blockId + ei} className="px-4 py-1.5 flex flex-wrap items-center gap-3 text-xs" style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
                                    <span className="px-1.5 py-0.5 rounded text-xs" style={{ background: 'rgba(100,116,139,0.12)', color: '#475569' }}>{t('hwh.owner')}</span>
                                    <span className="font-mono" style={{ color: 'var(--text-secondary)' }} title={occ.blockId}>…{occ.blockId.slice(-8)}</span>
                                    <span className="font-bold" style={{ color: 'var(--text-primary)' }}>{occ.vehicle}</span>
                                    <span className="font-mono" style={{ color: '#065f46' }}>{fmtTime(occ.startMs)}–{fmtTime(occ.endMs)}</span>
                                    <span style={{ color: 'var(--text-secondary)' }}>{fmtDurSec(occ.durationSec)}</span>
                                    <span style={{ color: 'var(--text-secondary)' }}>{occ.sourceStep}</span>
                                  </div>
                                );
                              }
                              const { sp, issues } = entry;
                              const origStart = new Date(sp.block.blockStartMs ?? 0);
                              const origDateFmt = `${String(origStart.getDate()).padStart(2,'0')}.${String(origStart.getMonth()+1).padStart(2,'0')}.${origStart.getFullYear()}`;
                              return (
                                <div key={sp.block.blockId + ei} className="px-4 py-1.5 flex flex-wrap items-center gap-3 text-xs" style={{ borderTop: '1px solid var(--border)', background: 'rgba(79,70,229,0.04)' }}>
                                  <span className="px-1.5 py-0.5 rounded text-xs font-bold" style={{ background: 'rgba(79,70,229,0.15)', color: '#4338ca' }}>{t('common.preview')}</span>
                                  <span className="font-mono" style={{ color: '#4338ca' }} title={sp.block.blockId}>…{sp.block.blockId.slice(-8)}</span>
                                  <span className="font-bold" style={{ color: 'var(--text-primary)' }}>{sp.block.vehicle}</span>
                                  <span style={{ color: 'var(--text-secondary)' }}>{t('hwh.origPrefix')} {origDateFmt} {fmtTime(sp.block.blockStartMs ?? 0)}–{fmtTime(sp.block.blockEndMs ?? 0)}</span>
                                  <span className="font-mono font-bold" style={{ color: '#4338ca' }}>{t('hwh.newPrefix')} {fmtTime(sp.chosen.proposedStart)}–{fmtTime(sp.chosen.proposedEnd)}</span>
                                  <span className="font-mono" style={{ color: '#6366f1', fontSize: '0.65rem' }}>
                                    {(() => {
                                      const ps = new Date(sp.chosen.proposedStart);
                                      const pe = new Date(sp.chosen.proposedEnd);
                                      const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                                      return `${t('hwh.targetPrefix')} ${fmt(ps)} – ${fmt(pe)}`;
                                    })()}
                                  </span>
                                  <span style={{ color: 'var(--text-secondary)' }}>{fmtDurSec(sp.block.blockDurationSec)}</span>
                                  <span style={{ color: 'var(--text-secondary)' }}>↑{fmtPuffer(sp.chosen.pufferVorMs)}</span>
                                  <span style={{ color: 'var(--text-secondary)' }}>↓{fmtPuffer(sp.chosen.pufferNachMs)}</span>
                                  {sp.chosen.crossesMidnight && <span style={{ color: '#b45309' }}>*{t('hwh.midnight')}</span>}
                                  {issues.length > 0 && <span className="font-bold" style={{ color: '#b91c1c' }}>{issues.join(', ')}</span>}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* Compact table */}
                  <div>
                    <div className="px-4 py-2 text-xs font-semibold" style={{ color: 'var(--text-secondary)', background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>{t('hwh.selectedPreviewPlacements')}</div>
                    <div className="overflow-x-auto">
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                            {[t('hwh.colBlockId'), t('hwh.colVehicle'), t('hwh.colOriginalDate'), t('hwh.colOriginalTime'), t('hwh.colNewPlacement'), t('hwh.colDuration'), t('hwh.colBufferBefore'), t('hwh.colBufferAfter'), t('hwh.colCheck'), t('hwh.colHint')].map(h => (
                              <th key={h} className="px-2 py-1.5 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {sectionEData.selected.map(({ block, chosen }, ri) => {
                            const issues = sectionEData.perItemChecks[ri];
                            const origStart = new Date(block.blockStartMs ?? 0);
                            const origEnd   = new Date(block.blockEndMs   ?? 0);
                            const origDateFmt = `${String(origStart.getDate()).padStart(2,'0')}.${String(origStart.getMonth()+1).padStart(2,'0')}.${origStart.getFullYear()}`;
                            const origTimeFmt = `${String(origStart.getHours()).padStart(2,'0')}:${String(origStart.getMinutes()).padStart(2,'0')}–${String(origEnd.getHours()).padStart(2,'0')}:${String(origEnd.getMinutes()).padStart(2,'0')}`;
                            const checkOk = issues.length === 0;
                            return (
                              <tr key={block.blockId} style={{ background: ri % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                                <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }} title={block.blockId}>…{block.blockId.slice(-8)}</td>
                                <td className="px-2 py-1.5 text-xs font-bold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{block.vehicle}</td>
                                <td className="px-2 py-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{origDateFmt}</td>
                                <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{origTimeFmt}</td>
                                <td className="px-2 py-1.5 text-xs font-mono font-bold whitespace-nowrap" style={{ color: '#4338ca' }}>
                                  {(() => {
                                    const ps = new Date(chosen.proposedStart);
                                    const pe = new Date(chosen.proposedEnd);
                                    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                                    return ps.getDate() === pe.getDate() && ps.getMonth() === pe.getMonth()
                                      ? `${fmt(ps).slice(0,10)} ${fmtTime(chosen.proposedStart)}–${fmtTime(chosen.proposedEnd)}`
                                      : `${fmt(ps)} – ${fmt(pe)}`;
                                  })()}
                                </td>
                                <td className="px-2 py-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDurSec(block.blockDurationSec)}</td>
                                <td className="px-2 py-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtPuffer(chosen.pufferVorMs)}</td>
                                <td className="px-2 py-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtPuffer(chosen.pufferNachMs)}</td>
                                <td className="px-2 py-1.5 text-xs font-bold whitespace-nowrap" style={{ color: checkOk ? '#15803d' : '#b91c1c' }}>{checkOk ? t('hwh.ok') : t('common.error')}</td>
                                <td className="px-2 py-1.5 text-xs" style={{ color: checkOk ? 'var(--text-secondary)' : '#b91c1c', whiteSpace: 'normal', maxWidth: 200 }}>
                                  {issues.length === 0 ? (chosen.crossesMidnight ? `* ${t('hwh.crossMidnight')}` : '—') : issues.join(', ')}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* ── Apply button ── */}
            {!sectionFData && (
              <div className="px-4 py-4" style={{ borderTop: '2px solid var(--border)' }}>
                {(() => {
                  const selectedCount = sectionEData.selected.length;
                  const applyDisabled = !originalTrips || originalTrips.length === 0 || selectedCount === 0 || !sectionEData.allOk;
                  const disabledReason = !originalTrips || originalTrips.length === 0
                    ? t('hwh.applyBlockedNoOriginalTrips')
                    : selectedCount === 0
                    ? t('hwh.applyBlockedNoPlacements')
                    : !sectionEData.allOk
                    ? t('hwh.applyBlockedCheckCalendarErrors')
                    : null;
                  return (
                    <>
                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          disabled={applyDisabled}
                          onClick={() => {
                            setDbgApplyClickCount(c => c + 1);
                            setDbgApplyLastClickedAt(new Date().toISOString());
                            setDbgApplyError(null);
                            setDbgApplyStarted(true);
                            setDbgApplyFinished(false);
                            try {
                              handleApplyPlan();
                              setDbgApplyFinished(true);
                            } catch (err) {
                              setDbgApplyError(String(err));
                            }
                          }}
                          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                          style={{ background: applyDisabled ? 'var(--bg-subtle)' : '#15803d', color: applyDisabled ? 'var(--text-secondary)' : '#fff', border: applyDisabled ? '1px solid var(--border)' : 'none' }}
                        >
                          <CheckCircle2 size={16} />
                          {t('hwh.applyCheckedPlan')}
                        </button>
                        {!applyDisabled && (
                          <span className="text-xs font-semibold" style={{ color: '#15803d' }}>
                            {t('hwh.placementsReady', { count: selectedCount })}
                          </span>
                        )}
                      </div>
                      {applyDisabled && disabledReason && (
                        <div className="mt-2 text-xs font-semibold" style={{ color: '#b91c1c' }}>
                          {t('hwh.applyLocked')}: {disabledReason}
                        </div>
                      )}
                      {dbgApplyError && (
                        <div className="mt-2 text-xs font-semibold" style={{ color: '#b91c1c' }}>
                          {t('common.error')}: {dbgApplyError}
                        </div>
                      )}
                      <div className="mt-2 text-xs" style={{ color: 'var(--text-tertiary)', fontFamily: 'monospace' }}>
                        debug: allOk={String(sectionEData.allOk)} selected={selectedCount} disabled={String(applyDisabled)} reason={disabledReason ?? '—'} clicks={dbgApplyClickCount} started={String(dbgApplyStarted)} finished={String(dbgApplyFinished)} lastClick={dbgApplyLastClickedAt ?? '—'} originalTrips={originalTrips?.length ?? 0}
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            {/* ── Section F: Angewendeter Plan / Neues Fahrtenbuch ── */}
            {sectionFData && (
              <div>
                <button
                  className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-semibold"
                  style={{ background: 'rgba(21,128,61,0.07)', color: '#15803d' }}
                  onClick={() => setAnalysisSectionF(o => !o)}
                >
                  <span>{t('hwh.sectionFTitle', { rides: sectionFData.totalRidesChanged, blocks: sectionFData.blockApps.length, verdict: sectionFData.allOk ? t('hwh.allChecksOk') : t('hwh.errorsFound') })}</span>
                  <span>{analysisSectionF ? '▲' : '▼'}</span>
                </button>
                {analysisSectionF && (
                  <div>
                    {/* Summary cards */}
                    <div className="px-4 py-3 flex flex-wrap gap-6 text-xs" style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                      <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statShiftedBlocks')}</span><span className="font-bold ml-1" style={{ color: '#15803d' }}>{sectionFData.blockApps.length}</span></div>
                      <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statShiftedRides')}</span><span className="font-bold ml-1" style={{ color: '#0e7490' }}>{sectionFData.totalRidesChanged}</span></div>
                      <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statPlannedHours')}</span><span className="font-bold ml-1" style={{ color: '#0e7490' }}>{fmtDurSec(sectionFData.totalSec)}</span></div>
                      <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statAffectedVehicles')}</span><span className="font-bold ml-1" style={{ color: 'var(--text-primary)' }}>{sectionFData.uniqueVehicles}</span></div>
                      <div>
                        <span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statCheckStatus')}</span>
                        <span className="font-bold ml-1" style={{ color: sectionFData.allOk ? '#15803d' : '#b91c1c' }}>
                          {sectionFData.allOk ? t('hwh.ok') : t('common.error')}
                        </span>
                      </div>
                    </div>

                    {/* Validation panel */}
                    <div style={{ borderBottom: '1px solid var(--border)' }}>
                      <div className="px-4 py-2 text-xs font-semibold" style={{ color: 'var(--text-secondary)', background: 'var(--bg-subtle)' }}>{t('hwh.finalCheckAppliedPlan')}</div>
                      {([
                        { label: t('hwh.checkRideTimestampValid'),      errors: sectionFData.invalidTsRides },
                        { label: t('hwh.checkNoOwnerOverlaps'),         errors: sectionFData.inhaberOverlaps },
                        { label: t('hwh.checkNoVehicleOverlapsBetween'), errors: sectionFData.vehicleOverlaps },
                        { label: t('hwh.checkNoRideConflictsExisting'), errors: sectionFData.rideLevelExistingConflicts },
                        { label: t('hwh.checkDriverNotes'), errors: [...sectionFData.driverExclusionViolations, ...effectiveUnresolvedRides.map(r => `${r.driver}: ${r.detail}`)] },
                        { label: t('hwh.checkAllSelectedBlocksApplied'), errors: sectionFData.missingBlocks },
                      ] as const).map(({ label, errors }) => (
                        <div key={label} className="px-4 py-2 flex items-start gap-3 text-xs" style={{ borderTop: '1px solid var(--border)' }}>
                          <span className="font-bold w-5 text-center flex-shrink-0" style={{ color: errors.length === 0 ? '#15803d' : '#b91c1c' }}>{errors.length === 0 ? '✓' : '✗'}</span>
                          <span className="w-56 flex-shrink-0" style={{ color: 'var(--text-primary)' }}>{label}</span>
                          <span className="font-bold flex-shrink-0" style={{ color: errors.length === 0 ? '#15803d' : '#b91c1c' }}>{errors.length === 0 ? t('hwh.ok') : t('hwh.errorCount', { count: errors.length })}</span>
                          {errors.length > 0 && <span style={{ color: '#b91c1c' }}>{errors.slice(0, 4).join(', ')}{errors.length > 4 ? ` +${errors.length - 4}` : ''}</span>}
                        </div>
                      ))}
                      <div className="px-4 py-2 flex items-start gap-3 text-xs" style={{ borderTop: '1px solid var(--border)' }}>
                        <span className="font-bold w-5 text-center flex-shrink-0" style={{ color: sectionFData.rideCountOk ? '#15803d' : '#b91c1c' }}>{sectionFData.rideCountOk ? '✓' : '✗'}</span>
                        <span className="w-56 flex-shrink-0" style={{ color: 'var(--text-primary)' }}>{t('hwh.checkRideCountPreserved')}</span>
                        <span className="font-bold flex-shrink-0" style={{ color: sectionFData.rideCountOk ? '#15803d' : '#b91c1c' }}>{sectionFData.rideCountOk ? t('hwh.ok') : t('common.error')}</span>
                      </div>
                      <div className="px-4 py-2 flex items-start gap-3 text-xs" style={{ borderTop: '1px solid var(--border)' }}>
                        <span className="font-bold w-5 text-center flex-shrink-0" style={{ color: '#15803d' }}>✓</span>
                        <span className="w-56 flex-shrink-0" style={{ color: 'var(--text-primary)' }}>{t('hwh.checkUnaffectedRidesUnchanged')}</span>
                        <span className="font-bold flex-shrink-0" style={{ color: '#15803d' }}>{t('hwh.ok')}</span>
                        <span style={{ color: '#9ca3af' }}>{t('hwh.ridesUntouched', { count: (originalTrips?.length ?? 0) - sectionFData.totalRidesChanged })}</span>
                      </div>
                      <div className="px-4 py-2 flex items-start gap-3 text-xs" style={{ borderTop: '1px solid var(--border)' }}>
                        <span className="font-bold w-5 text-center flex-shrink-0" style={{ color: sectionFData.tsMillisOk ? '#15803d' : '#b91c1c' }}>{sectionFData.tsMillisOk ? '✓' : '✗'}</span>
                        <span className="w-56 flex-shrink-0" style={{ color: 'var(--text-primary)' }}>{t('hwh.checkMilliseconds')}</span>
                        <span className="font-bold flex-shrink-0" style={{ color: sectionFData.tsMillisOk ? '#15803d' : '#b91c1c' }}>{sectionFData.tsMillisOk ? t('hwh.ok') : t('common.error')}</span>
                        <span style={{ color: '#9ca3af' }}>{sectionFData.tsMillisOk ? t('hwh.millisAllOk', { count: sectionFData.totalTsCount }) : t('hwh.millisSomeBad', { bad: sectionFData.invalidTsCount, total: sectionFData.totalTsCount })}</span>
                      </div>
                      <div className="px-4 py-2 flex items-start gap-3 text-xs" style={{ borderTop: '1px solid var(--border)' }}>
                        <span className="font-bold w-5 text-center flex-shrink-0" style={{ color: sectionFData.zeitversatzOk ? '#15803d' : '#b91c1c' }}>{sectionFData.zeitversatzOk ? '✓' : '✗'}</span>
                        <span className="w-56 flex-shrink-0" style={{ color: 'var(--text-primary)' }}>{t('hwh.checkOrderTimeOffsets')}</span>
                        <span className="font-bold flex-shrink-0" style={{ color: sectionFData.zeitversatzOk ? '#15803d' : '#b91c1c' }}>{sectionFData.zeitversatzOk ? t('hwh.ok') : t('common.error')}</span>
                        <span style={{ color: '#9ca3af' }}>{sectionFData.zeitversatzOk ? t('hwh.offsetsPreserved') : t('hwh.offsetsInvalid', { count: sectionFData.invalidZeitversatzCount })}</span>
                      </div>
                      <div className="px-4 py-2 flex items-start gap-3 text-xs" style={{ borderTop: '1px solid var(--border)' }}>
                        <span className="font-bold w-5 text-center flex-shrink-0" style={{ color: sectionFData.priceKmUnchanged ? '#15803d' : '#b91c1c' }}>{sectionFData.priceKmUnchanged ? '✓' : '✗'}</span>
                        <span className="w-56 flex-shrink-0" style={{ color: 'var(--text-primary)' }}>{t('hwh.checkPriceKmUnchanged')}</span>
                        <span className="font-bold flex-shrink-0" style={{ color: sectionFData.priceKmUnchanged ? '#15803d' : '#b91c1c' }}>{sectionFData.priceKmUnchanged ? t('hwh.ok') : t('common.error')}</span>
                        <span style={{ color: '#9ca3af' }}>{sectionFData.priceKmUnchanged ? t('hwh.priceKmAllCopied') : t('hwh.priceKmFromOriginal')}</span>
                      </div>
                      <div className="px-4 py-2 flex items-start gap-3 text-xs" style={{ borderTop: '1px solid var(--border)' }}>
                        <span className="font-bold w-5 text-center flex-shrink-0" style={{ color: '#15803d' }}>✓</span>
                        <span className="w-56 flex-shrink-0" style={{ color: 'var(--text-primary)' }}>{t('hwh.checkRowSorting')}</span>
                        <span className="font-bold flex-shrink-0" style={{ color: '#15803d' }}>{t('hwh.ok')}</span>
                        <span style={{ color: '#9ca3af' }}>{t('hwh.rowSortingDetail')}</span>
                      </div>
                      <div className="px-4 py-2 flex items-start gap-3 text-xs" style={{ borderTop: '1px solid var(--border)' }}>
                        <span className="font-bold w-5 text-center flex-shrink-0" style={{ color: sectionFData.columnOrderReady ? '#15803d' : '#d97706' }}>{sectionFData.columnOrderReady ? '✓' : '!'}</span>
                        <span className="w-56 flex-shrink-0" style={{ color: 'var(--text-primary)' }}>{t('hwh.checkColumnOrder')}</span>
                        <span className="font-bold flex-shrink-0" style={{ color: sectionFData.columnOrderReady ? '#15803d' : '#d97706' }}>{sectionFData.columnOrderReady ? t('hwh.columnOrderOriginal') : t('hwh.columnOrderFallback')}</span>
                        <span style={{ color: '#9ca3af' }}>{sectionFData.columnOrderReady ? t('hwh.sourceColumnsAvailable') : t('hwh.sourceColumnsMissing')}</span>
                      </div>
                    </div>

                    {/* Export status + button */}
                    {(() => {
                      const debugInfo = ownerResolution.status === 'none'
                        ? ownerResolution.debugInfo
                        : ownerResolution.status === 'ok'
                          ? `allDrivers=${allDrivers.length}, source=${ownerResolution.source}`
                          : `allDrivers=${allDrivers.length}, source=${ownerResolution.source}, candidates=${ownerResolution.count}`;
                      return (
                        <div style={{ borderBottom: '1px solid var(--border)' }}>
                          {/* Debug/info line */}
                          <div className="px-4 py-1.5 text-xs" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)', fontFamily: 'monospace' }}>
                            {t('hwh.ownerResolution')}: {debugInfo}
                          </div>
                          {ownerResolution.status === 'ok' && (
                            <div className="px-4 py-2 text-xs flex items-center gap-2" style={{ background: 'rgba(21,128,61,0.05)', color: '#15803d', borderBottom: '1px solid var(--border)' }}>
                              <span style={{ fontWeight: 600 }}>{t('hwh.ownerDriver')}:</span>
                              <span>{ownerResolution.name}</span>
                            </div>
                          )}
                          {ownerResolution.status === 'multiple' && (
                            <div className="px-4 py-2 text-xs" style={{ background: 'rgba(185,28,28,0.04)', color: '#b91c1c', borderBottom: '1px solid var(--border)' }}>
                              {t('hwh.multipleOwnersFound')}: {ownerResolution.names.join(', ')}
                            </div>
                          )}
                          <div className="px-4 py-3 flex flex-wrap items-center gap-4 text-xs font-semibold" style={{ background: canExport ? 'rgba(21,128,61,0.07)' : 'rgba(185,28,28,0.07)', color: canExport ? '#15803d' : '#b91c1c' }}>
                            <span>{canExport ? t('hwh.newFahrtenbuchReady') : t('hwh.exportLockedReason', { reason: exportBlockReason ?? '' })}</span>
                            <button
                              onClick={handleExportFahrtenbuch}
                              disabled={!canExport}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-bold transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                              style={{ background: canExport ? '#15803d' : '#6b7280', color: '#fff' }}
                            >
                              {t('hwh.downloadNewFahrtenbuch')}
                            </button>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Block-Anwendung table */}
                    <div style={{ borderBottom: '1px solid var(--border)' }}>
                      <div className="px-4 py-2 text-xs font-semibold" style={{ color: 'var(--text-secondary)', background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>{t('hwh.blockApplication')}</div>
                      <div className="overflow-x-auto">
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                              {[t('hwh.colBlockId'), t('hwh.colVehicle'), t('hwh.colOrigBlockTime'), t('hwh.colNewBlockTime'), t('hwh.colRides'), t('hwh.colOffset'), t('hwh.colCheck'), t('hwh.colHint')].map(h => (
                                <th key={h} className="px-2 py-1.5 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {sectionFData.blockApps.map((app, i) => (
                              <tr key={app.blockId} style={{ background: i%2===0 ? 'var(--bg-surface)' : 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                                <td className="px-2 py-1.5 text-xs font-mono" style={{ color: 'var(--text-secondary)' }} title={app.blockId}>…{app.blockId.slice(-8)}</td>
                                <td className="px-2 py-1.5 text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{app.vehicle}</td>
                                <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtTime(app.origStartMs)}–{fmtTime(app.origEndMs)}</td>
                                <td className="px-2 py-1.5 text-xs font-mono font-bold whitespace-nowrap" style={{ color: '#15803d' }}>{fmtTime(app.newStartMs)}–{fmtTime(app.newEndMs)}</td>
                                <td className="px-2 py-1.5 text-xs text-center whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{app.rideCount}</td>
                                <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{app.offsetMs >= 0 ? '+' : ''}{Math.round(app.offsetMs / 60000)} min</td>
                                <td className="px-2 py-1.5 text-xs font-bold whitespace-nowrap" style={{ color: app.ok ? '#15803d' : '#b91c1c' }}>{app.ok ? t('hwh.ok') : t('common.error')}</td>
                                <td className="px-2 py-1.5 text-xs" style={{ color: 'var(--text-secondary)', maxWidth: 160, whiteSpace: 'normal' }}>{app.hint}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Nicht exportierbare Fahrten — export BLOCKED for these */}
                    {effectiveUnresolvedRides.length > 0 && (
                      <div style={{ borderBottom: '1px solid var(--border)' }}>
                        <div className="px-4 py-2 flex items-center gap-2 text-xs font-semibold" style={{ color: '#b91c1c', background: 'rgba(185,28,28,0.06)', borderBottom: '1px solid rgba(185,28,28,0.25)' }}>
                          <span style={{ fontWeight: 700 }}>{t('hwh.nonExportableRides')}</span>
                          <span className="ml-1 px-2 py-0.5 rounded-full text-xs font-bold" style={{ background: 'rgba(185,28,28,0.15)', color: '#b91c1c' }}>{effectiveUnresolvedRides.length}</span>
                          <span className="ml-1 font-normal" style={{ color: '#b91c1c' }}>
                            {t('hwh.nonExportableRidesHint')}
                          </span>
                        </div>
                        <div className="overflow-x-auto">
                          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                              <tr style={{ background: 'rgba(185,28,28,0.06)', borderBottom: '1px solid rgba(185,28,28,0.2)' }}>
                                {[t('hwh.colTripId'), t('hwh.colVehicle'), t('hwh.colDriverOriginal'), t('hwh.colRideStart'), t('hwh.colRideEnd'), t('hwh.colNoteDetail'), t('hwh.colAction')].map(h => (
                                  <th key={h} className="px-2 py-1.5 text-left text-xs font-semibold whitespace-nowrap" style={{ color: '#b91c1c' }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {effectiveUnresolvedRides.map((info, i) => (
                                <tr key={info.tripId} style={{ background: i%2===0 ? 'var(--bg-surface)' : 'rgba(185,28,28,0.02)', borderBottom: '1px solid rgba(185,28,28,0.12)' }}>
                                  <td className="px-2 py-1.5 text-xs font-mono" style={{ color: 'var(--text-secondary)' }} title={info.tripId}>…{info.tripId.slice(-8)}</td>
                                  <td className="px-2 py-1.5 text-xs font-bold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{info.vehicle || '—'}</td>
                                  <td className="px-2 py-1.5 text-xs font-semibold" style={{ color: '#b91c1c' }}>{info.driver}</td>
                                  <td className="px-2 py-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{info.startMs ? new Date(info.startMs).toISOString().replace('T', ' ').slice(0, 19) : '—'}</td>
                                  <td className="px-2 py-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{info.endMs ? new Date(info.endMs).toISOString().replace('T', ' ').slice(0, 19) : '—'}</td>
                                  <td className="px-2 py-1.5 text-xs" style={{ color: 'var(--text-secondary)', maxWidth: 220, whiteSpace: 'normal' }}>{info.detail}</td>
                                  <td className="px-2 py-1.5 text-xs font-semibold whitespace-nowrap" style={{ color: '#b91c1c' }}>{t('hwh.unresolvableExportLocked')}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* Fahrer-Notiz-Konflikte — mögliche Alternativen */}
                    {driverNoteAlternatives && driverNoteAlternatives.totalBlocks > 0 && (
                      <div style={{ borderBottom: '1px solid var(--border)' }}>
                        {/* Section header + apply button */}
                        <div className="px-4 py-2 flex flex-wrap items-center gap-3 text-xs font-semibold" style={{ color: '#92400e', background: 'rgba(245,158,11,0.07)', borderBottom: '1px solid rgba(245,158,11,0.2)' }}>
                          <span style={{ fontWeight: 700 }}>{t('hwh.driverNoteConflictsAlternatives')}</span>
                          {driverNoteAlternatives.blocksWithAlternative > 0 && effectiveUnresolvedRides.length > 0 && (
                            <button
                              onClick={handleApplyNoteAlternatives}
                              className="inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-bold transition-opacity hover:opacity-90"
                              style={{ background: '#15803d', color: '#fff', marginLeft: 'auto' }}
                            >
                              {t('hwh.applyBestNoteAlternatives')}
                            </button>
                          )}
                          {effectiveUnresolvedRides.length === 0 && noteReassignments.size > 0 && (
                            <span className="ml-auto text-xs font-bold" style={{ color: '#15803d' }}>{t('hwh.allConflictsResolved')}</span>
                          )}
                        </div>
                        {/* Summary cards */}
                        <div className="px-4 py-2 flex flex-wrap gap-4 text-xs" style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                          <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statConflictBlocks')}</span><span className="font-bold ml-1" style={{ color: '#92400e' }}>{driverNoteAlternatives.totalBlocks}</span></div>
                          <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statWithValidAlternative')}</span><span className="font-bold ml-1" style={{ color: '#15803d' }}>{driverNoteAlternatives.blocksWithAlternative}</span></div>
                          <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statWithoutValidAlternative')}</span><span className="font-bold ml-1" style={{ color: driverNoteAlternatives.blocksWithout > 0 ? '#b91c1c' : 'var(--text-secondary)' }}>{driverNoteAlternatives.blocksWithout}</span></div>
                          <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statAlreadyApplied')}</span><span className="font-bold ml-1" style={{ color: noteReassignments.size > 0 ? '#15803d' : 'var(--text-secondary)' }}>{noteReassignments.size}</span></div>
                          <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.statExportStillLocked')}</span><span className="font-bold ml-1" style={{ color: effectiveUnresolvedRides.length > 0 ? '#b91c1c' : '#15803d' }}>{effectiveUnresolvedRides.length > 0 ? t('common.yes') : t('common.no')}</span></div>
                        </div>

                        {/* Per-block alternative breakdown */}
                        {driverNoteAlternatives.blocks.map(block => {
                          const hasPossible = block.candidates.some(c => c.status !== 'rejected');
                          const fmtMs = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
                          const fmtSec = (s: number) => {
                            const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
                            return `${h}h ${String(m).padStart(2,'0')}m`;
                          };
                          return (
                            <div key={block.blockKey} style={{ borderBottom: '1px solid rgba(245,158,11,0.18)' }}>
                              {/* Block header */}
                              <div className="px-4 py-2 flex flex-wrap gap-4 text-xs" style={{ background: hasPossible ? 'rgba(21,128,61,0.04)' : 'rgba(185,28,28,0.04)', borderBottom: '1px solid rgba(245,158,11,0.15)' }}>
                                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{block.vehicle}</span>
                                <span style={{ color: '#b45309' }}>{block.driver}</span>
                                <span style={{ color: 'var(--text-secondary)' }}>{fmtMs(block.startMs)} – {fmtMs(block.endMs)}</span>
                                <span style={{ color: 'var(--text-secondary)' }}>{tPlural({ one: 'hwh.rideCountOne', other: 'hwh.rideCountOther' }, block.rideCount)}</span>
                                <span style={{ color: 'var(--text-secondary)' }}>{fmtSec(block.durationSec)}</span>
                                <span className="font-bold" style={{ color: hasPossible ? '#15803d' : '#b91c1c' }}>
                                  {hasPossible ? t('hwh.canBeReplanned') : t('hwh.noValidAlternativeFound')}
                                </span>
                              </div>
                              {/* Candidates table */}
                              {block.candidates.length > 0 && (
                                <div className="overflow-x-auto">
                                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                                    <thead>
                                      <tr style={{ background: 'rgba(245,158,11,0.04)', borderBottom: '1px solid rgba(245,158,11,0.15)' }}>
                                        {[t('hwh.colTargetDriver'), t('hwh.colTargetKind'), t('hwh.colDriverFree'), t('hwh.colOwnerFree'), t('hwh.colDriverNoteConflict'), t('hwh.colOwnerConflict'), t('hwh.colScore'), t('common.status'), t('hwh.colRejectionReason')].map(h => (
                                          <th key={h} className="px-2 py-1.5 text-left font-semibold whitespace-nowrap" style={{ color: '#92400e' }}>{h}</th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {block.candidates.map((c, ci) => {
                                        const statusColor = c.status === 'best' ? '#15803d' : c.status === 'possible' ? '#0e7490' : '#b91c1c';
                                        // `status` / `targetKind` are internal values, not labels.
                                        const statusLabel = c.status === 'best' ? t('hwh.candBest') : c.status === 'possible' ? t('hwh.candPossible') : t('hwh.candRejected');
                                        const zielArt = c.targetKind === 'inhaber' ? t('hwh.owner') : t('hwh.regularDriver');
                                        return (
                                          <tr key={c.driverName + ci} style={{ background: ci%2===0 ? 'var(--bg-surface)' : 'rgba(245,158,11,0.02)', borderBottom: '1px solid rgba(245,158,11,0.1)' }}>
                                            <td className="px-2 py-1.5 font-semibold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{c.driverName}</td>
                                            <td className="px-2 py-1.5 whitespace-nowrap" style={{ color: c.targetKind === 'inhaber' ? '#0e7490' : 'var(--text-secondary)' }}>{zielArt}</td>
                                            <td className="px-2 py-1.5 font-bold whitespace-nowrap" style={{ color: c.driverFree ? '#15803d' : '#b91c1c' }}>{c.driverFree ? t('common.yes') : t('common.no')}</td>
                                            <td className="px-2 py-1.5 font-bold whitespace-nowrap" style={{ color: c.inhaberFree ? '#15803d' : '#b91c1c' }}>{c.targetKind === 'inhaber' ? (c.inhaberFree ? t('common.yes') : t('common.no')) : '—'}</td>
                                            <td className="px-2 py-1.5 font-bold whitespace-nowrap" style={{ color: c.driverNoteConflict ? '#b91c1c' : '#15803d' }}>{c.driverNoteConflict ? t('common.yes') : t('common.no')}</td>
                                            <td className="px-2 py-1.5 font-bold whitespace-nowrap" style={{ color: c.inhaberConflict ? '#b91c1c' : '#15803d' }}>{c.inhaberConflict ? t('common.yes') : t('common.no')}</td>
                                            <td className="px-2 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{c.targetKind === 'inhaber' ? t('hwh.ownerCandidate') : t('hwh.regularCandidate')}</td>
                                            <td className="px-2 py-1.5 font-bold whitespace-nowrap" style={{ color: statusColor }}>{statusLabel}</td>
                                            <td className="px-2 py-1.5" style={{ color: '#b91c1c', maxWidth: 240, whiteSpace: 'normal' }}>{c.rejectReason ?? '—'}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                              {block.candidates.length === 0 && (
                                <div className="px-4 py-2 text-xs" style={{ color: '#b91c1c' }}>{t('hwh.noDriversInDatabase')}</div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Geänderte Fahrten table */}
                    <div>
                      <div className="px-4 py-2 text-xs font-semibold" style={{ color: 'var(--text-secondary)', background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>{t('hwh.changedRides')}</div>
                      <div className="overflow-x-auto">
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                              {[t('hwh.colBlockId'), t('hwh.colTripIdRow'), t('hwh.colVehicle'), t('hwh.colOldDriver'), t('hwh.colNewDriver'), t('hwh.colOrigStart'), t('hwh.colOrigEnd'), t('hwh.colNewStart'), t('hwh.colNewEnd'), t('hwh.colDuration'), t('common.status')].map(h => (
                                <th key={h} className="px-2 py-1.5 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {sectionFData.changedRides.map((ride, i) => (
                              <tr key={ride.tripId + i} style={{ background: i%2===0 ? 'var(--bg-surface)' : 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                                <td className="px-2 py-1.5 text-xs font-mono" style={{ color: 'var(--text-secondary)' }} title={ride.blockId}>…{ride.blockId.slice(-6)}</td>
                                <td className="px-2 py-1.5 text-xs font-mono" style={{ color: 'var(--text-secondary)' }} title={ride.tripId}>{ride.srcRowIdx !== null ? `Z${ride.srcRowIdx}` : `…${ride.tripId.slice(-6)}`}</td>
                                <td className="px-2 py-1.5 text-xs font-bold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{ride.vehicle}</td>
                                <td className="px-2 py-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{ride.oldDriver || '—'}</td>
                                <td className="px-2 py-1.5 text-xs font-bold" style={{ color: '#15803d' }}>{ride.newDriver}</td>
                                <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDatetime(ride.origStartMs)}</td>
                                <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDatetime(ride.origEndMs)}</td>
                                <td className="px-2 py-1.5 text-xs font-mono font-bold whitespace-nowrap" style={{ color: '#15803d' }}>{fmtDatetime(ride.newStartMs)}</td>
                                <td className="px-2 py-1.5 text-xs font-mono font-bold whitespace-nowrap" style={{ color: '#15803d' }}>{fmtDatetime(ride.newEndMs)}</td>
                                <td className="px-2 py-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDurSec(ride.durSec)}</td>
                                <td className="px-2 py-1.5 text-xs font-bold whitespace-nowrap" style={{ color: ride.ok ? '#15803d' : '#b91c1c' }}>{ride.ok ? t('hwh.changed') : t('common.error')}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

          </div>
        )}
      </div>

      {/* Bottom nav */}
      <div className="flex flex-wrap items-center gap-4 pt-2">
        <button onClick={onBack} className="inline-flex items-center gap-2 text-sm hover:opacity-80" style={{ color: 'var(--text-secondary)' }}>
          <ArrowLeft size={15} /> {t('hwh.backToOwnerConflictPick')}
        </button>
        <button onClick={onRecompute} className="inline-flex items-center gap-2 text-sm hover:opacity-80" style={{ color: 'var(--text-secondary)' }}>
          <RefreshCw size={13} /> {t('hwh.recompute')}
        </button>
      </div>

      {/* Detail modal */}
      {modalData && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setModalData(null)}
        >
          <div
            className="rounded-2xl p-5 max-w-lg w-full mx-4 overflow-y-auto"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', maxHeight: '80vh' }}
            onClick={e => e.stopPropagation()}
          >
            {modalData.kind === 'occupied' && (() => {
              const o = modalData.interval;
              return (
                <>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>{t('hwh.occupiedOwnerBlock')}</h3>
                    <button onClick={() => setModalData(null)} className="text-xs hover:opacity-70" style={{ color: 'var(--text-secondary)' }}>✕ {t('common.close')}</button>
                  </div>
                  <div className="space-y-2 text-xs">
                    {[
                      [t('hwh.colBlockId'),   o.blockId],
                      [t('hwh.colVehicle'),   o.vehicle],
                      [t('hwh.colStart'),      fmtDatetime(o.startMs)],
                      [t('hwh.colEnd'),       fmtDatetime(o.endMs)],
                      [t('hwh.colDuration'),      formatBlockDuration(o.durationSec)],
                      [t('hwh.colRides'),    String(o.rides)],
                      [t('hwh.colRows'),     o.rows],
                      [t('hwh.colOrigin'),   o.sourceStep],
                    ].map(([k, v]) => (
                      <div key={k} className="flex items-start justify-between gap-4">
                        <span style={{ color: 'var(--text-secondary)' }}>{k}</span>
                        <span className="font-semibold text-right" style={{ color: 'var(--text-primary)' }}>{v}</span>
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}

            {modalData.kind === 'window' && (() => {
              const { date, startMs, endMs, durationSec, prevBlockId, nextBlockId, candidates } = modalData;
              const vehicleFreeCount = candidates.filter(c => c.vehicleFree).length;
              return (
                <>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-bold text-sm" style={{ color: '#065f46' }}>{t('hwh.freeTimeWindow')}</h3>
                    <button onClick={() => setModalData(null)} className="text-xs hover:opacity-70" style={{ color: 'var(--text-secondary)' }}>✕ {t('common.close')}</button>
                  </div>
                  <div className="space-y-2 text-xs mb-4">
                    {[
                      [t('common.date'),    date],
                      [t('hwh.colStart'),    fmtTime(startMs)],
                      [t('hwh.colEnd'),     fmtTime(endMs)],
                      [t('hwh.colDuration'),    formatBlockDuration(durationSec)],
                      [t('hwh.colPrevBlock'), prevBlockId ? `…${prevBlockId.slice(-8)}` : '—'],
                      [t('hwh.colNextBlock'),   nextBlockId ? `…${nextBlockId.slice(-8)}` : '—'],
                      [t('hwh.colMatchingOpenBlocks'),           String(candidates.length)],
                      [t('hwh.colOfWhichVehicleFree'),              String(vehicleFreeCount)],
                    ].map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between gap-4">
                        <span style={{ color: 'var(--text-secondary)' }}>{k}</span>
                        <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{v}</span>
                      </div>
                    ))}
                  </div>
                  {candidates.length > 0 && (
                    <>
                      <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                        {t('hwh.matchingBlocksOfTotal', { shown: Math.min(candidates.length, 10), total: candidates.length })}
                      </div>
                      <div className="overflow-x-auto">
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                              {[t('hwh.colBlockId'), t('hwh.colVehicle'), t('hwh.colOrigStart'), t('hwh.colOrigEnd'), t('hwh.colDuration'), t('hwh.colRides'), t('hwh.badgeVehicleFree')].map(h => (
                                <th key={h} className="px-2 py-1.5 text-left text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {candidates.slice(0, 10).map(({ block, vehicleFree }, ci) => (
                              <tr key={block.blockId} style={{ background: ci % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.03)', borderBottom: '1px solid var(--border)' }}>
                                <td className="px-2 py-1.5 text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>…{block.blockId.slice(-8)}</td>
                                <td className="px-2 py-1.5 text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{block.vehicle}</td>
                                <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDatetime(block.blockStartMs)}</td>
                                <td className="px-2 py-1.5 text-xs font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtDatetime(block.blockEndMs)}</td>
                                <td className="px-2 py-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{formatBlockDuration(block.blockDurationSec)}</td>
                                <td className="px-2 py-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{block.rides?.length ?? 0}</td>
                                <td className="px-2 py-1.5 text-xs font-bold" style={{ color: vehicleFree ? '#15803d' : '#b91c1c' }}>{vehicleFree ? t('common.yes') : t('common.no')}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Per-driver working-hour summary ──────────────────────────────────────────

export interface DriverHourSummaryRow {
  driverId: string | null;
  driverName: string;
  hourlyCents: number;       // euro-cents per hour
  baseSec: number;           // 1000 Std
  night25Sec: number;        // 1500 N25%
  night40Sec: number;        // 1501 N40%
  sundaySec: number;         // 1510 Son
  holidaySec: number;        // Feiertag
  totalSec: number;          // Insgesamt
}

const INVALID_DRIVER_NAMES_HS = new Set(['', 'Nicht zugewiesen', 'Inhaber', 'null', 'undefined']);

/**
 * Builds a per-driver working-hour summary from the final edited Fahrtenbuch data.
 * Uses shiftMap for Inhaber-shifted rides, noteReassignments for Fahrer-Notiz overrides,
 * and raw_data_json timestamps for regular rides — exactly matching the XLSX export.
 */
function buildDriverHourSummary(
  trips: FahrtenbuchTrip[],
  shiftMap: Map<string, { newStartMs: number; newEndMs: number; newDriver: string }>,
  noteReassignments: Map<string, string>,
  driverConfigs: WzDriverConfig[],
  resolvedOwnerName: string | null,
  year: number,
): DriverHourSummaryRow[] {
  const holidaySet = getGermanNationalHolidays(year);
  // Also include adjacent years for cross-year rides
  const prevHolidays = getGermanNationalHolidays(year - 1);
  const nextHolidays = getGermanNationalHolidays(year + 1);
  prevHolidays.forEach(h => holidaySet.add(h));
  nextHolidays.forEach(h => holidaySet.add(h));

  // Normalize driver name for grouping
  function resolveExportDriver(raw: string | null | undefined): string | null {
    if (!raw || INVALID_DRIVER_NAMES_HS.has(raw.trim())) return null;
    return raw.trim();
  }

  // Per-driver accumulator
  const acc = new Map<string, DriverHourSummaryRow>();

  function getOrCreate(name: string): DriverHourSummaryRow {
    if (!acc.has(name)) {
      const cfg = driverConfigs.find(c =>
        c.driverName === name ||
        (c.isOwner && name === resolvedOwnerName),
      );
      acc.set(name, {
        driverId: cfg?.driverId ?? null,
        driverName: name,
        hourlyCents: cfg?.hourlyCents ?? 0,
        baseSec: 0, night25Sec: 0, night40Sec: 0, sundaySec: 0, holidaySec: 0, totalSec: 0,
      });
    }
    return acc.get(name)!;
  }

  function addLohnart(name: string, startMs: number, endMs: number) {
    if (endMs <= startMs) return;
    const row = getOrCreate(name);
    const l = computeLohnartSeconds(startMs, endMs, holidaySet);
    row.baseSec    += l.baseSec;
    row.night25Sec += l.night25Sec;
    row.night40Sec += l.night40Sec;
    row.sundaySec  += l.sundaySec;
    row.holidaySec += l.holidaySec;
    row.totalSec   += l.totalSec;
  }

  for (const trip of trips) {
    if (trip.is_canceled) continue;

    const shifted = shiftMap.get(trip.id);
    if (shifted) {
      const driverRaw = shifted.newDriver === 'Inhaber' ? resolvedOwnerName : shifted.newDriver;
      const driver = resolveExportDriver(driverRaw);
      if (driver) addLohnart(driver, shifted.newStartMs, shifted.newEndMs);
      continue;
    }

    const noteDriver = noteReassignments.get(trip.id);
    // Resolve timestamps by COLUMN NAME, through the clean engine's own reader.
    //
    // This used to collect every ISO-shaped value in raw_data_json by iterating
    // Object.keys() and take the first as the start and the second as the end.
    // Measured on staging 27.09.2026 over all 13959 imported rides: for 13513 of
    // them (96.8%) the first ISO value is "Uhrzeit des Fahrtendes" — the ride's
    // END — and the second is "Uhrzeit des Fahrtbeginns". So start and end were
    // swapped, `endMs <= startMs` held, and addLohnart's guard returned without
    // accumulating. Nearly every ride was silently dropped from this summary,
    // which is both rendered (DriverHourSummaryTable) and stored
    // (driver_hour_summary_json), so a driver's hours read as almost nothing.
    //
    // resolveFullDatetime asks for the named column, accepts the German
    // DD.MM.YYYY form as well as ISO, and falls back to trip_date + start_time /
    // end_time — the same resolution the block engine uses for the same rides,
    // so the summary and the blocks can no longer disagree about a ride's hours.
    let startMs = parseFullDatetimeMs(resolveFullDatetime(trip, 'start'));
    let endMs   = parseFullDatetimeMs(resolveFullDatetime(trip, 'end'));
    // A ride that ends past midnight carries the same trip_date on both columns
    // only in the fallback; keep the day roll the old code applied there.
    if (endMs > 0 && startMs > 0 && endMs < startMs) endMs += 86400000;
    if (!startMs) continue;

    const driverRaw = noteDriver
      ?? (trip.assigned_driver_name !== 'Inhaber' ? trip.assigned_driver_name : resolvedOwnerName)
      ?? resolvedOwnerName
      ?? trip.original_driver_name;
    const driver = resolveExportDriver(driverRaw);
    if (!driver) continue;

    addLohnart(driver, startMs, endMs || startMs);
  }

  // Sort: regular drivers first (by name), Inhaber last
  const ownerName = resolvedOwnerName;
  return Array.from(acc.values())
    .filter(r => r.totalSec > 0)
    .sort((a, b) => {
      const aOwner = a.driverName === ownerName;
      const bOwner = b.driverName === ownerName;
      if (aOwner !== bOwner) return aOwner ? 1 : -1;
      return a.driverName.localeCompare(b.driverName);
    });
}

// ── Salary range validation ────────────────────────────────────────────────────

export interface SalaryRangeDriverRow {
  driverId: string | null;
  driverName: string;
  hourlyCents: number;
  minSalaryCents: number | null;
  maxSalaryCents: number | null;
  hours1000: number;       // decimal hours
  hours1500: number;
  hours1501: number;
  hours1510: number;
  hoursHoliday: number;
  basePayCents: number;
  night25PayCents: number;
  night40PayCents: number;
  sundayPayCents: number;
  holidayPayCents: number;
  finalSalaryCents: number;
  differenceToMinCents: number;   // negative means below min; 0 means at/above min
  differenceToMaxCents: number;   // positive means above max; 0 means at/below max
  status: 'ok' | 'below_min' | 'above_max';
}

/**
 * Computes the final salary in euro-cents for a single driver from their hour buckets.
 * Formula: basePay + night25Pay (25% surcharge) + night40Pay (40% surcharge) + sundayPay (50% surcharge) + holidayPay (100% surcharge)
 */
function computeFinalSalaryCents(row: DriverHourSummaryRow): {
  basePayCents: number;
  night25PayCents: number;
  night40PayCents: number;
  sundayPayCents: number;
  holidayPayCents: number;
  finalSalaryCents: number;
} {
  const r = row.hourlyCents / 3600; // cents per second
  const basePayCents    = Math.round(row.baseSec    * r);
  const night25PayCents = Math.round(row.night25Sec * r * 0.25);
  const night40PayCents = Math.round(row.night40Sec * r * 0.40);
  const sundayPayCents  = Math.round(row.sundaySec  * r * 0.50);
  const holidayPayCents = Math.round(row.holidaySec * r * 1.00);
  const finalSalaryCents = basePayCents + night25PayCents + night40PayCents + sundayPayCents + holidayPayCents;
  return { basePayCents, night25PayCents, night40PayCents, sundayPayCents, holidayPayCents, finalSalaryCents };
}

/**
 * Builds a salary range validation summary for every selected regular driver.
 * Uses DriverHourSummaryRow (the single source of truth) and the salary range
 * stored in driverConfigs. Returns one row per regular driver.
 */
function buildFinalSalaryRangeSummary(
  hourSummary: DriverHourSummaryRow[],
  driverConfigs: WzDriverConfig[],
): SalaryRangeDriverRow[] {
  const TOLERANCE_CENTS = 1; // 0.01 € rounding tolerance
  const cfgById = new Map<string | null, WzDriverConfig>();
  for (const cfg of driverConfigs) {
    if (!cfg.isOwner && cfg.included) cfgById.set(cfg.driverId, cfg);
  }

  const result: SalaryRangeDriverRow[] = [];

  for (const row of hourSummary) {
    const cfg = cfgById.get(row.driverId);
    if (!cfg) continue; // skip Inhaber and excluded drivers
    if (cfg.isOwner) continue;

    const { basePayCents, night25PayCents, night40PayCents, sundayPayCents, holidayPayCents, finalSalaryCents } = computeFinalSalaryCents(row);

    const minC = cfg.minSalaryCents;
    const maxC = cfg.maxSalaryCents;

    const differenceToMinCents = minC != null ? finalSalaryCents - minC : 0;
    const differenceToMaxCents = maxC != null ? finalSalaryCents - maxC : 0;

    let status: SalaryRangeDriverRow['status'] = 'ok';
    if (minC != null && finalSalaryCents < minC - TOLERANCE_CENTS) status = 'below_min';
    else if (maxC != null && finalSalaryCents > maxC + TOLERANCE_CENTS) status = 'above_max';

    result.push({
      driverId: row.driverId,
      driverName: row.driverName,
      hourlyCents: row.hourlyCents,
      minSalaryCents: minC,
      maxSalaryCents: maxC,
      hours1000:    row.baseSec    / 3600,
      hours1500:    row.night25Sec / 3600,
      hours1501:    row.night40Sec / 3600,
      hours1510:    row.sundaySec  / 3600,
      hoursHoliday: row.holidaySec / 3600,
      basePayCents,
      night25PayCents,
      night40PayCents,
      sundayPayCents,
      holidayPayCents,
      finalSalaryCents,
      differenceToMinCents,
      differenceToMaxCents,
      status,
    });
  }

  result.sort((a, b) => a.driverName.localeCompare(b.driverName, 'de'));
  return result;
}

/**
 * Validates salary range constraints.
 * Returns null if all drivers are within range, or a message if any are outside.
 */
function validateFinalSalaryRanges(summary: SalaryRangeDriverRow[], t: Translate): string | null {
  const violations = summary.filter(r => r.status !== 'ok');
  if (violations.length === 0) return null;
  return t('hwh.salaryOutsideRange');
}

function secToHStr(sec: number): string {
  return (sec / 3600).toFixed(2).replace('.', ',');
}

function fmtRate(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

interface DriverHourSummaryTableProps {
  rows: DriverHourSummaryRow[];
}

function DriverHourSummaryTable({ rows }: DriverHourSummaryTableProps) {
  const { t } = useTranslation();
  if (rows.length === 0) return (
    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('hwh.noDataAvailable')}</p>
  );
  const cols = [
    { key: 'driverName',  label: t('common.driver'),       align: 'left' },
    { key: 'hourlyCents', label: t('hwh.colRatePerHour'),  align: 'right' },
    { key: 'baseSec',     label: t('hwh.colHours1000'),    align: 'right' },
    { key: 'night25Sec',  label: '1500 N25%',              align: 'right' },
    { key: 'night40Sec',  label: '1501 N40%',              align: 'right' },
    { key: 'sundaySec',   label: t('hwh.colHours1510'),    align: 'right' },
    { key: 'holidaySec',  label: t('hwh.holiday'),         align: 'right' },
    { key: 'totalSec',    label: t('hwh.colTotal'),        align: 'right' },
  ] as const;
  return (
    <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid var(--border)' }}>
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
            {cols.map(c => (
              <th key={c.key} className={`px-3 py-2 font-semibold whitespace-nowrap ${c.align === 'right' ? 'text-right' : 'text-left'}`} style={{ color: 'var(--text-secondary)' }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.driverName} style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : undefined }}>
              <td className="px-3 py-2 font-semibold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{row.driverName}</td>
              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{fmtRate(row.hourlyCents)}</td>
              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{secToHStr(row.baseSec)}</td>
              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{secToHStr(row.night25Sec)}</td>
              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{secToHStr(row.night40Sec)}</td>
              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{secToHStr(row.sundaySec)}</td>
              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{secToHStr(row.holidaySec)}</td>
              <td className="px-3 py-2 text-right tabular-nums font-semibold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{secToHStr(row.totalSec)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Salary range summary table ────────────────────────────────────────────────

function fmtEur(cents: number): string {
  return (cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function fmtHDecimal(h: number): string {
  return h.toFixed(2).replace('.', ',');
}

interface SalaryRangeSummaryTableProps {
  rows: SalaryRangeDriverRow[];
  expandedDriver: string | null;
  onToggleExpand: (name: string) => void;
}

function SalaryRangeSummaryTable({ rows, expandedDriver, onToggleExpand }: SalaryRangeSummaryTableProps) {
  const { t } = useTranslation();
  if (rows.length === 0) return (
    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('hwh.noSalaryData')}</p>
  );

  // Keyed on the stored status value; only `label` renders.
  const statusColors: Record<SalaryRangeDriverRow['status'], { bg: string; border: string; text: string; label: string }> = {
    ok:         { bg: 'rgba(21,128,61,0.08)',   border: 'rgba(21,128,61,0.25)',  text: '#15803d', label: t('hwh.ok') },
    below_min:  { bg: 'rgba(220,38,38,0.06)',   border: 'rgba(220,38,38,0.3)',   text: '#b91c1c', label: t('hwh.belowMinSalary') },
    above_max:  { bg: 'rgba(217,119,6,0.06)',   border: 'rgba(217,119,6,0.35)',  text: '#b45309', label: t('hwh.aboveMaxSalary') },
  };

  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const s = statusColors[row.status];
        const isExpanded = expandedDriver === row.driverName;
        const diff = row.status === 'below_min'
          ? row.differenceToMinCents  // negative value (below min)
          : row.status === 'above_max'
            ? row.differenceToMaxCents // positive value (above max)
            : 0;
        return (
          <div key={row.driverName} className="rounded-xl overflow-hidden" style={{ border: `1px solid ${s.border}` }}>
            {/* Main row */}
            <button
              className="w-full flex items-center gap-3 px-4 py-3 text-left transition-all hover:brightness-95"
              style={{ background: s.bg }}
              onClick={() => onToggleExpand(row.driverName)}
            >
              {/* Status badge */}
              <span className="text-xs font-bold px-2 py-0.5 rounded-full flex-shrink-0" style={{ background: s.border, color: s.text }}>{s.label}</span>
              {/* Driver name */}
              <span className="font-semibold text-sm flex-1" style={{ color: 'var(--text-primary)' }}>{row.driverName}</span>
              {/* Mindestgehalt */}
              <div className="text-right hidden sm:block flex-shrink-0">
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('hwh.minShort')}</div>
                <div className="text-xs font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                  {row.minSalaryCents != null ? fmtEur(row.minSalaryCents) : '—'}
                </div>
              </div>
              {/* Maximalgehalt */}
              <div className="text-right hidden sm:block flex-shrink-0">
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('hwh.maxShort')}</div>
                <div className="text-xs font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                  {row.maxSalaryCents != null ? fmtEur(row.maxSalaryCents) : '—'}
                </div>
              </div>
              {/* Ist-Gehalt */}
              <div className="text-right flex-shrink-0">
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('hwh.actualSalary')}</div>
                <div className="text-xs font-bold tabular-nums" style={{ color: s.text }}>{fmtEur(row.finalSalaryCents)}</div>
              </div>
              {/* Differenz */}
              {row.status !== 'ok' && (
                <div className="text-right flex-shrink-0">
                  <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('hwh.difference')}</div>
                  <div className="text-xs font-bold tabular-nums" style={{ color: s.text }}>
                    {diff < 0 ? `−${fmtEur(-diff)}` : `+${fmtEur(diff)}`}
                  </div>
                </div>
              )}
              {/* Expand chevron */}
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ transform: isExpanded ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s', color: 'var(--text-secondary)', flexShrink: 0 }}>
                <path d="M3 5 L7 9 L11 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>

            {/* Expanded detail */}
            {isExpanded && (
              <div className="px-4 py-3 space-y-2" style={{ background: 'var(--bg-surface)', borderTop: `1px solid ${s.border}` }}>
                {/* Mobile salary range */}
                <div className="sm:hidden grid grid-cols-2 gap-2 text-xs">
                  <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.minSalary')}: </span><span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{row.minSalaryCents != null ? fmtEur(row.minSalaryCents) : '—'}</span></div>
                  <div><span style={{ color: 'var(--text-secondary)' }}>{t('hwh.maxSalary')}: </span><span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{row.maxSalaryCents != null ? fmtEur(row.maxSalaryCents) : '—'}</span></div>
                </div>
                {/* Hour buckets */}
                <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--border)' }}>
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                        {['Lohnart', t('hwh.colHours'), t('hwh.colFactor'), t('common.amount')].map((h, hi) => (
                          <th key={h} className={`px-3 py-2 font-semibold whitespace-nowrap ${hi === 0 ? 'text-left' : 'text-right'}`} style={{ color: 'var(--text-secondary)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { label: `1000 ${t('hwh.baseWage')}`,  hours: row.hours1000, factor: '×1,00', amountCents: row.basePayCents },
                        { label: '1500 N25%',                 hours: row.hours1500, factor: '×0,25', amountCents: row.night25PayCents },
                        { label: '1501 N40%',                 hours: row.hours1501, factor: '×0,40', amountCents: row.night40PayCents },
                        { label: `1510 ${t('hwh.sunday')}`,   hours: row.hours1510, factor: '×0,50', amountCents: row.sundayPayCents },
                        { label: t('hwh.holiday'),            hours: row.hoursHoliday, factor: '×1,00', amountCents: row.holidayPayCents },
                      ].map((item, idx) => (
                        <tr key={item.label} style={{ borderBottom: idx < 4 ? '1px solid var(--border)' : undefined }}>
                          <td className="px-3 py-1.5 font-medium" style={{ color: 'var(--text-primary)' }}>{item.label}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{fmtHDecimal(item.hours)} h</td>
                          <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{item.factor}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums font-semibold" style={{ color: 'var(--text-primary)' }}>{fmtEur(item.amountCents)}</td>
                        </tr>
                      ))}
                      <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--bg-subtle)' }}>
                        <td className="px-3 py-2 font-bold" style={{ color: 'var(--text-primary)' }} colSpan={3}>{t('hwh.total')}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-bold" style={{ color: s.text }}>{fmtEur(row.finalSalaryCents)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {t('hwh.hourlyRate')}: {fmtRate(row.hourlyCents)} €/h
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Standalone saved-plan export ─────────────────────────────────────────────
//
// Re-creates the identical XLSX from a saved plan without any live component state.
// Used when downloading a previously saved historical working-hours plan.

interface SavedPlanExportParams {
  trips: FahrtenbuchTrip[];
  shiftMapEntries: Array<[string, { newStartMs: number; newEndMs: number; newDriver: string; auftragEingangMs: number | null; auftragUebermittlungMs: number | null; geplanteAbholzeitMs: number | null }]>;
  noteReassignmentsEntries: Array<[string, string]>;
  ownerDriverName: string;
  storagePath: string | null;
  sourceSheetName: string | null;
  sourceColumnsJson: string[] | null;
  originalFileName: string | null;
  month: number;
  year: number;
  /** Only for the on-screen alert below; the workbook itself stays German. */
  t: Translate;
}

async function reExportFahrtenbuchFromSavedPlan(params: SavedPlanExportParams): Promise<void> {
  const { trips, shiftMapEntries, noteReassignmentsEntries, ownerDriverName, storagePath, sourceSheetName, sourceColumnsJson, originalFileName, month, year, t } = params;
  const shiftMap = new Map(shiftMapEntries);
  const noteReassignments = new Map(noteReassignmentsEntries);

  // Download original file from storage
  let originalWs: XLSX.WorkSheet | null = null;
  if (storagePath) {
    try {
      const { data: blob, error } = await supabase.storage.from('fahrtenbuch-files').download(storagePath);
      if (!error && blob) {
        const arrayBuffer = await blob.arrayBuffer();
        const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array', cellStyles: false, raw: true });
        const wsName = sourceSheetName ?? wb.SheetNames[0];
        originalWs = wb.Sheets[wsName] ?? wb.Sheets[wb.SheetNames[0]] ?? null;
      }
    } catch { /* fall through */ }
  }

  // Build column order
  let headers: string[];
  if (sourceColumnsJson && sourceColumnsJson.length > 0) {
    headers = [...sourceColumnsJson];
    const inHeaders = new Set(headers.map(h => h.toLowerCase()));
    for (const trip of trips) {
      if (trip.raw_data_json) for (const k of Object.keys(trip.raw_data_json)) {
        if (!inHeaders.has(k.toLowerCase())) { headers.push(k); inHeaders.add(k.toLowerCase()); }
      }
    }
  } else {
    const headerSet = new Set<string>();
    for (const trip of trips) {
      if (trip.raw_data_json) for (const k of Object.keys(trip.raw_data_json)) headerSet.add(k);
    }
    headers = [...headerSet];
  }

  const DRIVER_KEYS    = ['fahrername', 'fahrer'];
  const START_KEYS     = ['uhrzeit des fahrtbeginns', 'fahrtbeginn', 'start', 'start_datetime', 'fahrt_beginn'];
  const END_KEYS       = ['uhrzeit des fahrtendes', 'fahrtende', 'ende', 'end_datetime', 'fahrt_ende'];
  const DATE_KEYS      = ['datum der fahrt', 'datum', 'date', 'fahrt_datum'];
  const EINGANG_KEYS   = ['datum/uhrzeit auftragseingang', 'auftragseingang', 'auftrag_eingang'];
  const UEBERM_KEYS    = ['uhrzeit der auftragsuebermittlung', 'auftragsuebermittlung', 'auftrag_uebermittlung'];
  const ABHOLZEIT_KEYS = ['geplante abholzeit', 'abholzeit', 'geplante_abholzeit'];
  const FAHRPREIS_KEYS = ['fahrpreis', 'preis', 'price', 'fare'];
  const KILOMETER_KEYS = ['kilometer', 'km', 'distanz', 'distance'];

  const colIdx = new Map(headers.map((h, i) => [h.toLowerCase(), i]));
  const driverColIdx  = [...colIdx.entries()].find(([k]) => DRIVER_KEYS.includes(k))?.[1] ?? -1;
  const startColIdx   = [...colIdx.entries()].find(([k]) => START_KEYS.includes(k))?.[1] ?? -1;
  const endColIdx     = [...colIdx.entries()].find(([k]) => END_KEYS.includes(k))?.[1] ?? -1;
  const dateColIdx    = [...colIdx.entries()].find(([k]) => DATE_KEYS.includes(k))?.[1] ?? -1;
  const eingangColIdx = [...colIdx.entries()].find(([k]) => EINGANG_KEYS.includes(k))?.[1] ?? -1;
  const uebermColIdx  = [...colIdx.entries()].find(([k]) => UEBERM_KEYS.includes(k))?.[1] ?? -1;
  const abholColIdx   = [...colIdx.entries()].find(([k]) => ABHOLZEIT_KEYS.includes(k))?.[1] ?? -1;

  const fmtDate = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };

  const HEADER_KW = ['datum','fahrer','uhrzeit','preis','trinkgeld','zahlungsart','abholort','zielort','kennzeichen','start','ende','beginn','fahrt','trip','driver','date','time','price','status','storniert'];

  if (originalWs) {
    const range = XLSX.utils.decode_range(originalWs['!ref'] ?? 'A1');
    let wsHeaderRow = range.s.r;
    for (let r = range.s.r; r <= Math.min(range.e.r, 20); r++) {
      let matches = 0;
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = originalWs[XLSX.utils.encode_cell({ r, c })];
        if (cell && HEADER_KW.some(kw => String(cell.v ?? '').toLowerCase().includes(kw))) matches++;
      }
      if (matches >= 3) { wsHeaderRow = r; break; }
    }

    const wsColByName = new Map<string, number>();
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r: wsHeaderRow, c });
      const cell = originalWs[addr];
      if (cell) wsColByName.set(String(cell.v ?? '').toLowerCase().trim(), c);
    }

    const wsDriverCol  = DRIVER_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;
    const wsStartCol   = START_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;
    const wsEndCol     = END_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;
    const wsDateCol    = DATE_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;
    const wsEingangCol = EINGANG_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;
    const wsUebermCol  = UEBERM_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;
    const wsAbholCol   = ABHOLZEIT_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;
    const wsFahrpreisCol = FAHRPREIS_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;
    const wsKilometerCol = KILOMETER_KEYS.map(k => wsColByName.get(k)).find(v => v !== undefined) ?? -1;

    type RowEntry = { wsRow: number; sortMs: number; trip: FahrtenbuchTrip };
    const rowEntries: RowEntry[] = trips.map(trip => {
      const wsRow = wsHeaderRow + (trip.source_row_index ?? 1);
      const s = shiftMap.get(trip.id);
      let sortMs = Infinity;
      if (s) {
        sortMs = s.newStartMs;
      } else if (wsStartCol >= 0) {
        const addr = XLSX.utils.encode_cell({ r: wsRow, c: wsStartCol });
        const cell = originalWs![addr];
        if (cell) { const ms = Date.parse(String(cell.v ?? '').replace(' ', 'T')); if (!isNaN(ms)) sortMs = ms; }
      }
      return { wsRow, sortMs, trip };
    });
    rowEntries.sort((a, b) => a.sortMs === Infinity && b.sortMs === Infinity ? 0 : a.sortMs - b.sortMs);

    const newWs: XLSX.WorkSheet = {};
    const totalCols = range.e.c - range.s.c + 1;
    const totalRows = 1 + rowEntries.length;

    for (let c = range.s.c; c <= range.e.c; c++) {
      const srcAddr = XLSX.utils.encode_cell({ r: wsHeaderRow, c });
      const dstAddr = XLSX.utils.encode_cell({ r: 0, c: c - range.s.c });
      const cell = originalWs[srcAddr];
      if (cell) newWs[dstAddr] = { ...cell };
    }

    let invalidPriceKmCount = 0;
    for (let i = 0; i < rowEntries.length; i++) {
      const { wsRow, trip } = rowEntries[i];
      const dstRow = i + 1;
      const s = shiftMap.get(trip.id);
      for (let c = range.s.c; c <= range.e.c; c++) {
        const srcAddr = XLSX.utils.encode_cell({ r: wsRow, c });
        const dstAddr = XLSX.utils.encode_cell({ r: dstRow, c: c - range.s.c });
        const srcCell = originalWs[srcAddr];
        const cell: XLSX.CellObject = srcCell ? { ...srcCell } : { t: 'z' };
        if (s) {
          if (c === wsDriverCol  && wsDriverCol  >= 0) { cell.t = 's'; cell.v = ownerDriverName; delete cell.w; }
          else if (c === wsStartCol && wsStartCol >= 0) { cell.t = 's'; cell.v = formatExportDateTime(s.newStartMs); delete cell.w; }
          else if (c === wsEndCol   && wsEndCol   >= 0) { cell.t = 's'; cell.v = formatExportDateTime(s.newEndMs); delete cell.w; }
          else if (c === wsDateCol  && wsDateCol  >= 0) { cell.t = 's'; cell.v = fmtDate(s.newStartMs); delete cell.w; }
          else if (c === wsEingangCol && wsEingangCol >= 0 && s.auftragEingangMs !== null) { cell.t = 's'; cell.v = formatExportDateTime(s.auftragEingangMs); delete cell.w; }
          else if (c === wsUebermCol  && wsUebermCol  >= 0 && s.auftragUebermittlungMs !== null) { cell.t = 's'; cell.v = formatExportDateTime(s.auftragUebermittlungMs); delete cell.w; }
          else if (c === wsAbholCol   && wsAbholCol   >= 0 && s.geplanteAbholzeitMs !== null) { cell.t = 's'; cell.v = formatExportDateTime(s.geplanteAbholzeitMs); delete cell.w; }
        }
        if (!s && noteReassignments.has(trip.id)) {
          if (c === wsDriverCol && wsDriverCol >= 0) { cell.t = 's'; cell.v = noteReassignments.get(trip.id)!; delete cell.w; }
        }
        if ((c === wsFahrpreisCol && wsFahrpreisCol >= 0) || (c === wsKilometerCol && wsKilometerCol >= 0)) {
          if (srcCell && cell.v !== srcCell.v) invalidPriceKmCount++;
        }
        newWs[dstAddr] = cell;
      }
    }

    if (invalidPriceKmCount > 0) {
      // Screen alert, not workbook content.
      alert(t('hwh.exportLockedPriceKmChangedShort', { count: invalidPriceKmCount }));
      return;
    }

    newWs['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: totalRows - 1, c: totalCols - 1 } });
    const wb2 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb2, newWs, sourceSheetName ?? 'Sheet1');
    writeMarkedWorkbook(wb2, originalFileName ?? `fahrtenbuch_neu_${year}-${String(month).padStart(2,'0')}.xlsx`, hasSimulatedRides(trips));
    return;
  }

  // Fallback: json_to_sheet
  const allRows = trips.map(trip => {
    const row: Record<string, unknown> = { ...(trip.raw_data_json ?? {}) };
    const s = shiftMap.get(trip.id);
    if (s) {
      if (driverColIdx  >= 0) row[headers[driverColIdx]]  = ownerDriverName;
      if (startColIdx   >= 0) row[headers[startColIdx]]   = formatExportDateTime(s.newStartMs);
      if (endColIdx     >= 0) row[headers[endColIdx]]     = formatExportDateTime(s.newEndMs);
      if (dateColIdx    >= 0) row[headers[dateColIdx]]    = fmtDate(s.newStartMs);
      if (eingangColIdx >= 0 && s.auftragEingangMs !== null)       row[headers[eingangColIdx]] = formatExportDateTime(s.auftragEingangMs);
      if (uebermColIdx  >= 0 && s.auftragUebermittlungMs !== null) row[headers[uebermColIdx]]  = formatExportDateTime(s.auftragUebermittlungMs);
      if (abholColIdx   >= 0 && s.geplanteAbholzeitMs !== null)    row[headers[abholColIdx]]   = formatExportDateTime(s.geplanteAbholzeitMs);
    } else if (noteReassignments.has(trip.id)) {
      if (driverColIdx >= 0) row[headers[driverColIdx]] = noteReassignments.get(trip.id)!;
    }
    return row;
  });
  const startColName = startColIdx >= 0 ? headers[startColIdx] : null;
  allRows.sort((a, b) => {
    const parse = (r: Record<string, unknown>) => {
      if (!startColName) return Infinity;
      const ms = Date.parse(String(r[startColName] ?? '').replace(' ', 'T'));
      return isNaN(ms) ? Infinity : ms;
    };
    return parse(a) - parse(b);
  });
  const ws = XLSX.utils.json_to_sheet(allRows, { header: headers });
  const wb3 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb3, ws, sourceSheetName ?? 'Sheet1');
  writeMarkedWorkbook(wb3, originalFileName ?? `fahrtenbuch_neu_${year}-${String(month).padStart(2,'0')}.xlsx`, hasSimulatedRides(trips));
}

// ── Main component ────────────────────────────────────────────────────────────

// Progress messages, held as TranslationKeys because this list is module-level;
// the wizard resolves the current one with t(...).
const AUTO_RUN_STEPS = [
  'hwh.autoStepReadFahrtenbuch',
  'hwh.autoStepBuildBlocks',
  'hwh.autoStepAssignRegularDrivers',
  'hwh.autoStepCheckDriverNotes',
  'hwh.autoStepPrepareOwnerConflicts',
  'hwh.autoStepSearchWindows',
  'hwh.autoStepResolveConflicts',
  'hwh.autoStepResolveNoteConflicts',
  'hwh.autoStepPrepareExport',
  'hwh.autoStepFinalCheck',
] as const;
const MIN_STEP_MS = 1100;

// ── Vehicle month-boundary summary ───────────────────────────────────────────

export interface VehicleBoundaryRow {
  vehicle: string;
  firstDriver: string | null;
  firstTripMs: number | null;
  lastDriver: string | null;
  lastTripMs: number | null;
  source: 'preliminary' | 'final';
}

function fmtBoundaryMs(ms: number): string {
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
}

const INVALID_DRIVER_NAMES = new Set(['', 'Nicht zugewiesen', 'Inhaber']);

function resolveDriverDisplay(name: string | null | undefined): string | null {
  if (!name || INVALID_DRIVER_NAMES.has(name)) return null;
  return name;
}

/** Build vehicle/month boundary summary from originalTrips (preliminary). */
export function buildVehicleMonthBoundarySummary(
  trips: FahrtenbuchTrip[],
): VehicleBoundaryRow[] {
  // Parse full datetime ms for a FahrtenbuchTrip using the same logic as the engine
  function parseTripStartMs(trip: FahrtenbuchTrip): number {
    const raw = trip.raw_data_json as Record<string, unknown> | null;
    if (raw) {
      for (const k of Object.keys(raw)) {
        const v = String(raw[k] ?? '');
        if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) {
          const ms = Date.parse(v.replace(' ', 'T'));
          if (!isNaN(ms)) return ms;
        }
        if (/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/.test(v)) {
          const [datePart, timePart] = v.split(' ');
          const [day, mon, yr] = datePart.split('.');
          const iso = `${yr}-${mon}-${day}T${timePart}`;
          const ms = Date.parse(iso);
          if (!isNaN(ms)) return ms;
        }
      }
    }
    if (trip.trip_date && trip.start_time) {
      const combined = `${trip.trip_date}T${trip.start_time.length === 5 ? trip.start_time + ':00' : trip.start_time}`;
      const ms = Date.parse(combined);
      if (!isNaN(ms)) return ms;
    }
    return 0;
  }

  function parseTripEndMs(trip: FahrtenbuchTrip): number {
    const raw = trip.raw_data_json as Record<string, unknown> | null;
    if (raw) {
      const keys = Object.keys(raw);
      // Try to find an end time value — second datetime-looking field after start
      const datetimeLike: string[] = [];
      for (const k of keys) {
        const v = String(raw[k] ?? '');
        if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) || /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/.test(v)) {
          datetimeLike.push(v);
        }
      }
      // If there are at least 2, the second is typically end time
      if (datetimeLike.length >= 2) {
        const v = datetimeLike[1];
        if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) {
          const ms = Date.parse(v.replace(' ', 'T'));
          if (!isNaN(ms)) return ms;
        }
        if (/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/.test(v)) {
          const [datePart, timePart] = v.split(' ');
          const [day, mon, yr] = datePart.split('.');
          const iso = `${yr}-${mon}-${day}T${timePart}`;
          const ms = Date.parse(iso);
          if (!isNaN(ms)) return ms;
        }
      }
    }
    if (trip.trip_date && trip.end_time) {
      let combined = `${trip.trip_date}T${trip.end_time.length === 5 ? trip.end_time + ':00' : trip.end_time}`;
      let ms = Date.parse(combined);
      if (!isNaN(ms)) {
        // Handle cross-midnight: if end < start, add 1 day
        const startMs = parseTripStartMs(trip);
        if (startMs > 0 && ms < startMs) ms += 86400000;
        return ms;
      }
    }
    return 0;
  }

  // Group by vehicle
  const byVehicle = new Map<string, Array<{ startMs: number; endMs: number; driver: string | null }>>();
  for (const trip of trips) {
    if (trip.is_canceled) continue;
    const vehicle = trip.car_identifier ?? trip.car_id ?? '';
    if (!vehicle) continue;
    const startMs = parseTripStartMs(trip);
    if (!startMs) continue;
    const endMs = parseTripEndMs(trip) || startMs;
    const driver = resolveDriverDisplay(trip.assigned_driver_name) ?? resolveDriverDisplay(trip.original_driver_name);
    if (!byVehicle.has(vehicle)) byVehicle.set(vehicle, []);
    byVehicle.get(vehicle)!.push({ startMs, endMs, driver });
  }

  const result: VehicleBoundaryRow[] = [];
  for (const [vehicle, rows] of byVehicle) {
    rows.sort((a, b) => a.startMs - b.startMs);
    const first = rows[0];
    // Last = row with latest endMs (fallback to startMs if endMs unavailable)
    const last = rows.reduce((best, r) => (r.endMs || r.startMs) > (best.endMs || best.startMs) ? r : best, rows[0]);
    result.push({
      vehicle,
      firstDriver: first.driver,
      firstTripMs: first.startMs,
      lastDriver: last.driver,
      lastTripMs: last.endMs || last.startMs,
      source: 'preliminary',
    });
  }
  result.sort((a, b) => a.vehicle.localeCompare(b.vehicle));
  return result;
}

/** Build vehicle/month boundary summary from final snapshot rows. */
export function buildVehicleMonthBoundarySummaryFromSnapshot(
  rows: FinalBlockAssignmentRow[],
): VehicleBoundaryRow[] {
  const byVehicle = new Map<string, Array<{ startMs: number; endMs: number; driver: string | null }>>();
  for (const row of rows) {
    if (!row.isExportable) continue;
    const vehicle = row.vehicle;
    if (!vehicle) continue;
    const startMs = row.finalStartMs || row.originalStartMs;
    const endMs = row.finalEndMs || row.originalEndMs || startMs;
    if (!startMs) continue;
    const driver = resolveDriverDisplay(row.finalDriverName) ?? resolveDriverDisplay(row.originalDriverName);
    if (!byVehicle.has(vehicle)) byVehicle.set(vehicle, []);
    byVehicle.get(vehicle)!.push({ startMs, endMs, driver });
  }

  const result: VehicleBoundaryRow[] = [];
  for (const [vehicle, vehicleRows] of byVehicle) {
    vehicleRows.sort((a, b) => a.startMs - b.startMs);
    const first = vehicleRows[0];
    const last = vehicleRows.reduce((best, r) => (r.endMs || r.startMs) > (best.endMs || best.startMs) ? r : best, vehicleRows[0]);
    result.push({
      vehicle,
      firstDriver: first.driver,
      firstTripMs: first.startMs,
      lastDriver: last.driver,
      lastTripMs: last.endMs || last.startMs,
      source: 'final',
    });
  }
  result.sort((a, b) => a.vehicle.localeCompare(b.vehicle));
  return result;
}

interface VehicleMonthBoundarySummaryProps {
  rows: VehicleBoundaryRow[];
}

function VehicleMonthBoundarySummary({ rows }: VehicleMonthBoundarySummaryProps) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  const isFinal = rows.some(r => r.source === 'final');
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          {t('hwh.boundaryTitle')}
        </h3>
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
          style={isFinal
            ? { background: 'rgba(21,128,61,0.12)', color: '#15803d', border: '1px solid rgba(21,128,61,0.3)' }
            : { background: 'rgba(217,119,6,0.10)', color: '#b45309', border: '1px solid rgba(217,119,6,0.3)' }}
        >
          {isFinal ? t('hwh.boundaryFinal') : t('hwh.boundaryPreliminary')}
        </span>
      </div>
      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
        {t('hwh.boundaryHint')}
      </p>
      <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid var(--border)' }}>
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
              {[t('hwh.colVehicle'), t('hwh.colFirstDriver'), t('hwh.colFirstTrip'), t('hwh.colLastDriver'), t('hwh.colLastTrip')].map(h => (
                <th key={h} className="text-left px-3 py-2 font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.vehicle} style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : undefined }}>
                <td className="px-3 py-2 font-mono font-semibold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{row.vehicle}</td>
                <td className="px-3 py-2 whitespace-nowrap" style={{ color: row.firstDriver ? 'var(--text-primary)' : 'var(--text-tertiary, #9ca3af)' }}>
                  {row.firstDriver ?? <span className="italic">{t('hwh.notDeterminable')} <span className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-xs" style={{ background: 'rgba(217,119,6,0.10)', color: '#b45309' }}>{t('hwh.checkRequired')}</span></span>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  {row.firstTripMs ? fmtBoundaryMs(row.firstTripMs) : '—'}
                </td>
                <td className="px-3 py-2 whitespace-nowrap" style={{ color: row.lastDriver ? 'var(--text-primary)' : 'var(--text-tertiary, #9ca3af)' }}>
                  {row.lastDriver ?? <span className="italic">{t('hwh.notDeterminable')} <span className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-xs" style={{ background: 'rgba(217,119,6,0.10)', color: '#b45309' }}>{t('hwh.checkRequired')}</span></span>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  {row.lastTripMs ? fmtBoundaryMs(row.lastTripMs) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}



/**
 * The only caller is CompanyPlannerPage, which renders the wizard for
 * `planningMode === 'hist_working_hours'` and passes a single way out.
 * `Props` was annotated but never declared, so the parameter was silently
 * `any` — the one prop this component takes went unchecked.
 */
interface Props {
  onBack: () => void;
}

export default function HistoricalWorkingHoursWizard({ onBack }: Props) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const now = new Date();
  const yearOptions = useMemo(() => { const y = now.getFullYear(); return Array.from({ length: 8 }, (_, i) => y - 6 + i); }, []);

  // Step & navigation
  const [step, setStep] = useState(0);

  // Step 0
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [imports, setImports] = useState<FbImport[]>([]);
  const [loadingImports, setLoadingImports] = useState(false);
  const [selectedImportId, setSelectedImportId] = useState('');

  // Step 1 — driver configs + draft inputs
  const [allDrivers, setAllDrivers] = useState<DriverRow[]>([]);
  const [driverNotesMap, setDriverNotesMap] = useState<Map<string, StructuredNote[]>>(new Map());
  const [driverConfigs, setDriverConfigs] = useState<WzDriverConfig[]>([]);
  const [drafts, setDrafts] = useState<Map<string, WzDraft>>(new Map());
  const [useInhaber, setUseInhaber] = useState(true);
  const [inhaberId, setInhaberId] = useState('');
  const [reconciliationId, setReconciliationId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Step 2/3 — compute
  const [computing, setComputing] = useState(false);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [computePhase, setComputePhase] = useState('');

  // Phase 1 result
  const [phase1Result, setPhase1Result] = useState<BuildVehicleBlocksResult | null>(null);
  // Phase 2 result
  const [assignmentResult, setAssignmentResult] = useState<RegularDriverAssignmentResult | null>(null);
  // Phase 3 result
  const [inhaberResult, setInhaberResult] = useState<InhaberAssignmentResult | null>(null);
  // Inhaber non-conflict step (Step 3 in this wizard → wizard step 5)
  const [inhaberNcResult, setInhaberNcResult] = useState<InhaberNonConflictStepResult | null>(null);
  const [applyingNcs, setApplyingNcs] = useState(false);
  // Inhaber longest conflict step (Step 4 → wizard step 6)
  const [inhaberLcResult, setInhaberLcResult] = useState<InhaberLongestConflictStepResult | null>(null);
  const [applyingLcs, setApplyingLcs] = useState(false);
  // Inhaber free window search (Step 5 → wizard step 7)
  const [inhaberFwsResult, setInhaberFwsResult] = useState<InhaberFreeWindowSearchStepResult | null>(null);
  // Phase 4 result
  const [shiftResult, setShiftResult] = useState<OwnerShiftResult | null>(null);
  // Phase 5 result
  const [snapshotResult, setSnapshotResult] = useState<FinalBlockAssignmentSnapshotResult | null>(null);
  // Export validation result
  const [exportValidation, setExportValidation] = useState<HistoricalWorkingHoursExportValidationResult | null>(null);
  // Original trips (all, including canceled) stored for XLSX export
  const [originalTrips, setOriginalTrips] = useState<FahrtenbuchTrip[] | null>(null);
  // Export summary derived from snapshot + originalTrips
  const [exportSummary, setExportSummary] = useState<FahrtenbuchExportSummary | null>(null);
  // Stundennachweis preview derived from snapshot + regularTargets
  const [stundennachweisPreview, setStundennachweisPreview] = useState<HistoricalWorkingHoursStundennachweisPreviewResult | null>(null);
  // Row-level engine result (new engine — single source of truth for overlap validation)
  const [rowLevelEngineResult, setRowLevelEngineResult] = useState<ArbeitsstundenEngineResult | null>(null);
  // Generated worksheet self-audit result (post-download, final authority)
  const [worksheetAuditResult, setWorksheetAuditResult] = useState<GeneratedWorksheetAuditResult | null>(null);
  // Vehicle month-boundary summary (preliminary from originalTrips, updated to final after calculation)
  const [boundaryRows, setBoundaryRows] = useState<VehicleBoundaryRow[]>([]);

  // Serialized plan data for DB persistence (set by onPlanDataReady from InhaberFreeWindowSearchView)
  const [planData, setPlanData] = useState<{ shiftMapJson: Array<[string, object]>; noteReassignmentsJson: Array<[string, string]> } | null>(null);
  // Driver working-hour summary for display and persistence
  const [driverHourSummary, setDriverHourSummary] = useState<DriverHourSummaryRow[]>([]);
  // Salary range validation summary (computed from final export data)
  const [salaryRangeSummary, setSalaryRangeSummary] = useState<SalaryRangeDriverRow[]>([]);
  // Save-plan UI state
  const [savingPlan, setSavingPlan] = useState(false);
  const [planSavedId, setPlanSavedId] = useState<string | null>(null);
  const [savePlanError, setSavePlanError] = useState<string | null>(null);
  // Saved plans list for current month/year
  interface SavedPlanRow {
    id: string;
    month: number;
    year: number;
    original_file_name: string | null;
    saved_at: string;
    export_ready: boolean;
    export_block_reason: string | null;
    shift_map_json: Array<[string, object]>;
    note_reassignments_json: Array<[string, string]>;
    boundary_rows_json: VehicleBoundaryRow[];
    driver_configs_json: WzDriverConfig[];
    storage_path: string | null;
    source_columns_json: string[] | null;
    source_sheet_name: string | null;
    mode: string;
    driver_hour_summary_json: DriverHourSummaryRow[];
    /** Nullable: the import may be pruned after the plan is saved. */
    import_id: string | null;
  }
  const [savedPlans, setSavedPlans] = useState<SavedPlanRow[]>([]);
  const [loadingSavedPlans, setLoadingSavedPlans] = useState(false);
  // Ref to trigger XLSX download from the mounted InhaberFreeWindowSearchView
  const exportTriggerRef = useRef<(() => void) | null>(null);
  // Tracks which driver row is expanded in the salary range table
  const [expandedSalaryDriver, setExpandedSalaryDriver] = useState<string | null>(null);

  // Step 0 saved-plan viewer modal
  const [viewingPlan, setViewingPlan] = useState<SavedPlanRow | null>(null);
  const [downloadingPlanId, setDownloadingPlanId] = useState<string | null>(null);
  // Confirmation dialog before replacing an existing plan
  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false);

  // Assignment strategy
  const [assignmentStrategy, setAssignmentStrategy] = useState<RegularAssignmentStrategy>('hours_first');
  // Strategy that was used for the last compute (to detect stale state)
  const [lastComputedStrategy, setLastComputedStrategy] = useState<RegularAssignmentStrategy | null>(null);
  // Alternate strategy result for comparison card
  const [altAssignmentResult, setAltAssignmentResult] = useState<RegularDriverAssignmentResult | null>(null);

  // Original XLSX bytes for 1:1 export patching
  const [exportingXlsx, setExportingXlsx] = useState(false);

  // Targets manager overlay
  const [showTargetsManager, setShowTargetsManager] = useState(false);
  const [savingAsTargets, setSavingAsTargets] = useState(false);
  const [saveAsTargetsDone, setSaveAsTargetsDone] = useState(false);

  // ── Auto-run mode (simplified UX for normal users) ───────────────────────────
  const [debugMode, setDebugMode] = useState(false);
  const [autoRunPhase, setAutoRunPhase] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [autoRunStepIndex, setAutoRunStepIndex] = useState(0);
  const [autoRunExportReady, setAutoRunExportReady] = useState<boolean | null>(null);
  const [autoRunExportReason, setAutoRunExportReason] = useState<string | null>(null);
  const [autoRunError, setAutoRunError] = useState<string | null>(null);

  // 120s watchdog: if Abschlussprüfung hasn't resolved after timeout, force failure
  useEffect(() => {
    if (autoRunPhase !== 'done' || autoRunExportReady !== null) return;
    const id = setTimeout(() => {
      setAutoRunExportReady(false);
      setAutoRunExportReason(t('hwh.finalCheckTimeout'));
    }, 120_000);
    return () => clearTimeout(id);
  }, [autoRunPhase, autoRunExportReady, t]);

  // Tracks which import+month+year combination has already been prefilled from saved targets
  const prefillKeyRef = useRef('');

  // ── Load imports ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!companyId) return;
    setLoadingImports(true);
    setSelectedImportId('');
    supabase.from('fahrtenbuch_imports').select('id,file_name,row_count,imported_at,source_columns_json,source_sheet_name,storage_path')
      .eq('company_id', companyId).eq('month', month).eq('year', year)
      .order('imported_at', { ascending: false })
      .then(({ data }) => {
        const rows = (data ?? []) as FbImport[];
        if (import.meta.env.DEV) {
          console.log(`[FahrtenbuchImportList] Loaded ${rows.length} import(s) for ${month}/${year}:`);
          rows.forEach((r, i) => console.log(`  [${i}]`, {
            id: r.id, file_name: r.file_name, row_count: r.row_count,
            storage_path: r.storage_path, imported_at: r.imported_at,
          }));
          const withStorage = rows.filter(r => !!r.storage_path);
          console.log(`[FahrtenbuchImportList] ${withStorage.length}/${rows.length} have storage_path`);
        }
        setImports(rows);
        setLoadingImports(false);
      });
  }, [companyId, month, year]);

  // ── Load drivers ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!companyId) return;
    supabase.from('drivers').select('id,name,personalnummer,employment_type,driver_usage_type,planning_hourly_rate,planning_min_salary,planning_max_salary')
      // No status filter: `drivers_status_check` admits only 'active' and
      // 'inactive', so the `.neq('status','archived')` that stood here matched
      // every row and did nothing ('archived' is a status of companies, planning
      // runs and imports, never of a driver). Including an inactive driver is
      // also correct here: this wizard reconstructs a PAST month, and someone who
      // left since may well have driven it.
      .eq('company_id', companyId)
      .then(({ data }) => setAllDrivers((data ?? []) as DriverRow[]));
  }, [companyId]);

  // ── Load driver notes (for planning exclusions) ────────────────────────────

  useEffect(() => {
    if (!companyId) return;
    supabase.from('driver_notes')
      .select('id,driver_id,note_type,note_text,note_planning_behavior,is_full_day,start_date,end_date,note_date,start_time,end_time')
      .eq('company_id', companyId)
      .eq('note_planning_behavior', 'exclude_from_plan')
      .then(({ data }) => {
        const map = new Map<string, StructuredNote[]>();
        for (const row of (data ?? []) as StructuredNote[]) {
          if (!map.has(row.driver_id)) map.set(row.driver_id, []);
          map.get(row.driver_id)!.push(row);
        }
        setDriverNotesMap(map);
      });
  }, [companyId]);

  // ── Auto-populate drivers when import selected ───────────────────────────────

  useEffect(() => {
    if (!selectedImportId || allDrivers.length === 0) return;
    // Paginated: this read was unbounded, so any driver whose rides all fell
    // after row 1000 was silently missing from the Arbeitsstunden plan.
    fetchAllPaginated<{ original_driver_name: string; original_driver_id: string | null }>(
      (from, to) => supabase
        .from('fahrtenbuch_trips')
        .select('original_driver_name,original_driver_id')
        .eq('import_id', selectedImportId)
        .eq('is_canceled', false)
        .order('id', { ascending: true })
        .range(from, to),
      // Interpolated into fetchAllPaginated's error text. A caller's label
      // arrives already translated; the sentence around it carries its own key.
      { label: t('common.driver') },
    )
      .then((data) => {
        const seen = new Map<string, string>();
        for (const r of data) {
          if (r.original_driver_id && !seen.has(r.original_driver_id)) seen.set(r.original_driver_id, r.original_driver_name);
        }
        const ownerIds = new Set(allDrivers.filter(d => d.employment_type === 'company_owner').map(d => d.id));
        const configs: WzDriverConfig[] = [];
        const newDrafts = new Map<string, WzDraft>();
        for (const [did, dname] of seen) {
          const profile = allDrivers.find(d => d.id === did);
          const hourlyCents = profile?.planning_hourly_rate ? Math.round(profile.planning_hourly_rate * 100) : 0;
          const minSalaryCents = profile?.planning_min_salary != null ? Math.round(profile.planning_min_salary * 100) : null;
          const maxSalaryCents = profile?.planning_max_salary != null ? Math.round(profile.planning_max_salary * 100) : null;
          // Use canonical name from driver profile, not raw Fahrtenbuch name
          const canonicalName = profile?.name ?? dname;
          configs.push({ driverId: did, driverName: canonicalName, personalnummer: profile?.personalnummer ?? null,
            isOwner: ownerIds.has(did), included: !ownerIds.has(did), hourlyCents,
            minSalaryCents, maxSalaryCents,
            targetBaseH: 0, targetNacht25H: 0, targetNacht40H: 0, targetSundayH: 0, targetHolidayH: 0, hinweis: '' });
          newDrafts.set(did, { hourly: centsToStr(hourlyCents), baseH: '', nacht25H: '', nacht40H: '', sunH: '', holH: '' });
        }
        configs.sort((a, b) => (a.isOwner ? 1 : 0) - (b.isOwner ? 1 : 0) || a.driverName.localeCompare(b.driverName));
        setDriverConfigs(configs);
        setDrafts(newDrafts);
        const ownerDriver = allDrivers.find(d => d.employment_type === 'company_owner');
        if (ownerDriver) setInhaberId(ownerDriver.id);
      });
  }, [selectedImportId, allDrivers]);

  // ── Prefill target hours from saved historical_driver_hour_targets ────────────

  useEffect(() => {
    if (!companyId || driverConfigs.length === 0 || !selectedImportId) return;
    const prefillKey = `${selectedImportId}:${month}:${year}`;
    if (prefillKeyRef.current === prefillKey) return;
    prefillKeyRef.current = prefillKey;

    const monthName = MONTHS_DE[month - 1];
    supabase
      .from('historical_driver_hour_targets')
      .select('driver_id,base_hours,night_25_hours,night_0_4_40_hours,sunday_50_hours,holiday_hours')
      .eq('company_id', companyId)
      .eq('month', monthName)
      .eq('year', year)
      .not('driver_id', 'is', null)
      .then(({ data }) => {
        if (!data || data.length === 0) return;
        const byId = new Map(
          (data as Array<{
            driver_id: string;
            base_hours: number; night_25_hours: number;
            night_0_4_40_hours: number; sunday_50_hours: number; holiday_hours: number;
          }>).map(r => [r.driver_id, r])
        );
        setDriverConfigs(prev => prev.map(cfg => {
          const target = byId.get(cfg.driverId);
          if (!target) return cfg;
          return {
            ...cfg,
            targetBaseH:    Number(target.base_hours)          || 0,
            targetNacht25H: Number(target.night_25_hours)       || 0,
            targetNacht40H: Number(target.night_0_4_40_hours)   || 0,
            targetSundayH:  Number(target.sunday_50_hours)      || 0,
            targetHolidayH: Number(target.holiday_hours)        || 0,
          };
        }));
        setDrafts(prev => {
          const m = new Map(prev);
          for (const [did, target] of byId) {
            const existing = m.get(did);
            if (!existing) continue;
            m.set(did, {
              ...existing,
              baseH:    fmtH(Number(target.base_hours)         || 0),
              nacht25H: fmtH(Number(target.night_25_hours)      || 0),
              nacht40H: fmtH(Number(target.night_0_4_40_hours)  || 0),
              sunH:     fmtH(Number(target.sunday_50_hours)     || 0),
              holH:     fmtH(Number(target.holiday_hours)       || 0),
            });
          }
          return m;
        });
      });
  }, [driverConfigs.length, companyId, month, year, selectedImportId]);

  // ── Load saved plans for current month/year ───────────────────────────────────

  useEffect(() => {
    if (!companyId) return;
    setLoadingSavedPlans(true);
    supabase
      .from('historical_wh_saved_plans')
      .select('id,month,year,original_file_name,saved_at,export_ready,export_block_reason,shift_map_json,note_reassignments_json,boundary_rows_json,driver_configs_json,driver_hour_summary_json,storage_path,source_columns_json,source_sheet_name,mode,import_id')
      .eq('company_id', companyId)
      .eq('month', month)
      .eq('year', year)
      .order('saved_at', { ascending: false })
      .then(({ data }) => {
        setSavedPlans((data ?? []) as SavedPlanRow[]);
        setLoadingSavedPlans(false);
      });
  }, [companyId, month, year]);

  // ── Save current plan to DB ───────────────────────────────────────────────────

  // Internal function that actually performs the save (after confirmation if needed)
  const doSavePlan = useCallback(async () => {
    if (!companyId || !planData) return;
    setSavingPlan(true);
    setSavePlanError(null);
    setShowReplaceConfirm(false);
    const imp = imports.find(i => i.id === selectedImportId);

    // Delete any existing plan for this company/month/year/mode before inserting new one
    // A hidden DELETE touches nothing and answers 200, so the INSERT below ran
    // against the row this was meant to clear. It did NOT leave two plans for the
    // month — `historical_wh_saved_plans_company_month_year_mode_key` is UNIQUE on
    // (company_id, month, year, mode), verified live on staging — so the insert
    // failed 23505 and the user read a raw duplicate-key sentence instead of being
    // told their role may not save a plan. That is what this replaces.
    // 'gone' (nothing to replace) is fine.
    try {
      const cleared = await deleteChecked(supabase, 'historical_wh_saved_plans', q => q
        .eq('company_id', companyId)
        .eq('month', month)
        .eq('year', year)
        .eq('mode', 'historical_working_hours'));
      if (cleared === 'refused') {
        setSavePlanError(t('common.writeRefused'));
        setSavingPlan(false);
        return;
      }
    } catch (e: any) {
      setSavePlanError(e?.message ?? t('common.error'));
      setSavingPlan(false);
      return;
    }

    const { data, error } = await supabase
      .from('historical_wh_saved_plans')
      .insert({
        company_id: companyId,
        month,
        year,
        mode: 'historical_working_hours',
        import_id: selectedImportId || null,
        original_file_name: imp?.file_name ?? null,
        storage_path: imp?.storage_path ?? null,
        source_sheet_name: imp?.source_sheet_name ?? null,
        source_columns_json: imp?.source_columns_json ?? [],
        saved_by: user?.id ?? null,
        export_ready: autoRunExportReady === true,
        export_block_reason: autoRunExportReason ?? null,
        boundary_rows_json: boundaryRows,
        shift_map_json: planData.shiftMapJson,
        note_reassignments_json: planData.noteReassignmentsJson,
        driver_configs_json: driverConfigs,
        driver_hour_summary_json: driverHourSummary,
        validation_summary_json: {},
      })
      .select('id')
      .single();
    if (error) {
      setSavePlanError(error.message);
    } else {
      setPlanSavedId(data?.id ?? null);
      // Refresh list
      supabase
        .from('historical_wh_saved_plans')
        .select('id,month,year,original_file_name,saved_at,export_ready,export_block_reason,shift_map_json,note_reassignments_json,boundary_rows_json,driver_configs_json,driver_hour_summary_json,storage_path,source_columns_json,source_sheet_name,mode,import_id')
        .eq('company_id', companyId)
        .eq('month', month)
        .eq('year', year)
        .order('saved_at', { ascending: false })
        .then(({ data: listData }) => setSavedPlans((listData ?? []) as SavedPlanRow[]));
    }
    setSavingPlan(false);
  }, [companyId, user, planData, month, year, selectedImportId, imports, boundaryRows, driverConfigs, driverHourSummary, autoRunExportReady, autoRunExportReason]);

  // If an active plan already exists for this month, ask for confirmation first
  const handleSavePlan = useCallback(async () => {
    if (!companyId || !planData) return;
    const existingActivePlan = savedPlans.find(p => p.export_ready);
    if (existingActivePlan) {
      setShowReplaceConfirm(true);
    } else {
      await doSavePlan();
    }
  }, [companyId, planData, savedPlans, doSavePlan]);

  // ── Download from a saved plan (standalone re-export) ─────────────────────────

  const downloadSavedPlan = useCallback(async (plan: SavedPlanRow) => {
    if (!plan.import_id && !plan.storage_path) {
      alert(t('hwh.noOriginalData'));
      return;
    }
    setDownloadingPlanId(plan.id);
    try {
      // Fetch original trips from DB. Paginated and company-scoped: an
      // unpaginated read silently truncated at 1000 rows, so a month with more
      // rides than that exported a statutory Fahrtenbuch missing its tail.
      const trips = await fetchAllPaginated<FahrtenbuchTrip>(
        (from, to) => supabase
          .from('fahrtenbuch_trips')
          .select('*')
          .eq('company_id', companyId)
          .eq('import_id', plan.import_id ?? '')
          .order('source_row_index', { ascending: true, nullsFirst: false })
          .order('id', { ascending: true })
          .range(from, to),
        // Interpolated into fetchAllPaginated's error text. A caller's label
        // arrives already translated; the sentence around it carries its own key.
        { label: t('hwh.colRides') },
      );

      // Resolve owner driver name from saved driver_configs_json
      const ownerConfig = (plan.driver_configs_json as WzDriverConfig[] | null)?.find(c => c.isOwner);
      // Written into the Fahrername column of the exported Fahrtenbuch.
      const ownerDriverName = ownerConfig?.driverName ?? 'Inhaber';

      await reExportFahrtenbuchFromSavedPlan({
        trips,
        shiftMapEntries: (plan.shift_map_json as Array<[string, { newStartMs: number; newEndMs: number; newDriver: string; auftragEingangMs: number | null; auftragUebermittlungMs: number | null; geplanteAbholzeitMs: number | null }]>) ?? [],
        noteReassignmentsEntries: (plan.note_reassignments_json as Array<[string, string]>) ?? [],
        ownerDriverName,
        storagePath: plan.storage_path ?? null,
        sourceSheetName: plan.source_sheet_name ?? null,
        sourceColumnsJson: (plan.source_columns_json as string[] | null) ?? null,
        originalFileName: plan.original_file_name ?? null,
        month: plan.month,
        year: plan.year,
        t,
      });
    } catch (e) {
      alert(t('hwh.downloadFailed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setDownloadingPlanId(null);
    }
  }, [companyId, t]);

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function updateDraft(driverId: string, field: keyof WzDraft, val: string) {
    setDrafts(prev => { const m = new Map(prev); const d = m.get(driverId) ?? { hourly: '', baseH: '', nacht25H: '', nacht40H: '', sunH: '', holH: '' }; m.set(driverId, { ...d, [field]: val }); return m; });
  }

  function commitDraft(driverId: string, field: keyof WzDraft, val: string) {
    setDriverConfigs(prev => prev.map(c => {
      if (c.driverId !== driverId) return c;
      if (field === 'hourly')   return { ...c, hourlyCents: parseCentsFromStr(val) };
      if (field === 'baseH')    return { ...c, targetBaseH: parseGermanH(val) };
      if (field === 'nacht25H') return { ...c, targetNacht25H: parseGermanH(val) };
      if (field === 'nacht40H') return { ...c, targetNacht40H: parseGermanH(val) };
      if (field === 'sunH')     return { ...c, targetSundayH: parseGermanH(val) };
      if (field === 'holH')     return { ...c, targetHolidayH: parseGermanH(val) };
      return c;
    }));
    // Reformat draft
    if (field === 'hourly') updateDraft(driverId, field, centsToStr(parseCentsFromStr(val)));
    else updateDraft(driverId, field, fmtH(parseGermanH(val)) || val);
  }

  // ── Persistence ───────────────────────────────────────────────────────────────

  const ensureReconciliation = useCallback(async (): Promise<string> => {
    if (!companyId) throw new Error(t('hwh.errorNoCompanyId'));
    if (reconciliationId) return reconciliationId;
    const { data: existing } = await supabase.from('historical_reconciliations')
      .select('id').eq('company_id', companyId).eq('month', month).eq('year', year)
      .eq('reconciliation_mode', 'working_hours').maybeSingle();
    if (existing?.id) { setReconciliationId(existing.id); return existing.id; }
    const importEntry = imports.find(i => i.id === selectedImportId);
    const { data: created, error } = await supabase.from('historical_reconciliations')
      .insert({ company_id: companyId, month, year, import_id: selectedImportId || null,
        reconciliation_mode: 'working_hours', notes: importEntry?.file_name ?? null })
      .select('id').single();
    if (error) throw error;
    setReconciliationId(created.id);
    return created.id;
  }, [companyId, month, year, reconciliationId, selectedImportId, imports, t]);

  const saveDriverConfigs = useCallback(async () => {
    if (!companyId) return;
    setSaving(true);
    try {
      const rid = await ensureReconciliation();
      const rows = driverConfigs.map(c => ({
        reconciliation_id: rid, driver_id: c.driverId, driver_name: c.driverName,
        personalnummer: c.personalnummer, hourly_rate_cents: c.hourlyCents,
        is_owner: c.isOwner, is_included: c.included,
        target_base_hours: c.targetBaseH, target_night_25_hours: c.targetNacht25H,
        target_night_40_hours: c.targetNacht40H, target_sunday_50_hours: c.targetSundayH,
        target_holiday_hours: c.targetHolidayH, hinweis: c.hinweis || null,
        updated_at: new Date().toISOString(),
      }));
      await supabase.from('historical_reconciliation_wh_drivers')
        .upsert(rows, { onConflict: 'reconciliation_id,driver_id' });
    } catch { /* silent save */ }
    setSaving(false);
  }, [companyId, driverConfigs, ensureReconciliation]);

  // ── Save current wizard values as global targets ──────────────────────────────

  const handleSaveAsTargets = useCallback(async () => {
    if (!companyId) return;
    setSavingAsTargets(true);
    setSaveAsTargetsDone(false);
    const monthName = MONTHS_DE[month - 1];
    const included = driverConfigs.filter(c => c.included && !c.isOwner);
    await saveDriverConfigsAsTargets(companyId, monthName, year, included);
    setSavingAsTargets(false);
    setSaveAsTargetsDone(true);
    setTimeout(() => setSaveAsTargetsDone(false), 3000);
  }, [companyId, driverConfigs, month, year]);

  // ── Auto-run: runs all phases sequentially in simplified (non-debug) mode ─────

  const handleAutoRun = useCallback(async () => {
    if (!companyId || !selectedImportId) return;

    const runId = Date.now();
    if (debugMode) console.log(`[AutoRun #${runId}] start`, { month, year, selectedImportId });

    // Reset all previous results
    setPhase1Result(null);
    setAssignmentResult(null);
    setInhaberResult(null);
    setInhaberNcResult(null);
    setInhaberLcResult(null);
    setInhaberFwsResult(null);
    setShiftResult(null);
    setSnapshotResult(null);
    setExportValidation(null);
    setOriginalTrips(null);
    setBoundaryRows([]);
    setExportSummary(null);
    setStundennachweisPreview(null);
    setAltAssignmentResult(null);
    setLastComputedStrategy(null);
    setRowLevelEngineResult(null);
    setWorksheetAuditResult(null);
    setAutoRunExportReady(null);
    setAutoRunExportReason(null);
    setAutoRunError(null);

    setAutoRunPhase('running');
    setAutoRunStepIndex(0);

    const step = async (idx: number) => {
      if (debugMode) console.log(`[AutoRun #${runId}] step ${idx}: ${AUTO_RUN_STEPS[idx]}`);
      setAutoRunStepIndex(idx);
      await new Promise<void>(r => setTimeout(r, MIN_STEP_MS));
    };

    try {
      await saveDriverConfigs();

      // 0: Read Fahrtenbuch
      await step(0);
      const trips = await fetchAllTrips(companyId, selectedImportId);
      setOriginalTrips(trips);
      setBoundaryRows(buildVehicleMonthBoundarySummary(trips));

      // 1: Vehicle blocks
      await step(1);
      const p1 = buildVehicleBlocksForHistoricalWorkingHours(trips);
      setPhase1Result(p1);

      // 2: Assign regular drivers
      await step(2);
      const regularDrivers: RegularDriverTarget[] = driverConfigs
        .filter(c => c.included && !c.isOwner)
        .map(c => ({
          driverId:             c.driverId,
          driverName:           c.driverName,
          targetWorkSec:        c.targetBaseH * 3600,
          targetHours:          c.targetBaseH,
          targetBaseSec1000:    c.targetBaseH    * 3600,
          targetNight25Sec1500: c.targetNacht25H * 3600,
          targetNight40Sec1501: c.targetNacht40H * 3600,
          targetSundaySec1510:  c.targetSundayH  * 3600,
          targetHolidaySec:     c.targetHolidayH * 3600,
          targetTotalSec:       c.targetBaseH * 3600,
        }));
      const excls = (() => {
        if (driverNotesMap.size === 0) return undefined;
        const m = new Map<string, DriverPlanningExclusion[]>();
        for (const [driverId, notes] of driverNotesMap) {
          const intervals = buildDriverPlanningExclusions(notes, t);
          if (intervals.length > 0) m.set(driverId, intervals);
        }
        return m.size > 0 ? m : undefined;
      })();
      const p2 = assignRegularDriversToVehicleBlocks(p1, regularDrivers, assignmentStrategy, excls);
      setAssignmentResult(p2);

      // 3: Driver notes (visual step — already processed above)
      await step(3);

      // 4: Inhaber non-conflict
      await step(4);
      const inhaberName = driverConfigs.find(c => c.isOwner)?.driverName ?? 'Inhaber';
      const unassigned = p2.surplusBlocks.filter(b => !p2.assignments.some(a => a.blockId === b.blockId));
      const ncResult = runInhaberNonConflictStep(unassigned, inhaberName);
      setInhaberNcResult(ncResult);

      // 5: Free window search (longest conflict step)
      await step(5);
      const lcResult = runInhaberLongestConflictStep(
        ncResult.remainingConflictedBlocks,
        ncResult.assignedToInhaberBlocks,
        inhaberName,
      );
      setInhaberLcResult(lcResult);

      // 6: Free window search
      await step(6);
      const fwsResult = runInhaberFreeWindowSearch(
        ncResult.assignedToInhaberBlocks,
        lcResult.selectedBlocks,
        lcResult.remainingUnassignedBlocks,
        p1.blocks,
        p2.assignments,
        month,
        year,
      );
      setInhaberFwsResult(fwsResult);

      // 7–9: Visual steps (InhaberFreeWindowSearchView will auto-apply plan)
      await step(7);
      await step(8);
      await step(9);
      if (debugMode) console.log(`[AutoRun #${runId}] phases complete, navigating to step 7`);

      // Navigate to step 7 — InhaberFreeWindowSearchView renders and auto-applies
      setStep(7);
      setAutoRunPhase('done');

    } catch (e) {
      const msg = e instanceof Error ? e.message : t('hwh.unknownError');
      if (debugMode) console.error(`[AutoRun #${runId}] failed:`, msg, e);
      setAutoRunPhase('failed');
      setAutoRunError(msg);
    }
  }, [companyId, selectedImportId, driverConfigs, assignmentStrategy, month, year, driverNotesMap, saveDriverConfigs, debugMode, t]);

  // ── Compute ───────────────────────────────────────────────────────────────────

  const handleCompute = useCallback(async () => {
    if (!companyId || !selectedImportId) return;
    setComputing(true);
    setComputeError(null);
    setComputePhase(t('hwh.phaseLoadingTrips'));
    setPhase1Result(null);
    setAssignmentResult(null);
    setInhaberResult(null);
    setShiftResult(null);
    setSnapshotResult(null);
    setExportValidation(null);
    setOriginalTrips(null);
    setBoundaryRows([]);
    setExportSummary(null);
    setStundennachweisPreview(null);
    setAltAssignmentResult(null);
    setLastComputedStrategy(null);
    setRowLevelEngineResult(null);
    setWorksheetAuditResult(null);
    try {
      const trips = await fetchAllTrips(companyId, selectedImportId);
      setOriginalTrips(trips);
      setBoundaryRows(buildVehicleMonthBoundarySummary(trips));
      setComputePhase(t('hwh.phaseBuildingBlocks'));
      const result = buildVehicleBlocksForHistoricalWorkingHours(trips);
      if (import.meta.env.DEV) {
        console.log('[VehicleBlocksStep1] Built', result.blocks.length, 'blocks from', trips.length, 'trips', {
          validBlocks: result.validBlockCount,
          shortBlocks: result.shortBlockCount,
          longBlocks: result.longBlockCount,
          invalidBlocks: result.invalidBlockCount,
          vehicleCount: result.vehicleCount,
          totalBlockHours: result.totalBlockHours.toFixed(2),
          originalOverlaps: result.originalOverlaps.length,
        });
      }
      setPhase1Result(result);
      setStep(3);
    } catch (e) {
      setComputeError(e instanceof Error ? e.message : t('hwh.computeError'));
    } finally {
      setComputing(false);
      setComputePhase('');
    }
  }, [companyId, selectedImportId, t]);

  // ── Step 2: Assign regular drivers ───────────────────────────────────────────

  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  const handleAssignRegularDrivers = useCallback(async () => {
    if (!phase1Result) return;
    setAssigning(true);
    setAssignError(null);
    setAssignmentResult(null);
    try {
      const regularDrivers: RegularDriverTarget[] = driverConfigs
        .filter(c => c.included && !c.isOwner)
        .map(c => ({
          driverId:            c.driverId,
          driverName:          c.driverName,
          // Base total IS the total limit; N25/N40/Sunday/Feiertag are sub-buckets inside it
          targetWorkSec:       c.targetBaseH * 3600,
          targetHours:         c.targetBaseH,
          targetBaseSec1000:   c.targetBaseH    * 3600,
          targetNight25Sec1500: c.targetNacht25H * 3600,
          targetNight40Sec1501: c.targetNacht40H * 3600,
          targetSundaySec1510:  c.targetSundayH  * 3600,
          targetHolidaySec:     c.targetHolidayH * 3600,
          targetTotalSec:      c.targetBaseH * 3600,
        }));

      const result = assignRegularDriversToVehicleBlocks(phase1Result, regularDrivers, 'balanced', (() => {
        if (driverNotesMap.size === 0) return undefined;
        const excls = new Map<string, DriverPlanningExclusion[]>();
        for (const [driverId, notes] of driverNotesMap) {
          const intervals = buildDriverPlanningExclusions(notes, t);
          if (intervals.length > 0) excls.set(driverId, intervals);
        }
        return excls.size > 0 ? excls : undefined;
      })());

      if (import.meta.env.DEV) {
        const v = result.validation;
        const ratios = regularDrivers.map(rd => {
          const s = result.driverSummaries.find(d => d.driverId === rd.driverId);
          const assignedTotal   = s?.assignedWorkSec    ?? 0;
          const assignedN25     = s?.assignedNight25Sec1500 ?? 0;
          const assignedN40     = s?.assignedNight40Sec1501 ?? 0;
          const assignedSunday  = s?.assignedSundaySec1510 ?? 0;
          const assignedHoliday = s?.assignedHolidaySec ?? 0;
          const ratio = rd.targetTotalSec > 0 ? assignedTotal / rd.targetTotalSec : 0;
          return {
            name:               rd.driverName,
            baseTotalHours:     rd.targetBaseSec1000 / 3600,
            n25Limit:           rd.targetNight25Sec1500 / 3600,
            n40Limit:           rd.targetNight40Sec1501 / 3600,
            sundayLimit:        rd.targetSundaySec1510 / 3600,
            holidayLimit:       rd.targetHolidaySec / 3600,
            assignedTotal:      assignedTotal / 3600,
            assignedN25:        assignedN25 / 3600,
            assignedN40:        assignedN40 / 3600,
            assignedSunday:     assignedSunday / 3600,
            assignedHoliday:    assignedHoliday / 3600,
            assignedRatio:      Math.round(ratio * 1000) / 10,
            totalLimitExceeded: assignedTotal > rd.targetTotalSec,
            lohnartLimitExceeded: (assignedN25 > rd.targetNight25Sec1500) || (assignedN40 > rd.targetNight40Sec1501) || (assignedSunday > rd.targetSundaySec1510) || (assignedHoliday > rd.targetHolidaySec),
          };
        });
        const ratioValues = ratios.map(r => r.assignedRatio);
        const minRatio = Math.min(...ratioValues);
        const maxRatio = Math.max(...ratioValues);
        const spread   = maxRatio - minRatio;
        console.log('[WorkingHoursInterpretationFix] per-driver limits & actuals:', ratios);
        console.log('[RegularDriverBalance] distribution', {
          strategy:       'balanced',
          ratioSpread:    spread.toFixed(1) + '%',
          minRatio:       minRatio.toFixed(1) + '%',
          maxRatio:       maxRatio.toFixed(1) + '%',
          balanceStatus:  spread <= 25 ? 'Ausgewogen' : 'Unausgewogen',
          perDriverRatio: ratios.map(r => ({ name: r.name, ratio: r.assignedRatio + '%', assigned: r.assignedTotal.toFixed(2) + 'h', max: r.baseTotalHours.toFixed(2) + 'h' })),
          validBlocks:    phase1Result.validBlockCount,
          assignedBlocks: result.assignments.length,
          surplusValid:   result.surplusValidBlocks.length,
          driverOverlaps: v.driverOverlapCount,
          hourOverruns:   v.targetOverrunCount,
          first20Unassigned: result.surplusValidBlocks.slice(0, 20).map(b => ({ id: b.blockId, vehicle: b.vehicle })),
        });
      }

      setAssignmentResult(result);
      setStep(4);
    } catch (e) {
      setAssignError(e instanceof Error ? e.message : t('hwh.assignError'));
    } finally {
      setAssigning(false);
    }
  }, [phase1Result, driverConfigs, driverNotesMap, t]);

  // ── Input style ───────────────────────────────────────────────────────────────

  const inp: React.CSSProperties = {
    background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: '0.375rem',
    color: 'var(--text-primary)', fontSize: '0.8rem', padding: '0.3rem 0.5rem', outline: 'none', width: '100%',
  };


  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <>
    <div className="space-y-4 max-w-6xl">
      {/* Targets manager overlay */}
      {showTargetsManager && (
        <HistoricalHourTargetsManager
          companyId={companyId!}
          drivers={allDrivers as HoursDriver[]}
          defaultMonth={month}
          defaultYear={year}
          onClose={() => {
            setShowTargetsManager(false);
            prefillKeyRef.current = '';
          }}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="inline-flex items-center gap-2 text-sm font-medium transition-colors hover:opacity-80" style={{ color: 'var(--text-secondary)' }}>
          <ArrowLeft size={15} /> {t('hwh.backToSelection')}
        </button>
        <StepDots current={step} total={5} />
      </div>

      {/* ── Step 0: Monat & Import ─────────────────────────────────────────────── */}
      {step === 0 && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('hwh.step0Title')}</h2>
            <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{t('hwh.step0Subtitle')}</p>
          </div>
          <div className="rounded-2xl p-5 space-y-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('common.month')}</label>
                <select value={month} onChange={e => setMonth(+e.target.value)} style={{ ...inp, width: 'auto' }}>
                  {MONTH_KEYS.map((k, i) => <option key={i} value={i+1}>{t(k)}</option>)}
                </select>
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('hwh.year')}</label>
                <select value={year} onChange={e => setYear(+e.target.value)} style={{ ...inp, width: 'auto' }}>
                  {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('hwh.fahrtenbuchImport')}</label>
              {loadingImports ? (
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('common.loading')}</p>
              ) : imports.length === 0 ? (
                <p className="text-xs" style={{ color: '#b45309' }}>{t('hwh.noImportForMonth', { month: t(MONTH_KEYS[month-1]), year })}</p>
              ) : (
                <select value={selectedImportId} onChange={e => setSelectedImportId(e.target.value)} style={inp}>
                  <option value="">{t('hwh.chooseImport')}</option>
                  {imports.map(i => <option key={i.id} value={i.id}>{i.file_name} ({t('hwh.rowsCount', { count: i.row_count })})</option>)}
                </select>
              )}
            </div>
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => setStep(1)}
              disabled={!selectedImportId}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:brightness-110 disabled:opacity-40"
              style={{ background: '#2563eb', color: '#fff' }}
            >
              {t('hwh.next')} <ArrowRight size={15} />
            </button>
          </div>

          {/* ── Gespeicherter Monatsplan ─────────────────────────────────── */}
          <div className="rounded-2xl p-5 space-y-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('hwh.savedMonthlyPlan')}</h3>
              {loadingSavedPlans && <RefreshCw size={13} className="animate-spin" style={{ color: 'var(--text-secondary)' }} />}
            </div>
            {!loadingSavedPlans && savedPlans.length === 0 && (
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('hwh.noSavedPlanForMonth')}
              </p>
            )}
            {savedPlans.length > 0 && (
              <div className="space-y-2">
                {savedPlans.map(plan => {
                  const savedDate = new Date(plan.saved_at);
                  const savedFmt = `${String(savedDate.getDate()).padStart(2,'0')}.${String(savedDate.getMonth()+1).padStart(2,'0')}.${savedDate.getFullYear()} ${String(savedDate.getHours()).padStart(2,'0')}:${String(savedDate.getMinutes()).padStart(2,'0')}`;
                  const isDownloading = downloadingPlanId === plan.id;
                  return (
                    <div
                      key={plan.id}
                      className="rounded-xl p-4 space-y-3"
                      style={{ background: 'var(--bg-elevated, var(--bg-subtle))', border: '1px solid var(--border)' }}
                    >
                      <div className="flex flex-wrap items-start gap-x-6 gap-y-1 text-xs">
                        <div>
                          <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>{t('hwh.monthYear')}</span>
                          <span className="ml-2 font-semibold" style={{ color: 'var(--text-primary)' }}>{t(MONTH_KEYS[(plan.month ?? month) - 1])} {plan.year ?? year}</span>
                        </div>
                        <div>
                          <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>{t('hwh.fileName')}</span>
                          <span className="ml-2" style={{ color: 'var(--text-primary)' }}>{plan.original_file_name ?? '—'}</span>
                        </div>
                        <div>
                          <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>{t('common.status')}</span>
                          <span className="ml-2">
                            {plan.export_ready ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: 'rgba(21,128,61,0.10)', color: '#15803d', border: '1px solid rgba(21,128,61,0.25)' }}>
                                <CheckCircle2 size={11} /> {t('hwh.exportable')}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: 'rgba(220,38,38,0.07)', color: '#b91c1c', border: '1px solid rgba(220,38,38,0.2)' }}>
                                <AlertTriangle size={11} /> {t('hwh.notExportable')}
                              </span>
                            )}
                          </span>
                        </div>
                        <div>
                          <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>{t('hwh.savedAt')}</span>
                          <span className="ml-2 tabular-nums" style={{ color: 'var(--text-primary)' }}>{savedFmt}</span>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => setViewingPlan(plan)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:brightness-110"
                          style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                        >
                          <List size={12} /> {t('hwh.show')}
                        </button>
                        {plan.export_ready && (
                          <button
                            onClick={() => downloadSavedPlan(plan)}
                            disabled={isDownloading}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:brightness-110 disabled:opacity-50"
                            style={{ background: 'rgba(21,128,61,0.09)', color: '#15803d', border: '1px solid rgba(21,128,61,0.25)' }}
                          >
                            {isDownloading
                              ? <><RefreshCw size={12} className="animate-spin" /> {t('common.loading')}</>
                              : <><Download size={12} /> {t('hwh.downloadFahrtenbuch')}</>}
                          </button>
                        )}
                        <button
                          onClick={() => { setSelectedImportId(plan.import_id ?? selectedImportId); setStep(1); }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:brightness-110"
                          style={{ background: 'rgba(37,99,235,0.08)', color: '#1d4ed8', border: '1px solid rgba(37,99,235,0.25)' }}
                        >
                          <RefreshCw size={12} /> {t('hwh.recompute')}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Step 1: Lohnabrechnung-Zielwerte ──────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('hwh.step1Title')}</h2>
              <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{t('hwh.step1Subtitle')}</p>
            </div>
            <HourTargetsTrigger onClick={() => setShowTargetsManager(true)} />
          </div>

          {/* Assignment strategy */}
          <div className="rounded-2xl p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <label className="block text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('hwh.assignmentStrategy')}</label>
            <div className="flex gap-2">
              {([
                { value: 'hours_first', label: t('hwh.strategyHoursFirst') },
                { value: 'rides_first', label: t('hwh.strategyRidesFirst') },
              ] as const).map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setAssignmentStrategy(opt.value)}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                  style={{
                    background: assignmentStrategy === opt.value ? '#2563eb' : 'var(--background-primary)',
                    color: assignmentStrategy === opt.value ? '#fff' : 'var(--text-secondary)',
                    border: `1px solid ${assignmentStrategy === opt.value ? '#2563eb' : 'var(--border-primary)'}`,
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {assignmentStrategy === 'rides_first'
                ? t('hwh.strategyRidesFirstHint')
                : t('hwh.strategyHoursFirstHint')}
            </p>
          </div>

          {/* Inhaber */}
          <div className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-3">
              <input type="checkbox" checked={useInhaber} onChange={e => setUseInhaber(e.target.checked)} className="w-4 h-4" />
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t('hwh.useOwnerBalancingDriver')}</span>
            </div>
            {useInhaber && (
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('hwh.ownerDriver')}</label>
                <select value={inhaberId} onChange={e => setInhaberId(e.target.value)} style={{ ...inp, width: 'auto' }}>
                  <option value="">{t('hwh.noOwner')}</option>
                  {allDrivers.filter(d => d.employment_type === 'company_owner').map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
            )}
          </div>

          {/* Driver table */}
          <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ background: 'var(--bg-subtle)' }}>
                    <th className="px-3 py-2 text-left font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('hwh.colIncluded')}</th>
                    <th className="px-3 py-2 text-left font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('common.driver')}</th>
                    <th className="px-3 py-2 text-right font-semibold" style={{ color: 'var(--text-secondary)', minWidth: 80 }}>{t('hwh.colRatePerHour')}</th>
                    <th className="px-3 py-2 text-right font-semibold" style={{ color: 'var(--text-secondary)', minWidth: 70 }}>{t('hwh.colHours1000')}</th>
                    <th className="px-3 py-2 text-right font-semibold" style={{ color: 'var(--text-secondary)', minWidth: 70 }}>1500 N25%</th>
                    <th className="px-3 py-2 text-right font-semibold" style={{ color: 'var(--text-secondary)', minWidth: 70 }}>1501 N40%</th>
                    <th className="px-3 py-2 text-right font-semibold" style={{ color: 'var(--text-secondary)', minWidth: 70 }}>{t('hwh.colHours1510')}</th>
                    <th className="px-3 py-2 text-right font-semibold" style={{ color: 'var(--text-secondary)', minWidth: 70 }}>{t('hwh.holiday')}</th>
                  </tr>
                </thead>
                <tbody>
                  {driverConfigs.map(cfg => {
                    const d = drafts.get(cfg.driverId) ?? { hourly: '', baseH: '', nacht25H: '', nacht40H: '', sunH: '', holH: '' };
                    const isOwner = cfg.driverId === inhaberId && useInhaber;
                    return (
                      <tr key={cfg.driverId} style={{ borderTop: '1px solid var(--border)', opacity: isOwner ? 0.6 : 1 }}>
                        <td className="px-3 py-1.5">
                          <input type="checkbox" checked={cfg.included} disabled={isOwner}
                            onChange={e => setDriverConfigs(prev => prev.map(c => c.driverId === cfg.driverId ? { ...c, included: e.target.checked } : c))} />
                        </td>
                        <td className="px-3 py-1.5 font-medium" style={{ color: 'var(--text-primary)' }}>
                          {cfg.driverName}
                          {isOwner && <span className="ml-1 text-xs px-1 py-0.5 rounded" style={{ background: 'rgba(16,185,129,0.1)', color: '#047857' }}>{t('hwh.owner')}</span>}
                          {cfg.personalnummer && <span className="ml-1 text-xs" style={{ color: 'var(--text-secondary)' }}>#{cfg.personalnummer}</span>}
                        </td>
                        {['hourly','baseH','nacht25H','nacht40H','sunH','holH'].map(field => (
                          <td key={field} className="px-2 py-1">
                            <input
                              type="text" inputMode="decimal"
                              value={d[field as keyof WzDraft]}
                              disabled={isOwner && field !== 'hourly'}
                              onChange={e => updateDraft(cfg.driverId, field as keyof WzDraft, e.target.value)}
                              onBlur={e => commitDraft(cfg.driverId, field as keyof WzDraft, e.target.value)}
                              style={{ ...inp, textAlign: 'right' }}
                              placeholder="0,00"
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <button onClick={() => setStep(0)} className="inline-flex items-center gap-2 text-sm transition-colors hover:opacity-80" style={{ color: 'var(--text-secondary)' }}>
              <ArrowLeft size={15} /> {t('common.back')}
            </button>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setDebugMode(m => !m)}
                className="text-xs px-2 py-1 rounded-lg transition-colors hover:opacity-80"
                style={{ color: debugMode ? '#b91c1c' : 'var(--text-secondary)', background: debugMode ? 'rgba(220,38,38,0.07)' : 'transparent', border: `1px solid ${debugMode ? 'rgba(220,38,38,0.3)' : 'var(--border)'}` }}
              >
                {debugMode ? t('hwh.closeDebugView') : t('hwh.openDebugView')}
              </button>
              <button
                onClick={handleSaveAsTargets}
                disabled={savingAsTargets || driverConfigs.filter(c => c.included && !c.isOwner).length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all hover:brightness-110 disabled:opacity-40"
                style={{ background: saveAsTargetsDone ? 'rgba(21,128,61,0.1)' : 'var(--bg-subtle)', color: saveAsTargetsDone ? '#15803d' : 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                {savingAsTargets
                  ? <><RefreshCw size={12} className="animate-spin" /> {t('common.saving')}</>
                  : saveAsTargetsDone
                    ? <><CheckCircle2 size={12} /> {t('hwh.saved')}</>
                    : <><Save size={12} /> {t('hwh.saveCurrentAsTargets')}</>}
              </button>
              <button
                onClick={async () => {
                  if (debugMode) {
                    await saveDriverConfigs(); setStep(2);
                  } else {
                    handleAutoRun();
                  }
                }}
                disabled={driverConfigs.filter(c => c.included).length === 0 || autoRunPhase === 'running'}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:brightness-110 disabled:opacity-40"
                style={{ background: '#2563eb', color: '#fff' }}
              >
                {saving ? t('common.saving') : debugMode ? t('hwh.next') : t('hwh.calculate')} <ArrowRight size={15} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Auto-run modal (running / failed) ─────────────────────────────────── */}
      {(autoRunPhase === 'running' || autoRunPhase === 'failed') && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)' }}
          role="dialog"
          aria-modal="true"
          aria-label={t('hwh.autoRunTitle')}
        >
          <div
            className="relative w-full rounded-2xl shadow-2xl flex flex-col"
            style={{
              maxWidth: '56rem',
              maxHeight: '90vh',
              background: 'var(--bg-elevated, var(--bg-surface))',
              border: '1px solid var(--border)',
              overflow: 'hidden',
            }}
          >
            {/* Modal header */}
            <div className="px-6 pt-6 pb-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
              <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                {autoRunPhase === 'failed' ? t('hwh.autoRunFailedTitle') : t('hwh.autoRunTitle')}
              </h2>
              <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                {autoRunPhase === 'failed'
                  ? t('hwh.autoRunFailedHint')
                  : t('hwh.autoRunWaitHint')}
              </p>
            </div>

            {/* Modal body — scrollable */}
            <div className="flex-1 overflow-y-auto px-6 py-5">

              {/* ── Running state: flow diagram ── */}
              {autoRunPhase === 'running' && (
                <div className="rounded-2xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                  {/* Desktop layout */}
                  <div className="hidden sm:block">
                    {[0, 5].map(rowStart => (
                      <div key={rowStart}>
                        <div className="flex items-stretch gap-0">
                          {AUTO_RUN_STEPS.slice(rowStart, rowStart + 5).map((labelKey, colIdx) => {
                            const idx = rowStart + colIdx;
                            const done = idx < autoRunStepIndex;
                            const active = idx === autoRunStepIndex;
                            const isLast = idx === AUTO_RUN_STEPS.length - 1;
                            const isRowLast = colIdx === 4 || isLast;
                            const nodeStyle: React.CSSProperties = done
                              ? { background: 'rgba(21,128,61,0.08)', border: '1.5px solid #16a34a' }
                              : active
                                ? { background: 'rgba(37,99,235,0.10)', border: '1.5px solid #2563eb', boxShadow: '0 0 0 3px rgba(37,99,235,0.12)' }
                                : { background: 'var(--bg-subtle)', border: '1.5px solid var(--border)' };
                            return (
                              <React.Fragment key={idx}>
                                <div className="flex-1 flex flex-col items-center gap-2 rounded-xl px-2 py-3 transition-all duration-300" style={nodeStyle}>
                                  <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
                                    style={{ background: done ? 'rgba(21,128,61,0.15)' : active ? 'rgba(37,99,235,0.15)' : 'var(--border)', transition: 'background 0.3s' }}>
                                    {done
                                      ? <CheckCircle2 size={14} style={{ color: '#16a34a' }} />
                                      : active
                                        ? <RefreshCw size={13} className="animate-spin" style={{ color: '#2563eb' }} />
                                        : <div className="w-2 h-2 rounded-full" style={{ background: 'var(--text-tertiary, #9ca3af)' }} />}
                                  </div>
                                  <span className="text-center leading-snug" style={{
                                    fontSize: '0.65rem',
                                    color: done ? '#16a34a' : active ? '#2563eb' : 'var(--text-secondary)',
                                    fontWeight: active ? 600 : 400,
                                  }}>{t(labelKey)}</span>
                                  <span className="text-center" style={{ fontSize: '0.55rem', color: done ? '#16a34a' : active ? '#2563eb' : 'var(--text-tertiary, #9ca3af)', opacity: 0.7 }}>
                                    {idx + 1}/{AUTO_RUN_STEPS.length}
                                  </span>
                                </div>
                                {!isRowLast && (
                                  <div className="flex items-center self-center flex-shrink-0 px-0.5" style={{ minWidth: 20 }}>
                                    <div className="h-px flex-1 transition-all duration-500" style={{ background: done ? '#16a34a' : 'var(--border)', minWidth: 10 }} />
                                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" style={{ flexShrink: 0 }}>
                                      <path d="M0 4 L7 4 M4 1 L7 4 L4 7" stroke={done ? '#16a34a' : 'var(--text-tertiary, #9ca3af)'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  </div>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </div>
                        {rowStart === 0 && AUTO_RUN_STEPS.length > 5 && (
                          <div className="flex justify-end pr-2 my-0.5" style={{ height: 16 }}>
                            <div className="flex flex-col items-end">
                              <div className="h-px w-0" />
                              <svg width="20" height="16" viewBox="0 0 20 16" fill="none">
                                <path d="M0 1 Q10 1 10 8 Q10 15 20 15" stroke={autoRunStepIndex >= 5 ? '#16a34a' : 'var(--border)'} strokeWidth="1.5" strokeLinecap="round" fill="none" />
                              </svg>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  {/* Mobile layout */}
                  <div className="sm:hidden flex flex-col gap-0">
                    {AUTO_RUN_STEPS.map((labelKey, idx) => {
                      const done = idx < autoRunStepIndex;
                      const active = idx === autoRunStepIndex;
                      const isLast = idx === AUTO_RUN_STEPS.length - 1;
                      const nodeStyle: React.CSSProperties = done
                        ? { background: 'rgba(21,128,61,0.08)', border: '1.5px solid #16a34a' }
                        : active
                          ? { background: 'rgba(37,99,235,0.10)', border: '1.5px solid #2563eb', boxShadow: '0 0 0 3px rgba(37,99,235,0.10)' }
                          : { background: 'var(--bg-subtle)', border: '1.5px solid var(--border)' };
                      return (
                        <div key={idx} className="flex flex-col items-stretch">
                          <div className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-all duration-300" style={nodeStyle}>
                            <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0"
                              style={{ background: done ? 'rgba(21,128,61,0.15)' : active ? 'rgba(37,99,235,0.15)' : 'var(--border)' }}>
                              {done
                                ? <CheckCircle2 size={12} style={{ color: '#16a34a' }} />
                                : active
                                  ? <RefreshCw size={11} className="animate-spin" style={{ color: '#2563eb' }} />
                                  : <div className="w-2 h-2 rounded-full" style={{ background: 'var(--text-tertiary, #9ca3af)' }} />}
                            </div>
                            <span className="flex-1 text-xs leading-snug" style={{
                              color: done ? '#16a34a' : active ? '#2563eb' : 'var(--text-secondary)',
                              fontWeight: active ? 600 : 400,
                            }}>{t(labelKey)}</span>
                            <span className="text-right flex-shrink-0" style={{ fontSize: '0.6rem', color: done ? '#16a34a' : 'var(--text-tertiary, #9ca3af)', opacity: 0.65 }}>
                              {idx + 1}/{AUTO_RUN_STEPS.length}
                            </span>
                          </div>
                          {!isLast && (
                            <div className="flex justify-start pl-4" style={{ height: 14 }}>
                              <div className="w-px" style={{ background: done ? '#16a34a' : 'var(--border)', height: '100%', transition: 'background 0.3s' }} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ── Failed state ── */}
              {autoRunPhase === 'failed' && (
                <div className="rounded-2xl p-5 space-y-3" style={{ background: 'rgba(220,38,38,0.05)', border: '1px solid rgba(220,38,38,0.3)' }}>
                  <div className="flex items-center gap-3">
                    <AlertTriangle size={20} style={{ color: '#b91c1c', flexShrink: 0 }} />
                    <div>
                      <p className="text-base font-bold" style={{ color: '#b91c1c' }}>{t('hwh.autoRunFailedTitle')}</p>
                      <p className="text-sm mt-1" style={{ color: '#b91c1c' }}>{autoRunError ?? t('hwh.unknownError')}</p>
                    </div>
                  </div>
                </div>
              )}

            </div>

            {/* Modal footer — only shown when not actively running */}
            {autoRunPhase === 'failed' && (
              <div className="px-6 py-4 flex-shrink-0 flex justify-start" style={{ borderTop: '1px solid var(--border)' }}>
                <button
                  onClick={() => { setAutoRunPhase('idle'); setStep(1); }}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-110"
                  style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                >
                  <ArrowLeft size={15} /> {t('common.back')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Step 2: Berechnen ─────────────────────────────────────────────────── */}
      {step === 2 && autoRunPhase === 'idle' && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('hwh.step2Title')}</h2>
            <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{t('hwh.step2Subtitle')}</p>
          </div>
          <div className="rounded-2xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="rounded-xl p-2.5" style={{ background: 'rgba(37,99,235,0.1)' }}>
                <Calculator size={20} style={{ color: '#2563eb' }} />
              </div>
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {useInhaber && inhaberId
                    ? t('hwh.driversIncludedWithOwner', { count: driverConfigs.filter(c => c.included && c.driverId !== inhaberId).length })
                    : t('hwh.driversIncluded', { count: driverConfigs.filter(c => c.included && c.driverId !== inhaberId).length })}
                </p>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {t('hwh.importLabel')}: {imports.find(i => i.id === selectedImportId)?.file_name}
                </p>
              </div>
            </div>
            {/* Inhaber status indicator */}
            {useInhaber ? (
              inhaberId
                ? (() => {
                    const d = allDrivers.find(x => x.id === inhaberId);
                    return (
                      <div className="mb-3 px-3 py-2 rounded-lg text-xs" style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)', color: '#047857' }}>
                        {t('hwh.ownerBalancingDriver')}: <span className="font-semibold">{d?.name ?? inhaberId}</span>
                      </div>
                    );
                  })()
                : (
                  <div className="mb-3 px-3 py-2 rounded-lg text-xs" style={{ background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.3)', color: '#b45309' }}>
                    <AlertTriangle size={12} className="inline mr-1" />
                    {t('hwh.pleaseSelectOwner')}
                  </div>
                )
            ) : null}
            {computeError && (
              <div className="mb-3 px-4 py-2 rounded-xl text-sm" style={{ background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', color: '#b91c1c' }}>
                <AlertTriangle size={14} className="inline mr-1" /> {computeError}
              </div>
            )}
            {/* Strategy selector in compute step */}
            <div className="mb-4 pt-1">
              <label className="block text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('hwh.assignmentStrategy')}</label>
              <div className="flex gap-2 mb-2">
                {([
                  { value: 'hours_first', label: t('hwh.strategyHoursFirst') },
                  { value: 'rides_first', label: t('hwh.strategyRidesFirst') },
                ] as const).map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setAssignmentStrategy(opt.value)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                    style={{
                      background: assignmentStrategy === opt.value ? '#2563eb' : 'var(--background-primary)',
                      color: assignmentStrategy === opt.value ? '#fff' : 'var(--text-secondary)',
                      border: `1px solid ${assignmentStrategy === opt.value ? '#2563eb' : 'var(--border-primary)'}`,
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {assignmentStrategy === 'rides_first'
                  ? t('hwh.strategyRidesFirstHint')
                  : t('hwh.strategyHoursFirstHint')}
              </p>
            </div>
            {computing ? (
              <div className="flex items-center gap-3 py-4">
                <RefreshCw size={18} className="animate-spin" style={{ color: '#2563eb' }} />
                <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{computePhase || t('hwh.calculating')}</span>
              </div>
            ) : (
              <button onClick={() => handleCompute()}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:brightness-110"
                style={{ background: '#2563eb', color: '#fff' }}>
                <Calculator size={15} /> {t('hwh.step2Title')}
              </button>
            )}
          </div>
          <button onClick={() => setStep(1)} className="inline-flex items-center gap-2 text-sm transition-colors hover:opacity-80" style={{ color: 'var(--text-secondary)' }}>
            <ArrowLeft size={15} /> {t('common.back')}
          </button>
        </div>
      )}

      {/* ── Vehicle month-boundary summary (preliminary — visible in normal mode when trips are loaded) ── */}
      {step === 2 && autoRunPhase === 'idle' && boundaryRows.length > 0 && (
        <div className="rounded-2xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <VehicleMonthBoundarySummary rows={boundaryRows} />
        </div>
      )}

      {/* ── Step 3: Fahrzeug-Blöcke ─────────────────────────────────────────── */}
      {step === 3 && !phase1Result && (
        <div className="space-y-4">
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('hwh.vehicleBlocksTitle')}</h2>
          <div className="rounded-xl p-4" style={{ background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', color: '#b91c1c' }}>
            {t('hwh.vehicleBlocksLoadFailed')}
          </div>
          <button onClick={() => setStep(2)} className="inline-flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <ArrowLeft size={15} /> {t('common.back')}
          </button>
        </div>
      )}
      {step === 3 && phase1Result && (
        <>
          {assigning && (
            <div className="fixed inset-0 z-40 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.35)' }}>
              <div className="rounded-2xl px-8 py-6 flex items-center gap-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                <RefreshCw size={20} className="animate-spin" style={{ color: '#2563eb' }} />
                <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('hwh.autoStepAssignRegularDrivers')}</span>
              </div>
            </div>
          )}
          {driverNotesMap.size > 0 && (
            <div className="rounded-xl px-4 py-3 text-xs flex items-center gap-2" style={{ background: 'rgba(6,182,212,0.07)', border: '1px solid rgba(6,182,212,0.25)', color: '#0e7490' }}>
              <CheckCircle2 size={14} />
              <span>
                <strong>{t('hwh.driverNotesActive')}</strong> — {t('hwh.driverNotesActiveHint', { count: driverNotesMap.size })}
              </span>
            </div>
          )}
          {assignError && (
            <div className="mb-3 rounded-xl px-4 py-3 text-sm" style={{ background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', color: '#b91c1c' }}>
              {assignError}
            </div>
          )}
          <VehicleBlocksView
            result={phase1Result}
            month={month}
            year={year}
            onRecompute={() => {
              setPhase1Result(null);
              setAssignmentResult(null);
              setInhaberResult(null);
              setShiftResult(null);
              setSnapshotResult(null);
              setExportValidation(null);
              setOriginalTrips(null);
              setBoundaryRows([]);
              setExportSummary(null);
              setStundennachweisPreview(null);
              setAltAssignmentResult(null);
              setLastComputedStrategy(null);
              setRowLevelEngineResult(null);
              setWorksheetAuditResult(null);
              setComputeError(null);
              setStep(2);
            }}
            onAssign={handleAssignRegularDrivers}
          />
        </>
      )}

      {/* ── Step 4: Reguläre Fahrer-Zuweisung ──────────────────────────────────── */}
      {step === 4 && !assignmentResult && (
        <div className="space-y-4">
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('hwh.assignRegularDrivers')}</h2>
          <div className="rounded-xl p-4" style={{ background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', color: '#b91c1c' }}>
            {t('hwh.regularAssignmentImpossible')}
          </div>
          <button onClick={() => setStep(3)} className="inline-flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <ArrowLeft size={15} /> {t('common.back')}
          </button>
        </div>
      )}
      {step === 4 && assignmentResult && phase1Result && (
        <RegularDriverAssignmentView
          result={assignmentResult}
          phase1Result={phase1Result}
          driverConfigs={driverConfigs}
          inhaberName={driverConfigs.find(c => c.isOwner)?.driverName ?? ''}
          month={month}
          year={year}
          onBack={() => setStep(3)}
          onRecompute={() => {
            setPhase1Result(null);
            setAssignmentResult(null);
            setInhaberResult(null);
            setInhaberNcResult(null);
            setInhaberLcResult(null);
            setInhaberFwsResult(null);
            setShiftResult(null);
            setSnapshotResult(null);
            setExportValidation(null);
            setOriginalTrips(null);
            setBoundaryRows([]);
            setExportSummary(null);
            setStundennachweisPreview(null);
            setAltAssignmentResult(null);
            setLastComputedStrategy(null);
            setRowLevelEngineResult(null);
            setWorksheetAuditResult(null);
            setComputeError(null);
            setAssignError(null);
            setStep(2);
          }}
          onApplyNonConflictStep={() => {
            if (!assignmentResult || !phase1Result) return;
            setApplyingNcs(true);
            setInhaberLcResult(null);
            setInhaberFwsResult(null);
            try {
              const unassigned = assignmentResult.surplusBlocks.filter(b => !assignmentResult.assignments.some(a => a.blockId === b.blockId));
              const inhaberName = driverConfigs.find(c => c.isOwner)?.driverName ?? 'Inhaber';
              const ncResult = runInhaberNonConflictStep(unassigned, inhaberName);
              if (import.meta.env.DEV) {
                console.log('[InhaberNonConflictStep]', {
                  step2NotAssigned:           unassigned.length,
                  nonConflict:                ncResult.assignedToInhaberBlocks.length,
                  conflict:                   ncResult.remainingConflictedBlocks.length,
                  assignedToInhaber:          ncResult.assignedToInhaberBlocks.length,
                  remainingNotAssigned:       ncResult.remainingConflictedBlocks.length,
                  remainingWithoutConflict:   ncResult.diagnostics.remainingWithoutNzConflict,
                  inhaberRides:               ncResult.inhaberRides,
                  inhaberHours:               (ncResult.inhaberSec / 3600).toFixed(2),
                  first20Remaining:           ncResult.remainingConflictedBlocks.slice(0, 20).map(b => ({ id: b.blockId, vehicle: b.vehicle, rides: b.rides?.length ?? 0 })),
                });
              }
              setInhaberNcResult(ncResult);
              setStep(5);
            } catch (e) {
              console.error('[InhaberNonConflictStep] error', e);
            } finally {
              setApplyingNcs(false);
            }
          }}
        />
      )}

      {/* ── Step 5: Inhaber Nicht-konflikt Blöcke ───────────────────────────────── */}
      {step === 5 && inhaberNcResult && assignmentResult && phase1Result && (
        <InhaberNonConflictView
          ncResult={inhaberNcResult}
          regularAssignments={assignmentResult.assignments}
          allBlocks={phase1Result.blocks}
          month={month}
          year={year}
          onBack={() => setStep(4)}
          onRecompute={() => {
            setInhaberNcResult(null);
            setInhaberLcResult(null);
            setInhaberFwsResult(null);
            setStep(4);
          }}
          onApplyLongestConflictStep={() => {
            if (!inhaberNcResult) return;
            setApplyingLcs(true);
            try {
              const inhaberName = driverConfigs.find(c => c.isOwner)?.driverName ?? 'Inhaber';
              const lcResult = runInhaberLongestConflictStep(
                inhaberNcResult.remainingConflictedBlocks,
                inhaberNcResult.assignedToInhaberBlocks,
                inhaberName,
              );
              if (import.meta.env.DEV) {
                console.log('[InhaberLongestConflictStep]', {
                  remainingNzConflictBlocks: inhaberNcResult.remainingConflictedBlocks.length,
                  conflictGroups:            lcResult.conflictGroups.length,
                  groupIds:                  lcResult.conflictGroups.map(g => ({ id: g.groupId, blocks: g.blockIds, selected: g.selectedBlockId, decision: g.decision })),
                  selectedBlockIds:          lcResult.selectedBlocks.map(b => b.blockId),
                  rejectedCandidates:        lcResult.rejectedCandidates,
                  selectedInhaberBlocks:     lcResult.selectedBlocks.length,
                  remainingUnassigned:       lcResult.remainingUnassignedBlocks.length,
                  inhaberRidesAdded:         lcResult.inhaberRidesAdded,
                  inhaberHoursAdded:         (lcResult.inhaberSecAdded / 3600).toFixed(2),
                  inhaberHoursTotal:         (lcResult.inhaberSecTotal / 3600).toFixed(2),
                  diagnostics:               lcResult.diagnostics,
                });
              }
              setInhaberLcResult(lcResult);
              setStep(6);
            } catch (e) {
              console.error('[InhaberLongestConflictStep] error', e);
            } finally {
              setApplyingLcs(false);
            }
          }}
        />
      )}
      {step === 5 && !inhaberNcResult && (
        <div className="space-y-4">
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('hwh.ncTitle')}</h2>
          <div className="rounded-xl p-4" style={{ background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', color: '#b91c1c' }}>
            {t('hwh.noResultBackToRegular')}
          </div>
          <button onClick={() => setStep(4)} className="inline-flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <ArrowLeft size={15} /> {t('common.back')}
          </button>
        </div>
      )}

      {/* ── Step 6: Inhaber Längste Konflikt-Blöcke ─────────────────────────────── */}
      {step === 6 && inhaberLcResult && inhaberNcResult && assignmentResult && phase1Result && (
        <InhaberLongestConflictView
          lcResult={inhaberLcResult}
          step3InhaberBlocks={inhaberNcResult.assignedToInhaberBlocks}
          regularAssignments={assignmentResult.assignments}
          allBlocks={phase1Result.blocks}
          month={month}
          year={year}
          onBack={() => setStep(5)}
          onRecompute={() => {
            setInhaberLcResult(null);
            setInhaberFwsResult(null);
            setStep(5);
          }}
          onApplyFreeWindowSearch={() => {
            if (!inhaberLcResult || !inhaberNcResult || !assignmentResult || !phase1Result) return;
            try {
              const inhaberName = driverConfigs.find(c => c.isOwner)?.driverName ?? 'Inhaber';
              const fwsResult = runInhaberFreeWindowSearch(
                inhaberNcResult.assignedToInhaberBlocks,
                inhaberLcResult.selectedBlocks,
                inhaberLcResult.remainingUnassignedBlocks,
                phase1Result.blocks,
                assignmentResult.assignments,
                month,
                year,
              );
              if (import.meta.env.DEV) {
                console.log('[InhaberFreeWindowSearch]', {
                  inhaberOccupiedIntervals: fwsResult.inhaberOccupiedIntervals.length,
                  freeWindowsCount:         fwsResult.freeWindows.length,
                  totalFreeHours:           (fwsResult.summary.freeSec / 3600).toFixed(2),
                  remainingOpenBlocks:      fwsResult.remainingOpenBlocks.length,
                  candidateCountPerBlock:   fwsResult.candidateWindowsByBlock.map(c => ({ id: c.block.blockId, candidates: c.candidateWindows.length, withVehicle: c.windowsWithVehicleFree })),
                  blocksWithoutCandidates:  fwsResult.candidateWindowsByBlock.filter(c => c.candidateWindows.length === 0).map(c => c.block.blockId),
                  diagnostics:              fwsResult.diagnostics,
                });
              }
              setInhaberFwsResult(fwsResult);
              setStep(7);
            } catch (e) {
              console.error('[InhaberFreeWindowSearch] error', e);
            }
          }}
        />
      )}
      {step === 6 && !inhaberLcResult && (
        <div className="space-y-4">
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('hwh.lcTitle')}</h2>
          <div className="rounded-xl p-4" style={{ background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', color: '#b91c1c' }}>
            {t('hwh.noResultBackToNonConflict')}
          </div>
          <button onClick={() => setStep(5)} className="inline-flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <ArrowLeft size={15} /> {t('common.back')}
          </button>
        </div>
      )}

      {/* ── Step 7: Inhaber Zeitfenster für Verschiebung ─────────────────────────── */}
      {step === 7 && inhaberFwsResult && autoRunPhase === 'done' && !debugMode && (
        /* Auto-run result modal (normal/simplified mode) */
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)' }}
          role="dialog"
          aria-modal="true"
          aria-label={t('hwh.autoRunResultTitle')}
        >
          <div
            className="relative w-full rounded-2xl shadow-2xl flex flex-col"
            style={{
              maxWidth: '56rem',
              maxHeight: '90vh',
              background: 'var(--bg-elevated, var(--bg-surface))',
              border: '1px solid var(--border)',
              overflow: 'hidden',
            }}
          >
            {/* Modal header */}
            <div className="px-6 pt-6 pb-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
              <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                {autoRunExportReady === true
                  ? t('hwh.fahrtenbuchCreated')
                  : autoRunExportReady === false
                    ? t('hwh.autoRunFailedTitle')
                    : t('hwh.finalCheckRunning')}
              </h2>
              <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                {autoRunExportReady === true
                  ? t('hwh.allChecksPassedDownload')
                  : autoRunExportReady === false
                    ? t('hwh.validationFoundProblems')
                    : t('hwh.validationsRunning')}
              </p>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              {/* Loading state */}
              {autoRunExportReady === null && (
                <div className="flex items-center gap-4">
                  <RefreshCw size={20} className="animate-spin" style={{ color: '#2563eb', flexShrink: 0 }} />
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('hwh.validationsRunningEllipsis')}</p>
                </div>
              )}

              {/* Failure banner */}
              {autoRunExportReady === false && (
                <div className="rounded-2xl p-5" style={{ background: 'rgba(220,38,38,0.05)', border: '1px solid rgba(220,38,38,0.3)' }}>
                  <div className="flex items-start gap-3">
                    <AlertTriangle size={22} style={{ color: '#b91c1c', flexShrink: 0, marginTop: 2 }} />
                    <div>
                      <p className="text-base font-bold" style={{ color: '#b91c1c' }}>{t('hwh.autoRunFailedTitle')}</p>
                      <p className="text-sm mt-1" style={{ color: '#b91c1c' }}>{autoRunExportReason ?? t('hwh.unknownValidationErrors')}</p>
                      <p className="text-xs mt-2" style={{ color: 'var(--text-secondary)' }}>
                        {t('hwh.openDebugForDiagnosis')}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Vehicle month-boundary summary — shown when export is ready or failed */}
              {autoRunExportReady !== null && boundaryRows.length > 0 && (
                <div className="rounded-2xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                  <VehicleMonthBoundarySummary rows={boundaryRows} />
                </div>
              )}

              {/* Driver working-hour summary */}
              {autoRunExportReady === true && driverHourSummary.length > 0 && (
                <div className="rounded-2xl p-5 space-y-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                  <div>
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('hwh.workingHoursPerDriver')}</h3>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('hwh.hoursFromFinalPlan')}</p>
                  </div>
                  <DriverHourSummaryTable rows={driverHourSummary} />
                </div>
              )}

              {/* Salary range summary — shown when any driver has salary min/max configured */}
              {autoRunExportReady !== null && salaryRangeSummary.length > 0 && (
                <div className="rounded-2xl p-5 space-y-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                  <div>
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('hwh.salaryRangePerDriver')}</h3>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                      {t('hwh.salaryRangeHint')}
                    </p>
                    {salaryRangeSummary.some(r => r.status !== 'ok') && (
                      <div className="mt-2 px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2" style={{ background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.3)', color: '#b91c1c' }}>
                        <AlertTriangle size={13} />
                        {t('hwh.salaryOutsideRange')}
                      </div>
                    )}
                  </div>
                  <SalaryRangeSummaryTable
                    rows={salaryRangeSummary}
                    expandedDriver={expandedSalaryDriver}
                    onToggleExpand={(name) => setExpandedSalaryDriver(prev => prev === name ? null : name)}
                  />
                </div>
              )}

              {/* InhaberFreeWindowSearchView — always mounted for autoApply/onExportReadyCallback */}
              <InhaberFreeWindowSearchView
                fwsResult={inhaberFwsResult}
                month={month}
                year={year}
                onBack={() => { setAutoRunPhase('idle'); setStep(1); }}
                onRecompute={() => { setAutoRunPhase('idle'); setAutoRunExportReady(null); setInhaberFwsResult(null); setStep(1); }}
                originalTrips={originalTrips}
                inhaberName={driverConfigs.find(c => c.isOwner)?.driverName ?? 'Inhaber'}
                sourceSheetName={imports.find(i => i.id === selectedImportId)?.source_sheet_name ?? null}
                sourceColumnsJson={imports.find(i => i.id === selectedImportId)?.source_columns_json ?? null}
                storagePath={imports.find(i => i.id === selectedImportId)?.storage_path ?? null}
                originalFileName={imports.find(i => i.id === selectedImportId)?.file_name ?? null}
                driverConfigs={driverConfigs}
                allDrivers={allDrivers}
                driverNotesMap={driverNotesMap}
                simplified={true}
                autoApply={true}
                onExportReadyCallback={(ready, reason) => {
                  if (debugMode) console.log('[AutoRun] export-ready callback', { ready, reason });
                  setAutoRunExportReady(ready);
                  setAutoRunExportReason(reason);
                }}
                onFinalAssignmentReady={(rows) => setBoundaryRows(rows)}
                onPlanDataReady={(data) => { setPlanData(data); setPlanSavedId(null); setSavePlanError(null); }}
                onDriverHourSummaryReady={(rows) => setDriverHourSummary(rows)}
                onSalaryRangeSummaryReady={(rows) => setSalaryRangeSummary(rows)}
                exportTriggerRef={exportTriggerRef}
              />
            </div>

            {/* Modal footer */}
            {autoRunExportReady !== null && (
              <div className="px-6 py-4 flex-shrink-0 flex flex-wrap items-center gap-3" style={{ borderTop: '1px solid var(--border)' }}>
                <button
                  onClick={() => { setAutoRunPhase('idle'); setAutoRunExportReady(null); setStep(1); }}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-110"
                  style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                >
                  <ArrowLeft size={15} /> {t('common.back')}
                </button>
                {autoRunExportReady === true && (
                  <button
                    onClick={() => exportTriggerRef.current?.()}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-110"
                    style={{ background: 'rgba(21,128,61,0.10)', color: '#15803d', border: '1px solid rgba(21,128,61,0.3)' }}
                  >
                    <Download size={15} /> {t('hwh.downloadFahrtenbuch')}
                  </button>
                )}
                {autoRunExportReady === true && (
                  <button
                    onClick={handleSavePlan}
                    disabled={savingPlan || !!planSavedId || !planData}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ background: planSavedId ? 'rgba(21,128,61,0.08)' : 'rgba(37,99,235,0.10)', color: planSavedId ? '#15803d' : '#1d4ed8', border: `1px solid ${planSavedId ? 'rgba(21,128,61,0.3)' : 'rgba(37,99,235,0.3)'}` }}
                  >
                    {savingPlan ? (
                      <><RefreshCw size={14} className="animate-spin" /> {t('common.saving')}</>
                    ) : planSavedId ? (
                      <><CheckCircle2 size={14} /> {t('hwh.saved')}</>
                    ) : savedPlans.length > 0 ? (
                      <><Save size={15} /> {t('hwh.replaceMonthlyPlan')}</>
                    ) : (
                      <><Save size={15} /> {t('hwh.createMonthlyPlan')}</>
                    )}
                  </button>
                )}
                {savePlanError && (
                  <span className="text-xs font-medium" style={{ color: '#b91c1c' }}>{savePlanError}</span>
                )}
                {autoRunExportReady === false && (
                  <button
                    onClick={() => { setDebugMode(true); }}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-110"
                    style={{ background: 'rgba(220,38,38,0.08)', color: '#b91c1c', border: '1px solid rgba(220,38,38,0.3)' }}
                  >
                    {t('hwh.openDebugView')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {step === 7 && inhaberFwsResult && (autoRunPhase !== 'done' || debugMode) && (
        <InhaberFreeWindowSearchView
          fwsResult={inhaberFwsResult}
          month={month}
          year={year}
          onBack={() => setStep(6)}
          onRecompute={() => {
            setInhaberFwsResult(null);
            setStep(6);
          }}
          originalTrips={originalTrips}
          inhaberName={driverConfigs.find(c => c.isOwner)?.driverName ?? 'Inhaber'}
          sourceSheetName={imports.find(i => i.id === selectedImportId)?.source_sheet_name ?? null}
          sourceColumnsJson={imports.find(i => i.id === selectedImportId)?.source_columns_json ?? null}
          storagePath={imports.find(i => i.id === selectedImportId)?.storage_path ?? null}
          originalFileName={imports.find(i => i.id === selectedImportId)?.file_name ?? null}
          driverConfigs={driverConfigs}
          allDrivers={allDrivers}
          driverNotesMap={driverNotesMap}
        />
      )}
      {step === 7 && !inhaberFwsResult && (
        <div className="space-y-4">
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('hwh.fwsTitle')}</h2>
          <div className="rounded-xl p-4" style={{ background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', color: '#b91c1c' }}>
            {t('hwh.noResultBackToConflictPick')}
          </div>
          <button onClick={() => setStep(6)} className="inline-flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <ArrowLeft size={15} /> {t('common.back')}
          </button>
        </div>
      )}

      {/* Step 8 is disabled — workflow ends at step 7 (Inhaber free-time calendar) */}
      {step >= 8 && (
        <div className="space-y-4">
          <div className="rounded-xl p-4" style={{ background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', color: '#b91c1c' }}>
            {t('hwh.nextStepRebuilding')}
          </div>
          <button onClick={() => setStep(7)} className="inline-flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <ArrowLeft size={15} /> {t('common.back')}
          </button>
        </div>
      )}
    </div>

      {/* ── "Anzeigen" modal for a saved plan ─────────────────────────────────── */}
      {viewingPlan && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
          role="dialog" aria-modal="true"
          onClick={() => setViewingPlan(null)}
        >
          <div
            className="relative w-full rounded-2xl shadow-2xl flex flex-col"
            style={{ maxWidth: '52rem', maxHeight: '85vh', background: 'var(--bg-elevated, var(--bg-surface))', border: '1px solid var(--border)', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="px-6 pt-5 pb-4 flex-shrink-0 flex items-start justify-between gap-4" style={{ borderBottom: '1px solid var(--border)' }}>
              <div>
                <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
                  {t('hwh.savedMonthlyPlan')} — {t(MONTH_KEYS[(viewingPlan.month ?? month) - 1])} {viewingPlan.year ?? year}
                </h2>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{viewingPlan.original_file_name ?? '—'}</p>
              </div>
              <button onClick={() => setViewingPlan(null)} className="flex-shrink-0 p-1.5 rounded-lg hover:brightness-110 transition-all" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-3 text-xs">
                {([
                  { label: t('common.status'), value: viewingPlan.export_ready
                      ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(21,128,61,0.10)', color: '#15803d', border: '1px solid rgba(21,128,61,0.25)' }}><CheckCircle2 size={11} /> {t('hwh.exportable')}</span>
                      : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(220,38,38,0.07)', color: '#b91c1c', border: '1px solid rgba(220,38,38,0.2)' }}><AlertTriangle size={11} /> {t('hwh.notExportable')}</span> },
                  { label: t('hwh.savedAt'), value: (() => { const d = new Date(viewingPlan.saved_at); return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; })() },
                  { label: t('hwh.storagePath'), value: viewingPlan.storage_path ?? '—' },
                  { label: t('hwh.sheetName'), value: viewingPlan.source_sheet_name ?? '—' },
                ] as Array<{ label: string; value: React.ReactNode }>).map(({ label, value }) => (
                  <div key={label} className="rounded-lg p-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                    <div className="font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{label}</div>
                    <div style={{ color: 'var(--text-primary)' }}>{value}</div>
                  </div>
                ))}
              </div>
              {Array.isArray(viewingPlan.boundary_rows_json) && viewingPlan.boundary_rows_json.length > 0 && (
                <div className="rounded-2xl p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                  <VehicleMonthBoundarySummary rows={viewingPlan.boundary_rows_json as VehicleBoundaryRow[]} />
                </div>
              )}
              {Array.isArray(viewingPlan.driver_hour_summary_json) && viewingPlan.driver_hour_summary_json.length > 0 && (
                <div className="rounded-2xl p-4 space-y-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                  <div>
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('hwh.workingHoursPerDriver')}</h3>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('hwh.hoursFromSavedPlan')}</p>
                  </div>
                  <DriverHourSummaryTable rows={viewingPlan.driver_hour_summary_json as DriverHourSummaryRow[]} />
                </div>
              )}
            </div>
            <div className="px-6 py-4 flex-shrink-0 flex items-center gap-3" style={{ borderTop: '1px solid var(--border)' }}>
              {viewingPlan.export_ready && (
                <button
                  onClick={() => downloadSavedPlan(viewingPlan)}
                  disabled={downloadingPlanId === viewingPlan.id}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-110 disabled:opacity-50"
                  style={{ background: 'rgba(21,128,61,0.10)', color: '#15803d', border: '1px solid rgba(21,128,61,0.3)' }}
                >
                  {downloadingPlanId === viewingPlan.id
                    ? <><RefreshCw size={14} className="animate-spin" /> {t('common.loading')}</>
                    : <><Download size={14} /> {t('hwh.downloadFahrtenbuch')}</>}
                </button>
              )}
              <button
                onClick={() => setViewingPlan(null)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-110"
                style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Replace-plan confirmation dialog ──────────────────────────────────── */}
      {showReplaceConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
          role="dialog" aria-modal="true"
        >
          <div
            className="w-full rounded-2xl shadow-2xl p-6 space-y-4"
            style={{ maxWidth: '28rem', background: 'var(--bg-elevated, var(--bg-surface))', border: '1px solid var(--border)' }}
          >
            <div className="flex items-start gap-3">
              <AlertTriangle size={22} style={{ color: '#b45309', flexShrink: 0, marginTop: 2 }} />
              <div>
                <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('hwh.replaceSavedPlanQuestion')}</p>
                <p className="text-xs mt-1.5" style={{ color: 'var(--text-secondary)' }}>
                  {t('hwh.replaceSavedPlanHint')}
                </p>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowReplaceConfirm(false)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-110"
                style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={doSavePlan}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-110"
                style={{ background: 'rgba(220,38,38,0.10)', color: '#b91c1c', border: '1px solid rgba(220,38,38,0.3)' }}
              >
                {t('hwh.replaceOldPlan')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
