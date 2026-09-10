import React, { useEffect, useMemo, useState } from 'react';
import { Play, AlertTriangle, CheckCircle2, Car as CarIcon, Clock, Info, ChevronRight, ChevronDown, ArrowLeft, CalendarDays, History, Euro, ListChecks } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useFahrtenbuch, type FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
import {
  buildPhase1VehicleBlocks,
  type Phase1Result,
  type Phase1Trip,
  VEHICLE_BLOCK_GAP_MINUTES,
  DEFAULT_MAX_VEHICLE_BLOCK_DURATION_MINUTES,
  MIN_VEHICLE_BLOCK_DURATION_MINUTES,
  MAX_BLOCK_DURATION_LOWER_BOUND,
  MAX_BLOCK_DURATION_UPPER_BOUND,
} from '../utils/monatsplanungPhase1';
import { DEFAULT_VEHICLE_SWITCH_BUFFER_MINUTES } from '../utils/monatsplanungPhase3';
import { resolveActualRideWindow } from '../utils/planningQualityChecks';
import MonatsplanungDriverPool, { type PlanningDriver } from '../components/MonatsplanungDriverPool';
import MonatsplanungAssignmentPreview from '../components/MonatsplanungAssignmentPreview';
import MonatsplanungAppliedRuns from '../components/MonatsplanungAppliedRuns';
import HistoricalReconciliationWizard from '../components/HistoricalReconciliationWizard';
import HistoricalWorkingHoursWizard from '../components/HistoricalWorkingHoursWizard';
import { useSuperAdmin } from '../contexts/SuperAdminContext';

const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

const BATCH_SIZE = 1000;

/** Show full technical debug panels only when ?debug=1 is in the URL (developer mode). */
const DEBUG_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === '1';

function formatDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function formatTime(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : iso;
}

function formatDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : d;
}

function splitReasonLabel(reason: string, blockSeparatorMin: number, maxBlockMin: number): string {
  if (reason === 'gap_gt_60') return `Gap > ${blockSeparatorMin} Min.`;
  if (reason === 'max_duration_4_5h') {
    if (maxBlockMin % 60 === 0) return `Max. ${maxBlockMin / 60}h`;
    return `Max. ${maxBlockMin} Min`;
  }
  if (reason === 'end_of_vehicle_day') return 'Ende Tag';
  return reason;
}

