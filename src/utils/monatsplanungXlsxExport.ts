// Monatsplanung – Phase 6
// Read-only XLSX export of an applied planning run.
// Two modes:
//   • Originalformat (default): exact original headers/order/filename. Only the
//     Fahrername cell is replaced with the assigned driver for completed trips.
//     Canceled rows stay byte-identical.
//   • Auditformat: same original sheet + extra "Planung_Audit" sheet with the
//     planning metadata (Original Fahrer, Zugewiesener Fahrer, Assignment
//     Source, Planning Run ID, Block ID, Manual Exception, Dienstzeit/Tageslimit).
//
// No DB writes.

import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';

const BATCH = 1000;

export type ExportMode = 'original' | 'audit';

export interface AppliedRunSummary {
  id: string;
  company_id: string;
  month: number;
  year: number;
  import_id: string;
  status: string;
  applied_at: string | null;
  applied_by: string | null;
  apply_summary_json: Record<string, unknown> | null;
  settings_json: Record<string, unknown> | null;
  summary_json: Record<string, unknown> | null;
  file_name: string;
  source_columns_json: string[] | null;
  source_sheet_name: string | null;
  imported_at: string;
}

export interface ExportValidation {
  ok: boolean;
  total_rows: number;
  abgeschlossen_total: number;
  abgeschlossen_with_assignment: number;
  abgeschlossen_replaced: number;
  storniert_total: number;
  rows_linked_to_run: number;
  exceptions_in_run: number;
  expected_exceptions: number | null;
  expected_assigned: number | null;
  original_header_count: number;
  exported_header_count: number;
  headers_match: boolean;
  driver_column: string | null;
  original_sheet_name: string | null;
  mismatches: string[];
}

interface TripRow {
  id: string;
  trip_date: string;
  start_time: string | null;
  end_time: string | null;
  original_driver_id: string | null;
  original_driver_name: string;
  assigned_driver_id: string | null;
  assigned_driver_name: string;
  car_identifier: string | null;
  is_canceled: boolean;
  source_row_index: number | null;
  assignment_source: string | null;
  assignment_block_id: string | null;
  assignment_planning_run_id: string | null;
  raw_data_json: Record<string, unknown> | null;
}

interface ManualExceptionRow {
  block_id: string;
  dienstzeit_exception: boolean;
  tageslimit_exception: boolean;
  monatslimit_exception: boolean;
  reason: string | null;
}

async function fetchAllTrips(companyId: string, importId: string): Promise<TripRow[]> {
  const all: TripRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('fahrtenbuch_trips')
      .select(
        'id, trip_date, start_time, end_time, original_driver_id, original_driver_name, assigned_driver_id, assigned_driver_name, car_identifier, is_canceled, source_row_index, assignment_source, assignment_block_id, assignment_planning_run_id, raw_data_json',
      )
      .eq('company_id', companyId)
      .eq('import_id', importId)
      .order('source_row_index', { ascending: true, nullsFirst: false })
      .order('trip_date', { ascending: true })
      .order('start_time', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })
      .range(offset, offset + BATCH - 1);
    if (error) throw error;
    const rows = (data ?? []) as TripRow[];
    all.push(...rows);
    if (rows.length < BATCH) break;
    offset += BATCH;
  }
  return all;
}

async function fetchManualExceptions(planningRunId: string): Promise<ManualExceptionRow[]> {
  const { data, error } = await supabase
    .from('monthly_planning_manual_exceptions')
    .select('block_id, dienstzeit_exception, tageslimit_exception, monatslimit_exception, reason')
    .eq('planning_run_id', planningRunId);
  if (error) throw error;
  return (data ?? []) as ManualExceptionRow[];
}

