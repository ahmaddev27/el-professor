// Monatsplanung – Phase 4
// Build a Change Set / Apply Preview from the finalized Phase 3 result.
// In-memory only — no DB writes, no RPC, no exports.

import type { FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
import type { PlanningDriver } from '../components/MonatsplanungDriverPool';
import type { AssignedBlock, Phase3Result } from './monatsplanungPhase3';
// Type-only: the engine names a dictionary key beside its German text.
import type { EngineMessageKey, EngineMessageVars } from '../i18n/engineMessageTypes';

export type AssignmentSource = 'auto' | 'repair' | 'manual_exception';

export interface ChangeRow {
  trip_id: string;
  excel_row: number | null;
  service_date: string;
  start_datetime: string;
  end_datetime: string;
  vehicle_identifier: string;
  original_driver_id: string | null;
  original_driver_name: string;
  new_driver_id: string;
  new_driver_name: string;
  block_id: string;
  block_start_datetime: string;
  block_end_datetime: string;
  assignment_source: AssignmentSource;
  dienstzeit_exception: boolean;
  tageslimit_exception: boolean;
  monatslimit_exception: boolean;
  exception_reason: string;
  changed: boolean;
  is_canceled: boolean;
}

export interface ChangeSetPerDriver {
  driver_id: string;
  driver_name: string;
  trips: number;
  blocks: number;
  minutes: number;
  dienstzeit_exceptions: number;
  tageslimit_exceptions: number;
  monatslimit_exceptions: number;
}

export interface ChangeSetManualException {
  block_id: string;
  service_date: string;
  vehicle_identifier: string;
  block_start_datetime: string;
  block_end_datetime: string;
  driver_id: string;
  driver_name: string;
  dienstzeit: boolean;
  tageslimit: boolean;
  monatslimit: boolean;
  reason: string;
}

export interface Phase4Summary {
  total_trips: number;
  abgeschlossen: number;
  zu_aendern: number;
  unveraendert: number;
  zugewiesene_bloecke: number;
  manuelle_ausnahmen: number;
  dienstzeit_ausnahmen: number;
  tageslimit_ausnahmen: number;
  monatslimit_ausnahmen: number;
  offene_fahrten: number;
}

export interface Phase4ConsistencyIssue {
  type:
    | 'change_count_mismatch'
    | 'duplicate_trip_in_changeset'
    | 'canceled_trip_in_changeset'
    | 'missing_driver_on_change_row'
    | 'non_selected_driver_on_change_row'
    | 'manual_exception_missing_flag'
    | 'abgeschlossen_not_in_changeset';
  /** German, as the engine has always written it. The screen's fallback. */
  detail: string;
  messageKey?: EngineMessageKey;
  messageVars?: EngineMessageVars;
}

export interface Phase4Result {
  valid: boolean;
  change_rows: ChangeRow[];
  per_driver: ChangeSetPerDriver[];
  manual_exceptions: ChangeSetManualException[];
  summary: Phase4Summary;
  consistencyIssues: Phase4ConsistencyIssue[];
}

function classifySource(ab: AssignedBlock): AssignmentSource {
  if (ab.manual_exception?.confirmed_by_user) return 'manual_exception';
  if (ab.repair_applied || ab.repair_moved) return 'repair';
  return 'auto';
}

export function buildChangeSet(
  phase3: Phase3Result,
  trips: FahrtenbuchTrip[],
  selectedDrivers: PlanningDriver[],
): Phase4Result {
  const tripById = new Map<string, FahrtenbuchTrip>();
  for (const t of trips) tripById.set(t.id, t);
  const selectedSet = new Set(selectedDrivers.map(d => d.id));

  const change_rows: ChangeRow[] = [];
  const seenTripIds = new Set<string>();
  const issues: Phase4ConsistencyIssue[] = [];

  for (const ab of phase3.assigned) {
    const source = classifySource(ab);
    const dienstzeit = !!ab.manual_exception?.dienstzeit;
    const tageslimit = !!ab.manual_exception?.daily;
    const monatslimit = !!ab.manual_exception?.monthly;
    const exceptionReason = ab.manual_exception?.reason ?? '';

    for (const row of ab.trip_rows) {
      const trip = tripById.get(row.trip_id);
      if (seenTripIds.has(row.trip_id)) {
        issues.push({
          type: 'duplicate_trip_in_changeset',
          detail: `Trip ${row.trip_id} bereits einem anderen Block zugewiesen`,
          messageKey: 'engine.phase4.issue.duplicateTrip',
          messageVars: { tripId: row.trip_id },
        });
      }
      seenTripIds.add(row.trip_id);

      const isCanceled = trip?.is_canceled ?? false;
      if (isCanceled) {
        issues.push({
          type: 'canceled_trip_in_changeset',
          detail: `Stornierte Fahrt ${row.trip_id} in Change Set`,
          messageKey: 'engine.phase4.issue.canceledTrip',
          messageVars: { tripId: row.trip_id },
        });
      }
      if (!ab.driver_id) {
        issues.push({
          type: 'missing_driver_on_change_row',
          detail: `Block ${ab.block_id} ohne Fahrer`,
          messageKey: 'engine.phase4.issue.missingDriver',
          messageVars: { blockId: ab.block_id },
        });
      }
      if (ab.driver_id && !selectedSet.has(ab.driver_id)) {
        issues.push({
          type: 'non_selected_driver_on_change_row',
          detail: `Fahrer ${ab.driver_name} nicht in Auswahl`,
          messageKey: 'engine.phase4.issue.driverNotInPool',
          messageVars: { driver: ab.driver_name },
        });
      }
      if (source === 'manual_exception' && !dienstzeit && !tageslimit && !monatslimit) {
        issues.push({
          type: 'manual_exception_missing_flag',
          detail: `Manuelle Ausnahme bei Block ${ab.block_id} ohne Ausnahme-Flag`,
          messageKey: 'engine.phase4.issue.manualExceptionMissingFlag',
          messageVars: { blockId: ab.block_id },
        });
      }

      const originalId = trip?.original_driver_id ?? null;
      const originalName = trip?.original_driver_name ?? '';
      change_rows.push({
        trip_id: row.trip_id,
        excel_row: row.excel_row,
        service_date: ab.service_date,
        start_datetime: row.start_datetime,
        end_datetime: row.end_datetime,
        vehicle_identifier: ab.vehicle_identifier,
        original_driver_id: originalId,
        original_driver_name: originalName,
        new_driver_id: ab.driver_id,
        new_driver_name: ab.driver_name,
        block_id: ab.block_id,
        block_start_datetime: ab.block_start_datetime,
        block_end_datetime: ab.block_end_datetime,
        assignment_source: source,
        dienstzeit_exception: dienstzeit,
        tageslimit_exception: tageslimit,
        monatslimit_exception: monatslimit,
        exception_reason: exceptionReason,
        changed: originalId !== ab.driver_id || originalName !== ab.driver_name,
        is_canceled: isCanceled,
      });
    }
  }

  // Per-driver aggregation
  const perDriverMap = new Map<string, ChangeSetPerDriver>();
  const blocksPerDriver = new Map<string, Set<string>>();
  for (const ab of phase3.assigned) {
    const agg = perDriverMap.get(ab.driver_id) ?? {
      driver_id: ab.driver_id,
      driver_name: ab.driver_name,
      trips: 0,
      blocks: 0,
      minutes: 0,
      dienstzeit_exceptions: 0,
      tageslimit_exceptions: 0,
      monatslimit_exceptions: 0,
    };
    agg.trips += ab.trip_count;
    agg.minutes += ab.duration_minutes;
    if (ab.manual_exception?.dienstzeit) agg.dienstzeit_exceptions++;
    if (ab.manual_exception?.daily) agg.tageslimit_exceptions++;
    if (ab.manual_exception?.monthly) agg.monatslimit_exceptions++;
    perDriverMap.set(ab.driver_id, agg);

    const set = blocksPerDriver.get(ab.driver_id) ?? new Set<string>();
    set.add(ab.block_id);
    blocksPerDriver.set(ab.driver_id, set);
  }
  for (const [id, set] of blocksPerDriver) {
    const agg = perDriverMap.get(id);
    if (agg) agg.blocks = set.size;
  }
  const per_driver = [...perDriverMap.values()].sort((a, b) => a.driver_name.localeCompare(b.driver_name));

  // Manual exception list
  const manual_exceptions: ChangeSetManualException[] = phase3.assigned
    .filter(ab => ab.manual_exception?.confirmed_by_user)
    .map(ab => ({
      block_id: ab.block_id,
      service_date: ab.service_date,
      vehicle_identifier: ab.vehicle_identifier,
      block_start_datetime: ab.block_start_datetime,
      block_end_datetime: ab.block_end_datetime,
      driver_id: ab.driver_id,
      driver_name: ab.driver_name,
      dienstzeit: !!ab.manual_exception?.dienstzeit,
      tageslimit: !!ab.manual_exception?.daily,
      monatslimit: !!ab.manual_exception?.monthly,
      reason: ab.manual_exception?.reason ?? '',
    }));

  // Summary
  const abgeschlossen = trips.filter(t => !t.is_canceled).length;
  const zuAendern = change_rows.filter(r => r.changed && !r.is_canceled).length;
  const unveraendert = change_rows.filter(r => !r.changed && !r.is_canceled).length;
  const openTripsFromOpenBlocks = phase3.unassigned.reduce((s, b) => s + b.trip_count, 0);

  const summary: Phase4Summary = {
    total_trips: trips.length,
    abgeschlossen,
    zu_aendern: change_rows.filter(r => !r.is_canceled).length,
    unveraendert,
    zugewiesene_bloecke: phase3.assigned.length,
    manuelle_ausnahmen: manual_exceptions.length,
    dienstzeit_ausnahmen: manual_exceptions.filter(m => m.dienstzeit).length,
    tageslimit_ausnahmen: manual_exceptions.filter(m => m.tageslimit).length,
    monatslimit_ausnahmen: manual_exceptions.filter(m => m.monatslimit).length,
    offene_fahrten: openTripsFromOpenBlocks,
  };

  // Cross-check: every abgeschlossen Fahrt must appear in change set or in intentionally_open block
  const openBlockTripIds = new Set<string>();
  for (const u of phase3.unassigned) for (const id of u.trip_ids) openBlockTripIds.add(id);
  for (const t of trips) {
    if (t.is_canceled) continue;
    if (!seenTripIds.has(t.id) && !openBlockTripIds.has(t.id)) {
      issues.push({
        type: 'abgeschlossen_not_in_changeset',
        detail: `Abgeschlossene Fahrt ${t.id} fehlt im Change Set`,
        messageKey: 'engine.phase4.issue.completedTripMissing',
        messageVars: { tripId: t.id },
      });
    }
  }

  // change rows count vs resolved trips
  const resolvedTripsFromBlocks = phase3.assigned.reduce((s, b) => s + b.trip_count, 0);
  if (change_rows.length !== resolvedTripsFromBlocks) {
    issues.push({
      type: 'change_count_mismatch',
      detail: `Change Rows ${change_rows.length} ≠ resolved Trips ${resolvedTripsFromBlocks}`,
      messageKey: 'engine.phase4.issue.changeCountMismatch',
      messageVars: { changeRows: change_rows.length, resolvedTrips: resolvedTripsFromBlocks },
    });
  }

  // intentionally suppress noise: keep first 200 issues
  const consistencyIssues = issues.slice(0, 200);

  // Also fold zu_aendern (unchanged variant) — task says "Zu ändernde/zugewiesene Fahrten" includes all change rows
  // We keep both numbers above.
  void zuAendern;

  const valid = consistencyIssues.length === 0;

  return {
    valid,
    change_rows,
    per_driver,
    manual_exceptions,
    summary,
    consistencyIssues,
  };
}