async function fetchAllTripsForImport(companyId: string, importId: string): Promise<FahrtenbuchTrip[]> {
  const all: FahrtenbuchTrip[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('fahrtenbuch_trips')
      .select('*')
      .eq('company_id', companyId)
      .eq('import_id', importId)
      .order('trip_date', { ascending: true })
      .order('start_time', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);
    if (error) throw error;
    const rows = (data as FahrtenbuchTrip[]) ?? [];
    all.push(...rows);
    if (rows.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }
  return all;
}

export default function CompanyPlannerPage() {
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const now = new Date();
  const [planningMode, setPlanningMode] = useState<'selection' | 'new_month' | 'historical' | 'hist_mode_selection' | 'historical_reconciliation' | 'hist_working_hours'>('selection');
  const [reconciliationMode, setReconciliationMode] = useState<'brutto_salary' | 'working_hours' | null>(null);
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [selectedImportId, setSelectedImportId] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Phase1Result | null>(null);
  const [originalDriverNames, setOriginalDriverNames] = useState<string[]>([]);
  const [originalDriverIds, setOriginalDriverIds] = useState<string[]>([]);
  const [selectedDriverIds, setSelectedDriverIds] = useState<Set<string>>(new Set());
  const [poolDrivers, setPoolDrivers] = useState<PlanningDriver[]>([]);
  const [rawTrips, setRawTrips] = useState<FahrtenbuchTrip[]>([]);
  const [blockSeparatorGap, setBlockSeparatorGap] = useState<number>(VEHICLE_BLOCK_GAP_MINUTES);
  const [minBlockDuration, setMinBlockDuration] = useState<number>(MIN_VEHICLE_BLOCK_DURATION_MINUTES);
  const [maxBlockDuration, setMaxBlockDuration] = useState<number>(DEFAULT_MAX_VEHICLE_BLOCK_DURATION_MINUTES);
  const [vehicleSwitchBuffer, setVehicleSwitchBuffer] = useState<number>(DEFAULT_VEHICLE_SWITCH_BUFFER_MINUTES);
  const [appliedRunsReloadToken, setAppliedRunsReloadToken] = useState(0);

  const { imports, fetchImports, loadingImports } = useFahrtenbuch();

  useEffect(() => {
    void fetchImports();
  }, [fetchImports]);

  const filteredImports = useMemo(
    () => imports.filter(i => i.month === month && i.year === year),
    [imports, month, year],
  );

  useEffect(() => {
    if (filteredImports.length === 0) {
      setSelectedImportId('');
      return;
    }
    if (!filteredImports.some(i => i.id === selectedImportId)) {
      setSelectedImportId(filteredImports[0].id);
    }
  }, [filteredImports, selectedImportId]);

  // Invalidate downstream phases (Phase 3-7) when block inputs change so the
  // user has to re-run Phase 1 with the new parameters.
  useEffect(() => {
    setResult(null);
    setOriginalDriverNames([]);
    setOriginalDriverIds([]);
    setSelectedDriverIds(new Set());
    setPoolDrivers([]);
    setRawTrips([]);
  }, [blockSeparatorGap, minBlockDuration, maxBlockDuration, selectedImportId, month, year]);

  const yearOptions = useMemo(() => {
    const y = now.getFullYear();
    return [y - 1, y, y + 1];
  }, [now]);

  const handleRun = async () => {
    if (!companyId) {
      setError('Keine Firma ausgewählt.');
      return;
    }
    if (!selectedImportId) {
      setError('Bitte zuerst einen Fahrtenbuch-Import auswählen.');
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    setOriginalDriverNames([]);
    setOriginalDriverIds([]);
    setSelectedDriverIds(new Set());
    setPoolDrivers([]);
    setRawTrips([]);
    try {
      const rawTrips = await fetchAllTripsForImport(companyId, selectedImportId);
      setRawTrips(rawTrips);

      // Pre-compute actual ride timestamps from raw_data_json so Phase 1 can
      // sort and group by real calendar dates instead of service date + HH:MM.
      const phase1Trips: Phase1Trip[] = rawTrips.map(t => {
        if (t.is_canceled) {
          return {
            id: t.id,
            trip_date: t.trip_date,
            start_time: t.start_time,
            end_time: t.end_time,
            car_id: t.car_id,
            car_identifier: t.car_identifier,
            is_canceled: true,
            source_row_index: t.source_row_index,
          };
        }
        const rw = resolveActualRideWindow(t);
        return {
          id: t.id,
          trip_date: t.trip_date,
          start_time: t.start_time,
          end_time: t.end_time,
          car_id: t.car_id,
          car_identifier: t.car_identifier,
          is_canceled: false,
          source_row_index: t.source_row_index,
          actual_start_ms: rw.actualStartMs > 0 ? rw.actualStartMs : undefined,
          actual_end_ms:   rw.actualEndMs   > 0 ? rw.actualEndMs   : undefined,
        };
      });
      const res = buildPhase1VehicleBlocks(phase1Trips, {
        blockSeparatorGapMinutes: blockSeparatorGap,
        minBlockDurationMinutes: minBlockDuration,
        maxBlockDurationMinutes: maxBlockDuration,
      });

      setResult(res);

      const names = new Set<string>();
      const ids = new Set<string>();
      for (const t of rawTrips) {
        if (t.is_canceled) continue;
        if (t.original_driver_name && t.original_driver_name.trim()) {
          names.add(t.original_driver_name.trim());
        }
        if (t.original_driver_id) ids.add(t.original_driver_id);
      }
      setOriginalDriverNames(Array.from(names));
      setOriginalDriverIds(Array.from(ids));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
          Monatsplanung
        </h1>
        {planningMode === 'selection' && (
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            Wähle einen Planungsmodus aus.
          </p>
        )}
        {planningMode === 'new_month' && (
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            Phase 1: Fahrzeug-Blöcke
          </p>
        )}
        {planningMode === 'historical' && (
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            Historischer Steuerberater-Abgleich
          </p>
        )}
      </div>

      {/* ── Mode selection ── */}
      {planningMode === 'selection' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-2">
          {/* Card 1 — Neue Monatsplanung */}
          <div
            className="rounded-2xl p-6 flex flex-col gap-4"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-3">
              <div className="rounded-xl p-2.5" style={{ background: 'rgba(37,99,235,0.1)' }}>
                <CalendarDays size={22} style={{ color: '#2563eb' }} />
              </div>
              <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                Neue Monatsplanung
              </h2>
            </div>
            <p className="text-sm leading-relaxed flex-1" style={{ color: 'var(--text-secondary)' }}>
              Für aktuelle oder zukünftige Monate. Fahrten importieren, Planung erstellen, finale Fahrtenbücher und Stundennachweise erzeugen.
            </p>
            <button
              onClick={() => setPlanningMode('new_month')}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold self-start transition-all hover:brightness-110 active:scale-[0.98]"
              style={{ background: '#2563eb', color: '#fff' }}
            >
              <Play size={15} />
              Neue Planung starten
            </button>
          </div>

          {/* Card 2 — Alter Monat / Steuerberater-Abgleich */}
          <div
            className="rounded-2xl p-6 flex flex-col gap-4"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-3">
              <div className="rounded-xl p-2.5" style={{ background: 'rgba(124,58,237,0.1)' }}>
                <History size={22} style={{ color: '#7c3aed' }} />
              </div>
              <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                Alter Monat / Steuerberater-Abgleich
              </h2>
            </div>
            <p className="text-sm leading-relaxed flex-1" style={{ color: 'var(--text-secondary)' }}>
              Für bereits gemeldete Monate. Steuerberater-Zielwerte eingeben und Stundennachweise exakt dagegen abgleichen.
            </p>
            <button
              onClick={() => setPlanningMode('hist_mode_selection')}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold self-start transition-all hover:brightness-110 active:scale-[0.98]"
              style={{ background: '#7c3aed', color: '#fff' }}
            >
              <History size={15} />
              Historischen Abgleich starten
            </button>
          </div>
        </div>
      )}

      {/* ── Historical reconciliation wizard ── */}
      {planningMode === 'historical_reconciliation' && (
        <HistoricalReconciliationWizard onBack={() => setPlanningMode('hist_mode_selection')} />
      )}

      {/* ── Historical mode selection ── */}
      {planningMode === 'hist_mode_selection' && (
        <div className="max-w-3xl mx-auto px-2">
          <button
            onClick={() => setPlanningMode('selection')}
            className="inline-flex items-center gap-2 text-sm font-medium mb-6 transition-colors hover:opacity-80"
            style={{ color: 'var(--text-secondary)' }}
          >
            <ArrowLeft size={15} />
            Zurück zur Auswahl
          </button>

          <div className="mb-6">
            <h2 className="text-xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
              Art des historischen Abgleichs wählen
            </h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Wählen Sie, ob der Abgleich über Brutto-Gehälter oder über Arbeitsstunden/Lohnarten erfolgen soll.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
            {/* Card 1 — Mit Brutto-Gehältern */}
            <div
              className="rounded-2xl p-6 flex flex-col gap-4 cursor-pointer transition-all hover:brightness-105"
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
            >
              <div className="flex items-start gap-3">
                <div className="rounded-xl p-2.5 shrink-0" style={{ background: 'rgba(124,58,237,0.1)' }}>
                  <Euro size={22} style={{ color: '#7c3aed' }} />
                </div>
                <div className="flex flex-col gap-1">
                  <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
                    Mit Brutto-Gehältern
                  </h3>
                  <span
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold self-start"
                    style={{ background: 'rgba(21,128,61,0.1)', color: '#15803d' }}
                  >
                    Aktuell verfügbar
                  </span>
                </div>
              </div>
              <p className="text-sm leading-relaxed flex-1" style={{ color: 'var(--text-secondary)' }}>
                Verwenden Sie diese Option, wenn Sie pro Fahrer ein exaktes Ziel-Brutto eingeben möchten. Das System verteilt Fahrten und ergänzt fehlende Beträge über Ausgleichsstunden, damit das finale Brutto erreicht wird.
              </p>
              <button
                onClick={() => {
                  setReconciliationMode('brutto_salary');
                  setPlanningMode('historical_reconciliation');
                }}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold self-start transition-all hover:brightness-110 active:scale-[0.98]"
                style={{ background: '#7c3aed', color: '#fff' }}
              >
                <Euro size={15} />
                Mit Brutto-Gehältern starten
              </button>
            </div>

            {/* Card 2 — Mit Arbeitsstunden */}
            <div
              className="rounded-2xl p-6 flex flex-col gap-4"
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', opacity: 0.9 }}
            >
              <div className="flex items-start gap-3">
                <div className="rounded-xl p-2.5 shrink-0" style={{ background: 'rgba(37,99,235,0.1)' }}>
                  <ListChecks size={22} style={{ color: '#2563eb' }} />
                </div>
                <div className="flex flex-col gap-1">
                  <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
                    Mit Arbeitsstunden
                  </h3>
                  <span
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold self-start"
                    style={{ background: 'rgba(37,99,235,0.1)', color: '#1d4ed8' }}
                  >
                    Neu
                  </span>
                </div>
              </div>
              <p className="text-sm leading-relaxed flex-1" style={{ color: 'var(--text-secondary)' }}>
                Verwenden Sie diese Option, wenn Sie die Werte aus der Lohnabrechnung pro Lohnart exakt nachbauen möchten, z.B. Stundenlohn, Nachtzuschlag 25%, Nachtzuschlag 40% und Sonntagszuschlag.
              </p>
              <button
                onClick={() => {
                  setReconciliationMode('working_hours');
                  setPlanningMode('hist_working_hours');
                }}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold self-start transition-all hover:brightness-110 active:scale-[0.98]"
                style={{ background: '#2563eb', color: '#fff' }}
              >
                <ListChecks size={15} />
                Mit Arbeitsstunden starten
              </button>
            </div>
          </div>

          <div
            className="rounded-xl px-4 py-3 text-xs"
            style={{ background: 'rgba(124,58,237,0.06)', border: '1px solid rgba(124,58,237,0.15)', color: 'var(--text-secondary)' }}
          >
            <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Hinweis:</span>{' '}
            Der Brutto-Modus gleicht gegen ein finales Brutto ab. Der Arbeitsstunden-Modus wird später die einzelnen Lohnarten aus der Lohnabrechnung exakt abgleichen.
          </div>
        </div>
      )}

      {/* ── Working hours reconciliation wizard ── */}
      {planningMode === 'hist_working_hours' && (
        <HistoricalWorkingHoursWizard onBack={() => setPlanningMode('hist_mode_selection')} />
      )}

      {/* ── Normal planning workflow (new_month) ── */}
      {planningMode === 'new_month' && (
        <div>
          <button
            onClick={() => setPlanningMode('selection')}
            className="inline-flex items-center gap-2 text-sm font-medium mb-5 transition-colors hover:opacity-80"
            style={{ color: 'var(--text-secondary)' }}
          >
            <ArrowLeft size={15} />
            Zurück zur Auswahl
          </button>

      <div
        className="rounded-xl p-5 mb-6"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
      >
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5"
              style={{ color: 'var(--text-tertiary)' }}>
              Monat
            </label>
            <select
              value={month}
              onChange={e => setMonth(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg text-sm"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              {MONTHS_DE.map((m, i) => (
                <option key={i} value={i + 1}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5"
              style={{ color: 'var(--text-tertiary)' }}>
              Jahr
            </label>
            <select
              value={year}
              onChange={e => setYear(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg text-sm"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              {yearOptions.map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5"
              style={{ color: 'var(--text-tertiary)' }}>
              Fahrtenbuch-Datei / Import
            </label>
            <select
              value={selectedImportId}
              onChange={e => setSelectedImportId(e.target.value)}
              disabled={loadingImports || filteredImports.length === 0}
              className="w-full px-3 py-2 rounded-lg text-sm"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              {filteredImports.length === 0 ? (
                <option value="">Kein Import für {MONTHS_DE[month - 1]} {year} gefunden</option>
              ) : (
                filteredImports.map(i => (
                  <option key={i.id} value={i.id}>
                    {i.file_name} ({i.row_count} Zeilen, {new Date(i.imported_at).toLocaleDateString('de-DE')})
                  </option>
                ))
              )}
            </select>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <button
            onClick={handleRun}
            disabled={running || !selectedImportId}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold shadow-sm transition-all hover:shadow-md hover:brightness-110 active:scale-[0.98] active:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-sm disabled:active:scale-100"
            style={{ background: 'var(--primary, #2563eb)', color: 'var(--primary-contrast, #fff)' }}
          >
            <Play size={16} />
            {running ? 'Lade Fahrten…' : 'Fahrzeug-Blöcke erstellen'}
          </button>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
            <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
              Block-Trenner:
            </span>
            <input
              type="number"
              min={1}
              max={720}
              step={1}
              value={blockSeparatorGap}
              onChange={e => {
                const v = parseInt(e.target.value, 10);
                setBlockSeparatorGap(Number.isFinite(v) && v > 0 ? v : VEHICLE_BLOCK_GAP_MINUTES);
              }}
              className="w-16 px-2 py-1 rounded text-sm text-right"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            />
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Min.</span>
          </div>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
            <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
              Min Blockdauer:
            </span>
            <input
              type="number"
              min={0}
              max={120}
              step={1}
              value={minBlockDuration}
              onChange={e => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isFinite(v)) {
                  setMinBlockDuration(MIN_VEHICLE_BLOCK_DURATION_MINUTES);
                } else {
                  setMinBlockDuration(Math.max(0, Math.min(120, v)));
                }
              }}
              className="w-16 px-2 py-1 rounded text-sm text-right"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            />
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              Min.{minBlockDuration === 0 ? ' (deaktiviert)' : ''}
            </span>
          </div>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
            <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
              Max Blockdauer:
            </span>
            <input
              type="number"
              min={MAX_BLOCK_DURATION_LOWER_BOUND}
              max={MAX_BLOCK_DURATION_UPPER_BOUND}
              step={1}
              value={maxBlockDuration}
              onChange={e => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isFinite(v)) {
                  setMaxBlockDuration(DEFAULT_MAX_VEHICLE_BLOCK_DURATION_MINUTES);
                } else {
                  setMaxBlockDuration(Math.max(MAX_BLOCK_DURATION_LOWER_BOUND, Math.min(MAX_BLOCK_DURATION_UPPER_BOUND, v)));
                }
              }}
              className="w-20 px-2 py-1 rounded text-sm text-right"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            />
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Min.</span>
          </div>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
            <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
              Fahrzeugwechsel-Puffer:
            </span>
            <input
              type="number"
              min={0}
              max={240}
              step={5}
              value={vehicleSwitchBuffer}
              onChange={e => {
                const v = parseInt(e.target.value, 10);
                setVehicleSwitchBuffer(Number.isFinite(v) && v >= 0 ? v : DEFAULT_VEHICLE_SWITCH_BUFFER_MINUTES);
              }}
              className="w-16 px-2 py-1 rounded text-sm text-right"
              style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            />
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Min.</span>
          </div>
          <div className="text-xs flex items-center gap-1.5" style={{ color: 'var(--text-tertiary)' }}>
            <Info size={13} />
            Block-Trenner Default {VEHICLE_BLOCK_GAP_MINUTES} Min · Min Blockdauer Default {MIN_VEHICLE_BLOCK_DURATION_MINUTES} Min (0 = aus) · Max Blockdauer Default {DEFAULT_MAX_VEHICLE_BLOCK_DURATION_MINUTES} Min (4,5h, Bereich {MAX_BLOCK_DURATION_LOWER_BOUND}–{MAX_BLOCK_DURATION_UPPER_BOUND} Min) · Fahrzeugwechsel-Puffer Default {DEFAULT_VEHICLE_SWITCH_BUFFER_MINUTES} Min.
          </div>
          <div className="text-xs flex items-start gap-1.5 mt-1 px-3 py-2 rounded-lg w-full" style={{ background: 'rgba(37,99,235,0.06)', color: '#1e40af', border: '1px solid rgba(37,99,235,0.18)' }}>
            <Info size={13} className="shrink-0 mt-0.5" />
            <span>
              <strong>Sicherheitsregeln aktiv:</strong> Fahrzeugwechsel-Puffer {vehicleSwitchBuffer} Min · Ein Fahrzeug pro Fahrer/Tag (konfigurierbar in Phase 3).
              Diese Regeln helfen, spätere Konflikte in den finalen Dokumenten zu vermeiden. Mindestabstand, wenn ein Fahrer zwischen zwei verschiedenen Fahrzeugen wechselt.
            </span>
          </div>
        </div>

        {error && (
          <div
            className="mt-4 px-3 py-2 rounded-lg text-sm flex items-center gap-2"
            style={{ background: 'var(--bg-danger-subtle, #fef2f2)', color: 'var(--danger, #b91c1c)' }}
          >
            <AlertTriangle size={15} />
            {error}
          </div>
        )}
      </div>

      {result && <BlockStatusBanner result={result} />}
      {DEBUG_MODE && result && <ResultPanels result={result} blockSeparatorMin={blockSeparatorGap} maxBlockMin={maxBlockDuration} />}
      {result && companyId && (
        <div className="mt-6">
          <MonatsplanungDriverPool
            companyId={companyId}
            originalDriverNames={originalDriverNames}
            originalDriverIds={originalDriverIds}
            selectedIds={selectedDriverIds}
            onSelectedChange={setSelectedDriverIds}
            onDriversLoaded={setPoolDrivers}
          />
        </div>
      )}

      {result && poolDrivers.length > 0 && (
        <div className="mt-6">
          <MonatsplanungAssignmentPreview
            blocks={result.blocks}
            selectedDrivers={poolDrivers.filter(d => selectedDriverIds.has(d.id))}
            trips={rawTrips}
            importId={selectedImportId}
            month={month}
            year={year}
            blockSeparatorMinutes={blockSeparatorGap}
            minBlockDurationMinutes={minBlockDuration}
            maxBlockDurationMinutes={maxBlockDuration}
            vehicleSwitchBufferMinutes={vehicleSwitchBuffer}
            sourceFileName={filteredImports.find(i => i.id === selectedImportId)?.file_name ?? ''}
            companyId={companyId}
            onApplied={() => setAppliedRunsReloadToken(t => t + 1)}
          />
        </div>
      )}

      {companyId && (
        <div className="mt-8">
          <MonatsplanungAppliedRuns companyId={companyId} reloadToken={appliedRunsReloadToken} />
        </div>
      )}
        </div>
      )}
    </div>
  );
}

function BlockStatusBanner({ result }: { result: Phase1Result }) {
  const s = result.summary;
  const observedMax = s.observed_max_block_duration_minutes;
  const hasProblems = s.coverage_issues > 0 || observedMax > s.max_block_duration_minutes;

  if (hasProblems) {
    return null;
  }

  return (
    <div
      className="mt-4 rounded-xl px-4 py-3 flex items-center gap-3"
      style={{ background: 'rgba(21,128,61,0.06)', border: '1px solid rgba(21,128,61,0.22)', color: 'var(--text-primary)' }}
    >
      <CheckCircle2 size={16} style={{ color: '#15803d', flexShrink: 0 }} />
      <span className="text-sm">
        <span className="font-semibold" style={{ color: '#15803d' }}>Fahrzeug-Blöcke wurden erstellt.</span>
        {' '}
        <span style={{ color: 'var(--text-secondary)' }}>
          {s.blocks_total} Blöcke · {s.vehicles} Fahrzeuge · {s.abgeschlossen} Fahrten.
          Sie können mit der Planung fortfahren.
        </span>
      </span>
    </div>
  );
}

function ResultPanels({ result, blockSeparatorMin, maxBlockMin }: { result: Phase1Result; blockSeparatorMin: number; maxBlockMin: number }) {
  const s = result.summary;
  const observedMax = s.observed_max_block_duration_minutes;
  const validationOk = s.coverage_issues === 0 && observedMax <= s.max_block_duration_minutes;
  const [blocksOpen, setBlocksOpen] = useState(true);

  return (
    <div className="space-y-6">
      {/* Overall summary */}
      <div
        className="rounded-xl p-5"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
      >
        <h2 className="text-base font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
          Übersicht
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <StatCard label="Block-Trenner" value={`${s.block_separator_gap_minutes} Min.`} highlight />
          <StatCard label="Min Blockdauer" value={s.min_block_duration_minutes === 0 ? 'aus' : `${s.min_block_duration_minutes} Min.`} highlight />
          <StatCard label="Max Blockdauer" value={`${s.max_block_duration_minutes} Min.`} highlight />
          <StatCard label="Gesamt Fahrten" value={s.total_trips} />
          <StatCard label="Abgeschlossen" value={s.abgeschlossen} />
          <StatCard label="Storniert" value={s.storniert} />
          <StatCard label="Fahrzeuge" value={s.vehicles} />
          <StatCard label="Vehicle Blocks" value={s.blocks_total} highlight />
          <StatCard label={`Split: Gap > ${blockSeparatorMin}`} value={s.blocks_split_by_gap} />
          <StatCard label={`Split: Max ${maxBlockMin} Min`} value={s.blocks_split_by_max_duration} />
          <StatCard
            label="Beob. max. Blockdauer"
            value={formatDuration(observedMax)}
            tone={observedMax > s.max_block_duration_minutes ? 'danger' : undefined}
          />
          <StatCard label="Kurze Blöcke erkannt" value={s.short_blocks_detected} />
          <StatCard label="Kurze Blöcke zusammengeführt" value={s.short_blocks_merged} tone={s.short_blocks_merged > 0 ? 'ok' : undefined} />
          <StatCard
            label="Kurze Blöcke verbleibend"
            value={s.short_blocks_remaining}
            tone={s.short_blocks_remaining > 0 ? 'warning' : 'ok'}
          />
          <StatCard
            label="Coverage Issues"
            value={s.coverage_issues}
            tone={s.coverage_issues > 0 ? 'danger' : 'ok'}
          />
          <div className="flex items-center">
            {validationOk ? (
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold"
                style={{ color: 'var(--success, #15803d)' }}>
                <CheckCircle2 size={16} /> Validierung OK
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold"
                style={{ color: 'var(--danger, #b91c1c)' }}>
                <AlertTriangle size={16} /> Probleme erkannt
              </span>
            )}
          </div>
        </div>

        {result.coverageIssues.length > 0 && (
          <details className="mt-4">
            <summary className="text-sm cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
              Coverage-Issues anzeigen ({result.coverageIssues.length})
            </summary>
            <ul className="mt-2 space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {result.coverageIssues.slice(0, 50).map((c, i) => (
                <li key={i}>• [{c.type}] {c.detail}</li>
              ))}
              {result.coverageIssues.length > 50 && (
                <li>… und {result.coverageIssues.length - 50} weitere</li>
              )}
            </ul>
          </details>
        )}

        {result.skippedTrips.length > 0 && (
          <details className="mt-3">
            <summary className="text-sm cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
              Übersprungene Fahrten ({result.skippedTrips.length})
            </summary>
            <ul className="mt-2 space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {result.skippedTrips.slice(0, 30).map((t, i) => (
                <li key={i}>• {t.id}: {t.reason}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* Per-vehicle summary */}
      <div
        className="rounded-xl overflow-hidden"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
      >
        <div className="px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <h2 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <CarIcon size={16} /> Pro Fahrzeug
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--bg-subtle)' }}>
                <Th>Kennzeichen</Th>
                <Th align="right">Blocks</Th>
                <Th align="right">Fahrten</Th>
                <Th align="right">Ø Fahrten/Block</Th>
                <Th align="right">Ø Blockdauer</Th>
                <Th align="right">Max Blockdauer</Th>
              </tr>
            </thead>
            <tbody>
              {result.perVehicle.map(v => (
                <tr key={v.vehicle_id} style={{ borderTop: '1px solid var(--border)' }}>
                  <Td><span className="font-mono">{v.vehicle_identifier}</span></Td>
                  <Td align="right">{v.blocks}</Td>
                  <Td align="right">{v.trips}</Td>
                  <Td align="right">{v.avg_trips_per_block.toFixed(2)}</Td>
                  <Td align="right">{formatDuration(Math.round(v.avg_block_duration_minutes))}</Td>
                  <Td align="right">{formatDuration(v.max_block_duration_minutes)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Block table */}
      <div
        className="rounded-xl overflow-hidden"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
      >
        <button
          type="button"
          onClick={() => setBlocksOpen(o => !o)}
          className="w-full px-5 py-4 border-b flex items-center justify-between text-left transition-colors hover:bg-[color:var(--bg-subtle)]"
          style={{ borderColor: 'var(--border)' }}
          aria-expanded={blocksOpen}
        >
          <h2 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            {blocksOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <Clock size={16} /> Vehicle Blocks ({result.blocks.length})
          </h2>
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {blocksOpen ? 'Einklappen' : 'Ausklappen'}
          </span>
        </button>
        {blocksOpen && (
        <div className="overflow-x-auto max-h-[600px]">
          <table className="w-full text-xs">
            <thead className="sticky top-0" style={{ background: 'var(--bg-subtle)' }}>
              <tr>
                <Th>Akt. Datum</Th>
                <Th>Kennzeichen</Th>
                <Th>Akt. Start</Th>
                <Th>Akt. Ende</Th>
                <Th align="right">Dauer</Th>
                <Th align="right">Fahrten</Th>
                <Th>Split</Th>
                <Th>Min Blockdauer</Th>
                <Th>Excel-Rows / Trip-IDs</Th>
              </tr>
            </thead>
            <tbody>
              {result.blocks.map(b => {
                // Detect cross-midnight block (end date > start date)
                const endDate = b.block_end_datetime.slice(0, 10);
                const crossMidnight = endDate > b.service_date;
                return (
                <tr key={b.block_id} style={{ borderTop: '1px solid var(--border)' }}>
                  <Td>
                    <span title={crossMidnight ? `Endet ${formatDate(endDate)}` : undefined}>
                      {formatDate(b.service_date)}
                      {crossMidnight && (
                        <span className="ml-1 text-[9px] font-semibold px-1 rounded"
                          style={{ background: 'rgba(234,88,12,0.12)', color: '#c2410c' }}>
                          →{formatDate(endDate)}
                        </span>
                      )}
                    </span>
                  </Td>
                  <Td><span className="font-mono">{b.vehicle_identifier}</span></Td>
                  <Td>{formatTime(b.block_start_datetime)}</Td>
                  <Td>{formatTime(b.block_end_datetime)}</Td>
                  <Td align="right">{formatDuration(b.duration_minutes)}</Td>
                  <Td align="right">{b.trip_count}</Td>
                  <Td>
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                      style={{
                        background:
                          b.split_reason === 'max_duration_4_5h'
                            ? 'rgba(234, 88, 12, 0.12)'
                            : b.split_reason === 'gap_gt_60'
                            ? 'rgba(2, 132, 199, 0.12)'
                            : 'var(--bg-muted)',
                        color:
                          b.split_reason === 'max_duration_4_5h'
                            ? '#c2410c'
                            : b.split_reason === 'gap_gt_60'
                            ? '#0369a1'
                            : 'var(--text-tertiary)',
                      }}
                    >
                      {splitReasonLabel(b.split_reason, blockSeparatorMin, maxBlockMin)}
                    </span>
                  </Td>
                  <Td>
                    {b.merge_status === 'merged_short' ? (
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                        style={{ background: 'rgba(21, 128, 61, 0.12)', color: '#15803d' }}
                      >
                        Short merged
                      </span>
                    ) : b.merge_status === 'short_warning' ? (
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                        style={{ background: 'rgba(234, 88, 12, 0.12)', color: '#c2410c' }}
                        title={`Block < ${result.summary.min_block_duration_minutes} Min.`}
                      >
                        Short &lt; {result.summary.min_block_duration_minutes} Min
                      </span>
                    ) : (
                      <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>—</span>
                    )}
                  </Td>
                  <Td>
                    <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                      {b.first_excel_row != null && b.last_excel_row != null
                        ? `Rows ${b.first_excel_row}–${b.last_excel_row}`
                        : `${b.first_trip_id.slice(0, 8)}…${b.last_trip_id.slice(0, 8)}`}
                    </span>
                  </Td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  highlight,
  tone,
}: {
  label: string;
  value: number | string;
  highlight?: boolean;
  tone?: 'ok' | 'danger' | 'warning';
}) {
  const color =
    tone === 'danger' ? 'var(--danger, #b91c1c)' :
    tone === 'warning' ? '#c2410c' :
    tone === 'ok' ? 'var(--success, #15803d)' :
    highlight ? 'var(--primary)' :
    'var(--text-primary)';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-semibold mb-1"
        style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </div>
      <div className="text-xl font-bold" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className="px-3 py-2 text-[11px] uppercase tracking-wider font-semibold"
      style={{ color: 'var(--text-tertiary)', textAlign: align ?? 'left' }}
    >
      {children}
    </th>
  );
}

function Td({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <td className="px-3 py-2" style={{ color: 'var(--text-primary)', textAlign: align ?? 'left' }}>
      {children}
    </td>
  );
}
