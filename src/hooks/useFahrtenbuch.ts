import { useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

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
}

export interface FahrtenbuchTrip {
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

export interface TripInsertRow {
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

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useFahrtenbuch() {
  const { companyId, user } = useAuth();
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

  const createImport = useCallback(async (params: {
    month: number;
    year: number;
    fileName: string;
    trips: TripInsertRow[];
    notes?: string;
    sourceSheetName?: string;
    sourceColumns?: string[];
    xlsxBytes?: Uint8Array | null;
  }): Promise<string> => {
    if (!companyId || !user) throw new Error('Not authenticated');

    // XLSX bytes are mandatory — no import without the original file in storage
    if (!params.xlsxBytes || params.xlsxBytes.length === 0) {
      throw new Error('Import blockiert: Original-XLSX-Datei konnte nicht gelesen werden.');
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
        row_count: params.trips.length,
        notes: params.notes || null,
        source_sheet_name: params.sourceSheetName || null,
        source_columns_json: params.sourceColumns || null,
        storage_path: storagePath,
      })
      .select('id, storage_path, imported_at')
      .single();

    if (importErr) {
      // Best-effort cleanup of uploaded file
      await supabase.storage.from('fahrtenbuch-files').remove([storagePath]);
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

    const batchSize = 200;
    for (let i = 0; i < params.trips.length; i += batchSize) {
      const batch = params.trips.slice(i, i + batchSize).map(t => ({
        ...t,
        import_id: importId,
        company_id: companyId,
      }));
      const { error: tripErr } = await supabase
        .from('fahrtenbuch_trips')
        .insert(batch);
      if (tripErr) throw tripErr;
    }

    await fetchImports();
    return importId;
  }, [companyId, user, fetchImports]);

  const deleteImport = useCallback(async (importId: string) => {
    if (!companyId) return;

    const { error: planErr } = await supabase
      .from('company_planning_runs')
      .delete()
      .eq('import_id', importId)
      .eq('company_id', companyId);
    if (planErr) throw planErr;

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
    createImport,
    deleteImport,
  };
}