export async function fetchAppliedRuns(companyId: string): Promise<AppliedRunSummary[]> {
  const { data: runs, error } = await supabase
    .from('company_planning_runs')
    .select('id, company_id, month, year, import_id, status, applied_at, applied_by, apply_summary_json, settings_json, summary_json')
    .eq('company_id', companyId)
    .not('applied_at', 'is', null)
    .order('applied_at', { ascending: false });
  if (error) throw error;
  const list = (runs ?? []) as Omit<AppliedRunSummary, 'file_name' | 'source_columns_json' | 'source_sheet_name' | 'imported_at'>[];
  if (list.length === 0) return [];

  const importIds = Array.from(new Set(list.map(r => r.import_id)));
  const { data: imports, error: impErr } = await supabase
    .from('fahrtenbuch_imports')
    .select('id, file_name, source_columns_json, source_sheet_name, imported_at')
    .in('id', importIds);
  if (impErr) throw impErr;
  const importsById = new Map<string, { file_name: string; source_columns_json: string[] | null; source_sheet_name: string | null; imported_at: string }>();
  for (const i of imports ?? []) {
    importsById.set(i.id as string, {
      file_name: (i.file_name as string) ?? '',
      source_columns_json: (i.source_columns_json as string[] | null) ?? null,
      source_sheet_name: (i.source_sheet_name as string | null) ?? null,
      imported_at: (i.imported_at as string) ?? '',
    });
  }
  return list.map(r => ({
    ...r,
    file_name: importsById.get(r.import_id)?.file_name ?? '',
    source_columns_json: importsById.get(r.import_id)?.source_columns_json ?? null,
    source_sheet_name: importsById.get(r.import_id)?.source_sheet_name ?? null,
    imported_at: importsById.get(r.import_id)?.imported_at ?? '',
  }));
}

function readNumber(obj: Record<string, unknown> | null, key: string): number | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === 'number' ? v : null;
}

// Identify the original header that holds the driver name. Strategy:
// 1) Look for an exact "Fahrername" header.
// 2) Otherwise, find the header whose value in the first non-canceled trip
//    equals that trip's original_driver_name.
// 3) Otherwise, try common synonyms (case-insensitive).
function detectDriverColumn(headers: string[], trips: TripRow[]): string | null {
  if (headers.includes('Fahrername')) return 'Fahrername';

  const sample = trips.find(t => !t.is_canceled && t.original_driver_name && t.raw_data_json);
  if (sample) {
    const raw = sample.raw_data_json as Record<string, unknown>;
    const target = sample.original_driver_name.trim();
    for (const h of headers) {
      const v = raw[h];
      if (typeof v === 'string' && v.trim() === target) return h;
    }
  }

  const lc = new Map(headers.map(h => [h.toLowerCase().trim(), h]));
  for (const cand of ['fahrername', 'fahrer', 'fahrer name', 'driver name', 'driver']) {
    const hit = lc.get(cand);
    if (hit) return hit;
  }
  return null;
}

function cellValue(v: unknown): string | number | boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  return String(v);
}

export interface PreparedExport {
  run: AppliedRunSummary;
  trips: TripRow[];
  exceptions: ManualExceptionRow[];
  headers: string[];
  driverColumn: string | null;
  validation: ExportValidation;
}

