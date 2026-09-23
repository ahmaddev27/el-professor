import { useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import type {
  ReviewReason, SourceRowKeyBasis, TimeSource, TripStatus,
} from '../utils/fahrtenbuchImportParser';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FahrtenbuchImport {
  id: string;
  company_id: string;
  month: number;
  year: number;
  file_name: string;
  imported_by: string;
  imported_at: string;
  status: 'pending' | 'confirmed' | 'archived';
  row_count: number;
  notes: string | null;
  source_columns_json: string[] | null;
  source_sheet_name: string | null;
  storage_path: string | null;
  /** SHA-256 of the uploaded file; NULL for imports older than 20260922100000. */
  file_sha256: string | null;
}

/**
 * The columns 20260922100000 adds to a trip, all written once at import and
 * refused by protect_fahrtenbuch_immutable_fields afterwards. Rows older than
 * that migration carry the backfilled values, and a NULL source_row_key.
 * utils/fahrtenbuchImportParser.ts says what each one means.
 */
export interface TripImportFacts {
  start_at: string | null;
  end_at: string | null;
  time_zone: string | null;
  time_source: TimeSource;
  trip_status: TripStatus;
  needs_review: boolean;
  review_reasons: ReviewReason[];
  currency: string;
  currency_source: 'assumed' | 'source';
  source_row_key: string | null;
  source_row_key_basis: SourceRowKeyBasis | null;
}

// The database allows NULL in these two for a row written without them (a
// release rolled back past this one inserts no trip_status); every import of
// this release and the backfill set both.
export interface FahrtenbuchTrip extends Omit<TripImportFacts, 'time_source' | 'trip_status'> {
  time_source: TimeSource | null;
  trip_status: TripStatus | null;
  id: string;
  company_id: string;
  import_id: string;
  trip_date: string;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  original_driver_id: string | null;
  original_driver_name: string;
  assigned_driver_id: string | null;
  assigned_driver_name: string;
  car_id: string | null;
  car_identifier: string | null;
  route_start: string | null;
  route_end: string | null;
  description: string | null;
  price_amount: number;
  cash_amount: number;
  online_amount: number;
  tip_amount: number;
  action_amount: number;
  raw_data_json: Record<string, unknown>;
  plausibility_status: 'pending' | 'ok' | 'uncovered' | 'overlap' | 'canceled';
  is_canceled: boolean;
  source_status: string | null;
  assignment_reason: string | null;
  assignment_note: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  source_row_index: number | null;
  created_at: string;
  updated_at: string;
}

export interface TripInsertRow extends TripImportFacts {
  company_id: string;
  import_id: string;
  trip_date: string;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  original_driver_id: string | null;
  original_driver_name: string;
  assigned_driver_id: string | null;
  assigned_driver_name: string;
  car_id: string | null;
  car_identifier: string | null;
  route_start: string | null;
  route_end: string | null;
  description: string | null;
  price_amount: number;
  cash_amount: number;
  online_amount: number;
  tip_amount: number;
  action_amount: number;
  raw_data_json: Record<string, unknown>;
  plausibility_status: 'pending' | 'canceled';
  is_canceled: boolean;
  source_status: string | null;
  source_row_index: number;
}

// ── Batched fetch helper ─────────────────────────────────────────────────────
// Supabase returns max 1000 rows by default. This fetches all rows in batches.

const BATCH_SIZE = 1000;

async function fetchAllRows<T>(
  buildQuery: (from: number, to: number) => ReturnType<ReturnType<typeof supabase.from>['select']>,
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await buildQuery(offset, offset + BATCH_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }
  return all;
}

// ── Duplicate refusal (20260922100000) ───────────────────────────────────────

/** The unique constraint that refuses the same file twice in one company. */
const FILE_HASH_CONSTRAINT = 'fahrtenbuch_imports_company_file_sha256_key';
/** The unique index that refuses the same ride twice in one company. */
const ROW_KEY_INDEX = 'fahrtenbuch_trips_company_source_row_key';
/**
 * Keys per lookup. A key is 64 characters, so 100 keep the request line near
 * 7 KB, well inside what Kong and PostgREST accept; each key names at most one
 * stored row, so an answer stays far below the 1000-row cap.
 */
const KEY_LOOKUP_CHUNK = 100;

/** The company already imported this exact file. `existing` is that import. */
export class DuplicateImportFileError extends Error {
  constructor(message: string, readonly existing: FahrtenbuchImport | null) {
    super(message);
    this.name = 'DuplicateImportFileError';
  }
}

function isUniqueViolation(err: unknown, name: string): boolean {
  const e = err as { code?: string; message?: string; details?: string } | null;
  return e?.code === '23505' && `${e.message ?? ''} ${e.details ?? ''}`.includes(name);
}

export interface CreateImportResult {
  importId: string;
  /** Trips written. */
  inserted: number;
  /** Trips left out because the company already stores them. */
  duplicatesRefused: number;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useFahrtenbuch() {
  const { user } = useAuth();
  /*
    The company the session is in (plan 3.4b), not the account's membership.
    The Fahrtenbuch screens showed nothing inside a support session for the
    same reason useDatabase's did: `AuthContext.companyId` is null for a
    platform account, so every filter and every storage path named "null".
  */
  const { effectiveCompanyId: companyId, companyScope } = useSuperAdmin();
  const { t } = useTranslation();
  // A dependency of createImport: the mode can change under the same company
  // (view → support), which does not remount the tenant shell.
  const isReadOnlyPlatformSession = companyScope.isPlatformSession && companyScope.readOnly;
  const [imports, setImports] = useState<FahrtenbuchImport[]>([]);
  const [trips, setTrips] = useState<FahrtenbuchTrip[]>([]);
  const [loadingImports, setLoadingImports] = useState(false);
  const [loadingTrips, setLoadingTrips] = useState(false);

  const fetchImports = useCallback(async () => {
    if (!companyId) return;
    setLoadingImports(true);
    try {
      const { data, error } = await supabase
        .from('fahrtenbuch_imports')
        .select('*')
        .eq('company_id', companyId)
        .order('imported_at', { ascending: false });
      if (error) throw error;
      const rows = (data as FahrtenbuchImport[]) || [];
      if (import.meta.env.DEV) {
        console.log(`[FahrtenbuchImportList] fetchImports — ${rows.length} total imports:`);
        rows.forEach((r, i) => console.log(`  [${i}]`, {
          id: r.id, month: r.month, year: r.year, file_name: r.file_name,
          row_count: r.row_count, storage_path: r.storage_path, imported_at: r.imported_at,
        }));
      }
      setImports(rows);
    } finally {
      setLoadingImports(false);
    }
  }, [companyId]);

  const fetchTrips = useCallback(async (importId?: string, month?: number, year?: number) => {
    if (!companyId) return;
    setLoadingTrips(true);
    try {
      const result = await fetchAllRows<FahrtenbuchTrip>((from, to) => {
        let q = supabase
          .from('fahrtenbuch_trips')
          .select('*')
          .eq('company_id', companyId)
          .order('trip_date', { ascending: true })
          .order('start_time', { ascending: true, nullsFirst: false })
          .order('id', { ascending: true })
          .range(from, to);
        if (importId) q = q.eq('import_id', importId);
        return q;
      });

      let filtered = result;
      if (!importId && month !== undefined && year !== undefined) {
        filtered = result.filter(t => {
          const d = new Date(t.trip_date);
          return d.getFullYear() === year && d.getMonth() + 1 === month;
        });
      }

      setTrips(filtered);
    } finally {
      setLoadingTrips(false);
    }
  }, [companyId]);

  /** The company's import of exactly this file, if it has one. */
  const findImportByFileHash = useCallback(async (fileSha256: string): Promise<FahrtenbuchImport | null> => {
    if (!companyId) return null;
    const { data, error } = await supabase
      .from('fahrtenbuch_imports')
      .select('*')
      .eq('company_id', companyId)
      .eq('file_sha256', fileSha256)
      .maybeSingle();
    if (error) throw error;
    return (data as FahrtenbuchImport | null) ?? null;
  }, [companyId]);

  /**
   * Which of these ride keys the company already stores — optionally leaving
   * out one import's rides, for the preview of an import that will replace it.
   */
  const findStoredSourceRowKeys = useCallback(async (
    keys: readonly string[],
    excludeImportId: string | null = null,
  ): Promise<Set<string>> => {
    const stored = new Set<string>();
    if (!companyId) return stored;
    const unique = [...new Set(keys)];
    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += KEY_LOOKUP_CHUNK) {
      chunks.push(unique.slice(i, i + KEY_LOOKUP_CHUNK));
    }
    const answers = await Promise.all(chunks.map(chunk => {
      let q = supabase
        .from('fahrtenbuch_trips')
        .select('source_row_key')
        .eq('company_id', companyId)
        .in('source_row_key', chunk);
      if (excludeImportId) q = q.neq('import_id', excludeImportId);
      return q;
    }));
    for (const { data, error } of answers) {
      if (error) throw error;
      for (const row of (data ?? []) as { source_row_key: string | null }[]) {
        if (row.source_row_key) stored.add(row.source_row_key);
      }
    }
    return stored;
  }, [companyId]);

  const createImport = useCallback(async (params: {
    month: number;
    year: number;
    fileName: string;
    trips: TripInsertRow[];
    /** SHA-256 of the uploaded bytes (sha256HexOfBytes). */
    fileSha256: string;
    notes?: string;
    sourceSheetName?: string;
    sourceColumns?: string[];
    xlsxBytes?: Uint8Array | null;
  }): Promise<CreateImportResult> => {
    if (!companyId || !user) throw new Error('Not authenticated');

    // XLSX bytes are mandatory — no import without the original file in storage
    if (!params.xlsxBytes || params.xlsxBytes.length === 0) {
      throw new Error('Import blockiert: Original-XLSX-Datei konnte nicht gelesen werden.');
    }

    // The same file once per company. Asked before the upload so a refused file
    // leaves nothing behind; the unique constraint is the wall for a race.
    const existing = await findImportByFileHash(params.fileSha256);
    if (existing) {
      throw new DuplicateImportFileError(t('imp.duplicateFile.title'), existing);
    }

    // The same ride once per company: drop the rows another import already
    // holds. Asked again here, after a replaced import was deleted, so the
    // preview's count is not trusted blindly; the unique index is the wall.
    const storedKeys = await findStoredSourceRowKeys(
      params.trips.flatMap(r => (r.source_row_key ? [r.source_row_key] : [])),
    );
    const trips = params.trips.filter(r => !r.source_row_key || !storedKeys.has(r.source_row_key));
    const duplicatesRefused = params.trips.length - trips.length;
    if (trips.length === 0) {
      throw new Error(t('imp.error.allDuplicates'));
    }

    const ext = params.fileName.toLowerCase().endsWith('.xlsx') ? '' : '.xlsx';
    const safeName = params.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${companyId}/${Date.now()}_${safeName}${ext}`;

    if (import.meta.env.DEV) {
      console.log('[FahrtenbuchImportStorage] Starting import:', {
        fileName: params.fileName, month: params.month, year: params.year,
        companyId, xlsxBytesLength: params.xlsxBytes.length,
        bucket: 'fahrtenbuch-files', targetStoragePath: storagePath,
      });
    }

    const { error: uploadErr } = await supabase.storage
      .from('fahrtenbuch-files')
      .upload(storagePath, params.xlsxBytes, {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        upsert: false,
      });

    if (uploadErr) {
      if (import.meta.env.DEV) {
        console.error('[FahrtenbuchImportStorage] Storage upload FAILED:', uploadErr.message);
      }
      /*
        Since 20260920100000 a support session uploads into the opened
        company's folder like a member does, and a read-only (`view`) context
        is refused — by the bucket policy, before the import row below is ever
        attempted. That refusal is a rule, not a storage fault, so it gets the
        sentence that names it instead of the configuration hint below.
      */
      if (isReadOnlyPlatformSession) {
        throw new Error(t('support.storage.readOnly'));
      }
      throw new Error(`Import blockiert: Original-XLSX-Datei konnte nicht gespeichert werden. Bitte Storage-Konfiguration prüfen. (${uploadErr.message})`);
    }

    if (import.meta.env.DEV) {
      console.log('[FahrtenbuchImportStorage] Storage upload SUCCESS, path:', storagePath);
    }

    const { data: importRow, error: importErr } = await supabase
      .from('fahrtenbuch_imports')
      .insert({
        company_id: companyId,
        month: params.month,
        year: params.year,
        file_name: params.fileName,
        imported_by: user.id,
        status: 'confirmed',
        row_count: trips.length,
        notes: params.notes || null,
        source_sheet_name: params.sourceSheetName || null,
        source_columns_json: params.sourceColumns || null,
        storage_path: storagePath,
        file_sha256: params.fileSha256,
      })
      .select('id, storage_path, imported_at')
      .single();

    if (importErr) {
      // Best-effort cleanup of uploaded file
      await supabase.storage.from('fahrtenbuch-files').remove([storagePath]);
      if (isUniqueViolation(importErr, FILE_HASH_CONSTRAINT)) {
        // Another tab or colleague imported the same file since the check above.
        throw new DuplicateImportFileError(
          t('imp.duplicateFile.title'),
          await findImportByFileHash(params.fileSha256).catch(() => null),
        );
      }
      throw importErr;
    }

    const importId = importRow.id as string;

    // Verify storage_path was persisted
    if (!importRow.storage_path) {
      await supabase.storage.from('fahrtenbuch-files').remove([storagePath]);
      await supabase.from('fahrtenbuch_imports').delete().eq('id', importId);
      throw new Error('Import blockiert: Originaldatei wurde nicht mit dem Import gespeichert.');
    }

    if (import.meta.env.DEV) {
      console.log('[FahrtenbuchImportStorage] Import row created:', {
        id: importId, storage_path: importRow.storage_path, imported_at: importRow.imported_at,
      });
    }

    // Trips go in batches because PostgREST caps a request, but the import row
    // already claims row_count = trips.length. A batch failing partway
    // therefore used to leave a 'confirmed' import whose row_count lied about
    // how many trips exist — and planning would then run against a silently
    // truncated month.
    //
    // There is no client-side transaction across requests, so on failure we
    // unwind: delete the trips written so far, the import row, and the uploaded
    // file, restoring the state from before the import was attempted.
    const batchSize = 200;
    let insertedBatches = 0;
    try {
      for (let i = 0; i < trips.length; i += batchSize) {
        const batch = trips.slice(i, i + batchSize).map(t => ({
          ...t,
          import_id: importId,
          company_id: companyId,
        }));
        const { error: tripErr } = await supabase
          .from('fahrtenbuch_trips')
          .insert(batch);
        if (tripErr) throw tripErr;
        insertedBatches++;
      }
    } catch (tripErr) {
      const written = insertedBatches * batchSize;
      // Best effort — if any of this also fails, the throw below still tells the
      // user the import did not succeed.
      await supabase.from('fahrtenbuch_trips').delete().eq('import_id', importId);
      await supabase.from('fahrtenbuch_imports').delete().eq('id', importId);
      await supabase.storage.from('fahrtenbuch-files').remove([storagePath]);
      await fetchImports();
      if (isUniqueViolation(tripErr, ROW_KEY_INDEX)) {
        throw new Error(t('imp.error.rowRace'));
      }
      const cause = (tripErr as { message?: string } | null)?.message ?? 'Unbekannter Fehler';
      throw new Error(
        `Import fehlgeschlagen nach ${written} von ${trips.length} Fahrten. ` +
        'Der unvollständige Import wurde vollständig zurückgenommen. ' +
        `Ursache: ${cause}`,
      );
    }

    await fetchImports();
    return { importId, inserted: trips.length, duplicatesRefused };
  }, [companyId, user, fetchImports, findImportByFileHash, findStoredSourceRowKeys, isReadOnlyPlatformSession, t]);

  const deleteImport = useCallback(async (importId: string) => {
    if (!companyId) return;

    // Deleting the runs directly cascades away planning_finalizations,
    // monthly_planning_manual_exceptions and planning_run_adjustments. Route each
    // one through the RPC, which archives a run that still has trips attached
    // instead of destroying its record.
    const { data: runs, error: runsErr } = await supabase
      .from('company_planning_runs')
      .select('id')
      .eq('import_id', importId)
      .eq('company_id', companyId);
    if (runsErr) throw runsErr;

    for (const run of runs ?? []) {
      const { error: rpcErr } = await supabase.rpc('delete_or_archive_monthly_planning_run', {
        p_run_id: run.id,
      });
      if (rpcErr) throw rpcErr;
    }

    // A BEFORE DELETE trigger refuses this when a finalization exists for the
    // month, so the German message it raises reaches the user as-is.
    const { error } = await supabase
      .from('fahrtenbuch_imports')
      .delete()
      .eq('id', importId)
      .eq('company_id', companyId);
    if (error) throw error;

    await fetchImports();
    setTrips(prev => prev.filter(t => t.import_id !== importId));
  }, [companyId, fetchImports]);

  return {
    imports,
    trips,
    loadingImports,
    loadingTrips,
    fetchImports,
    fetchTrips,
    findImportByFileHash,
    findStoredSourceRowKeys,
    createImport,
    deleteImport,
  };
}