export async function prepareExport(run: AppliedRunSummary): Promise<PreparedExport> {
  const [trips, exceptions] = await Promise.all([
    fetchAllTrips(run.company_id, run.import_id),
    fetchManualExceptions(run.id),
  ]);

  // Original headers come from the import metadata. If absent, fall back to the
  // union of all raw_data_json keys (preserves order via insertion-order set).
  const headersFromImport = (run.source_columns_json ?? []).filter(h => typeof h === 'string' && h.length > 0);
  let headers = headersFromImport;
  if (headers.length === 0) {
    const collected = new Set<string>();
    for (const t of trips) {
      const raw = t.raw_data_json ?? {};
      for (const k of Object.keys(raw)) collected.add(k);
    }
    headers = Array.from(collected);
  }

  const driverColumn = detectDriverColumn(headers, trips);

  const abgeschlossen = trips.filter(t => !t.is_canceled);
  const storniert = trips.filter(t => t.is_canceled);
  const abgeschlossen_with_assignment = abgeschlossen.filter(t => !!t.assigned_driver_id).length;
  const rows_linked_to_run = trips.filter(t => t.assignment_planning_run_id === run.id).length;
  const exceptions_in_run = exceptions.length;

  const apply = run.apply_summary_json;
  const expectedAssigned = readNumber(apply, 'updated_trips');
  const expectedExceptions = readNumber(apply, 'manual_exceptions_saved');

  const replaceableCount = trips.filter(
    t => !t.is_canceled && t.assignment_planning_run_id === run.id && !!t.assigned_driver_name,
  ).length;

  const mismatches: string[] = [];
  if (expectedAssigned != null && rows_linked_to_run !== expectedAssigned) {
    mismatches.push(`Zugewiesene Fahrten verknüpft: ${rows_linked_to_run} ≠ erwartet ${expectedAssigned}`);
  }
  if (expectedExceptions != null && exceptions_in_run !== expectedExceptions) {
    mismatches.push(`Manuelle Ausnahmen: ${exceptions_in_run} ≠ erwartet ${expectedExceptions}`);
  }
  const canceledWithRun = storniert.filter(t => t.assignment_planning_run_id === run.id).length;
  if (canceledWithRun > 0) {
    mismatches.push(`${canceledWithRun} stornierte Fahrt(en) sind fälschlich mit Planning Run verknüpft`);
  }
  if (!driverColumn) {
    mismatches.push('Fahrername-Spalte in den Original-Headern nicht gefunden');
  }

  // Row-level: every completed trip linked to the run must produce a non-empty
  // Fahrername in the export (assigned_driver_name).
  if (driverColumn) {
    const missing = trips.filter(
      t => !t.is_canceled
        && t.assignment_planning_run_id === run.id
        && (!t.assigned_driver_name || t.assigned_driver_name.trim() === ''),
    ).length;
    if (missing > 0) {
      mismatches.push(`${missing} abgeschlossene Fahrt(en) ohne Fahrername`);
    }
  }

  const validation: ExportValidation = {
    ok: false,
    total_rows: trips.length,
    abgeschlossen_total: abgeschlossen.length,
    abgeschlossen_with_assignment,
    abgeschlossen_replaced: replaceableCount,
    storniert_total: storniert.length,
    rows_linked_to_run,
    exceptions_in_run,
    expected_exceptions: expectedExceptions,
    expected_assigned: expectedAssigned,
    original_header_count: headers.length,
    exported_header_count: headers.length,
    headers_match: true, // we are emitting exactly the input headers
    driver_column: driverColumn,
    original_sheet_name: run.source_sheet_name,
    mismatches,
  };
  validation.ok = mismatches.length === 0;

  return { run, trips, exceptions, headers, driverColumn, validation };
}

function buildOriginalSheet(prep: PreparedExport): (string | number | boolean | null)[][] {
  const { headers, trips, driverColumn, run } = prep;
  const out: (string | number | boolean | null)[][] = [headers];

  for (const t of trips) {
    const raw = (t.raw_data_json ?? {}) as Record<string, unknown>;
    const row: (string | number | boolean | null)[] = headers.map(h => cellValue(raw[h]));

    if (!t.is_canceled && driverColumn && t.assignment_planning_run_id === run.id && t.assigned_driver_name) {
      const colIndex = headers.indexOf(driverColumn);
      if (colIndex >= 0) row[colIndex] = t.assigned_driver_name;
    }
    out.push(row);
  }
  return out;
}

const AUDIT_HEADERS = [
  'Source Row',
  'Datum',
  'Start',
  'Ende',
  'Kennzeichen',
  'Original Fahrer',
  'Zugewiesener Fahrer',
  'Assignment Source',
  'Planning Run ID',
  'Block ID',
  'Manual Exception',
  'Dienstzeit Exception',
  'Tageslimit Exception',
  'Monatslimit Exception',
  'Begründung',
  'Monatswechsel',
  'Monatszuordnung',
];

function buildAuditSheet(prep: PreparedExport): (string | number | null)[][] {
  const { trips, exceptions, run } = prep;
  const excByBlock = new Map<string, ManualExceptionRow>();
  for (const e of exceptions) excByBlock.set(e.block_id, e);

  const out: (string | number | null)[][] = [AUDIT_HEADERS];
  for (const t of trips) {
    if (t.is_canceled) continue;
    const linked = t.assignment_planning_run_id === run.id;
    const blockId = t.assignment_block_id ?? '';
    const exc = blockId ? excByBlock.get(blockId) : undefined;

    // Detect cross-month: trip_date is last day of its month AND end_time < start_time (crosses midnight)
    const startMins = t.start_time ? timeStrToMins(t.start_time) : null;
    const endMins = t.end_time ? timeStrToMins(t.end_time) : null;
    const crossesMidnight = startMins !== null && endMins !== null && endMins > 0 && endMins <= startMins;
    let monatswechsel: 'JA' | null = null;
    let monatszuordnung: string | null = null;
    if (crossesMidnight && t.trip_date) {
      const d = new Date(t.trip_date + 'T12:00:00');
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      if (d.getDate() === lastDay) {
        monatswechsel = 'JA';
        monatszuordnung = t.trip_date.slice(0, 7); // YYYY-MM of start month
      }
    }

    out.push([
      t.source_row_index ?? null,
      t.trip_date,
      t.start_time,
      t.end_time,
      t.car_identifier,
      t.original_driver_name || null,
      linked ? (t.assigned_driver_name || null) : null,
      linked ? (t.assignment_source || null) : null,
      linked ? run.id : null,
      linked ? (t.assignment_block_id || null) : null,
      exc ? 'JA' : null,
      exc?.dienstzeit_exception ? 'JA' : null,
      exc?.tageslimit_exception ? 'JA' : null,
      exc?.monatslimit_exception ? 'JA' : null,
      exc?.reason ?? null,
      monatswechsel,
      monatszuordnung,
    ]);
  }
  return out;
}

function timeStrToMins(t: string): number {
  const parts = t.split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

export interface ExportResult {
  validation: ExportValidation;
  fileName: string;
  mode: ExportMode;
  blocked?: { reason: string };
}

export async function exportAppliedRunXlsx(
  run: AppliedRunSummary,
  mode: ExportMode = 'original',
): Promise<ExportResult> {
  const prep = await prepareExport(run);

  const fileName = run.file_name && run.file_name.trim().length > 0
    ? run.file_name
    : `fahrtenbuch_${run.year}_${String(run.month).padStart(2, '0')}.xlsx`;

  // Hard guard: Originalformat must not deviate in headers.
  const originalRows = buildOriginalSheet(prep);
  const emittedHeaders = originalRows[0] as string[];
  const headersStrictlyEqual =
    emittedHeaders.length === prep.headers.length &&
    emittedHeaders.every((h, i) => h === prep.headers[i]);
  if (!headersStrictlyEqual) {
    return {
      validation: { ...prep.validation, headers_match: false, ok: false },
      fileName,
      mode,
      blocked: { reason: 'Exportfehler: Originalformat darf keine zusätzlichen Spalten enthalten.' },
    };
  }

  const wb = XLSX.utils.book_new();
  const rawSheetName = (run.source_sheet_name && run.source_sheet_name.trim().length > 0)
    ? run.source_sheet_name
    : 'Sheet1';
  // XLSX sheet names are capped at 31 chars and forbid : \ / ? * [ ]
  const originalSheetName = rawSheetName.replace(/[:\\/?*[\]]/g, '_').slice(0, 31);
  const ws = XLSX.utils.aoa_to_sheet(originalRows);
  XLSX.utils.book_append_sheet(wb, ws, originalSheetName);

  if (mode === 'audit') {
    const auditRows = buildAuditSheet(prep);
    const ws2 = XLSX.utils.aoa_to_sheet(auditRows);
    XLSX.utils.book_append_sheet(wb, ws2, 'Planung_Audit');
  }

  XLSX.writeFile(wb, fileName);

  return { validation: prep.validation, fileName, mode };
}

// Backwards-compat alias used by detail-modal pre-export validation.
export async function validateAppliedRun(run: AppliedRunSummary): Promise<{ validation: ExportValidation }> {
  const prep = await prepareExport(run);
  return { validation: prep.validation };
}
